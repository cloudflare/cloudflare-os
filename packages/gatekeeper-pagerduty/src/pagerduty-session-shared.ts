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
import {
  MAX_LIMIT, chainedPage, isDenial, listing, scheduleListings, schedulePath, type OffsetSource, type PagerDutyApi, type Query,
} from "./pagerduty-api";
import { isProvisional, type PagerDutyActions, type PriorityTarget, type UserTarget } from "./pagerduty-actions";
import { subresourceId, type Identity, type ObjectKind } from "./pagerduty-credentials";
import type { Tenant } from "./pagerduty-env";
import {
  toIncidentSummary, toOnCall, toPriority, toScheduleSummary, toServiceSummary, toTeam, toUser, toUserRef,
  type Schedule, type WireIncident, type WireOnCall, type WirePriority, type WireRef, type WireSchedule, type WireService,
  type WireUser,
} from "./pagerduty-normalize";
import {
  changedIncidents, matchesQuery, newestFirst, overlayIncident, overlayOnCalls, overridingUsers, pendingIncidents,
  type IncidentQuery, type Pending,
} from "./pagerduty-simulation";
import { OBJECT_ID, objectId } from "./pagerduty-urls";
import type { PagerDutyEventHookTarget } from "./pagerduty-hooks";
import type {
  Cursor, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyListOptions, PagerDutyOnCall,
  PagerDutyOnCallWindow, PagerDutyPageOptions, PagerDutyPriority, PagerDutyScheduleSummary, PagerDutyServiceSummary,
  PagerDutySubscribeOptions, PagerDutyTeamSummary, PagerDutyTimeWindow, PagerDutyUser,
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

/** The capability a hook subscribed through: its scope, and its incident, if one. */
export type HookScope = { scope: readonly ObjectRef[]; incidentId?: string };

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
  readonly resolve: (id: string) => string;
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

/**
 * What one capability owns: the gatekeeper host, its own approval-queue stub, and its scope -- the
 * objects every read through it depends on besides the account, whose team and service bound what
 * it may reach. A capability handed out takes a duplicate stub, so disposing one never disturbs another.
 */
export class SessionContext implements Disposable {
  readonly within: Within;

  constructor(readonly host: SessionHost, readonly queue: RpcStub<ApprovalQueue>, readonly scope: readonly ObjectRef[]) {
    this.within = withinOf(scope);
  }

  dup(): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), this.scope);
  }

  /** A context for an object opened from this one, which every read through it also depends on. */
  opening(object: ObjectRef): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), [...this.scope, object]);
  }

  /**
   * Authorizes a read, reporting the account, this capability's scope, and `objects`: those the
   * read's filter names and its result shows. Every read goes through here, whether it found
   * anything or came from cache, so no read can leave out the account or the scope.
   */
  async authorize(observation: ObservationInput, objects: readonly ObjectRef[] = []): Promise<void> {
    const { region, accountId } = await this.host.me();
    const account = { region, accountId };
    const reported = [...this.scope, ...objects].filter(({ id }) => !isProvisional(id));
    await this.queue.authorizeObservation({
      ...observation,
      subresources: [...new Set([subresourceId(account), ...reported.map(object => subresourceId(account, object))])],
    });
  }

  [Symbol.dispose](): void {
    this.queue[Symbol.dispose]();
  }
}

/** The objects a capability may reach beyond itself: those in this team, or on this service. */
export type Within = { teamId?: string; serviceId?: string };

/** What a capability with `scope` may reach: its scope's team and service, if any. */
export function withinOf(scope: readonly ObjectRef[]): Within {
  return { teamId: scope.find(({ kind }) => kind === "team")?.id, serviceId: scope.find(({ kind }) => kind === "service")?.id };
}

/** Names the object of `kind` a read depends on. */
const refOf = (kind: ObjectKind) => (id: string): ObjectRef => ({ kind, id });
export const team = refOf("team");
export const service = refOf("service");
export const incident = refOf("incident");
export const schedule = refOf("schedule");
export const escalationPolicy = refOf("escalation_policy");

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
export function text(value: string, what: string, max = Infinity): string {
  if (value.trim() === "") throw new Error(`${what} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${what} can be at most ${max} characters.`);
  return value;
}

/** An agent-supplied ISO 8601 time, normalized, or undefined when none was given. */
export function time(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${what} must be an ISO 8601 time.`);
  return new Date(value).toISOString();
}

/** Agent-supplied object IDs, each checked, or undefined when none were given. */
export function ids(values: readonly string[] | undefined, what: string): string[] | undefined {
  return values?.map(value => objectId(value, what));
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
  // The probe serves a read that asks for nothing more; v2 has no `users` to include.
  if (probed.schedule && !window && !(users && shiftBased)) return probed.schedule;
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

/**
 * The services a capability's incidents are on, or undefined for an account's: its team's, as
 * PagerDuty lists them now (cached briefly, as `cachedService()` is), and its own.
 */
async function servicesWithin({ host, within: { teamId, serviceId } }: SessionContext): Promise<string[] | undefined> {
  const teamServices = teamId === undefined ? undefined : await host.cached(`team-services:${teamId}`, SERVICE_TTL_MS, async () =>
    (await host.read(api => api.all<WireRef>("/services", "services", { team_ids: [teamId] }))).map(({ id }) => id));
  return serviceId === undefined ? teamServices : (teamServices ?? [serviceId]).filter(id => id === serviceId);
}

/** Whether `owned` belongs to team `teamId`, as one of its teams; anything does when there's none. */
const inTeam = (owned: { teams?: readonly { id: string }[] }, teamId: string | undefined): boolean =>
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
  await ctx.authorize({ title: "Looked up PagerDuty users", description: `Found ${countOf(users.length, "user")}.` });
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
  await ctx.authorize({ title: "Listed PagerDuty priorities", description: `Listed ${countOf(rows.length, "priority")}.` });
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
  if (given.length === 0) throw new Error(`${what} must name at least one user.`);
  return await Promise.all(given.map(async value => {
    text(value, what);
    const user = OBJECT_ID.test(value)
      ? (await ctx.host.read(api => api.get<{ user: WireUser }>(`/users/${value}`))).user
      : (await ctx.host.read(api => api.all<WireUser>("/users", "users", { query: value }, MAX_USERS)))
        .find(({ email }) => email.toLowerCase() === value.toLowerCase());
    if (!user) throw new Error(`No PagerDuty user has the email ${value}.`);
    return { ...toUserRef(user), given: value };
  }));
}

/**
 * Listings walked by offset, one after another, authorizing each page as it leaves: the cursor
 * owns a duplicate of the capability's queue stub and releases it when the walk is dropped.
 */
export function offsetCursor<T>(ctx: SessionContext, options: {
  pageSize: number;
  /** The listings walked in turn; pending actions apply as rows are served, in `overlay` and `inject`. */
  sources: readonly OffsetSource<T>[];
  describe(rows: readonly T[], terminal: boolean): ObservationInput;
  /** What the listing's filter names, reported with every page. */
  filter?: readonly ObjectRef[];
  /** What a page shows, as it is served: a page it throws for is refused. */
  result(rows: readonly T[]): ObjectRef[] | Promise<ObjectRef[]>;
  overlay?(row: T): T | null;
  inject?: CursorInjection<T>;
  beforePage?(): Promise<void>;
}): Cursor<T> {
  const { pageSize, sources, describe, filter = [], result, ...hooks } = options;
  const walk = ctx.dup();
  return new TokenCursor<T>({
    ...hooks,
    pageSize,
    remotePageSize: Math.max(pageSize, DEFAULT_PAGE_SIZE),
    dispose: () => walk[Symbol.dispose](),
    fetchPage: (token, perPage) => walk.host.read(api => chainedPage(api, sources, token, perPage)),
    authorizePage: async (rows, { terminal }) => walk.authorize(describe(rows, terminal), [...filter, ...await result(rows)]),
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
function namedListing<T extends { id: string }>(ctx: SessionContext, kind: "service" | "team" | "schedule",
                                               list: PagerDutyListOptions | undefined, teamId: string | undefined,
                                               sources: (filters: Query) => readonly OffsetSource<T>[]): Cursor<T> {
  const query = list?.query === undefined ? undefined : text(list.query, "query", 200);
  return offsetCursor<T>(ctx, {
    pageSize: pageSizeOf(list),
    sources: sources({ query, ...(teamId ? { team_ids: [teamId] } : {}) }),
    describe: listed(`Listed PagerDuty ${plural(kind)}`, kind),
    result: rows => rows.map(({ id }) => ({ kind, id })),
  });
}

/** Services, by name. */
export const listServices = (ctx: SessionContext, list: PagerDutyListOptions | undefined,
                             teamId?: string): Cursor<PagerDutyServiceSummary> =>
  namedListing(ctx, "service", list, teamId,
    filters => [listing("/services", "services", { ...filters, sort_by: "name" }, toServiceSummary)]);

/** The account's teams. */
export const listTeams = (ctx: SessionContext, list: PagerDutyListOptions | undefined): Cursor<PagerDutyTeamSummary> =>
  namedListing(ctx, "team", list, undefined, filters => [listing("/teams", "teams", filters, toTeam)]);

/** Schedules: layer-based ones, by name, then shift-based ones, which PagerDuty lists apart. */
export const listSchedules = (ctx: SessionContext, list: PagerDutyListOptions | undefined,
                              teamId?: string): Cursor<PagerDutyScheduleSummary> =>
  namedListing(ctx, "schedule", list, teamId,
    filters => scheduleListings(filters, (wire: WireSchedule, shiftBased) => toScheduleSummary({ ...wire, shiftBased })));

/** The most services a team's incident listing names in its URL, about 2.6 KB of it. */
const MAX_QUERY_SERVICES = 100;

/**
 * The defaults and bounds of an incident filter, as PagerDuty's query and the simulation's, on
 * the services `scope` names, if any, which are team `teamId`'s, if any.
 */
function incidentQuery(filter: PagerDutyIncidentFilter | undefined, scope: string[] | undefined, me: Identity,
                       teamId?: string): { query: IncidentQuery; params: Query } {
  const statuses = filter?.statuses ?? ["triggered", "acknowledged"];
  const urgencies = filter?.urgencies;
  const requested = ids(filter?.serviceIds, "serviceIds");
  const serviceIds = scope && requested ? requested.filter(id => scope.includes(id)) : requested ?? scope;
  // PagerDuty relates an incident to every team involved in it, so a team's incidents are asked
  // for by its services, as everything else in a team binding has them. A team with too many for
  // a URL is asked for by team, and `listIncidents` drops rows on services outside `query`.
  const byTeam = teamId !== undefined && (serviceIds?.length ?? 0) > MAX_QUERY_SERVICES;
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
    statuses, urgencies, since, until,
    ...byTeam ? { team_ids: [teamId] } : { service_ids: serviceIds },
    user_ids: query.assignedToMe ? [me.userId] : undefined,
    date_range: filter?.allTime ? "all" : undefined,
    sort_by: "created_at:desc",
  };
  return { query, params };
}

/** Incidents, newest first, as pending actions leave them. */
export async function listIncidents(ctx: SessionContext, filter: PagerDutyIncidentFilter | undefined):
  Promise<Cursor<PagerDutyIncidentSummary>> {
  const { host } = ctx;
  const [me, scope] = await Promise.all([host.me(), servicesWithin(ctx)]);
  const { query, params } = incidentQuery(filter, scope, me, ctx.within.teamId);
  const you = youRef(me);
  const { resolve } = host;
  // A filter naming none of the capability's services matches nothing, so PagerDuty isn't asked.
  const nothing = query.serviceIds?.length === 0;
  // PagerDuty filters before pending changes apply, so it leaves out an incident they move into the
  // filter: each incident they act on is read afresh, and listed if they leave it matching. One the
  // user can no longer open is left out, as one outside the binding is.
  const current = (id: string) => readIncident(ctx, id).catch((error: unknown) => {
    if (!isDenial(error)) throw error;
    return undefined;
  });
  const reads = nothing ? [] : await Promise.all(changedIncidents(host.pending(), resolve).map(current));
  const changed = new Map(reads.flatMap(wire => wire ? [[wire.id, toIncidentSummary(wire)] as const] : []));
  // The capability's services and the pending actions as of the page being served: a service can
  // leave the team, and actions can change, while the walk is open.
  let live = scope;
  let pending = host.pending();
  // Whether a row, as pending actions leave it, is still on one of those services and in the filter.
  const keeps = (row: PagerDutyIncidentSummary) =>
    (!live || live.includes(row.service.id)) && matchesQuery(row, query, you);
  const simulate = (row: PagerDutyIncidentSummary): PagerDutyIncidentSummary | null => {
    const simulated = overlayIncident(row, pending, resolve, you);
    return keeps(simulated) ? simulated : null;
  };
  const opened = () => pendingIncidents(pending, resolve, you).filter(keeps);
  const injected = [...opened(), ...[...changed.values()].flatMap(row => simulate(row) ?? [])].toSorted(newestFirst);
  const named = (filter?.serviceIds ? query.serviceIds ?? [] : []).map(service);
  // Injected incidents show what staging or this call read of their services, and the cursor
  // authorizes no page made only of them, so their services are reported before the walk serves any.
  if (injected.length > 0) {
    await ctx.authorize({ title: "Listed PagerDuty incidents", description: `Read ${countOf(injected.length, "incident")} as pending changes leave them.` },
      [...named, ...injected.map(row => service(row.service.id))]);
  }
  return offsetCursor<PagerDutyIncidentSummary>(ctx, {
    pageSize: pageSizeOf(filter),
    sources: [nothing ? async () => ({ items: [], more: false }) : listing("/incidents", "incidents", params, toIncidentSummary)],
    beforePage: async () => {
      live = await servicesWithin(ctx);
      pending = host.pending();
    },
    describe: listed("Listed PagerDuty incidents", "incident"),
    filter: named,
    // One check per service rather than per incident: an incident is as visible as its service.
    result: rows => rows.map(row => service(row.service.id)),
    overlay: simulate,
    inject: {
      items: injected,
      compare: newestFirst,
      revalidate: row => {
        const read = changed.get(row.id);
        return read ? simulate(read) : opened().find(({ id }) => id === row.id) ?? null;
      },
      identity: row => resolve(row.id),
    },
  });
}

/**
 * Who is on call, as `GET /oncalls` answers for `params` with pending overrides applied, reporting
 * what `filter` names even when the answer is empty; only `users`, when given.
 */
export async function listOnCalls(ctx: SessionContext, window: PagerDutyOnCallWindow | undefined, options: {
  params: Query; users?: readonly string[]; filter: readonly ObjectRef[]; none?: boolean;
}): Promise<PagerDutyOnCall[]> {
  const levels = window?.levels;
  if (levels?.some(level => !Number.isInteger(level) || level < 1)) {
    throw new Error("levels must be whole numbers from 1.");
  }
  const { host } = ctx;
  const pending = host.pending();
  const { resolve } = host;
  const since = time(window?.since, "since");
  const until = time(window?.until, "until");
  // A pending override can put a user on call where PagerDuty doesn't list them yet, and cut short
  // the entry it covers, so entries are then split and picked out here; users too, when the filter
  // names one an override puts on call, as PagerDuty would leave out the entry they cover.
  const overriding = overridingUsers(pending, resolve);
  const covering = options.users?.some(id => overriding.includes(id));
  const params = { ...options.params, user_ids: covering ? undefined : options.users, since, until };
  const rows = options.none ? [] : await host.read(api => api.all<WireOnCall>("/oncalls", "oncalls", params));
  const fetched = rows.map(toOnCall);
  // PagerDuty answers for the window, each end now by default, and an override can leave part of an
  // entry outside it. An empty window is the moment `from`; an entry without a start or end is open.
  const now = Date.now();
  const from = since ? Date.parse(since) : now;
  const to = Math.max(until ? Date.parse(until) : now, from + 1);
  const simulated = overriding.length === 0 ? fetched : overlayOnCalls(fetched, pending, resolve).filter(entry =>
    (!options.users || options.users.includes(entry.user.id))
    && (entry.start === null || Date.parse(entry.start) < to) && (entry.end === null || Date.parse(entry.end) > from));
  const entries = simulated.filter(entry => !levels || levels.includes(entry.level));
  await ctx.authorize({ title: "Listed who is on call in PagerDuty", description: `Read ${countOf(entries.length, "on-call entry")}.` }, [
    ...options.filter,
    ...entries.flatMap(entry => [escalationPolicy(entry.escalationPolicy.id), ...(entry.schedule ? [schedule(entry.schedule.id)] : [])]),
  ]);
  return entries;
}

/** Binds `hook` to events on the incidents `ctx` reaches: those it is within, or the one `incidentId` names. */
export function subscribed(ctx: SessionContext, hook: RpcStub<PagerDutyEventHookTarget>,
                           options: PagerDutySubscribeOptions | undefined, incidentId?: string): Promise<void> {
  return ctx.host.subscribe(ctx.queue, hook, options, { scope: ctx.scope, ...(incidentId ? { incidentId } : {}) });
}
