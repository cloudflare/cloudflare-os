// PagerDuty's REST objects as the gatekeeper reads them, and their conversion into the shapes
// types.d.ts gives the agent. Only the fields a conversion reads are declared; PagerDuty sends
// references (`*_reference`, named by `summary`) and full objects (named by `name`) alike.

import type {
  PagerDutyAlert, PagerDutyIncidentDetails, PagerDutyIncidentStatus, PagerDutyIncidentSummary,
  PagerDutyNote, PagerDutyOnCall, PagerDutyOverride, PagerDutyPriority, PagerDutyRef,
  PagerDutyScheduleDetails, PagerDutyScheduleSummary, PagerDutyServiceDetails, PagerDutyServiceSummary,
  PagerDutyShift, PagerDutyTeamMember, PagerDutyTeamSummary, PagerDutyTimelineEntry, PagerDutyUrgency,
  PagerDutyUser, PagerDutyUserRef,
} from "./types";

export type WireRef = {
  id: string;
  type?: string;
  summary?: string | null;
  name?: string | null;
  html_url?: string | null;
};

export type WireUser = WireRef & {
  email: string;
  job_title?: string | null;
  time_zone?: string | null;
  role?: string;
  avatar_url?: string | null;
};

export type WireTeam = WireRef & { description?: string | null };

export type WireService = WireRef & {
  description?: string | null;
  status?: PagerDutyServiceSummary["status"];
  teams?: WireRef[];
  escalation_policy?: WireRef;
  acknowledgement_timeout?: number | null;
  auto_resolve_timeout?: number | null;
  created_at?: string;
};

export type WireIncident = WireRef & {
  incident_number: number;
  title: string;
  status: PagerDutyIncidentStatus;
  urgency: PagerDutyUrgency;
  priority?: WireRef | null;
  service: WireRef;
  teams?: WireRef[];
  escalation_policy?: WireRef;
  assignments?: { assignee: WireRef }[];
  acknowledgements?: { acknowledger: WireRef; at: string }[];
  incident_key?: string | null;
  created_at: string;
  last_status_change_at?: string;
  resolved_at?: string | null;
  alert_counts?: { all?: number };
  conference_bridge?: { conference_url?: string | null } | null;
  body?: { details?: unknown } | null;
};

export type WireAlert = WireRef & {
  status: PagerDutyAlert["status"];
  severity?: PagerDutyAlert["severity"];
  created_at: string;
  body?: { details?: unknown; cef_details?: { source_origin?: string | null } } | null;
};

export type WireLogEntry = WireRef & { created_at: string; agent?: WireRef | null };

export type WireNote = { id: string; content: string; created_at: string; user?: WireRef | null };

export type WireOnCall = {
  user: WireRef;
  escalation_level: number;
  escalation_policy: WireRef;
  schedule?: WireRef | null;
  start?: string | null;
  end?: string | null;
};

export type WireSchedule = WireRef & {
  description?: string | null;
  time_zone: string;
  teams?: WireRef[];
  escalation_policies?: WireRef[];
  schedule_layers?: {
    name?: string;
    users?: { user: WireRef }[];
    rotation_turn_length_seconds?: number;
  }[];
  final_schedule?: { rendered_schedule_entries?: WireShift[] };
};

export type WireShift = { user: WireRef; start: string; end: string };

export type WireOverride = WireShift & { id: string };

export type WirePriority = { id: string; name: string; description?: string | null };

export type WireMember = { user: WireUser; role: string };

/** What another object names this one by. */
export function toRef(wire: WireRef): PagerDutyRef {
  return { id: wire.id, name: wire.name ?? wire.summary ?? wire.id, htmlUrl: wire.html_url ?? "" };
}

export function toUserRef(wire: WireRef): PagerDutyUserRef {
  return { id: wire.id, name: wire.name ?? wire.summary ?? wire.id };
}

export function toUser(wire: WireUser): PagerDutyUser {
  return {
    ...toUserRef(wire),
    email: wire.email,
    jobTitle: wire.job_title || null,
    timeZone: wire.time_zone ?? "",
    htmlUrl: wire.html_url ?? "",
  };
}

/** A member's team role; PagerDuty's lowest, `observer`, for one it doesn't name. */
export function toMember(wire: WireMember): PagerDutyTeamMember {
  const teamRole = wire.role === "responder" || wire.role === "manager" ? wire.role : "observer";
  return { ...toUser(wire.user), teamRole };
}

export function toTeam(wire: WireTeam): PagerDutyTeamSummary {
  return { ...toRef(wire), description: wire.description || null };
}

export function toServiceSummary(wire: WireService): PagerDutyServiceSummary {
  const team = wire.teams?.[0];
  return {
    ...toRef(wire),
    description: wire.description || null,
    status: wire.status ?? "active",
    team: team ? toRef(team) : null,
  };
}

export function toServiceDetails(wire: WireService, you: PagerDutyUser): PagerDutyServiceDetails {
  if (!wire.escalation_policy) throw new Error("PagerDuty described a service without its escalation policy.");
  return {
    ...toServiceSummary(wire),
    escalationPolicy: toRef(wire.escalation_policy),
    acknowledgementTimeout: wire.acknowledgement_timeout ?? null,
    autoResolveTimeout: wire.auto_resolve_timeout ?? null,
    createdAt: wire.created_at ?? "",
    you,
  };
}

export function toIncidentSummary(wire: WireIncident): PagerDutyIncidentSummary {
  const team = wire.teams?.[0];
  return {
    id: wire.id,
    number: wire.incident_number,
    title: wire.title,
    status: wire.status,
    urgency: wire.urgency,
    priority: wire.priority ? wire.priority.name ?? wire.priority.summary ?? null : null,
    service: toRef(wire.service),
    team: team ? toRef(team) : null,
    assignees: (wire.assignments ?? []).map(({ assignee }) => toUserRef(assignee)),
    createdAt: wire.created_at,
    updatedAt: wire.last_status_change_at ?? wire.created_at,
    htmlUrl: wire.html_url ?? "",
  };
}

/** Plain-text details given when the incident was opened by hand, if any. */
function detailsOf(body: WireIncident["body"]): string | null {
  const details = body?.details;
  if (details === undefined || details === null || details === "") return null;
  return typeof details === "string" ? details : JSON.stringify(details);
}

export function toIncidentDetails(wire: WireIncident, firstAlert: WireAlert | null): PagerDutyIncidentDetails {
  if (!wire.escalation_policy) throw new Error("PagerDuty described an incident without its escalation policy.");
  return {
    ...toIncidentSummary(wire),
    details: detailsOf(wire.body),
    escalationPolicy: toRef(wire.escalation_policy),
    acknowledgers: (wire.acknowledgements ?? []).map(({ acknowledger, at }) => ({ user: toUserRef(acknowledger), at })),
    incidentKey: wire.incident_key || null,
    resolvedAt: wire.resolved_at ?? null,
    alertCount: wire.alert_counts?.all ?? 0,
    firstAlert: firstAlert && toAlert(firstAlert),
    conferenceUrl: wire.conference_bridge?.conference_url || null,
  };
}

export function toAlert(wire: WireAlert): PagerDutyAlert {
  const details = wire.body?.details;
  return {
    id: wire.id,
    summary: wire.summary ?? "",
    status: wire.status,
    severity: wire.severity ?? "info",
    createdAt: wire.created_at,
    source: wire.body?.cef_details?.source_origin || null,
    details: details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null,
    htmlUrl: wire.html_url ?? "",
  };
}

export function toTimelineEntry(wire: WireLogEntry): PagerDutyTimelineEntry {
  const actor = wire.agent?.type?.startsWith("user") ? toUserRef(wire.agent) : null;
  return {
    id: wire.id,
    at: wire.created_at,
    kind: (wire.type ?? "").replace(/_log_entry$/, ""),
    summary: wire.summary ?? "",
    actor,
  };
}

export function toNote(wire: WireNote): PagerDutyNote {
  return { id: wire.id, content: wire.content, author: wire.user ? toUserRef(wire.user) : null, createdAt: wire.created_at };
}

export function toOnCall(wire: WireOnCall): PagerDutyOnCall {
  return {
    user: toUserRef(wire.user),
    level: wire.escalation_level,
    escalationPolicy: toRef(wire.escalation_policy),
    schedule: wire.schedule ? toRef(wire.schedule) : null,
    start: wire.start ?? null,
    end: wire.end ?? null,
  };
}

export function toScheduleSummary(wire: WireSchedule): PagerDutyScheduleSummary {
  return {
    ...toRef(wire),
    description: wire.description || null,
    timeZone: wire.time_zone,
    teams: (wire.teams ?? []).map(toRef),
  };
}

export function toScheduleDetails(wire: WireSchedule): PagerDutyScheduleDetails {
  return {
    ...toScheduleSummary(wire),
    escalationPolicies: (wire.escalation_policies ?? []).map(toRef),
    layers: (wire.schedule_layers ?? []).map(layer => ({
      name: layer.name ?? "",
      users: (layer.users ?? []).map(({ user }) => toUserRef(user)),
      turnLength: layer.rotation_turn_length_seconds ?? 0,
    })),
  };
}

export function toShift(wire: WireShift): PagerDutyShift {
  return { user: toUserRef(wire.user), start: wire.start, end: wire.end };
}

export function toOverride(wire: WireOverride): PagerDutyOverride {
  return { id: wire.id, ...toShift(wire) };
}

export function toPriority(wire: WirePriority): PagerDutyPriority {
  return { id: wire.id, name: wire.name, description: wire.description ?? "" };
}
