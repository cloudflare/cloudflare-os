#!/usr/bin/env node

// proof-deps: a Dependabot npm pull request that only moves existing dependencies to mature,
// advisory-free minor or patch versions.
//
// Holds when every rule below passes:
//   - Dependabot opened it from its npm branch. Whether Dependabot wrote every commit is the
//     gate's check (author, committer and signature, through the API), not this proof's.
//   - It changes only package.json files, pnpm-lock.yaml, and in pnpm-workspace.yaml the version
//     of existing catalog entries, each a minor or patch move (the gate's own rule for that file,
//     isCatalogVersionBump, read from the whole file on each side), and nothing under
//     packages/workshop-backend (the kernel).
//   - A manifest keeps its dependency names and changes only exact, caret or tilde versions, each a
//     minor or patch move (0.x moves count as breaking when the minor changes). An importer's or
//     catalog's specifier in the lockfile changes the same way or not at all.
//   - The lockfile names no package that the base did not, and touches no section beyond
//     importers, catalogs, packages and snapshots. Every package version present at both base and
//     head keeps its integrity and resolution, and every package or snapshot entry present at both
//     keeps every other line, read from the whole lockfile on each side; every version the head
//     adds resolves from the default registry by a sha512 integrity; and neither side has a line
//     the reader cannot take as pnpm writes it (readLockfile).
//   - Every version the lockfile adds was published at least `minimumReleaseAge` (read from the
//     base pnpm-workspace.yaml) before now, by the registry's `time` map.
//   - OSV lists no advisory for any version the lockfile adds or removes, or that an importer,
//     catalog or snapshot entry now depends on or stopped depending on, as its version or as a
//     peer in that version's suffix (advisoryTargets). An advisory on the old version is a
//     security fix, and those go to a person.
//
// The preview smoke is its own artifact (`preview-smoke`, from the `preview-smoke` job in
// automerge-head-proofs.yml, which builds and runs the workers locally); the gate needs both.
//
//   node scripts/automerge/proofs/deps.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, AUTOMERGE_PR_AUTHOR, AUTOMERGE_HEAD_REF

import { isDeepStrictEqual } from "node:util";

import { isCatalogVersionBump } from "../../risk-review-policy.ts";
import { fileAt, mergeBase } from "../git.ts";
import { asArray, asObject, isObject, parseJson, type Json, type JsonObject } from "../json.ts";
import { isMain } from "../main.ts";
import { DEPENDABOT_LOGIN } from "../producers.ts";
import { decide, notApplicable, runProducer, type Outcome } from "./artifact.ts";
import { pullRequestDiff, type FileDiff, type Hunk } from "./diff.ts";
import { isMinorOrPatch, parseVersion, rangeVersion } from "./semver.ts";

const NPM_BRANCH_PREFIX = "dependabot/npm_and_yarn/";
const KERNEL = "packages/workshop-backend/";
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** A `name@version` the lockfile adds or removes. */
export interface PackageVersion {
  name: string;
  version: string;
}

/** Everything the rules read. The CLI gathers it from git, the registry and OSV. */
export interface DepsInput {
  author: string;
  headRef: string;
  files: FileDiff[];
  /** Each changed package.json at the merge base and at head. */
  manifests: { path: string; base: string | undefined; head: string | undefined }[];
  /** Whether a package name appears anywhere in the base lockfile. */
  baseLockHasName: (name: string) => boolean;
  minimumReleaseAgeMinutes: number;
  /** Publish time of each added version, from the registry. Missing means unknown. */
  published: Record<string, string>;
  /** OSV advisory ids for each of advisoryTargets. Missing means not checked. */
  advisories: Record<string, string[]>;
  /** The whole pnpm-lock.yaml at the merge base and at head, read by readLockfile. */
  lockfiles: { base: LockfileView; head: LockfileView };
  /** The whole pnpm-workspace.yaml at the merge base and at head. */
  workspace: { base: string; head: string };
  now: Date;
}

const LOCK_KEY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s'(/]+)@([^(':\s]+)(?:\(.*\))?'?:(?: \{\})?$/;
const LOCK_VERSION_LINE = /^ +(?:specifier|version): \S/;
const LOCK_INTEGRITY = /^ {4}resolution: /;
const CATALOG_ENTRY = /^ {2,4}('?)([^'\s#][^':]*)\1: (\S+)$/;

/** `name@version`, the key the registry and OSV results are filed under. */
function versionKey({ name, version }: PackageVersion): string {
  return `${name}@${version}`;
}

/** The versions a lockfile diff adds and removes, and the lockfile rules it breaks. */
interface LockfileChanges {
  added: PackageVersion[];
  removed: PackageVersion[];
  reasons: string[];
}

/** Reads a lockfile diff. A version both removed and added (a moved line) counts as neither. */
function lockfileChanges(hunks: Hunk[]): LockfileChanges {
  const added = new Map<string, PackageVersion>();
  const removed = new Map<string, PackageVersion>();
  const reasons: string[] = [];
  for (const hunk of hunks) {
    const section = hunk.section.replace(/:$/, "");
    const lines = [...hunk.removed, ...hunk.added];
    // git names a hunk after the top-level key above its first line, so a key inside the hunk
    // would start a section the rules below do not take the hunk for.
    const topLevel = lines.find((line) => /^\S/.test(line));
    if (topLevel !== undefined) {
      reasons.push(`pnpm-lock.yaml: adds or removes the top-level line "${topLevel}"`);
      continue;
    }
    if (section === "importers" || section === "catalogs") {
      const other = lines.find((line) => !LOCK_VERSION_LINE.test(line));
      if (other !== undefined) reasons.push(`pnpm-lock.yaml ${section}: unexpected change "${other.trim()}"`);
      continue;
    }
    if (section !== "packages" && section !== "snapshots") {
      reasons.push(`pnpm-lock.yaml: changes the "${section || "top"}" section`);
      continue;
    }
    // Every version has one `packages:` entry; `snapshots:` only repeats it per peer set, so a
    // snapshot key that comes or goes names no version of its own.
    const collect = (source: string[], into: Map<string, PackageVersion>) => {
      for (const line of source) {
        const key = LOCK_KEY.exec(line);
        if (!key) {
          if (/^ {2}\S/.test(line)) reasons.push(`pnpm-lock.yaml: unrecognized package key "${line.trim()}"`);
        } else if (section === "packages") {
          into.set(`${key[1]}@${key[2]}`, { name: key[1], version: key[2] });
        }
      }
    };
    collect(hunk.removed, removed);
    collect(hunk.added, added);
  }
  for (const key of added.keys()) {
    if (removed.delete(key)) added.delete(key);
  }
  return { added: [...added.values()], removed: [...removed.values()], reasons };
}

/** One importer or catalog dependency: its name, specifier and locked version. */
interface Pin {
  name: string;
  specifier: string;
  version: string;
}

/** A lockfile, as far as the whole-file rules read it. */
interface LockfileView {
  /** Each `packages:` entry's resolution, keyed by `name@version`. */
  resolutions: Map<string, string>;
  /**
   * Every line of a `packages:` or `snapshots:` entry that no other rule reads, keyed by section
   * and key as written, peer suffix included. An entry both sides have must keep them.
   */
  fields: Map<string, string[]>;
  /** Each importer and catalog dependency, keyed by where it is declared. */
  pins: Map<string, Pin>;
  /**
   * Locks that can hold several versions, keyed by where they are declared. A `snapshots:` entry's
   * dependency, `snapshots/<name@version>/<group>/<dependency>`: one package version can have
   * several snapshots, one per peer set, and each adds its version, so a version two peer sets
   * lock is listed twice. And the peers in a version string's suffix, `<where> peer <name>`, for
   * an importer's version and for a snapshot's dependency.
   */
  edges: Map<string, string[]>;
  /** Lines the rules cannot read as pnpm writes them: comments, odd keys, duplicates. */
  problems: string[];
}

const NESTED_KEY = /^( *)('?)([^']+?)\2:(?: (.*))?$/;
const LIST_ITEM = /^ +- \S/;
const SECTION = /^[A-Za-z][\w-]*:/;
const READ_SECTIONS = ["importers", "catalogs", "packages", "snapshots"];
const SNAPSHOT_DEPENDENCIES = ["dependencies", "optionalDependencies"];
const FLOW_RESOLUTION = /^ {4}resolution: \{.*\}$/;

function unquote(value: string): string {
  return /^'.*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : value;
}

/**
 * Reads the importers, catalogs, packages and snapshots sections of a whole pnpm-lock.yaml. pnpm
 * writes no comments, indents by two spaces, quotes keys with single quotes and writes every
 * mapping but a resolution as a block. So a comment, an odd or skipped indent, a column-0 line that
 * is not a section key, a line that is neither a key nor a list item, a key in double quotes, an
 * unreadable package key, and a resolution, dependency group, importer or catalog written any other
 * way is a problem: each could hide an entry from the reading below while YAML still parses it.
 * Below a package's own fields no rule reads, and a field such as `deprecated` can hold text on
 * several lines, so those lines are kept as written.
 */
export function readLockfile(text: string): LockfileView {
  const view: LockfileView = { resolutions: new Map(), fields: new Map(), pins: new Map(), edges: new Map(), problems: [] };
  const lock = (where: string, pin: Pin) => {
    view.edges.set(where, [...view.edges.get(where) ?? [], lockedVersion(pin)]);
  };
  const lockPeers = (where: string, version: string) => {
    for (const peer of peerPins(version)) lock(`${where} peer ${peer.name}`, peer);
  };
  let section = "";
  const path: string[] = [];
  let entry = "";
  let fields: string[] = [];
  let group = "";
  let above = 0;
  text.split("\n").forEach((line, index) => {
    const problem = (what: string) => view.problems.push(`pnpm-lock.yaml line ${index + 1}: ${what}`);
    if (line.trim() === "") return;
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const skipped = indent > above + 2;
    above = indent;
    if (section === "packages" && indent > 4) {
      fields.push(line);
      return;
    }
    if (line.trimStart().startsWith("#")) return problem("a comment");
    if (indent % 2 !== 0 || line[indent] === "\t" || skipped) return problem("indentation pnpm does not write");
    if (indent === 0) {
      if (!SECTION.test(line)) return problem(`not a section key: ${line}`);
      section = line.replace(/:.*$/, "");
      entry = "";
      return;
    }
    if (!READ_SECTIONS.includes(section)) return;
    const match = NESTED_KEY.exec(line);
    if (match ? match[3].includes('"') : !LIST_ITEM.test(line)) {
      return problem(`not a key or a list item as pnpm writes one: ${line.trim()}`);
    }
    if (section === "packages" || section === "snapshots") {
      if (indent === 2) {
        const key = LOCK_KEY.exec(line);
        entry = key ? `${key[1]}@${key[2]}` : "";
        fields = [];
        group = "";
        if (!key) return problem(`not a package key: ${line.trim()}`);
        const written = `${section}/${unquote(line.trim().replace(/:(?: \{\})?$/, ""))}`;
        if (section === "packages" ? view.resolutions.has(entry) : view.fields.has(written)) problem(`${written} is listed twice`);
        view.fields.set(written, fields);
        if (section === "packages") view.resolutions.set(entry, "");
        return;
      }
      if (section === "packages" && /^ {4}resolution:/.test(line)) {
        if (!FLOW_RESOLUTION.test(line)) return problem(`${entry}: a resolution not written on one line`);
        view.resolutions.set(entry, line.replace(LOCK_INTEGRITY, "").trim());
        return;
      }
      if (indent === 4) group = section === "snapshots" && match && SNAPSHOT_DEPENDENCIES.includes(match[3]) ? match[3] : "";
      if (group === "") {
        fields.push(line);
      } else if (indent === 6 && match) {
        const where = `snapshots/${entry}/${group}/${match[3]}`;
        const version = unquote(match[4] ?? "");
        lock(where, { name: match[3], specifier: "", version });
        lockPeers(where, version);
      } else if (indent !== 4 || match?.[4] !== undefined) {
        problem(`${entry}: ${group} not written as a block of versions`);
      }
      return;
    }
    if (!match) return;
    // importers: <importer>/<group>/<name> at indents 2, 4, 6; catalogs: <catalog>/<name> at 2, 4.
    const depth = indent / 2 - 1;
    const fieldDepth = section === "importers" ? 3 : 2;
    if (depth < fieldDepth) {
      if (match[4] !== undefined && match[4] !== "{}") return problem(`${match[3]} not written as a block`);
      path.length = depth;
      path[depth] = match[3];
      return;
    }
    if (depth !== fieldDepth || path.length !== fieldDepth) return;
    const where = `${section}/${path.join("/")}`;
    const pin = view.pins.get(where) ?? { name: path[fieldDepth - 1], specifier: "", version: "" };
    if (match[3] === "specifier") pin.specifier = unquote(match[4] ?? "");
    if (match[3] === "version") {
      pin.version = unquote(match[4] ?? "");
      lockPeers(where, pin.version);
    }
    view.pins.set(where, pin);
  });
  return view;
}

/**
 * The registry version a pin locks, or undefined for anything else: a workspace link, a local
 * file, a URL or a git dependency, none of which OSV can be asked about.
 */
function pinnedVersion(pin: Pin): PackageVersion | undefined {
  const version = pin.version.replace(/\(.*$/, "");
  const alias = /^((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(version);
  const npm = /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(pin.specifier);
  const found = alias ? { name: alias[1], version: alias[2] } : { name: npm ? npm[1] : pin.name, version };
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(found.version) ? found : undefined;
}

/**
 * A resolution with pnpm's default-registry `tarball:` field dropped, which pnpm writes or leaves
 * out without the package changing (#216).
 */
function normalResolution(key: string, resolution: string): string {
  const at = key.lastIndexOf("@");
  const name = key.slice(0, at);
  const tarball = `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, "")}-${key.slice(at + 1)}.tgz`;
  return resolution.replace(`, tarball: ${tarball}}`, "}");
}

/** A resolution that names nothing but a sha512 hash, which pnpm fetches from the default registry. */
const REGISTRY_RESOLUTION = /^\{integrity: sha512-[A-Za-z0-9+/]+=*\}$/;

/**
 * Every package version at both base and head whose resolution or integrity is not the same, every
 * package or snapshot entry at both whose other lines are not, every version new at head that does
 * not resolve from the default registry by its hash, and every line of either lockfile the reading
 * could not take as pnpm writes it.
 */
function entryReasons(base: LockfileView, head: LockfileView): string[] {
  const reasons = [...base.problems.map((problem) => `base ${problem}`), ...head.problems.map((problem) => `head ${problem}`)];
  for (const [key, after] of head.resolutions) {
    const before = base.resolutions.get(key);
    if (before === undefined) {
      if (!REGISTRY_RESOLUTION.test(normalResolution(key, after))) {
        reasons.push(`pnpm-lock.yaml: ${key} does not resolve from the default registry by a sha512 integrity`);
      }
    } else if (normalResolution(key, before) !== normalResolution(key, after)) {
      reasons.push(`pnpm-lock.yaml: ${key} keeps its version but its resolution changed`);
    }
  }
  for (const [key, after] of head.fields) {
    const before = base.fields.get(key);
    if (before !== undefined && before.join("\n") !== after.join("\n")) {
      reasons.push(`pnpm-lock.yaml ${key} keeps its version but its entry changed`);
    }
  }
  return reasons;
}

/** Each distinct value of `values` that `others` does not match one for one. */
function unmatched(values: string[], others: string[]): string[] {
  const left = [...others];
  return [...new Set(values.filter((value) => {
    const at = left.indexOf(value);
    if (at !== -1) left.splice(at, 1);
    return at === -1;
  }))];
}

/** The registry versions importer, catalog and snapshot entries stopped and started resolving to. */
interface PinMoves {
  from: PackageVersion[];
  to: PackageVersion[];
  reasons: string[];
}

const NOT_REGISTRY = "not a registry version: ";

/**
 * What a pin locks, compared by `name@version`: the peer suffix of its version string is read
 * apart (peerPins). A non-registry version compares as written.
 */
function lockedVersion(pin: Pin): string {
  const version = pinnedVersion(pin);
  return version === undefined ? `${NOT_REGISTRY}${pin.version}` : versionKey(version);
}

const PEER = /\(((?:@[^/@()]+\/)?[^@()]+)@([^()]+)/g;

/**
 * The peers in a version string's suffix: pnpm appends `(name@version)` for each peer a package
 * was installed with, and a peer's own peers nest inside its group. A suffix that holds anything
 * else is one more pin, under no name and locked to the suffix as written, so that a change to it
 * fails as a non-registry version.
 */
function peerPins(version: string): Pin[] {
  const at = version.indexOf("(");
  if (at === -1) return [];
  const suffix = version.slice(at);
  const peers = [...suffix.matchAll(PEER)].map((match) => ({ name: match[1], specifier: "", version: match[2] }));
  const closed = suffix.split("(").length === suffix.split(")").length;
  const readable = closed && suffix.replaceAll(PEER, "").replaceAll(")", "") === "";
  return readable ? peers : [...peers, { name: "", specifier: "", version: suffix }];
}

/** Whether two versions are on one release line: the same major, and for 0.x the same minor. */
function sameLine(a: string, b: string): boolean {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (x === undefined || y === undefined) return false;
  return a === b || isMinorOrPatch(x, y) || isMinorOrPatch(y, x);
}

function splitKey(key: string): PackageVersion {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * Where an importer, catalog or snapshot entry locks a different version at head, the version each
 * side locks. A snapshot's dependencies count too: a bump can move a transitive dependency to a
 * version the lockfile already had, which then adds no package entry. Where one package version
 * has several peer sets, a version locked less often and another locked more often is one peer
 * set moving between them, though both sides still lock both. Locked more often or less often
 * alone is a peer set that came or went, which moves nothing.
 *
 * Every move must stay on a release line (sameLine), as the manifest rule requires of direct
 * dependencies: a version an entry moves to must share a line with a version that entry moved
 * from, or, for an entry new at head, with a version of the same package at base. So must every
 * package version the lockfile adds. A package the base does not have at all is left to the rule
 * on new package names.
 */
function pinMoves(base: LockfileView, head: LockfileView): PinMoves {
  const from = new Map<string, PackageVersion>();
  const to = new Map<string, PackageVersion>();
  const reasons: string[] = [];
  const baseVersions = new Map<string, string[]>();
  for (const key of base.resolutions.keys()) {
    const { name, version } = splitKey(key);
    baseVersions.set(name, [...baseVersions.get(name) ?? [], version]);
  }
  const registry = (where: string, values: string[]) => values.flatMap((value) => {
    if (!value.startsWith(NOT_REGISTRY)) return [splitKey(value)];
    reasons.push(`pnpm-lock.yaml ${where}: moves to or from ${value.slice(NOT_REGISTRY.length)}, not a registry version`);
    return [];
  });
  const move = (where: string, removed: string[], added: string[]) => {
    const before = registry(where, removed);
    const after = registry(where, added);
    for (const entry of before) from.set(versionKey(entry), entry);
    for (const entry of after) {
      to.set(versionKey(entry), entry);
      const lines = before.length > 0
        ? before.filter((old) => old.name === entry.name).map((old) => old.version)
        : baseVersions.get(entry.name) ?? [entry.version];
      if (!lines.some((version) => sameLine(version, entry.version))) {
        reasons.push(`pnpm-lock.yaml ${where}: ${versionKey(entry)} leaves the release line of ${lines.join(", ") || "nothing it moved from"}`);
      }
    }
  };
  for (const where of new Set([...base.pins.keys(), ...head.pins.keys()])) {
    const beforePin = base.pins.get(where);
    const afterPin = head.pins.get(where);
    const before = beforePin === undefined ? [] : [lockedVersion(beforePin)];
    const after = afterPin === undefined ? [] : [lockedVersion(afterPin)];
    if (before[0] !== after[0]) move(where, before, after);
    if (beforePin !== undefined && afterPin !== undefined && beforePin.specifier !== afterPin.specifier) {
      reasons.push(...versionMoveReasons(`pnpm-lock.yaml ${where} specifier`, beforePin.specifier, afterPin.specifier));
    }
  }
  for (const where of new Set([...base.edges.keys(), ...head.edges.keys()])) {
    const before = base.edges.get(where) ?? [];
    const after = head.edges.get(where) ?? [];
    const fewer = unmatched(before, after);
    const more = unmatched(after, before);
    const moved = fewer.length > 0 && more.length > 0;
    const removed = moved ? fewer : fewer.filter((value) => !after.includes(value));
    const added = moved ? more : more.filter((value) => !before.includes(value));
    if (removed.length > 0 || added.length > 0) move(where, removed, added);
  }
  for (const key of head.resolutions.keys()) {
    if (base.resolutions.has(key)) continue;
    const { name, version } = splitKey(key);
    const lines = baseVersions.get(name);
    if (lines !== undefined && !lines.some((old) => sameLine(old, version))) {
      reasons.push(`pnpm-lock.yaml packages: ${key} leaves the release line of ${lines.join(", ")}`);
    }
  }
  return { from: [...from.values()], to: [...to.values()], reasons };
}

/** The versions OSV must be asked about: every version added, removed, or moved to or from. */
function advisoryTargets(lock: LockfileChanges, moves: PinMoves): PackageVersion[] {
  const targets = new Map<string, PackageVersion>();
  for (const entry of [...lock.added, ...lock.removed, ...moves.from, ...moves.to]) targets.set(versionKey(entry), entry);
  return [...targets.values()];
}

/**
 * Every rule a pnpm-workspace.yaml change breaks: anything but a minor or patch move of an
 * existing catalog entry's version.
 */
function workspaceReasons(base: string, head: string): string[] {
  if (!isCatalogVersionBump(base, head)) return ["pnpm-workspace.yaml: changes more than the versions of catalog entries"];
  const after = head.split("\n");
  return base.split("\n").flatMap((line, i) => {
    if (line === after[i]) return [];
    const from = CATALOG_ENTRY.exec(line);
    const to = CATALOG_ENTRY.exec(after[i]);
    if (!from || !to) return [`pnpm-workspace.yaml: "${after[i].trim()}" is not a version change of "${line.trim()}"`];
    return versionMoveReasons(`catalog ${to[2]}`, from[3], to[3]);
  });
}

function versionMoveReasons(what: string, from: string, to: string): string[] {
  const a = rangeVersion(from);
  const b = rangeVersion(to);
  if (!a || !b) return [`${what}: ${from} -> ${to} is not an exact, caret or tilde version`];
  if (from.replace(/[\d.]+.*$/, "") !== to.replace(/[\d.]+.*$/, "")) {
    return [`${what}: ${from} -> ${to} changes the range operator`];
  }
  return isMinorOrPatch(a, b) ? [] : [`${what}: ${from} -> ${to} is not a minor or patch update`];
}

/** Every rule a package.json change breaks. */
function manifestReasons(path: string, base: string | undefined, head: string | undefined): string[] {
  if (base === undefined || head === undefined) return [`${path}: added or deleted`];
  const before = asObject(parseJson(base), `${path} at base`);
  const after = asObject(parseJson(head), `${path} at head`);
  const reasons: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!DEPENDENCY_MAPS.includes(key)) {
      if (!isDeepStrictEqual(before[key], after[key])) reasons.push(`${path}: changes "${key}"`);
      continue;
    }
    const from = before[key] ?? {};
    const to = after[key] ?? {};
    if (!isObject(from) || !isObject(to)) {
      reasons.push(`${path}: "${key}" is not an object`);
      continue;
    }
    const names = new Set([...Object.keys(from), ...Object.keys(to)]);
    for (const name of names) {
      const a: Json | undefined = from[name];
      const b: Json | undefined = to[name];
      if (a === b) continue;
      if (typeof a !== "string" || typeof b !== "string") {
        reasons.push(`${path}: ${key} adds or removes ${name}`);
        continue;
      }
      reasons.push(...versionMoveReasons(`${path} ${name}`, a, b));
    }
  }
  return reasons;
}

/** A time as the registry's `time` map writes it: a date and time in UTC. */
const PUBLISH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The base workspace's `minimumReleaseAge`, in minutes. */
function minimumReleaseAge(workspaceYaml: string): number {
  const match = /^minimumReleaseAge: (\d+)\s*$/m.exec(workspaceYaml);
  if (!match) throw new Error("pnpm-workspace.yaml at base sets no minimumReleaseAge");
  return Number(match[1]);
}

/** Applies every rule. */
export function evaluateDeps(input: DepsInput): Outcome {
  if (input.author !== DEPENDABOT_LOGIN || !input.headRef.startsWith(NPM_BRANCH_PREFIX)) {
    return notApplicable("not a Dependabot npm pull request", { author: input.author, head_ref: input.headRef });
  }
  const reasons: string[] = [];

  let lock: LockfileChanges = { added: [], removed: [], reasons: [] };
  for (const file of input.files) {
    if (file.path.startsWith(KERNEL)) reasons.push(`${file.path}: under the kernel`);
    if (file.binary || file.modeChanged) reasons.push(`${file.path}: binary or mode change`);
    if (file.path === "pnpm-lock.yaml") {
      lock = lockfileChanges(file.hunks);
      reasons.push(...lock.reasons);
    } else if (file.path === "pnpm-workspace.yaml") {
      reasons.push(...workspaceReasons(input.workspace.base, input.workspace.head));
    } else if (file.path !== "package.json" && !file.path.endsWith("/package.json")) {
      reasons.push(`${file.path}: not a manifest or the lockfile`);
    }
  }
  for (const { path, base, head } of input.manifests) reasons.push(...manifestReasons(path, base, head));
  const baseLock = input.lockfiles.base;
  const headLock = input.lockfiles.head;
  reasons.push(...entryReasons(baseLock, headLock));
  const moves = pinMoves(baseLock, headLock);
  reasons.push(...moves.reasons);

  const removedNames = new Set(lock.removed.map((entry) => entry.name));
  const ageMs = input.minimumReleaseAgeMinutes * 60_000;
  const ages: JsonObject = {};
  for (const entry of lock.added) {
    const key = versionKey(entry);
    if (!removedNames.has(entry.name) && !input.baseLockHasName(entry.name)) {
      reasons.push(`${key}: a package the base lockfile does not name`);
    }
    const published = input.published[key];
    const at = published !== undefined && PUBLISH_TIME.test(published) ? Date.parse(published) : Number.NaN;
    if (Number.isNaN(at)) {
      reasons.push(`${key}: publish time unknown`);
      continue;
    }
    const hours = Math.floor((input.now.getTime() - at) / 3_600_000);
    ages[key] = hours;
    if (input.now.getTime() - at < ageMs) {
      reasons.push(`${key}: published ${hours}h ago, under minimumReleaseAge (${input.minimumReleaseAgeMinutes} minutes)`);
    }
  }
  const osv: JsonObject = {};
  for (const entry of advisoryTargets(lock, moves)) {
    const key = versionKey(entry);
    const ids = input.advisories[key];
    if (ids === undefined) {
      reasons.push(`${key}: not checked against OSV`);
    } else if (ids.length > 0) {
      osv[key] = ids;
      reasons.push(`${key}: OSV lists ${ids.join(", ")}`);
    }
  }
  return decide(reasons, {
    added: lock.added.map(versionKey),
    removed: lock.removed.map(versionKey),
    moved_from: moves.from.map(versionKey),
    moved_to: moves.to.map(versionKey),
    age_hours: ages,
    advisories: osv,
    minimum_release_age_minutes: input.minimumReleaseAgeMinutes,
    smoke: "separate artifact: preview-smoke",
  });
}

/** The package names a lockfile's `packages:` section lists. */
export function lockfileNames(lockfile: LockfileView): Set<string> {
  return new Set([...lockfile.resolutions.keys()].map((key) => key.slice(0, key.lastIndexOf("@"))));
}

/** Publish times for `entries`, from each package's full registry document. */
async function fetchPublishTimes(entries: PackageVersion[]): Promise<Record<string, string>> {
  const times: Record<string, string> = {};
  for (const name of new Set(entries.map((entry) => entry.name))) {
    const response = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2f")}`);
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
    const time = asObject(asObject(parseJson(await response.text()), name).time, `${name} time`);
    for (const entry of entries) {
      const at = entry.name === name ? time[entry.version] : undefined;
      if (typeof at === "string") times[versionKey(entry)] = at;
    }
  }
  return times;
}

/** OSV advisory ids for `entries`, from one `querybatch` call. */
async function fetchAdvisories(entries: PackageVersion[]): Promise<Record<string, string[]>> {
  if (entries.length === 0) return {};
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: entries.map(({ name, version }) => ({ package: { ecosystem: "npm", name }, version })),
    }),
  });
  if (!response.ok) throw new Error(`api.osv.dev answered ${response.status}`);
  return advisoriesFromOsv(entries, parseJson(await response.text()));
}

/** Maps an OSV `querybatch` response back onto the entries it was asked about, in order. */
export function advisoriesFromOsv(entries: PackageVersion[], body: Json): Record<string, string[]> {
  const results = asArray(asObject(body, "OSV response").results, "OSV results");
  if (results.length !== entries.length) throw new Error("OSV returned a different number of results");
  const advisories: Record<string, string[]> = {};
  entries.forEach((entry, i) => {
    const result = asObject(results[i], "OSV result");
    // A result holds `vulns` or nothing. Anything else, `next_page_token` for a list cut short
    // included, is not the whole list of advisories.
    const unread = Object.keys(result).filter((key) => key !== "vulns");
    if (unread.length > 0) throw new Error(`OSV answered ${versionKey(entry)} with ${unread.join(", ")}`);
    const vulns = result.vulns === undefined ? [] : asArray(result.vulns, "OSV vulns");
    advisories[versionKey(entry)] = vulns.map((vuln) => {
      const id = asObject(vuln, "OSV vuln").id;
      if (typeof id !== "string") throw new Error("OSV vuln without an id");
      return id;
    });
  });
  return advisories;
}

async function main(): Promise<void> {
  await runProducer("proof-deps", async ({ head, base }) => {
    const from = mergeBase(base, head);
    const files = pullRequestDiff(base, head);
    const lockFile = files.find((file) => file.path === "pnpm-lock.yaml");
    const lock = lockfileChanges(lockFile?.hunks ?? []);
    const baseWorkspace = fileAt(from, "pnpm-workspace.yaml");
    const headWorkspace = fileAt(head, "pnpm-workspace.yaml");
    const baseLock = fileAt(from, "pnpm-lock.yaml");
    const headLock = fileAt(head, "pnpm-lock.yaml");
    if (baseWorkspace === undefined || baseLock === undefined) throw new Error("base has no pnpm workspace");
    if (headWorkspace === undefined || headLock === undefined) throw new Error("head has no pnpm workspace");
    const lockfiles = { base: readLockfile(baseLock), head: readLockfile(headLock) };
    const baseNames = lockfileNames(lockfiles.base);
    return evaluateDeps({
      author: process.env.AUTOMERGE_PR_AUTHOR ?? "",
      headRef: process.env.AUTOMERGE_HEAD_REF ?? "",
      files,
      manifests: files
        .filter((file) => file.path === "package.json" || file.path.endsWith("/package.json"))
        .map(({ path }) => ({ path, base: fileAt(from, path), head: fileAt(head, path) })),
      baseLockHasName: (name) => baseNames.has(name),
      minimumReleaseAgeMinutes: minimumReleaseAge(baseWorkspace),
      published: await fetchPublishTimes(lock.added),
      advisories: await fetchAdvisories(advisoryTargets(lock, pinMoves(lockfiles.base, lockfiles.head))),
      lockfiles,
      workspace: { base: baseWorkspace, head: headWorkspace },
      now: new Date(),
    });
  });
}

if (isMain(import.meta.url)) await main();
