// The end of the connect flow: the account trades the authorization code for a grant, and refuses
// one that holds no refresh token. These drive the real account class against a stubbed fetch and
// read the point the exchange writes.
import { timingSafeEqual } from "node:crypto";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";

vi.mock("cloudflare:workers", async importOriginal => ({
  // The shared stub's `env`, which the metrics read their bindings from.
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  // Bases of classes these tests construct none of.
  RpcTarget: Object,
  WorkerEntrypoint: Object,
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/spotify-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/account-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/playlist-configurator-ui.txt", () => ({ default: "" }));

const { UserAccount } = await import("../src/spotify");

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "ticket" };

// An account whose connect flow has reached the OAuth callback, with the nonce that callback
// carries, and what the account stored.
function connecting() {
  const kv = new Map<string, unknown>();
  kv.set("nonce", { value: "oauth-nonce", expiresAt: Date.now() + 60_000, stage: "oauth" });
  kv.set("callback", { complete: async () => HANDOFF });
  const ctx = {
    id: { toString: () => "user" },
    exports: { GatekeeperUserImpl: () => ({}) },
    storage: {
      // Values are kept as they are given: the callback is a stub, which is no plain data.
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => void kv.set(key, value),
        delete: (key: string) => kv.delete(key),
      },
      deleteAlarm: async () => {},
    },
  };
  const configured = { CLIENT_ID: "client", CLIENT_SECRET: "secret", BASE_URL: "https://gk.example" };
  return { account: new UserAccount(ctx as never, configured as never), kv };
}

type Point = { blobs?: unknown[]; doubles?: unknown[] };

// A global fetch that answers the token endpoint with `body`, and the requests it was handed.
function answering(body: unknown) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the grant a code is exchanged for", () => {
  const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
  let points: Point[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void points.push(point) };
    ambient.SUBSERVICE_METRICS = "true";
    // The Workers runtime's comparison, which the account checks the callback's nonce with.
    Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value: timingSafeEqual });
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
    vi.unstubAllGlobals();
  });

  // Each point written, as its operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => (slot.startsWith("blob") ? point.blobs : point.doubles)?.[Number(slot.replace(/\D+/, "")) - 1]));
  }

  it("is refused, and its exchange counted as an error of the call, when a 200 holds no refresh token", async () => {
    const fetch = answering({ access_token: "new-access", expires_in: 1800 });
    const { account, kv } = connecting();
    const refused = account.acceptAuthCode("the-code", "oauth-nonce");
    await expect(refused).rejects.toThrow(new Error("Spotify did not return a refresh token."));
    expect(fetch.mock.calls.map(([input, init]) => [init?.method, String(input)])).toEqual([["POST", TOKEN_URL]]);
    expect([kv.has("refreshToken"), kv.has("accessToken")]).toEqual([false, false]);
    expect(calls()).toEqual([["token.exchange", "error", "api", 200]]);
  });

  it("is stored, and its exchange counted as a success, when it holds a refresh token", async () => {
    const fetch = answering({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
    const { account, kv } = connecting();
    expect(await account.acceptAuthCode("the-code", "oauth-nonce")).toEqual(HANDOFF);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([kv.get("refreshToken"), kv.get("accessToken")]).toEqual(["new-refresh", "new-access"]);
    expect(calls()).toEqual([["token.exchange", "success", "", 200]]);
  });
});
