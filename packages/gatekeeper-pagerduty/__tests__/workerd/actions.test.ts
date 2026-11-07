// Actions, from staging to apply: nothing reaches PagerDuty before approval; each change is the
// REST call PagerDuty documents, sent as the connected user (`From`); each declares its kind and
// auto-approval verdict; and reads show pending changes as if they had been made.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { WireIncident } from "../../src/pagerduty-normalize";
import type { PagerDutyIncidentSummary, PagerDutyOverride } from "../../src/types";
import {
  ALICE, BOB, FakePagerDuty, OTHER_SCHEDULE, OTHER_SERVICE, OTHER_TEAM, POLICY, PRIORITY, SCHEDULE, SERVICE, SHIFT_SCHEDULE, TEAM,
  failure, hooks, accountStub, seedAccount, sub, unwrap,
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
    userObjectId: props.userObjectId,
    incident: pd.incident(SERVICE),
    run: async (steps: Step[], pages?: number, between?: Step[][]) =>
      unwrap(await hooks().run(name, props, steps, pages ? { pages, between } : {})),
    attempt: async (steps: Step[]) => failure(await hooks().run(name, props, steps)),
    submitted: async (): Promise<Array<{ actionId: number; description: ActionDescription }>> =>
      (await hooks().queueLog(name)).submitted,
    reported: async () => (await hooks().queueLog(name)).observations.map(o => new Set(o.subresources)),
    apply: async (actionId: number) => unwrap(await hooks().applyAction(name, props, actionId)),
    tryApply: async (actionId: number) => failure(await hooks().applyAction(name, props, actionId)),
    reject: async (actionId: number) => unwrap(await hooks().rejectAction(name, props, actionId)),
    autoApprovable: async () => unwrap(await hooks().autoApprovable(name, props)) as { tag: string }[],
  };
}

const HOUR = 60 * 60_000;
/** The next midnight UTC: the overrides these tests add and remove haven't begun. */
const DAY = Math.ceil(Date.now() / (24 * HOUR)) * 24 * HOUR;
const at = (hours: number) => new Date(DAY + hours * HOUR).toISOString();
const START = at(9);
const END = at(17);
const incidentRef = { type: "incident_reference" };
/** An on-call entry for `user` at the first level of the platform policy, through its schedule. */
const onCallEntry = (user: { id: string }, start: string, end: string) =>
  ({ user: { id: user.id }, level: 1, escalationPolicy: { id: POLICY.id }, schedule: { id: SCHEDULE.id }, start, end });

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
  "setUrgency to low": {
    steps: onIncident("setUrgency", "low"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, urgency: "low" } }, tag: "edit-incidents", autoApprovable: true,
  },
  "setUrgency to high": {
    steps: onIncident("setUrgency", "high"), method: "PUT", path: incidentPath(),
    body: { incident: { ...incidentRef, urgency: "high" } }, tag: "edit-incidents", autoApprovable: false,
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

  it("won't acknowledge an incident that is resolved, or that a pending resolve closes, since that would reopen it", async () => {
    const t = await setup();
    const resolved = t.pd.incident(SERVICE, { status: "resolved" });
    expect(await t.attempt(onIncident("acknowledge")(resolved.id))).toMatch(/resolved incident can't be acknowledged/);
    await t.run(onIncident("resolve")(t.incident.id));
    expect(await t.attempt(onIncident("acknowledge")(t.incident.id))).toMatch(/resolved incident can't be acknowledged/);
    expect((await t.submitted()).map(({ description }) => description.actionKind?.tag)).toEqual(["resolve-incidents"]);
  });

  it.each([
    ["an account", { resourceKind: "account" }],
    ["a team", { resourceKind: "team", id: TEAM.id }],
  ] as [string, Binding][])("leaves resolved, sending nothing, an incident resolved since %s binding staged its acknowledgement", async (_name, binding) => {
    const t = await setup(binding);
    await t.run(onIncident("acknowledge")(t.incident.id));
    const [{ actionId }] = await t.submitted();
    t.incident.status = "resolved";
    expect(await t.tryApply(actionId)).toMatch(/resolved in the meantime/);
    expect(t.pd.writes()).toEqual([]);
  });

  it.each([
    ["createOverride", [ALICE.email, START, END]],
    ["deleteOverride", ["POVR003"]],
  ])("refuses %s on a shift-based schedule, staging nothing", async (method, args) => {
    const t = await setup({ resourceKind: "schedule", id: SHIFT_SCHEDULE.id });
    expect(await t.attempt([[method, ...args]])).toMatch(/not supported for shift-based schedules yet/);
    expect(await t.submitted()).toEqual([]);
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

  it("leaves a change pending, having sent nothing, when the connection can't produce credentials", async () => {
    const t = await setup();
    await t.run(onIncident("addNote", "Looking into it")(t.incident.id));
    const [{ actionId }] = await t.submitted();
    // The access token has expired, and PagerDuty's token endpoint is down.
    await runInDurableObject(accountStub(t.userObjectId), (_instance, state) => {
      state.storage.kv.put("credentials", { ...state.storage.kv.get<object>("credentials"), expiresAt: Date.now() - 1 });
    });
    t.pd.claims = () => {
      throw new Error("PagerDuty's identity service is down");
    };
    expect(await t.tryApply(actionId)).toMatch(/identity service is down/);
    expect(t.pd.writes()).toEqual([]);

    t.pd.claims = (_user, claims) => claims;
    await t.apply(actionId);
    expect(t.pd.writes().map(w => [w.method, w.url.pathname])).toEqual([["POST", `/incidents/${t.incident.id}/notes`]]);
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

  it("refuses, sending nothing, a change to an incident that has moved off the service binding since", async () => {
    const t = await setup({ resourceKind: "service", id: SERVICE.id });
    await t.run(onIncident("acknowledge")(t.incident.id));
    const [{ actionId }] = await t.submitted();
    t.incident.service = OTHER_SERVICE;
    expect(await t.tryApply(actionId)).toMatch(/belongs to another service/);
    expect(t.pd.writes()).toEqual([]);
  });

  it("refuses, sending nothing, an override on a schedule that has left the team binding since", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    await t.run([["getSchedule", SCHEDULE.id], ["createOverride", ALICE.email, START, END]]);
    const [{ actionId }] = await t.submitted();
    t.pd.schedules.get(SCHEDULE.id)!.teams = [OTHER_TEAM];
    expect(await t.tryApply(actionId)).toMatch(/doesn't belong to this team/);
    expect(t.pd.writes()).toEqual([]);
  });

  it("refuses, sending nothing, a change to an incident whose service has left the team binding since staging read it", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    await t.run(onIncident("acknowledge")(t.incident.id));
    const [{ actionId }] = await t.submitted();
    t.pd.services.get(SERVICE.id)!.teams = [OTHER_TEAM];
    expect(await t.tryApply(actionId)).toMatch(/doesn't belong to this team/);
    expect(t.pd.writes()).toEqual([]);
  });

  it.each([
    ["createOverride", [ALICE.email, START, END]],
    ["deleteOverride", ["POVR001"]],
  ])("fails %s for good, sending nothing, once the team binding's schedule is gone", async (method, args) => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    await t.run([["getSchedule", SCHEDULE.id], [method, ...args]]);
    const [{ actionId }] = await t.submitted();
    const deleted = t.pd.schedules.get(SCHEDULE.id)!;
    t.pd.schedules.delete(SCHEDULE.id);
    await t.tryApply(actionId);
    // Terminal: the schedule coming back doesn't revive it.
    t.pd.schedules.set(SCHEDULE.id, deleted);
    await t.tryApply(actionId);
    expect(t.pd.writes()).toEqual([]);
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

  it.each([
    ["acknowledgement", {}, ["acknowledge"], { statuses: ["acknowledged"] }],
    ["resolve", {}, ["resolve"], { statuses: ["resolved"] }],
    ["reassignment to oneself", { assignments: [{ assignee: { id: BOB.id, type: "user_reference", summary: "Bob" } }] },
      ["reassign", { users: [ALICE.email] }], { assignedToMe: true }],
  ] as [string, Partial<WireIncident>, Step, object][])("lists an incident a pending %s moves into the filter PagerDuty applies before it", async (_name, wire, step, filter) => {
    const t = await setup();
    Object.assign(t.incident, wire);
    await t.run(onIncident(...step)(t.incident.id));
    expect(await t.run([["listIncidents", filter]], 5)).toMatchObject([[{ id: t.incident.id }]]);
    // Its service is reported before the walk serves it, as for an incident waiting to be opened.
    expect((await t.reported()).at(-2)).toEqual(new Set([sub(), sub("service", SERVICE.id)]));
  });

  it("lists an incident a pending change keeps in the filter once, though PagerDuty lists it too", async () => {
    const t = await setup();
    await t.run(onIncident("acknowledge")(t.incident.id));
    expect(await t.run([["listIncidents"]], 5)).toMatchObject([[{ id: t.incident.id, status: "acknowledged" }]]);
  });

  it("leaves out, in a team binding, an incident a pending change moves into the filter once it has left the team", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    await t.run(onIncident("acknowledge")(t.incident.id));
    t.incident.service = OTHER_SERVICE;
    expect(await t.run([["listIncidents", { statuses: ["acknowledged"] }]], 5)).toEqual([]);
    expect((await t.reported()).at(-1)).toEqual(new Set([sub(), sub("team", TEAM.id)]));
  });

  it.each([403, 404] as const)("leaves out an incident a pending change moves into the filter once PagerDuty refuses it with %i", async status => {
    const t = await setup();
    await t.run(onIncident("acknowledge")(t.incident.id));
    t.pd.hide(ALICE.id, t.incident.id, status);
    expect(await t.run([["listIncidents", { statuses: ["acknowledged"] }]], 5)).toEqual([]);
  });

  it.each([
    ["shows a change staged", ["setTitle", "Retitled"], { title: "Retitled" }],
    ["drops an incident resolved", ["resolve"], null],
  ] as [string, Step, object | null][])("%s mid-walk on an incident the walk already holds", async (_name, step, change) => {
    const t = await setup();
    // 28 open incidents. A pending resolve drops one of PagerDuty's first 25, so the first page takes
    // one of the next 3, and the walk holds the last 2 for the next page.
    const rows = [t.incident, ...Array.from({ length: 27 }, () => t.pd.incident(SERVICE))];
    const [changed, last] = rows.slice(26);
    await t.run(onIncident("resolve")(rows[1].id));
    const pages = await t.run([["listIncidents"]], 5, [onIncident(...step)(changed.id)]) as PagerDutyIncidentSummary[][];
    expect(pages[0]).toHaveLength(25);
    expect(pages.slice(1)).toMatchObject([[...change ? [{ id: changed.id, ...change }] : [], { id: last.id }]]);
    expect(t.pd.matching("GET", /^\/incidents\?/)).toHaveLength(2);
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
    // Once for the pending incident before the walk serves it, then for the page PagerDuty filled.
    expect(await t.reported()).toEqual([
      new Set([sub(), sub("service", OTHER_SERVICE.id)]), new Set([sub(), sub("service", SERVICE.id)]),
    ]);
  });

  it.each([
    ["PagerDuty lists none", { serviceIds: [OTHER_SERVICE.id] }],
    ["the page has room for it alone", { pageSize: 1 }],
  ])("reports the service of an incident a pending action opens when %s", async (_name, filter) => {
    const t = await setup();
    await t.run([["getService", OTHER_SERVICE.id], ["createIncident", { title: "Refunds failing" }]]);
    expect(await t.run([["listIncidents", filter]], 1)).toMatchObject([[{ id: "~1", service: { name: "Billing" } }]]);
    expect(await t.reported()).toEqual([new Set([sub(), sub("service", OTHER_SERVICE.id)])]);
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
    const reported = new Set([sub(), sub("team", TEAM.id), sub("service", SERVICE.id)]);
    expect(await t.reported()).toEqual([reported, reported]);
  });

  it("lists, in a team binding, an incident a pending action opens on a service the team shares", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    t.pd.services.get(OTHER_SERVICE.id)!.teams = [OTHER_TEAM, TEAM];
    await t.run([["getService", OTHER_SERVICE.id], ["createIncident", { title: "Refunds failing" }]]);
    const [[opened]] = await t.run([["listIncidents"]], 5) as PagerDutyIncidentSummary[][];
    expect([opened.id, opened.team?.id]).toEqual(["~1", OTHER_TEAM.id]);
  });

  it("returns an acknowledged incident a pending change raises to high urgency to triggered, so it can't be snoozed", async () => {
    const t = await setup();
    Object.assign(t.incident, {
      status: "acknowledged", urgency: "low", acknowledgements: [{ acknowledger: { id: BOB.id, type: "user_reference" }, at: START }],
    });
    await t.run(onIncident("setUrgency", "high")(t.incident.id));
    expect(await t.run(onIncident("getDetails")(t.incident.id))).toMatchObject({ status: "triggered", urgency: "high", acknowledgers: [] });
    expect(await t.attempt(onIncident("snooze", 3600)(t.incident.id))).toMatch(/Only an acknowledged incident/);
  });

  it("shows pending overrides in a schedule's overrides and shifts, and hides one pending removal", async () => {
    const t = await setup(schedule);
    t.pd.overrides.set(SCHEDULE.id, [{ id: "POVR001", start: START, end: END, user: { id: ALICE.id, summary: "Alice" } }]);
    t.pd.shifts.set(SCHEDULE.id, [{ start: at(0), end: at(24), user: { id: ALICE.id, summary: "Alice" } }]);
    const ref = await t.run([["createOverride", BOB.email, START, END]]);
    expect(ref).toBe("~1");
    await t.run([["deleteOverride", "POVR001"]]);
    const window = { since: at(0), until: at(24) };
    expect(await t.run([["listOverrides", window]])).toEqual([{ id: "~1", user: { id: BOB.id, name: "Bob" }, start: START, end: END }]);
    expect(await t.run([["listShifts", window]])).toEqual([
      { user: { id: ALICE.id, name: "Alice" }, start: at(0), end: START },
      { user: { id: BOB.id, name: "Bob" }, start: START, end: END },
      { user: { id: ALICE.id, name: "Alice" }, start: END, end: at(24) },
    ]);
  });

  describe("on call", () => {
    const now = Date.now();
    const hour = (hours: number) => new Date(now + hours * HOUR).toISOString();
    // Bob is on call for half a day either side of now; Alice is staged to cover the hour either side.
    const covered = async (binding?: Binding) => {
      const t = await setup(binding);
      t.pd.oncalls = [{
        user: { id: BOB.id, type: "user_reference", summary: "Bob" }, escalation_level: 1, escalation_policy: POLICY,
        schedule: SCHEDULE, start: hour(-12), end: hour(12),
      }];
      await t.run([["getSchedule", SCHEDULE.id], ["createOverride", ALICE.email, hour(-1), hour(1)]]);
      return t;
    };

    it.each([
      ["an account", { resourceKind: "account" }],
      ["a team", { resourceKind: "team", id: TEAM.id }],
    ] as [string, Binding][])("shows %s binding a pending override's user on call now in place of whoever it covers", async (_name, binding) => {
      const t = await covered(binding);
      expect(await t.run([["listOnCalls"]])).toMatchObject([onCallEntry(ALICE, hour(-1), hour(1))]);
    });

    it("finds a pending override's user by a user filter, and keeps whoever it covers on call around it in a window", async () => {
      const t = await covered();
      expect(await t.run([["listOnCalls", { users: [ALICE.email] }]])).toMatchObject([onCallEntry(ALICE, hour(-1), hour(1))]);
      expect(await t.run([["listOnCalls", { since: hour(-2), until: hour(2) }]])).toMatchObject([
        onCallEntry(BOB, hour(-12), hour(-1)), onCallEntry(ALICE, hour(-1), hour(1)), onCallEntry(BOB, hour(1), hour(12)),
      ]);
      expect(await t.run([["listOnCalls", { since: hour(2), until: hour(3) }]])).toMatchObject([onCallEntry(BOB, hour(1), hour(12))]);
    });
  });

  it("shows an override already under way ending when its removal was staged, and tells the approver", async () => {
    const t = await setup(schedule);
    const start = new Date(Date.now() - HOUR).toISOString();
    const end = new Date(Date.now() + HOUR).toISOString();
    t.pd.overrides.set(SCHEDULE.id, [{ id: "POVR001", start, end, user: { id: BOB.id, summary: "Bob" } }]);
    const staging = Date.now();
    await t.run([["deleteOverride", "POVR001"]]);
    const window = { since: new Date(Date.now() - 2 * HOUR).toISOString() };
    const [override] = await t.run([["listOverrides", window]]) as PagerDutyOverride[];
    expect(override).toMatchObject({ id: "POVR001", start });
    expect(Date.parse(override.end)).toBeGreaterThanOrEqual(staging);
    expect(Date.parse(override.end)).toBeLessThan(Date.parse(end));
    const [{ description }] = await t.submitted();
    expect(description.description).toMatch(/or ends it now if it has already begun/);
  });

  it("removes an override another action is adding only through the schedule it is adding it to, from its overrides and shifts", async () => {
    const t = await setup();
    expect(await t.run([["getSchedule", SCHEDULE.id], ["createOverride", ALICE.email, START, END]])).toBe("~1");
    expect(await t.attempt([["getSchedule", OTHER_SCHEDULE.id], ["deleteOverride", "~1"]]))
      .toMatch(/isn't one this gadget added to this schedule/);
    await t.run([["getSchedule", SCHEDULE.id], ["deleteOverride", "~1"]]);
    expect((await t.submitted()).map(({ description }) => description.actionKind?.tag)).toEqual(["manage-overrides", "delete-overrides"]);
    expect(await t.run([["getSchedule", SCHEDULE.id], ["listOverrides", { since: START, until: END }]])).toEqual([]);
    expect(await t.run([["getSchedule", SCHEDULE.id], ["listShifts", { since: START, until: END }]])).toEqual([]);
  });

  it("removes an override another action added only through the schedule it added it to", async () => {
    const t = await setup();
    await t.run([["getSchedule", SCHEDULE.id], ["createOverride", ALICE.email, START, END]]);
    const [create] = await t.submitted();
    await t.apply(create.actionId);
    expect(await t.attempt([["getSchedule", OTHER_SCHEDULE.id], ["deleteOverride", "~1"]]))
      .toMatch(/isn't one this gadget added to this schedule/);
    await t.run([["getSchedule", SCHEDULE.id], ["deleteOverride", "~1"]]);
    const [, removal] = await t.submitted();
    await t.apply(removal.actionId);
    const [, deleted] = t.pd.writes();
    expect([deleted.method, deleted.url.pathname]).toEqual(["DELETE", expect.stringMatching(`^/schedules/${SCHEDULE.id}/overrides/`)]);
  });
});
