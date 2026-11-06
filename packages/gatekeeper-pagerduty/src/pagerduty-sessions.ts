// The capabilities a gadget holds: the account, team, service, incident and schedule sessions, each
// also what a broader one returns when it opens an object. Every read fetches as the connected
// user, replays pending actions over the result, and authorizes the observation before returning,
// reporting the account, the objects the capability is scoped to, those its filter names and those
// its result shows (see `SessionContext.authorize`). Every write validates, then stages an action;
// none reaches PagerDuty before approval.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import { ArrayCursor, TokenCursor, type CursorInjection } from "@gadgets/gatekeeper-kit/cursors";
import type { ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import { MAX_LIMIT, MAX_OFFSET, type Page, type PagerDutyApi, type Query } from "./pagerduty-api";
import {
  isProvisional, type IncidentTarget, type NewIncident, type PagerDutyActions, type PriorityTarget, type UserTarget,
} from "./pagerduty-actions";
import { subresourceId, youOf, type Identity, type ObjectKind } from "./pagerduty-credentials";
import { webOrigin, type Tenant } from "./pagerduty-env";
import {
  toAlert, toIncidentDetails, toIncidentSummary, toMember, toNote, toOnCall, toOverride, toPriority, toRef,
  toScheduleDetails, toScheduleSummary, toServiceDetails, toServiceSummary, toShift, toTeam, toTimelineEntry, toUser,
  type WireAlert, type WireIncident, type WireLogEntry, type WireMember, type WireNote, type WireOnCall,
  type WireOverride, type WirePriority, type WireRef, type WireSchedule, type WireService, type WireTeam, type WireUser,
} from "./pagerduty-normalize";
import {
  matchesQuery, newestFirst, overlayIncident, overlayOverrides, overlayShifts, pendingIncident, pendingIncidents,
  pendingNotes, type IncidentQuery, type Pending,
} from "./pagerduty-simulation";
import { OBJECT_ID, objectId } from "./pagerduty-urls";
import type {
  Cursor, PagerDutyAccount, PagerDutyAccountMetadata, PagerDutyAlert, PagerDutyCreateIncidentOptions, PagerDutyIncident,
  PagerDutyIncidentDetails, PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyListOptions, PagerDutyNote,
  PagerDutyOnCall, PagerDutyOnCallFilter, PagerDutyOnCallWindow, PagerDutyOverride, PagerDutyPageOptions,
  PagerDutyPriority, PagerDutyResponderRequest, PagerDutySchedule, PagerDutyScheduleDetails, PagerDutyScheduleSummary,
  PagerDutyService, PagerDutyServiceDetails, PagerDutyServiceSummary, PagerDutyShift, PagerDutyTeam,
  PagerDutyTeamMember, PagerDutyTeamMetadata, PagerDutyTeamSummary, PagerDutyTimeWindow, PagerDutyTimelineEntry,
  PagerDutyUrgency, PagerDutyUser,
} from "./types";

/** How long a service's team and escalation policy, read to check a binding's scope, stay cached. */
const SERVICE_TTL_MS = 5 * 60_000;
/** How long the account's priorities and a team's escalation policies stay cached. */
const CATALOG_TTL_MS = 10 * 60_000;
/** Listings' default page size. */
const DEFAULT_PAGE_SIZE = 25;
/** How far back incident listings reach by default. */
const DEFAULT_INCIDENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** The most users `findUsers` returns. */
const MAX_USERS = 50;
/** PagerDuty's longest note. */
const MAX_NOTE_LENGTH = 25_000;
/** PagerDuty's longest snooze. */
const MAX_SNOOZE_SECONDS = 604_800;
/** The longest schedule window PagerDuty renders shifts for. */
const MAX_SHIFT_DAYS = 90;

const HOOKS_UNAVAILABLE = "PagerDuty hooks are not configured on this deployment.";

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
type Within = { teamId?: string; serviceId?: string };

const team = (id: string): ObjectRef => ({ kind: "team", id });
const service = (id: string): ObjectRef => ({ kind: "service", id });
const incident = (id: string): ObjectRef => ({ kind: "incident", id });
const schedule = (id: string): ObjectRef => ({ kind: "schedule", id });
const escalationPolicy = (id: string): ObjectRef => ({ kind: "escalation_policy", id });

const countOf = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Validation

function pageSizeOf(options: PagerDutyPageOptions | undefined): number {
  const size = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
    throw new Error(`pageSize must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return size;
}

function text(value: unknown, what: string, max = Infinity): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${what} can be at most ${max} characters.`);
  return value;
}

function time(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${what} must be an ISO 8601 time.`);
  return new Date(value).toISOString();
}

function urgency(value: unknown): PagerDutyUrgency {
  if (value !== "high" && value !== "low") throw new Error('urgency must be "high" or "low".');
  return value;
}

function ids(values: readonly string[] | undefined, what: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${what} must be an array of PagerDuty IDs.`);
  return values.map(value => objectId(value, what));
}

/** A window between ISO times, defaulting to `days` from now and at most `maxDays` long. */
function windowOf(window: PagerDutyTimeWindow | undefined, days: number, maxDays = Infinity): { since: string; until: string } {
  const since = time(window?.since, "since") ?? new Date().toISOString();
  const until = time(window?.until, "until") ?? new Date(Date.parse(since) + days * DAY_MS).toISOString();
  if (Date.parse(until) <= Date.parse(since)) throw new Error("until must be after since.");
  if (Date.parse(until) - Date.parse(since) > maxDays * DAY_MS) throw new Error(`since and until can be at most ${maxDays} days apart.`);
  return { since, until };
}

// ---------------------------------------------------------------------------
// Shared reads

/** A service as PagerDuty describes it now. */
async function readService(ctx: SessionContext, id: string): Promise<WireService> {
  return (await ctx.host.read(api => api.get<{ service: WireService }>(`/services/${id}`))).service;
}

/** A service's team and escalation policy, cached briefly, for checking a binding's scope. */
function cachedService(ctx: SessionContext, id: string): Promise<WireService> {
  return ctx.host.cached(`service:${id}`, SERVICE_TTL_MS, () => readService(ctx, id));
}

/** @throws Error unless `wire` belongs to team `teamId`. */
function requireTeam(wire: { teams?: WireRef[] }, teamId: string | undefined, what: string): void {
  if (teamId !== undefined && !wire.teams?.some(({ id }) => id === teamId)) {
    throw new Error(`That ${what} doesn't belong to this team.`);
  }
}

/** Every user matching `query`, up to `MAX_USERS`. */
async function findUsers(ctx: SessionContext, query: string | undefined): Promise<PagerDutyUser[]> {
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

async function listPriorities(ctx: SessionContext): Promise<PagerDutyPriority[]> {
  const rows = await priorities(ctx);
  await ctx.authorize({ title: "Listed PagerDuty priorities", description: `Listed ${countOf(rows.length, "priority")}.` },
    { filter: [], result: [] });
  return rows.map(toPriority);
}

/** A priority named by the agent, for an action's payload. */
async function priorityNamed(ctx: SessionContext, name: string): Promise<PriorityTarget> {
  text(name, "priority");
  const match = (await priorities(ctx)).find(priority => priority.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`There is no priority named "${name}"; listPriorities() lists them.`);
  return { id: match.id, name: match.name };
}

/** Users named by email or ID, for an action's payload or a filter. */
async function usersNamed(ctx: SessionContext, given: readonly string[], what: string): Promise<UserTarget[]> {
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
function offsetCursor<W, T>(ctx: SessionContext, options: {
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
function listed(title: string, noun: string) {
  return (rows: readonly unknown[], terminal: boolean): ObservationInput => ({
    title,
    description: rows.length > 0 ? `Read ${countOf(rows.length, noun)}.`
      : terminal ? `Listed ${noun}s; there were none.` : `Scanned ${noun}s; none were in this window.`,
  });
}

/**
 * A name-sorted listing of services, teams or schedules. A team's own listings report nothing per
 * row, since the team's scope covers what it owns; the account's report each row.
 */
function namedListing<W extends WireRef, T>(ctx: SessionContext, options: {
  path: string; key: string; kind: ObjectKind; noun: string; teamId?: string;
  list?: PagerDutyListOptions; convert(wire: W): T;
}): Cursor<T> {
  const query = options.list?.query === undefined ? undefined : text(options.list.query, "query", 200);
  const filters: Query = { query, ...(options.teamId ? { team_ids: [options.teamId] } : {}) };
  if (options.kind === "service") filters.sort_by = "name";
  const ids = new Map<T, string>();
  return offsetCursor<W, T>(ctx, {
    pageSize: pageSizeOf(options.list),
    fetch: (api, offset, limit) => api.page<W>(options.path, options.key, filters, offset, limit),
    convert: rows => rows.map(row => {
      const converted = options.convert(row);
      ids.set(converted, row.id);
      return converted;
    }),
    describe: listed(`Listed PagerDuty ${options.noun}s`, options.noun),
    filter: [],
    result: rows => options.teamId ? [] : rows.map(row => ({ kind: options.kind, id: ids.get(row)! })),
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
async function listIncidents(ctx: SessionContext, filter: PagerDutyIncidentFilter | undefined,
                             within: Within): Promise<Cursor<PagerDutyIncidentSummary>> {
  const { host } = ctx;
  const me = await host.me();
  const { query, params } = incidentQuery(filter, within, me);
  const you = { id: me.userId, name: me.name };
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
async function listOnCalls(ctx: SessionContext, window: PagerDutyOnCallWindow | undefined, options: {
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

const unsupportedHooks = (): never => {
  throw new Error(HOOKS_UNAVAILABLE);
};

// ---------------------------------------------------------------------------
// Account

@validateRpc()
export class PagerDutyAccountImpl extends RpcTarget implements PagerDutyAccount {
  readonly #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  async getMetadata(): Promise<PagerDutyAccountMetadata> {
    const me = await this.#ctx.host.me();
    await this.#ctx.authorize({ title: "Read the PagerDuty account", description: "Read the account and the connected user." },
      { filter: [], result: [] });
    return { subdomain: me.subdomain, htmlUrl: webOrigin(me), you: youOf(me) };
  }

  async listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>> {
    return await listIncidents(this.#ctx, filter, {});
  }

  async getIncident(idOrNumber: string): Promise<PagerDutyIncident> {
    return await PagerDutyIncidentImpl.open(this.#ctx, idOrNumber, {});
  }

  async listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>> {
    return namedListing<WireService, PagerDutyServiceSummary>(this.#ctx,
      { path: "/services", key: "services", kind: "service", noun: "service", list: options, convert: toServiceSummary });
  }

  async getService(id: string): Promise<PagerDutyService> {
    objectId(id, "id");
    return new PagerDutyServiceImpl(this.#ctx.within(service(id)), id, {});
  }

  async listTeams(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyTeamSummary>> {
    return namedListing<WireTeam, PagerDutyTeamSummary>(this.#ctx,
      { path: "/teams", key: "teams", kind: "team", noun: "team", list: options, convert: toTeam });
  }

  async getTeam(id: string): Promise<PagerDutyTeam> {
    objectId(id, "id");
    return new PagerDutyTeamImpl(this.#ctx.within(team(id)), id);
  }

  async listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>> {
    return namedListing<WireSchedule, PagerDutyScheduleSummary>(this.#ctx,
      { path: "/schedules", key: "schedules", kind: "schedule", noun: "schedule", list: options, convert: toScheduleSummary });
  }

  async getSchedule(id: string): Promise<PagerDutySchedule> {
    objectId(id, "id");
    return new PagerDutyScheduleImpl(this.#ctx.within(schedule(id)), id, {});
  }

  async listOnCalls(filter?: PagerDutyOnCallFilter): Promise<PagerDutyOnCall[]> {
    const scheduleIds = ids(filter?.scheduleIds, "scheduleIds");
    const policyIds = ids(filter?.escalationPolicyIds, "escalationPolicyIds");
    const users = filter?.users === undefined ? undefined : await usersNamed(this.#ctx, filter.users, "users");
    return await listOnCalls(this.#ctx, filter, {
      params: { user_ids: users?.map(({ id }) => id), schedule_ids: scheduleIds, escalation_policy_ids: policyIds },
      filter: [...(scheduleIds ?? []).map(schedule), ...(policyIds ?? []).map(escalationPolicy)],
      fixed: [],
    });
  }

  async findUsers(query?: string): Promise<PagerDutyUser[]> {
    return await findUsers(this.#ctx, query);
  }

  async listPriorities(): Promise<PagerDutyPriority[]> {
    return await listPriorities(this.#ctx);
  }

  async subscribe(): Promise<void> {
    unsupportedHooks();
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Team

@validateRpc()
export class PagerDutyTeamImpl extends RpcTarget implements PagerDutyTeam {
  readonly #ctx: SessionContext;
  readonly #id: string;

  constructor(ctx: SessionContext, id: string) {
    super();
    this.#ctx = ctx;
    this.#id = id;
  }

  async getMetadata(): Promise<PagerDutyTeamMetadata> {
    const { team: wire } = await this.#ctx.host.read(api => api.get<{ team: WireTeam }>(`/teams/${this.#id}`));
    const me = await this.#ctx.host.me();
    await this.#ctx.authorize({ title: "Read a PagerDuty team", description: "Read the team's name and description." },
      { filter: [], result: [] });
    return { ...toTeam(wire), you: youOf(me) };
  }

  async listMembers(): Promise<PagerDutyTeamMember[]> {
    const rows = await this.#ctx.host.read(api =>
      api.all<WireMember>(`/teams/${this.#id}/members`, "members", { include: ["users"] }));
    await this.#ctx.authorize({ title: "Listed a PagerDuty team's members", description: `Read ${countOf(rows.length, "member")}.` },
      { filter: [], result: [] });
    return rows.map(toMember);
  }

  async listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>> {
    return namedListing<WireService, PagerDutyServiceSummary>(this.#ctx, {
      path: "/services", key: "services", kind: "service", noun: "service", teamId: this.#id, list: options,
      convert: toServiceSummary,
    });
  }

  async getService(id: string): Promise<PagerDutyService> {
    requireTeam(await cachedService(this.#ctx, objectId(id, "id")), this.#id, "service");
    return new PagerDutyServiceImpl(this.#ctx.within(service(id)), id, { teamId: this.#id });
  }

  async listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>> {
    return await listIncidents(this.#ctx, filter, { teamId: this.#id });
  }

  async getIncident(idOrNumber: string): Promise<PagerDutyIncident> {
    return await PagerDutyIncidentImpl.open(this.#ctx, idOrNumber, { teamId: this.#id });
  }

  async listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>> {
    return namedListing<WireSchedule, PagerDutyScheduleSummary>(this.#ctx, {
      path: "/schedules", key: "schedules", kind: "schedule", noun: "schedule", teamId: this.#id, list: options,
      convert: toScheduleSummary,
    });
  }

  async getSchedule(id: string): Promise<PagerDutySchedule> {
    const { schedule: wire } = await this.#ctx.host.read(api =>
      api.get<{ schedule: WireSchedule }>(`/schedules/${objectId(id, "id")}`));
    requireTeam(wire, this.#id, "schedule");
    return new PagerDutyScheduleImpl(this.#ctx.within(schedule(id)), id, { teamId: this.#id });
  }

  async listOnCalls(window?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]> {
    const policies = await this.#ctx.host.cached(`policies:${this.#id}`, CATALOG_TTL_MS, () => this.#ctx.host.read(api =>
      api.all<WireRef>("/escalation_policies", "escalation_policies", { team_ids: [this.#id] })));
    const policyIds = policies.map(({ id }) => id);
    // With no policy to filter by, PagerDuty would answer for the whole account.
    return await listOnCalls(this.#ctx, window, {
      params: { escalation_policy_ids: policyIds }, filter: [], fixed: policyIds.map(escalationPolicy),
      none: policyIds.length === 0,
    });
  }

  async findUsers(query?: string): Promise<PagerDutyUser[]> {
    return await findUsers(this.#ctx, query);
  }

  async listPriorities(): Promise<PagerDutyPriority[]> {
    return await listPriorities(this.#ctx);
  }

  async subscribe(): Promise<void> {
    unsupportedHooks();
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Service

@validateRpc()
export class PagerDutyServiceImpl extends RpcTarget implements PagerDutyService {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #within: Within;

  /** @param within The team the service was opened from, which it must still belong to. */
  constructor(ctx: SessionContext, id: string, within: { teamId?: string }) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#within = { ...within, serviceId: id };
  }

  async getDetails(): Promise<PagerDutyServiceDetails> {
    const wire = await readService(this.#ctx, this.#id);
    requireTeam(wire, this.#within.teamId, "service");
    const me = await this.#ctx.host.me();
    await this.#ctx.authorize({ title: "Read a PagerDuty service", description: "Read the service's details." },
      { filter: [], result: [] });
    return toServiceDetails(wire, youOf(me));
  }

  async listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>> {
    return await listIncidents(this.#ctx, filter, this.#within);
  }

  async getIncident(idOrNumber: string): Promise<PagerDutyIncident> {
    return await PagerDutyIncidentImpl.open(this.#ctx, idOrNumber, this.#within);
  }

  async createIncident(options: PagerDutyCreateIncidentOptions): Promise<PagerDutyIncident> {
    const ctx = this.#ctx;
    const title = text(options?.title, "title", 1024);
    const details = options.details === undefined ? undefined : text(options.details, "details", MAX_NOTE_LENGTH);
    const incidentKey = options.incidentKey === undefined ? undefined : text(options.incidentKey, "incidentKey", 255);
    const chosenUrgency = options.urgency === undefined ? undefined : urgency(options.urgency);
    const priority = options.priority === undefined ? undefined : await priorityNamed(ctx, options.priority);
    const assignTo = options.assignTo === undefined ? undefined : await usersNamed(ctx, options.assignTo, "assignTo");
    const wire = await cachedService(ctx, this.#id);
    requireTeam(wire, this.#within.teamId, "service");
    if (!wire.escalation_policy) throw new Error("PagerDuty described the service without its escalation policy.");
    const summary = toServiceSummary(wire);
    const ref = ctx.host.allocate("incident");
    const payload: NewIncident = {
      ref, service: { id: summary.id, name: summary.name, htmlUrl: summary.htmlUrl },
      team: summary.team, escalationPolicy: toRef(wire.escalation_policy),
      title, stagedAt: new Date().toISOString(),
      ...(details !== undefined ? { details } : {}),
      ...(chosenUrgency ? { urgency: chosenUrgency } : {}),
      ...(priority ? { priority } : {}),
      ...(assignTo ? { assignTo } : {}),
      ...(incidentKey !== undefined ? { incidentKey } : {}),
    };
    await ctx.host.submit(ctx.queue, "createIncident", payload);
    return new PagerDutyIncidentImpl(ctx.dup(), ref, this.#within);
  }

  async listOnCalls(window?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]> {
    const wire = await cachedService(this.#ctx, this.#id);
    const policyId = wire.escalation_policy?.id;
    if (!policyId) throw new Error("PagerDuty described the service without its escalation policy.");
    return await listOnCalls(this.#ctx, window,
      { params: { escalation_policy_ids: [policyId] }, filter: [], fixed: [escalationPolicy(policyId)] });
  }

  async findUsers(query?: string): Promise<PagerDutyUser[]> {
    return await findUsers(this.#ctx, query);
  }

  async listPriorities(): Promise<PagerDutyPriority[]> {
    return await listPriorities(this.#ctx);
  }

  async subscribe(): Promise<void> {
    unsupportedHooks();
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Incident

/** An incident as one read found it: PagerDuty's, or one a pending action opens. */
type Loaded = { wire: WireIncident; pending?: never } | { wire?: never; pending: NewIncident };

const INCIDENT_INCLUDES = ["acknowledgers", "assignees", "conference_bridge", "priorities", "body"];

@validateRpc()
export class PagerDutyIncidentImpl extends RpcTarget implements PagerDutyIncident {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #within: Within;

  /**
   * @param id PagerDuty's ID, or the `~N` of an incident a pending action opens.
   * @param within The team or service the incident was opened from, which it must still belong to.
   */
  constructor(ctx: SessionContext, id: string, within: Within) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#within = within;
  }

  /** Opens an incident by ID or number, refusing one outside `within`. */
  static async open(ctx: SessionContext, idOrNumber: string, within: Within): Promise<PagerDutyIncidentImpl> {
    if (!OBJECT_ID.test(idOrNumber) && !isProvisional(idOrNumber)) {
      throw new Error('idOrNumber must be an incident ID, such as "Q2W3E4R5T6Y7U8", or its number.');
    }
    const opened = new PagerDutyIncidentImpl(ctx.dup(), idOrNumber, within);
    try {
      const loaded = await opened.#load();
      return loaded.wire ? new PagerDutyIncidentImpl(opened.#ctx, loaded.wire.id, within) : opened;
    } catch (error) {
      opened.#ctx[Symbol.dispose]();
      throw error;
    }
  }

  /** The incident now, checked against the capability's scope. */
  async #load(includes: readonly string[] = []): Promise<Loaded> {
    const { host } = this.#ctx;
    const id = host.resolve(this.#id);
    let loaded: Loaded;
    if (isProvisional(id)) {
      const created = host.pending().find(({ action }) => action.kind === "createIncident" && action.payload.ref === id);
      if (created?.action.kind !== "createIncident") {
        throw new Error("This incident was never opened: opening it was rejected or failed.");
      }
      loaded = { pending: created.action.payload };
    } else {
      const { incident: wire } = await host.read(api =>
        api.get<{ incident: WireIncident }>(`/incidents/${id}`, includes.length ? { include: includes } : {}));
      loaded = { wire };
    }
    const serviceId = loaded.wire ? loaded.wire.service.id : loaded.pending.service.id;
    if (this.#within.serviceId && serviceId !== this.#within.serviceId) {
      throw new Error("That incident belongs to another service.");
    }
    if (this.#within.teamId) requireTeam(await cachedService(this.#ctx, serviceId), this.#within.teamId, "incident");
    return loaded;
  }

  /** What this incident's reads depend on: itself, once PagerDuty has it, and its service. */
  #result(loaded: Loaded): ObjectRef[] {
    return loaded.wire ? [incident(loaded.wire.id), service(loaded.wire.service.id)] : [service(loaded.pending.service.id)];
  }

  async #you() {
    const me = await this.#ctx.host.me();
    return { id: me.userId, name: me.name };
  }

  async getDetails(): Promise<PagerDutyIncidentDetails> {
    const { host } = this.#ctx;
    const loaded = await this.#load(INCIDENT_INCLUDES);
    let details: PagerDutyIncidentDetails;
    if (loaded.wire) {
      const id = loaded.wire.id;
      const { alerts } = await host.read(api => api.get<{ alerts: WireAlert[] }>(`/incidents/${id}/alerts`,
        { limit: 1, sort_by: "created_at:asc" }));
      details = toIncidentDetails(loaded.wire, alerts[0] ?? null);
    } else {
      details = pendingIncident(loaded.pending);
    }
    await this.#ctx.authorize({ title: "Read a PagerDuty incident", description: "Read the incident's details." },
      { filter: [], result: this.#result(loaded) });
    return overlayIncident(details, host.pending(), id => host.resolve(id), await this.#you());
  }

  async getTimeline(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyTimelineEntry>> {
    return await this.#history(options, async (api, id) => {
      // PagerDuty doesn't document the order, so the whole log is read and put oldest first.
      const rows = await api.all<WireLogEntry>(`/incidents/${id}/log_entries`, "log_entries");
      return rows.map(toTimelineEntry).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    }, "log entry");
  }

  async listNotes(): Promise<PagerDutyNote[]> {
    const { host } = this.#ctx;
    const loaded = await this.#load();
    const rows = loaded.wire
      ? (await host.read(api => api.get<{ notes: WireNote[] }>(`/incidents/${loaded.wire.id}/notes`))).notes.map(toNote)
      : [];
    const id = loaded.wire ? loaded.wire.id : loaded.pending.ref;
    const notes = [...rows, ...pendingNotes(id, host.pending(), ref => host.resolve(ref), await this.#you())]
      .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    await this.#ctx.authorize({ title: "Read a PagerDuty incident's notes", description: `Read ${countOf(notes.length, "note")}.` },
      { filter: [], result: this.#result(loaded) });
    return notes;
  }

  async listAlerts(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyAlert>> {
    const pageSize = pageSizeOf(options);
    const loaded = await this.#load();
    if (!loaded.wire) return await this.#history(options, async () => [], "alert");
    const { id } = loaded.wire;
    return offsetCursor<WireAlert, PagerDutyAlert>(this.#ctx, {
      pageSize,
      fetch: (api, offset, limit) => api.page<WireAlert>(`/incidents/${id}/alerts`, "alerts",
        { sort_by: "created_at:desc" }, offset, limit),
      convert: rows => rows.map(toAlert),
      describe: listed("Listed a PagerDuty incident's alerts", "alert"),
      filter: [],
      result: () => this.#result(loaded),
    });
  }

  /** A history read whole, then paged, each page authorized with the incident's dependencies. */
  async #history<T>(options: PagerDutyPageOptions | undefined,
                    read: (api: PagerDutyApi, id: string) => Promise<T[]>, noun: string): Promise<Cursor<T>> {
    const pageSize = pageSizeOf(options);
    const loaded = await this.#load();
    // An incident still waiting to be opened has no history.
    if (!loaded.wire) {
      await this.#ctx.authorize(listed(`Listed a PagerDuty incident's ${noun}s`, noun)([], true),
        { filter: [], result: this.#result(loaded) });
      return new ArrayCursor<T>([], pageSize);
    }
    const { id } = loaded.wire;
    return offsetCursor<T, T>(this.#ctx, {
      pageSize,
      fetch: async (api, offset) => offset > 0 ? { items: [], more: false } : { items: await read(api, id), more: false },
      convert: rows => rows,
      describe: listed(`Listed a PagerDuty incident's ${noun}s`, noun),
      filter: [],
      result: () => this.#result(loaded),
    });
  }

  /** The incident an action stages against, checked against the capability's scope. */
  async #target(): Promise<{ target: IncidentTarget; status: PagerDutyIncidentSummary["status"] }> {
    const { host } = this.#ctx;
    const loaded = await this.#load();
    const summary = loaded.wire ? toIncidentSummary(loaded.wire) : pendingIncident(loaded.pending);
    const { status } = overlayIncident(summary, host.pending(), id => host.resolve(id), await this.#you());
    return { target: loaded.wire ? { id: loaded.wire.id, number: loaded.wire.incident_number } : { id: this.#id }, status };
  }

  async #stage<K extends Exclude<keyof PagerDutyActions, "createIncident" | "createOverride" | "createOverrideForOthers" | "deleteOverride">>(
    kind: K, payload: (target: IncidentTarget) => PagerDutyActions[K],
  ): Promise<void> {
    const { target } = await this.#target();
    await this.#ctx.host.submit(this.#ctx.queue, kind, payload(target));
  }

  async acknowledge(): Promise<void> {
    await this.#stage("acknowledge", target => ({ incident: target }));
  }

  async resolve(resolution?: string): Promise<void> {
    const note = resolution === undefined ? undefined : text(resolution, "resolution", MAX_NOTE_LENGTH);
    await this.#stage("resolve", target => ({ incident: target, ...(note !== undefined ? { resolution: note } : {}) }));
  }

  async snooze(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SNOOZE_SECONDS) {
      throw new Error(`seconds must be a whole number from 1 to ${MAX_SNOOZE_SECONDS}.`);
    }
    const { target, status } = await this.#target();
    if (status !== "acknowledged") throw new Error("Only an acknowledged incident can be snoozed.");
    await this.#ctx.host.submit(this.#ctx.queue, "snooze", { incident: target, seconds });
  }

  async addNote(content: string): Promise<void> {
    text(content, "content", MAX_NOTE_LENGTH);
    const ref = this.#ctx.host.allocate("note");
    await this.#stage("addNote", target => ({ incident: target, ref, content, stagedAt: new Date().toISOString() }));
  }

  async reassign(to: { users: string[] } | { escalationPolicyId: string }): Promise<void> {
    const assignee = "users" in to
      ? { users: await usersNamed(this.#ctx, to.users, "users") }
      : { escalationPolicyId: objectId(to.escalationPolicyId, "escalationPolicyId") };
    await this.#stage("reassign", target => ({ incident: target, to: assignee }));
  }

  async escalate(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < 1) throw new Error("level must be a whole number from 1.");
    await this.#stage("escalate", target => ({ incident: target, level }));
  }

  async requestResponders(options: PagerDutyResponderRequest): Promise<void> {
    const message = text(options?.message, "message", MAX_NOTE_LENGTH);
    const users = options.users?.length ? await usersNamed(this.#ctx, options.users, "users") : [];
    const escalationPolicyIds = ids(options.escalationPolicyIds, "escalationPolicyIds") ?? [];
    if (users.length + escalationPolicyIds.length === 0) throw new Error("Name at least one user or escalation policy.");
    await this.#stage("requestResponders", target => ({ incident: target, message, users, escalationPolicyIds }));
  }

  async setPriority(priority: string | null): Promise<void> {
    const chosen = priority === null ? null : await priorityNamed(this.#ctx, priority);
    await this.#stage("setPriority", target => ({ incident: target, priority: chosen }));
  }

  async setUrgency(value: PagerDutyUrgency): Promise<void> {
    const chosen = urgency(value);
    await this.#stage("setUrgency", target => ({ incident: target, urgency: chosen }));
  }

  async setTitle(title: string): Promise<void> {
    text(title, "title", 1024);
    await this.#stage("setTitle", target => ({ incident: target, title }));
  }

  async postStatusUpdate(message: string): Promise<void> {
    text(message, "message", MAX_NOTE_LENGTH);
    await this.#stage("postStatusUpdate", target => ({ incident: target, message }));
  }

  async subscribe(): Promise<void> {
    unsupportedHooks();
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Schedule

@validateRpc()
export class PagerDutyScheduleImpl extends RpcTarget implements PagerDutySchedule {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #teamId?: string;

  /** @param within The team the schedule was opened from, which it must still belong to. */
  constructor(ctx: SessionContext, id: string, within: { teamId?: string }) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#teamId = within.teamId;
  }

  async #read(query: Query = {}): Promise<WireSchedule> {
    const { schedule: wire } = await this.#ctx.host.read(api =>
      api.get<{ schedule: WireSchedule }>(`/schedules/${this.#id}`, query));
    requireTeam(wire, this.#teamId, "schedule");
    return wire;
  }

  async getDetails(): Promise<PagerDutyScheduleDetails> {
    const wire = await this.#read();
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule", description: "Read the schedule's details." },
      { filter: [], result: [] });
    return toScheduleDetails(wire);
  }

  async listShifts(window?: PagerDutyTimeWindow): Promise<PagerDutyShift[]> {
    const span = windowOf(window, 7, MAX_SHIFT_DAYS);
    const wire = await this.#read(span);
    const { host } = this.#ctx;
    const shifts = overlayShifts((wire.final_schedule?.rendered_schedule_entries ?? []).map(toShift), this.#id, span,
      host.pending(), id => host.resolve(id));
    await this.#ctx.authorize({ title: "Read who is on call on a PagerDuty schedule", description: `Read ${countOf(shifts.length, "shift")}.` },
      { filter: [], result: [] });
    return shifts;
  }

  async listOverrides(window?: PagerDutyTimeWindow): Promise<PagerDutyOverride[]> {
    const span = windowOf(window, 30);
    const { host } = this.#ctx;
    if (this.#teamId) await this.#read();
    const rows = await host.read(api =>
      api.get<{ overrides: WireOverride[] }>(`/schedules/${this.#id}/overrides`, span));
    const overrides = overlayOverrides(rows.overrides.map(toOverride), this.#id, span, host.pending(), id => host.resolve(id));
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule's overrides", description: `Read ${countOf(overrides.length, "override")}.` },
      { filter: [], result: [] });
    return overrides;
  }

  async createOverride(user: string, start: string, end: string): Promise<string> {
    const from = time(text(start, "start"), "start")!;
    const until = time(text(end, "end"), "end")!;
    if (Date.parse(until) <= Date.parse(from)) throw new Error("end must be after start.");
    if (this.#teamId) await this.#read();
    const [target] = await usersNamed(this.#ctx, [user], "user");
    const me = await this.#ctx.host.me();
    const ref = this.#ctx.host.allocate("override");
    await this.#ctx.host.submit(this.#ctx.queue, target.id === me.userId ? "createOverride" : "createOverrideForOthers",
      { ref, scheduleId: this.#id, user: target, start: from, end: until });
    return ref;
  }

  async deleteOverride(id: string): Promise<void> {
    if (typeof id !== "string" || (!OBJECT_ID.test(id) && !isProvisional(id))) {
      throw new Error('id must be an override ID, such as "Q3X6MJ1LUKD6QW".');
    }
    if (this.#teamId) await this.#read();
    await this.#ctx.host.submit(this.#ctx.queue, "deleteOverride", { scheduleId: this.#id, overrideId: id });
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}
