import type {
  ConfiguratorUIHierarchyAncestor,
  ConfiguratorUIHierarchyChoice,
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyRequest,
  ConfiguratorUIHierarchyTab,
  HierarchyPickerProps,
} from "../index.ts";
import { displayText, identifier, MAX_OPTIONS } from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";

type Item = ConfiguratorUIHierarchyItem;
type Ancestor = ConfiguratorUIHierarchyAncestor;
type Tab = ConfiguratorUIHierarchyTab;

/**
 * The open location: the open tab (none without tabs) and the containers opened below it or the
 * root, outermost first. `detached` when the first of them is not known to be a direct child of
 * the tab or root -- a search result without a `path` that says so -- so the breadcrumb shows a gap
 * rather than claim it is one.
 */
export type Location = { tab: string | null; trail: Ancestor[]; detached: boolean };

export type Page = { items: Item[]; nextCursor: string | null; notice?: string };

const sanitizeChoice = (value: unknown): ConfiguratorUIHierarchyChoice | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const { title, subtitle } = value as Record<string, unknown>;
  return { title: displayText(title), subtitle: displayText(subtitle) };
};

/** What a node shares with its ancestors, or nothing without an id and a title. */
const sanitizeAncestor = (value: unknown): Ancestor | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = identifier(raw.id);
  const title = displayText(raw.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    selectable: typeof raw.selectable === "boolean" ? raw.selectable : undefined,
    unselectableReason: displayText(raw.unselectableReason),
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    choice: sanitizeChoice(raw.choice),
  };
};

/** A tab as shown. Unlike a container, it is offered as a choice only when it says so. */
export const sanitizeTab = (value: unknown) => {
  const tab = sanitizeAncestor(value);
  return tab && { ...tab, selectable: tab.selectable === true };
};

/** A path whose every ancestor is valid, or none: a partial path would misstate where a node is. */
const sanitizePath = (value: unknown): Ancestor[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const path = value.map(sanitizeAncestor);
  return path.every(ancestor => ancestor !== undefined) ? path : undefined;
};

export const sanitizeItem = (value: unknown): Item | undefined => {
  const ancestor = sanitizeAncestor(value);
  if (!ancestor) return undefined;
  const { kind, subtitle, badge, meta, path } = value as Record<string, unknown>;
  if (kind !== "container" && kind !== "leaf") return undefined;
  return {
    ...ancestor,
    kind,
    selectable: ancestor.selectable !== false,
    subtitle: displayText(subtitle),
    badge: displayText(badge),
    meta: displayText(meta),
    path: sanitizePath(path),
  };
};

/** A page saying its location cannot be listed yet: shown as a failed load is, but expected. */
class Unavailable extends Error {}

/** One page, refused whole rather than truncated when it is too long to show. */
const sanitizePage = (page: unknown): Page => {
  const { items, nextCursor, unavailable, notice } =
    (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
  const reason = displayText(unavailable);
  if (reason) throw new Unavailable(reason);
  const listed: unknown[] = Array.isArray(items) ? items : [];
  if (listed.length > MAX_OPTIONS) {
    throw new Error(`The list returned more than ${MAX_OPTIONS} items in one page.`);
  }
  return {
    items: listed.flatMap(item => sanitizeItem(item) ?? []),
    nextCursor: identifier(nextCursor) ?? null,
    notice: displayText(notice),
  };
};

export const requestPage = (
  loadItems: HierarchyPickerProps["loadItems"],
  request: ConfiguratorUIHierarchyRequest,
): Promise<Page> => Promise.resolve().then(() => loadItems(request)).then(sanitizePage);

export const reportLoadFailure = (error: unknown) => {
  if (!(error instanceof Unavailable)) reportFrontendIssue("configurator.hierarchy-load", error);
};

/** `incoming` after `existing`, skipping ids already listed, which would collide as row keys. */
export const appendUnique = (existing: readonly Item[], incoming: readonly Item[]): Item[] => {
  const seen = new Set(existing.map(item => item.id));
  return [...existing, ...incoming.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })];
};

export const asContainer = ({ id, title, icon, choice }: Ancestor): Item =>
  ({ id, title, icon, choice, kind: "container", selectable: true });

/** The id whose nodes `location` lists: its innermost container's, else its tab's, else the root's. */
export const locationIdOf = ({ tab, trail }: Location, rootId: string) => trail.at(-1)?.id ?? tab ?? rootId;

/**
 * A row's line: why a leaf cannot be chosen, else its subtitle. Under a search, where it lives comes
 * first, so results of one name can be told apart.
 */
export const rowSubtitle = (item: Item, searching: boolean): string | undefined => {
  const own = item.kind === "leaf" && !item.selectable ? item.unselectableReason ?? item.subtitle : item.subtitle;
  if (!searching) return own;
  return [item.path?.map(({ title }) => title).join(" / "), own].filter(Boolean).join(" · ") || undefined;
};

const EXTENSION = /\.[^.\s]{1,7}$/u;
// Missing before Firefox 125, where titles truncate whole rather than fail every configurator.
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : undefined;

/**
 * A title split where its end, kept in view as the rest truncates, starts: its extension and up to
 * 3 characters before it, counted as the user sees them, so an accent or an emoji is not cut from
 * its letter. A space before that end goes with it, since the end of the truncating part drops it.
 * None for a title without an extension or with nothing before that end to give way.
 */
export const splitTitle = (title: string): [head: string, tail: string] | undefined => {
  const extension = EXTENSION.exec(title);
  const start = extension && graphemes && [...graphemes.segment(title.slice(0, extension.index))].at(-3)?.index;
  const head = start ? title.slice(0, start).trimEnd() : "";
  return head ? [head, title.slice(head.length)] : undefined;
};

/**
 * Where a node found without browsing to it (a search result, a pre-filled value) lives. Under tabs,
 * its path names its tab first; one that does not is shown in the open tab, behind a gap above
 * whatever its trail opens. A trail that opens nothing (a leaf with no path, pinned atop the tab's
 * own listing) leaves no gap to show.
 */
export const locationOf = (item: Item, tabs: readonly Tab[], openTab: string | null): Location => {
  if (tabs.some(({ id }) => id === item.id)) return { tab: item.id, trail: [], detached: false };
  const tab = tabs.find(({ id }) => id === item.path?.[0]?.id);
  const path = (tab ? item.path?.slice(1) : item.path) ?? [];
  const trail = item.kind === "container" ? [...path, item] : path;
  const anchored = tabs.length > 0 ? tab !== undefined : item.path !== undefined;
  return { tab: tab?.id ?? openTab, trail, detached: !anchored && trail.length > 0 };
};

