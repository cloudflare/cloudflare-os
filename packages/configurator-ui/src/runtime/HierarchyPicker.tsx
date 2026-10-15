import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { cn } from "@cloudflare/kumo/utils";
import { CaretRightIcon, CheckIcon, FileIcon, FolderIcon } from "@phosphor-icons/react";
import {
  isValidElement,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ConfiguratorUIHierarchyAncestor,
  ConfiguratorUIHierarchyItem,
  ConfiguratorUIHierarchyRequest,
  HierarchyPickerProps,
} from "../index.ts";
import { FilterInput } from "./FilterInput.tsx";
import { displayText, failureMessage, identifier, MAX_OPTIONS } from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";

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

const SEARCH_DEBOUNCE_MS = 180;
const AT_ROOT: Location = { trail: [], detached: false };

/** A path whose every ancestor is valid, or none: a partial path would misstate where a node is. */
const sanitizePath = (value: unknown): Ancestor[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const path: Ancestor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const { id: rawId, title: rawTitle, selectable } = entry as Record<string, unknown>;
    const id = identifier(rawId);
    const title = displayText(rawTitle);
    if (!id || !title) return undefined;
    path.push(typeof selectable === "boolean" ? { id, title, selectable } : { id, title });
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
    meta: displayText(raw.meta),
    selectable: raw.selectable !== false,
    path: sanitizePath(raw.path),
  };
};

/** One page, refused whole rather than truncated when it is too long to show. */
const sanitizePage = (page: unknown): Page => {
  const { items, nextCursor } = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
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

/** `incoming` after `existing`, skipping ids already listed, which would collide as row keys. */
const appendUnique = (existing: readonly Item[], incoming: readonly Item[]): Item[] => {
  const seen = new Set(existing.map(item => item.id));
  return [...existing, ...incoming.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })];
};

const asContainer = ({ id, title }: Ancestor): Item => ({ id, title, kind: "container", selectable: true });

const asAncestor = ({ id, title, selectable }: Item): Ancestor => ({ id, title, selectable });

/** Where a node found without browsing to it (a search result, a pre-filled value) lives. */
const locationOf = (item: Item): Location => item.kind === "container"
  ? { trail: [...item.path ?? [], asAncestor(item)], detached: !item.path }
  : { trail: item.path ?? [], detached: false };

/**
 * Drill-down navigator choosing one node of a hierarchy: the root, a container or a leaf. Renders
 * inline rather than in a popup, which the frame would clip. Only the user's own moves call
 * `onChange`; pre-fill, loading and search only change what is shown.
 *
 * Where it has navigated, and what opening there selected, describe one root and the selections the
 * user made, so a new root or a value the module set starts it afresh, pre-filling that value.
 */
export const HierarchyPicker = (props: HierarchyPickerProps) => {
  const value = props.value ?? null;
  const [own, setOwn] = useState({ value, generation: 0 });
  if (value !== own.value) setOwn({ value, generation: own.generation + 1 });
  const onChange: HierarchyPickerProps["onChange"] = (next, item) => {
    setOwn(current => ({ ...current, value: next }));
    props.onChange(next, item);
  };
  return <Navigator key={`${props.name}\n${props.root.id}\n${own.generation}`} {...props} onChange={onChange} />;
};

const Navigator = (props: HierarchyPickerProps) => {
  const { name, value = null, root, icons, searchPlaceholder, metaLabel, disabled = false } = props;

  // A module's render builds its callbacks afresh on every render, and a new identity must not
  // restart a load.
  const loadItem = useEffectEvent((id: string) => props.loadItem?.(id) ?? null);
  const loadItems = useEffectEvent(props.loadItems);

  const [pendingPrefill, setPendingPrefill] = useState(
    () => value && value !== root.id && props.loadItem ? value : null);
  const [location, setLocation] = useState<Location>(AT_ROOT);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Item | null>(null);
  // What opening the location selected: itself, or nothing. Choosing the selected leaf again returns
  // to it, so unchoosing never selects more than the user had.
  const [openedWith, setOpenedWith] = useState<Item | null>(
    () => value === root.id ? asContainer(root) : null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusFirstRow = useRef(false);
  // Bumped whenever the listing a response would update is replaced, so a late page is dropped.
  const generation = useRef(0);

  const prefilling = pendingPrefill !== null;
  const current = location.trail.at(-1);
  const locationId = current?.id ?? root.id;
  const locationTitle = current?.title ?? root.title;

  useEffect(() => {
    if (pendingPrefill === null) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadItem(pendingPrefill))
      .then(sanitizeItem)
      .then(item => {
        if (cancelled) return;
        if (item) {
          setChosen(item);
          setLocation(locationOf(item));
          setOpenedWith(item.kind === "container" ? item : null);
        }
        setPendingPrefill(null);
      }, error => {
        if (cancelled) return;
        reportFrontendIssue("configurator.hierarchy-item-load", error);
        setPendingPrefill(null);
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
      reportFrontendIssue("configurator.hierarchy-load", error);
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
  const items = fresh?.items ?? [];
  const activeIndex = Math.max(0, items.findIndex(item => item.id === activeId));

  // Once a navigation started from the list has a listing, focus lands on its first row; until
  // then it waits on the list itself, since the row that started it is gone.
  useEffect(() => {
    const list = listRef.current;
    if (!focusFirstRow.current || !list) return;
    if (status === "loading") {
      if (!list.contains(document.activeElement)) list.focus();
      return;
    }
    focusFirstRow.current = false;
    (list.querySelector<HTMLElement>('[role="option"]') ?? list).focus();
  });

  const select = (item: Item | null) => {
    if (disabled) return;
    setChosen(item);
    props.onChange(item?.id ?? null, item);
  };

  const navigate = (next: Location, selection: Item | null, fromList: boolean) => {
    if (disabled) return;
    setPendingPrefill(null);
    setLocation(next);
    setText("");
    setQuery("");
    focusFirstRow.current = fromList;
    setOpenedWith(selection);
    select(selection);
  };

  /** Opens the root (depth 0) or the trail's container at that depth, selecting it if it can be. */
  const goTo = (depth: number, fromList: boolean) => {
    const trail = location.trail.slice(0, depth);
    const target = trail.at(-1);
    const selectable = target ? target.selectable !== false : root.selectable === true;
    navigate({ trail, detached: depth > 0 && location.detached },
      selectable ? asContainer(target ?? root) : null, fromList);
  };

  const openContainer = (item: Item) => navigate(
    query
      ? locationOf(item)
      : { trail: [...location.trail, asAncestor(item)], detached: location.detached },
    item.selectable ? item : null,
    true);

  const activate = (item: Item) => {
    if (item.kind === "container") openContainer(item);
    else if (!item.selectable) return;
    else if (item.id !== value) select(item);
    else select(openedWith);
  };

  const retry = () => {
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
      setListing(shown => shown && { ...shown, items: appendUnique(shown.items, page.items),
        nextCursor: page.nextCursor, loadingMore: false });
    }, error => {
      if (generation.current !== token) return;
      reportFrontendIssue("configurator.hierarchy-load", error);
      setListing(shown => shown && { ...shown, loadingMore: false,
        moreMessage: failureMessage(error, "Could not load more items.") });
    });
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rows = [...listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []];
    const index = rows.indexOf(event.target as HTMLElement);
    const item = index >= 0 ? items[index] : undefined;
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
      case "Enter":
      case " ":
        if (!item) return;
        activate(item);
        break;
      case "ArrowRight":
        if (item?.kind !== "container") return;
        openContainer(item);
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

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || !text) return;
    event.preventDefault();
    setText("");
    setQuery("");
  };

  const iconFor = (item: Item): ReactNode => {
    const custom = item.icon && icons && Object.hasOwn(icons, item.icon) ? icons[item.icon] : undefined;
    if (isValidElement(custom)) return custom;
    return item.kind === "container" ? <FolderIcon size={20} /> : <FileIcon size={20} />;
  };

  const locationSelected = value !== null && value === locationId;
  const rowSelected = value !== null && items.some(item => item.id === value);
  const selectedTitle = value === null || locationSelected || rowSelected || status === "loading"
    ? null
    : chosen?.id === value ? chosen.title
    : value === root.id ? root.title
    : location.trail.find(ancestor => ancestor.id === value)?.title ?? value;

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
        {isCurrent && locationSelected && (
          <>
            <CheckIcon aria-hidden="true" size={12} className="text-kumo-brand" />
            <span className="sr-only">, selected</span>
          </>
        )}
      </Button>
    );
  };
  const separator = <CaretRightIcon aria-hidden="true" size={12} className="shrink-0 text-kumo-subtle" />;

  let announcement: ReactNode;
  if (status === "loading") announcement = "Loading…";
  else if (status === "failed") announcement = fresh?.message;
  else if (items.length === 0) announcement = query ? `No results for "${query}".` : "Nothing here.";
  else {
    announcement = (
      <>
        <span className="sr-only">
          {items.length} {query ? (items.length === 1 ? "result" : "results") : (items.length === 1 ? "item" : "items")}
        </span>
        {fresh?.moreMessage}
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
      <div className="flex flex-col gap-2 border-b border-kumo-line p-2">
        <nav aria-label="Location" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
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
        {searchPlaceholder && (
          <FilterInput
            label={searchPlaceholder}
            value={text}
            disabled={disabled}
            onChange={setText}
            onKeyDown={onSearchKeyDown}
          />
        )}
      </div>
      {metaLabel && (
        <div className="flex justify-end border-b border-kumo-line px-4 py-1 text-xs text-kumo-subtle">
          {metaLabel}
        </div>
      )}
      <div className="max-h-80 overflow-y-auto p-1">
        <div
          ref={listRef}
          role="listbox"
          aria-label={locationTitle}
          aria-busy={status === "loading" || undefined}
          aria-disabled={disabled || undefined}
          tabIndex={items.length === 0 && !disabled ? 0 : -1}
          onKeyDown={onListKeyDown}
          className="flex flex-col rounded-md outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
        >
          {items.map((item, index) => {
            const selected = item.id === value;
            const inert = disabled || (item.kind === "leaf" && !item.selectable);
            // A search result says where it lives, unless it describes itself.
            const subtitle = item.subtitle
              ?? (query && item.path?.length ? item.path.map(ancestor => ancestor.title).join(" / ") : undefined);
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={selected}
                aria-disabled={inert || undefined}
                tabIndex={!disabled && index === activeIndex ? 0 : -1}
                onFocus={() => setActiveId(item.id)}
                onClick={() => activate(item)}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none",
                  "focus-visible:ring-2 focus-visible:ring-kumo-focus",
                  inert ? "cursor-default" : "cursor-pointer hover:bg-kumo-tint",
                  item.kind === "leaf" && !item.selectable && "text-kumo-inactive",
                  selected && "bg-kumo-tint text-kumo-strong",
                )}
              >
                <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center overflow-hidden text-kumo-subtle [&>svg]:size-5">
                  {iconFor(item)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.title}</span>
                  {subtitle && <span className="truncate text-xs text-kumo-subtle">{subtitle}</span>}
                </span>
                {item.meta && <span className="shrink-0 text-xs text-kumo-subtle">{item.meta}</span>}
                {selected && <CheckIcon aria-hidden="true" size={16} className="shrink-0 text-kumo-brand" />}
                {item.kind === "container" && (
                  <CaretRightIcon aria-hidden="true" size={16} className="shrink-0 text-kumo-subtle" />
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-sm text-kumo-subtle empty:hidden">
          {status === "loading" && <span aria-hidden="true"><Loader size="sm" /></span>}
          <div role="status" aria-live="polite" className={cn(status === "failed" && "text-kumo-danger")}>
            {announcement}
          </div>
          {status === "failed" && (
            <Button size="xs" disabled={disabled} onClick={retry}>Retry</Button>
          )}
          {status === "ready" && fresh?.nextCursor && (
            <Button size="xs" loading={fresh.loadingMore} disabled={disabled} onClick={loadMore}>
              Load more
            </Button>
          )}
        </div>
      </div>
      {selectedTitle !== null && (
        <div className="truncate border-t border-kumo-line px-3 py-2 text-sm text-kumo-default">
          Selected: {selectedTitle}
        </div>
      )}
    </div>
  );
};
