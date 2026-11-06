// What each read reports: the account always, the objects its capability is scoped to, those its
// filter names and those its result shows -- on empty pages and cache hits too -- and the narrower
// capabilities a broader one opens, which refuse anything outside them.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WireIncident, WireRef } from "../../src/pagerduty-normalize";
import type { PagerDutyIncidentDetails } from "../../src/types";
import {
  ALICE, FakePagerDuty, OTHER_SCHEDULE, OTHER_SERVICE, POLICY, SCHEDULE, SERVICE, TEAM, failure, hooks, seedAccount, sub, unwrap,
} from "./fake-pagerduty";
import type { GatekeeperProps, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Binding = { resourceKind: "account" } | { resourceKind: "team" | "service" | "incident" | "schedule"; id: string };

async function setup(binding: Binding = { resourceKind: "account" }, pd = new FakePagerDuty().install()) {
  const props = { userObjectId: await seedAccount(pd), region: "us", subdomain: "acme", ...binding } as GatekeeperProps;
  const name = crypto.randomUUID();
  return {
    pd,
    run: async (steps: Step[], pages?: number) => unwrap(await hooks().run(name, props, steps, pages ? { pages } : {})),
    attempt: async (steps: Step[], pages?: number) => failure(await hooks().run(name, props, steps, pages ? { pages } : {})),
    /** What each observation so far reported, order aside. */
    reported: async () => (await hooks().queueLog(name)).observations.map(o => new Set(o.subresources)),
  };
}

const ids = (...list: string[]) => new Set([sub(), ...list]);

describe("an account binding", () => {
  it("reports the account on its own reads, a cached one included", async () => {
    const t = await setup();
    expect(await t.run([["getMetadata"]])).toMatchObject({ subdomain: "acme", htmlUrl: "https://acme.pagerduty.com", you: { id: ALICE.id } });
    await t.run([["listPriorities"]]);
    await t.run([["listPriorities"]]);
    await t.run([["findUsers", "bob"]]);
    expect(t.pd.matching("GET", /^\/priorities/)).toHaveLength(1);
    expect(await t.reported()).toEqual([ids(), ids(), ids(), ids()]);
  });

  it("reports each incident page's services, open incidents of the last 30 days by default", async () => {
    const t = await setup();
    t.pd.incident(SERVICE);
    t.pd.incident(SERVICE);
    t.pd.incident(OTHER_SERVICE);
    const [page] = await t.run([["listIncidents"]], 5) as PagerDutyIncidentDetails[][];
    expect(page).toHaveLength(3);
    expect(await t.reported()).toEqual([ids(sub("service", SERVICE.id), sub("service", OTHER_SERVICE.id))]);
    const { searchParams } = t.pd.matching("GET", /^\/incidents\?/)[0].url;
    expect(searchParams.getAll("statuses[]")).toEqual(["triggered", "acknowledged"]);
    expect(Date.parse(searchParams.get("until")!) - Date.parse(searchParams.get("since")!)).toBe(30 * 24 * 60 * 60_000);
  });

  it("reports the services a filter names, though the page is empty", async () => {
    const t = await setup();
    t.pd.incident(SERVICE);
    expect(await t.run([["listIncidents", { serviceIds: [OTHER_SERVICE.id] }]], 5)).toEqual([]);
    expect(await t.reported()).toEqual([ids(sub("service", OTHER_SERVICE.id))]);
  });

  it("reports each page's own services as a listing is walked", async () => {
    const t = await setup();
    t.pd.incident(SERVICE);
    t.pd.incident(OTHER_SERVICE);
    t.pd.incident(SERVICE);
    const pages = await t.run([["listIncidents", { pageSize: 1 }]], 5) as PagerDutyIncidentDetails[][];
    expect(pages.map(page => page.map(row => row.service.id))).toEqual([[SERVICE.id], [OTHER_SERVICE.id], [SERVICE.id]]);
    expect(await t.reported()).toEqual([
      ids(sub("service", SERVICE.id)), ids(sub("service", OTHER_SERVICE.id)), ids(sub("service", SERVICE.id)),
    ]);
  });

  it("keeps an incident search within PagerDuty's six-month window unless it asks for all time", async () => {
    const t = await setup();
    expect(await t.attempt([["listIncidents", { since: "2026-01-01T00:00:00Z", until: "2026-08-01T00:00:00Z" }]]))
      .toMatch(/at most 6 months apart/);
    await t.run([["listIncidents", { allTime: true }]], 1);
    const { searchParams } = t.pd.matching("GET", /^\/incidents\?/)[0].url;
    expect([searchParams.get("date_range"), searchParams.has("since"), searchParams.has("until")]).toEqual(["all", false, false]);
  });

  it("reports each service, team and schedule it lists", async () => {
    const t = await setup();
    await t.run([["listServices"]], 5);
    await t.run([["listTeams"]], 5);
    await t.run([["listSchedules", { query: "platform" }]], 5);
    expect(await t.reported()).toEqual([
      ids(sub("service", SERVICE.id), sub("service", OTHER_SERVICE.id)),
      ids(sub("team", TEAM.id), sub("team", "PTEAM02")),
      ids(sub("schedule", SCHEDULE.id)),
    ]);
  });

  it("reports the schedules an on-call filter names and the policies and schedules its entries show", async () => {
    const t = await setup();
    t.pd.oncalls = [{ user: { id: ALICE.id, summary: "Alice" }, escalation_level: 1, escalation_policy: POLICY, schedule: SCHEDULE }];
    expect(await t.run([["listOnCalls", { scheduleIds: [OTHER_SCHEDULE.id] }]])).toEqual([]);
    expect(await t.run([["listOnCalls"]])).toHaveLength(1);
    expect(await t.reported()).toEqual([
      ids(sub("schedule", OTHER_SCHEDULE.id)),
      ids(sub("escalation_policy", POLICY.id), sub("schedule", SCHEDULE.id)),
    ]);
  });

  it("opens each object as its narrower capability, which reports it", async () => {
    const t = await setup();
    const incident = t.pd.incident(SERVICE);
    await t.run([["getTeam", TEAM.id], ["getMetadata"]]);
    await t.run([["getService", SERVICE.id], ["getDetails"]]);
    await t.run([["getSchedule", SCHEDULE.id], ["getDetails"]]);
    await t.run([["getIncident", incident.id], ["getDetails"]]);
    await t.run([["getTeam", TEAM.id], ["getService", SERVICE.id], ["getIncident", incident.id], ["listNotes"]]);
    expect(await t.reported()).toEqual([
      ids(sub("team", TEAM.id)),
      ids(sub("service", SERVICE.id)),
      ids(sub("schedule", SCHEDULE.id)),
      ids(sub("incident", incident.id), sub("service", SERVICE.id)),
      ids(sub("team", TEAM.id), sub("service", SERVICE.id), sub("incident", incident.id)),
    ]);
  });
});

describe("a team binding", () => {
  const team = { resourceKind: "team", id: TEAM.id } as const;

  it("reports each service and schedule it lists besides the team, and its incidents' services per page", async () => {
    const t = await setup(team);
    t.pd.incident(SERVICE);
    await t.run([["getMetadata"]]);
    await t.run([["listMembers"]]);
    await t.run([["listServices"]], 5);
    await t.run([["listSchedules"]], 5);
    await t.run([["listIncidents"]], 5);
    const scope = ids(sub("team", TEAM.id));
    expect(await t.reported()).toEqual([
      scope, scope,
      ids(sub("team", TEAM.id), sub("service", SERVICE.id)),
      ids(sub("team", TEAM.id), sub("schedule", SCHEDULE.id)),
      ids(sub("team", TEAM.id), sub("service", SERVICE.id)),
    ]);
    expect(t.pd.matching("GET", /^\/incidents\?/)[0].url.searchParams.getAll("team_ids[]")).toEqual([TEAM.id]);
  });

  it("reports the team's escalation policies for who is on call, though nobody is, a cached answer included", async () => {
    const t = await setup(team);
    expect(await t.run([["listOnCalls"]])).toEqual([]);
    expect(await t.run([["listOnCalls"]])).toEqual([]);
    expect(t.pd.matching("GET", /^\/escalation_policies/)).toHaveLength(1);
    const expected = ids(sub("team", TEAM.id), sub("escalation_policy", POLICY.id));
    expect(await t.reported()).toEqual([expected, expected]);
  });

  it("asks nothing of a team with no escalation policy, which would answer for the whole account", async () => {
    const t = await setup({ resourceKind: "team", id: "PTEAM03" });
    t.pd.teams.set("PTEAM03", { id: "PTEAM03", name: "Empty" });
    expect(await t.run([["listOnCalls"]])).toEqual([]);
    expect(t.pd.matching("GET", /^\/oncalls/)).toHaveLength(0);
    expect(await t.reported()).toEqual([ids(sub("team", "PTEAM03"))]);
  });

  it("refuses another team's service, schedule or incident", async () => {
    const t = await setup(team);
    const theirs = t.pd.incident(OTHER_SERVICE);
    expect(await t.attempt([["getService", OTHER_SERVICE.id]])).toMatch(/doesn't belong to this team/);
    expect(await t.attempt([["getSchedule", OTHER_SCHEDULE.id]])).toMatch(/doesn't belong to this team/);
    expect(await t.attempt([["getIncident", theirs.id]])).toMatch(/doesn't belong to this team/);
    expect(await t.reported()).toEqual([]);
  });
});

describe("a service binding", () => {
  const service = { resourceKind: "service", id: SERVICE.id } as const;

  it("reports the service on every read, and its escalation policy for who is on call though nobody is", async () => {
    const t = await setup(service);
    await t.run([["getDetails"]]);
    expect(await t.run([["listIncidents"]], 5)).toEqual([]);
    expect(await t.run([["listOnCalls"]])).toEqual([]);
    expect(await t.reported()).toEqual([
      ids(sub("service", SERVICE.id)),
      ids(sub("service", SERVICE.id)),
      ids(sub("service", SERVICE.id), sub("escalation_policy", POLICY.id)),
    ]);
  });

  it("refuses another service's incident, and lists none of another service's", async () => {
    const t = await setup(service);
    const theirs = t.pd.incident(OTHER_SERVICE);
    expect(await t.attempt([["getIncident", theirs.id]])).toMatch(/belongs to another service/);
    expect(await t.run([["listIncidents", { serviceIds: [OTHER_SERVICE.id] }]], 5)).toEqual([]);
    expect(t.pd.matching("GET", /^\/incidents\?/)).toHaveLength(0);
    expect(await t.reported()).toEqual([ids(sub("service", SERVICE.id))]);
  });
});

describe("an incident binding", () => {
  it("reports the incident and its service on every read, though it has no notes, entries or alerts", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const t = await setup({ resourceKind: "incident", id: incident.id }, pd);
    await t.run([["getDetails"]]);
    expect(await t.run([["listNotes"]])).toEqual([]);
    expect(await t.run([["getTimeline"]], 5)).toEqual([]);
    expect(await t.run([["listAlerts"]], 5)).toEqual([]);
    const expected = ids(sub("incident", incident.id), sub("service", SERVICE.id));
    expect(await t.reported()).toEqual([expected, expected, expected, expected]);
  });

  it("reports an incident bound by number by the ID PagerDuty gave it", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const t = await setup({ resourceKind: "incident", id: String(incident.incident_number) }, pd);
    expect(await t.run([["getDetails"]])).toMatchObject({ id: incident.id });
    expect(await t.reported()).toEqual([ids(sub("incident", incident.id), sub("service", SERVICE.id))]);
  });

  it("reads the timeline a page at a time, oldest first, rather than the whole log up front", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    pd.logEntries.set(incident.id, Array.from({ length: 300 }, (_, n) => ({
      id: `PLOG${n}`, type: "notify_log_entry", summary: `Entry ${n}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
    })));
    const t = await setup({ resourceKind: "incident", id: incident.id }, pd);
    const [first, second] = await t.run([["getTimeline", { pageSize: 10 }]], 2) as { id: string }[][];
    expect([...first, ...second].map(entry => entry.id)).toEqual(Array.from({ length: 20 }, (_, n) => `PLOG${n}`));
    expect(pd.matching("GET", /\/log_entries\?/)).toHaveLength(1);
  });

  it("shows the note a log entry carries, such as a resolution", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    pd.logEntries.set(incident.id, [
      { id: "PLOG1", type: "trigger_log_entry", summary: "Triggered", created_at: incident.created_at },
      {
        id: "PLOG2", type: "resolve_log_entry", summary: "Resolved by Alice", created_at: new Date().toISOString(),
        agent: { id: ALICE.id, type: "user_reference", summary: "Alice" }, note: "Rolled back the deploy",
      },
    ]);
    const t = await setup({ resourceKind: "incident", id: incident.id }, pd);
    expect(await t.run([["getTimeline"]], 1)).toMatchObject([[
      { id: "PLOG1", kind: "trigger", note: null },
      { id: "PLOG2", kind: "resolve", actor: { id: ALICE.id }, note: "Rolled back the deploy" },
    ]]);
  });
});

/** Moves `incident` to `to` when its listing first asks PagerDuty for a page, after the cursor was made. */
const moveOnPage = (pd: FakePagerDuty, incident: WireIncident, to: WireRef) =>
  pd.on("GET", new RegExp(`^/incidents/${incident.id}/(alerts|log_entries)`), () => {
    incident.service = to;
    return undefined;
  });

describe("an incident's listing, open while the incident moves to another service", () => {
  it.each(["listAlerts", "getTimeline"])("refuses %s's page once the incident has left the service binding", async method => {
    const t = await setup({ resourceKind: "service", id: SERVICE.id });
    const incident = t.pd.incident(SERVICE);
    moveOnPage(t.pd, incident, OTHER_SERVICE);
    expect(await t.attempt([["getIncident", incident.id], [method]], 1)).toMatch(/belongs to another service/);
    expect(await t.reported()).toEqual([]);
  });

  it("serves, in a team binding, the page of an incident moved to another of its services, reporting that one", async () => {
    const t = await setup({ resourceKind: "team", id: TEAM.id });
    t.pd.services.get(OTHER_SERVICE.id)!.teams = [TEAM];
    const incident = t.pd.incident(SERVICE);
    t.pd.logEntries.set(incident.id, [{ id: "PLOG1", type: "trigger_log_entry", summary: "Triggered", created_at: incident.created_at }]);
    moveOnPage(t.pd, incident, OTHER_SERVICE);
    expect(await t.run([["getIncident", incident.id], ["getTimeline"]], 1)).toMatchObject([[{ id: "PLOG1" }]]);
    expect(await t.reported()).toEqual([ids(sub("team", TEAM.id), sub("incident", incident.id), sub("service", OTHER_SERVICE.id))]);
  });
});

describe("a schedule binding", () => {
  it("reports the schedule on every read, though it has no shifts or overrides", async () => {
    const t = await setup({ resourceKind: "schedule", id: SCHEDULE.id });
    await t.run([["getDetails"]]);
    expect(await t.run([["listShifts"]])).toEqual([]);
    expect(await t.run([["listOverrides"]])).toEqual([]);
    const expected = ids(sub("schedule", SCHEDULE.id));
    expect(await t.reported()).toEqual([expected, expected, expected]);
  });
});
