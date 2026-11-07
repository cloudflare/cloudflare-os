// What a gadget can change in PagerDuty, as kit actions: each kind's approval text, auto-approval
// verdict and REST call. Sessions validate and stage them (the pagerduty-*session*.ts modules);
// nothing here runs until a user approves, and apply first checks that a team or service binding
// still reaches what the action changes, and that an incident being acknowledged isn't resolved.
// Incidents and overrides a pending action creates have temporary `~N` IDs, which later actions can
// name and which apply resolves to PagerDuty's.

import {
  ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionPresentation, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle, type ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { PagerDutyApiError, type PagerDutyApi } from "./pagerduty-api";
import type { Identity } from "./pagerduty-credentials";
import { VENDOR_ID, type Tenant } from "./pagerduty-env";
import type { WireIncident, WireOverride } from "./pagerduty-normalize";
import type { ScopedObject } from "./pagerduty-session-shared";
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
  /** The service, its teams, and the escalation policy it would notify, as staging read them. */
  service: PagerDutyRef;
  teams: PagerDutyRef[];
  escalationPolicy: PagerDutyRef;
  title: string;
  details?: string;
  priority?: PriorityTarget;
  assignTo?: UserTarget[];
  incidentKey?: string;
  /** When it was staged, which is when a simulated read says it was created. */
  stagedAt: string;
} & (
  | { urgency: PagerDutyUrgency; serviceUrgency?: never }
  /** Left to PagerDuty, whose service rule gave `serviceUrgency` when it was staged: what reads show meanwhile. */
  | { urgency?: never; serviceUrgency: PagerDutyUrgency }
);

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
  lowerUrgency: { incident: IncidentTarget };
  raiseUrgency: { incident: IncidentTarget };
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
  /**
   * @throws ActionApplyError once `object` (an incident, or the service or schedule an action adds
   * to) has left the team or service the binding is scoped to.
   */
  requireInScope(object: ScopedObject): Promise<void>;
  /**
   * The incident `id` as PagerDuty has it now, read afresh.
   * @throws ActionApplyError once it has left the team or service the binding is scoped to.
   */
  currentIncident(id: string): Promise<WireIncident>;
  /** Drops every cached read, once an action changed what they hold. */
  invalidate(): void;
};

/** Whether an ID is a temporary one a pending action created. */
export const isProvisional = (id: string): boolean => id.startsWith("~");

/**
 * Which incident `target` is now (PagerDuty's ID once the action creating it applied), refused once
 * it has left the binding's scope.
 */
async function incidentId(host: PagerDutyActionHost, target: IncidentTarget): Promise<string> {
  const id = host.refs.requireResolved(target.id, { expectedKind: "incident" });
  await host.requireInScope({ kind: "incident", id });
  return id;
}

/**
 * The temporary reference a payload builds on, if any: its incident's, or the override it removes.
 * Every definition's `dependsOn`.
 */
export function dependedRefs(payload: PagerDutyActions[keyof PagerDutyActions]): string[] {
  const ref = "incident" in payload ? payload.incident.id : "overrideId" in payload ? payload.overrideId : undefined;
  return ref !== undefined && isProvisional(ref) ? [ref] : [];
}

/**
 * The temporary reference an action creates, if any: the incident or override it opens. A note's
 * `ref` names it only for simulation; no later action builds on it.
 */
export function providedRefs(action: PagerDutyAction): string[] {
  switch (action.kind) {
    case "createIncident":
    case "createOverride":
    case "createOverrideForOthers":
      return [action.payload.ref];
    default:
      return [];
  }
}

/** The kind a temporary override ID is allocated with, which ties it to the override's schedule. */
export const overrideKind = (scheduleId: string) => `override:${scheduleId}` as const;

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
 * Sends a change PagerDuty applies at most once per call. Only the request's own failure is
 * classified: PagerDuty's refusal left nothing behind, and any other failure may have landed after
 * all. A rate limit or credential rejection stopped the call, so it is retried as it came, as is
 * anything that failed before the request was made (the connected user, the credentials).
 */
async function once<T>(host: PagerDutyActionHost, op: (api: PagerDutyApi, me: Identity) => Promise<T>): Promise<T> {
  return await host.write(async (api, me) => {
    try {
      return await op(api, me);
    } catch (error) {
      if (error instanceof PagerDutyApiError && (error.status === 401 || error.status === 429)) throw error;
      if (error instanceof PagerDutyApiError && error.status < 500) throw new ActionApplyError(error.message);
      throw new ActionOutcomeUnknownError(error instanceof Error ? error.message : "PagerDuty did not answer.");
    }
  });
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

/** Updates the incident `id` with the `PUT /incidents/{id}` fields in `incident`. */
async function putIncident(host: PagerDutyActionHost, id: string, incident: Record<string, unknown>): Promise<void> {
  await idempotent(host, api => api.write("PUT", `/incidents/${id}`, { incident: { type: "incident_reference", ...incident } }));
}

/** Updates the incident `target` is, refused once it has left the binding's scope. */
async function updateIncident(host: PagerDutyActionHost, target: IncidentTarget, incident: Record<string, unknown>): Promise<void> {
  await putIncident(host, await incidentId(host, target), incident);
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
      await host.requireInScope({ kind: "schedule", id: payload.scheduleId });
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

/** Setting an incident's urgency to `urgency`: its approval text and REST call. */
function urgencyDefinition(urgency: PagerDutyUrgency, autoApprovable: boolean) {
  return {
    kind: EDIT,
    autoApprovable,
    delivery: "continue-with-simulation" as const,
    dependsOn: dependedRefs,
    describe: (payload: { incident: IncidentTarget }, host: PagerDutyActionHost) =>
      present(`Set a PagerDuty incident's urgency to ${urgency}`,
        buildDescription(`Sets the urgency of ${incidentLabel(host, payload.incident)} to ${urgency}` + (urgency === "high"
          ? ", which pages its responders by their high-urgency rules and, if it is acknowledged, returns it to " +
            "triggered and resumes its escalation."
          : "."))),
    apply: (payload: { incident: IncidentTarget }, host: PagerDutyActionHost) =>
      updateIncident(host, payload.incident, { urgency }),
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
    apply: async (payload, host) => {
      const id = host.refs.requireResolved(payload.incident.id, { expectedKind: "incident" });
      // PagerDuty reopens a resolved incident it is asked to acknowledge.
      if ((await host.currentIncident(id)).status === "resolved") {
        throw new ActionApplyError("The incident was resolved in the meantime, so it was left resolved.");
      }
      await putIncident(host, id, { status: "acknowledged" });
    },
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
      const id = await incidentId(host, payload.incident);
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
  lowerUrgency: urgencyDefinition("low", true),
  // Pages responders by their high-urgency rules, resuming an acknowledged incident's escalation (rule 2).
  raiseUrgency: urgencyDefinition("high", false),
  addNote: {
    kind: NOTES,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    dependsOn: dependedRefs,
    describe: (payload, host) => present("Add a note to a PagerDuty incident",
      buildDescription(`Adds a note to ${incidentLabel(host, payload.incident)}.`).verbatim("Note", payload.content)),
    apply: async (payload, host) => {
      const id = await incidentId(host, payload.incident);
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
      const id = await incidentId(host, payload.incident);
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
      const id = await incidentId(host, payload.incident);
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
      await host.requireInScope({ kind: "service", id: payload.service.id });
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
      await host.requireInScope({ kind: "schedule", id: payload.scheduleId });
      const id = host.refs.requireResolved(payload.overrideId, { expectedKind: overrideKind(payload.scheduleId) });
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
