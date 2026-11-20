// The points written for the requests the Durable Objects send to X: an action that loops over
// requests is written as one point per kind of request, and the OAuth client's token requests are
// counted under their own names. The metrics read the Worker's bindings from `cloudflare:workers`,
// whose `env` this suite shares with the Durable Objects, so a dataset set on it here records what
// they write.

import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { scopesFor } from "../../src/x-env";
import { ALICE, BOB, FakeX, hooks, json, reconnectAs, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps } from "./worker";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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
// status and number of calls, ordered by operation.
function written() {
  const rows = points.splice(0).map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
  return rows.toSorted((a, b) => String(a[2]).localeCompare(String(b[2])));
}

describe("the points of an action that loops over requests", () => {
  it("writes a thread's publish, and its undoing, as one point per kind of request", async () => {
    const x = new FakeX().install();
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["createThread", [
      { text: "One", images: [{ data: PNG, mediaType: "image/png", altText: "A chart" }] },
      { text: "Two" },
      { text: "Three" },
    ]]]));
    const [{ actionId }] = (await hooks().queueLog(name)).submitted;
    expect(written()).toEqual([]);

    unwrap(await hooks().applyAction(name, props, actionId));
    expect(x.count("POST", /^\/2\/tweets$/)).toBe(3);
    expect(written()).toEqual([
      ["gatekeeper.x.api", "x", "media.upload", "success", 200, 1],
      ["gatekeeper.x.api", "x", "metadata.create", "success", 200, 1],
      ["gatekeeper.x.api", "x", "tweets.create", "success", 201, 3],
    ]);

    unwrap(await hooks().revertAction(name, props, actionId));
    expect(x.count("DELETE", /^\/2\/tweets\//)).toBe(3);
    expect(written()).toEqual([["gatekeeper.x.api", "x", "tweets.delete", "success", 200, 3]]);
  });
});

describe("the points of an action that pages", () => {
  it("writes the pages of owned Lists a List's creation reads as one point", async () => {
    const x = new FakeX().install();
    // X pages the account's owned Lists: one page that names another, then the last.
    x.on("GET", /\/owned_lists/, request => json(request.url.searchParams.has("pagination_token")
      ? { meta: { result_count: 0 } } : { meta: { result_count: 0, next_token: "page-2" } }));
    const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
    const name = crypto.randomUUID();
    unwrap(await hooks().run(name, props, [["createList", "Friends"]]));
    const [{ actionId }] = (await hooks().queueLog(name)).submitted;
    written();

    unwrap(await hooks().applyAction(name, props, actionId));

    expect(x.count("GET", /\/owned_lists/)).toBe(2);
    expect(written().filter(([, , operation]) => operation === "owned_lists.list"))
      .toEqual([["gatekeeper.x.api", "x", "owned_lists.list", "success", 200, 2]]);
  });
});

describe("the points of the OAuth client's requests", () => {
  it("counts a refresh, an exchange and each revocation under its own name", async () => {
    const x = new FakeX().install();
    const expired = await seedAccount(x, ALICE, { expiresInMs: 0 });
    unwrap(await hooks().account(expired, "getCredentials"));
    expect(written()).toEqual([["gatekeeper.x.api", "x", "token.refresh", "success", 200, 1]]);

    // A reconnect as another X user: the code's exchange, the read of who authorized it, and the
    // revocation of both tokens of the grant it is refused.
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce(), scopesFor());
    expect(await reconnectAs(x, id, BOB)).toHaveProperty("refused");
    expect(written()).toEqual([
      ["gatekeeper.x.api", "x", "token.exchange", "success", 200, 1],
      ["gatekeeper.x.api", "x", "token.revoke", "success", 200, 1],
      ["gatekeeper.x.api", "x", "token.revoke", "success", 200, 1],
      ["gatekeeper.x.api", "x", "users.me", "success", 200, 1],
    ]);
  });

  it.each<[string, unknown]>([
    ["holds no data", {}],
    ["names no account", { data: { name: "Alice" } }],
  ])("counts the read of who authorized a reconnect an error of the call where a 200 %s", async (_lacking, answer) => {
    const x = new FakeX().install();
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce(), scopesFor());
    x.on("GET", /^\/2\/users\/me(\?|$)/, () => json(answer));
    written();

    await expect(reconnectAs(x, id, ALICE))
      .rejects.toThrow("Could not read which X account authorized this connection. Please try again.");

    expect(x.count("GET", /^\/2\/users\/me(\?|$)/)).toBe(1);
    expect(written()).toEqual([
      ["gatekeeper.x.api", "x", "token.exchange", "success", 200, 1],
      ["gatekeeper.x.api", "x", "users.me", "error", 200, 1],
    ]);
  });
});
