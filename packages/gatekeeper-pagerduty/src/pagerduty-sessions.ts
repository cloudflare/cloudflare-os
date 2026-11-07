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
import { toMember, toRef, toServiceDetails, toTeam, type WireMember, type WireRef, type WireTeam } from "./pagerduty-normalize";
import { PagerDutyIncidentImpl } from "./pagerduty-incident-session";
import { PagerDutyScheduleImpl } from "./pagerduty-schedule-session";
import { serviceUrgency } from "./pagerduty-simulation";
import {
  CATALOG_TTL_MS, MAX_NOTE_LENGTH, cachedService, countOf, escalationPolicy, findUsers, ids, listIncidents, listOnCalls,
  listPriorities, listSchedules, listServices, listTeams, priorityNamed, readSchedule, readService, requireTeam, schedule,
  service, subscribed, team, text, usersNamed, type SessionContext, type Within,
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
// What the account, team and service capabilities share: their incidents, users and hooks, each
// reaching only what is `within` the capability.

@validateRpc()
abstract class PagerDutyScopeImpl extends RpcTarget {
  constructor(protected readonly ctx: SessionContext, protected readonly within: Within) {
    super();
  }

  async listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>> {
    return await listIncidents(this.ctx, filter, this.within);
  }

  async getIncident(idOrNumber: string): Promise<PagerDutyIncident> {
    return await PagerDutyIncidentImpl.open(this.ctx, idOrNumber, this.within);
  }

  async findUsers(query?: string): Promise<PagerDutyUser[]> {
    return await findUsers(this.ctx, query);
  }

  async listPriorities(): Promise<PagerDutyPriority[]> {
    return await listPriorities(this.ctx);
  }

  async subscribe(hook: RpcStub<PagerDutyEventHookTarget>, options?: PagerDutySubscribeOptions): Promise<void> {
    await subscribed(this.ctx, hook, options, this.within);
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Account

@validateRpc()
export class PagerDutyAccountImpl extends PagerDutyScopeImpl implements PagerDutyAccount {
  constructor(ctx: SessionContext) {
    super(ctx, {});
  }

  async getMetadata(): Promise<PagerDutyAccountMetadata> {
    const me = await this.ctx.host.me();
    await this.ctx.authorize({ title: "Read the PagerDuty account", description: "Read the account and the connected user." });
    return { subdomain: me.subdomain, htmlUrl: webOrigin(me), you: youOf(me) };
  }

  async listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>> {
    return listServices(this.ctx, options);
  }

  async getService(id: string): Promise<PagerDutyService> {
    objectId(id, "id");
    return new PagerDutyServiceImpl(this.ctx.within(service(id)), id, {});
  }

  async listTeams(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyTeamSummary>> {
    return listTeams(this.ctx, options);
  }

  async getTeam(id: string): Promise<PagerDutyTeam> {
    objectId(id, "id");
    return new PagerDutyTeamImpl(this.ctx.within(team(id)), id);
  }

  async listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>> {
    return listSchedules(this.ctx, options);
  }

  async getSchedule(id: string): Promise<PagerDutySchedule> {
    objectId(id, "id");
    return new PagerDutyScheduleImpl(this.ctx.within(schedule(id)), id, {});
  }

  async listOnCalls(filter?: PagerDutyOnCallFilter): Promise<PagerDutyOnCall[]> {
    const scheduleIds = ids(filter?.scheduleIds, "scheduleIds");
    const policyIds = ids(filter?.escalationPolicyIds, "escalationPolicyIds");
    const users = filter?.users === undefined ? undefined : await usersNamed(this.ctx, filter.users, "users");
    return await listOnCalls(this.ctx, filter, {
      params: { schedule_ids: scheduleIds, escalation_policy_ids: policyIds },
      users: users?.map(({ id }) => id),
      filter: [...(scheduleIds ?? []).map(schedule), ...(policyIds ?? []).map(escalationPolicy)],
      fixed: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Team

@validateRpc()
export class PagerDutyTeamImpl extends PagerDutyScopeImpl implements PagerDutyTeam {
  readonly #id: string;

  constructor(ctx: SessionContext, id: string) {
    super(ctx, { teamId: id });
    this.#id = id;
  }

  async getMetadata(): Promise<PagerDutyTeamMetadata> {
    const { team: wire } = await this.ctx.host.read(api => api.get<{ team: WireTeam }>(`/teams/${this.#id}`));
    const me = await this.ctx.host.me();
    await this.ctx.authorize({ title: "Read a PagerDuty team", description: "Read the team's name and description." });
    return { ...toTeam(wire), you: youOf(me) };
  }

  async listMembers(): Promise<PagerDutyTeamMember[]> {
    const rows = await this.ctx.host.read(api =>
      api.all<WireMember>(`/teams/${this.#id}/members`, "members", { include: ["users"] }));
    await this.ctx.authorize({ title: "Listed a PagerDuty team's members", description: `Read ${countOf(rows.length, "member")}.` });
    return rows.map(toMember);
  }

  async listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>> {
    return listServices(this.ctx, options, this.#id);
  }

  async getService(id: string): Promise<PagerDutyService> {
    requireTeam(await cachedService(this.ctx, objectId(id, "id")), this.#id, "service");
    return new PagerDutyServiceImpl(this.ctx.within(service(id)), id, this.within);
  }

  async listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>> {
    return listSchedules(this.ctx, options, this.#id);
  }

  async getSchedule(id: string): Promise<PagerDutySchedule> {
    requireTeam(await readSchedule(this.ctx, objectId(id, "id")), this.#id, "schedule");
    return new PagerDutyScheduleImpl(this.ctx.within(schedule(id)), id, this.within);
  }

  async listOnCalls(window?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]> {
    const policies = await this.ctx.host.cached(`policies:${this.#id}`, CATALOG_TTL_MS, () => this.ctx.host.read(api =>
      api.all<WireRef>("/escalation_policies", "escalation_policies", { team_ids: [this.#id] })));
    const policyIds = policies.map(({ id }) => id);
    // With no policy to filter by, PagerDuty would answer for the whole account.
    return await listOnCalls(this.ctx, window, {
      params: { escalation_policy_ids: policyIds }, filter: [], fixed: policyIds.map(escalationPolicy),
      none: policyIds.length === 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Service

@validateRpc()
export class PagerDutyServiceImpl extends PagerDutyScopeImpl implements PagerDutyService {
  readonly #id: string;

  /** @param within The team the service was opened from, which it must still belong to. */
  constructor(ctx: SessionContext, id: string, within: { teamId?: string }) {
    super(ctx, { ...within, serviceId: id });
    this.#id = id;
  }

  /** The service, checked against the team it was opened from; cached briefly unless `fresh`. */
  async #service(fresh = false) {
    const wire = fresh ? await readService(this.ctx, this.#id) : await cachedService(this.ctx, this.#id);
    requireTeam(wire, this.within.teamId, "service");
    return wire;
  }

  async getDetails(): Promise<PagerDutyServiceDetails> {
    const wire = await this.#service(true);
    const me = await this.ctx.host.me();
    await this.ctx.authorize({ title: "Read a PagerDuty service", description: "Read the service's details." });
    return toServiceDetails(wire, youOf(me));
  }

  async createIncident(options: PagerDutyCreateIncidentOptions): Promise<PagerDutyIncident> {
    const ctx = this.ctx;
    const title = text(options.title, "title", 1024);
    const details = options.details === undefined ? undefined : text(options.details, "details", MAX_NOTE_LENGTH);
    const incidentKey = options.incidentKey === undefined ? undefined : text(options.incidentKey, "incidentKey", 255);
    const [priority, assignTo, wire] = await Promise.all([
      options.priority === undefined ? undefined : priorityNamed(ctx, options.priority),
      options.assignTo === undefined ? undefined : usersNamed(ctx, options.assignTo, "assignTo"),
      this.#service(),
    ]);
    if (!wire.escalation_policy) throw new Error("PagerDuty described the service without its escalation policy.");
    const ref = ctx.host.allocate("incident");
    const stagedAt = new Date();
    const payload: NewIncident = {
      ref, service: toRef(wire),
      teams: (wire.teams ?? []).map(toRef), escalationPolicy: toRef(wire.escalation_policy),
      title, stagedAt: stagedAt.toISOString(),
      ...(details !== undefined ? { details } : {}),
      ...(options.urgency ? { urgency: options.urgency } : { serviceUrgency: serviceUrgency(wire, stagedAt) }),
      ...(priority ? { priority } : {}),
      ...(assignTo ? { assignTo } : {}),
      ...(incidentKey !== undefined ? { incidentKey } : {}),
    };
    await ctx.host.submit(ctx.queue, "createIncident", payload);
    return new PagerDutyIncidentImpl(ctx.dup(), ref, this.within);
  }

  async listOnCalls(window?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]> {
    const policyId = (await this.#service()).escalation_policy?.id;
    if (!policyId) throw new Error("PagerDuty described the service without its escalation policy.");
    return await listOnCalls(this.ctx, window,
      { params: { escalation_policy_ids: [policyId] }, filter: [], fixed: [escalationPolicy(policyId)] });
  }
}
