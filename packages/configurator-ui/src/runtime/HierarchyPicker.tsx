import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { cn } from "@cloudflare/kumo/utils";
import { CaretRightIcon, FileIcon, FolderIcon } from "@phosphor-icons/react";
import { isValidElement, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  ConfiguratorUIHierarchyAncestor,
  ConfiguratorUIHierarchyChoice,
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyRequest,
  HierarchyPickerProps,
} from "../index.ts";
import { FilterInput } from "./FilterInput.tsx";
import { displayText, failureMessage, identifier, MAX_OPTIONS, SEARCH_DEBOUNCE_MS } from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";
import { useCollectionHold } from "./storeContext.ts";

type Item = ConfiguratorUIHierarchyItem;
type Ancestor = ConfiguratorUIHierarchyAncestor;

/**
 * The open location: the containers opened below the root, outermost first, or none for the root.
 * `detached` when the first of them is not known to be a direct child of the root -- a search result
 * without a `path` -- so the breadcrumb shows a gap rather than claim it is one.
 */
type Location = { trail: Ancestor[]; detached: boolean };

type Page = { items: Item[]; nextCursor: string | null };

/** What `loadItems` returned for one location and query, page after page. */
type Listing = Page & {
  parentId: string;
  query: string;
  status: "ready" | "failed";
  message?: string;
  loadingMore: boolean;
  moreMessage?: string;
};

const AT_ROOT: Location = { trail: [], detached: false };

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

const sanitizeItem = (value: unknown): Item | undefined => {
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
  const { items, nextCursor, unavailable } =
    (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
  const reason = displayText(unavailable);
  if (reason) throw new Unavailable(reason);
  const listed: unknown[] = Array.isArray(items) ? items : [];
  if (listed.length > MAX_OPTIONS) {
    throw new Error(`The list returned more than ${MAX_OPTIONS} items in one page.`);
  }
  return { items: listed.flatMap(item => sanitizeItem(item) ?? []), nextCursor: identifier(nextCursor) ?? null };
};

const requestPage = (
  loadItems: HierarchyPickerProps["loadItems"],
  request: ConfiguratorUIHierarchyRequest,
): Promise<Page> => Promise.resolve().then(() => loadItems(request)).then(sanitizePage);

const reportLoadFailure = (error: unknown) => {
  if (!(error instanceof Unavailable)) reportFrontendIssue("configurator.hierarchy-load", error);
};

/** `incoming` after `existing`, skipping ids already listed, which would collide as row keys. */
const appendUnique = (existing: readonly Item[], incoming: readonly Item[]): Item[] => {
  const seen = new Set(existing.map(item => item.id));
  return [...existing, ...incoming.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })];
};

const asContainer = ({ id, title, icon, choice }: Ancestor): Item =>
  ({ id, title, icon, choice, kind: "container", selectable: true });

const asAncestor = ({ id, title, selectable, icon, choice }: Item): Ancestor => ({ id, title, selectable, icon, choice });

/** A search result's line: where it lives, then its own, so results of one name can be told apart. */
const searchSubtitle = ({ path, subtitle }: Item): string | undefined =>
  [path?.map(ancestor => ancestor.title).join(" / "), subtitle].filter(Boolean).join(" · ") || undefined;

/** Where a node found without browsing to it (a search result, a pre-filled value) lives. */
const locationOf = (item: Item): Location => item.kind === "container"
  ? { trail: [...item.path ?? [], asAncestor(item)], detached: !item.path }
  : { trail: item.path ?? [], detached: false };

type ChoiceBodyProps = { mark: "checked" | "unchecked" | "none"; icon: ReactNode; title: string; subtitle?: string };

/**
 * What the root's card and every row show: a radio's look (or room for one, so icons line up), an
 * icon and two lines. The look is only a cue; `aria-selected` or `aria-pressed` says it.
 */
const ChoiceBody = ({ mark, icon, title, subtitle }: ChoiceBodyProps) => (
  <>
    <span
      className={cn("flex size-4 shrink-0 items-center justify-center rounded-full",
        mark === "checked" && "bg-kumo-brand ring ring-kumo-brand",
        mark === "unchecked" && "bg-kumo-base ring ring-kumo-line")}
    >
      {mark === "checked" && <span className="size-2 rounded-full bg-kumo-base" />}
    </span>
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center overflow-hidden text-kumo-subtle [&>svg]:size-5">
      {icon}
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{title}</span>
      {subtitle && <span className="truncate text-xs text-kumo-subtle">{subtitle}</span>}
    </span>
  </>
);

type RowProps = Omit<ChoiceBodyProps, "mark"> & {
  /** What activating the row does; `none` for a node that can be neither chosen nor opened. */
  action: "choose" | "open" | "none";
  selected: boolean;
  disabled: boolean;
  /** Whether the list's single tab stop is on this row. */
  tabbable: boolean;
  onFocus(): void;
  onActivate(): void;
};

/** One option of the list. Moving between rows is the list's job; activating one is the row's. */
const Row = ({ action, selected, disabled, tabbable, onFocus, onActivate, ...body }: RowProps) => {
  const inert = disabled || action === "none";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const activates = event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && action === "open");
    if (inert || !activates) return;
    event.preventDefault();
    onActivate();
  };
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={inert || undefined}
      tabIndex={!disabled && tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={inert ? undefined : onActivate}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none",
        "focus-visible:ring-2 focus-visible:ring-kumo-focus",
        inert ? "cursor-default" : "cursor-pointer hover:bg-kumo-tint",
        action === "none" && "text-kumo-inactive",
        selected && "bg-kumo-tint text-kumo-strong",
      )}
    >
      <ChoiceBody {...body} mark={selected ? "checked" : action === "choose" ? "unchecked" : "none"} />
      {action === "open" && <CaretRightIcon aria-hidden="true" size={16} className="shrink-0 text-kumo-subtle" />}
    </div>
  );
};

/**
 * Drill-down navigator choosing one node of a hierarchy: the root, a container or a leaf. Renders
 * inline rather than in a popup, which the frame would clip. The root is chosen from its card, an
 * open container from the row its listing starts with and a leaf from its own row. As in a file
 * dialog, a choice lasts while it is in view: moving elsewhere or searching lets go of it, except
 * the root's, whose card is always in view.
 *
 * Where it has navigated describes one root, so a new root starts it afresh. A value nothing on
 * screen shows as chosen, pre-filled or set by the module later, is looked up and opened where it
 * lives. Any other change leaves the picker where the user took it: a pick the module takes at once
 * or after awaiting something, one it declines, or a choice it lets go of.
 */
export const HierarchyPicker = (props: HierarchyPickerProps) =>
  <Navigator key={`${props.name}\n${props.root.id}`} {...props} />;

const Navigator = (props: HierarchyPickerProps) => {
  const { name, value = null, root, icons, searchPlaceholder, disabled = false } = props;

  // A module's render builds its callbacks afresh on every render, and a new identity must not
  // restart a load.
  const loadItem = useEffectEvent((id: string) => props.loadItem?.(id) ?? null);
  const loadItems = useEffectEvent(props.loadItems);
  const dropPrefill = useEffectEvent(() => props.onChange(null, null));

  // The value the last render saw, so a change to it is acted on once. Null at first, so a pre-filled
  // value is a change like any other.
  const [seenValue, setSeenValue] = useState<string | null>(null);
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);
  const [location, setLocation] = useState<Location>(AT_ROOT);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  // A pre-filled leaf, which its parent's listing may not show: on a later page, or with no path.
  const [prefilledLeaf, setPrefilledLeaf] = useState<Item | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  // Where focus goes once that location's listing is shown (the row named, or else the first),
  // after the control that had it went away with what it did.
  const focusTarget = useRef<{ location: string; row: string | null } | null>(null);
  // Set when Shift+Tab leaves the search box, whose focus hid the breadcrumb it should reach.
  const focusCrumb = useRef(false);
  // Bumped whenever the listing a response would update is replaced, so a late page is dropped.
  const generation = useRef(0);

  const forgetPrefill = () => {
    setPendingPrefill(null);
    setPrefilledLeaf(null);
  };
  const clearSearch = () => {
    setText("");
    setQuery("");
  };

  const prefilling = pendingPrefill !== null;
  const current = location.trail.at(-1);
  const locationId = current?.id ?? root.id;
  const locationTitle = current?.title ?? root.title;

  useEffect(() => {
    if (pendingPrefill === null) return;
    /** Shows `item` where it lives, or, with none to show as that choice, leaves nothing chosen. */
    const settle = (item?: Item) => {
      if (item) {
        setLocation(locationOf(item));
        if (item.kind === "leaf") setPrefilledLeaf(item);
      } else dropPrefill();
      setPendingPrefill(null);
    };
    // An unselectable root is no choice the picker can show, and no node `loadItem` knows.
    if (pendingPrefill === root.id) {
      settle();
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => loadItem(pendingPrefill))
      .then(sanitizeItem)
      .then(item => {
        if (!cancelled) settle(item?.selectable && item.id === pendingPrefill ? item : undefined);
      }, error => {
        if (cancelled) return;
        reportFrontendIssue("configurator.hierarchy-item-load", error);
        settle();
      });
    return () => {
      cancelled = true;
    };
  }, [pendingPrefill]);

  useEffect(() => {
    if (prefilling) return;
    const token = generation.current;
    requestPage(loadItems, { parentId: locationId, query, cursor: null }).then(page => {
      if (generation.current !== token) return;
      setListing({ parentId: locationId, query, items: appendUnique([], page.items),
        nextCursor: page.nextCursor, status: "ready", loadingMore: false });
    }, error => {
      if (generation.current !== token) return;
      reportLoadFailure(error);
      setListing({ parentId: locationId, query, items: [], nextCursor: null, status: "failed",
        message: failureMessage(error, "Could not load items."), loadingMore: false });
    });
    return () => {
      generation.current += 1;
    };
  }, [locationId, query, attempt, prefilling]);

  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, query]);

  const fresh = !prefilling && listing?.parentId === locationId && listing.query === query
    ? listing : null;
  const status = fresh?.status ?? "loading";
  // A listing naming the open container or the root among its own nodes would show one choice twice.
  const shows = (item: Item) => item.id !== locationId && item.id !== root.id;
  const items = (fresh?.items ?? []).filter(shows);
  // The open container, offered as a choice of its own. Not under a search, whose results are not
  // its contents.
  const scope = current && current.selectable !== false && !query ? asContainer(current) : null;
  // A pre-filled leaf its folder's listing does not show (on a later page, or found without a path)
  // comes first until the listing does, so the choice is in view, and stays while the user is here.
  const pinned = status === "ready" && !query && prefilledLeaf
    && !items.some(item => item.id === prefilledLeaf.id) ? prefilledLeaf : null;
  const rows = pinned ? [pinned, ...items] : items;
  const rowIds = [...scope ? [scope.id] : [], ...rows.map(row => row.id)];
  // Compact beside the breadcrumb until used; then it takes the breadcrumb's place, since what it
  // finds is not in the open location.
  const searchOpen = searchFocused || text !== "";
  const focusId = activeId !== null && rowIds.includes(activeId) ? activeId : rowIds[0];
  const rootChosen = root.selectable === true && value === root.id;
  // Rows about to give way to the search being typed are no longer in view; the root's card is.
  const settled = text.trim() === query;
  // A choice is on screen on the root's card, the open container's own row, or the row of a leaf
  // that can be chosen. A container's row in a listing opens it, so its choice is the row it opens to.
  const showsChoice = (item: Item) => item.kind === "leaf" && item.selectable === true && item.id === value;
  const choiceShown = value !== null
    && (rootChosen || settled && (value === scope?.id || rows.some(showsChoice)));
  if (value !== seenValue) {
    setSeenValue(value);
    if (value !== null && !choiceShown) {
      setPendingPrefill(value);
      setPrefilledLeaf(null);
      clearSearch();
    } else setPendingPrefill(null);
  }
  // A value nothing on screen shows as chosen (a pre-fill still being looked up, or found in a folder
  // that is still listing or failed to) is held back from collection.
  useCollectionHold(name, value !== null && !choiceShown ? "Configurator is not showing its choice." : null);

  // Moves focus to `focusTarget` once its listing is shown, holding it on the list while it loads.
  // Only focus the picker lost, to the page or within its list and footer, is moved: a user who went
  // elsewhere meanwhile, in the frame or out of it, stays there. A frame the user left can still
  // report its focus on the page, so `hasFocus` tells the two apart. A layout effect, so it runs
  // before the form's fallback for lost focus (`useKeepFocusInForm`, in a parent), which would
  // otherwise take it first.
  useLayoutEffect(() => {
    const target = focusTarget.current;
    const list = listRef.current;
    if (!list || !target || target.location !== locationId) return;
    const active = document.activeElement;
    const elsewhere = active && active !== document.body && !list.contains(active)
      && !footerRef.current?.contains(active);
    if (elsewhere || !document.hasFocus()) {
      focusTarget.current = null;
      return;
    }
    if (status === "loading") {
      if (!list.contains(active)) list.focus();
      return;
    }
    focusTarget.current = null;
    const index = target.row === null ? 0 : Math.max(0, rowIds.indexOf(target.row));
    (list.querySelectorAll<HTMLElement>('[role="option"]')[index] ?? list).focus();
  });

  useEffect(() => {
    const crumb = crumbsRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!focusCrumb.current || !crumb) return;
    focusCrumb.current = false;
    crumb.focus();
  });

  /** As in a file dialog, a choice lasts while it is in view, and only the root's card always is. */
  const leaveView = () => {
    if (value !== null && !rootChosen) props.onChange(null, null);
  };

  const select = (item: Item) => {
    if (disabled || item.id === value || (item.id !== root.id && !settled)) return;
    setPendingPrefill(null);
    props.onChange(item.id, item);
  };

  const navigate = (next: Location, fromList: boolean) => {
    if (disabled) return;
    leaveView();
    forgetPrefill();
    setLocation(next);
    clearSearch();
    // The row that started it goes with the listing it was in.
    focusTarget.current = fromList ? { location: next.trail.at(-1)?.id ?? root.id, row: null } : null;
  };

  /** Opens the root (depth 0) or the trail's container at that depth; the open one stays as it is. */
  const goTo = (depth: number, fromList: boolean) => {
    if (depth === location.trail.length) return;
    navigate({ trail: location.trail.slice(0, depth), detached: depth > 0 && location.detached }, fromList);
  };

  const openContainer = (item: Item) => navigate(
    query
      ? locationOf(item)
      : { trail: [...location.trail, asAncestor(item)], detached: location.detached },
    true);

  const retry = () => {
    focusTarget.current = { location: locationId, row: null };
    setListing(null);
    setAttempt(count => count + 1);
  };

  const loadMore = () => {
    if (!fresh?.nextCursor || fresh.loadingMore || disabled) return;
    const { parentId, query: listedQuery, nextCursor } = fresh;
    const token = generation.current;
    setListing({ ...fresh, loadingMore: true, moreMessage: undefined });
    requestPage(props.loadItems, { parentId, query: listedQuery, cursor: nextCursor }).then(page => {
      if (generation.current !== token) return;
      // From the button, focus moves to the first row it brought; when the last page takes the
      // button and brought none, to the row the button followed.
      const listed = new Set(fresh.items.map(item => item.id));
      const added = page.items.find(item => shows(item) && !listed.has(item.id));
      if ((added || !page.nextCursor) && footerRef.current?.contains(document.activeElement)) {
        focusTarget.current = { location: parentId, row: added?.id ?? rowIds.at(-1) ?? null };
      }
      setListing(shown => shown && { ...shown, items: appendUnique(shown.items, page.items),
        nextCursor: page.nextCursor, loadingMore: false });
    }, error => {
      if (generation.current !== token) return;
      reportLoadFailure(error);
      setListing(shown => shown && { ...shown, loadingMore: false,
        moreMessage: failureMessage(error, "Could not load more items.") });
    });
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rows = [...listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []];
    const index = rows.indexOf(event.target as HTMLElement);
    const focusRow = (target: number) => rows[Math.max(0, Math.min(target, rows.length - 1))]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusRow(index + 1);
        break;
      case "ArrowUp":
        focusRow(index - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowLeft":
      case "Backspace":
        if (location.trail.length === 0) return;
        goTo(location.trail.length - 1, true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const search = (next: string) => {
    setText(next);
    forgetPrefill();
    leaveView();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && event.shiftKey && !text) {
      event.preventDefault();
      focusCrumb.current = true;
      setSearchFocused(false);
      return;
    }
    if (event.key !== "Escape" || !text) return;
    event.preventDefault();
    search("");
    setQuery("");
  };

  const iconFor = (icon: string | undefined, kind: Item["kind"]): ReactNode => {
    const custom = icon && icons && Object.hasOwn(icons, icon) ? icons[icon] : undefined;
    if (isValidElement(custom)) return custom;
    return kind === "container" ? <FolderIcon size={20} /> : <FileIcon size={20} />;
  };

  const crumb = (title: string, depth: number) => {
    const isCurrent = depth === location.trail.length;
    return (
      <Button
        variant="ghost"
        size="xs"
        className={cn("max-w-48 truncate", isCurrent && "text-kumo-strong")}
        aria-current={isCurrent ? "location" : undefined}
        disabled={disabled}
        onClick={() => goTo(depth, false)}
      >
        {title}
      </Button>
    );
  };
  const separator = <CaretRightIcon aria-hidden="true" size={12} className="shrink-0 text-kumo-subtle" />;

  let announcement: ReactNode;
  if (status === "loading") announcement = "Loading…";
  else if (status === "failed") announcement = fresh?.message;
  else if (rows.length === 0) announcement = query ? `No results for "${query}".` : "Nothing here.";
  else {
    announcement = (
      <>
        <span className="sr-only">
          {`${rows.length} ${query ? "result" : "item"}${rows.length === 1 ? "" : "s"}`}
        </span>
        {fresh?.moreMessage && <>{" "}<span className="text-kumo-danger">{fresh.moreMessage}</span></>}
      </>
    );
  }

  return (
    <div
      data-name={name}
      aria-disabled={disabled || undefined}
      className={cn("flex flex-col overflow-hidden rounded-lg border border-kumo-line bg-kumo-base",
        disabled && "opacity-60")}
    >
      {root.selectable === true && (
        <div className="border-b border-kumo-line p-2">
          <button
            type="button"
            aria-pressed={rootChosen}
            disabled={disabled}
            onClick={() => select(asContainer(root))}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm outline-none",
              "focus-visible:ring-2 focus-visible:ring-kumo-focus",
              rootChosen ? "border-kumo-brand bg-kumo-tint text-kumo-strong" : "border-kumo-hairline",
              !disabled && "cursor-pointer hover:bg-kumo-tint",
            )}
          >
            <ChoiceBody
              mark={rootChosen ? "checked" : "unchecked"}
              icon={iconFor(root.icon, "container")}
              title={`All of ${root.title}`}
              subtitle={root.subtitle}
            />
          </button>
        </div>
      )}
      <div className="flex min-h-11 items-center gap-2 border-b border-kumo-line p-2">
        {!searchOpen && (
          <nav ref={crumbsRef} aria-label="Location" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm">
            {crumb(root.title, 0)}
            {location.detached && location.trail.length > 0 && (
              <>
                {separator}
                <span className="px-1 text-kumo-subtle">…</span>
              </>
            )}
            {location.trail.map((ancestor, index) => (
              <span key={ancestor.id} className="contents">
                {separator}
                {crumb(ancestor.title, index + 1)}
              </span>
            ))}
          </nav>
        )}
        {searchPlaceholder && (
          <div
            className={cn("ml-auto shrink-0 transition-[width] duration-150", searchOpen ? "w-full" : "w-40")}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          >
            <FilterInput
              label={searchPlaceholder}
              placeholder={searchOpen ? searchPlaceholder : "Search"}
              value={text}
              disabled={disabled}
              onChange={search}
              onKeyDown={onSearchKeyDown}
            />
          </div>
        )}
      </div>
      {/* One fixed height, so neither a navigation nor the listing it loads moves the form. */}
      <div className={cn("h-80 overflow-y-auto p-1", status === "loading" && "flex flex-col")}>
        <div
          ref={listRef}
          role="listbox"
          aria-label={query ? "Search results" : locationTitle}
          aria-busy={status === "loading" || fresh?.loadingMore || undefined}
          aria-disabled={disabled || undefined}
          tabIndex={rowIds.length === 0 && !disabled ? 0 : -1}
          onKeyDown={onListKeyDown}
          className="flex flex-col rounded-md outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
        >
          {/* Keyed by location, so focus on it does not carry over to the next location's row. Set
              apart from the contents, since choosing it takes all of them. */}
          {scope && (
            <>
              <Row
                key={scope.id}
                title={scope.choice?.title ?? `Everything in ${scope.title}`}
                subtitle={scope.choice?.subtitle}
                icon={iconFor(scope.icon, "container")}
                action="choose"
                selected={value === scope.id}
                disabled={disabled}
                tabbable={focusId === scope.id}
                onFocus={() => setActiveId(scope.id)}
                onActivate={() => select(scope)}
              />
              <div aria-hidden="true" className="mx-2 my-1 border-t border-kumo-line" />
            </>
          )}
          {rows.map(item => (
            <Row
              key={item.id}
              title={item.title}
              subtitle={query ? searchSubtitle(item) : item.subtitle}
              icon={iconFor(item.icon, item.kind)}
              action={item.kind === "container" ? "open" : item.selectable ? "choose" : "none"}
              selected={showsChoice(item)}
              disabled={disabled}
              tabbable={focusId === item.id}
              onFocus={() => setActiveId(item.id)}
              onActivate={() => item.kind === "container" ? openContainer(item) : select(item)}
            />
          ))}
        </div>
        <div ref={footerRef} className={cn("flex flex-wrap items-center gap-2 px-2 py-1 text-sm text-kumo-subtle empty:hidden",
          status === "loading" && "m-auto")}>
          {status === "loading" && <span aria-hidden="true"><Loader size="sm" /></span>}
          <div role="status" aria-live="polite" className={cn(status === "failed" && "text-kumo-danger")}>
            {announcement}
          </div>
          {status === "failed" && (
            <Button size="xs" disabled={disabled} onClick={retry}>Retry</Button>
          )}
          {status === "ready" && fresh?.nextCursor && (
            // Not Kumo's `loading`, which disables the button and so drops its focus.
            <Button size="xs" disabled={disabled} onClick={loadMore}>Load more</Button>
          )}
          {fresh?.loadingMore && <span aria-hidden="true"><Loader size="sm" /></span>}
        </div>
      </div>
    </div>
  );
};
