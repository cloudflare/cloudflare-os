// A stand-in for the Cloudflare API the workerd suite's gatekeeper talks to: Workers Observability
// telemetry, the Workers API's Worker and version lookups, and the OAuth token endpoint, each
// answering per access token. Telemetry queries answer with every event the test set, whatever
// their filters say, so what reaches the caller is what the gatekeeper itself let through.

import { env, runInDurableObject } from "cloudflare:test";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { vi } from "vitest";
import { BILLING_SCOPES } from "../../src/oauth";
import type { UserAccount } from "../worker.js";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT_PATH = `/client/v4/accounts/${ACCOUNT_ID}/`;

/** Scopes of a connection granted both observability resource types. */
export const TELEMETRY_SCOPES = [...BILLING_SCOPES, "workers-observability.read", "workers-tail.read"];
/** Scopes of a connection granted observability before Worker bindings needed Worker metadata. */
export const ACCOUNT_ONLY_SCOPES = [...BILLING_SCOPES, "workers-observability.read"];

export type FakeWorker = { id: string; name: string; versions: string[] };

/** Cloudflare as each access token sees it. Tests change it freely between calls. */
export type Backend = {
  /** The account's Workers, which a test renames, deletes and creates. */
  workers: FakeWorker[];
  /** The status every telemetry request with this token fails with; absent means it succeeds. */
  telemetryStatus: Record<string, number>;
  /** The Workers this token can see; absent means every one. */
  sees: Record<string, (worker: FakeWorker) => boolean>;
  /** The events every telemetry query answers with. */
  events: unknown[];
  /** Telemetry requests with this token are answered only once the promise settles. */
  hold: Record<string, Promise<void>>;
  /** Each request to the account, as `METHOD path`, with its token and body. */
  requests: Array<{ token: string; call: string; body?: unknown }>;
};

const json = (value: unknown, status = 200) => Response.json(value, { status });
const failure = (status: number) =>
  json({ success: false, errors: [{ code: 10000 + status, message: `failed with ${status}` }] }, status);
const STATISTICS = { elapsed: 1, rows_read: 10, bytes_read: 100 };

/** A telemetry event emitted by `service` running `versionId`. */
export function event(id: string, service: string, versionId?: string, source: unknown = {}) {
  return {
    dataset: "cloudflare-workers",
    timestamp: 1,
    source,
    $metadata: { id, service, traceId: "trace-1", level: "info" },
    ...(versionId === undefined ? {} : { $workers: { scriptName: service, scriptVersion: { id: versionId } } }),
  };
}

function queryResult(view: string, events: unknown[]): unknown {
  switch (view) {
    case "events": return { statistics: STATISTICS, events: { count: events.length, events } };
    case "invocations": return { statistics: STATISTICS, invocations: { "req-1": events } };
    case "traces": return {
      statistics: STATISTICS,
      traces: [{
        traceId: "trace-1", traceStartMs: 1, traceEndMs: 2, traceDurationMs: 1,
        rootSpanName: "fetch", rootTransactionName: "GET /", service: ["api"], spans: 1,
      }],
    };
    default: return {
      statistics: STATISTICS,
      calculations: [{
        calculation: "count",
        aggregates: [{ value: events.length, count: events.length, interval: 1, sampleInterval: 1 }],
        series: [],
      }],
    };
  }
}

/** Stubs `fetch` with a fresh backend. */
export function stubCloudflare(): Backend {
  const backend: Backend = {
    workers: [], telemetryStatus: {}, sees: {}, events: [], hold: {}, requests: [],
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === "https://dash.cloudflare.com/oauth2/token") {
      return json({ error: "invalid_grant", error_description: "revoked" }, 400);
    }
    if (!url.pathname.startsWith(ACCOUNT_PATH)) return failure(404);
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const path = url.pathname.slice(ACCOUNT_PATH.length);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body));
    backend.requests.push({ token, call: `${init.method ?? "GET"} ${path}`, body });

    const telemetry = path.match(/^workers\/observability\/telemetry\/(keys|values|query)$/);
    if (telemetry) {
      await backend.hold[token];
      const status = backend.telemetryStatus[token];
      if (status) return failure(status);
      if (telemetry[1] === "query") {
        // Shaped by the gatekeeper's own `#query`, the only caller of this endpoint.
        const { view } = body as { view: string };
        return json({ success: true, result: queryResult(view, backend.events) });
      }
      if (telemetry[1] === "values") {
        return json({ success: true, result: [{ key: "$metadata.level", type: "string", value: "info", dataset: "cloudflare-workers" }] });
      }
      return json({ success: true, result: [{ key: "$metadata.level", type: "string", lastSeenAt: 1 }] });
    }

    const lookup = path.match(/^workers\/workers\/([^/]+)(\/versions)?$/);
    if (lookup) {
      const segment = decodeURIComponent(lookup[1]);
      // As Cloudflare documents the path parameter: a Worker's ID or its name.
      const worker = backend.workers.find(candidate => candidate.id === segment) ??
        backend.workers.find(candidate => candidate.name === segment);
      if (!worker || !(backend.sees[token] ?? (() => true))(worker)) return failure(404);
      if (!lookup[2]) return json({ success: true, result: { id: worker.id, name: worker.name } });
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      const versions = worker.versions.slice((page - 1) * perPage, page * perPage);
      return json({
        success: true,
        result: versions.map((id, index) => ({ id, number: (page - 1) * perPage + index + 1 })),
        result_info: { page, per_page: perPage, count: versions.length, total_count: worker.versions.length },
      });
    }
    return failure(404);
  });
  return backend;
}

let accounts = 0;

/** A connected account holding `token` under `scopes`. Returns its `UserAccount` ID. */
export async function connectAccount(token: string, scopes = TELEMETRY_SCOPES): Promise<string> {
  const id = env.USER_ACCOUNT.idFromName(`account-${accounts++}-${token}`);
  await runInDurableObject(env.USER_ACCOUNT.get(id), (_instance: UserAccount, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", `${token}-refresh`);
    state.storage.kv.put("accessToken", { token, expires: Date.now() + 3_600_000 });
    state.storage.kv.put("grantedScopes", scopes);
  });
  return id.toString();
}

/** Runs `change` against a connected account's own storage and object. */
export async function inAccount(
  userObjectId: string,
  change: (account: UserAccount, state: DurableObjectState) => void | Promise<void>,
): Promise<void> {
  await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)), change);
}

/** Reconnects an account to hold `token` instead, through the staged-reconnect commit. */
export async function reconnect(userObjectId: string, token: string): Promise<void> {
  await inAccount(userObjectId, async (account, state) => {
    const stageId = stageCredentials(state.storage.kv, {
      refreshToken: `${token}-refresh`,
      accessToken: { token, expires: Date.now() + 3_600_000 },
      grantedScopes: TELEMETRY_SCOPES,
    }, Date.now());
    await account.commitReconnect(stageId);
  });
}
