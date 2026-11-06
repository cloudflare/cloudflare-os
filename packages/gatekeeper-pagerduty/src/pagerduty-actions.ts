// What a gadget can change in PagerDuty, as kit actions: each kind's approval text, auto-approval
// verdict and REST call. Sessions validate and stage them (the pagerduty-*session*.ts modules);
// nothing here runs until a user approves. Incidents and overrides a pending action creates have
// temporary `~N` IDs, which later actions can name and which apply resolves to PagerDuty's.

import {
  ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionPresentation, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle, type ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { PagerDutyApiError, type PagerDutyApi } from "./pagerduty-api";
import type { Identity } from "./pagerduty-credentials";
import { VENDOR_ID, type Tenant } from "./pagerduty-env";
import type { WireIncident, WireOverride } from "./pagerduty-normalize";
import { resourceUrl } from "./pagerduty-urls";
import type { PagerDutyRef, PagerDutyUrgency } from "./types";

/** An incident an action acts on: PagerDuty's ID, or the `~N` of one a pending action creates. */
export type IncidentTarget = { id: string; number?: number };

/** A user named by the agent (email or ID), as the gatekeeper resolved them when staging. */
export type UserTarget = { id: string; name: string; given: string };

/** A priority, resolved by name when staging. */
export type PriorityTarget = { id: string; name: string };

export type NewIncident = {
  /** The `~N` the pending incident goes by until PagerDuty assigns its ID. */
  ref: string;
  /** The service, and the escalation policy it would notify, as staging read them. */
  service: PagerDutyRef;
  team: PagerDutyRef | null;
  escalationPolicy: PagerDutyRef;
  title: string;
  details?: string;
  urgency?: PagerDutyUrgency;
  priority?: PriorityTarget;
  assignTo?: UserTarget[];
  incidentKey?: string;
  /** When it was staged, which is when a simulated read says it was created. */
  stagedAt: string;
};

export type NewOverride = {
  /** The `~N` the pending override goes by until PagerDuty assigns its ID. */
  ref: string;
  scheduleId: string;
  user: UserTarget;
  start: string;
  end: string;
};

/** Every action's payload, by kind. */
export type PagerDutyActions = {
  acknowledge: { incident: IncidentTarget };
  snooze: { incident: IncidentTarget; seconds: number };
  resolve: { incident: IncidentTarget; resolution?: string };
  setPriority: { incident: IncidentTarget; priority: PriorityTarget | null };
  setTitle: { incident: IncidentTarget; title: string };
  setUrgency: { incident: IncidentTarget; urgency: PagerDutyUrgency };
  addNote: { incident: IncidentTarget; ref: string; content: string; stagedAt: string };
  reassign: { incident: IncidentTarget; to: { users: UserTarget[] } | { escalationPolicyId: string } };
  escalate: { incident: IncidentTarget; level: number };
  requestResponders: {
    incident: IncidentTarget; message: string; users: UserTarget[]; escalationPolicyIds: string[];
  };
  postStatusUpdate: { incident: IncidentTarget; message: string };
  createIncident: NewIncident;
  createOverride: NewOverride;
  /** As `createOverride`, for an override putting someone other than the connected user on call. */
  createOverrideForOthers: NewOverride;
  /** `stagedAt` is when a simulated read says an override already under way ended. */
  deleteOverride: { scheduleId: string; overrideId: string; stagedAt: string };
};

export type PagerDutyAction = TaggedAction<PagerDutyActions>;

/** What apply handlers may do. */
export type PagerDutyActionHost = {
  readonly tenant: Tenant;
  readonly refs: ProvisionalIds<string>;
  /** Runs a write as the connected user, who `From` names. */
  write<T>(op: (api: PagerDutyApi, me: Identity) => Promise<T>): Promise<T>;
  /** Drops every cached read, once an action changed what they hold. */
  invalidate(): void;
};

/** Whether an ID is a temporary one a pending action created. */
export const isProvisional = (id: string): boolean => id.startsWith("~");

/** Which incident `target` is now: PagerDuty's ID once the action creating it applied. */
const incidentId = (host: PagerDutyActionHost, target: IncidentTarget): string =>
  host.refs.requireResolved(target.id, { expectedKind: "incident" });

/**
 * The temporary reference a payload builds on, if any: its incident's, or the override it removes.
 * Every definition's `dependsOn`.
 */
export function dependedRefs(payload: PagerDutyActions[keyof PagerDutyActions]): string[] {
  const ref = "incident" in payload ? payload.incident.id : "overrideId" in payload ? payload.overrideId : undefined;
  return ref !== undefined && isProvisional(ref) ? [ref] : [];
}

/** How the approval text names an incident: a link once it exists. */
function incidentLabel(host: PagerDutyActionHost, target: IncidentTarget): string {
  if (isProvisional(target.id)) return "the incident this gadget is opening";
  const url = resourceUrl({ ...host.tenant, kind: "incident", id: target.id });
  return `[incident ${target.number === undefined ? target.id : `#${target.number}`}](${url})`;
}

function present(title: string, description: ActionDescriptionBuilder): ActionPresentation {
  // No PagerDuty action can be undone through the API, so none implements revert.
  return { title: sanitizeTitle(title), ...description.finish(), implementsRevert: false };
}

/** The users an action names, as the agent gave them. */
const usersGiven = (users: readonly UserTarget[]): string[] => users.map(({ given, id }) => given === id ? id : `${given} (${id})`);

/**
 * Sends a change PagerDuty applies at most once per call. PagerDuty's refusal, or a rate limit or
 * credential rejection that stopped the call, left nothing behind; any other failure may have
 * landed after all.
 */
async function once<T>(host: PagerDutyActionHost, op: (api: PagerDutyApi, me: Identity) => Promise<T>): Promise<T> {
  try {
    return await host.write(op);
  } catch (error) {
    if (error instanceof PagerDutyApiError && (error.status === 401 || error.status === 429)) throw error;
    if (error instanceof PagerDutyApiError && error.status < 500) throw new ActionApplyError(error.message);
    throw new ActionOutcomeUnknownError(error instanceof Error ? error.message : "PagerDuty did not answer.");
  }
}

/** Sends a change that repeating leaves the same, so a failure is retried as it came. */
async function idempotent(host: PagerDutyActionHost, op: (api: PagerDutyApi, me: Identity) => Promise<unknown>): Promise<void> {
  try {
    await host.write(op);
  } catch (error) {
    if (error instanceof PagerDutyApiError && error.status < 500 && error.status !== 401 && error.status !== 429) {
      throw new ActionApplyError(error.message);
    }
    throw error;
  }
}

/** Updates the incident with the `PUT /incidents/{id}` fields in `incident`. */
function updateIncident(host: PagerDutyActionHost, target: IncidentTarget, incident: Record<string, unknown>): Promise<void> {
  const id = incidentId(host, target);
  return idempotent(host, api => api.write("PUT", `/incidents/${id}`, { incident: { type: "incident_reference", ...incident } }));
}

const userReference = ({ id }: UserTarget) => ({ id, type: "user_reference" });
const priorityReference = (priority: PriorityTarget | null | undefined) =>
  priority ? { id: priority.id, type: "priority_reference" } : null;

const ACKNOWLEDGE = { tag: "acknowledge-incidents", label: "Acknowledge and snooze incidents" };
const RESOLVE = { tag: "resolve-incidents", label: "Resolve incidents" };
const EDIT = { tag: "edit-incidents", label: "Change incidents' title, priority and urgency" };
const NOTES = { tag: "add-notes", label: "Add notes to incidents" };
const REASSIGN = { tag: "reassign-incidents", label: "Reassign and escalate incidents" };
const RESPONDERS = { tag: "request-responders", label: "Ask more people to respond to incidents" };
const STATUS_UPDATES = { tag: "post-status-updates", label: "Post incident status updates" };
const CREATE = { tag: "create-incidents", label: "Open incidents" };
const OVERRIDES = { tag: "manage-overrides", label: "Add schedule overrides" };
const DELETE_OVERRIDES = { tag: "delete-overrides", label: "Remove schedule overrides" };

/** An override's approval text and its REST call, shared by the kinds for oneself and for others. */
function overrideDefinition(autoApprovable: boolean) {
  return {
    kind: OVERRIDES,
    autoApprovable,
    delivery: "continue-with-simulation" as const,
    claimBeforeApply: true,
    provides: (payload: NewOverride) => [payload.ref],
    describe: (payload: NewOverride, host: PagerDutyActionHost) => present("Add a PagerDuty schedule override",
      buildDescription(`Puts a user on call on [this schedule](${resourceUrl({ ...host.tenant, kind: "schedule", id: payload.scheduleId })}), ` +
        "over whoever it would otherwise have.")
        .inline("User", usersGiven([payload.user])[0])
        .inline("From", payload.start)
        .inline("Until", payload.end)),
    apply: async (payload: NewOverride, host: PagerDutyActionHost) => {
      const [result] = await once(host, api => api.write<{ status: number; errors?: string[]; override?: WireOverride }[]>(
        "POST", `/schedules/${payload.scheduleId}/overrides`,
        { overrides: [{ start: payload.start, end: payload.end, user: userReference(payload.user) }] }));
      if (!result?.override?.id) {
        throw new ActionApplyError(`PagerDuty refused the override${result?.errors?.length ? `: ${result.errors.join("; ")}` : "."}`);
      }
      host.refs.bind(payload.ref, result.override.id);
    },
  };
}

/** The declared action set. */
export const actions = defineActions<PagerDutyActionHost, PagerDutyActions>({
  acknowledge: {
    kind: ACKNOWLEDGE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Acknowledge a PagerDuty incident",
      buildDescription(`Acknowledges ${incidentLabel(host, payload.incident)} as you, which stops its escalation.`)),
    apply: (payload, host) => updateIncident(host, payload.incident, { status: "acknowledged" }),
  },
  snooze: {
    kind: ACKNOWLEDGE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Snooze a PagerDuty incident",
      buildDescription(`Snoozes ${incidentLabel(host, payload.incident)}: it triggers again after the time below ` +
        "unless it is resolved first.").inline("Seconds", String(payload.seconds))),
    apply: async (payload, host) => {
      const id = incidentId(host, payload.incident);
      await idempotent(host, api => api.write("POST", `/incidents/${id}/snooze`, { duration: payload.seconds }));
    },
  },
  resolve: {
    kind: RESOLVE,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => {
      const description = buildDescription(`Resolves ${incidentLabel(host, payload.incident)}.`);
      if (payload.resolution !== undefined) description.verbatim("Resolution note", payload.resolution);
      return present("Resolve a PagerDuty incident", description);
    },
    apply: (payload, host) => updateIncident(host, payload.incident,
      { status: "resolved", ...(payload.resolution !== undefined ? { resolution: payload.resolution } : {}) }),
  },
  setPriority: {
    kind: EDIT,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Set a PagerDuty incident's priority",
      buildDescription(`Sets the priority of ${incidentLabel(host, payload.incident)}.`)
        .inline("Priority", payload.priority?.name ?? "(none)")),
    apply: (payload, host) => updateIncident(host, payload.incident, { priority: priorityReference(payload.priority) }),
  },
  setTitle: {
    kind: EDIT,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Retitle a PagerDuty incident",
      buildDescription(`Replaces the title of ${incidentLabel(host, payload.incident)}.`).inline("Title", payload.title)),
    apply: (payload, host) => updateIncident(host, payload.incident, { title: payload.title }),
  },
  setUrgency: {
    kind: EDIT,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present(`Set a PagerDuty incident's urgency to ${payload.urgency}`,
      buildDescription(`Sets the urgency of ${incidentLabel(host, payload.incident)} to ${payload.urgency}` +
        (payload.urgency === "high" ? ", which may notify its assignees again." : "."))),
    apply: (payload, host) => updateIncident(host, payload.incident, { urgency: payload.urgency }),
  },
  addNote: {
    kind: NOTES,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Add a note to a PagerDuty incident",
      buildDescription(`Adds a note to ${incidentLabel(host, payload.incident)}.`).verbatim("Note", payload.content)),
    apply: async (payload, host) => {
      const id = incidentId(host, payload.incident);
      await once(host, api => api.write("POST", `/incidents/${id}/notes`, { note: { content: payload.content } }));
    },
  },
  reassign: {
    kind: REASSIGN,
    // Notifies the new assignees, who may be outside the bound resource (rule 2).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => {
      const description = buildDescription(`Reassigns ${incidentLabel(host, payload.incident)}, replacing its ` +
        "assignees and notifying the new ones.");
      if ("users" in payload.to) description.list("Users", usersGiven(payload.to.users));
      else description.inline("Escalation policy", payload.to.escalationPolicyId);
      return present("Reassign a PagerDuty incident", description);
    },
    apply: (payload, host) => updateIncident(host, payload.incident, "users" in payload.to
      ? { assignments: payload.to.users.map(user => ({ assignee: userReference(user) })) }
      : { escalation_policy: { id: payload.to.escalationPolicyId, type: "escalation_policy_reference" } }),
  },
  escalate: {
    kind: REASSIGN,
    // Notifies whoever the level names, who may be outside the bound resource (rule 2).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Escalate a PagerDuty incident",
      buildDescription(`Escalates ${incidentLabel(host, payload.incident)} to this level of its escalation ` +
        "policy, notifying whoever is on call there.").inline("Level", String(payload.level))),
    apply: (payload, host) => updateIncident(host, payload.incident, { escalation_level: payload.level }),
  },
  requestResponders: {
    kind: RESPONDERS,
    // Pages each responder with the message (rule 2).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    dependsOn: dependedRefs,
    describe: (payload, host) => {
      const description = buildDescription(`Asks more people to help with ${incidentLabel(host, payload.incident)}, ` +
        "paging each with the message below.").verbatim("Message", payload.message);
      if (payload.users.length) description.list("Users", usersGiven(payload.users));
      if (payload.escalationPolicyIds.length) description.list("Escalation policies", payload.escalationPolicyIds);
      return present("Request responders for a PagerDuty incident", description);
    },
    apply: async (payload, host) => {
      const id = incidentId(host, payload.incident);
      await once(host, (api, me) => api.write("POST", `/incidents/${id}/responder_requests`, {
        requester_id: me.userId,
        message: payload.message,
        responder_request_targets: [
          ...payload.users.map(user => ({ responder_request_target: userReference(user) })),
          ...payload.escalationPolicyIds.map(policy =>
            ({ responder_request_target: { id: policy, type: "escalation_policy_reference" } })),
        ],
      }));
    },
  },
  postStatusUpdate: {
    kind: STATUS_UPDATES,
    // PagerDuty emails it to the incident's subscribers and stakeholders (rule 2).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Post a PagerDuty status update",
      buildDescription(`Publishes a status update on ${incidentLabel(host, payload.incident)}, which PagerDuty ` +
        "sends to its subscribers and stakeholders.").verbatim("Message", payload.message)),
    apply: async (payload, host) => {
      const id = incidentId(host, payload.incident);
      await once(host, api => api.write("POST", `/incidents/${id}/status_updates`, { message: payload.message }));
    },
  },
  createIncident: {
    kind: CREATE,
    // Pages whoever the service's escalation policy or the assignees name (rule 2).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    provides: payload => [payload.ref],
    describe: (payload, host) => {
      const service = resourceUrl({ ...host.tenant, kind: "service", id: payload.service.id });
      const description = buildDescription(`Opens an incident on [this service](${service}), which notifies ` +
        (payload.assignTo?.length ? "the assignees below." : "whoever its escalation policy names."))
        .inline("Title", payload.title);
      if (payload.details !== undefined) description.verbatim("Details", payload.details);
      if (payload.urgency) description.inline("Urgency", payload.urgency);
      if (payload.priority) description.inline("Priority", payload.priority.name);
      if (payload.assignTo?.length) description.list("Assign to", usersGiven(payload.assignTo));
      if (payload.incidentKey !== undefined) description.inline("Deduplication key", payload.incidentKey);
      return present(`Open a PagerDuty incident: ${payload.title}`, description);
    },
    apply: async (payload, host) => {
      const { incident } = await once(host, api => api.write<{ incident: WireIncident }>("POST", "/incidents", {
        incident: {
          type: "incident",
          title: payload.title,
          service: { id: payload.service.id, type: "service_reference" },
          ...(payload.urgency ? { urgency: payload.urgency } : {}),
          ...(payload.priority ? { priority: priorityReference(payload.priority) } : {}),
          ...(payload.details !== undefined ? { body: { type: "incident_body", details: payload.details } } : {}),
          ...(payload.assignTo?.length
            ? { assignments: payload.assignTo.map(user => ({ assignee: userReference(user) })) } : {}),
          ...(payload.incidentKey !== undefined ? { incident_key: payload.incidentKey } : {}),
        },
      }));
      host.refs.bind(payload.ref, incident.id);
    },
  },
  createOverride: overrideDefinition(true),
  // Puts someone else on call, whom PagerDuty will page (rule 2).
  createOverrideForOthers: overrideDefinition(false),
  deleteOverride: {
    kind: DELETE_OVERRIDES,
    // Removes or cuts short an override (rule 1).
    autoApprovable: false,
    delivery: "continue-with-simulation",
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Remove a PagerDuty schedule override",
      buildDescription(`Removes an override from [this schedule](${resourceUrl({ ...host.tenant, kind: "schedule", id: payload.scheduleId })}), ` +
        "or ends it now if it has already begun.")
        .inline("Override", payload.overrideId)),
    apply: async (payload, host) => {
      const id = host.refs.requireResolved(payload.overrideId, { expectedKind: "override" });
      await idempotent(host, async api => {
        try {
          await api.write("DELETE", `/schedules/${payload.scheduleId}/overrides/${id}`);
        } catch (error) {
          // Already gone counts as removed.
          if (!(error instanceof PagerDutyApiError && error.status === 404)) throw error;
        }
      });
    },
  },
}, {
  // Fenced on the connected user rather than the connection generation: a reconnect, which must be
  // the same user, must not strand what is waiting.
  fence: "authority",
  afterResolve: host => host.invalidate(),
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  vendorId: VENDOR_ID,
});

/** The temporary references an action creates. */
export function providedRefs(action: PagerDutyAction): string[] {
  return action.kind === "createIncident" || action.kind === "createOverride" || action.kind === "createOverrideForOthers"
    ? [action.payload.ref] : [];
}
