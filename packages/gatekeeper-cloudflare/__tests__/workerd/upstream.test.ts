// The points written for the requests a connected account's Durable Object sends to Cloudflare: a
// check that probes account after account is written as one point per kind of answer, and the
// refresh it starts is counted under its own name. The metrics read the Worker's bindings from
// `cloudflare:workers`, whose `env` this suite shares with the Durable Object, so a dataset set on
// it here records what the account writes.

import { env, runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_SCOPES } from "../../src/oauth";
import type { UserAccount } from "../worker.js";

const DENIED_ACCOUNT_ID = "00000000000000000000000000000001";
const ACCOUNT_IDS = [
  "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", DENIED_ACCOUNT_ID,
];
const TELEMETRY_SCOPES = [...BILLING_SCOPES, "workers-observability.read"];

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

// The points written, as each one's source, service, operation, outcome, HTTP status and number of
// calls, ordered by operation and status.
function written() {
  const rows = points.map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
  return rows.toSorted((a, b) => `${a[2]} ${a[4]}`.localeCompare(`${b[2]} ${b[4]}`));
}

describe("the points of a telemetry access check", () => {
  it("writes the probes of every account asked about as one point per kind of answer", async () => {
    // The token endpoint answers a refresh, and the telemetry API each probe: a refusal for one
    // account and keys for the others.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.body instanceof URLSearchParams) {
        return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      }
      return url.includes(`/accounts/${DENIED_ACCOUNT_ID}/`)
        ? Response.json({ success: false, errors: [{ code: 10000, message: "refused" }] }, { status: 403 })
        : Response.json({ success: true, result: [{ key: "$metadata.level", type: "string", lastSeenAt: 1 }] });
    }));

    const allowed = await runInDurableObject(env.USER_ACCOUNT.getByName("upstream-points"), (account: UserAccount, state) => {
      // An expired access token, so that the check refreshes it before its first probe.
      state.storage.kv.put("refreshToken", "refresh-1");
      state.storage.kv.put("accessToken", { token: "access-1", expires: 0 });
      state.storage.kv.put("grantedScopes", TELEMETRY_SCOPES);
      return account.checkTelemetryAccess(ACCOUNT_IDS);
    });

    expect(allowed).toEqual([true, true, false]);
    expect(written()).toEqual([
      ["gatekeeper.cloudflare.api", "cloudflare", "telemetry.keys", "success", 200, 2],
      ["gatekeeper.cloudflare.api", "cloudflare", "telemetry.keys", "error", 403, 1],
      ["gatekeeper.cloudflare.api", "cloudflare", "token.refresh", "success", 200, 1],
    ]);
  });
});
