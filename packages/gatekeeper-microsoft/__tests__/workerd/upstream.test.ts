// The points written for the requests the account Durable Object sends to Entra ID's token
// endpoint: the OAuth client sends them through the gatekeeper's upstream, so each is counted
// under its own name. The metrics read the Worker's bindings from `cloudflare:workers`, whose `env`
// this suite shares with the Durable Objects, so a dataset set on it here records what they write.

import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { SHAREPOINT_RESOURCE, scopesFor, type Env } from "../../src/microsoft-env";
import { FakeGraph, PHILLIP, failure, hooks, json, reconnectAs, seedAccount, unwrap } from "./fake-graph";

const ambient = bindings as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
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

// The points written since the last look, as each one's source, service, operation, outcome,
// reason and HTTP status.
function written() {
  return points.splice(0).map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// The points written since the last look, as each one's operation, outcome, reason and HTTP status, in the order of their names.
function counted() {
  return written().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status]).toSorted();
}

describe("the points of the OAuth client's requests", () => {
  it("counts the refresh of an expired grant under its own name", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { expiresInMs: 0 });

    unwrap(await hooks().account(id, "getCredentials"));

    expect(graph.tokenRequests()).toHaveLength(1);
    expect(written()).toEqual([["gatekeeper.microsoft.api", "microsoft", "token.refresh", "success", "", 200]]);
  });

  it("counts a refresh Entra refuses as an error of that request, sent once", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { expiresInMs: 0 });
    graph.on("POST", /oauth2\/v2\.0\/token/, () => json({ error: "temporarily_unavailable" }, { status: 503 }));

    failure(await hooks().account(id, "getCredentials"));

    expect(graph.tokenRequests()).toHaveLength(1);
    expect(written()).toEqual([["gatekeeper.microsoft.api", "microsoft", "token.refresh", "error", "http", 503]]);
  });
});

describe("the points of a success that is not what its request was sent for", () => {
  it("counts a re-read of the signed-in user answered with no ID as an error of the API, and serves the stored identity", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/me(\?|$)/, () => json({ displayName: "Somebody" }));
    const id = await seedAccount(graph, PHILLIP, { identity: { fetchedAt: 0, name: "Stored name" } });

    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({ objectId: PHILLIP.oid, name: "Stored name" });

    expect(graph.count("GET", /^\/v1\.0\/me(\?|$)/)).toBe(1);
    expect(counted()).toEqual([["me.get", "error", "api", 200], ["sites.get", "success", "", 200]]);
  });

  it("counts a re-read of the tenant's root site answered with no ID as an error of the API, and serves the stored identity", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/sites\/root(\?|$)/, () => json({ webUrl: "https://contoso.sharepoint.com" }));
    const id = await seedAccount(graph, PHILLIP, { identity: { fetchedAt: 0, name: "Stored name" } });

    expect(unwrap(await hooks().account(id, "getIdentity"))).toMatchObject({ objectId: PHILLIP.oid, name: "Stored name" });

    expect(graph.count("GET", /^\/v1\.0\/sites\/root(\?|$)/)).toBe(1);
    expect(counted()).toEqual([["me.get", "success", "", 200], ["sites.get", "error", "api", 200]]);
  });

  it("counts the user's own OneDrive answered with no ID as an error of the API, and fails the picker's tab with what reading it threw", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/me\/drive(\?|$)/, () => json({ name: "OneDrive" }));
    const id = await seedAccount(graph);

    expect(failure(await hooks().configurator(id, "write", "loadItems", { tab: "onedrive" }))).toContain("Microsoft Graph sent a malformed library.");

    expect(graph.count("GET", /^\/v1\.0\/me\/drive(\?|$)/)).toBe(1);
    expect(counted()).toEqual([["drive.get", "error", "api", 200]]);
  });

  it("fails a connect whose user Graph cannot read with that failure, though the root site answered with no ID ahead of it, and counts each answer as what it is", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/me(\?|$)/, async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return json({ error: { code: "generalException" } }, { status: 500 });
    });
    graph.on("GET", /^\/v1\.0\/sites\/root(\?|$)/, () => json({ webUrl: "https://contoso.sharepoint.com" }));
    const id = await seedAccount(graph);
    await hooks().installCallback(id, generateNonce(), scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));

    const error = await reconnectAs(graph, id, PHILLIP).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "Could not read which Microsoft 365 account authorized this connection. Please try again.",
      cause: { name: "GraphApiError", status: 500 },
    });
    expect(counted().filter(([operation]) => operation !== "token.exchange")).toEqual([["me.get", "error", "http", 500], ["sites.get", "error", "api", 200]]);
  });
});
