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

/** A path whose every ancestor is valid, or none: a partial path would misstate where a node is. */
const sanitizePath = (value: unknown): Ancestor[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const path: Ancestor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const raw = entry as Record<string, unknown>;
    const id = identifier(raw.id);
    const title = displayText(raw.title);
    if (!id || !title) return undefined;
    path.push({
      id,
      title,
      selectable: typeof raw.selectable === "boolean" ? raw.selectable : undefined,
      icon: typeof raw.icon === "string" ? raw.icon : undefined,
      choice: sanitizeChoice(raw.choice),
    });
  }
  return path;
};

export const sanitizeItem = (value: unknown): Item | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = identifier(raw.id);
  const title = displayText(raw.title);
  if (!id || !title || (raw.kind !== "container" && raw.kind !== "leaf")) return undefined;
  return {
    id,
    title,
    kind: raw.kind,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    subtitle: displayText(raw.subtitle),
    selectable: raw.selectable !== false,
    choice: sanitizeChoice(raw.choice),
    path: sanitizePath(raw.path),
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

export const asAncestor = ({ id, title, selectable, icon, choice }: Item): Ancestor => ({ id, title, selectable, icon, choice });

/** A search result's line: where it lives, then its own, so results of one name can be told apart. */
export const searchSubtitle = ({ path, subtitle }: Item): string | undefined =>
  [path?.map(ancestor => ancestor.title).join(" / "), subtitle].filter(Boolean).join(" · ") || undefined;

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
  const trail = item.kind === "container" ? [...path, asAncestor(item)] : path;
  return tabs.length > 0
    ? { tab: tab?.id ?? openTab, trail, detached: !tab && trail.length > 0 }
    : { tab: null, trail, detached: item.kind === "container" && !item.path };
};

