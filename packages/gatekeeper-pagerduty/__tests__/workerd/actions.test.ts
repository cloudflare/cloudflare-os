// Actions, from staging to apply: nothing reaches PagerDuty before approval; each change is the
// REST call PagerDuty documents, sent as the connected user (`From`); each declares its kind and
// auto-approval verdict; and reads show pending changes as if they had been made.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { PagerDutyIncidentSummary, PagerDutyOverride } from "../../src/types";
import {
  ALICE, BOB, FakePagerDuty, OTHER_SCHEDULE, OTHER_SERVICE, PRIORITY, SCHEDULE, SERVICE, TEAM, failure, hooks, seedAccount, sub,
  unwrap,
} from "./fake-pagerduty";
import type { GatekeeperProps, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Binding = { resourceKind: "account" } | { resourceKind: "team" | "service" | "incident" | "schedule"; id: string };

async function setup(binding: Binding = { resourceKind: "account" }) {
  const pd = new FakePagerDuty().install();
  const props = { userObjectId: await seedAccount(pd), region: "us", subdomain: "acme", ...binding } as GatekeeperProps;
  const name = crypto.randomUUID();
  return {
    pd,
    incident: pd.incident(SERVICE),
    run: async (steps: Step[], pages?: number) => unwrap(await hooks().run(name, props, steps, pages ? { pages } : {})),
    attempt: async (steps: Step[]) => failure(await hooks().run(name, props, steps)),
    submitted: async (): Promise<Array<{ actionId: number; description: ActionDescription }>> =>
      (await hooks().queueLog(name)).submitted,
    reported: async () => (await hooks().queueLog(name)).observations.map(o => new Set(o.subresources)),
    apply: async (actionId: number) => unwrap(await hooks().applyAction(name, props, actionId)),
    reject: async (actionId: number) => unwrap(await hooks().rejectAction(name, props, actionId)),
    autoApprovable: async () => unwrap(await hooks().autoApprovable(name, props)) as { tag: string }[],
  };
}

const START = "2026-11-10T09:00:00.000Z";
const END = "2026-11-10T17:00:00.000Z";
const incidentRef = { type: "incident_reference" };

type Case = {
  binding?: Binding;
  steps: (incidentId: string) => Step[];
  method: string;
  path: (incidentId: string) => string;
  body: unknown;
  tag: string;
  autoApprovable: boolean;
};

const onIncident = (...step: Step) => (id: string): Step[] => [["getIncident", id], step];
const incidentPath = (suffix = "") => (id: string) => `/incidents/${id}${suffix}`;
const schedule = { resourceKind: "schedule", id: SCHEDULE.id } as const;

const CASES: Record<string, Case> = {
  acknowledge: {
    steps: onIncident("acknowledge"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, status: "acknowledged" } }, tag: "acknowledge-incidents", autoApprovable: true,
  },
  resolve: {
    steps: onIncident("resolve", "Rolled back"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, status: "resolved", resolution: "Rolled back" } }, tag: "resolve-incidents", autoApprovable: true,
  },
  setPriority: {
    steps: onIncident("setPriority", "p1"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, priority: { id: PRIORITY.id, type: "priority_reference" } } }, tag: "edit-incidents", autoApprovable: true,
  },
  setTitle: {
    steps: onIncident("setTitle", "API down in EU"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, title: "API down in EU" } }, tag: "edit-incidents", autoApprovable: true,
  },
  setUrgency: {
    steps: onIncident("setUrgency", "low"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, urgency: "low" } }, tag: "edit-incidents", autoApprovable: true,
  },
  addNote: {
    steps: onIncident("addNote", "Looking into it"), method: "POST", path: incidentPath("/notes"),
    body: { note: { content: "Looking into it" } }, tag: "add-notes", autoApprovable: true,
  },
  reassign: {
    steps: onIncident("reassign", { users: ["bob@acme.test"] }), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, assignments: [{ assignee: { id: BOB.id, type: "user_reference" } }] } },
    tag: "reassign-incidents", autoApprovable: false,
  },
  escalate: {
    steps: onIncident("escalate", 2), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, escalation_level: 2 } }, tag: "reassign-incidents", autoApprovable: false,
  },
  requestResponders: {
    steps: onIncident("requestResponders", { message: "Need a DBA", users: [BOB.id] }), method: "POST",
    path: incidentPath("/responder_requests"),
    body: {
      requester_id: ALICE.id, message: "Need a DBA",
      responder_request_targets: [{ responder_request_target: { id: BOB.id, type: "user_reference" } }],
    },
    tag: "request-responders", autoApprovable: false,
  },
  postStatusUpdate: {
    steps: onIncident("postStatusUpdate", "Mitigated"), method: "POST", path: incidentPath("/status_updates"),
    body: { message: "Mitigated" }, tag: "post-status-updates", autoApprovable: false,
  },
  createIncident: {
    binding: { resourceKind: "service", id: SERVICE.id },
    steps: () => [["createIncident", { title: "Checkout failing", urgency: "low" }]], method: "POST", path: () => "/incidents",
    body: { incident: { type: "incident", title: "Checkout failing", service: { id: SERVICE.id, type: "service_reference" }, urgency: "low" } },
    tag: "create-incidents", autoApprovable: false,
  },
  "createOverride for oneself": {
    binding: schedule,
    steps: () => [["createOverride", ALICE.email, START, END]], method: "POST", path: () => `/schedules/${SCHEDULE.id}/overrides`,
    body: { overrides: [{ start: START, end: END, user: { id: ALICE.id, type: "user_reference" } }] },
    tag: "manage-overrides", autoApprovable: true,
  },
  "createOverride for someone else": {
    binding: schedule,
    steps: () => [["createOverride", BOB.id, START, END]], method: "POST", path: () => `/schedules/${SCHEDULE.id}/overrides`,
    body: { overrides: [{ start: START, end: END, user: { id: BOB.id, type: "user_reference" } }] },
    tag: "manage-overrides", autoApprovable: false,
  },
};

describe("each change", () => {
  it.each(Object.entries(CASES))("%s: sends nothing until approved, then the documented request as the user", async (_name, c) => {
    const t = await setup(c.binding);
    await t.run(c.steps(t.incident.id));
    expect(t.pd.writes()).toEqual([]);
    const [{ actionId, description }] = await t.submitted();
    expect(description).toMatchObject({ autoApprovable: c.autoApprovable, actionKind: { tag: c.tag } });

    await t.apply(actionId);
    const [write] = t.pd.writes();
    expect({ method: write.method, path: write.url.pathname, origin: write.url.origin, from: write.headers.get("from") })
      .toEqual({ method: c.method, path: c.path(t.incident.id), origin: "https://api.pagerduty.com", from: ALICE.email });
    expect(JSON.parse(write.body!)).toEqual(c.body);
  });

  it("snoozes an incident a pending acknowledgement leaves acknowledged", async () => {
    const t = await setup();
    expect(await t.attempt(onIncident("snooze", 3600)(t.incident.id))).toMatch(/Only an acknowledged incident/);
    await t.run(onIncident("acknowledge")(t.incident.id));
    await t.run(onIncident("snooze", 3600)(t.incident.id));
    const [acknowledge, snooze] = await t.submitted();
    expect(snooze.description).toMatchObject({ autoApprovable: true, actionKind: { tag: "acknowledge-incidents" } });
    await t.apply(acknowledge.actionId);
    await t.apply(snooze.actionId);
    expect(t.pd.writes().map(w => [w.method, w.url.pathname, w.body && JSON.parse(w.body)])).toEqual([
      ["PUT", `/incidents/${t.incident.id}`, { incident: { ...incidentRef, status: "acknowledged" } }],
      ["POST", `/incidents/${t.incident.id}/snooze`, { duration: 3600 }],
    ]);
  });

  it("removes an override, which is not auto-approvable", async () => {
    const t = await setup(schedule);
    t.pd.overrides.set(SCHEDULE.id, [{ id: "POVR001", start: START, end: END, user: { id: BOB.id, summary: "Bob" } }]);
    await t.run([["deleteOverride", "POVR001"]]);
    const [{ actionId, description }] = await t.submitted();
    expect(description).toMatchObject({ autoApprovable: false, actionKind: { tag: "delete-overrides" } });
    await t.apply(actionId);
    expect(t.pd.writes().map(w => [w.method, w.url.pathname])).toEqual([["DELETE", `/schedules/${SCHEDULE.id}/overrides/POVR001`]]);
    expect(t.pd.overrides.get(SCHEDULE.id)).toEqual([]);
  });
});

describe("the auto-approvable catalog", () => {
  it.each([
    [{ resourceKind: "account" }, ["acknowledge-incidents", "resolve-incidents", "edit-incidents", "add-notes", "manage-overrides"]],
    [{ resourceKind: "service", id: SERVICE.id }, ["acknowledge-incidents", "resolve-incidents", "edit-incidents", "add-notes"]],
    [{ resourceKind: "incident", id: "PINC001" }, ["acknowledge-incidents", "resolve-incidents", "edit-incidents", "add-notes"]],
    [schedule, ["manage-overrides"]],
  ] as [Binding, string[]][])("lists for a %o binding what it can submit as auto-approvable", async (binding, tags) => {
    const t = await setup(binding);
    expect((await t.autoApprovable()).map(kind => kind.tag).toSorted()).toEqual(tags.toSorted());
  });
});

describe("narrow bindings", () => {
  it("won't let a team binding add an override to another team's schedule", async () => {
    const t = await setup({ resourceKind: "team", id: "PTEAM01" });
    expect(await t.attempt([["getSchedule", "PSCH002"], ["createOverride", ALICE.email, START, END]])).toMatch(/doesn't belong to this team/);
    expect(await t.submitted()).toEqual([]);
  });

  it("won't let a service binding act on another service's incident", async () => {
    const t = await setup({ resourceKind: "service", id: "PSVC002" });
    expect(await t.attempt(onIncident("acknowledge")(t.incident.id))).toMatch(/belongs to another service/);
    expect(await t.submitted()).toEqual([]);
  });
});

describe("simulation", () => {
  it("shows an incident's pending changes and notes in its reads", async () => {
    const t = await setup();
    const steps = (...step: Step) => onIncident(...step)(t.incident.id);
    await t.run(steps("acknowledge"));
    await t.run(steps("setTitle", "Database failover"));
    await t.run(steps("setPriority", "P1"));
    await t.run(steps("reassign", { users: [BOB.email] }));
    await t.run(steps("addNote", "Failing over"));
    expect(await t.run(steps("getDetails"))).toMatchObject({
      status: "acknowledged", title: "Database failover", priority: "P1", assignees: [{ id: BOB.id }],
      acknowledgers: [{ user: { id: ALICE.id } }],
    });
    expect(await t.run(steps("listNotes"))).toMatchObject([{ content: "Failing over", author: { id: ALICE.id } }]);
    expect(t.pd.writes()).toEqual([]);
  });

  it("drops an incident a pending resolve closes from the open incidents", async () => {
    const t = await setup();
    await t.run(onIncident("resolve")(t.incident.id));
    expect(await t.run([["listIncidents"]], 5)).toEqual([]);
    expect(await t.run(onIncident("getDetails")(t.incident.id))).toMatchObject({ status: "resolved", assignees: [] });
  });

  it("lists an incident a pending action opens, and binds what builds on it to the incident PagerDuty made", async () => {
    const t = await setup({ resourceKind: "service", id: SERVICE.id });
    await t.run([["createIncident", { title: "Checkout failing" }], ["addNote", "Paging payments"]]);
    const [[opened, existing]] = await t.run([["listIncidents"]], 5) as PagerDutyIncidentSummary[][];
    expect(opened).toMatchObject({ id: "~1", title: "Checkout failing", status: "triggered", service: { id: SERVICE.id } });
    expect(existing.id).toBe(t.incident.id);
    expect(await t.run([["getIncident", "~1"], ["listNotes"]])).toMatchObject([{ content: "Paging payments" }]);

    const [create, note] = await t.submitted();
    await t.apply(create.actionId);
    await t.apply(note.actionId);
    const made = [...t.pd.incidents.values()].find(i => i.title === "Checkout failing")!;
    expect(t.pd.notes.get(made.id)).toMatchObject([{ content: "Paging payments" }]);
    expect(await t.run([["getIncident", "~1"], ["getDetails"]])).toMatchObject({ id: made.id });
  });

  it("reports the service of an incident a pending action opens, whose details staging read from it", async () => {
    const t = await setup();
    await t.run([["getService", OTHER_SERVICE.id], ["createIncident", { title: "Refunds failing" }]]);
    const [[opened, existing]] = await t.run([["listIncidents"]], 5) as PagerDutyIncidentSummary[][];
    expect([opened.service.name, existing.id]).toEqual(["Billing", t.incident.id]);
    expect(await t.reported()).toEqual([new Set([sub(), sub("service", SERVICE.id), sub("service", OTHER_SERVICE.id)])]);
  });

  it("asks the gadget to restart when a rejected incident had work built on it", async () => {
    const t = await setup({ resourceKind: "service", id: SERVICE.id });
    await t.run([["createIncident", { title: "Checkout failing" }], ["addNote", "Paging payments"]]);
    const [create] = await t.submitted();
    expect(await t.reject(create.actionId)).toEqual({ restart: true });
    expect(await t.run([["listIncidents"]], 5)).toMatchObject([[{ id: t.incident.id }]]);
  });

  it("lists and reports, in a team binding, an incident a pending action opens on one of its services", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    await t.run([["getService", SERVICE.id], ["createIncident", { title: "Checkout failing" }]]);
    const [[opened, existing]] = await t.run([["listIncidents"]], 5) as PagerDutyIncidentSummary[][];
    expect([opened.id, opened.team?.id, existing.id]).toEqual(["~1", TEAM.id, t.incident.id]);
    expect(await t.reported()).toEqual([new Set([sub(), sub("team", TEAM.id), sub("service", SERVICE.id)])]);
  });

  it("shows pending overrides in a schedule's overrides and shifts, and hides one pending removal", async () => {
    const t = await setup(schedule);
    t.pd.overrides.set(SCHEDULE.id, [{ id: "POVR001", start: START, end: END, user: { id: ALICE.id, summary: "Alice" } }]);
    t.pd.shifts.set(SCHEDULE.id, [{ start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z", user: { id: ALICE.id, summary: "Alice" } }]);
    const ref = await t.run([["createOverride", BOB.email, START, END]]);
    expect(ref).toBe("~1");
    await t.run([["deleteOverride", "POVR001"]]);
    const window = { since: "2026-11-10T00:00:00.000Z", until: "2026-11-11T00:00:00.000Z" };
    expect(await t.run([["listOverrides", window]])).toEqual([{ id: "~1", user: { id: BOB.id, name: "Bob" }, start: START, end: END }]);
    expect(await t.run([["listShifts", window]])).toEqual([
      { user: { id: ALICE.id, name: "Alice" }, start: "2026-11-10T00:00:00.000Z", end: START },
      { user: { id: BOB.id, name: "Bob" }, start: START, end: END },
      { user: { id: ALICE.id, name: "Alice" }, start: END, end: "2026-11-11T00:00:00.000Z" },
    ]);
  });

  it("shows an override already under way ending when its removal was staged, and tells the approver", async () => {
    const t = await setup(schedule);
    const hour = 60 * 60_000;
    const start = new Date(Date.now() - hour).toISOString();
    const end = new Date(Date.now() + hour).toISOString();
    t.pd.overrides.set(SCHEDULE.id, [{ id: "POVR001", start, end, user: { id: BOB.id, summary: "Bob" } }]);
    const staging = Date.now();
    await t.run([["deleteOverride", "POVR001"]]);
    const window = { since: new Date(Date.now() - 2 * hour).toISOString() };
    const [override] = await t.run([["listOverrides", window]]) as PagerDutyOverride[];
    expect(override).toMatchObject({ id: "POVR001", start });
    expect(Date.parse(override.end)).toBeGreaterThanOrEqual(staging);
    expect(Date.parse(override.end)).toBeLessThan(Date.parse(end));
    const [{ description }] = await t.submitted();
    expect(description.description).toMatch(/or ends it now if it has already begun/);
  });

  it("removes an override another action is adding only through the schedule it is adding it to", async () => {
    const t = await setup();
    expect(await t.run([["getSchedule", SCHEDULE.id], ["createOverride", ALICE.email, START, END]])).toBe("~1");
    expect(await t.attempt([["getSchedule", OTHER_SCHEDULE.id], ["deleteOverride", "~1"]]))
      .toMatch(/isn't one this gadget is adding to this schedule/);
    await t.run([["getSchedule", SCHEDULE.id], ["deleteOverride", "~1"]]);
    expect((await t.submitted()).map(({ description }) => description.actionKind?.tag)).toEqual(["manage-overrides", "delete-overrides"]);
    expect(await t.run([["getSchedule", SCHEDULE.id], ["listOverrides", { since: START, until: END }]])).toEqual([]);
  });
});
