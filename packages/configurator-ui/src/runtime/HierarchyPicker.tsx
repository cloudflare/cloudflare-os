import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { cn } from "@cloudflare/kumo/utils";
import { FileIcon, FolderIcon, InfoIcon } from "@phosphor-icons/react";
import { isValidElement, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ConfiguratorUIHierarchyAncestor, ConfiguratorUIHierarchyItem, HierarchyPickerProps } from "../index.ts";
import { FilterInput } from "./FilterInput.tsx";
import { Breadcrumb } from "./HierarchyBreadcrumb.tsx";
import {
  appendUnique, asAncestor, asContainer, locationOf, reportLoadFailure, requestPage, sanitizeItem, searchSubtitle,
  type Location, type Page,
} from "./hierarchyNodes.ts";
import { ChoiceBody, Row } from "./HierarchyRow.tsx";
import { failureMessage, SEARCH_DEBOUNCE_MS } from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";
import { useCollectionHold } from "./storeContext.ts";

type Item = ConfiguratorUIHierarchyItem;
type Ancestor = ConfiguratorUIHierarchyAncestor;

/** What `loadItems` returned for one location and query, page after page. */
type Listing = Page & {
  parentId: string;
  query: string;
  status: "ready" | "failed";
  message?: string;
  loadingMore: boolean;
  moreMessage?: string;
};

/**
 * Drill-down navigator choosing one node of a hierarchy: the root, a container or a leaf. Renders
 * inline rather than in a popup, which the frame would clip. The root is chosen from its card, an
 * open container from the row its listing starts with and a leaf from its own row. As in a file
 * dialog, a choice lasts while it is in view: moving elsewhere or searching lets go of it, except
 * the root's, whose card is always in view.
 *
 * Where it has navigated describes one root and its tabs, so a new root or set of tabs starts it
 * afresh. A value nothing on screen shows as chosen, pre-filled or set by the module later, is
 * looked up and opened where it lives. Any other change leaves the picker where the user took it: a
 * pick the module takes at once or after awaiting something, one it declines, or a choice it lets
 * go of.
 */
export const HierarchyPicker = (props: HierarchyPickerProps) =>
  <Navigator key={[props.name, props.root.id, ...props.tabs?.map(({ id }) => id) ?? []].join("\n")} {...props} />;

const Navigator = (props: HierarchyPickerProps) => {
  const { name, value = null, root, tabs = [], icons, searchPlaceholder, disabled = false } = props;

  // A module's render builds its callbacks afresh on every render, and a new identity must not
  // restart a load.
  const loadItem = useEffectEvent((id: string) => props.loadItem?.(id) ?? null);
  const loadItems = useEffectEvent(props.loadItems);
  const dropPrefill = useEffectEvent(() => props.onChange(null, null));

  // The value the last render saw, so a change to it is acted on once. Null at first, so a pre-filled
  // value is a change like any other.
  const [seenValue, setSeenValue] = useState<string | null>(null);
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);
  const [location, setLocation] = useState<Location>(() => ({ tab: tabs[0]?.id ?? null, trail: [], detached: false }));
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
  const openTab = tabs.find(({ id }) => id === location.tab);
  // A tab is offered as a choice only when it says so, unlike a container.
  const current: Ancestor | undefined = location.trail.at(-1)
    ?? (openTab && { ...openTab, selectable: openTab.selectable === true });
  const locationId = current?.id ?? root.id;
  const locationTitle = current?.title ?? root.title;

  useEffect(() => {
    if (pendingPrefill === null) return;
    /** Shows `item` where it lives, or, with none to show as that choice, leaves nothing chosen. */
    const settle = (item?: Item) => {
      if (item) {
        setLocation(open => locationOf(item, tabs, open.tab));
        if (item.kind === "leaf") setPrefilledLeaf(item);
      } else dropPrefill();
      setPendingPrefill(null);
    };
    // The root and the tabs are known without a lookup. An unselectable root is no choice the picker
    // can show; a tab is shown on the row its listing starts with, when it is offered as a choice.
    const tab = tabs.find(({ id }) => id === pendingPrefill);
    if (pendingPrefill === root.id || tab) {
      settle(tab?.selectable === true ? asContainer(tab) : undefined);
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
      setListing({ ...page, parentId: locationId, query, items: appendUnique([], page.items), status: "ready",
        loadingMore: false });
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
  const hasTabs = tabs.length > 0;
  // Without tabs, the search box sits compact beside the breadcrumb until used, then takes its place;
  // beside tabs, it has room of its own. Either way the breadcrumb gives way to what a search finds,
  // which is not in the open location.
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
    focusTarget.current = fromList ? { location: next.trail.at(-1)?.id ?? next.tab ?? root.id, row: null } : null;
  };

  /** Opens the tab or root (depth 0) or the trail's container at that depth; the open one stays as it is. */
  const goTo = (depth: number, fromList: boolean) => {
    if (depth === location.trail.length) return;
    navigate({ ...location, trail: location.trail.slice(0, depth), detached: depth > 0 && location.detached }, fromList);
  };

  const openContainer = (item: Item) => navigate(
    query
      ? locationOf(item, tabs, location.tab)
      : { ...location, trail: [...location.trail, asAncestor(item)] },
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
        nextCursor: page.nextCursor, notice: page.notice ?? shown.notice, loadingMore: false });
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
    // Without tabs, the breadcrumb comes before the search box, which hid it while focused.
    if (!hasTabs && event.key === "Tab" && event.shiftKey && !text) {
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

  const count = `${rows.length} ${query ? "result" : "item"}${rows.length === 1 ? "" : "s"}`;

  let announcement: ReactNode;
  if (status === "loading") announcement = "Loading…";
  else if (status === "failed") announcement = fresh?.message;
  else {
    // The notice is drawn above the list, so it is only said here.
    const said = [rows.length > 0 && count, fresh?.notice].filter(Boolean).join(". ");
    announcement = (
      <>
        {rows.length === 0 && !fresh?.notice && (query ? `No results for "${query}".` : "Nothing here.")}
        {said && <span className="sr-only">{said}</span>}
        {fresh?.moreMessage && <>{" "}<span className="text-kumo-danger">{fresh.moreMessage}</span></>}
      </>
    );
  }

  // Hidden from assistive technology, which hears it from the status below the list.
  const shownCount = status === "ready" && settled && rows.length > 0 && (
    <span aria-hidden="true" className="shrink-0 px-1 text-xs text-kumo-subtle">{count}</span>
  );

  const breadcrumb = (
    <Breadcrumb
      top={openTab?.title ?? root.title}
      location={location}
      disabled={disabled}
      navRef={crumbsRef}
      onGo={depth => goTo(depth, false)}
    />
  );

  const searchBox = searchPlaceholder && (
    <div
      className={hasTabs
        ? "min-w-40 flex-1"
        : cn("ml-auto shrink-0 transition-[width] duration-150", searchOpen ? "w-full" : "w-40")}
      onFocus={() => setSearchFocused(true)}
      onBlur={() => setSearchFocused(false)}
    >
      <FilterInput
        label={searchPlaceholder}
        placeholder={hasTabs || searchOpen ? searchPlaceholder : "Search"}
        value={text}
        disabled={disabled}
        onChange={search}
        onKeyDown={onSearchKeyDown}
      />
    </div>
  );

  const bar = "flex min-h-11 items-center gap-2 border-b border-kumo-line p-2";

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
      {hasTabs ? (
        <>
          <div className={bar}>
            {/* Kumo's Tabs cannot be disabled; `inert` keeps a disabled picker's out of reach. */}
            <div inert={disabled || undefined} className="min-w-0">
              <Tabs
                variant="segmented"
                size="sm"
                tabs={tabs.map(({ id, title }) => ({ value: id, label: title }))}
                value={location.tab ?? undefined}
                onValueChange={tab => navigate({ tab, trail: [], detached: false }, false)}
              />
            </div>
            {searchBox}
          </div>
          {/* Kept while searching, so the list does not move. */}
          <div className={bar}>
            {text === "" ? breadcrumb : (
              <span aria-hidden="true" className="min-w-0 flex-1 px-1 text-sm text-kumo-subtle">Search results</span>
            )}
            {shownCount}
          </div>
        </>
      ) : (
        <div className={bar}>
          {!searchOpen && <>{breadcrumb}{shownCount}</>}
          {searchBox}
        </div>
      )}
      {/* One fixed height, so neither a navigation nor the listing it loads moves the form. */}
      <div className={cn("h-80 overflow-y-auto p-1", status === "loading" && "flex flex-col")}>
        {fresh?.notice && (
          <p aria-hidden="true" className="flex gap-2 px-2 py-1.5 text-xs text-kumo-subtle">
            <InfoIcon size={14} className="mt-px shrink-0" />
            {fresh.notice}
          </p>
        )}
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
