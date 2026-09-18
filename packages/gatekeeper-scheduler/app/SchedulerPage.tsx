import { Button, Empty, InputGroup, Loader } from "@cloudflare/kumo";
import {
  CalendarBlank,
  CaretDown,
  Clock,
  MagnifyingGlass,
  Plus,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ManagementListOptions,
  ManagementSchedule,
  ManagementSchedulePage,
} from "../src/management-types";
import type { ScheduleStatus } from "../src/types";
import { formatCadence, formatOccurrences, formatTiming } from "./format";

export const CREATE_SCHEDULE_PROMPT =
  "Help me create a scheduled task. Ask me what it should do, which workspace and resources it should use, when it should run, and which timezone to use. Then set up the schedule.";

const STARTERS = [
  {
    title: "Daily brief",
    cadence: "Weekdays at 8:00 AM",
    description: "Your calendar for the day plus the unread mail that needs a reply",
    prompt:
      "Every weekday at 8:00 AM, send me a short brief of my calendar for the day and the unread email that needs a reply. Ask me which calendar and mailbox to use and which timezone to use, then set up the schedule.",
    icon: CalendarBlank,
  },
  {
    title: "Weekly roundup",
    cadence: "Fridays at 4:00 PM",
    description: "Turn the week’s Linear issues and GitHub pull requests into a status update",
    prompt:
      "Every Friday at 4:00 PM, turn this week’s Linear issues and GitHub pull requests into a status update. Ask me which Linear team, GitHub repositories, and timezone to use, then set up the schedule.",
    icon: CalendarBlank,
  },
  {
    title: "Follow-up monitor",
    cadence: "Weekdays at 9:00 AM",
    description: "Flag the Gmail threads that are waiting on your reply",
    prompt:
      "Every weekday at 9:00 AM, flag the Gmail threads that are waiting on my reply. Ask me which mailbox, destination, and timezone to use, then set up the schedule.",
    icon: WarningCircle,
  },
  {
    title: "Metrics snapshot",
    cadence: "Mondays at 8:00 AM",
    description: "Refresh a spreadsheet or query and call out what moved",
    prompt:
      "Every Monday at 8:00 AM, refresh a spreadsheet or query and call out what moved. Ask me which data source, destination, and timezone to use, then set up the schedule.",
    icon: Clock,
  },
] as const;

type Filter = "all" | "active" | "dead" | "finished";

// Upper bound on one host title lookup, matching its per-call cap and our page size.
const MAX_TITLE_LOOKUP = 100;

export type ScheduleManagementClient = {
  list(options?: ManagementListOptions): Promise<ManagementSchedulePage>;
};

type Props = {
  api: ScheduleManagementClient;
  openWorkspace: (workspaceId: string, gadgetId?: number) => void | Promise<void>;
  openPrompt: (prompt: string) => void | Promise<void>;
  // Resolves the live title of each workspace ID, or null when the user can no longer see it. The
  // schedule rows hold only IDs, so titles are never a stale snapshot.
  resolveWorkspaceTitles: (ids: string[]) => Promise<(string | null)[]>;
};

export default function SchedulerPage({
  api,
  openWorkspace,
  openPrompt,
  resolveWorkspaceTitles,
}: Props) {
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

  // The account has no schedules at all: "all" spans every status, so an empty unfiltered page
  // means there is nothing for the search field or the status tabs to act on.
  const isEmpty =
    !loading && !error && schedules.length === 0 && !debouncedQuery && filter === "all";
  return (
    <main className="mx-auto min-h-full w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
            Scheduled tasks
          </h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            Wake a workspace and run its code on a schedule you choose.
          </p>
        </div>
        <Button
          variant="primary"
          icon={Plus}
          data-action="create-schedule"
          className="self-start !bg-kumo-brand enabled:hover:!bg-kumo-brand-hover"
          onClick={() => void runHostAction(() => openPrompt(CREATE_SCHEDULE_PROMPT))}
        >
          Create schedule
        </Button>
      </header>

      {!isEmpty && (
        <>
          <InputGroup className="mt-4">
            <InputGroup.Addon align="start">
              <MagnifyingGlass size={15} />
            </InputGroup.Addon>
            <InputGroup.Input
              aria-label="Search scheduled tasks"
              type="search"
              value={query}
              maxLength={200}
              placeholder="Search scheduled tasks…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>

          <nav className="mt-4 flex gap-5 border-b border-kumo-line" aria-label="Schedule status">
            {FILTERS.map((item) => (
              <Button
                key={item.value}
                variant="ghost"
                data-filter={item.value}
                aria-current={filter === item.value ? "page" : undefined}
                className={`relative !h-auto !rounded-none !px-0 !pb-2 text-sm ${
                  filter === item.value ? "!text-kumo-default font-medium" : "!text-kumo-subtle hover:!text-kumo-default"
                }`}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
                {filter === item.value && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-kumo-brand" />
                )}
              </Button>
            ))}
          </nav>
        </>
      )}

      <section aria-live="polite" aria-busy={loading} className={isEmpty ? undefined : "min-h-32"}>
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader size="base" />
            <p className="text-sm text-kumo-subtle">Loading scheduled tasks…</p>
          </div>
        ) : error ? (
          <Empty
            size="sm"
            icon={<WarningCircle size={32} />}
            title="Couldn’t load scheduled tasks."
            contents={
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : isEmpty ? null : schedules.length === 0 ? (
          <Empty size="sm" title="No scheduled tasks match these filters." />
        ) : (
          <div className="divide-y divide-kumo-line">
            {schedules.map((schedule) => {
              const rowKey = `${schedule.scheduleId}:${schedule.workspaceId}`;
              const detailsOpen = expanded.has(rowKey);
              const targetTitle = workspaceTitles.get(schedule.workspaceId) ?? null;
              return (
                <ScheduleRow
                  key={rowKey}
                  schedule={schedule}
                  targetTitle={targetTitle}
                  now={now}
                  expanded={detailsOpen}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(rowKey)) next.delete(rowKey);
                      else next.add(rowKey);
                      return next;
                    })
                  }
                  onOpen={() =>
                    void runHostAction(() => openWorkspace(schedule.workspaceId, schedule.gadgetId))
                  }
                />
              );
            })}
          </div>
        )}
        {!loading && !error && cursor && (
          <div className="flex justify-center py-5">
            <Button
              variant="secondary"
              data-action="load-more"
              loading={loadingMore}
              onClick={() => void load(cursor)}
            >
              Load more
            </Button>
          </div>
        )}
      </section>

      <section className={isEmpty ? "mt-6" : "mt-8"} aria-labelledby="get-started-heading">
        <h2
          id="get-started-heading"
          className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
        >
          Get started
        </h2>
        <div className="mt-3 grid gap-1">
          {STARTERS.map((starter) => {
            const Icon = starter.icon;
            return (
              <button
                key={starter.title}
                type="button"
                className="group flex items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-kumo-tint"
                onClick={() => void runHostAction(() => openPrompt(starter.prompt))}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-kumo-default">
                    {starter.title}{" "}
                    <span className="ml-1 font-normal text-kumo-inactive">{starter.cadence}</span>
                  </span>
                  <span className="block truncate text-xs text-kumo-subtle">
                    {starter.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function ScheduleRow({
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
  onToggle: () => void;
  onOpen: () => void;
}) {
  const timing = formatTiming(schedule, now);
  const target = targetTitle ?? "Unavailable workspace";
  // A workspace the user can no longer see has nothing to open.
  const unavailable = targetTitle === null;
  // Only failed schedules have something to expand: why they need attention. The caret is a sibling
  // of the open button, never nested inside it, so the rest of the row stays one click target.
  const needsAttention = schedule.status === "dead";
  return (
    <article className={`-mx-2 rounded-lg px-2 py-3 ${unavailable ? "" : "hover:bg-kumo-tint"}`}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-action="open-schedule"
          disabled={unavailable}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={onOpen}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${needsAttention ? "bg-kumo-danger-tint text-kumo-danger" : "bg-kumo-fill text-kumo-subtle"}`}
          >
            {needsAttention ? <WarningCircle size={16} /> : <Clock size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-kumo-default">
              {schedule.title}
            </span>
            <span className="block truncate text-xs text-kumo-subtle">
              {[formatCadence(schedule.cadence), formatOccurrences(schedule), target]
                .filter(Boolean).join(" · ")}
              {/* Narrow screens drop the timing column, so carry the relative time here instead. */}
              <span className="sm:hidden"> · {timing.relative}</span>
            </span>
          </span>
          <span className="hidden shrink-0 text-right sm:block">
            <span
              className={`block text-xs ${needsAttention ? "text-kumo-danger" : "text-kumo-subtle"}`}
            >
              {timing.relative}
            </span>
            {timing.absolute && (
              <span className="block text-[11px] text-kumo-inactive">{timing.absolute}</span>
            )}
          </span>
        </button>
        {needsAttention && (
          <Button
            variant="ghost"
            shape="circle"
            size="sm"
            data-action="toggle-diagnostic"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} why ${schedule.title} needs attention`}
            className="shrink-0 text-kumo-inactive hover:text-kumo-default"
            icon={<CaretDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />}
            onClick={onToggle}
          />
        )}
      </div>
      {needsAttention && expanded && timing.diagnostic && (
        <p className="ml-12 mt-2 rounded-lg bg-kumo-elevated px-3 py-2.5 text-xs leading-5 text-kumo-danger">
          {timing.diagnostic}
        </p>
      )}
    </article>
  );
}

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
