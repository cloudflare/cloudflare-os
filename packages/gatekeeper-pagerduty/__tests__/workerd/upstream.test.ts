// The points written for the requests the Durable Objects send to PagerDuty: work that loops over
// requests is written as one point per kind of request, and the OAuth client's token requests are
// counted under their own names. The metrics read the Worker's bindings from `cloudflare:workers`,
// whose `env` this suite shares with the Durable Objects, so a dataset set on it here records what
// they write.

import { env, runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { getRedirectUri, type Env } from "../../src/pagerduty-env";
import {
  ALICE, BOB, FakePagerDuty, OTHER_SERVICE, SCHEDULE, SERVICE, TEAM, accountStub, bound, failure, hooks, json, seedAccount, sub,
  unwrap,
} from "./fake-pagerduty";
import type { Step } from "./worker";

const ambient = bindings as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// The points written since the last look, as each one's source, service, operation, outcome, HTTP
// status and number of calls, ordered by operation and status. The fetch of the ID token's signing
// keys is left out: the gatekeeper keeps the keys once it has them, so whether a connect here is
// the one that fetches them depends on what ran before it.
function written() {
  const rows = points.splice(0).map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
  return rows.filter(([, , operation]) => operation !== "certs.get")
    .toSorted((a, b) => `${a[2]} ${a[4]}`.localeCompare(`${b[2]} ${b[4]}`));
}

describe("the points of work that loops over requests", () => {
  it("writes the pages of a listing as one point", async () => {
    const t = await bound();
    // PagerDuty pages the users found: one page that names another, then the last.
    t.pd.on("GET", /^\/users\?/, request => json(request.url.searchParams.get("offset") === "0"
      ? { users: [BOB], more: true } : { users: [], more: false }));
    expect(await t.run([["findUsers", "bob"]])).toMatchObject([{ id: BOB.id }]);

    expect(t.pd.matching("GET", /^\/users\?/)).toHaveLength(2);
    expect(written().filter(([, , operation]) => operation === "users.list"))
      .toEqual([["gatekeeper.pagerduty.api", "pagerduty", "users.list", "success", 200, 2]]);
  });

  it("writes the lookups of the users a filter names as one point", async () => {
    const t = await bound();
    await t.run([["getMetadata"]]);
    written();
    t.pd.requests.length = 0;

    await t.run([["listOnCalls", { users: [ALICE.id, BOB.id] }]], 1);

    expect(t.pd.matching("GET", /^\/users\/P\w+$/)).toHaveLength(2);
    expect(written().filter(([, , operation]) => operation === "users.get"))
      .toEqual([["gatekeeper.pagerduty.api", "pagerduty", "users.get", "success", 200, 2]]);
  });

  it("writes the reads of the incidents pending actions are on as one point", async () => {
    const t = await bound();
    const incidents = [t.pd.incident(SERVICE), t.pd.incident(SERVICE), t.pd.incident(SERVICE)];
    for (const { id } of incidents) await t.run([["getIncident", id], ["acknowledge"]]);
    written();
    t.pd.requests.length = 0;

    await t.run([["listIncidents"]], 1);

    expect(t.pd.matching("GET", /^\/incidents\/\w+(\?|$)/)).toHaveLength(3);
    expect(written().filter(([, , operation]) => operation === "incidents.get"))
      .toEqual([["gatekeeper.pagerduty.api", "pagerduty", "incidents.get", "success", 200, 3]]);
  });

  it("writes an observer's probes of the objects a read reported as one point per kind", async () => {
    const t = await bound();
    await t.run([["getMetadata"]]);
    const bob = await seedAccount(t.pd, BOB);
    written();

    const subresources = [sub(), sub("service", SERVICE.id), sub("service", OTHER_SERVICE.id), sub("team", TEAM.id)];
    expect(unwrap(await hooks().verifyObserverAccess(t.name, t.props, [{ id: "bob", userObjectId: bob }], subresources)))
      .toEqual({ allowedObserverIds: ["bob"] });

    expect(t.pd.matching("GET", /^\/services\//, BOB.id)).toHaveLength(2);
    expect(written().filter(([, , operation]) => operation !== "users.me")).toEqual([
      ["gatekeeper.pagerduty.api", "pagerduty", "services.get", "success", 200, 2],
      ["gatekeeper.pagerduty.api", "pagerduty", "teams.get", "success", 200, 1],
    ]);
  });
});

// The points written for `operation` since the last look, as each one's outcome, reason, HTTP
// status and number of calls.
function counted(operation: string) {
  return points.splice(0).filter(point => column(point, SUBSERVICE_V1_SLOTS.operation) === operation).map(point => [
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
}

describe("the points of an answer its caller rejects", () => {
  it.each([
    ["no team", {}],
    ["a team that is no object", { team: "Platform" }],
  ])("counts the read of an object the picker opens, answered 200 with %s, as an error of the call", async (_, body) => {
    const pd = new FakePagerDuty().install();
    const userObjectId = await seedAccount(pd, ALICE);
    expect(unwrap(await hooks().locate(userObjectId, `team:${TEAM.id}`))).toMatchObject({ ref: `team:${TEAM.id}` });
    expect(counted("teams.get")).toEqual([["success", "", 200, 1]]);

    pd.on("GET", /^\/teams\/\w+$/, () => json(body));
    expect(failure(await hooks().locate(userObjectId, `team:${TEAM.id}`))).toBe("PagerDuty's team was malformed.");
    expect(pd.matching("GET", /^\/teams\/\w+$/)).toHaveLength(2);
    expect(counted("teams.get")).toEqual([["error", "api", 200, 1]]);
  });

  it.each([
    ["a result that holds no override", [{ status: 201 }], "PagerDuty refused the override."],
    ["an override that has no ID", [{ status: 201, override: { start: "", end: "", user: { id: ALICE.id } } }], "PagerDuty refused the override."],
    ["no result", [], "PagerDuty refused the override."],
    ["a result it refused", [{ status: 400, errors: ["Override must end after its start"] }],
      "PagerDuty refused the override: Override must end after its start"],
    // What is no list fails the reading of its first result, with the runtime's own words.
    ["an object in place of its results", { status: 201 }, "(intermediate value) is not iterable"],
    ["null in place of its results", null, "(intermediate value) is not iterable"],
  ])("counts a batch of one override answered 201 with %s as an error of the call, sent once", async (_, results, message) => {
    const t = await bound({ resourceKind: "schedule", id: SCHEDULE.id });
    const day = Math.ceil(Date.now() / 86_400_000) * 86_400_000;
    await t.run([["createOverride", ALICE.email, new Date(day + 9 * 3_600_000).toISOString(), new Date(day + 17 * 3_600_000).toISOString()]]);
    const { submitted: [{ actionId }] } = await hooks().queueLog(t.name);
    t.pd.on("POST", /^\/schedules\/\w+\/overrides$/, () => json(results, { status: 201 }));
    points.length = 0;

    expect(failure(await hooks().applyAction(t.name, t.props, actionId))).toBe(message);
    expect(t.pd.matching("POST", /^\/schedules\/\w+\/overrides$/)).toHaveLength(1);
    expect(counted("overrides.create")).toEqual([["error", "api", 201, 1]]);
  });

  it("counts the lookup of a user named by ID, answered 200 with no user, as an error of the call", async () => {
    const t = await bound({ resourceKind: "schedule", id: SCHEDULE.id });
    const day = Math.ceil(Date.now() / 86_400_000) * 86_400_000;
    const override: Step = ["createOverride", BOB.id, new Date(day + 9 * 3_600_000).toISOString(), new Date(day + 17 * 3_600_000).toISOString()];
    await t.run([override]);
    expect(counted("users.get")).toEqual([["success", "", 200, 1]]);

    t.pd.on("GET", /^\/users\/PBOB001$/, () => json({}));
    expect(await t.attempt([override])).toBe(`No PagerDuty user has the email ${BOB.id}.`);
    expect(t.pd.matching("GET", /^\/users\/PBOB001$/)).toHaveLength(2);
    expect(counted("users.get")).toEqual([["error", "api", 200, 1]]);
  });

  it("counts a batch that added the override it was asked for as a success", async () => {
    const t = await bound({ resourceKind: "schedule", id: SCHEDULE.id });
    const day = Math.ceil(Date.now() / 86_400_000) * 86_400_000;
    await t.run([["createOverride", ALICE.email, new Date(day + 9 * 3_600_000).toISOString(), new Date(day + 17 * 3_600_000).toISOString()]]);
    const { submitted: [{ actionId }] } = await hooks().queueLog(t.name);
    points.length = 0;

    unwrap(await hooks().applyAction(t.name, t.props, actionId));
    expect(t.pd.overrides.get(SCHEDULE.id)).toHaveLength(1);
    expect(counted("overrides.create")).toEqual([["success", "", 201, 1]]);
  });
});

describe("the points of the OAuth client's requests", () => {
  it("counts a refresh and an exchange under their own names", async () => {
    const pd = new FakePagerDuty().install();
    const expired = await seedAccount(pd, ALICE);
    await runInDurableObject(accountStub(expired), async (_instance, state) => {
      state.storage.kv.put("credentials", { ...state.storage.kv.get<object>("credentials"), expiresAt: Date.now() - 1 });
    });
    await accountStub(expired).getCredentials();
    expect(pd.matching("POST", /^\/oauth\/token$/)).toHaveLength(1);
    expect(written()).toEqual([["gatekeeper.pagerduty.api", "pagerduty", "token.refresh", "success", 200, 1]]);

    // A reconnect: the code's exchange, and the read of who authorized it.
    const userObjectId = await seedAccount(pd, ALICE);
    await hooks().installCallback(userObjectId, generateNonce());
    const { url } = unwrap(await hooks().user(userObjectId, "reconnect")) as { url: string };
    const result = await runInDurableObject(accountStub(userObjectId), async instance => {
      const flow = await instance.beginOAuthFlow(url.slice(url.lastIndexOf("/") + 1), getRedirectUri(env as Env));
      if (!flow) throw new Error("the connect flow did not start");
      const code = `code-${crypto.randomUUID()}`;
      pd.codes.set(code, { userId: ALICE.id, codeChallenge: flow.codeChallenge });
      return await instance.acceptAuthCode(code, flow.oauthNonce);
    });
    expect(result).toHaveProperty("handoff");
    expect(written()).toEqual([
      ["gatekeeper.pagerduty.api", "pagerduty", "token.exchange", "success", 200, 1],
      ["gatekeeper.pagerduty.api", "pagerduty", "users.me", "success", 200, 1],
    ]);
  });

  it("counts a code PagerDuty refuses by its status", async () => {
    const pd = new FakePagerDuty().install();
    const userObjectId = await seedAccount(pd, ALICE);
    await hooks().installCallback(userObjectId, generateNonce());
    const { url } = unwrap(await hooks().user(userObjectId, "reconnect")) as { url: string };
    await runInDurableObject(accountStub(userObjectId), async instance => {
      const flow = await instance.beginOAuthFlow(url.slice(url.lastIndexOf("/") + 1), getRedirectUri(env as Env));
      if (!flow) throw new Error("the connect flow did not start");
      // A code PagerDuty never issued.
      await instance.acceptAuthCode("code-unknown", flow.oauthNonce).catch(() => undefined);
    });
    expect(pd.matching("POST", /^\/oauth\/token$/)).toHaveLength(1);
    expect(written()).toEqual([["gatekeeper.pagerduty.api", "pagerduty", "token.exchange", "error", 400, 1]]);
  });
});
