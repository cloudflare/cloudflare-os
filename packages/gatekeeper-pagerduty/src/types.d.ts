import type { RpcStub } from "cloudflare:workers";

// Session API exposed to Gadgets/agents by the PagerDuty gatekeeper.
//
// PagerDuty routes alerts from services to the people on call for them. The gatekeeper offers
// five grantable resources, each with its own interface:
//
//   - PagerDutyAccount  — the whole account (e.g. https://acme.pagerduty.com).
//   - PagerDutyTeam     — one team: its services, their incidents, its schedules and members.
//   - PagerDutyService  — one service and its incidents.
//   - PagerDutyIncident — one incident.
//   - PagerDutySchedule — one on-call schedule and its overrides.
//
// `PagerDutyIncident`, `PagerDutyService`, `PagerDutyTeam` and `PagerDutySchedule` are also what
// the broader interfaces return when you open one of those, so the same shape is used everywhere.
//
// Everything you can see is what the connected PagerDuty user can see: services and incidents
// of private teams they don't belong to are absent.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A whole PagerDuty account: every service, team, schedule and incident the user can see. */
export interface PagerDutyAccount {
  /** The account and the connected user. */
  getMetadata(): Promise<PagerDutyAccountMetadata>;

  /**
   * Lists incidents, newest first. By default, only open (triggered or acknowledged) incidents
   * created in the last 30 days; see {@link PagerDutyIncidentFilter}.
   */
  listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>>;

  /** Opens an incident by its id (e.g. `"Q2W3E4R5T6Y7U8"`) or its number (e.g. `"12345"`). */
  getIncident(idOrNumber: string): Promise<PagerDutyIncident>;

  /** Lists services, by name. `query` filters by a case-insensitive name substring. */
  listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>>;

  /** Opens a service by its id (e.g. `"PABC123"`). */
  getService(id: string): Promise<PagerDutyService>;

  /** Lists teams, by name. `query` filters by a case-insensitive name substring. */
  listTeams(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyTeamSummary>>;

  /** Opens a team by its id. */
  getTeam(id: string): Promise<PagerDutyTeam>;

  /** Lists on-call schedules, by name. `query` filters by a case-insensitive name substring. */
  listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>>;

  /** Opens a schedule by its id. */
  getSchedule(id: string): Promise<PagerDutySchedule>;

  /**
   * Who is on call: one entry per user, escalation level and schedule. By default, right now
   * across the whole account; see {@link PagerDutyOnCallFilter}.
   */
  listOnCalls(filter?: PagerDutyOnCallFilter): Promise<PagerDutyOnCall[]>;

  /**
   * Looks up users (up to 50). With a `query`, matches a case-insensitive name or email
   * substring; with none, returns the first users. Use it to find who to reassign an incident to
   * or put on call.
   */
  findUsers(query?: string): Promise<PagerDutyUser[]>;

  /** The account's incident priorities, highest first. Empty if the account doesn't use them. */
  listPriorities(): Promise<PagerDutyPriority[]>;

  /**
   * Have `hook.receiveEvent()` called with each incident event of the kinds in `options.events`
   * (by default, all of them) on any incident in the account; see {@link PagerDutyEventKind}.
   *
   * Every event is delivered, whoever caused it, including the changes a hook makes once they
   * are approved; `event.actor.isYou` tells those apart. The hook starts disabled, and nothing is
   * delivered until the user enables it. Every call creates a distinct hook, so subscribe once
   * for each set of events to watch. Throws if this deployment has not configured PagerDuty
   * hooks.
   *
   * `hook` must be a persistent stub that restores through a Gadget's `[restore]()` method: inside
   * the Gadget, create it with `this.ctx.restore(params)`; from `executeCode`, through the Gadget's
   * binding, as "Persistent Stubs and `ctx.restore()`" in your instructions describes. The
   * Gadget's `[restore]()` receives those `params` for every delivery, so they can tell its
   * subscriptions apart. The restored target is a separate object; pass it what it needs from
   * `[restore]()`, such as `this`, the Gadget.
   *
   * @example
   * // server.js
   * import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
   * export class Gadget extends DurableObject {
   *   async [restore](params) {
   *     if (params.type === "triage") return new Triage();
   *     throw new TypeError(`Unknown restore type: ${params.type}`);
   *   }
   * }
   * class Triage extends RpcTarget {
   *   async receiveEvent(event) {
   *     if (event.kind === "triggered" && event.info.urgency === "high") {
   *       await event.incident.addNote("Triage bot is looking at this.");
   *     }
   *   }
   * }
   *
   * // executeCode, where `hook` is a persistent stub for the params `{ type: "triage" }`
   * await env.PAGERDUTY.subscribe(hook, { events: ["triggered"] });
   */
  subscribe(hook: RpcStub<PagerDutyEventHook>, options?: PagerDutySubscribeOptions): Promise<void>;
}

/** One PagerDuty team: the services it owns, their incidents, its schedules and its members. */
export interface PagerDutyTeam {
  /** The team's name, description and connected user. */
  getMetadata(): Promise<PagerDutyTeamMetadata>;

  /** Lists the team's members and their team roles. */
  listMembers(): Promise<PagerDutyTeamMember[]>;

  /** Lists the services the team owns, by name. */
  listServices(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyServiceSummary>>;

  /** Opens one of the team's services by id. Throws if the team doesn't own it. */
  getService(id: string): Promise<PagerDutyService>;

  /** As `PagerDutyAccount.listIncidents()`, for incidents on the team's services. */
  listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>>;

  /** Opens an incident on one of the team's services. Throws if it belongs to another team. */
  getIncident(idOrNumber: string): Promise<PagerDutyIncident>;

  /** Lists the team's schedules, by name. */
  listSchedules(options?: PagerDutyListOptions): Promise<Cursor<PagerDutyScheduleSummary>>;

  /** Opens one of the team's schedules by id. Throws if the team doesn't own it. */
  getSchedule(id: string): Promise<PagerDutySchedule>;

  /** Who is on call for the team's escalation policies; by default, right now. */
  listOnCalls(filter?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]>;

  /** As `PagerDutyAccount.findUsers()`. */
  findUsers(query?: string): Promise<PagerDutyUser[]>;

  /** As `PagerDutyAccount.listPriorities()`. */
  listPriorities(): Promise<PagerDutyPriority[]>;

  /** As `PagerDutyAccount.subscribe()`, for incidents on the team's services. */
  subscribe(hook: RpcStub<PagerDutyEventHook>, options?: PagerDutySubscribeOptions): Promise<void>;
}

/** One PagerDuty service: something that raises incidents, such as an application or a host. */
export interface PagerDutyService {
  /** The service's details, including who it escalates to. */
  getDetails(): Promise<PagerDutyServiceDetails>;

  /** As `PagerDutyAccount.listIncidents()`, for this service's incidents. */
  listIncidents(filter?: PagerDutyIncidentFilter): Promise<Cursor<PagerDutyIncidentSummary>>;

  /** Opens one of this service's incidents. Throws if it belongs to another service. */
  getIncident(idOrNumber: string): Promise<PagerDutyIncident>;

  /**
   * Opens a new incident on this service, which notifies whoever its escalation policy names.
   * Returns the new incident. Until PagerDuty opens it, it goes by a temporary id such as `"~1"`,
   * with `number` 0 and an empty `htmlUrl`.
   */
  createIncident(options: PagerDutyCreateIncidentOptions): Promise<PagerDutyIncident>;

  /** Who is on call for this service's escalation policy; by default, right now. */
  listOnCalls(filter?: PagerDutyOnCallWindow): Promise<PagerDutyOnCall[]>;

  /** As `PagerDutyAccount.findUsers()`. */
  findUsers(query?: string): Promise<PagerDutyUser[]>;

  /** As `PagerDutyAccount.listPriorities()`. */
  listPriorities(): Promise<PagerDutyPriority[]>;

  /** As `PagerDutyAccount.subscribe()`, for this service's incidents. */
  subscribe(hook: RpcStub<PagerDutyEventHook>, options?: PagerDutySubscribeOptions): Promise<void>;
}

/**
 * One PagerDuty incident.
 *
 * `getDetails`, `getTimeline`, `listNotes` and `listAlerts` read the incident; every other method
 * changes it.
 */
export interface PagerDutyIncident {
  /** The incident's current details, including the triggering alert's payload. */
  getDetails(): Promise<PagerDutyIncidentDetails>;

  /** The incident's log: triggers, notifications, acknowledgements, escalations, notes, oldest first. */
  getTimeline(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyTimelineEntry>>;

  /** The incident's notes, oldest first. */
  listNotes(): Promise<PagerDutyNote[]>;

  /** The alerts grouped into the incident, newest first. */
  listAlerts(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyAlert>>;

  /** Acknowledges the incident as the connected user, which stops escalation while it lasts. */
  acknowledge(): Promise<void>;

  /**
   * Resolves the incident. `resolution`, if given, is recorded on the resolve entry of
   * `getTimeline()`; it isn't a note, so `listNotes()` doesn't return it.
   */
  resolve(resolution?: string): Promise<void>;

  /**
   * Snoozes an acknowledged incident: it re-triggers after `seconds` (1 to 604800) unless resolved
   * first. Throws unless the incident is acknowledged.
   */
  snooze(seconds: number): Promise<void>;

  /** Adds a note (plain text, up to 25000 characters) to the incident. */
  addNote(content: string): Promise<void>;

  /**
   * Reassigns the incident, which notifies the new assignees: either to users, by email or id
   * (`PagerDutyAccount.findUsers()` resolves names), or to an escalation policy by id. Replaces
   * the current assignees.
   */
  reassign(to: { users: string[] } | { escalationPolicyId: string }): Promise<void>;

  /** Escalates to `level` (1 is the first) of the incident's escalation policy, notifying it. */
  escalate(level: number): Promise<void>;

  /**
   * Asks more people to help, notifying each with `message`: users by email or id, and escalation
   * policies by id. If the account's plan doesn't include responder requests, PagerDuty refuses
   * the request once it is approved; this call doesn't fail for it.
   */
  requestResponders(options: PagerDutyResponderRequest): Promise<void>;

  /** Sets the priority by name (see `listPriorities()`), or clears it with `null`. */
  setPriority(priority: string | null): Promise<void>;

  /** Sets the urgency. Raising it to `"high"` may notify the assignees again. */
  setUrgency(urgency: PagerDutyUrgency): Promise<void>;

  /** Replaces the incident's title. */
  setTitle(title: string): Promise<void>;

  /**
   * Publishes a status update (plain text), which PagerDuty sends to the incident's subscribers
   * and stakeholders.
   */
  postStatusUpdate(message: string): Promise<void>;

  /** As `PagerDutyAccount.subscribe()`, for this incident alone. */
  subscribe(hook: RpcStub<PagerDutyEventHook>, options?: PagerDutySubscribeOptions): Promise<void>;
}

/** One on-call schedule. */
export interface PagerDutySchedule {
  /** The schedule's name, time zone, layers and the escalation policies that use it. */
  getDetails(): Promise<PagerDutyScheduleDetails>;

  /**
   * Who is on call when, overrides applied, between `since` and `until` (ISO 8601; by default,
   * the next 7 days; at most 90 days apart).
   */
  listShifts(window?: PagerDutyTimeWindow): Promise<PagerDutyShift[]>;

  /** The schedule's overrides in a window (by default, the next 30 days). */
  listOverrides(window?: PagerDutyTimeWindow): Promise<PagerDutyOverride[]>;

  /**
   * Puts `user` (an email or id) on call from `start` to `end` (ISO 8601), over whoever the
   * schedule would otherwise have. Returns the new override's id.
   */
  createOverride(user: string, start: string, end: string): Promise<string>;

  /**
   * Removes an override by id. One already under way is cut short instead, ending once the removal
   * is approved; one already over can't be removed.
   */
  deleteOverride(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Implemented by a gadget to receive PagerDuty incident events; see `PagerDutyAccount.subscribe()`. */
export interface PagerDutyEventHook {
  /**
   * Called with each event the hook watches for. `event.incident` can read and change the
   * incident, and is released when this call returns. An event may arrive more than once or out
   * of order, so key any work on `event.id` to keep it idempotent. One this throws for is retried
   * with backoff, eight attempts in all, and disabling the hook ends its retries. An event can
   * also be missed, so a gadget that must see every incident should also list them now and then.
   */
  receiveEvent(event: PagerDutyEvent): Promise<void>;
}

/** What `subscribe()` watches for. */
export type PagerDutySubscribeOptions = {
  /** The kinds of event to deliver; by default, all of them. */
  events?: PagerDutyEventKind[];
};

/**
 * What happened to the incident:
 * - `triggered`: it was opened;
 * - `acknowledged` / `unacknowledged`: someone acknowledged it, or the acknowledgement timed out;
 * - `resolved` / `reopened`;
 * - `reassigned`: its assignees changed;
 * - `escalated`: it moved to another level of its escalation policy;
 * - `delegated`: it moved to another escalation policy;
 * - `priorityUpdated`;
 * - `noteAdded`: `event.note` holds the note;
 * - `responderAdded`: someone was asked to help;
 * - `statusUpdatePublished`: `event.statusUpdate` holds the message.
 */
export type PagerDutyEventKind =
  | "triggered"
  | "acknowledged"
  | "unacknowledged"
  | "resolved"
  | "reopened"
  | "reassigned"
  | "escalated"
  | "delegated"
  | "priorityUpdated"
  | "noteAdded"
  | "responderAdded"
  | "statusUpdatePublished";

/** One event delivered to a `PagerDutyEventHook`. */
export type PagerDutyEvent = {
  /** The event's id: the same for each delivery of it. */
  id: string;
  kind: PagerDutyEventKind;
  /** When it happened (ISO 8601). */
  occurredAt: string;
  /** Who caused it, or `null` when PagerDuty did (an escalation timeout, an integration). */
  actor: (PagerDutyUserRef & { isYou: boolean }) | null;
  /** The incident as it is when the event is delivered, which may be after later changes. */
  info: PagerDutyIncidentSummary;
  /** The incident, to read and change. */
  incident: PagerDutyIncident;
  /**
   * For `noteAdded`: the note. A note too long for PagerDuty to send whole is read in full on
   * delivery, and left unset if it was deleted by then.
   */
  note?: string;
  /**
   * For `statusUpdatePublished`: the message. Unset if it was too long for PagerDuty to send whole,
   * as PagerDuty offers no way to read it in full.
   */
  statusUpdate?: string;
};

// ---------------------------------------------------------------------------
// Pagination and filters
// ---------------------------------------------------------------------------

/**
 * A pagination cursor. This is an RPC object: call `next()` repeatedly on the same cursor to
 * fetch subsequent batches. `next()` returns `null` once exhausted. Dispose the cursor when done.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** Paging for cursor-backed lists. */
export type PagerDutyPageOptions = {
  /** How many items each `next()` returns, 1 to 100. Default 25. */
  pageSize?: number;
};

/** Paging plus a name filter. */
export type PagerDutyListOptions = PagerDutyPageOptions & {
  /** Case-insensitive substring of the name. */
  query?: string;
};

/** A time window; both ends ISO 8601. */
export type PagerDutyTimeWindow = {
  since?: string;
  until?: string;
};

/**
 * Filters for listing incidents. All given filters must match. PagerDuty lists at most the first
 * 10000 matches, so narrow `since`/`until` to reach older ones.
 */
export type PagerDutyIncidentFilter = PagerDutyPageOptions & PagerDutyTimeWindow & {
  /** By default `["triggered", "acknowledged"]`. */
  statuses?: PagerDutyIncidentStatus[];
  urgencies?: PagerDutyUrgency[];
  /** Only incidents currently assigned to the connected user. */
  assignedToMe?: boolean;
  /** Only incidents on these services (ids). Within a team, only the team's services match. */
  serviceIds?: string[];
  /**
   * `since`/`until` bound when incidents were created: by default the last 30 days, and at most
   * 6 months apart. Set `allTime` to ignore them.
   */
  allTime?: boolean;
};

/** Which on-call entries to list. */
export type PagerDutyOnCallWindow = PagerDutyTimeWindow & {
  /**
   * Only entries for these escalation levels (1 is the first). By default, every level.
   */
  levels?: number[];
};

/** Filters for `PagerDutyAccount.listOnCalls()`. */
export type PagerDutyOnCallFilter = PagerDutyOnCallWindow & {
  /** Only these users (emails or ids). */
  users?: string[];
  scheduleIds?: string[];
  escalationPolicyIds?: string[];
};

/** Options for `PagerDutyService.createIncident()`. */
export type PagerDutyCreateIncidentOptions = {
  title: string;
  /** Plain-text details. */
  details?: string;
  /** Default: the service's own urgency rule. */
  urgency?: PagerDutyUrgency;
  /** A priority name (see `listPriorities()`). */
  priority?: string;
  /** Assign to these users (emails or ids) instead of the service's escalation policy. */
  assignTo?: string[];
  /**
   * De-duplication key: PagerDuty refuses to open a second incident with the same key on the
   * service while the first is open. That refusal comes once the incident is approved, not from
   * `createIncident()`, and reads show the incident as pending until then.
   */
  incidentKey?: string;
};

/** Options for `PagerDutyIncident.requestResponders()`. */
export type PagerDutyResponderRequest = {
  /** Sent to each responder. */
  message: string;
  users?: string[];
  escalationPolicyIds?: string[];
};

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export type PagerDutyIncidentStatus = "triggered" | "acknowledged" | "resolved";
export type PagerDutyUrgency = "high" | "low";

/** A user, as other objects refer to one. */
export type PagerDutyUserRef = {
  id: string;
  name: string;
};

/** A user, with what is needed to contact or assign them. */
export type PagerDutyUser = PagerDutyUserRef & {
  email: string;
  /** e.g. `"Site Reliability Engineer"`, if set. */
  jobTitle: string | null;
  timeZone: string;
  htmlUrl: string;
};

/** A team member and their role on the team. */
export type PagerDutyTeamMember = PagerDutyUser & {
  teamRole: "observer" | "responder" | "manager";
};

/** A reference to another PagerDuty object. */
export type PagerDutyRef = {
  id: string;
  name: string;
  htmlUrl: string;
};

export type PagerDutyPriority = {
  id: string;
  name: string;
  description: string;
};

/** The account and who is connected to it. */
export type PagerDutyAccountMetadata = {
  /** e.g. `"acme"` for https://acme.pagerduty.com */
  subdomain: string;
  htmlUrl: string;
  /** The connected user; incidents can be filtered with `assignedToMe`. */
  you: PagerDutyUser;
};

export type PagerDutyTeamSummary = PagerDutyRef & {
  description: string | null;
};

export type PagerDutyTeamMetadata = PagerDutyTeamSummary & {
  /** The connected user. */
  you: PagerDutyUser;
};

export type PagerDutyServiceSummary = PagerDutyRef & {
  description: string | null;
  /** `"critical"` while it has a high-urgency open incident, `"warning"` for low urgency. */
  status: "active" | "warning" | "critical" | "maintenance" | "disabled";
  team: PagerDutyRef | null;
};

export type PagerDutyServiceDetails = PagerDutyServiceSummary & {
  escalationPolicy: PagerDutyRef;
  /** Seconds after which an acknowledged incident re-triggers, or `null` for never. */
  acknowledgementTimeout: number | null;
  /** Seconds after which an open incident resolves itself, or `null` for never. */
  autoResolveTimeout: number | null;
  createdAt: string;
  /** You, as this service's connected user. */
  you: PagerDutyUser;
};

/** An incident, as lists return it. */
export type PagerDutyIncidentSummary = {
  id: string;
  /** The account-wide incident number, e.g. `12345`; 0 until PagerDuty opens a pending incident. */
  number: number;
  title: string;
  status: PagerDutyIncidentStatus;
  urgency: PagerDutyUrgency;
  priority: string | null;
  service: PagerDutyRef;
  team: PagerDutyRef | null;
  assignees: PagerDutyUserRef[];
  createdAt: string;
  /** When its status last changed. */
  updatedAt: string;
  /** Empty until PagerDuty opens a pending incident. */
  htmlUrl: string;
};

/** An incident's full details. */
export type PagerDutyIncidentDetails = PagerDutyIncidentSummary & {
  /** Plain-text details given when it was opened by hand, if any. */
  details: string | null;
  escalationPolicy: PagerDutyRef;
  acknowledgers: { user: PagerDutyUserRef; at: string }[];
  /** The deduplication key, if any. */
  incidentKey: string | null;
  resolvedAt: string | null;
  /** The number of alerts grouped into it. */
  alertCount: number;
  /**
   * The first alert's payload, as the monitoring tool sent it: typically a summary, severity,
   * source and tool-specific custom details.
   */
  firstAlert: PagerDutyAlert | null;
  /** The incident's conference bridge, if one was set. */
  conferenceUrl: string | null;
};

/** One alert grouped into an incident. */
export type PagerDutyAlert = {
  id: string;
  summary: string;
  status: "triggered" | "resolved";
  severity: "critical" | "error" | "warning" | "info";
  createdAt: string;
  /** Where it came from, e.g. a hostname. */
  source: string | null;
  /** The monitoring tool's own details, as JSON. */
  details: Record<string, unknown> | null;
  htmlUrl: string;
};

/** One line of an incident's log. */
export type PagerDutyTimelineEntry = {
  id: string;
  at: string;
  /** e.g. `"trigger"`, `"notify"`, `"acknowledge"`, `"escalate"`, `"assign"`, `"annotate"`, `"resolve"`. */
  kind: string;
  /** PagerDuty's one-line description, e.g. "Notified Jane Doe via SMS". */
  summary: string;
  actor: PagerDutyUserRef | null;
};

export type PagerDutyNote = {
  id: string;
  content: string;
  author: PagerDutyUserRef | null;
  createdAt: string;
};

/** One user's turn on call. */
export type PagerDutyOnCall = {
  user: PagerDutyUserRef;
  /** 1 is the first level notified. */
  level: number;
  escalationPolicy: PagerDutyRef;
  /** `null` when the user is on the escalation policy directly rather than through a schedule. */
  schedule: PagerDutyRef | null;
  /** `null` for open-ended (directly on the escalation policy). */
  start: string | null;
  end: string | null;
};

export type PagerDutyScheduleSummary = PagerDutyRef & {
  description: string | null;
  timeZone: string;
  teams: PagerDutyRef[];
};

export type PagerDutyScheduleDetails = PagerDutyScheduleSummary & {
  escalationPolicies: PagerDutyRef[];
  /** The rotations the schedule combines, highest first. */
  layers: {
    name: string;
    users: PagerDutyUserRef[];
    /** Seconds per turn, e.g. 604800 for a weekly rotation. */
    turnLength: number;
  }[];
};

/** A span of a schedule, overrides applied. */
export type PagerDutyShift = {
  user: PagerDutyUserRef;
  start: string;
  end: string;
};

export type PagerDutyOverride = {
  id: string;
  user: PagerDutyUserRef;
  start: string;
  end: string;
};
