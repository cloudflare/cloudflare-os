// What every capability shares: the gatekeeper host it reads and stages through, the context that
// authorizes each read, argument validation, and the reads and listings more than one capability
// makes. Every read fetches as the connected user, replays pending actions over the result, and
// authorizes the observation before returning, reporting the account, the objects the capability
// is scoped to, those its filter names and those its result shows (see `SessionContext.authorize`).
// The capabilities themselves live in pagerduty-sessions.ts (account, team, service),
// pagerduty-incident-session.ts and pagerduty-schedule-session.ts.

import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import { TokenCursor, type CursorInjection } from "@gadgets/gatekeeper-kit/cursors";
import type { ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import { MAX_LIMIT, MAX_OFFSET, isDenial, schedulePath, type Page, type PagerDutyApi, type Query } from "./pagerduty-api";
import { isProvisional, type NewIncident, type PagerDutyActions, type PriorityTarget, type UserTarget } from "./pagerduty-actions";
import { subresourceId, type Identity, type ObjectKind } from "./pagerduty-credentials";
import type { Tenant } from "./pagerduty-env";
import {
  toIncidentSummary, toOnCall, toPriority, toScheduleSummary, toUser,
  type Schedule, type WireIncident, type WireOnCall, type WirePriority, type WireRef, type WireSchedule, type WireService,
  type WireUser,
} from "./pagerduty-normalize";
import {
  changedIncidents, matchesQuery, newestFirst, overlayIncident, overlayOnCalls, overridesPending, pendingIncidents,
  type IncidentQuery, type Pending,
} from "./pagerduty-simulation";
import { OBJECT_ID, objectId } from "./pagerduty-urls";
import type { PagerDutyEventHookTarget } from "./pagerduty-hooks";
import type {
  Cursor, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyListOptions, PagerDutyOnCall,
  PagerDutyOnCallWindow, PagerDutyPageOptions, PagerDutyPriority, PagerDutyScheduleSummary, PagerDutySubscribeOptions,
  PagerDutyTimeWindow, PagerDutyUrgency, PagerDutyUser,
} from "./types";

/** How long a service's team and escalation policy, read to check a binding's scope, stay cached. */
const SERVICE_TTL_MS = 5 * 60_000;
/** How long the account's priorities and a team's escalation policies stay cached. */
export const CATALOG_TTL_MS = 10 * 60_000;
/** Listings' default page size. */
const DEFAULT_PAGE_SIZE = 25;
/** How far back incident listings reach by default. */
const DEFAULT_INCIDENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** The most users `findUsers` returns. */
const MAX_USERS = 50;
/** PagerDuty's longest note. */
export const MAX_NOTE_LENGTH = 25_000;

/** The capability a hook subscribed through: its scope, what it may reach, and its incident, if one. */
export type HookScope = { scope: readonly ObjectRef[]; within: Within; incidentId?: string };

/** What a session may ask of the gatekeeper Durable Object. */
export type SessionHost = {
  readonly tenant: Tenant;
  /** The connected user, whose account every subresource names. */
  me(): Promise<Identity>;
  /** Runs a read as the connected user. */
  read<T>(op: (api: PagerDutyApi) => Promise<T>): Promise<T>;
  /** A cached value, partitioned by connection. */
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  /** Actions waiting for a decision, for simulation. */
  pending(): Pending;
  /** The ID PagerDuty assigned a temporary ID, or the ID itself. */
  resolve(id: string): string;
  /** Allocates a temporary ID for something a pending action creates, of `kind`. */
  allocate(kind: "incident" | "note" | `override:${string}`): string;
  /** The kind a temporary ID was allocated with. */
  kindOf(id: string): string | undefined;
  submit<K extends keyof PagerDutyActions>(queue: ActionSubmitter, kind: K, payload: PagerDutyActions[K]): Promise<number>;
  /** Binds `hook` to the incident events `scope` reaches (see pagerduty-hooks.ts). */
  subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<PagerDutyEventHookTarget>,
            options: PagerDutySubscribeOptions | undefined, scope: HookScope): Promise<void>;
};

/** An object a read depends on. */
export type ObjectRef = { kind: ObjectKind; id: string };

/** What restricts a read beyond its capability's scope: the objects its filter names, and its result shows. */
export type ReadReport = { filter: readonly ObjectRef[]; result: readonly ObjectRef[] };

/**
 * What one capability owns: the gatekeeper host, its own approval-queue stub, and its scope -- the
 * objects every read through it depends on besides the account. A capability handed out takes a
 * duplicate stub, so disposing one never disturbs another.
 */
export class SessionContext implements Disposable {
  constructor(readonly host: SessionHost, readonly queue: RpcStub<ApprovalQueue>, readonly scope: readonly ObjectRef[]) {}

  dup(): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), this.scope);
  }

  /** A context for an object opened from this one, which every read through it also depends on. */
  within(object: ObjectRef): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), [...this.scope, object]);
  }

  /**
   * Authorizes a read, reporting the account, this capability's scope, and `report`'s filter and
   * result. Every read goes through here, whether it found anything or came from cache, so no read
   * can leave out the account or the scope.
   */
  async authorize(observation: ObservationInput, report: ReadReport): Promise<void> {
    const { region, accountId } = await this.host.me();
    const account = { region, accountId };
    const objects = [...this.scope, ...report.filter, ...report.result].filter(({ id }) => !isProvisional(id));
    await this.queue.authorizeObservation({
      ...observation,
      subresources: [...new Set([subresourceId(account), ...objects.map(object => subresourceId(account, object))])],
    });
  }

  [Symbol.dispose](): void {
    this.queue[Symbol.dispose]();
  }
}

/** The objects a capability may reach beyond itself: those in this team, or on this service. */
export type Within = { teamId?: string; serviceId?: string };

/** A team a read depends on. */
export const team = (id: string): ObjectRef => ({ kind: "team", id });
/** A service a read depends on. */
export const service = (id: string): ObjectRef => ({ kind: "service", id });
/** An incident a read depends on. */
export const incident = (id: string): ObjectRef => ({ kind: "incident", id });
/** A schedule a read depends on. */
export const schedule = (id: string): ObjectRef => ({ kind: "schedule", id });
/** An escalation policy a read depends on. */
export const escalationPolicy = (id: string): ObjectRef => ({ kind: "escalation_policy", id });

const plural = (noun: string): string => noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;

/** `count` of `noun`, e.g. "1 note", "3 entries". */
export const countOf = (count: number, noun: string): string => `${count} ${count === 1 ? noun : plural(noun)}`;

// ---------------------------------------------------------------------------
// Validation

/** A listing's page size, checked. */
export function pageSizeOf(options: PagerDutyPageOptions | undefined): number {
  const size = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
    throw new Error(`pageSize must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return size;
}

/** An agent-supplied string, non-empty and at most `max` characters. */
export function text(value: unknown, what: string, max = Infinity): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${what} can be at most ${max} characters.`);
  return value;
}

/** An agent-supplied ISO 8601 time, normalized, or undefined when none was given. */
export function time(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${what} must be an ISO 8601 time.`);
  return new Date(value).toISOString();
}

/** An agent-supplied urgency, checked. */
export function urgency(value: unknown): PagerDutyUrgency {
  if (value !== "high" && value !== "low") throw new Error('urgency must be "high" or "low".');
  return value;
}

/** Agent-supplied object IDs, each checked, or undefined when none were given. */
export function ids(values: readonly string[] | undefined, what: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${what} must be an array of PagerDuty IDs.`);
  return values.map(value => objectId(value, what));
}

/** A window between ISO times, defaulting to `days` from now and at most `maxDays` long. */
export function windowOf(window: PagerDutyTimeWindow | undefined, days: number, maxDays = Infinity): { since: string; until: string } {
  const since = time(window?.since, "since") ?? new Date().toISOString();
  const until = time(window?.until, "until") ?? new Date(Date.parse(since) + days * DAY_MS).toISOString();
  if (Date.parse(until) <= Date.parse(since)) throw new Error("until must be after since.");
  if (Date.parse(until) - Date.parse(since) > maxDays * DAY_MS) throw new Error(`since and until can be at most ${maxDays} days apart.`);
  return { since, until };
}

// ---------------------------------------------------------------------------
// Shared reads

/** The connected user, as the pending actions they staged show them. */
export const youRef = (me: Identity) => ({ id: me.userId, name: me.name });

/** An incident as PagerDuty describes it now. */
export async function readIncident({ host }: { host: SessionHost }, id: string,
                                   include: readonly string[] = []): Promise<WireIncident> {
  return (await host.read(api => api.get<{ incident: WireIncident }>(`/incidents/${id}`, include.length ? { include } : {})))
    .incident;
}

/** A service as PagerDuty describes it now. */
export async function readService({ host }: { host: SessionHost }, id: string): Promise<WireService> {
  return (await host.read(api => api.get<{ service: WireService }>(`/services/${id}`))).service;
}

/** What a schedule read asks for besides the schedule: its shifts in `window`, and the users a shift-based one names. */
export type ScheduleQuery = { window?: { since: string; until: string }; users?: boolean };

/**
 * A schedule as PagerDuty describes it now, of either generation. Which one it is is found by a
 * read without parameters, so a parameter PagerDuty refuses fails the read rather than pass for a
 * layer-based schedule, and is remembered a while, so only the first read of a layer-based
 * schedule asks the v3 API in vain.
 */
export async function readSchedule({ host }: { host: SessionHost }, id: string,
                                   { window, users }: ScheduleQuery = {}): Promise<Schedule> {
  const probed: { schedule?: Schedule } = {};
  const shiftBased = await host.cached(`schedule-generation:${id}`, CATALOG_TTL_MS, async () => {
    const probe = await host.read(api => api.schedule<{ schedule: WireSchedule }>(id));
    probed.schedule = { ...probe.body.schedule, shiftBased: probe.shiftBased };
    return probe.shiftBased;
  });
  // The probe serves a read that asks for nothing more.
  if (probed.schedule && !window && !users) return probed.schedule;
  // v3 sends a schedule's shifts and users only when asked to include them.
  const query: Query = shiftBased
    ? { ...window, include: [...(window ? ["final_schedule"] : []), ...(users ? ["users"] : [])] }
    : { ...window };
  const read = await host.read(api => api.get<{ schedule: WireSchedule }>(schedulePath(id, shiftBased), query));
  return { ...read.schedule, shiftBased };
}

/** A service's team and escalation policy, cached briefly, for checking a binding's scope. */
export function cachedService(ctx: { host: SessionHost }, id: string): Promise<WireService> {
  return ctx.host.cached(`service:${id}`, SERVICE_TTL_MS, () => readService(ctx, id));
}

/** Whether `owned` belongs to team `teamId`, as one of its teams; anything does when there's none. */
export const inTeam = (owned: { teams?: readonly { id: string }[] }, teamId: string | undefined): boolean =>
  teamId === undefined || (owned.teams ?? []).some(({ id }) => id === teamId);

/** @throws Error unless `wire` belongs to team `teamId`. */
export function requireTeam(wire: { teams?: WireRef[] }, teamId: string | undefined, what: string): void {
  if (!inTeam(wire, teamId)) throw new Error(`That ${what} doesn't belong to this team.`);
}

/**
 * Why an incident on service `serviceId` is outside a capability's team or service, or undefined
 * when it is within. `loadService` reads the service's teams: briefly cached for reads by default.
 */
export async function outsideOf(ctx: { host: SessionHost }, serviceId: string, within: Within,
                                loadService = cachedService): Promise<string | undefined> {
  if (within.serviceId && serviceId !== within.serviceId) return "That incident belongs to another service.";
  if (within.teamId && !inTeam(await loadService(ctx, serviceId), within.teamId)) {
    return "That incident doesn't belong to this team.";
  }
  return undefined;
}

/**
 * The incident `id` as PagerDuty has it now, and why it is outside `within`, if it is. PagerDuty
 * can move an incident to another service at any time, so each check reads it afresh;
 * `loadService` reads the service's teams, briefly cached by default.
 */
export async function currentIncident(ctx: { host: SessionHost }, id: string, within: Within,
                                      include: readonly string[] = [], loadService = cachedService):
    Promise<{ wire: WireIncident; outside?: string }> {
  const wire = await readIncident(ctx, id, include);
  const outside = await outsideOf(ctx, wire.service.id, within, loadService);
  return outside ? { wire, outside } : { wire };
}

/** What a change can act on, or add to, that a team or service capability must still reach. */
export type ScopedObject = { kind: "incident" | "service" | "schedule"; id: string };

/**
 * Why `object` is now outside `within`, or undefined when it is within: an incident by the service
 * PagerDuty has it on, a service or schedule by its teams. Every read is fresh, since a change is
 * about to be made; nothing is read when `within` is empty.
 */
export async function objectOutside(ctx: { host: SessionHost }, { kind, id }: ScopedObject, within: Within):
    Promise<string | undefined> {
  if (kind === "incident") {
    return within.teamId || within.serviceId ? (await currentIncident(ctx, id, within, [], readService)).outside : undefined;
  }
  if (!within.teamId) return undefined;
  const wire = kind === "service" ? await readService(ctx, id) : await readSchedule(ctx, id);
  return inTeam(wire, within.teamId) ? undefined : `That ${kind} doesn't belong to this team.`;
}

/** Every user matching `query`, up to `MAX_USERS`. */
export async function findUsers(ctx: SessionContext, query: string | undefined): Promise<PagerDutyUser[]> {
  if (query !== undefined) text(query, "query", 200);
  const users = await ctx.host.read(api => api.all<WireUser>("/users", "users", { query }, MAX_USERS));
  await ctx.authorize({ title: "Looked up PagerDuty users", description: `Found ${countOf(users.length, "user")}.` },
    { filter: [], result: [] });
  return users.map(toUser);
}

/** The account's priorities, cached briefly. */
function priorities(ctx: SessionContext): Promise<WirePriority[]> {
  return ctx.host.cached("priorities", CATALOG_TTL_MS,
    () => ctx.host.read(api => api.all<WirePriority>("/priorities", "priorities")));
}

/** The account's priorities, as an agent lists them. */
export async function listPriorities(ctx: SessionContext): Promise<PagerDutyPriority[]> {
  const rows = await priorities(ctx);
  await ctx.authorize({ title: "Listed PagerDuty priorities", description: `Listed ${countOf(rows.length, "priority")}.` },
    { filter: [], result: [] });
  return rows.map(toPriority);
}

/** A priority named by the agent, for an action's payload. */
export async function priorityNamed(ctx: SessionContext, name: string): Promise<PriorityTarget> {
  text(name, "priority");
  const match = (await priorities(ctx)).find(priority => priority.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`There is no priority named "${name}"; listPriorities() lists them.`);
  return { id: match.id, name: match.name };
}

/** Users named by email or ID, for an action's payload or a filter. */
export async function usersNamed(ctx: SessionContext, given: readonly string[], what: string): Promise<UserTarget[]> {
  if (!Array.isArray(given) || given.length === 0) throw new Error(`${what} must name at least one user.`);
  return await Promise.all(given.map(async value => {
    text(value, what);
    if (OBJECT_ID.test(value)) {
      const { user } = await ctx.host.read(api => api.get<{ user: WireUser }>(`/users/${value}`));
      return { id: user.id, name: user.name ?? user.id, given: value };
    }
    const users = await ctx.host.read(api => api.all<WireUser>("/users", "users", { query: value }, MAX_USERS));
    const user = users.find(({ email }) => email.toLowerCase() === value.toLowerCase());
    if (!user) throw new Error(`No PagerDuty user has the email ${value}.`);
    return { id: user.id, name: user.name ?? user.id, given: value };
  }));
}

/** One page of a listing from `offset`, at most `limit` rows. */
type OffsetFetch<W> = (api: PagerDutyApi, offset: number, limit: number) => Promise<Page<W>>;

/**
 * Listings walked by offset, one after another, authorizing each page as it leaves: the cursor
 * owns a duplicate of the capability's queue stub and releases it when the walk is dropped.
 */
export function offsetCursor<W, T>(ctx: SessionContext, options: {
  pageSize: number;
  /** The listings walked in turn. */
  sources: readonly OffsetFetch<W>[];
  /** Converts a page as fetched; pending actions apply as rows are served, in `inject`. */
  convert(rows: W[]): T[];
  describe(rows: readonly T[], terminal: boolean): ObservationInput;
  filter: readonly ObjectRef[];
  /** What a page shows, as it is served: a page it throws for is refused. */
  result(rows: readonly T[]): ObjectRef[] | Promise<ObjectRef[]>;
  inject?: CursorInjection<T>;
}): Cursor<T> {
  const walk = ctx.dup();
  return new TokenCursor<T>({
    pageSize: options.pageSize,
    remotePageSize: Math.max(options.pageSize, DEFAULT_PAGE_SIZE),
    dispose: () => walk[Symbol.dispose](),
    ...(options.inject ? { inject: options.inject } : {}),
    // A token is `<source>:<offset>`, where the walk stopped in which listing.
    fetchPage: async (token, perPage) => {
      const [source, offset] = token === undefined ? [0, 0] : token.split(":").map(Number) as [number, number];
      const page = await walk.host.read(api => options.sources[source]!(api, offset, Math.min(perPage, MAX_OFFSET - offset)));
      const next = offset + page.items.length;
      // PagerDuty refuses an offset past its cap, so the listing ends there.
      const more = page.more && page.items.length > 0 && next < MAX_OFFSET;
      const nextToken = more ? `${source}:${next}` : source + 1 < options.sources.length ? `${source + 1}:0` : undefined;
      return { items: options.convert(page.items), ...(nextToken ? { nextToken } : {}) };
    },
    authorizePage: async (rows, { terminal }) =>
      walk.authorize(options.describe(rows, terminal), { filter: options.filter, result: await options.result(rows) }),
  });
}

/** What a listing page's observation says. */
export function listed(title: string, noun: string) {
  return (rows: readonly unknown[], terminal: boolean): ObservationInput => ({
    title,
    description: rows.length > 0 ? `Read ${countOf(rows.length, noun)}.`
      : terminal ? `Listed ${plural(noun)}; there were none.` : `Scanned ${plural(noun)}; none were in this window.`,
  });
}

/**
 * Listings of services, teams or schedules, walked in turn, reporting each row: a team's listing
 * too, since PagerDuty showing the team needn't mean it shows everything the team owns.
 */
export function namedListing<W extends WireRef, T extends { id: string }>(ctx: SessionContext, options: {
  key: string; kind: ObjectKind; noun: string; teamId?: string; list?: PagerDutyListOptions;
  /** Each listing's path, and how its rows convert. */
  sources: readonly { path: string; convert(wire: W): T }[];
}): Cursor<T> {
  const query = options.list?.query === undefined ? undefined : text(options.list.query, "query", 200);
  const filters: Query = { query, ...(options.teamId ? { team_ids: [options.teamId] } : {}) };
  if (options.kind === "service") filters.sort_by = "name";
  return offsetCursor<T, T>(ctx, {
    pageSize: pageSizeOf(options.list),
    sources: options.sources.map(({ path, convert }): OffsetFetch<T> => async (api, offset, limit) => {
      const page = await api.page<W>(path, options.key, filters, offset, limit);
      return { ...page, items: page.items.map(convert) };
    }),
    convert: rows => rows,
    describe: listed(`Listed PagerDuty ${plural(options.noun)}`, options.noun),
    filter: [],
    result: rows => rows.map(({ id }) => ({ kind: options.kind, id })),
  });
}

/** Schedules: layer-based ones, by name, then shift-based ones, which PagerDuty lists apart. */
export function listSchedules(ctx: SessionContext, list: PagerDutyListOptions | undefined,
                              teamId?: string): Cursor<PagerDutyScheduleSummary> {
  return namedListing<WireSchedule, PagerDutyScheduleSummary>(ctx, {
    key: "schedules", kind: "schedule", noun: "schedule", list, teamId,
    sources: [false, true].map(shiftBased => ({
      path: shiftBased ? "/v3/schedules" : "/schedules",
      convert: (wire: WireSchedule) => toScheduleSummary({ ...wire, shiftBased }),
    })),
  });
}

/** The defaults and bounds of an incident filter, as PagerDuty's query and the simulation's. */
function incidentQuery(filter: PagerDutyIncidentFilter | undefined, within: Within, me: Identity): { query: IncidentQuery; params: Query } {
  const statuses = filter?.statuses ?? ["triggered", "acknowledged"];
  if (!Array.isArray(statuses) || statuses.some(status => !["triggered", "acknowledged", "resolved"].includes(status))) {
    throw new Error('statuses must list "triggered", "acknowledged" or "resolved".');
  }
  const urgencies = filter?.urgencies?.map(urgency);
  let serviceIds = ids(filter?.serviceIds, "serviceIds");
  if (within.serviceId) serviceIds = (serviceIds ?? [within.serviceId]).filter(id => id === within.serviceId);
  let since: string | undefined;
  let until: string | undefined;
  if (!filter?.allTime) {
    until = time(filter?.until, "until") ?? new Date().toISOString();
    since = time(filter?.since, "since") ?? new Date(Date.parse(until) - DEFAULT_INCIDENT_DAYS * DAY_MS).toISOString();
    const limit = new Date(since);
    limit.setUTCMonth(limit.getUTCMonth() + 6);
    if (Date.parse(until) <= Date.parse(since)) throw new Error("until must be after since.");
    if (Date.parse(until) > limit.getTime()) {
      throw new Error("since and until can be at most 6 months apart; set allTime to search every incident.");
    }
  }
  const query: IncidentQuery = {
    statuses, urgencies, serviceIds, since, until, assignedToMe: filter?.assignedToMe === true,
  };
  const params: Query = {
    statuses, urgencies, service_ids: serviceIds, since, until,
    user_ids: query.assignedToMe ? [me.userId] : undefined,
    team_ids: within.teamId ? [within.teamId] : undefined,
    date_range: filter?.allTime ? "all" : undefined,
    sort_by: "created_at:desc",
  };
  return { query, params };
}

/** Incidents, newest first, as pending actions leave them. */
export async function listIncidents(ctx: SessionContext, filter: PagerDutyIncidentFilter | undefined,
                                    within: Within): Promise<Cursor<PagerDutyIncidentSummary>> {
  const { host } = ctx;
  const me = await host.me();
  const { query, params } = incidentQuery(filter, within, me);
  const you = youRef(me);
  const resolve = (id: string) => host.resolve(id);
  // A row as pending actions leave it, or null once they move it out of the listing. A row is
  // simulated as it is served, since pending actions can change while the walk is open.
  const simulate = (row: PagerDutyIncidentSummary): PagerDutyIncidentSummary | null => {
    const simulated = overlayIncident(row, host.pending(), resolve, you);
    return matchesQuery(simulated, query, you) ? simulated : null;
  };
  const inScope = (payload: NewIncident) => (!within.serviceId || payload.service.id === within.serviceId)
    && inTeam(payload, within.teamId);
  const opened = () => pendingIncidents(host.pending(), resolve, you, inScope).filter(row => matchesQuery(row, query, you));
  // PagerDuty filters before pending changes apply, so it leaves out an incident they move into the
  // filter: each incident they act on is read afresh, and listed if they leave it matching. One the
  // user can no longer open is left out, as one outside the binding is.
  const current = (id: string) => currentIncident(ctx, id, within).catch((error: unknown) => {
    if (!isDenial(error)) throw error;
    return undefined;
  });
  const reads = query.serviceIds?.length === 0 ? [] : await Promise.all(changedIncidents(host.pending(), resolve).map(current));
  const changed = new Map(reads.flatMap(found => !found || found.outside ? [] : [[found.wire.id, toIncidentSummary(found.wire)] as const]));
  const injected = [...opened(), ...[...changed.values()].flatMap(row => simulate(row) ?? [])].toSorted(newestFirst);
  const named = (query.serviceIds ?? []).map(service);
  // Injected incidents show what staging or this call read of their services, and the cursor
  // authorizes no page made only of them, so their services are reported before the walk serves any.
  if (injected.length > 0) {
    await ctx.authorize({ title: "Listed PagerDuty incidents", description: `Read ${countOf(injected.length, "incident")} as pending changes leave them.` },
      { filter: named, result: injected.map(row => service(row.service.id)) });
  }
  return offsetCursor<WireIncident, PagerDutyIncidentSummary>(ctx, {
    pageSize: pageSizeOf(filter),
    // A filter naming none of a service binding's services matches nothing, so PagerDuty isn't asked.
    sources: [(api, offset, limit) => query.serviceIds?.length === 0
      ? Promise.resolve({ items: [], more: false })
      : api.page<WireIncident>("/incidents", "incidents", params, offset, limit)],
    convert: rows => rows.map(toIncidentSummary),
    describe: listed("Listed PagerDuty incidents", "incident"),
    filter: named,
    // One check per service rather than per incident: an incident is as visible as its service.
    result: rows => rows.map(row => service(row.service.id)),
    inject: {
      items: injected,
      compare: newestFirst,
      revalidate: row => {
        const read = changed.get(row.id);
        return read ? simulate(read) : opened().find(({ id }) => id === row.id) ?? null;
      },
      overlay: simulate,
      identity: row => resolve(row.id),
    },
  });
}

/**
 * Who is on call, as `GET /oncalls` answers for `params` with pending overrides applied, reporting
 * `fixed` even when empty; only `users`, when given.
 */
export async function listOnCalls(ctx: SessionContext, window: PagerDutyOnCallWindow | undefined, options: {
  params: Query; users?: readonly string[]; filter: readonly ObjectRef[]; fixed: readonly ObjectRef[]; none?: boolean;
}): Promise<PagerDutyOnCall[]> {
  const levels = window?.levels;
  if (levels !== undefined && (!Array.isArray(levels) || levels.some(level => !Number.isInteger(level) || level < 1))) {
    throw new Error("levels must be whole numbers from 1.");
  }
  const { host } = ctx;
  const pending = host.pending();
  const resolve = (id: string) => host.resolve(id);
  const since = time(window?.since, "since");
  const until = time(window?.until, "until");
  // A pending override can put a user on call where PagerDuty doesn't list them yet, so users and
  // the window are then picked out here instead.
  const overriding = overridesPending(pending, resolve);
  const params = { ...options.params, user_ids: overriding ? undefined : options.users, since, until };
  const rows = options.none ? [] : await host.read(api => api.all<WireOnCall>("/oncalls", "oncalls", params));
  const fetched = rows.map(toOnCall);
  // PagerDuty answers for the window, each end now by default, and an override can leave part of an
  // entry outside it. An empty window is the moment `from`; an entry without a start or end is open.
  const now = Date.now();
  const from = since ? Date.parse(since) : now;
  const to = Math.max(until ? Date.parse(until) : now, from + 1);
  const simulated = !overriding ? fetched : overlayOnCalls(fetched, pending, resolve).filter(entry =>
    (!options.users || options.users.includes(entry.user.id))
    && (entry.start === null || Date.parse(entry.start) < to) && (entry.end === null || Date.parse(entry.end) > from));
  const entries = simulated.filter(entry => !levels || levels.includes(entry.level));
  await ctx.authorize({ title: "Listed who is on call in PagerDuty", description: `Read ${countOf(entries.length, "on-call entry")}.` }, {
    filter: options.filter,
    result: [...options.fixed, ...entries.flatMap(entry => [
      escalationPolicy(entry.escalationPolicy.id), ...(entry.schedule ? [schedule(entry.schedule.id)] : []),
    ])],
  });
  return entries;
}

/** Binds `hook` to events on the incidents `ctx` reaches: those `within`, or the one `incidentId` names. */
export function subscribed(ctx: SessionContext, hook: RpcStub<PagerDutyEventHookTarget>,
                           options: PagerDutySubscribeOptions | undefined, within: Within, incidentId?: string): Promise<void> {
  return ctx.host.subscribe(ctx.queue, hook, options, { scope: ctx.scope, within, ...(incidentId ? { incidentId } : {}) });
}
