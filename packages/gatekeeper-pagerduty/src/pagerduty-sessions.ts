// The account, team and service capabilities: what those bindings hold, and what a broader one
// returns when it opens a team or service. Their shared reads and listings live in
// pagerduty-session-shared.ts; the incident and schedule capabilities they open, in
// pagerduty-incident-session.ts and pagerduty-schedule-session.ts. Every write validates, then
// stages an action; none reaches PagerDuty before approval.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { NewIncident } from "./pagerduty-actions";
import { youOf } from "./pagerduty-credentials";
import { webOrigin } from "./pagerduty-env";
import {
  toMember, toRef, toServiceDetails, toServiceSummary, toTeam,
  type WireMember, type WireRef, type WireService, type WireTeam,
} from "./pagerduty-normalize";
import { PagerDutyIncidentImpl } from "./pagerduty-incident-session";
import { PagerDutyScheduleImpl } from "./pagerduty-schedule-session";
import {
  CATALOG_TTL_MS, MAX_NOTE_LENGTH, cachedService, countOf, escalationPolicy, findUsers, ids, listIncidents, listOnCalls,
  listPriorities, listSchedules, namedListing, priorityNamed, readSchedule, readService, requireTeam, schedule, service,
  subscribed, team, text, urgency, usersNamed, type SessionContext, type Within,
} from "./pagerduty-session-shared";
import { objectId } from "./pagerduty-urls";
import type { PagerDutyEventHookTarget } from "./pagerduty-hooks";
import type {
  Cursor, PagerDutyAccount, PagerDutyAccountMetadata, PagerDutyCreateIncidentOptions, PagerDutyIncident,
  PagerDutyIncidentFilter, PagerDutyIncidentSummary, PagerDutyListOptions, PagerDutyOnCall, PagerDutyOnCallFilter,
  PagerDutyOnCallWindow, PagerDutyPriority, PagerDutySchedule, PagerDutyScheduleSummary, PagerDutyService,
  PagerDutyServiceDetails, PagerDutyServiceSummary, PagerDutySubscribeOptions, PagerDutyTeam, PagerDutyTeamMember,
  PagerDutyTeamMetadata, PagerDutyTeamSummary, PagerDutyUser,
} from "./types";

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
      { key: "services", kind: "service", noun: "service", list: options, sources: [{ path: "/services", convert: toServiceSummary }] });
  }

  async getService(id: string): Promise<PagerDutyService> {
    objectId(id, "id");
    return new PagerDutyServiceImpl(this.#ctx.within(service(id)), id, {});
  }

  async listTeams(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyTeamSummary>> {
    return namedListing<WireTeam, PagerDutyTeamSummary>(this.#ctx,
      { key: "teams", kind: "team", noun: "team", list: options, sources: [{ path: "/teams", convert: toTeam }] });
  }

  async getTeam(id: string): Promise<PagerDutyTeam> {
    objectId(id, "id");
    return new PagerDutyTeamImpl(this.#ctx.within(team(id)), id);
  }

  async listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>> {
    return listSchedules(this.#ctx, options);
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

  async subscribe(hook: RpcStub<PagerDutyEventHookTarget>, options?: PagerDutySubscribeOptions): Promise<void> {
    await subscribed(this.#ctx, hook, options, {});
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
      key: "services", kind: "service", noun: "service", teamId: this.#id, list: options,
      sources: [{ path: "/services", convert: toServiceSummary }],
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
    return listSchedules(this.#ctx, options, this.#id);
  }

  async getSchedule(id: string): Promise<PagerDutySchedule> {
    requireTeam(await readSchedule(this.#ctx, objectId(id, "id")), this.#id, "schedule");
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

  async subscribe(hook: RpcStub<PagerDutyEventHookTarget>, options?: PagerDutySubscribeOptions): Promise<void> {
    await subscribed(this.#ctx, hook, options, { teamId: this.#id });
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
      teams: (wire.teams ?? []).map(toRef), escalationPolicy: toRef(wire.escalation_policy),
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
    requireTeam(wire, this.#within.teamId, "service");
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

  async subscribe(hook: RpcStub<PagerDutyEventHookTarget>, options?: PagerDutySubscribeOptions): Promise<void> {
    await subscribed(this.#ctx, hook, options, this.#within);
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}
