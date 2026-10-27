import {
  Button, Field, Fragment, h, Notice, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  SharePointBrowserCrumb as Crumb,
  SharePointBrowserIcon as Icon,
  SharePointBrowserItem as Item,
  SharePointBrowserPage as Page,
  SharePointBrowserRequest as Request,
  SharePointConfiguratorRpc as Rpc,
  SharePointConfiguratorStatus as Status,
  SharePointConfiguratorValues as Values,
} from "./sharepoint-configurator-types";

/** Must equal `SHAREPOINT_RESOURCE.urlPattern` in microsoft-env.ts. */
const SHAREPOINT_GRANT = "https://*.sharepoint.com/*";
/** Must equal `ALL_TITLE` in sharepoint-configurator.ts. */
const ALL_TITLE = "All of SharePoint & OneDrive";
/** Must name the tabs `SharePointConfiguratorUI.loadItems` knows. */
const TABS = [{ value: "sites", title: "Sites" }, { value: "onedrive", title: "OneDrive" }];
const FIELD_LABEL = "What to connect";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
const SEARCH_DELAY_MS = 300;
const TYPEAHEAD_MS = 700;
/** A place stops offering more once it holds this many rows. */
const MAX_ROWS = 1000;
// Enough to fill the listing's maximum height, so a long place replaces them without a jump.
const SKELETON_ROWS = 7;
const PATH_SEPARATOR = " › ";

type Context = ConfiguratorUIRenderContext<Rpc, Values>;

type Connection =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "waiting" }
  | Status;

/**
 * The little of the frame's DOM this module touches: the nodes refs and events hand it. `h` builds
 * virtual nodes, which never are DOM nodes; the package's types have no DOM.
 */
type FrameNode = {
  isConnected: boolean; value: string; tabIndex: number;
  scrollTop: number; clientHeight: number; scrollHeight: number; offsetLeft: number;
  style: { minHeight: string; left: string };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  focus(options?: { preventScroll: boolean }): void;
  select(): void;
  contains(node: FrameNode | null): boolean;
  closest(selector: string): FrameNode | null;
};
type FrameEvent = {
  currentTarget: FrameNode; target: FrameNode; relatedTarget: FrameNode | null; detail: number;
  key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean;
  preventDefault(): void; stopPropagation(): void;
};
const frameDocument = (globalThis as unknown as { document?: { activeElement: FrameNode | null } }).document;

let connection: Connection = { state: "loading" };
let asked = false;
// Bumped by every status request, so a reply that a newer one overtook is dropped.
let generation = 0;
/** The resource URL the frame opened with, when SharePoint couldn't find it: the user chooses instead. */
let missing: string | null = null;
// Re-renders with what has loaded. Every render installs its own, so a late reply reaches the
// current tree. It changes no values, so it never invalidates a resource URL being collected.
let rerender: () => void = () => {};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** Reads what the connection allows, once, then re-renders with it. */
function loadStatus({ ui }: Context): void {
  if (asked) return;
  asked = true;
  const run = ++generation;
  ui.getStatus().then(status => {
    if (run !== generation) return;
    connection = status;
    rerender();
  }, error => {
    if (run !== generation) return;
    connection = { state: "failed", message: errorMessage(error, "Couldn't reach SharePoint.") };
    rerender();
  });
}

/**
 * Asks for SharePoint access from the click, so the browser lets Workshop open the consent pop-up,
 * then waits for the grant to land.
 */
async function allowAccess({ ensureResources, ui }: Context): Promise<void> {
  const run = ++generation;
  const access = ensureResources([SHAREPOINT_GRANT]);
  connection = { state: "waiting" };
  rerender();
  try {
    const held = await access;
    const deadline = Date.now() + ACCESS_WAIT_MS;
    for (;;) {
      if (!held) await sleep(ACCESS_POLL_MS);
      if (run !== generation) return;
      const status = await ui.getStatus();
      if (run !== generation) return;
      if (status.state !== "needsAccess" || held) {
        connection = status;
        rerender();
        return;
      }
      if (Date.now() > deadline) throw new Error("Access wasn't granted within 3 minutes. Select Allow access to try again.");
    }
  } catch (error) {
    if (run !== generation) return;
    connection = { state: "failed", message: errorMessage(error, "Access wasn't granted.") };
    rerender();
  }
}

/** The kind of a ref: the part before its colon. */
function kindOf(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref === "all" ? "all" : ref.slice(0, ref.indexOf(":"));
}

/** What a choice covers, in a sentence the summary finishes. */
const COVERS: Record<string, string> = {
  all: ": every site, library, list and file you can open, including ones you get access to later.",
  site: ": the site’s libraries, lists and pages, including anything added later. Not its subsites.",
  drive: ": every folder and file in it, including anything added later.",
  folder: ": every folder and file inside it, including anything added later.",
  file: ": just this file.",
  list: ": the list’s items and columns.",
  page: ": just this page.",
};

function summary(values: Values): { name: string; text: string } | undefined {
  const kind = kindOf(values.ref);
  const covers = COVERS[kind];
  if (covers === undefined) return undefined;
  const name = kind === "all" ? ALL_TITLE : values.title ?? "This choice";
  const access = connection.state === "ready"
    ? connection.access === "write"
      ? " Changes wait for your approval."
      : " Read only."
    : "";
  return { name, text: covers + access };
}

/** The picker's starting place, for a choice that came with the frame. */
function initialLocation(values: Values): { tab: string; path: Crumb[] } | undefined {
  if (!values.location) return undefined;
  try {
    const parsed = JSON.parse(values.location) as { tab?: unknown; path?: unknown };
    return typeof parsed.tab === "string" && Array.isArray(parsed.path) ? { tab: parsed.tab, path: parsed.path as Crumb[] } : undefined;
  } catch {
    return undefined;
  }
}

// -- the picker's state -------------------------------------------------------------------------

/** One place, or one search of it, as loaded. */
type Listing =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; page: Page; more?: "loading" | "failed" };
/** A listing, and the row last focused in it, which is where the listing's tab stop returns to. */
type Entry = { listing: Listing; focusId?: string };

/** What the picker keeps across renders, since every render rebuilds its tree. */
const picker = {
  tab: TABS[0]!.value,
  /** Each tab's open places, outermost first. */
  paths: {} as Record<string, Item[]>,
  /** What is typed in the search box, and the search it has become once the typing paused. */
  input: "",
  query: "",
  debounce: undefined as ReturnType<typeof setTimeout> | undefined,
  /**
   * Listings by {@link listingKey}. Only each tab's open places and the current search are kept, so
   * going back up is instant but a long session doesn't hold every place it ever opened.
   */
  entries: new Map<string, Entry>(),
  /**
   * Where focus goes once it exists, by `data-sp-focus` id, or `first` (a place's first row) or
   * `after:<value>` (the row after one). It stands only while focus stays in the picker.
   */
  pending: null as string | null,
  /** Said once the place a navigation or search asked for has loaded. */
  announcement: null as { kind: "search" } | { kind: "open"; title: string } | null,
  /** Where the chosen row is, so "Show" can go back to it. */
  chosenAt: null as { tab: string; path: Item[] } | null,
  /** Scrolls the chosen row into view once its place has loaded. */
  revealChosen: false,
  initialApplied: false,
  interacted: false,
  crumbMenuOpen: false,
  /** The tallest the listing has been: it never shrinks back, so the frame's height stays put. */
  minListHeight: 0,
  typeahead: { text: "", at: 0 },
  renders: 0,
};

function listingKey(tab: string, place: Item | undefined, query: string): string {
  return JSON.stringify([tab, place?.value ?? null, query]);
}

function prune(current: string): void {
  const kept = new Set([current]);
  for (const { value: tab } of TABS) {
    const path = picker.paths[tab] ?? [];
    for (let depth = 0; depth <= path.length; depth++) kept.add(listingKey(tab, path[depth - 1], ""));
  }
  for (const key of picker.entries.keys()) if (!kept.has(key)) picker.entries.delete(key);
}

/** Loads a listing's first page, or its next one when it has loaded. A reply a retry or a newer page overtook is dropped. */
function fetchPage(ui: Rpc, entry: Entry, request: Request): void {
  const previous = entry.listing.state === "ready" ? entry.listing : undefined;
  const listing: Listing = previous ? { ...previous, more: "loading" } : { state: "loading" };
  entry.listing = listing;
  ui.loadItems(previous ? { ...request, pageToken: previous.page.nextPageToken } : request).then(page => {
    if (entry.listing !== listing) return;
    if (previous) {
      const known = new Set(previous.page.items.map(item => item.value));
      const added = page.items.filter(item => !known.has(item.value));
      const items = [...previous.page.items, ...added].slice(0, MAX_ROWS);
      entry.listing = {
        state: "ready",
        page: { items, nextPageToken: items.length < MAX_ROWS ? page.nextPageToken : undefined, notice: page.notice ?? previous.page.notice },
      };
      announce(`Showing ${added.length} more`);
    } else {
      entry.listing = { state: "ready", page };
    }
    rerender();
  }, error => {
    if (entry.listing !== listing) return;
    if (previous) {
      entry.listing = { ...previous, more: "failed" };
      announce("Couldn't load more");
    } else {
      entry.listing = { state: "failed", message: errorMessage(error, "Something went wrong.") };
    }
    rerender();
  });
}

/** Opens the picker where a choice made before it was shown lives, once, and only until the user has moved. */
function applyInitialLocation(values: Values): void {
  const location = initialLocation(values);
  if (picker.initialApplied || picker.interacted || !location || !TABS.some(tab => tab.value === location.tab)) return;
  picker.initialApplied = true;
  picker.tab = location.tab;
  picker.paths[location.tab] = placesOf(location.path);
  if (values.ref && values.ref !== "all") {
    picker.chosenAt = { tab: location.tab, path: picker.paths[location.tab]! };
    picker.revealChosen = true;
  }
}

/** The places a breadcrumb names, kept as rows, so choosing one from its "All of" row reports what its row said. */
function placesOf(crumbs: Crumb[]): Item[] {
  return crumbs.map(crumb => ({ ...crumb, navigable: true }));
}

// -- pieces -------------------------------------------------------------------------------------

/** What the picker last did, read out by the live region `render` keeps outside the picker. */
let announced = "";
// Repeating a message must still change the region, or it is not read out again. The caller
// re-renders, as every announcement comes with a change to show.
function announce(message: string): void {
  announced = announced === message ? `${message}\u00a0` : message;
}

const FILE_SHAPE = "M4 1.75h5.25L12.75 5.25v8.25a.75.75 0 0 1-.75.75H4a.75.75 0 0 1-.75-.75v-11A.75.75 0 0 1 4 1.75Z";
const FILE_FOLD = "M9.25 1.75v3.5h3.5";
const FOLDER_SHAPE = "M1.75 4a.75.75 0 0 1 .75-.75h3.4l1.5 1.5h6.1a.75.75 0 0 1 .75.75v6.75a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75Z";
const FRAME_SHAPE = "M2.75 3.25h10.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-.5.5H2.75a.5.5 0 0 1-.5-.5v-8.5a.5.5 0 0 1 .5-.5Z";

// Each icon's tint and its 16px paths. A path is stroked; "soft:" also fills it faintly, and
// "solid:" fills it without a stroke. Tints are CSS variables with dark-mode values (see STYLE);
// "neutral" takes the surrounding ink.
const ICONS: Record<Icon, { tint: string; paths: string[] }> = {
  file: { tint: "neutral", paths: ["soft:" + FILE_SHAPE, FILE_FOLD] },
  text: { tint: "neutral", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M5.75 8.25h3M5.75 10.25h4.5M5.75 12.25h3.5"] },
  document: { tint: "blue", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M5.75 8.25h4.5M5.75 10.25h4.5M5.75 12.25h2.75"] },
  spreadsheet: { tint: "green", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M5.5 7.75h5v4.5h-5ZM5.5 10h5M8 7.75v4.5"] },
  presentation: { tint: "orange", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M5.5 8h5v3.25h-5ZM7 12.75h2"] },
  pdf: { tint: "red", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "solid:M2 8.25h7.5a.5.5 0 0 1 .5.5v2.5a.5.5 0 0 1-.5.5H2Z"] },
  image: { tint: "purple", paths: ["soft:" + FRAME_SHAPE, "M2.5 11l3-3 2.75 2.75 1.75-1.75 3.5 3.5", "M10.5 6.25h.01"] },
  video: { tint: "pink", paths: ["soft:" + FRAME_SHAPE, "soft:M6.75 6.1v3.8a.3.3 0 0 0 .45.26l3.1-1.9a.3.3 0 0 0 0-.52L7.2 5.84a.3.3 0 0 0-.45.26Z"] },
  audio: { tint: "purple", paths: ["M6.25 11.75V3.9l6-1.4v7.75", "soft:M6.25 11.75a1.75 1.5 0 1 1-3.5 0 1.75 1.5 0 0 1 3.5 0Z", "soft:M12.25 10.25a1.75 1.5 0 1 1-3.5 0 1.75 1.5 0 0 1 3.5 0Z"] },
  archive: { tint: "amber", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M6.5 2.5h1M7.5 4h1M6.5 5.5h1M7.5 7h1", "M6.75 8.75h2v2.5h-2Z"] },
  code: { tint: "indigo", paths: ["soft:" + FILE_SHAPE, FILE_FOLD, "M7 8.25 5.5 9.75 7 11.25M9 8.25l1.5 1.5L9 11.25"] },
  folder: { tint: "neutral", paths: ["soft:" + FOLDER_SHAPE] },
  "shared-folder": { tint: "neutral", paths: ["soft:" + FOLDER_SHAPE, "M8 9.4a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3ZM5.9 12.25c.3-.95 1.1-1.55 2.1-1.55s1.8.6 2.1 1.55"] },
  drive: { tint: "neutral", paths: ["soft:M1.75 9.25 3.5 3.75a.75.75 0 0 1 .7-.5h7.6a.75.75 0 0 1 .7.5l1.75 5.5v3a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75Z", "M1.75 9.25h12.5M11 11h.5"] },
  onedrive: { tint: "blue", paths: ["soft:M4.4 12.75h7.35a2.75 2.75 0 0 0 .4-5.47 4 4 0 0 0-7.6-.86A3.2 3.2 0 0 0 4.4 12.75Z"] },
  site: { tint: "teal", paths: ["soft:M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5Z", "M1.75 8h12.5M8 1.75C6.4 3.4 5.6 5.6 5.6 8s.8 4.6 2.4 6.25C9.6 12.6 10.4 10.4 10.4 8S9.6 3.4 8 1.75Z"] },
  library: { tint: "teal", paths: ["soft:M2.25 2.75h2.75v10.5H2.25Z", "soft:M5 2.75h2.75v10.5H5Z", "soft:M8.85 3.6 11.5 2.9l2.75 10.2-2.65.7Z"] },
  list: { tint: "teal", paths: ["M6.25 4.25h7M6.25 8h7M6.25 11.75h7", "M2.75 4.25h.5M2.75 8h.5M2.75 11.75h.5"] },
  pages: { tint: "teal", paths: ["soft:M5.25 1.75h5.25l2.5 2.5v7.5a.75.75 0 0 1-.75.75h-7a.75.75 0 0 1-.75-.75v-9.25a.75.75 0 0 1 .75-.75Z", "M2.5 4.75v8.75a.75.75 0 0 0 .75.75h6.5"] },
  page: { tint: "teal", paths: ["soft:" + FRAME_SHAPE, "M2.25 6h11.5M4.75 8.5h6.5M4.75 10.75h4"] },
};

const GLYPHS = {
  chevronRight: ["M6 3.5 10.5 8 6 12.5"],
  chevronLeft: ["M10 3.5 5.5 8 10 12.5"],
  close: ["M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5"],
  info: ["M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5Z", "M8 7.5v3.75M8 5h.01"],
  shield: ["M8 1.75 2.75 3.75v3.9c0 3 2.2 5.6 5.25 6.6 3.05-1 5.25-3.6 5.25-6.6v-3.9Z", "M5.75 8.1l1.6 1.6 2.9-3.1"],
  search: ["M7 12.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5ZM14.25 14.25l-3.5-3.5"],
};

function glyph(paths: string[], size: number, className?: string) {
  return <svg viewBox="0 0 16 16" width={String(size)} height={String(size)} aria-hidden="true" class={className}
    fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">
    {paths.map(path => path.startsWith("solid:") ? <path d={path.slice(6)} fill="currentColor" stroke="none" />
      : path.startsWith("soft:") ? <path d={path.slice(5)} fill="currentColor" fill-opacity="0.14" />
      : <path d={path} />)}
  </svg>;
}

function icon(name: Icon) {
  const { tint, paths } = ICONS[name] ?? ICONS.file;
  return <span className={`browser-icon tint-${tint}`} aria-hidden="true">{glyph(paths, 16)}</span>;
}

function looksLikeLink(query: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(query);
}

function count(n: number, more: boolean, noun: string): string {
  return `${n}${more ? " or more " : " "}${noun}${n === 1 && !more ? "" : "s"}`;
}

// A file name keeps its extension in view: the end of the name is drawn apart from the start, and
// only the start gives way to an ellipsis.
function nameParts(title: string): [string, string] | null {
  const dot = title.lastIndexOf(".");
  const extension = dot > 0 ? title.length - dot : 0;
  if (title.length < 24 || extension < 2 || extension > 8) return null;
  const tail = extension + 3;
  return [title.slice(0, title.length - tail), title.slice(title.length - tail)];
}

// Scrolls only the listing, never the frame or its host page, which scrollIntoView would do.
function scrollIntoList(list: FrameNode, node: FrameNode, center = false): void {
  const listBox = list.getBoundingClientRect();
  const nodeBox = node.getBoundingClientRect();
  if (center) list.scrollTop += nodeBox.top - listBox.top - (listBox.height - nodeBox.height) / 2;
  else if (nodeBox.top < listBox.top + 4) list.scrollTop -= listBox.top + 4 - nodeBox.top;
  else if (nodeBox.bottom > listBox.bottom - 4) list.scrollTop += nodeBox.bottom - (listBox.bottom - 4);
}

function radio(checked: boolean) {
  return <span className={checked ? "browser-radio checked" : "browser-radio"} />;
}

function separator() {
  return <span className="browser-crumb-separator" aria-hidden="true">›</span>;
}

function stateBlock(className: string, title: string, text: string | null, action?: unknown) {
  return <div className={`browser-state ${className}`}>
    <p className="browser-state-title">{title}</p>
    {text ? <p className="browser-state-text">{text}</p> : null}
    {action ?? null}
  </div>;
}

function focusIn(list: FrameNode, node: FrameNode): void {
  node.focus({ preventScroll: true });
  if (list.contains(node)) scrollIntoList(list, node);
}

// -- the picker ---------------------------------------------------------------------------------

/** The nodes of one render, by `data-sp-focus` id, and the order of its listing's tab stops. */
type Tree = { card: FrameNode; list: FrameNode; nodes: Map<string, FrameNode>; navIds: string[] };

/**
 * Everything the user can choose, drawn as one card: the "All" row above the tabs, the "All of" row
 * inside each place and every row in it are radios of one group. Clicking a row that opens opens
 * it, and its radio chooses it, so choosing a place and browsing into it never conflict.
 */
function browser({ values, setValues, ui }: Context) {
  const active = frameDocument?.activeElement ?? null;
  // What had focus in the picker before this render rebuilt it; null once focus has left it.
  const focusedId = active?.closest(".browser") ? active.getAttribute("data-sp-focus") : null;
  if (focusedId === null) picker.pending = null;
  applyInitialLocation(values);

  // The runtime hands each element's node to its ref on commit, after this render returns.
  const nodes = new Map<string, FrameNode>();
  const tracked = (id: string) => ({ "data-sp-focus": id, ref: (node: FrameNode | null) => { if (node) nodes.set(id, node); } });
  let cardNode: FrameNode | undefined;
  let menuNode: FrameNode | undefined;

  const tab = picker.tab;
  const tabIndex = Math.max(0, TABS.findIndex(candidate => candidate.value === tab));
  const tabTitle = TABS[tabIndex]!.title;
  const path = picker.paths[tab] ?? [];
  const place = path.at(-1);
  const placeTitle = place?.title ?? tabTitle;
  const query = picker.query;
  const searching = query !== "";
  const link = searching && looksLikeLink(query);
  const allSelected = values.ref === "all";
  const value = allSelected ? null : values.ref ?? null;
  const key = listingKey(tab, place, query);
  const request: Request = { tab, ...(place ? { container: place.value } : {}), ...(searching ? { query } : {}) };
  prune(key);
  const entry = picker.entries.get(key) ?? { listing: { state: "loading" } };
  if (!picker.entries.has(key)) {
    picker.entries.set(key, entry);
    fetchPage(ui, entry, request);
  }
  const listing = entry.listing;
  const loading = listing.state === "loading";
  const page = listing.state === "ready" ? listing.page : undefined;
  const items = page?.items ?? [];
  const more = listing.state === "ready" ? listing.more : undefined;

  if (picker.announcement && !loading) {
    const announcement = picker.announcement;
    picker.announcement = null;
    if (announcement.kind === "search") {
      announce(listing.state === "failed" ? `Couldn't search. ${listing.message}`
        : items.length === 0 ? (link ? "No results for this link" : `No results for “${query}”`)
        : count(items.length, Boolean(page?.nextPageToken), "result"));
    } else {
      const title = announcement.title;
      announce(listing.state === "failed" ? `Couldn't open ${title}. ${listing.message}`
        : `${title === tabTitle && path.length === 0 ? title : `Opened ${title}`}, `
          + (items.length === 0 ? "nothing here yet" : count(items.length, Boolean(page?.nextPageToken), "item")));
    }
  }

  function clearSearch() {
    clearTimeout(picker.debounce);
    picker.debounce = undefined;
    picker.input = "";
    picker.query = "";
  }

  function commitQuery() {
    clearTimeout(picker.debounce);
    picker.debounce = undefined;
    const next = picker.input.trim();
    if (next !== picker.query) {
      picker.query = next;
      picker.announcement = next ? { kind: "search" } : null;
    }
    rerender();
  }

  function navigate(nextPath: Item[], pending: string | null, nextTab = tab) {
    picker.interacted = true;
    picker.crumbMenuOpen = false;
    picker.tab = nextTab;
    picker.paths[nextTab] = nextPath;
    picker.pending = pending;
    picker.announcement = { kind: "open", title: nextPath.at(-1)?.title ?? TABS.find(candidate => candidate.value === nextTab)!.title };
    rerender();
  }

  // A search result carries where it lives; without that, the best known place is the open one.
  const pathOf = (item: Item) => searching && item.path ? placesOf(item.path) : path;

  function open(item: Item) {
    const nextPath = [...pathOf(item), { ...item, path: undefined }];
    clearSearch();
    navigate(nextPath, "first");
  }

  function goUp() {
    if (searching || !place) return;
    navigate(path.slice(0, -1), `row:${place.value}`);
  }

  /** Keeps `depth` places of the path, landing on the row of the place that was below it. */
  function goToDepth(depth: number) {
    navigate(path.slice(0, depth), `row:${path[depth]!.value}`);
  }

  function choose(item: Item, choicePath: Item[]) {
    if (item.selectable === false) {
      announce(`Can't choose ${item.title}${item.unselectableReason ? `. ${item.unselectableReason}` : ""}`);
      rerender();
      return;
    }
    picker.interacted = true;
    picker.chosenAt = { tab, path: choicePath };
    announce(`Chose ${item.title}`);
    setValues({ ref: item.value, title: item.title, location: null });
  }

  function chooseAll() {
    picker.interacted = true;
    announce(`Chose ${ALL_TITLE}`);
    setValues({ ref: "all", title: null, location: null });
  }

  function switchTab(nextTab: string) {
    if (nextTab === tab) {
      // The open tab's button takes it back to its root, as a sidebar location does.
      if (path.length > 0 && !searching) navigate([], `tab:${tab}`);
      return;
    }
    navigate(picker.paths[nextTab] ?? [], `tab:${nextTab}`, nextTab);
  }

  function showChosen() {
    const chosenAt = picker.chosenAt;
    if (!chosenAt || !value) return;
    clearSearch();
    picker.revealChosen = true;
    navigate(chosenAt.path, `row:${value}`, chosenAt.tab);
  }

  function retry() {
    picker.entries.delete(key);
    picker.pending = "first";
    picker.announcement = searching ? { kind: "search" } : { kind: "open", title: placeTitle };
    rerender();
  }

  function loadMore() {
    if (listing.state !== "ready" || !listing.page.nextPageToken || listing.more === "loading") return;
    fetchPage(ui, entry, request);
    const last = items.at(-1);
    if (last) picker.pending = `after:${last.value}`;
    rerender();
  }

  // ----- The listing's tab stops, known before the rows are drawn -----

  /**
   * The rows and the buttons among them, in order, which share arrow-key movement, one tab stop and
   * type-ahead. Mirrors what the listing below draws.
   */
  const rowId = (item: Item) => `row:${item.value}`;
  const navIds: string[] = [
    ...(!searching && place && place.selectable !== false ? [rowId(place)] : []),
    ...(listing.state === "failed" ? ["retry"]
      : items.length > 0 ? [...items.map(rowId), ...(page?.nextPageToken || more === "failed" ? ["more"] : [])]
      : []),
  ];
  // One tab stop for the listing: the row last focused here, else the chosen row, else the first.
  const checkedId = value !== null && navIds.includes(`row:${value}`) ? `row:${value}` : undefined;
  const stopId = [entry.focusId, checkedId, navIds[0]].find(id => id && navIds.includes(id));
  const navNode = (id: string | undefined) => (id === undefined ? undefined : nodes.get(id));
  const tabStop = () => navIds.find(id => nodes.get(id)?.tabIndex === 0);

  // From the controls above the listing, ArrowDown moves to the listing's tab stop.
  const moveToList = (event: FrameEvent) => {
    const stop = navNode(tabStop());
    const list = nodes.get("list");
    if (!stop || !list) return;
    event.preventDefault();
    focusIn(list, stop);
  };

  // ----- The "All" row, above everything else -----

  const allRow = <div
    className={`browser-row browser-all${allSelected ? " selected" : ""}`}
    role="radio" aria-checked={allSelected ? "true" : "false"} aria-label={ALL_TITLE}
    aria-description="Every site, library, list and file you can open" tabindex="0" {...tracked("all")}
    onClick={(event: FrameEvent) => {
      if (event.detail <= 1) chooseAll();
    }}
    onKeydown={(event: FrameEvent) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        chooseAll();
      } else if (event.key === "ArrowDown") {
        moveToList(event);
      }
    }}
  >
    <span className="browser-radio-hit">{radio(allSelected)}</span>
    {icon("site")}
    <span className="browser-row-text">
      <span className="browser-row-title">{ALL_TITLE}</span>
      <span className="browser-row-subtitle">Every site, library, list and file you can open</span>
    </span>
  </div>;

  // ----- Tabs and search -----

  const tablist = <div className="browser-tabs" role="tablist" aria-label="Places">
    {TABS.map((candidate, index) => {
      const selected = candidate.value === tab;
      return <button
        type="button" role="tab" id={`sp-tab-${index}`} className="browser-tab"
        aria-selected={selected ? "true" : "false"} aria-controls="sp-panel" tabindex={selected ? "0" : "-1"}
        title={candidate.title} {...tracked(`tab:${candidate.value}`)}
        onClick={() => switchTab(candidate.value)}
        onKeydown={(event: FrameEvent) => {
          const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
          const next = step ? TABS[(index + step + TABS.length) % TABS.length]
            : event.key === "Home" ? TABS[0] : event.key === "End" ? TABS.at(-1) : undefined;
          if (!next) return;
          event.preventDefault();
          switchTab(next.value);
        }}
      >{candidate.title}</button>;
    })}
  </div>;

  const searchInput = <input
    className="browser-search-input" type="search" data-configurator-input="sp-search" {...tracked("search")}
    value={picker.input} placeholder="Search or paste a link" aria-label={`Search ${placeTitle}, or paste a link`}
    aria-controls="sp-list" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
    onInput={(event: FrameEvent) => {
      picker.input = event.currentTarget.value;
      picker.interacted = true;
      clearTimeout(picker.debounce);
      picker.debounce = setTimeout(commitQuery, SEARCH_DELAY_MS);
      rerender();
    }}
    onKeydown={(event: FrameEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitQuery();
      } else if (event.key === "Escape") {
        // Only an Escape that clears something is consumed; with nothing to clear it is left be.
        if (!picker.input) return;
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        rerender();
      } else if (event.key === "ArrowDown") {
        moveToList(event);
      }
    }}
  />;
  const searchBusy = picker.debounce !== undefined || (searching && (loading || more === "loading"));
  const search = <div className={`browser-search${searchBusy ? " busy" : ""}`}>
    <span className="browser-search-icon">{glyph(GLYPHS.search, 14)}</span>
    <span className="browser-spinner" aria-hidden="true" />
    {searchInput}
    <button type="button" className="browser-search-clear" aria-label="Clear search" title="Clear search" {...tracked("search-clear")}
      onClick={() => {
        clearSearch();
        picker.pending = "search";
        rerender();
      }}>{glyph(GLYPHS.close, 12)}</button>
  </div>;

  // ----- The listing -----

  const rows: unknown[] = [];

  function handleNavKey(event: FrameEvent, actions: { open?: () => void; choose(): void } | null) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const list = nodes.get("list");
    if (!list) return;
    const index = navIds.indexOf(event.currentTarget.getAttribute("data-sp-focus") ?? "");
    const go = (id: string | undefined) => {
      const target = navNode(id);
      if (!target) return;
      event.preventDefault();
      focusIn(list, target);
    };
    const rowHeight = navNode(navIds[0])?.getBoundingClientRect().height || 44;
    const pageSize = Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1);
    switch (event.key) {
      case "ArrowDown": return go(navIds[index + 1]);
      case "ArrowUp": return go(navIds[index - 1]);
      case "Home": return go(navIds[0]);
      case "End": return go(navIds.at(-1));
      case "PageDown": return go(navIds[Math.min(navIds.length - 1, index + pageSize)]);
      case "PageUp": return go(navIds[Math.max(0, index - pageSize)]);
      case "Enter":
        if (!actions) return;
        event.preventDefault();
        return actions.open ? actions.open() : actions.choose();
      case " ":
        if (!actions) return;
        event.preventDefault();
        return actions.choose();
      case "ArrowRight":
        if (!actions?.open) return;
        event.preventDefault();
        return actions.open();
      case "ArrowLeft":
      case "Backspace":
        if (searching || !place) return;
        event.preventDefault();
        return goUp();
    }
    if (event.key.length !== 1 || event.key === " " || event.key === "/") return;
    const now = Date.now();
    const text = (now - picker.typeahead.at < TYPEAHEAD_MS ? picker.typeahead.text : "") + event.key.toLowerCase();
    picker.typeahead = { text, at: now };
    // Repeating one letter steps through the rows that start with it.
    const repeating = [...text].every(letter => letter === text[0]);
    const needle = repeating ? text[0]! : text;
    const start = repeating ? index + 1 : Math.max(0, index);
    const ordered = [...navIds.slice(start), ...navIds.slice(0, start)];
    go(ordered.find(id => (nodes.get(id)?.getAttribute("data-sp-title") ?? "").toLowerCase().startsWith(needle)));
  }

  // The tab stop follows focus between renders, so Tab returns to where the user was.
  function rememberFocus(node: FrameNode) {
    const id = node.getAttribute("data-sp-focus") ?? undefined;
    entry.focusId = id;
    for (const navId of navIds) {
      const nav = nodes.get(navId);
      if (nav) nav.tabIndex = navId === id ? 0 : -1;
    }
  }

  function navButton(id: string, className: string, onClick: () => void, children: unknown, busy = false) {
    return <button type="button" className={className} aria-disabled={busy ? "true" : undefined}
      tabindex={id === stopId ? "0" : "-1"} data-sp-nav="" {...tracked(id)}
      onFocus={(event: FrameEvent) => rememberFocus(event.currentTarget)}
      onKeydown={(event: FrameEvent) => handleNavKey(event, null)}
      onClick={onClick}>{children}</button>;
  }

  function itemRow(item: Item, asPlace = false) {
    const id = rowId(item);
    const checked = value === item.value;
    const selectable = item.selectable !== false;
    const opens = Boolean(item.navigable) && !asPlace;
    const title = asPlace ? `All of ${item.title}` : item.title;
    const choicePath = asPlace ? path.slice(0, -1) : pathOf(item);
    const location = searching && item.path
      ? (item.path.length > 0 ? item.path.map(crumb => crumb.title).join(PATH_SEPARATOR) : tabTitle)
      : undefined;
    const reason = selectable ? undefined : item.unselectableReason ?? "This can't be chosen.";
    const secondary = asPlace ? "Everything inside, including anything added later"
      // A row that opens says what is inside; why it can't be chosen shows once it is open.
      : location ?? (opens ? item.subtitle ?? reason : reason ?? item.subtitle);
    const split = asPlace || item.navigable ? null : nameParts(item.title);
    const actions = { open: opens ? () => open(item) : undefined, choose: () => choose(item, choicePath) };
    return <div
      className={`browser-row${checked ? " selected" : ""}${selectable ? "" : " unselectable"}${asPlace ? " browser-place" : ""}${opens ? " opens" : ""}`}
      role="radio" aria-checked={checked ? "true" : "false"} aria-disabled={selectable ? undefined : "true"} aria-label={title}
      aria-description={[location ? `In ${location}` : item.subtitle, item.meta, item.badge, reason,
        opens ? "Has items. Press Right Arrow to open" : undefined].filter(Boolean).join(". ") || undefined}
      title={reason && !opens ? `${title} – ${reason}` : title}
      tabindex={id === stopId ? "0" : "-1"} data-sp-nav="" data-sp-title={title} {...tracked(id)}
      onFocus={(event: FrameEvent) => rememberFocus(event.currentTarget)}
      onKeydown={(event: FrameEvent) => handleNavKey(event, actions)}
      onClick={(event: FrameEvent) => {
        // The second click of a double-click lands on whatever the first one opened.
        if (event.detail > 1) return;
        if (opens && !(selectable && event.target.closest(".browser-radio-hit"))) actions.open!();
        else actions.choose();
      }}
    >
      {/* A row that can't be chosen has no radio, only its room, so icons stay aligned. */}
      <span className="browser-radio-hit">{selectable ? radio(checked) : null}</span>
      {icon(item.icon ?? (item.navigable ? "folder" : "file"))}
      <span className="browser-row-text">
        <span className="browser-row-heading">
          {split
            ? <span className="browser-row-title split">
              <span className="browser-name-start">{split[0]}</span>
              <span className="browser-name-end">{split[1]}</span>
            </span>
            : <span className="browser-row-title">{title}</span>}
          {item.badge && !asPlace ? <span className="browser-badge">{item.badge}</span> : null}
        </span>
        {secondary ? <span className={`browser-row-subtitle${secondary === reason && !opens ? " reason" : ""}${location ? " location" : ""}`}>{secondary}</span> : null}
      </span>
      {item.meta && !asPlace ? <span className="browser-row-meta">{item.meta}</span> : null}
      {/* Rows that do not open keep the chevron's room, so every row's meta lines up. */}
      {opens ? glyph(GLYPHS.chevronRight, 14, "browser-chevron") : asPlace ? null : <span className="browser-chevron-space" />}
    </div>;
  }

  if (!searching && place) {
    rows.push(place.selectable !== false ? itemRow(place, true) : <div className="browser-place-reason">
      {glyph(GLYPHS.info, 14)}
      <span>{place.unselectableReason ?? `You can't choose all of ${place.title}, but you can choose what's inside.`}</span>
    </div>);
  }
  if (page?.notice) {
    rows.push(<div className="browser-notice">{glyph(GLYPHS.info, 14)}<span>{page.notice}</span></div>);
  }
  if (listing.state === "loading") {
    for (let index = 0; index < SKELETON_ROWS; index++) {
      rows.push(<div className="browser-skeleton" aria-hidden="true">
        <span className="browser-skeleton-radio" />
        <span className="browser-skeleton-icon" />
        <span className="browser-skeleton-text">
          <span className="browser-skeleton-line" style={{ width: `${[58, 44, 66, 38, 52, 47, 61][index]}%` }} />
          <span className="browser-skeleton-line short" style={{ width: `${[32, 24, 36, 21, 28, 25, 30][index]}%` }} />
        </span>
      </div>);
    }
  } else if (listing.state === "failed") {
    rows.push(stateBlock("failed", searching ? "Couldn't search" : `Couldn't open ${placeTitle}`, listing.message,
      navButton("retry", "browser-button", retry, "Try again")));
  } else if (items.length === 0) {
    const widen = searching && !link && place
      ? <button type="button" className="browser-link" {...tracked("widen")} onClick={() => {
        picker.paths[tab] = [];
        picker.announcement = { kind: "search" };
        rerender();
      }}>{`Search all of ${tabTitle}`}</button>
      : undefined;
    rows.push(searching
      ? stateBlock("empty", link ? "No results for this link" : `No results for “${query}”`,
        link ? "Check that you can open it, or browse to it instead." : place ? `Only ${place.title} was searched.` : null, widen)
      : stateBlock("empty", "Nothing here yet", place && place.selectable !== false ? `You can still choose all of ${place.title}.` : null));
  } else {
    for (const item of items) rows.push(itemRow(item));
    if (page?.nextPageToken || more === "failed") {
      rows.push(navButton("more", `browser-more${more === "loading" ? " busy" : ""}`, loadMore, more === "loading"
        ? [<span className="browser-spinner" aria-hidden="true" />, "Loading more…"]
        : more === "failed" ? "Couldn't load more. Try again" : "Show more", more === "loading"));
    }
  }

  const list = <div
    className="browser-list" id="sp-list" role="group" aria-label={searching ? "Search results" : placeTitle}
    aria-busy={loading ? "true" : undefined} tabindex="-1" {...tracked("list")}
    style={picker.minListHeight ? { minHeight: `${picker.minListHeight}px` } : {}}
    onScroll={(event: FrameEvent) => {
      // Scrolling near the end loads the next page; the button stays for keyboards. A listing the
      // user has not scrolled never loads by itself, so a short page cannot chain into many.
      const node = event.currentTarget;
      if (node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 96 && more !== "failed") loadMore();
    }}
  >{rows}</div>;

  // ----- Where the listing is: breadcrumb, or the search's scope -----

  const offerChosen = value !== null && picker.chosenAt !== null && Boolean(values.title) && !loading && checkedId === undefined;
  const canGoUp = !searching && path.length > 0;
  const parentTitle = path.length > 1 ? path.at(-2)!.title : tabTitle;
  const back = canGoUp
    ? <button type="button" className="browser-back" aria-label={`Back to ${parentTitle}`} title={`Back to ${parentTitle}`}
      {...tracked("back")} onClick={goUp}>{glyph(GLYPHS.chevronLeft, 14)}</button>
    : null;

  let crumbMenu: unknown = null;
  let where: unknown;
  if (searching) {
    where = <span className="browser-scope">{loading
      ? (link ? "Looking up link…" : `Searching ${place ? place.title : `all of ${tabTitle}`}…`)
      : link ? "Results for this link"
      : ["Results in ", ...(place ? [<strong>{place.title}</strong>] : ["all of ", <strong>{tabTitle}</strong>])]}</span>;
  } else {
    // The tab's root, then each place. Deep paths fold their middle into a "…" menu, so the
    // breadcrumb stays on one line and the current place keeps its room.
    const trail = [{ title: tabTitle }, ...path];
    const folded = path.length > 3 ? path.slice(0, -2) : [];
    const crumbs: unknown[] = [];
    trail.forEach((crumb, depth) => {
      if (folded.length > 0 && depth >= 1 && depth <= folded.length) {
        if (depth !== 1) return;
        crumbs.push(separator(), <button
          type="button" className="browser-crumb browser-crumb-more" aria-label={`Show ${folded.length} more places`}
          aria-haspopup="menu" aria-expanded={picker.crumbMenuOpen ? "true" : "false"}
          title={folded.map(hidden => hidden.title).join(PATH_SEPARATOR)} {...tracked("crumb-more")}
          onMousedown={(event: FrameEvent) => {
            // Keeps the menu's own focusout from closing it just before this click toggles it.
            if (picker.crumbMenuOpen) event.preventDefault();
          }}
          onClick={() => {
            picker.crumbMenuOpen = !picker.crumbMenuOpen;
            picker.pending = picker.crumbMenuOpen ? "menu:1" : "crumb-more";
            rerender();
          }}
        >…</button>);
        return;
      }
      if (depth > 0) crumbs.push(separator());
      crumbs.push(depth === trail.length - 1
        ? <span className="browser-crumb current" aria-current="location" title={crumb.title}>{crumb.title}</span>
        : <button type="button" className="browser-crumb" title={crumb.title} {...tracked(`crumb:${depth}`)}
          onClick={() => goToDepth(depth)}>{crumb.title}</button>);
    });
    where = <nav className="browser-crumbs" aria-label="Location">{crumbs}</nav>;

    if (picker.crumbMenuOpen && folded.length > 0) {
      const closeMenu = (pending: string | null) => {
        picker.crumbMenuOpen = false;
        picker.pending = pending;
        rerender();
      };
      const menuIds = folded.map((_, index) => `menu:${index + 1}`);
      crumbMenu = <div className="browser-crumb-menu" role="menu" aria-label="More places" data-floating-popup=""
        ref={(node: FrameNode | null) => { if (node) menuNode = node; }}
        onFocusout={(event: FrameEvent) => {
          if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
          const menu = event.currentTarget;
          setTimeout(() => {
            if (picker.crumbMenuOpen && !menu.contains(frameDocument?.activeElement ?? null)) closeMenu(null);
          }, 0);
        }}
      >{folded.map((crumb, index) => <button
        type="button" role="menuitem" className="browser-crumb-menu-item" tabindex="-1" {...tracked(menuIds[index]!)}
        onClick={() => goToDepth(index + 1)}
        onKeydown={(event: FrameEvent) => {
          const at = menuIds.indexOf(event.currentTarget.getAttribute("data-sp-focus") ?? "");
          const next = ({
            ArrowDown: menuIds[(at + 1) % menuIds.length], ArrowUp: menuIds[(at - 1 + menuIds.length) % menuIds.length],
            Home: menuIds[0], End: menuIds.at(-1),
          } as Record<string, string | undefined>)[event.key];
          if (next) {
            event.preventDefault();
            nodes.get(next)?.focus({ preventScroll: true });
          } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            closeMenu(event.key === "Escape" ? "crumb-more" : null);
          }
        }}
      >{icon(crumb.icon ?? "folder")}<span>{crumb.title}</span></button>)}</div>;
    }
  }

  const tail = offerChosen
    ? <span className="browser-chosen">
      <span className="browser-chosen-label" title={values.title!}>Chosen: <strong>{values.title!}</strong></span>
      <button type="button" className="browser-link" aria-label={`Show ${values.title!}`} {...tracked("show-chosen")} onClick={showChosen}>Show</button>
    </span>
    : page && items.length > 0
      ? <span className="browser-count">{count(items.length, Boolean(page.nextPageToken), searching ? "result" : "item")}</span>
      : null;

  const panel = <div className="browser-panel" id="sp-panel" role="tabpanel" aria-labelledby={`sp-tab-${tabIndex}`}>
    <div className="browser-location">{back}{where}{tail}</div>
    {crumbMenu}
    {list}
  </div>;

  // ----- What the choice grants -----

  const granted = summary(values);
  const summaryNode = granted
    ? <div className="browser-summary">
      {glyph(GLYPHS.shield, 14, "browser-summary-icon")}
      <p className="browser-summary-text"><strong>{granted.name}</strong>{granted.text}</p>
    </div>
    : null;

  const card = <div className="browser with-all" role="radiogroup" aria-label={FIELD_LABEL}
    ref={(node: FrameNode | null) => { if (node) cardNode = node; }}
    onKeydown={(event: FrameEvent) => {
      // "/" jumps to the search box from anywhere in the picker but the box itself.
      const input = nodes.get("search");
      if (event.key !== "/" || !input || event.target === input) return;
      event.preventDefault();
      input.focus();
      input.select();
    }}
  >{allRow}<div className="browser-toolbar">{tablist}{search}</div>{panel}{summaryNode}</div>;

  // Once the runtime has committed the tree, the refs hold its nodes and focus can be put back.
  const run = ++picker.renders;
  queueMicrotask(() => {
    const listNode = nodes.get("list");
    if (run !== picker.renders || !cardNode?.isConnected || !listNode) return;
    const tree: Tree = { card: cardNode, list: listNode, nodes, navIds };
    if (picker.revealChosen && !loading) {
      picker.revealChosen = false;
      const row = navNode(checkedId);
      if (row) scrollIntoList(listNode, row, true);
    }
    const height = listNode.getBoundingClientRect().height;
    if (height > picker.minListHeight) {
      picker.minListHeight = height;
      listNode.style.minHeight = `${height}px`;
    }
    const opener = nodes.get("crumb-more");
    if (menuNode && opener) menuNode.style.left = `${Math.max(4, opener.offsetLeft - 8)}px`;
    restoreFocus(tree, focusedId, loading || more === "loading");
  });

  return card;
}

/**
 * Puts focus back in the rebuilt picker. A pending target (where a navigation wants focus to land)
 * wins once it exists; while the place it is in is still loading, focus waits on the listing.
 */
function restoreFocus({ card, list, nodes, navIds }: Tree, focusedId: string | null, waiting: boolean): void {
  if (focusedId === null) return;
  const pending = picker.pending;
  if (pending) {
    let target: FrameNode | undefined;
    if (pending === "first") target = navIds.length > 0 ? nodes.get(navIds[0]!) : undefined;
    else if (pending.startsWith("after:")) {
      const next = navIds[navIds.indexOf(`row:${pending.slice(6)}`) + 1];
      target = next?.startsWith("row:") ? nodes.get(next) : undefined;
    } else target = nodes.get(pending);
    if (target) {
      picker.pending = null;
      focusIn(list, target);
      return;
    }
    if (waiting) {
      (nodes.get(focusedId) ?? list).focus({ preventScroll: true });
      return;
    }
    picker.pending = null;
  }
  const active = frameDocument?.activeElement ?? null;
  if (active && card.contains(active) && active.getAttribute("data-sp-focus") === focusedId) return;
  // Focus parked on the listing belongs on its tab stop once there is one.
  const target = (focusedId === "list" ? undefined : nodes.get(focusedId))
    ?? (focusedId.startsWith("tab:") ? nodes.get(`tab:${picker.tab}`) : undefined)
    ?? navIds.map(id => nodes.get(id)).find(node => node?.tabIndex === 0)
    ?? list;
  target.focus({ preventScroll: true });
}

// The picker's own styles, on the runtime's tokens, so it follows the host's light and dark themes.
const STYLE = `
/* A label kept for screen readers, which the runtime's stylesheet doesn't provide. */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.browser {
  --browser-row-height: 44px;
  --browser-tint-blue: oklch(54% 0.17 258);
  --browser-tint-green: oklch(53% 0.13 152);
  --browser-tint-orange: oklch(62% 0.17 48);
  --browser-tint-red: oklch(56% 0.19 26);
  --browser-tint-purple: oklch(53% 0.19 300);
  --browser-tint-pink: oklch(58% 0.2 355);
  --browser-tint-amber: oklch(62% 0.13 75);
  --browser-tint-indigo: oklch(52% 0.15 275);
  --browser-tint-teal: oklch(53% 0.09 195);
  position: relative; border: 1px solid var(--color-kumo-line); border-radius: 10px; background: var(--color-kumo-base);
  /* Long names must ellipsize, not widen the grid track the picker sits in. */
  contain: inline-size;
}
@media (prefers-color-scheme: dark) {
  .browser {
    --browser-tint-blue: oklch(74% 0.13 258);
    --browser-tint-green: oklch(74% 0.13 152);
    --browser-tint-orange: oklch(76% 0.14 55);
    --browser-tint-red: oklch(72% 0.15 24);
    --browser-tint-purple: oklch(74% 0.13 300);
    --browser-tint-pink: oklch(74% 0.14 355);
    --browser-tint-amber: oklch(80% 0.12 80);
    --browser-tint-indigo: oklch(74% 0.11 275);
    --browser-tint-teal: oklch(76% 0.09 195);
  }
}
:where(.browser) button { font: inherit; color: inherit; }
.browser-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 8px 6px; }
.browser.with-all .browser-toolbar { border-top: 1px solid var(--color-kumo-line); }
.browser-tabs { display: flex; gap: 2px; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.browser-tabs::-webkit-scrollbar { display: none; }
.browser-tab { flex-shrink: 0; height: 28px; max-width: 180px; overflow: hidden; border: 0; border-radius: 6px; padding: 0 10px; background: transparent; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; letter-spacing: -0.1px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.browser-tab:hover:not(:disabled) { background: var(--color-kumo-elevated); color: var(--text-color-kumo-default); }
.browser-tab[aria-selected="true"] { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-search { position: relative; flex: 1 1 180px; min-width: 160px; margin-left: auto; }
.browser-search-icon { position: absolute; left: 9px; top: 50%; display: flex; transform: translateY(-50%); color: var(--text-color-kumo-inactive); pointer-events: none; }
.browser-search .browser-spinner { position: absolute; left: 10px; top: 50%; margin-top: -6px; display: none; }
.browser-search.busy .browser-search-icon { display: none; }
.browser-search.busy .browser-spinner { display: block; }
.browser-search-input { display: block; width: 100%; height: 30px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 0 28px 0 29px; background: var(--color-kumo-base); color: inherit; outline: none; font: inherit; font-size: 13px; letter-spacing: -0.2px; }
.browser-search-input::placeholder { color: var(--text-color-kumo-inactive); }
.browser-search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
.browser-search-input:focus { border-color: var(--color-kumo-interact); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-interact) 35%, transparent); }
.browser-search-input:disabled { background: var(--color-kumo-elevated); }
.browser-search-clear { position: absolute; right: 5px; top: 50%; display: flex; width: 20px; height: 20px; align-items: center; justify-content: center; transform: translateY(-50%); border: 0; border-radius: 50%; padding: 0; background: transparent; color: var(--text-color-kumo-subtle); cursor: pointer; }
.browser-search-clear:hover { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-search-input:placeholder-shown ~ .browser-search-clear { display: none; }
.browser-spinner { display: inline-block; flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid var(--color-kumo-line); border-top-color: var(--text-color-kumo-subtle); border-radius: 50%; animation: browser-spin .7s linear infinite; }
.browser-location { display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 8px 0 8px; border-top: 1px solid var(--color-kumo-line); color: var(--text-color-kumo-subtle); font-size: 12.5px; line-height: 16px; }
.browser-back { display: flex; flex-shrink: 0; width: 24px; height: 24px; margin-left: -4px; align-items: center; justify-content: center; border: 0; border-radius: 6px; padding: 0; background: transparent; color: var(--text-color-kumo-subtle); cursor: pointer; }
.browser-back:hover:not(:disabled) { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-back.placeholder { display: none; }
.browser-crumbs { display: flex; flex: 1; align-items: center; gap: 1px; min-width: 0; overflow: hidden; white-space: nowrap; }
.browser-crumb { flex: 0 1 auto; min-width: 2.5em; max-width: 180px; overflow: hidden; border: 0; border-radius: 5px; padding: 2px 5px; background: none; color: var(--text-color-kumo-subtle); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
button.browser-crumb:hover:not(:disabled) { background: var(--color-kumo-tint); color: var(--text-color-kumo-default); }
.browser-crumb.current { flex: 0 0 auto; max-width: 62%; color: var(--text-color-kumo-default); font-weight: 500; cursor: default; }
.browser-crumb-more { flex-shrink: 0; min-width: 0; letter-spacing: .05em; }
.browser-crumb-separator { flex-shrink: 0; padding: 0 1px; color: var(--text-color-kumo-inactive); }
.browser-scope { flex: 1; min-width: 0; overflow: hidden; padding: 0 5px; text-overflow: ellipsis; white-space: nowrap; }
.browser-scope strong, .browser-chosen strong { color: var(--text-color-kumo-default); font-weight: 500; }
.browser-count { flex-shrink: 0; padding-left: 8px; color: var(--text-color-kumo-inactive); font-variant-numeric: tabular-nums; }
.browser-chosen { display: flex; flex-shrink: 1; align-items: center; gap: 2px; min-width: 0; max-width: 46%; margin-left: 8px; border-radius: 999px; padding: 0 2px 0 9px; background: var(--color-kumo-tint); height: 22px; font-size: 12px; }
.browser-chosen-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-link { flex-shrink: 0; border: 0; border-radius: 999px; padding: 2px 7px; background: none; color: var(--text-color-kumo-default); font-size: 12px; font-weight: 500; text-decoration: underline; text-decoration-color: var(--color-kumo-interact); text-underline-offset: 2px; cursor: pointer; }
.browser-link:hover:not(:disabled) { text-decoration-color: currentColor; }
.browser-crumb-menu { position: absolute; top: calc(100% - 2px); z-index: 10; display: grid; min-width: 180px; max-width: 280px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 4px; background: var(--color-kumo-base); box-shadow: 0 4px 16px rgb(0 0 0 / 10%); }
.browser-panel { position: relative; }
.browser-panel > .browser-crumb-menu { top: 30px; }
.browser-crumb-menu-item { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; border: 0; border-radius: 6px; padding: 0 8px 0 4px; background: none; text-align: left; cursor: pointer; }
.browser-crumb-menu-item span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-crumb-menu-item:hover, .browser-crumb-menu-item:focus { background: var(--color-kumo-tint); outline: none; }
.browser-crumb-menu-item .browser-icon { width: 22px; height: 22px; border-radius: 5px; }
.browser-list { position: relative; display: grid; align-content: start; gap: 1px; max-height: 480px; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--color-kumo-line); padding: 4px; outline: none; scroll-padding: 4px; }
.browser-row { display: flex; align-items: center; gap: 8px; height: var(--browser-row-height); min-width: 0; border-radius: 7px; padding: 0 8px 0 4px; outline: none; cursor: pointer; user-select: none; -webkit-user-select: none; }
.browser-row:hover { background: var(--color-kumo-elevated); }
.browser-row.selected, .browser-row.selected:hover { background: var(--color-kumo-tint); }
.browser-row:focus-visible { box-shadow: inset 0 0 0 2px var(--color-kumo-interact); }
.browser-row.unselectable:not(.opens) { cursor: default; }
.browser-all { margin: 4px; height: 52px; }
.browser-all .browser-row-title { font-weight: 600; }
.browser-place { position: relative; margin-bottom: 5px; }
.browser-place::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: -3px; border-bottom: 1px solid var(--color-kumo-line); pointer-events: none; }
.browser-radio-hit { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 50%; }
.browser-row:not(.unselectable):not([aria-disabled="true"]) .browser-radio-hit:hover { background: color-mix(in oklab, var(--color-kumo-interact) 40%, transparent); }
.browser-radio { display: block; width: 16px; height: 16px; border: 1.5px solid var(--color-kumo-interact); border-radius: 50%; background: var(--color-kumo-base); }
.browser-row:hover .browser-radio:not(.checked) { border-color: var(--text-color-kumo-inactive); }
.browser-radio.checked { border-color: var(--text-color-kumo-default); background: var(--text-color-kumo-default); box-shadow: inset 0 0 0 3.5px var(--color-kumo-base); }
.browser-icon { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 7px; color: var(--browser-tint); background: color-mix(in oklab, var(--browser-tint) 11%, var(--color-kumo-base)); }
.browser-icon.tint-neutral { --browser-tint: var(--text-color-kumo-subtle); background: var(--color-kumo-tint); }
.browser-row.selected .browser-icon.tint-neutral { background: var(--color-kumo-base); }
.browser-icon.tint-blue { --browser-tint: var(--browser-tint-blue); }
.browser-icon.tint-green { --browser-tint: var(--browser-tint-green); }
.browser-icon.tint-orange { --browser-tint: var(--browser-tint-orange); }
.browser-icon.tint-red { --browser-tint: var(--browser-tint-red); }
.browser-icon.tint-purple { --browser-tint: var(--browser-tint-purple); }
.browser-icon.tint-pink { --browser-tint: var(--browser-tint-pink); }
.browser-icon.tint-amber { --browser-tint: var(--browser-tint-amber); }
.browser-icon.tint-indigo { --browser-tint: var(--browser-tint-indigo); }
.browser-icon.tint-teal { --browser-tint: var(--browser-tint-teal); }
.browser-row-text { display: grid; flex: 1; gap: 1px; min-width: 0; }
.browser-row-heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
.browser-row-title { min-width: 0; overflow: hidden; color: var(--text-color-kumo-default); font-size: 13px; font-weight: 500; line-height: 18px; letter-spacing: -0.15px; text-overflow: ellipsis; white-space: nowrap; }
.browser-row-title.split { display: flex; }
.browser-name-start { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.browser-name-end { flex-shrink: 0; white-space: pre; }
.browser-row.unselectable:not(.opens) .browser-row-title { color: var(--text-color-kumo-subtle); }
.browser-row-subtitle { min-width: 0; overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.browser-row-subtitle.reason { color: var(--text-color-kumo-inactive); }
.browser-badge { flex-shrink: 0; border: 1px solid var(--color-kumo-line); border-radius: 4px; padding: 0 5px; color: var(--text-color-kumo-subtle); font-size: 11px; font-weight: 600; line-height: 15px; letter-spacing: .04em; font-variant-caps: all-small-caps; white-space: nowrap; }
.browser-row-meta { flex-shrink: 0; max-width: 34%; overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.browser-chevron-space { flex-shrink: 0; width: 12px; }
.browser-chevron { flex-shrink: 0; margin-right: -2px; color: var(--text-color-kumo-inactive); transition: transform .12s ease, color .12s ease; }
.browser-row:hover .browser-chevron { color: var(--text-color-kumo-subtle); transform: translateX(2px); }
.browser-place-reason, .browser-notice { display: flex; align-items: flex-start; gap: 7px; margin: 2px 0 4px; border-radius: 7px; padding: 7px 9px; background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.browser-place-reason svg, .browser-notice svg { flex-shrink: 0; margin-top: 1px; }
.browser-more { display: flex; align-items: center; justify-content: center; gap: 8px; height: 36px; margin-top: 2px; border: 0; border-radius: 7px; background: transparent; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; cursor: pointer; outline: none; }
.browser-more:hover:not([aria-disabled="true"]) { background: var(--color-kumo-elevated); color: var(--text-color-kumo-default); }
.browser-more:focus-visible { box-shadow: inset 0 0 0 2px var(--color-kumo-interact); }
.browser-more.busy { cursor: progress; }
.browser-state { display: grid; justify-items: center; align-content: center; gap: 4px; min-height: calc(var(--browser-row-height) * 3); padding: 12px 16px; text-align: center; }
.browser-state p { margin: 0; max-width: 340px; }
.browser-state-title { color: var(--text-color-kumo-default); font-size: 13px; font-weight: 500; line-height: 18px; }
.browser-state-text { color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.browser-state.failed .browser-state-title { color: var(--color-kumo-danger); }
.browser-state .browser-link, .browser-state .browser-button { margin-top: 6px; }
.browser-button { display: inline-flex; height: 28px; align-items: center; border: 1px solid var(--color-kumo-line); border-radius: 7px; padding: 0 10px; background: var(--color-kumo-base); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.browser-button:hover:not(:disabled) { background: var(--color-kumo-elevated); }
.browser-skeleton { display: flex; align-items: center; gap: 8px; height: var(--browser-row-height); padding: 0 8px 0 4px; }
.browser-skeleton-radio { flex-shrink: 0; width: 16px; height: 16px; margin: 0 6px; border-radius: 50%; background: var(--color-kumo-tint); }
.browser-skeleton-icon { flex-shrink: 0; width: 28px; height: 28px; border-radius: 7px; background: var(--color-kumo-tint); }
.browser-skeleton-text { display: grid; flex: 1; gap: 7px; }
.browser-skeleton-line { height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--color-kumo-tint) 0%, var(--color-kumo-elevated) 50%, var(--color-kumo-tint) 100%) 0 0 / 200% 100%; animation: browser-shimmer 1.4s ease-in-out infinite; }
.browser-skeleton-line.short { height: 6px; }
.browser-summary { display: flex; align-items: flex-start; gap: 8px; border-top: 1px solid var(--color-kumo-line); border-radius: 0 0 9px 9px; padding: 9px 12px 10px; background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 17px; }
.browser-summary-icon { flex-shrink: 0; margin-top: 1.5px; color: var(--text-color-kumo-default); }
.browser-summary-text { margin: 0; min-width: 0; }
.browser-summary strong { color: var(--text-color-kumo-default); font-weight: 600; }
.browser-tab:focus-visible, .browser-back:focus-visible, .browser-crumb:focus-visible, .browser-link:focus-visible, .browser-button:focus-visible, .browser-search-clear:focus-visible { outline: 2px solid var(--color-kumo-interact); outline-offset: 1px; }
@keyframes browser-spin { to { transform: rotate(360deg); } }
@keyframes browser-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) {
  .browser-skeleton-line { animation: none; }
  .browser-spinner { animation-duration: 1.6s; }
  .browser-chevron { transition: none; }
  .browser-row:hover .browser-chevron { transform: none; }
}
`;

function notices(context: Context) {
  switch (connection.state) {
    case "needsAccess":
    case "waiting":
      return <Fragment>
        <Notice>
          {"This Microsoft 365 connection hasn't been allowed to open SharePoint and OneDrive yet. " +
            "Allow it, then choose what to connect."}
        </Notice>
        <div>
          <Button variant="primary" disabled={connection.state === "waiting"} onClick={() => void allowAccess(context)}>
            {connection.state === "waiting" ? "Waiting for the pop-up…" : "Allow access"}
          </Button>
        </div>
      </Fragment>;
    case "unavailable":
    case "failed":
      return <Fragment>
        <Notice tone="error">{connection.message}</Notice>
        {connection.state === "failed" ? <div>
          <Button variant="secondary" onClick={() => {
            asked = false;
            connection = { state: "loading" };
            loadStatus(context);
            rerender();
          }}>Try again</Button>
        </div> : null}
      </Fragment>;
    default:
      return null;
  }
}

export default {
  initial: { ref: "all" },

  isReady({ values }) {
    return Boolean(values.ref) && connection.state === "ready";
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const located = await ui.locate(resourceUrl);
    if (located === null) {
      // Not a fallback to "all": that would bind everything with one click, in place of what was asked for.
      missing = resourceUrl;
      return { ref: null };
    }
    return {
      ref: located.ref,
      title: located.title,
      location: located.ref === "all" ? null : JSON.stringify({ tab: located.tab, path: located.path }),
    };
  },

  resourceUrl({ values, ui }) {
    if (!values.ref) throw new Error("Choose what to connect.");
    return ui.resourceUrlFor(values.ref);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    // Until the connection can open SharePoint there is nothing to browse: the notice stands alone.
    if (connection.state === "needsAccess" || connection.state === "waiting" || connection.state === "unavailable") {
      return <Section>{notices(context)}</Section>;
    }
    return <Section>
      <style>{STYLE}</style>
      {missing !== null && !context.values.ref
        ? <Notice>{`Couldn't find ${missing} in SharePoint. Choose what to connect.`}</Notice>
        : null}
      <Field
        label={FIELD_LABEL}
        description="Choose everything, or open a site or your OneDrive to choose one part of it. It never includes more than you can open yourself."
      >
        {browser(context)}
      </Field>
      {/* Outside the picker, and kept across renders: a live region that arrives with its text may not be read out. */}
      <div className="visually-hidden" role="status" aria-live="polite" id="sp-announcer">{announced}</div>
      {notices(context)}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
