import {
  ArrowsClockwise,
  Check,
  Copy,
  Lightning,
  MagnifyingGlass,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ManagementDeliveryPage,
  ManagementEndpoint,
  ManagementEndpointPage,
  ManagementListOptions,
} from "../src/management-types";
import type { DeliverySummary, EndpointCredentials, EndpointStatus } from "../src/types";
import { describeDelivery, formatBytes, formatRelative, statusLabel, statusTone } from "./format";

export const CREATE_ENDPOINT_PROMPT =
  "Help me set up an inbound webhook for this workspace. Ask me which service will call it and " +
  "what should happen when an event arrives, then register the endpoint and give me the URL and " +
  "token to paste into that service.";

const STARTERS = [
  {
    title: "Repository events",
    detail: "Review pushes and open a pull request when something needs fixing",
    prompt:
      "Set up a webhook this workspace can give to GitHub for push events. When one arrives, " +
      "review what changed in the repository and open a pull request if it needs a fix. Ask me " +
      "which repository to watch, then register the endpoint and give me the URL and token.",
    icon: Lightning,
  },
  {
    title: "Alert triage",
    detail: "Turn incoming alerts into a triaged summary with a recommended next step",
    prompt:
      "Set up a webhook my alerting tool can post to. When an alert arrives, summarize what " +
      "fired, how severe it is, and what to do next. Ask me which tool will send the alerts and " +
      "where the summary should go, then register the endpoint and give me the URL and token.",
    icon: WarningCircle,
  },
  {
    title: "Form submissions",
    detail: "File each submission and flag the ones that need a human reply",
    prompt:
      "Set up a webhook a form service can post submissions to. File each submission and flag the " +
      "ones that need a human reply. Ask me which service and what counts as needing a reply, " +
      "then register the endpoint and give me the URL and token.",
    icon: Plus,
  },
] as const;

type Filter = "all" | "active" | "disabled" | "failing";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Not enabled" },
  { value: "failing", label: "Needs attention" },
];

// Upper bound on one host title lookup, matching its per-call cap and our page size.
const MAX_TITLE_LOOKUP = 100;

export type WebhookManagementClient = {
  list(options?: ManagementListOptions): Promise<ManagementEndpointPage>;
  deliveries(endpointId: string): Promise<ManagementDeliveryPage>;
  rotateToken(endpointId: string): Promise<EndpointCredentials>;
  revoke(endpointId: string): Promise<void>;
};

type Props = {
  api: WebhookManagementClient;
  openWorkspace: (workspaceId: string, gadgetId?: number) => void | Promise<void>;
  openPrompt: (prompt: string) => void | Promise<void>;
  // Resolves the live title of each workspace ID, or null when the user can no longer see it. The
  // endpoint rows hold only IDs, so titles are never a stale snapshot.
  resolveWorkspaceTitles: (ids: string[]) => Promise<(string | null)[]>;
};

function statusesForFilter(filter: Filter): EndpointStatus[] | undefined {
  return filter === "all" ? undefined : [filter];
}

export default function WebhooksPage({
  api,
  openWorkspace,
  openPrompt,
  resolveWorkspaceTitles,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [endpoints, setEndpoints] = useState<ManagementEndpoint[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string | null>(null);
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
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
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
        setEndpoints((current) =>
          nextCursor ? [...current, ...page.endpoints] : page.endpoints,
        );
        setCursor(page.cursor);
      } catch {
        if (epoch === request.current) setError("load");
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
    void load();
  }, [load]);

  // Resolve titles for whatever workspaces the current rows reference, once per new set of IDs.
  useEffect(() => {
    const ids = [...new Set(endpoints.map((endpoint) => endpoint.workspaceId))]
      .filter((id) => !workspaceTitles.has(id))
      .slice(0, MAX_TITLE_LOOKUP);
    if (ids.length === 0) return;
    let cancelled = false;
    void resolveWorkspaceTitles(ids)
      .then((titles) => {
        if (cancelled) return;
        setWorkspaceTitles((current) => {
          const next = new Map(current);
          ids.forEach((id, index) => next.set(id, titles[index] ?? null));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [endpoints, resolveWorkspaceTitles, workspaceTitles]);

  const isEmpty = !loading && !error && endpoints.length === 0 && !debouncedQuery && filter === "all";

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 py-8">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Webhooks</h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            Inbound URLs that let other services push events into your workspaces.
          </p>
        </div>
        <button
          type="button"
          data-action="create"
          className="press inline-flex h-9 items-center justify-center gap-2 self-start rounded-lg bg-kumo-brand px-3.5 text-sm font-medium text-white hover:bg-kumo-brand-hover"
          onClick={() => void openPrompt(CREATE_ENDPOINT_PROMPT)}
        >
          <Plus size={15} weight="bold" />
          New webhook
        </button>
      </header>

      {!isEmpty && (
        <>
          <label className="mt-4 flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 text-kumo-inactive focus-within:ring-2 focus-within:ring-kumo-ring">
            <MagnifyingGlass size={15} />
            <span className="sr-only">Search webhooks</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-inactive"
              type="search"
              value={query}
              maxLength={200}
              placeholder="Search webhooks…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>

          <nav className="mt-4 flex gap-5 border-b border-kumo-line" aria-label="Webhook status">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                data-filter={item.value}
                aria-current={filter === item.value ? "page" : undefined}
                className={`relative pb-2 text-sm ${filter === item.value ? "font-medium text-kumo-default" : "text-kumo-subtle hover:text-kumo-default"}`}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
                {filter === item.value && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-kumo-brand" />
                )}
              </button>
            ))}
          </nav>
        </>
      )}

      <section aria-live="polite" aria-busy={loading} className={isEmpty ? undefined : "min-h-32"}>
        {loading ? (
          <p className="py-12 text-center text-sm text-kumo-subtle">Loading webhooks…</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-kumo-danger">Couldn’t load webhooks.</p>
            <button
              className="text-sm font-medium text-kumo-link hover:text-kumo-brand-hover"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        ) : isEmpty ? null : endpoints.length === 0 ? (
          <p className="py-12 text-center text-sm text-kumo-subtle">
            No webhooks match these filters.
          </p>
        ) : (
          <div className="divide-y divide-kumo-line">
            {endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.endpointId}
                api={api}
                endpoint={endpoint}
                now={now}
                workspaceTitle={workspaceTitles.get(endpoint.workspaceId) ?? null}
                expanded={expanded === endpoint.endpointId}
                onToggle={() =>
                  setExpanded((current) =>
                    current === endpoint.endpointId ? null : endpoint.endpointId,
                  )
                }
                onOpenWorkspace={() =>
                  void openWorkspace(endpoint.workspaceId, endpoint.gadgetId)
                }
                onRevoked={() => {
                  setExpanded(null);
                  setEndpoints((current) =>
                    current.filter((item) => item.endpointId !== endpoint.endpointId),
                  );
                }}
              />
            ))}
          </div>
        )}
        {!loading && !error && cursor && (
          <div className="flex justify-center py-5">
            <button
              type="button"
              data-action="load-more"
              disabled={loadingMore}
              className="rounded-lg border border-kumo-line bg-kumo-control px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
              onClick={() => void load(cursor)}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
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
                onClick={() => void openPrompt(starter.prompt)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-kumo-default">
                    {starter.title}
                  </span>
                  <span className="block truncate text-xs text-kumo-subtle">{starter.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function EndpointRow({
  api,
  endpoint,
  now,
  workspaceTitle,
  expanded,
  onToggle,
  onOpenWorkspace,
  onRevoked,
}: {
  api: WebhookManagementClient;
  endpoint: ManagementEndpoint;
  now: number;
  workspaceTitle: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenWorkspace: () => void;
  onRevoked: () => void;
}) {
  const [deliveries, setDeliveries] = useState<DeliverySummary[] | null>(null);
  // The freshly minted token, held only in this component: it is never readable again from the
  // server, so it lives exactly as long as the row stays expanded.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    if (!expanded) {
      setNewToken(null);
      setConfirmingRevoke(false);
      return;
    }
    let cancelled = false;
    void api
      .deliveries(endpoint.endpointId)
      .then((page) => {
        if (!cancelled) setDeliveries(page.deliveries);
      })
      .catch(() => {
        if (!cancelled) setDeliveries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, endpoint.endpointId, expanded]);

  const rotate = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      const credentials = await api.rotateToken(endpoint.endpointId);
      setNewToken(credentials.token);
    } catch {
      setActionError("Couldn’t issue a token for this webhook.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api.revoke(endpoint.endpointId);
      onRevoked();
    } catch {
      setActionError("Couldn’t delete this webhook.");
      setBusy(false);
    }
  };

  return (
    <div data-endpoint={endpoint.endpointId}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-kumo-tint"
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-kumo-default">{endpoint.title}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(endpoint.status)}`}
            >
              {statusLabel(endpoint.status)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
            {workspaceTitle ?? "Workspace unavailable"}
            {" · "}
            {endpoint.deliveryCount === 0
              ? "No deliveries yet"
              : `${endpoint.deliveryCount} deliveries`}
            {endpoint.lastDeliveryAt !== undefined &&
              ` · last ${formatRelative(endpoint.lastDeliveryAt, now)}`}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="px-1 pb-4">
          <p className="text-sm text-kumo-subtle">{endpoint.description}</p>

          <CopyField label="Endpoint URL" value={endpoint.url} />

          {!endpoint.hasToken && (
            <p className="mt-3 rounded-lg bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
              No token yet, so this endpoint rejects every request. Generate one below and paste it
              into the sending service.
            </p>
          )}

          {endpoint.status === "disabled" && (
            <p className="mt-3 rounded-lg bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
              This endpoint is registered but its hook is not enabled yet, so it rejects deliveries.
              Enable it from the workspace’s Connections panel.
            </p>
          )}

          {newToken && (
            <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-elevated p-3">
              <p className="text-xs font-medium text-kumo-default">
                Token — copy it now, it is not shown again
              </p>
              <CopyField label="Bearer token" value={newToken} mono />
              <p className="mt-2 text-xs text-kumo-subtle">
                Send it as <code>Authorization: Bearer &lt;token&gt;</code>.
                {endpoint.hasToken && " The previous token stopped working immediately."}
              </p>
            </div>
          )}

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-kumo-inactive">Methods</dt>
            <dd className="text-kumo-default">{endpoint.methods.join(", ")}</dd>
            <dt className="text-kumo-inactive">Created</dt>
            <dd className="text-kumo-default">{formatRelative(endpoint.createdAt, now)}</dd>
            {endpoint.failedCount > 0 && (
              <>
                <dt className="text-kumo-inactive">Failed deliveries</dt>
                <dd className="text-kumo-danger">{endpoint.failedCount}</dd>
              </>
            )}
          </dl>

          <h3 className="mt-4 text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive">
            Recent deliveries
          </h3>
          {deliveries === null ? (
            <p className="mt-2 text-xs text-kumo-subtle">Loading…</p>
          ) : deliveries.length === 0 ? (
            <p className="mt-2 text-xs text-kumo-subtle">Nothing has called this URL yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-kumo-line">
              {deliveries.map((delivery) => (
                <li
                  key={delivery.deliveryId}
                  className="flex items-baseline justify-between gap-3 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-kumo-default">
                    {delivery.method} · {formatBytes(delivery.bodyBytes)} ·{" "}
                    <span
                      className={
                        delivery.outcome === "failed" ? "text-kumo-danger" : "text-kumo-subtle"
                      }
                    >
                      {describeDelivery(delivery)}
                    </span>
                  </span>
                  <span className="shrink-0 text-kumo-inactive">
                    {formatRelative(delivery.receivedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {actionError && <p className="mt-3 text-xs text-kumo-danger">{actionError}</p>}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-action="open-workspace"
              className="rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
              onClick={onOpenWorkspace}
            >
              Open workspace
            </button>
            <button
              type="button"
              data-action="rotate"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
              onClick={() => void rotate()}
            >
              <ArrowsClockwise size={13} />
              {endpoint.hasToken ? "Rotate token" : "Generate token"}
            </button>
            {confirmingRevoke ? (
              <span className="inline-flex items-center gap-2">
                <button
                  type="button"
                  data-action="revoke-confirm"
                  disabled={busy}
                  className="rounded-lg bg-kumo-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  onClick={() => void revoke()}
                >
                  Delete permanently
                </button>
                <button
                  type="button"
                  className="text-xs text-kumo-subtle hover:text-kumo-default"
                  onClick={() => setConfirmingRevoke(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-action="revoke"
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-3 py-1.5 text-xs font-medium text-kumo-danger hover:bg-kumo-danger-tint disabled:opacity-50"
                onClick={() => setConfirmingRevoke(true)}
              >
                <Trash size={13} />
                Delete
              </button>
            )}
          </div>
          {confirmingRevoke && (
            <p className="mt-2 text-xs text-kumo-subtle">
              The URL stops working immediately. The workspace’s hook stays until you remove it in
              Connections.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 py-2">
      <span className="sr-only">{label}</span>
      <code
        className={`min-w-0 flex-1 truncate text-xs text-kumo-default ${mono ? "font-mono" : ""}`}
      >
        {value}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()}`}
        className="shrink-0 rounded p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
        onClick={() => {
          // clipboard-write is the one permission the host grants the frame; a failure is silent
          // because the value is already selectable on screen.
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => {},
          );
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
