import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareObservabilityApiError } from "../src/observability-parse";
import { getWorker, resolveWorkerScope } from "../src/workers-api";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_ID = "a".repeat(32);
const OTHER_WORKER_ID = "b".repeat(32);
const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/`;
const getToken = async () => "token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answer each request by its path under the account, recording the paths asked for. */
function stubApi(route: (path: string) => Response): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input).slice(API_BASE.length);
    paths.push(path);
    return route(path);
  }));
  return paths;
}

function notFound(): Response {
  return Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
}

function versionsPage(ids: string[], perPage = 100): Response {
  return Response.json({
    success: true,
    result: ids.map(id => ({ id })),
    result_info: { page: 1, per_page: perPage },
  });
}

describe("getWorker", () => {
  it("returns the Worker a name names", async () => {
    const paths = stubApi(() => Response.json({
      success: true, result: { id: WORKER_ID, name: "api/worker" },
    }));

    await expect(getWorker(getToken, ACCOUNT_ID, { name: "api/worker" }))
      .resolves.toEqual({ workerId: WORKER_ID, name: "api/worker" });
    expect(paths).toEqual(["workers/workers/api%2Fworker"]);
  });

  it("refuses a Worker named like the ID it was asked for", async () => {
    // The API resolves a path segment as an ID *or* a name. Once the bound Worker is gone, another
    // Worker named after its ID would answer the lookup, and must not be taken for it.
    stubApi(() => Response.json({
      success: true, result: { id: OTHER_WORKER_ID, name: WORKER_ID },
    }));

    await expect(getWorker(getToken, ACCOUNT_ID, { workerId: WORKER_ID })).resolves.toBeNull();
  });

  it("reports a missing Worker as null", async () => {
    stubApi(notFound);

    await expect(getWorker(getToken, ACCOUNT_ID, { name: "gone" })).resolves.toBeNull();
  });

  it("throws a denial rather than reporting the Worker missing", async () => {
    // A caller has to tell "no such Worker" from "this credential cannot look": the latter means
    // asking for the missing scope, not telling the user their Worker is gone.
    stubApi(() => Response.json({ success: false, errors: [{ code: 10000, message: "forbidden" }] }, { status: 403 }));

    const error = await getWorker(getToken, ACCOUNT_ID, { name: "api-worker" }).catch(caught => caught);

    expect(error).toBeInstanceOf(CloudflareObservabilityApiError);
    expect(error).toMatchObject({ status: 403 });
  });

  it("rejects a malformed Worker as a gateway error", async () => {
    stubApi(() => Response.json({ success: true, result: { id: "not-an-id", name: "api-worker" } }));

    await expect(getWorker(getToken, ACCOUNT_ID, { name: "api-worker" }))
      .rejects.toMatchObject({ status: 502 });
  });
});

function worker(): Response {
  return Response.json({ success: true, result: { id: WORKER_ID, name: "renamed-worker" } });
}

describe("resolveWorkerScope", () => {
  it("collects every version across pages and the Worker's current name", async () => {
    // A version left off the list would have its telemetry dropped as another Worker's, so the walk
    // must continue while pages come back full.
    const paths = stubApi(path => {
      if (path === `workers/workers/${WORKER_ID}`) return worker();
      const page = new URL(path, API_BASE).searchParams.get("page");
      if (page === "1") return versionsPage(["v1", "v2"], 2);
      if (page === "2") return versionsPage(["v3", "v4"], 2);
      return versionsPage(["v5"], 2);
    });

    const scope = await resolveWorkerScope(getToken, ACCOUNT_ID, WORKER_ID);

    expect(scope).toEqual({
      workerId: WORKER_ID,
      name: "renamed-worker",
      versionIds: new Set(["v1", "v2", "v3", "v4", "v5"]),
    });
    expect(paths.filter(path => path.includes("/versions"))
      .map(path => new URL(path, API_BASE).searchParams.get("page")))
      .toEqual(["1", "2", "3"]);
  });

  it("stops at the first short page", async () => {
    const paths = stubApi(path => path.includes("/versions") ? versionsPage(["v1"]) : worker());

    await expect(resolveWorkerScope(getToken, ACCOUNT_ID, WORKER_ID))
      .resolves.toMatchObject({ versionIds: new Set(["v1"]) });
    expect(paths).toEqual([
      `workers/workers/${WORKER_ID}/versions?page=1&per_page=100`,
      `workers/workers/${WORKER_ID}`,
    ]);
  });

  it("reports a deleted Worker as gone", async () => {
    stubApi(path => path.includes("/versions") ? notFound() : worker());

    await expect(resolveWorkerScope(getToken, ACCOUNT_ID, WORKER_ID))
      .rejects.toMatchObject({ status: 404 });
  });

  it("refuses a Worker named like the bound Worker's ID", async () => {
    // The versions path resolves names too, so after a deletion it can list an impostor's versions;
    // the ID lookup that follows is what refuses to take that Worker for the bound one.
    stubApi(path => path.includes("/versions")
      ? versionsPage(["impostor-version"])
      : Response.json({ success: true, result: { id: OTHER_WORKER_ID, name: WORKER_ID } }));

    await expect(resolveWorkerScope(getToken, ACCOUNT_ID, WORKER_ID))
      .rejects.toMatchObject({ status: 404 });
  });

  it("reports the Worker gone when it disappears between the two lookups", async () => {
    stubApi(path => path.includes("/versions") ? versionsPage(["v1"]) : notFound());

    await expect(resolveWorkerScope(getToken, ACCOUNT_ID, WORKER_ID))
      .rejects.toMatchObject({ status: 404 });
  });
});
