/* =========================================================================
 *  Slides -- the Durable Object
 *  -----------------------------------------------------------------------
 *  The deck document (its slides and the deck logo), its shared undo
 *  history, the media asset store, the embedded cover artwork, and the
 *  PowerPoint export. It broadcasts every
 *  saved change to the connected browsers as a patch carrying only the
 *  slides that changed, and is a generic store: it doesn't know what any
 *  component does. The browser renderer (client.ts) and the pptx library
 *  do; lib/pptx.ts adapts the deck for the latter.
 * ========================================================================= */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue, SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import { LOGO_DEFAULT_TEXT } from "@gadgets/bundled-blueprints/libraries/pptx/server";
import { COVER_ORANGE_PNG } from "./lib/branding.ts";
import { pptxAssets } from "./lib/brand-rasters.ts";
import { deckToSlidesPptx } from "./lib/pptx.ts";
import { DEFAULT_LOGO_POSITION, isLogoImageData, isLogoPosition } from "./lib/logo.ts";
import { SLIDE_LAYOUTS, SLIDE_LAYOUT_IDS, isSlideLayout } from "./lib/layouts.ts";
import type {
  Block,
  BlockInput,
  BlockPatch,
  BlockPatchEntry,
  BlockProps,
  BrandAssets,
  Deck,
  DeckCallbacks,
  DeckLogo,
  DeckLogoPatch,
  DeckPatch,
  GadgetStub,
  LegacyDeckCallbacks,
  Slide,
  SlideInput,
  SlidePatch,
  SlideSummary,
  SubscribeOptions,
  UndoState,
} from "./lib/protocol.ts";

// ---------------------------------------------------------------------------
// Storage (v2). The deck lives in memory and is written incrementally, so an
// edit costs one small slide write instead of rewriting the whole deck:
//   meta          { v: 2, themeVersion, order, rev, seq, undo: [seq], redo: [seq],
//                   logo }  -- logo: the deck logo (its image an asset ref), or null
//   s:<slideId>   one slide; big media in its blocks is an "asset:<hash>" ref
//   h:<seq>       one undo/redo step: the earlier version of only the slides
//                 it touched (+ the earlier slide order and deck logo, when
//                 those changed); a step touching many slides spills them
//                 into h:<seq>:<n>
//   a:<hash>:<n>  asset data (inlined images, large SVG markup), chunked so
//                 no single value nears the storage value-size limit
//   assets        { <hash>: chunkCount } -- the asset index
// Stored slides are never mutated: every change builds new slide and block
// objects. History steps therefore share everything they didn't touch, and a
// broadcast carries only the slides that changed. The v1 layout (the whole
// deck as one "deck" value) is migrated on first load.
// ---------------------------------------------------------------------------
const LEGACY_KEY = "deck";
const THEME_VERSION = "workspace.2";
const MAX_UNDO = 50;
const META_KEY = "meta";
const ASSET_INDEX_KEY = "assets";
// PNG stand-ins for SVG artwork, drawn by a browser (the server can't), for
// PowerPoint viewers without SVG support: { <svgKey>: <assetHash> }.
const RASTER_INDEX_KEY = "rasters";
const MAX_RASTER_LENGTH = 6 * 1024 * 1024;
// Editors draw rasters at most 1600px on a side; a larger one is refused, so
// no one stand-in can pass the PowerPoint library's per-image limits.
const MAX_RASTER_SIDE = 2048;
// Together the stand-ins in one export get at most this many pixels, leaving
// the rest of the library's 64M for the deck's photos and dot grids. An SVG
// past it exports with the blank stand-in: PowerPoint 365 / 2019+ and Keynote
// still draw the SVG itself.
const MAX_EXPORT_RASTER_PIXELS = 24_000_000;
const SLIDE_PREFIX = "s:";
const HIST_PREFIX = "h:";
const ASSET_PREFIX = "a:";
const ASSET_REF = "asset:";
// Keep in sync with client.ts (`shouldExternalize`): which prop values are
// stored as assets rather than inline in the slide.
const ASSET_MIN_LENGTH = 2048;
const ASSET_CHUNK = 40000;
const MAX_ASSET_LENGTH = 32 * 1024 * 1024;
const STORAGE_BATCH = 128;
// Values stay well under the smallest per-value limit (128 KiB), even for
// text that encodes at more than a byte per character.
const HIST_GROUP_CHARS = 40000;
const SWEEP_DELAY_MS = 30000;
const MAX_LOGO_ALT = 500;
// What one edit may grow the deck to: the PowerPoint export's own limits, and a slide well under
// the 2 MiB a stored value may be, even at two bytes a character.
const MAX_SLIDES = 500;
const MAX_BLOCKS_PER_SLIDE = 1000;
const MAX_SLIDE_CHARS = 900_000;

/** The `meta` record. `legacyHash` is the hash of the v1 "deck" value it was migrated from. */
interface StoredMeta {
  v: 2;
  themeVersion: string;
  legacyHash: string | null;
  order: string[];
  rev: number;
  seq: number;
  undo: number[];
  redo: number[];
  /** Absent in decks saved before there was a deck logo. */
  logo?: DeckLogo | null;
}

/** A slide's earlier version in a history step; null when the step created it. */
type SlideVersions = Record<string, Slide | null>;

/**
 * One undo/redo step in memory: what it restores, and how many spill groups it was stored in.
 * `logo` is there only when the step changed the deck logo (null: there was none).
 */
interface HistoryStep {
  seq: number;
  order?: string[];
  logo?: DeckLogo | null;
  slides: SlideVersions;
  groups: number;
}

/** A step's head record (`h:<seq>`): its slides inline, or the number of `h:<seq>:<n>` groups. */
interface StoredStepHead {
  seq: number;
  order?: string[];
  logo?: DeckLogo | null;
  slides?: SlideVersions;
  groups?: number;
}

type StoragePuts = Record<string, unknown>;

/** What a slide from storage or a caller may look like before it is checked. */
type LooseSlide = Partial<Omit<Slide, "blocks" | "background">> & { background?: unknown; blocks?: unknown };

function isAssetRef(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(ASSET_REF);
}
function shouldExternalize(key: string, v: unknown): v is string {
  return typeof v === "string" && v.length >= ASSET_MIN_LENGTH && !v.startsWith(ASSET_REF) && (key === "src" || key === "markup" || v.startsWith("data:"));
}
async function hashString(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let hex = "";
  for (const byte of new Uint8Array(digest, 0, 16)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
function inBatches<T>(list: T[], size = STORAGE_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// The SVG artwork a slide shows: SVG block markup and SVG data-URL images.
// Values may be asset refs.
function svgSourcesOf(slide: Slide | null | undefined, out: Set<string>): Set<string> {
  for (const b of slide?.blocks || []) {
    const p = b?.props;
    if (!p || typeof p !== "object") continue;
    if (b.type === "svg" && typeof p.markup === "string" && p.markup.trim()) out.add(p.markup);
    if (b.type === "image" || b.type === "logo") imageSvgSource(p.src, out);
  }
  return out;
}
// An image source that may be SVG (an asset ref may hold either).
function imageSvgSource(src: unknown, out: Set<string>): void {
  if (typeof src === "string" && (isAssetRef(src) || /^data:image\/svg\+xml/i.test(src))) out.add(src);
}
// A raster's key: the hash of the SVG source it stands in for. An asset ref
// already is that hash (assets are stored under the hash of their data), so
// client and server agree without either reading the other's copy.
async function svgKey(value: string): Promise<string> {
  return isAssetRef(value) ? value.slice(ASSET_REF.length) : hashString(value);
}
function assetHashesOf(slide: Slide | null | undefined, out: Set<string>): Set<string> {
  for (const b of slide?.blocks || []) {
    const p = b?.props;
    if (!p || typeof p !== "object") continue;
    for (const k in p) {
      const v = p[k];
      if (isAssetRef(v)) out.add(v.slice(ASSET_REF.length));
    }
  }
  return out;
}
// The deck logo as a "slide" of one image, so the slide walks above cover it.
function logoAsSlide(logo: DeckLogo | null | undefined): Slide | null {
  return logo ? { id: "", background: {}, blocks: [{ id: "", type: "image", x: 0, y: 0, props: { src: logo.src } }] } : null;
}
// Deep equality of stored JSON, whatever order its keys were written in.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => Object.hasOwn(y, k) && sameValue(x[k], y[k]));
}
// The width and height a PNG data URI's header gives, or null if it isn't a PNG.
function pngSize(dataUri: string): { w: number; h: number } | null {
  let head: string;
  try { head = atob(dataUri.slice(dataUri.indexOf(",") + 1, dataUri.indexOf(",") + 33)); } catch { return null; }
  if (!head.startsWith("\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR")) return null;
  const at = (i: number) => ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0;
  return { w: at(16), h: at(20) };
}
function sameLogo(a: DeckLogo | null, b: DeckLogo | null): boolean {
  return a === b || !!a && !!b && a.src === b.src && a.position === b.position && a.onCover === b.onCover && a.alt === b.alt;
}
function insertIndex(atIndex: unknown, length: number): number {
  const n = atIndex == null ? NaN : Number(atIndex);
  return Number.isInteger(n) && n >= 0 && n <= length ? n : length;
}
function moveIndex(toIndex: unknown, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(Number(toIndex))));
}
// A block with `patch` merged in, as a new object (props merge too).
function mergeBlock(b: Block, patch: BlockPatch & { id?: unknown }): Record<string, unknown> {
  const { props, id, ...rest } = patch;
  const loose: Record<string, unknown> = rest;
  // A geometry value that isn't a number leaves the old one (null clears w/h).
  for (const k of ["x", "y", "w", "h"]) {
    const v = loose[k];
    if (k in loose && !(v === null && (k === "w" || k === "h")) && !Number.isFinite(typeof v === "string" && v.trim() ? Number(v) : v)) delete loose[k];
  }
  const next: Record<string, unknown> = { ...b, ...loose };
  if (props && typeof props === "object" && !Array.isArray(props)) next.props = { ...b.props, ...props };
  return next;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
// A caller's list, refused when it isn't one or is longer than `max`.
function boundedList(list: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(list)) throw new Error(`${what} must be an array.`);
  if (list.length > max) throw new Error(`Too many ${what} (at most ${max}).`);
  return list;
}
// Props that are numbers wherever they appear; numeric strings are accepted.
const NUMERIC_PROPS = ["fontSize", "lineHeight", "scale", "opacity", "strokeWidth", "radius", "width", "x1", "y1", "x2", "y2", "dotGrid"];
// Blocks are stored in a shape every reader (client, exporter, agents) can
// rely on: a string type, finite numeric x/y, w/h positive numbers or absent,
// and a props object. Agents often send numbers as strings ("120"), which
// would otherwise concatenate on the first nudge. Returns a new object, or
// null for something that isn't a block. (The id is checked by the caller.)
function normalizeBlock(b: unknown): (Omit<Block, "id"> & { id?: unknown }) | null {
  if (!isPlainObject(b)) return null;
  const num = (v: unknown) => {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };
  const out: Record<string, unknown> & { type: string; x: number; y: number } = { ...b, type: typeof b.type === "string" && b.type ? b.type : "text", x: num(b.x) ?? 0, y: num(b.y) ?? 0 };
  for (const k of ["w", "h"]) {
    const n = num(b[k]);
    if (n === undefined || n <= 0) delete out[k];
    else out[k] = n;
  }
  const props: BlockProps = isPlainObject(b.props) ? { ...b.props } as BlockProps : {};
  for (const k of NUMERIC_PROPS) {
    const v = props[k];
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) props[k] = Number(v);
  }
  return Object.assign(out, { props });
}

export class Gadget extends DurableObject implements GadgetStub {
  state: DurableObjectState;
  subscribers: SubscriberRegistry<DeckCallbacks>;
  // Tabs still running the previous Slides client (see subscribe).
  legacySubscribers: SubscriberRegistry<LegacyDeckCallbacks>;
  #legacyFeed: Promise<void> = Promise.resolve();
  #legacyQueued = false;
  #order: string[] = [];
  #slides = new Map<string, Slide>();
  #rev = 0;
  #seq = 0;
  #undo: HistoryStep[] = [];
  #redo: HistoryStep[] = [];
  #assets = new Map<string, number>();
  #rasters = new Map<string, string>();
  #mutations = new MutationQueue();
  #sweepTimer: ReturnType<typeof setTimeout> | null = null;
  #legacyHash: string | null = null;
  #logo: DeckLogo | null = null;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env as Cloudflare.Env);
    this.state = state;
    this.subscribers = new SubscriberRegistry();
    this.legacySubscribers = new SubscriberRegistry();
    state.blockConcurrencyWhile(() => this.#load());
  }

  // Mutations run one at a time, in arrival order. (Hashing an asset awaits
  // something other than storage, which would otherwise let calls interleave.)
  // One that fails may have stored assets nothing uses, so a sweep follows.
  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#mutations.run(fn);
    result.catch(() => this.#scheduleSweep());
    return result;
  }

  // -------- load & persist ------------------------------------------------
  // The v1 record is left where it was, so the previous version of this
  // gadget still finds its deck. If that version saved to it after the
  // migration (its hash no longer matches), it is migrated again.
  async #load(): Promise<void> {
    const st = this.state.storage;
    const [meta, legacy] = await Promise.all([st.get<StoredMeta>(META_KEY), st.get<{ slides?: unknown }>(LEGACY_KEY)]);
    const legacyHash = legacy ? await hashString(JSON.stringify(legacy)) : null;
    this.#legacyHash = legacyHash;
    // The theme version is only a marker: a deck from any earlier theme
    // (including the "workspace.1" decks of the previous Slides blueprint) is
    // kept and migrated, never reseeded, since it holds someone's work.
    if (meta && meta.v === 2 && (meta.legacyHash ?? null) === legacyHash) {
      return this.#loadV2(meta);
    }
    if (meta) await this.#clearV2();
    const usable = legacy && Array.isArray(legacy.slides);
    let slides: unknown[] = initialDeck().slides;
    if (usable) {
      slides = structuredClone(legacy.slides as unknown[]);
      migrateLogoBlocks({ slides: slides as LooseSlide[] });
    }
    await this.#seed(slides);
  }
  // Deletes the v2 records but not the v1 one. Meta goes last, so a load
  // after an interruption finds it stale and clears again.
  async #clearV2(): Promise<void> {
    const st = this.state.storage;
    for (let after: string | undefined; ;) {
      const keys = [...(await st.list({ startAfter: after, limit: 128 })).keys()];
      if (!keys.length) break;
      after = keys[keys.length - 1];
      const doomed = keys.filter((k) => k !== LEGACY_KEY && k !== META_KEY);
      if (doomed.length) await st.delete(doomed);
    }
    await st.delete(META_KEY);
  }
  async #loadV2(meta: StoredMeta): Promise<void> {
    const st = this.state.storage;
    const [slideMap, histMap, index, rasters] = await Promise.all([
      st.list<Slide>({ prefix: SLIDE_PREFIX }),
      st.list<StoredStepHead | SlideVersions>({ prefix: HIST_PREFIX }),
      st.get<Record<string, number>>(ASSET_INDEX_KEY),
      st.get<Record<string, string>>(RASTER_INDEX_KEY),
    ]);
    for (const [key, s] of slideMap) if (s && typeof s === "object") this.#slides.set(key.slice(SLIDE_PREFIX.length), s);
    const seen = new Set<string>();
    this.#order = (Array.isArray(meta.order) ? meta.order : []).filter((id) => this.#slides.has(id) && !seen.has(id) && seen.add(id));
    this.#rev = Number(meta.rev) || 0;
    this.#seq = Number(meta.seq) || 0;
    this.#logo = isPlainObject(meta.logo) && typeof meta.logo.src === "string" ? meta.logo : null;
    this.#assets = new Map(Object.entries(index || {}));
    this.#rasters = new Map(Object.entries(rasters || {}).filter(([, hash]) => this.#assets.has(hash)));
    const readStep = (seq: number): HistoryStep | null => {
      const head = histMap.get(HIST_PREFIX + seq) as StoredStepHead | undefined;
      if (!head) return null;
      const slides: SlideVersions = { ...head.slides || {} };
      for (let g = 0; g < (head.groups || 0); g++) Object.assign(slides, histMap.get(`${HIST_PREFIX}${seq}:${g}`) || {});
      // A step saved by an earlier build can hold blocks the deck no longer has (a Gadgets
      // mark): an undo must not bring them back.
      migrateLogoBlocks({ slides: Object.values(slides).filter((s): s is Slide => !!s) });
      const step: HistoryStep = { seq, order: head.order, slides, groups: head.groups || 0 };
      if ("logo" in head) step.logo = head.logo ?? null;
      return step;
    };
    const isStep = (step: HistoryStep | null): step is HistoryStep => !!step;
    this.#undo = (meta.undo || []).map(readStep).filter(isStep);
    this.#redo = (meta.redo || []).map(readStep).filter(isStep);
    // Tidy anything an older or interrupted session left behind.
    const puts: StoragePuts = {}, dels: string[] = [];
    for (const id of this.#slides.keys()) {
      if (!seen.has(id)) {
        this.#slides.delete(id);
        dels.push(SLIDE_PREFIX + id);
      }
    }
    const live = new Set([...this.#undo, ...this.#redo].map((e) => String(e.seq)));
    for (const key of histMap.keys()) if (!live.has(key.slice(HIST_PREFIX.length).split(":")[0])) dels.push(key);
    if (!this.#order.length) {
      const s = newBlankSlide();
      this.#slides.set(s.id, s);
      this.#order = [s.id];
      puts[SLIDE_PREFIX + s.id] = s;
      puts[META_KEY] = this.#meta();
    }
    for (const id of this.#order) {
      const s = this.#slides.get(id);
      if (s && migrateLogoBlocks({ slides: [s] })) puts[SLIDE_PREFIX + id] = s;
    }
    if (dels.length || Object.keys(puts).length) await this.#write(puts, dels);
    this.#scheduleSweep();
  }
  // A fresh store from plain slides (first run, a migration, or a theme reset).
  async #seed(rawSlides: unknown[]): Promise<void> {
    const seen = new Set<string>();
    for (const raw of rawSlides) {
      if (!isPlainObject(raw)) continue;
      const id = slideIdFrom(raw.id, (x) => seen.has(x));
      seen.add(id);
      this.#slides.set(id, await this.#prepareSlide({ ...raw, id }));
      this.#order.push(id);
    }
    if (!this.#order.length) {
      const s = newBlankSlide();
      this.#slides.set(s.id, s);
      this.#order.push(s.id);
    }
    const puts: StoragePuts = { [META_KEY]: this.#meta() };
    for (const id of this.#order) puts[SLIDE_PREFIX + id] = this.#slides.get(id);
    await this.#write(puts, []);
  }
  #meta(): StoredMeta {
    return {
      v: 2,
      themeVersion: THEME_VERSION,
      legacyHash: this.#legacyHash,
      order: this.#order,
      rev: this.#rev,
      seq: this.#seq,
      undo: this.#undo.map((e) => e.seq),
      redo: this.#redo.map((e) => e.seq),
      logo: this.#logo,
    };
  }
  // Every put/delete is issued without an await in between, so storage
  // coalesces them into one atomic write.
  #write(puts: StoragePuts, dels: string[]): Promise<unknown[]> {
    const st = this.state.storage;
    const ops: Promise<unknown>[] = [];
    for (const group of inBatches(Object.entries(puts))) ops.push(st.put(Object.fromEntries(group)));
    for (const group of inBatches(dels)) ops.push(st.delete(group));
    return Promise.all(ops);
  }
  #stepPuts(step: HistoryStep): StoragePuts {
    const ids = Object.keys(step.slides);
    const head: StoredStepHead = { seq: step.seq };
    if (step.order) head.order = step.order;
    if ("logo" in step) head.logo = step.logo ?? null;
    if (ids.length <= 1) {
      head.slides = step.slides;
      step.groups = 0;
      return { [HIST_PREFIX + step.seq]: head };
    }
    const puts: StoragePuts = {};
    let group: SlideVersions = {}, size = 0, g = 0;
    for (const id of ids) {
      const s = step.slides[id];
      const n = s ? JSON.stringify(s).length : 4;
      if (size && size + n > HIST_GROUP_CHARS) {
        puts[`${HIST_PREFIX}${step.seq}:${g++}`] = group;
        group = {};
        size = 0;
      }
      group[id] = s;
      size += n;
    }
    puts[`${HIST_PREFIX}${step.seq}:${g++}`] = group;
    head.groups = step.groups = g;
    puts[HIST_PREFIX + step.seq] = head;
    return puts;
  }
  #stepKeys(step: HistoryStep): string[] {
    const keys = [HIST_PREFIX + step.seq];
    for (let g = 0; g < (step.groups || 0); g++) keys.push(`${HIST_PREFIX}${step.seq}:${g}`);
    return keys;
  }

  // -------- assets --------------------------------------------------------
  async #putAsset(data: string): Promise<string> {
    if (data.length > MAX_ASSET_LENGTH) throw new Error("That file is too large to store in a deck.");
    const hash = await hashString(data);
    if (!this.#assets.has(hash)) {
      const n = Math.max(1, Math.ceil(data.length / ASSET_CHUNK));
      this.#assets.set(hash, n);
      const puts: StoragePuts = { [ASSET_INDEX_KEY]: Object.fromEntries(this.#assets) };
      for (let i = 0; i < n; i++) puts[`${ASSET_PREFIX}${hash}:${i}`] = data.slice(i * ASSET_CHUNK, (i + 1) * ASSET_CHUNK);
      await this.#write(puts, []);
    }
    return ASSET_REF + hash;
  }
  // A new or changed block, normalized (see normalizeBlock; null if it isn't
  // a block at all), with its big media moved out to assets.
  async #prepareBlock(raw: unknown): Promise<(Omit<Block, "id"> & { id?: unknown }) | null> {
    const b = normalizeBlock(raw);
    if (!b) return null;
    const p = b.props;
    let props: BlockProps | null = null;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (!shouldExternalize(k, v)) continue;
      props ??= { ...p };
      props[k] = await this.#putAsset(v);
    }
    return props ? { ...b, props } : b;
  }
  // A whole block list: non-blocks dropped, ids unique on the slide.
  async #prepareBlocks(blocks: unknown): Promise<Block[]> {
    const out: Block[] = [], seen = new Set<string>();
    for (const raw of Array.isArray(blocks) ? blocks : []) {
      const b = await this.#prepareBlock(raw);
      if (!b) continue;
      const id = typeof b.id === "string" && b.id && !seen.has(b.id) ? b.id : genId();
      seen.add(id);
      out.push({ ...b, id });
    }
    return out;
  }
  async #prepareSlide(s: LooseSlide & { id: string }): Promise<Slide> {
    const background = isPlainObject(s.background) ? s.background : {};
    return { ...s, background, blocks: await this.#prepareBlocks(s.blocks) };
  }
  // An asset's first chunk, enough to tell what kind of data it holds ("" if there is none).
  async #assetHead(hash: string): Promise<string> {
    if (!this.#assets.has(hash)) return "";
    return await this.state.storage.get<string>(`${ASSET_PREFIX}${hash}:0`) ?? "";
  }
  async #readAsset(hash: string): Promise<string | null> {
    const n = this.#assets.get(hash);
    if (!n) return null;
    const keys = Array.from({ length: n }, (_, i) => `${ASSET_PREFIX}${hash}:${i}`);
    const parts: string[] = [];
    for (const group of inBatches(keys)) {
      const got = await this.state.storage.get<string>(group);
      for (const key of group) {
        const v = got.get(key);
        if (typeof v !== "string") return null;
        parts.push(v);
      }
    }
    return parts.join("");
  }
  // Assets no longer used by the deck or its history are deleted, a little
  // while after history steps are dropped.
  #scheduleSweep(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = null;
      this.#mutations.run(() => this.#sweep()).catch((e) => console.error("Asset sweep failed", e));
    }, SWEEP_DELAY_MS);
  }
  async #sweep(): Promise<void> {
    if (!this.#assets.size) return;
    const used = new Set<string>();
    // Everything the deck and its history show: slides and logos.
    const shown: Array<Slide | null> = [...this.#slides.values(), logoAsSlide(this.#logo)];
    for (const step of [...this.#undo, ...this.#redo]) {
      shown.push(...Object.values(step.slides));
      if (step.logo) shown.push(logoAsSlide(step.logo));
    }
    for (const s of shown) assetHashesOf(s, used);
    // SVG rasters live as long as their artwork is in the deck or its history.
    const svgs = new Set<string>();
    for (const s of shown) svgSourcesOf(s, svgs);
    const liveKeys = new Set<string>();
    for (const v of svgs) liveKeys.add(await svgKey(v));
    let rastersChanged = false;
    for (const [key, hash] of this.#rasters) {
      if (liveKeys.has(key)) used.add(hash);
      else { this.#rasters.delete(key); rastersChanged = true; }
    }
    if (rastersChanged) await this.#write({ [RASTER_INDEX_KEY]: Object.fromEntries(this.#rasters) }, []);
    const dels: string[] = [];
    for (const [hash, n] of this.#assets) {
      if (used.has(hash)) continue;
      for (let i = 0; i < n; i++) dels.push(`${ASSET_PREFIX}${hash}:${i}`);
      this.#assets.delete(hash);
    }
    if (dels.length) await this.#write({ [ASSET_INDEX_KEY]: Object.fromEntries(this.#assets) }, dels);
  }

  // -------- commit --------------------------------------------------------
  // Apply one step. `changes` maps slide id -> new slide (or null to remove);
  // `nextOrder` is the new slide order, or null if unchanged. `kind` is
  // "edit" (a new undo step, clearing redo), "undo" or "redo"; `consumed` is
  // the history step an undo/redo used up; `nextLogo` is the new deck logo,
  // or undefined if unchanged.
  // An edit that changes nothing is dropped (it would clear redo and leave
  // an undo step that does nothing), and one that would grow the deck past
  // its limits is refused before anything changes.
  async #apply(changes: Map<string, Slide | null>, nextOrder: string[] | null, kind: "edit" | "undo" | "redo", consumed: HistoryStep | null = null, nextLogo?: DeckLogo | null): Promise<void> {
    if (nextOrder && sameOrder(nextOrder, this.#order)) nextOrder = null;
    const logoChanged = nextLogo !== undefined && !sameLogo(nextLogo, this.#logo);
    if (kind === "edit") {
      for (const [id, s] of changes) if (sameValue(s, this.#slides.get(id) ?? null)) changes.delete(id);
      if (!changes.size && !nextOrder && !logoChanged) return;
      this.#checkLimits(changes, nextOrder);
    }
    const inverse: HistoryStep = { seq: ++this.#seq, slides: {}, groups: 0 };
    for (const id of changes.keys()) inverse.slides[id] = this.#slides.get(id) ?? null;
    if (nextOrder) inverse.order = this.#order;
    if (logoChanged) {
      inverse.logo = this.#logo;
      this.#logo = nextLogo;
    }
    const puts: StoragePuts = {}, dels: string[] = [], sent: Record<string, Slide> = {};
    for (const [id, s] of changes) {
      if (s) {
        this.#slides.set(id, s);
        puts[SLIDE_PREFIX + id] = s;
        sent[id] = s;
      } else {
        this.#slides.delete(id);
        dels.push(SLIDE_PREFIX + id);
      }
    }
    if (nextOrder) this.#order = nextOrder;
    let dropped: HistoryStep[] = [];
    if (kind === "edit") {
      this.#undo.push(inverse);
      if (this.#undo.length > MAX_UNDO) dropped = this.#undo.splice(0, this.#undo.length - MAX_UNDO);
      dropped.push(...this.#redo);
      this.#redo = [];
    } else if (kind === "undo") {
      this.#redo.push(inverse);
    } else {
      this.#undo.push(inverse);
    }
    Object.assign(puts, this.#stepPuts(inverse));
    for (const step of dropped) dels.push(...this.#stepKeys(step));
    if (consumed) dels.push(...this.#stepKeys(consumed));
    const base = this.#rev;
    this.#rev = base + 1;
    puts[META_KEY] = this.#meta();
    await this.#write(puts, dels);
    if (dropped.length) this.#scheduleSweep();
    const patch: DeckPatch = { rev: this.#rev, base, slides: sent };
    if (nextOrder) patch.order = this.#order;
    if (logoChanged) patch.logo = this.#logo;
    this.#broadcast(patch);
  }
  // Throws when an edit would take the deck past MAX_SLIDES, a slide past
  // MAX_BLOCKS_PER_SLIDE (counts already past them, from older decks, may
  // shrink but not grow), or a slide past what storage can hold.
  #checkLimits(changes: Map<string, Slide | null>, nextOrder: string[] | null): void {
    if (nextOrder && nextOrder.length > MAX_SLIDES && nextOrder.length > this.#order.length) {
      throw new Error(`A deck can have at most ${MAX_SLIDES} slides.`);
    }
    for (const [id, s] of changes) {
      if (!s) continue;
      const count = (s.blocks || []).length;
      if (count > MAX_BLOCKS_PER_SLIDE && count > (this.#slides.get(id)?.blocks || []).length) {
        throw new Error(`A slide can have at most ${MAX_BLOCKS_PER_SLIDE} blocks.`);
      }
      if (JSON.stringify(s).length > MAX_SLIDE_CHARS) {
        throw new Error("That slide is too large to save: shorten its text, or split it across slides.");
      }
    }
  }
  // Delivery is the registry's: issued at once and never awaited, so a slow or
  // failing browser holds up neither the save nor the other subscribers.
  #broadcast(patch: DeckPatch): void {
    const meta: UndoState = {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
    };
    this.subscribers.broadcast((sub) => sub.deckPatched(patch, meta));
    this.#feedLegacy();
  }
  // A tab of the previous client wants the whole deck, with its media
  // inlined (it can't read asset refs). Sent in order, and coalesced: each
  // send carries the deck as it is by then.
  #feedLegacy(): void {
    if (!this.legacySubscribers.size || this.#legacyQueued) return;
    this.#legacyQueued = true;
    this.#legacyFeed = this.#legacyFeed.then(async () => {
      this.#legacyQueued = false;
      if (!this.legacySubscribers.size) return;
      const deck = await this.getDeckInlined();
      const meta = await this.getUndoState();
      this.legacySubscribers.broadcast((sub) => sub.deckChanged(deck, meta));
    }).catch((e) => console.error("Legacy deck broadcast failed", e));
  }
  #deckView(): Deck & { themeVersion: string; rev: number } {
    return { themeVersion: THEME_VERSION, rev: this.#rev, slides: this.#order.map((id) => this.#slides.get(id)).filter((s): s is Slide => !!s), logo: this.#logo };
  }

  // -------- undo / redo ---------------------------------------------------
  async getUndoState(): Promise<UndoState> {
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
    };
  }
  undo(): Promise<boolean> {
    return this.#run(async () => {
      const step = this.#undo.pop();
      if (!step) return false;
      await this.#apply(new Map(Object.entries(step.slides)), step.order || null, "undo", step, "logo" in step ? step.logo ?? null : undefined);
      return true;
    });
  }
  redo(): Promise<boolean> {
    return this.#run(async () => {
      const step = this.#redo.pop();
      if (!step) return false;
      await this.#apply(new Map(Object.entries(step.slides)), step.order || null, "redo", step, "logo" in step ? step.logo ?? null : undefined);
      return true;
    });
  }

  // -------- read ----------------------------------------------------------
  // The deck as stored: big media appears as "asset:<hash>" refs (read them
  // with getAsset). `rev` counts saved changes. While a tab of the previous
  // client is open, the media is inlined unless the caller passes
  // `{ refs: true }` (as this client does): that client reads the deck back
  // after some edits and can't resolve refs.
  async getDeck(options?: { refs?: boolean }): Promise<Deck> {
    if (this.legacySubscribers.size && !(isPlainObject(options) && options.refs === true)) return this.getDeckInlined();
    return this.#deckView();
  }
  // The deck with every asset ref replaced by its data (used for export).
  async getDeckInlined(): Promise<Deck> {
    const view = this.#deckView();
    const cache = new Map<string, string>();
    const read = async (ref: string): Promise<string> => {
      const hash = ref.slice(ASSET_REF.length);
      let data = cache.get(hash);
      if (data === undefined) cache.set(hash, data = await this.#readAsset(hash) ?? "");
      return data;
    };
    const slides: Slide[] = [];
    for (const s of view.slides) {
      let blocks: Block[] | null = null;
      const list = s.blocks || [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i]?.props;
        if (!p || typeof p !== "object") continue;
        let props: BlockProps | null = null;
        for (const k of Object.keys(p)) {
          const v = p[k];
          if (!isAssetRef(v)) continue;
          props ??= { ...p };
          props[k] = await read(v);
        }
        if (props) {
          blocks ??= [...list];
          blocks[i] = { ...list[i], props };
        }
      }
      slides.push(blocks ? { ...s, blocks } : s);
    }
    const logo = view.logo && isAssetRef(view.logo.src) ? { ...view.logo, src: await read(view.logo.src) } : view.logo;
    return { ...view, slides, logo };
  }
  // One asset's data (e.g. an image's data: URI), by "asset:<hash>" ref.
  async getAsset(ref: string): Promise<string | null> {
    const s = String(ref ?? "");
    return this.#readAsset(s.startsWith(ASSET_REF) ? s.slice(ASSET_REF.length) : s);
  }

  // ---- SVG rasters (for PowerPoint) --------------------------------------
  // Browsers draw a PNG of each piece of SVG artwork and save it here, so
  // PowerPoint viewers that can't show SVG show the PNG instead. Keys are
  // svgKey() of the SVG source. None of this touches the deck or its undo.

  // The keys of the SVG artwork the deck shows now.
  async #liveSvgKeys(): Promise<Set<string>> {
    const live = new Set<string>();
    for (const s of [...this.#slides.values(), logoAsSlide(this.#logo)]) for (const v of svgSourcesOf(s, new Set())) live.add(await svgKey(v));
    return live;
  }
  // Which of `keys` have no raster yet (and are in the deck).
  async missingSvgRasters(keys: string[]): Promise<string[]> {
    const live = await this.#liveSvgKeys();
    return (Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string" && live.has(k) && !this.#rasters.has(k));
  }
  // Saves the PNG for artwork the deck shows (false for any other key).
  saveSvgRaster(key: string, png: string): Promise<boolean> {
    return this.#run(async () => {
      if (typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return false;
      if (typeof png !== "string" || !png.startsWith("data:image/png;base64,") || png.length > MAX_RASTER_LENGTH) return false;
      const size = pngSize(png);
      if (!size || !size.w || !size.h || size.w > MAX_RASTER_SIDE || size.h > MAX_RASTER_SIDE) return false;
      if (this.#rasters.has(key)) return true;
      if (!(await this.#liveSvgKeys()).has(key)) return false;
      const ref = await this.#putAsset(png);
      this.#rasters.set(key, ref.slice(ASSET_REF.length));
      await this.#write({ [RASTER_INDEX_KEY]: Object.fromEntries(this.#rasters) }, []);
      return true;
    });
  }
  // { key: pngDataUri } for the keys that have one (used by the exporter).
  async getSvgRasters(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of Array.isArray(keys) ? keys : []) {
      const hash = this.#rasters.get(k);
      const png = hash ? await this.#readAsset(hash) : null;
      if (png) out[k] = png;
    }
    return out;
  }
  // The orange cover artwork. One copy, shared by the browser renderer
  // (which fetches it at boot) and the PowerPoint exporter.
  async getBrandAssets(): Promise<BrandAssets> {
    return { coverOrange: COVER_ORANGE_PNG };
  }
  // A compact map of the deck for agents: every slide with its id, position,
  // a label, and each block's id, type, position and readable text. Read this
  // first, then edit one block at a time (see README → "How agents should edit").
  async listSlides(): Promise<SlideSummary[]> {
    return this.#deckView().slides.map((s, index) => ({
      id: s.id,
      index,
      label: slideLabelOf(s),
      background: s.background || {},
      blocks: (s.blocks || []).map((b) => ({
        id: b.id,
        type: b.type,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        text: blockTextOf(b),
      })),
    }));
  }
  // One slide in full (every block with all of its props).
  async getSlide(slideId: string): Promise<Slide | null> {
    return this.#slides.get(slideId) || null;
  }

  // -------- deck logo -----------------------------------------------------
  // Set, change or remove the deck logo (one undo step). The patch is merged
  // into the current logo: { src } sets the image (a PNG, JPEG or SVG data:
  // URI), { position }, { onCover } and { alt } adjust it, and null or an
  // empty src removes it. Returns the logo as stored (its image an asset ref).
  setLogo(logo: DeckLogoPatch | null): Promise<DeckLogo | null> {
    return this.#run(async () => {
      const next = await this.#prepareLogo(logo);
      if (!sameLogo(next, this.#logo)) await this.#apply(new Map(), null, "edit", null, next);
      return this.#logo;
    });
  }
  // A logo patch merged into the current logo and checked, with a big image
  // moved out to an asset. Throws on anything that isn't a logo.
  async #prepareLogo(patch: DeckLogoPatch | null | undefined): Promise<DeckLogo | null> {
    if (patch == null) return null;
    if (!isPlainObject(patch)) throw new Error("setLogo takes { src, position, onCover, alt }, or null to remove the logo.");
    const pick = <K extends keyof DeckLogo>(k: K): DeckLogo[K] | null | undefined => k in patch ? patch[k] : this.#logo?.[k];
    const src = pick("src");
    if (src == null || src === "") return null;
    if (typeof src !== "string") throw new Error("The logo's src must be a string.");
    if (!isLogoImageData(isAssetRef(src) ? await this.#assetHead(src.slice(ASSET_REF.length)) : src)) {
      throw new Error("The logo must be a PNG, JPEG or SVG image, as a data: URI.");
    }
    const position = pick("position") ?? DEFAULT_LOGO_POSITION;
    if (!isLogoPosition(position)) throw new Error("The logo's position must be top-left, top-right, bottom-left or bottom-right.");
    const onCover = pick("onCover") ?? true;
    if (typeof onCover !== "boolean") throw new Error("The logo's onCover must be true or false.");
    const alt = pick("alt");
    if (alt != null && typeof alt !== "string") throw new Error("The logo's alt text must be a string.");
    const next: DeckLogo = { src: shouldExternalize("src", src) ? await this.#putAsset(src) : src, position, onCover };
    const trimmed = alt?.trim().slice(0, MAX_LOGO_ALT);
    if (trimmed) next.alt = trimmed;
    return next;
  }

  // -------- slide ops -----------------------------------------------------
  // Insert a slide (at the end by default): { layout } builds it from a named
  // layout, { background, blocks } as given; nothing at all, the cover slide.
  addSlide(atIndex?: number | null, slide?: SlideInput): Promise<string> {
    return this.#run(async () => {
      const raw: LooseSlide = isPlainObject(slide) ? slideFromInput(slide) : newBlankSlide();
      if (raw.blocks !== undefined) boundedList(raw.blocks, MAX_BLOCKS_PER_SLIDE, "blocks");
      // Slide and block ids must be unique: keep a supplied one only if it is
      // (#prepareSlide sees to the blocks).
      const id = slideIdFrom(raw.id, (x) => this.#slides.has(x));
      const s = await this.#prepareSlide({ ...raw, id });
      const order = [...this.#order];
      order.splice(insertIndex(atIndex, order.length), 0, s.id);
      await this.#apply(new Map([[s.id, s]]), order, "edit");
      return s.id;
    });
  }
  removeSlide(slideId: string): Promise<void> {
    return this.#run(async () => {
      const changes = new Map<string, Slide | null>();
      let order = this.#order.filter((id) => id !== slideId);
      if (order.length !== this.#order.length) changes.set(slideId, null);
      if (order.length === 0) {
        const blank = newBlankSlide();
        changes.set(blank.id, blank);
        order = [blank.id];
      }
      await this.#apply(changes, order, "edit");
    });
  }
  duplicateSlide(slideId: string): Promise<string | null> {
    return this.#run(async () => {
      const src = this.#slides.get(slideId);
      if (!src) return null;
      const copy: Slide = JSON.parse(JSON.stringify(src));
      copy.id = genId();
      copy.blocks = (copy.blocks || []).map((b) => ({ ...b, id: genId() }));
      const order = [...this.#order];
      order.splice(order.indexOf(slideId) + 1, 0, copy.id);
      await this.#apply(new Map([[copy.id, copy]]), order, "edit");
      return copy.id;
    });
  }
  moveSlide(slideId: string, toIndex: number): Promise<void> {
    return this.#run(async () => {
      const i = this.#order.indexOf(slideId);
      if (i < 0 || !Number.isFinite(Number(toIndex))) return;
      const order = [...this.#order];
      order.splice(i, 1);
      order.splice(moveIndex(toIndex, order.length), 0, slideId);
      await this.#apply(new Map(), order, "edit");
    });
  }
  updateSlide(slideId: string, patch: SlidePatch): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s || !isPlainObject(patch)) return;
      const next: Slide = { ...s };
      if (isPlainObject(patch.background)) next.background = { ...s.background, ...patch.background };
      const { background, id, blocks, ...rest } = patch as SlidePatch & { id?: unknown };
      Object.assign(next, rest);
      if (blocks !== undefined) next.blocks = await this.#prepareBlocks(boundedList(blocks, MAX_BLOCKS_PER_SLIDE, "blocks"));
      await this.#apply(new Map([[slideId, next]]), null, "edit");
    });
  }

  // -------- block ops -----------------------------------------------------
  addBlock(slideId: string, block: BlockInput, atIndex?: number | null): Promise<string | null> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s) return null;
      const blocks = [...s.blocks || []];
      // Block ids must be unique on the slide: keep a supplied one only if it is.
      const b = await this.#prepareBlock(block);
      if (!b) return null;
      const supplied = b.id;
      const id = typeof supplied !== "string" || !supplied || blocks.some((x) => x.id === supplied) ? genId() : supplied;
      blocks.splice(insertIndex(atIndex, blocks.length), 0, { ...b, id });
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
      return id;
    });
  }
  updateBlock(slideId: string, blockId: string, patch: BlockPatch): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s) return;
      const blocks = [...s.blocks || []];
      const i = blocks.findIndex((b) => b.id === blockId);
      if (i < 0 || !isPlainObject(patch)) return;
      blocks[i] = await this.#preparePatched(blocks[i], patch);
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
    });
  }
  // A block with a patch applied, normalized. The merge keeps the block's
  // id, so the result is always a block.
  async #preparePatched(b: Block, patch: BlockPatch): Promise<Block> {
    const next = await this.#prepareBlock(mergeBlock(b, patch));
    return { ...next as Omit<Block, "id">, id: b.id };
  }
  removeBlock(slideId: string, blockId: string): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s) return;
      const blocks = (s.blocks || []).filter((b) => b.id !== blockId);
      if (blocks.length === (s.blocks || []).length) return;
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
    });
  }
  reorderBlock(slideId: string, blockId: string, toIndex: number): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s) return;
      const blocks = [...s.blocks || []];
      const i = blocks.findIndex((b) => b.id === blockId);
      if (i < 0 || !Number.isFinite(Number(toIndex))) return;
      const [b] = blocks.splice(i, 1);
      const to = moveIndex(toIndex, blocks.length);
      if (to === i) return;
      blocks.splice(to, 0, b);
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
    });
  }

  // -------- multi-block ops (one save, one undo step) ---------------------
  addBlocks(slideId: string, blocks: BlockInput[]): Promise<string[]> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s || !Array.isArray(blocks)) return [];
      const next = [...s.blocks || []];
      boundedList(blocks, Math.max(0, MAX_BLOCKS_PER_SLIDE - next.length), "blocks");
      const ids: string[] = [];
      for (const block of blocks) {
        const b = await this.#prepareBlock(block);
        if (!b) continue;
        // As in addBlock: a supplied id is kept only if it is unique on the slide.
        const supplied = b.id;
        const id = typeof supplied !== "string" || !supplied || next.some((x) => x.id === supplied) ? genId() : supplied;
        next.push({ ...b, id });
        ids.push(id);
      }
      if (!ids.length) return ids;
      await this.#apply(new Map([[slideId, { ...s, blocks: next }]]), null, "edit");
      return ids;
    });
  }
  // patches: [{ id, patch }] — each patch merges like updateBlock's.
  updateBlocks(slideId: string, patches: BlockPatchEntry[]): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s || !Array.isArray(patches)) return;
      const blocks = [...s.blocks || []];
      let changed = false;
      for (const entry of patches) {
        const { id, patch } = isPlainObject(entry) ? entry as Partial<BlockPatchEntry> : {};
        const i = blocks.findIndex((b) => b.id === id);
        if (i < 0 || !isPlainObject(patch)) continue;
        blocks[i] = await this.#preparePatched(blocks[i], patch);
        changed = true;
      }
      if (!changed) return;
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
    });
  }
  removeBlocks(slideId: string, blockIds: string[]): Promise<void> {
    return this.#run(async () => {
      const s = this.#slides.get(slideId);
      if (!s || !Array.isArray(blockIds)) return;
      const gone = new Set(blockIds);
      const blocks = (s.blocks || []).filter((b) => !gone.has(b.id));
      if (blocks.length === (s.blocks || []).length) return;
      await this.#apply(new Map([[slideId, { ...s, blocks }]]), null, "edit");
    });
  }

  // -------- bulk ----------------------------------------------------------
  // `logo` replaces the deck logo too; undefined keeps it.
  async #replaceAll(rawSlides: unknown, logo?: DeckLogoPatch | null): Promise<void> {
    const list = boundedList(rawSlides, MAX_SLIDES, "slides");
    for (const raw of list) if (isPlainObject(raw) && raw.blocks !== undefined) boundedList(raw.blocks, MAX_BLOCKS_PER_SLIDE, "blocks");
    const nextLogo = logo === undefined ? undefined : await this.#prepareLogo(logo);
    const changes = new Map<string, Slide | null>();
    for (const id of this.#order) changes.set(id, null);
    const order: string[] = [], seen = new Set<string>();
    for (const raw of list) {
      if (!isPlainObject(raw)) continue;
      const id = slideIdFrom(raw.id, (x) => seen.has(x));
      seen.add(id);
      changes.set(id, await this.#prepareSlide({ ...raw, id }));
      order.push(id);
    }
    if (!order.length) {
      const blank = newBlankSlide();
      changes.set(blank.id, blank);
      order.push(blank.id);
    }
    await this.#apply(changes, order, "edit", null, nextLogo);
  }
  // Replaces every slide, and the deck logo when `deck.logo` is given (null
  // removes it); without one the logo stays.
  setDeck(deck: { slides: SlideInput[]; logo?: DeckLogoPatch | null }): Promise<void> {
    return this.#run(() => this.#replaceAll(deck?.slides, deck?.logo));
  }
  // Back to a new deck: the cover slide alone, and no logo.
  resetAll(): Promise<Deck> {
    return this.#run(async () => {
      await this.#replaceAll(initialDeck().slides, null);
      return this.#deckView();
    });
  }

  // -------- realtime ------------------------------------------------------
  // This client subscribes with { patches: true }. A tab still running the
  // previous Slides client (open while the gadget took this update) passes
  // nothing and implements only deckChanged(deck, meta): it is sent the whole
  // deck, media inlined, now and after every change, so it keeps working
  // until it reloads. (A stub answers to any method name; which callback the
  // browser implements is what its subscribe call says.)
  async subscribe(cb: DeckCallbacks & LegacyDeckCallbacks, options?: SubscribeOptions): Promise<void> {
    if (isPlainObject(options) && options.patches === true) {
      this.subscribers.add(cb);
      return;
    }
    this.legacySubscribers.add(cb);
    this.#feedLegacy();
  }
}

// A caller's slide id, unless it is missing, taken, or a name every object has
// already: history steps and patches key slides by id, and `__proto__` would
// vanish from them.
function slideIdFrom(raw: unknown, taken: (id: string) => boolean): string {
  return typeof raw === "string" && raw && !(raw in Object.prototype) && !taken(raw) ? raw : genId();
}
function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}
// Readable text of a block: its string props, minus image data and SVG markup.
function blockTextOf(b: Block): string {
  const p = b.props || {};
  const parts: string[] = [];
  for (const k in p) {
    if (k === "src" || k === "markup") continue;
    const v = p[k];
    if (typeof v !== "string" || !v.trim() || v.startsWith("data:") || v.startsWith(ASSET_REF) || v.length > 4000) continue;
    if (/^#[0-9a-f]{3,8}$/i.test(v.trim())) continue;
    parts.push(v);
  }
  return parts.join(" · ");
}
function slideLabelOf(s: Slide): string {
  for (const type of ["title", "subtitle", "text", "sectionLabel"]) {
    for (const b of s.blocks || []) {
      if (b.type !== type) continue;
      const t = String(b.props?.text || "").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
  }
  return "Untitled";
}
// Logos still at an earlier template's top-right spot move to the current
// one (a right-aligned box ending on the 36px margin, centred on the section
// label), and a logo saved without a name gets the default one. Logos you
// placed yourself are left alone. Gadgets marks are removed. Runs once,
// quietly, with no undo step.
// (It edits the slides it is given in place: they are freshly loaded.)
function migrateLogoBlocks(deck: { slides: LooseSlide[] }): boolean {
  let changed = false;
  for (const s of deck.slides || []) {
    // The platform's own "gadgets" mark, which the earlier starter deck put
    // on its cover, is no longer a block type: decks drop it.
    if (Array.isArray(s?.blocks)) {
      const kept = s.blocks.filter((b) => (b as Partial<Block> | null)?.type !== "gadgetsMark");
      if (kept.length !== s.blocks.length) { s.blocks = kept; changed = true; }
    }
    for (const b of (Array.isArray(s?.blocks) ? s.blocks : []) as Array<Partial<Block> | null>) {
      if (b?.type !== "logo") continue;
      const p: BlockProps = b.props && typeof b.props === "object" ? b.props : {};
      const oldSpot = b.x === 1013 && b.y === 40 || b.x === 997 && b.y === 30;
      if (oldSpot && p.variant === "dark" && Number(p.scale) === 0.62 && p.align == null) {
        b.x = 964;
        b.y = 31;
        b.w = 200;
        b.props = { ...p, scale: 0.75, align: "right" };
        changed = true;
      }
      if (b.props?.text == null) {
        b.props = { ...b.props, text: LOGO_DEFAULT_TEXT };
        changed = true;
      }
    }
  }
  return changed;
}
// The cover slide a new deck starts with: the title layout.
function newBlankSlide(): Slide {
  const { background, blocks } = SLIDE_LAYOUTS.title();
  return { id: genId(), background, blocks: blocks.map((b) => ({ ...b, id: genId() })) };
}
// An `addSlide` input as the slide to store. A layout builds the slide from
// its template. Otherwise the slide is flat (no inset surface) unless the
// input asks for the inset, and white unless it names a colour, so a slide an
// agent assembles itself never picks up the inset surface by accident. (The
// renderer draws the inset whenever `inset` isn't false, which stored slides
// rely on, so the default is set here rather than changed there.)
function slideFromInput(input: SlideInput): LooseSlide {
  const { layout, ...rest } = input;
  const background = isPlainObject(rest.background) ? rest.background : {};
  if (layout === undefined) return { ...rest, background: { color: "#FFFFFF", ...background, inset: background.inset === true } };
  if (!isSlideLayout(layout)) throw new Error(`Unknown slide layout ${JSON.stringify(layout)}: use one of ${SLIDE_LAYOUT_IDS.join(", ")}.`);
  if (rest.blocks !== undefined) throw new Error("addSlide takes a layout or blocks, not both: build the slide from the layout, then edit or add blocks.");
  const template = SLIDE_LAYOUTS[layout]();
  return { ...rest, background: { ...template.background, ...background }, blocks: template.blocks };
}
function initialDeck(): Deck {
  return { themeVersion: THEME_VERSION, slides: [newBlankSlide()] };
}

const SLIDES_EXPORT_FORMATS = [
  { id: "pptx", label: "PowerPoint", mode: "server", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileExtension: ".pptx" },
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return SLIDES_EXPORT_FORMATS;
  }
  async export(gadget: Pick<GadgetStub, "getDeckInlined" | "getSvgRasters">, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id === "pptx") {
      const deck = await gadget.getDeckInlined();
      // PNG stand-ins for SVG artwork, keyed by the inlined source.
      const keyOf = new Map<string, string>();
      for (const slide of [...deck.slides || [], logoAsSlide(deck.logo)]) for (const v of svgSourcesOf(slide, new Set())) keyOf.set(v, await svgKey(v));
      const byKey = keyOf.size ? await gadget.getSvgRasters([...new Set(keyOf.values())]) : {};
      const svgRasters = new Map<string, string>();
      const counted = new Set<string>();
      let pixels = 0;
      for (const [v, k] of keyOf) {
        const png = byKey[k], size = png ? pngSize(png) : null;
        if (!size) continue;
        if (!counted.has(k)) {
          if (pixels + size.w * size.h > MAX_EXPORT_RASTER_PIXELS) continue;
          pixels += size.w * size.h;
          counted.add(k);
        }
        svgRasters.set(v, png);
      }
      return deckToSlidesPptx(deck, { ...await pptxAssets(deck), svgRasters });
    }
    throw new Error("Unsupported slides export format: " + id);
  }
}
