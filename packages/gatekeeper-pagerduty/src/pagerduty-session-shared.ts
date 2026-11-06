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
import { MAX_LIMIT, MAX_OFFSET, type Page, type PagerDutyApi, type Query } from "./pagerduty-api";
import { isProvisional, type PagerDutyActions, type PriorityTarget, type UserTarget } from "./pagerduty-actions";
import { subresourceId, type Identity, type ObjectKind } from "./pagerduty-credentials";
import type { Tenant } from "./pagerduty-env";
import {
  toIncidentSummary, toOnCall, toPriority, toUser,
  type WireIncident, type WireOnCall, type WirePriority, type WireRef, type WireService, type WireUser,
} from "./pagerduty-normalize";
import {
  matchesQuery, newestFirst, overlayIncident, pendingIncidents, type IncidentQuery, type Pending,
} from "./pagerduty-simulation";
import { OBJECT_ID, objectId } from "./pagerduty-urls";
import type { PagerDutyEventHookTarget } from "./pagerduty-hooks";
import type {
  Cursor, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyListOptions, PagerDutyOnCall,
  PagerDutyOnCallWindow, PagerDutyPageOptions, PagerDutyPriority, PagerDutySubscribeOptions, PagerDutyTimeWindow,
  PagerDutyUrgency, PagerDutyUser,
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
  /** Allocates a temporary ID for something a pending action creates. */
  allocate(kind: "incident" | "note" | "override"): string;
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
export const youOf = (me: Identity) => ({ id: me.userId, name: me.name });

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

/** A service's team and escalation policy, cached briefly, for checking a binding's scope. */
export function cachedService(ctx: { host: SessionHost }, id: string): Promise<WireService> {
  return ctx.host.cached(`service:${id}`, SERVICE_TTL_MS, () => readService(ctx, id));
}

/** @throws Error unless `wire` belongs to team `teamId`. */
export function requireTeam(wire: { teams?: WireRef[] }, teamId: string | undefined, what: string): void {
  if (teamId !== undefined && !wire.teams?.some(({ id }) => id === teamId)) {
    throw new Error(`That ${what} doesn't belong to this team.`);
  }
}

/**
 * Why an incident on service `serviceId` is outside a capability's team or service, or undefined
 * when it is within.
 */
export async function outsideOf(ctx: { host: SessionHost }, serviceId: string, within: Within): Promise<string | undefined> {
  if (within.serviceId && serviceId !== within.serviceId) return "That incident belongs to another service.";
  if (within.teamId && !(await cachedService(ctx, serviceId)).teams?.some(({ id }) => id === within.teamId)) {
    return "That incident doesn't belong to this team.";
  }
  return undefined;
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

/**
 * A listing walked by offset, authorizing each page as it leaves: the cursor owns a duplicate of
 * the capability's queue stub and releases it when the walk is dropped.
 */
export function offsetCursor<W, T>(ctx: SessionContext, options: {
  pageSize: number;
  fetch(api: PagerDutyApi, offset: number, limit: number): Promise<Page<W>>;
  /** Converts a page, applying pending actions; may drop rows they move out of the listing. */
  convert(rows: W[]): T[];
  describe(rows: readonly T[], terminal: boolean): ObservationInput;
  filter: readonly ObjectRef[];
  result(rows: readonly T[]): ObjectRef[];
  inject?: CursorInjection<T>;
}): Cursor<T> {
  const walk = ctx.dup();
  return new TokenCursor<T>({
    pageSize: options.pageSize,
    remotePageSize: Math.max(options.pageSize, DEFAULT_PAGE_SIZE),
    dispose: () => walk[Symbol.dispose](),
    ...(options.inject ? { inject: options.inject } : {}),
    fetchPage: async (token, perPage) => {
      const offset = token === undefined ? 0 : Number(token);
      const page = await walk.host.read(api => options.fetch(api, offset, Math.min(perPage, MAX_OFFSET - offset)));
      const next = offset + page.items.length;
      // PagerDuty refuses an offset past its cap, so the walk ends there.
      const more = page.more && page.items.length > 0 && next < MAX_OFFSET;
      return { items: options.convert(page.items), ...(more ? { nextToken: String(next) } : {}) };
    },
    authorizePage: (rows, { terminal }) =>
      walk.authorize(options.describe(rows, terminal), { filter: options.filter, result: options.result(rows) }),
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
 * A name-sorted listing of services, teams or schedules, reporting each row: a team's listing too,
 * since PagerDuty showing the team needn't mean it shows everything the team owns.
 */
export function namedListing<W extends WireRef, T extends { id: string }>(ctx: SessionContext, options: {
  path: string; key: string; kind: ObjectKind; noun: string; teamId?: string;
  list?: PagerDutyListOptions; convert(wire: W): T;
}): Cursor<T> {
  const query = options.list?.query === undefined ? undefined : text(options.list.query, "query", 200);
  const filters: Query = { query, ...(options.teamId ? { team_ids: [options.teamId] } : {}) };
  if (options.kind === "service") filters.sort_by = "name";
  return offsetCursor<W, T>(ctx, {
    pageSize: pageSizeOf(options.list),
    fetch: (api, offset, limit) => api.page<W>(options.path, options.key, filters, offset, limit),
    convert: rows => rows.map(options.convert),
    describe: listed(`Listed PagerDuty ${plural(options.noun)}`, options.noun),
    filter: [],
    result: rows => rows.map(({ id }) => ({ kind: options.kind, id })),
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
  const you = youOf(me);
  const overlay = (row: PagerDutyIncidentSummary) => overlayIncident(row, host.pending(), id => host.resolve(id), you);
  const inScope = (row: PagerDutyIncidentSummary) => (!within.serviceId || row.service.id === within.serviceId)
    && (!within.teamId || row.team?.id === within.teamId);
  const fresh = () => pendingIncidents(host.pending(), id => host.resolve(id), you)
    .filter(row => inScope(row) && matchesQuery(row, query, you));
  const injected = fresh().toSorted(newestFirst);
  return offsetCursor<WireIncident, PagerDutyIncidentSummary>(ctx, {
    pageSize: pageSizeOf(filter),
    // A filter naming none of a service binding's services matches nothing, so PagerDuty isn't asked.
    fetch: (api, offset, limit) => query.serviceIds?.length === 0
      ? Promise.resolve({ items: [], more: false })
      : api.page<WireIncident>("/incidents", "incidents", params, offset, limit),
    convert: rows => rows.map(row => overlay(toIncidentSummary(row))).filter(row => matchesQuery(row, query, you)),
    describe: listed("Listed PagerDuty incidents", "incident"),
    // A pending incident shows what staging read of its service, and the cursor never passes it to
    // `result`, so every page of the walk reports that service.
    filter: [...query.serviceIds ?? [], ...injected.map(row => row.service.id)].map(service),
    // One check per service rather than per incident: an incident is as visible as its service.
    result: rows => rows.map(row => service(row.service.id)),
    inject: {
      items: injected,
      compare: newestFirst,
      revalidate: row => fresh().find(({ id }) => id === row.id) ?? null,
      identity: row => host.resolve(row.id),
    },
  });
}

/** Who is on call, as `GET /oncalls` answers for `params`, reporting `fixed` even when empty. */
export async function listOnCalls(ctx: SessionContext, window: PagerDutyOnCallWindow | undefined, options: {
  params: Query; filter: readonly ObjectRef[]; fixed: readonly ObjectRef[]; none?: boolean;
}): Promise<PagerDutyOnCall[]> {
  const levels = window?.levels;
  if (levels !== undefined && (!Array.isArray(levels) || levels.some(level => !Number.isInteger(level) || level < 1))) {
    throw new Error("levels must be whole numbers from 1.");
  }
  const params = { ...options.params, since: time(window?.since, "since"), until: time(window?.until, "until") };
  const rows = options.none ? [] : await ctx.host.read(api => api.all<WireOnCall>("/oncalls", "oncalls", params));
  const entries = rows.map(toOnCall).filter(entry => !levels || levels.includes(entry.level));
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
