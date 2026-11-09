import { CaretDown, Clock, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ManagementListOptions,
  ManagementSchedule,
  ManagementSchedulePage,
} from "../src/management-types";
import type { ScheduleStatus } from "../src/types";
import { formatCadence, formatOccurrences, formatTiming } from "./format";

type Filter = "all" | "active" | "dead" | "finished";

// Upper bound on one host title lookup, matching its per-call cap and our page size.
const MAX_TITLE_LOOKUP = 100;

export type ScheduleManagementClient = {
  list(options?: ManagementListOptions): Promise<ManagementSchedulePage>;
};

type Props = {
  api: ScheduleManagementClient;
  openWorkspace: (workspaceId: string, gadgetId?: number) => void | Promise<void>;
  // Resolves the live title of each workspace ID, or null when the user can no longer see it. The
  // schedule rows hold only IDs, so titles are never a stale snapshot.
  resolveWorkspaceTitles: (ids: string[]) => Promise<(string | null)[]>;
};

/**
 * What the account has scheduled, read-only, shown beneath the Workshop Library's own header:
 * schedules are set up by asking in a chat, and paused or deleted where they live.
 */
export default function SchedulerPage({ api, openWorkspace, resolveWorkspaceTitles }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [schedules, setSchedules] = useState<ManagementSchedule[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [workspaceTitles, setWorkspaceTitles] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [now, setNow] = useState(Date.now());
  const request = useRef(0);
  const statuses = useMemo(() => statusesForFilter(filter), [filter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const load = useCallback(
    async (nextCursor?: string) => {
      const epoch = ++request.current;
      if (nextCursor) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const page = await api.list({
          cursor: nextCursor,
          query: debouncedQuery || undefined,
          statuses,
        });
        if (epoch !== request.current) return;
        setSchedules((current) => (nextCursor ? [...current, ...page.schedules] : page.schedules));
        setCursor(page.cursor);
      } catch (caught) {
        if (epoch === request.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (epoch === request.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, debouncedQuery, statuses],
  );

  useEffect(() => {
    setExpanded(new Set());
    void load();
  }, [load]);

  // Resolve titles for workspaces we haven't looked up yet. Failures leave the rows unresolved,
  // which renders as an unavailable target rather than breaking the list.
  useEffect(() => {
    // Capped at the host's per-call limit: a second page can land before the first lookup settles,
    // and an over-long request would be rejected outright. The rest is picked up on the next run.
    const missing = [
      ...new Set(schedules.map((s) => s.workspaceId).filter((id) => !workspaceTitles.has(id))),
    ].slice(0, MAX_TITLE_LOOKUP);
    if (missing.length === 0) return;
    let cancelled = false;
    resolveWorkspaceTitles(missing)
      .then((titles) => {
        if (cancelled) return;
        setWorkspaceTitles((current) => {
          const next = new Map(current);
          missing.forEach((id, index) => next.set(id, titles[index] ?? null));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [schedules, workspaceTitles, resolveWorkspaceTitles]);

  const runHostAction = useCallback(async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  // Stable so a memoised row re-renders only when its own schedule, title, expansion, or the clock
  // changes, not on every keystroke, page load, or title batch elsewhere in the list.
  const toggleSchedule = useCallback((schedule: ManagementSchedule) => {
    const rowKey = scheduleRowKey(schedule);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);
  const openSchedule = useCallback(
    (schedule: ManagementSchedule) =>
      void runHostAction(() => openWorkspace(schedule.workspaceId, schedule.gadgetId)),
    [runHostAction, openWorkspace],
  );

  // The account has no schedules at all: "all" spans every status, so an empty unfiltered page
  // means there is nothing for the search field or the status tabs to act on.
  const isEmpty =
    !loading && !error && schedules.length === 0 && !debouncedQuery && filter === "all";
  return (
    <main className="min-h-full w-full px-4 pb-8 pt-2.5 md:px-[45px]">
      {!isEmpty && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <nav className="flex flex-wrap gap-1" aria-label="Schedule status">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                data-filter={item.value}
                aria-current={filter === item.value ? "page" : undefined}
                className={`h-[30px] rounded-full px-3 text-[13px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${filter === item.value ? "bg-kumo-fill font-medium text-kumo-default" : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"}`}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <span className="flex-1" />
          <label className="flex h-[34px] w-[min(220px,50vw)] shrink-0 items-center gap-2 rounded-full bg-kumo-base px-2.5 ring-1 ring-kumo-line focus-within:ring-2 focus-within:ring-kumo-ring">
            <MagnifyingGlass size={16} className="shrink-0 text-kumo-subtle" />
            <span className="sr-only">Search scheduled tasks</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] text-kumo-default outline-none placeholder:text-kumo-subtle"
              type="search"
              value={query}
              maxLength={200}
              placeholder="Search"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
      )}

      <section aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div role="status" aria-label="Loading scheduled tasks" className="flex justify-center py-16">
            <span className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-[13px] text-kumo-danger">Couldn’t load scheduled tasks.</p>
            <button
              type="button"
              className="inline-flex h-[34px] items-center rounded-full bg-kumo-base px-3 text-[13px] font-medium text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-elevated"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        ) : isEmpty ? (
          <p className="mx-auto max-w-sm py-16 text-center text-[13px] leading-5 text-kumo-subtle">
            Nothing is scheduled yet. Ask in any chat, like “every weekday at 8, send me my
            calendar”, and it shows up here.
          </p>
        ) : schedules.length === 0 ? (
          <p className="py-16 text-center text-[13px] leading-5 text-kumo-subtle">
            {debouncedQuery ? "Nothing matches your search." : "No scheduled tasks here."}
          </p>
        ) : (
          <div className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
            {schedules.map((schedule) => {
              const rowKey = scheduleRowKey(schedule);
              return (
                <ScheduleRow
                  key={rowKey}
                  schedule={schedule}
                  targetTitle={workspaceTitles.get(schedule.workspaceId) ?? null}
                  now={now}
                  expanded={expanded.has(rowKey)}
                  onToggle={toggleSchedule}
                  onOpen={openSchedule}
                />
              );
            })}
          </div>
        )}
        {!loading && !error && cursor && (
          <div className="flex justify-center py-5">
            <button
              type="button"
              data-action="load-more"
              disabled={loadingMore}
              className="inline-flex h-[34px] items-center rounded-full bg-kumo-base px-3 text-[13px] font-medium text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-elevated disabled:opacity-50"
              onClick={() => void load(cursor)}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function scheduleRowKey(schedule: ManagementSchedule): string {
  return `${schedule.scheduleId}:${schedule.workspaceId}`;
}

const ScheduleRow = memo(function ScheduleRow({
  schedule,
  targetTitle,
  now,
  expanded,
  onToggle,
  onOpen,
}: {
  schedule: ManagementSchedule;
  // Live title of the workspace this schedule delivers into; null while it is still being
  // resolved, or when the workspace is gone.
  targetTitle: string | null;
  now: number;
  expanded: boolean;
  onToggle: (schedule: ManagementSchedule) => void;
  onOpen: (schedule: ManagementSchedule) => void;
}) {
  const timing = formatTiming(schedule, now);
  const target = targetTitle ?? "Unavailable workspace";
  // A workspace the user can no longer see has nothing to open.
  const unavailable = targetTitle === null;
  // Only failed schedules have something to expand: why they need attention. The caret is a sibling
  // of the open button, never nested inside it, so the rest of the row stays one click target.
  const needsAttention = schedule.status === "dead";
  return (
    <article>
      <div className="flex items-center">
        <button
          type="button"
          data-action="open-schedule"
          disabled={unavailable}
          title={timing.absolute || undefined}
          className={`flex h-[49px] min-w-0 flex-1 items-center gap-3 rounded-[14px] px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-kumo-ring ${unavailable ? "cursor-default" : "hover:bg-kumo-tint"}`}
          onClick={() => onOpen(schedule)}
        >
          <span
            className={`flex size-[25px] shrink-0 items-center justify-center rounded-[10px] ${needsAttention ? "text-kumo-danger" : "text-kumo-default"}`}
          >
            {needsAttention ? <WarningCircle size={18} /> : <Clock size={18} weight="light" />}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">
              {schedule.title}
            </span>
            <span className="hidden truncate text-[13px] text-kumo-subtle sm:inline">
              {[formatCadence(schedule.cadence), formatOccurrences(schedule), target]
                .filter(Boolean).join(" · ")}
            </span>
          </span>
          <span
            className={`shrink-0 text-[13px] leading-[22px] ${needsAttention ? "text-kumo-danger" : "text-kumo-subtle"}`}
          >
            {timing.relative}
          </span>
        </button>
        {needsAttention && (
          <button
            type="button"
            data-action="toggle-diagnostic"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} why ${schedule.title} needs attention`}
            className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            onClick={() => onToggle(schedule)}
          >
            <CaretDown
              size={14}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      {needsAttention && expanded && timing.diagnostic && (
        <p className="mb-2 ml-[49px] mr-3 rounded-[14px] bg-kumo-danger-tint px-3 py-2.5 text-[13px] leading-5 text-kumo-danger">
          {timing.diagnostic}
        </p>
      )}
    </article>
  );
});

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "dead", label: "Needs attention" },
  { value: "finished", label: "Finished" },
];

function statusesForFilter(filter: Filter): ScheduleStatus[] | undefined {
  if (filter === "all") return undefined;
  if (filter === "active") return ["active"];
  if (filter === "dead") return ["dead"];
  return ["completed", "expired"];
}
