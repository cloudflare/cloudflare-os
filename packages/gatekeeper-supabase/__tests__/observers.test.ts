// Supabase's observer contract: every read reports the subresources it depends on (an organization
// binding its organization, plus the project whose data a read reveals; a project binding its
// project under the organization Supabase names), verifyObserverAccess refuses any ID the binding
// never reports, and each observer's own account answers access from its project and organization
// lists, reusing allowed answers longer than denials, within the credentials that learned them.
// The Management API is faked at `fetch`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";

vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

import { SupabaseGatekeeperImpl, UserAccount } from "../src/supabase.js";
import type { SupabaseOrganization, SupabaseProject } from "../src/types";

const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "tsrqponmlkjihgfedcba";
const PROJECT_ID = `organization/acme/project/${REF}`;

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key: string, value: unknown) => { map.set(key, value); },
    delete: (key: string) => map.delete(key),
    *list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
      for (const key of [...map.keys()].toSorted()) {
        if (key.startsWith(prefix)) yield [key, map.get(key) as T];
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function project(ref: string, organizationSlug: string) {
  return {
    ref, name: ref, organization_slug: organizationSlug, region: "us-east-1", status: "ACTIVE_HEALTHY",
    created_at: "2026-01-01T00:00:00Z", database: { host: `db.${ref}.supabase.co`, version: "15" },
  };
}

/**
 * Serves the Management API from `routes`, by path; a function route is asked on every request.
 * Returns the requests made, as `METHOD path` with the bearer token they carried.
 */
function serve(routes: Record<string, unknown>) {
  const requests: { request: string; token: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    requests.push({
      request: `${init?.method ?? "GET"} ${pathname}`,
      token: new Headers(init?.headers).get("Authorization"),
    });
    const route = routes[pathname];
    if (route === undefined) return json({ message: "not found" }, 404);
    return typeof route === "function" ? route() as Response : json(route);
  }));
  return requests;
}

type Observation = { title: string; subresources?: string[]; excludeObservers?: string[] };

function recordingQueue() {
  const observations: Observation[] = [];
  return {
    observations,
    dup() { return this; },
    authorizeObservation(description: Observation) { observations.push(description); },
  };
}

/** A gatekeeper facet as `getGatekeeperClassFor` mints it, reading with a live owner token. */
function gatekeeper(props: { resourceKind: "project"; ref: string } | { resourceKind: "organization"; slug: string }) {
  const kv = memoryKv();
  const owner = {
    getAccessToken: async () => ({ token: "owner-token", expiresAt: Date.now() + 3_600_000 }),
    noteCredentialsExpired: async () => {},
  };
  const ctx = {
    props: { userObjectId: "owner", ...props },
    storage: { kv },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => owner } },
  };
  return { gatekeeper: new SupabaseGatekeeperImpl(ctx as never, {} as never), kv };
}

/** An observer whose verifier answers from `access`, recording what it was asked. */
function observer(id: string, access: (subresource: string) => boolean) {
  const checkSubresourceAccess = vi.fn(async (subresources: string[]) => subresources.map(access));
  return { id, verifier: { checkSubresourceAccess } as never, checkSubresourceAccess };
}

/** An account with a live grant, connected before credentials were named. */
function connectedAccount() {
  const kv = memoryKv();
  kv.put("accessToken", "token-1");
  kv.put("refreshToken", "refresh-1");
  kv.put("accessTokenExpiresAt", Date.now() + 3_600_000);
  const ctx = {
    storage: { kv, deleteAll: async () => kv.map.clear(), deleteAlarm: async () => {} },
    id: { toString: () => "account" },
    exports: {},
  };
  const account = new UserAccount(ctx as never, { CLIENT_ID: "client", CLIENT_SECRET: "secret" } as never);
  return { account, kv };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("organization binding observations", () => {
  it("report the organization on every read, and each project whose data a read reveals", async () => {
    serve({
      "/v1/organizations": [{ slug: "acme", name: "Acme" }],
      "/v1/projects": [],
      [`/v1/projects/${REF}`]: project(REF, "acme"),
      [`/v1/projects/${REF}/functions`]: [],
      [`/v1/projects/${REF}/database/query/read-only`]: [],
    });
    const { gatekeeper: facet, kv } = gatekeeper({ resourceKind: "organization", slug: "acme" });
    const queue = recordingQueue();
    const organization = await facet.startSession(queue as never) as SupabaseOrganization;

    await organization.getInfo();
    // Served from the session cache, and still reported.
    await organization.getInfo();
    expect(await organization.listProjects()).toEqual([]);
    const opened = await organization.getProject(REF);
    expect(await opened.listEdgeFunctions()).toEqual([]);
    expect(await (await opened.getDatabase()).query("select 1")).toEqual({ rows: [], rowCount: 0 });

    expect(queue.observations.map(({ title, subresources }) => [title, subresources])).toEqual([
      ["Read Supabase organization", ["organization/acme"]],
      ["Read Supabase organization", ["organization/acme"]],
      ["List Supabase projects", ["organization/acme"]],
      ["Open Supabase project", ["organization/acme", PROJECT_ID]],
      ["List Supabase edge functions", ["organization/acme", PROJECT_ID]],
      ["Run read-only SQL on Supabase", ["organization/acme", PROJECT_ID]],
    ]);
    // Reads no longer feed the legacy tracker or exclude observers by it.
    expect(queue.observations.every(observation => observation.excludeObservers === undefined)).toBe(true);
    expect([...kv.list({ prefix: "observedProject:" })]).toEqual([]);
  });
});

describe("project binding observations", () => {
  it("report the project under the organization Supabase names, from its cached metadata", async () => {
    const requests = serve({
      [`/v1/projects/${REF}`]: project(REF, "acme"),
      [`/v1/projects/${REF}/storage/buckets`]: [],
      [`/v1/projects/${REF}/database/query/read-only`]: [],
    });
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "project", ref: REF });
    const queue = recordingQueue();
    const session = await facet.startSession(queue as never) as SupabaseProject;

    expect(await session.listStorageBuckets()).toEqual([]);
    await session.getInfo();
    expect(await (await session.getDatabase()).query("select 1")).toEqual({ rows: [], rowCount: 0 });

    expect(queue.observations.map(({ subresources }) => subresources))
      .toEqual([[PROJECT_ID], [PROJECT_ID], [PROJECT_ID]]);
    expect(requests.filter(({ request }) => request === `GET /v1/projects/${REF}`)).toHaveLength(1);
  });

  it("refuse a read when Supabase names no organization for the project", async () => {
    serve({
      [`/v1/projects/${REF}`]: project(REF, ""),
      [`/v1/projects/${REF}/storage/buckets`]: [],
    });
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "project", ref: REF });
    const queue = recordingQueue();
    const session = await facet.startSession(queue as never) as SupabaseProject;

    await expect(session.listStorageBuckets()).rejects.toThrow(/which organization owns/);
    expect(queue.observations).toEqual([]);
  });
});

describe("verifyObserverAccess", () => {
  it("allows, on an organization binding, the observers whose accounts can read every ID", async () => {
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "organization", slug: "acme" });
    const member = observer("member", () => true);
    const outsider = observer("outsider", subresource => subresource === "organization/acme");

    await expect(facet.verifyObserverAccess([member, outsider], ["organization/acme", PROJECT_ID]))
      .resolves.toEqual({ allowedObserverIds: ["member"] });
    expect(member.checkSubresourceAccess).toHaveBeenCalledWith(["organization/acme", PROJECT_ID]);
  });

  it("refuses, on an organization binding, any ID outside its organization or of an unknown kind", async () => {
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "organization", slug: "acme" });
    const member = observer("member", () => true);
    for (const id of [
      "organization/other",
      `organization/other/project/${REF}`,
      `organization/acme/project/${REF}/table/notes`,
      `organization/acme/team/${REF}`,
      `project/${REF}`,
      "supabase/organization/acme",
      // A non-canonical spelling of the bound organization.
      "organization/%61cme",
      "organization",
      "",
    ]) {
      await expect(facet.verifyObserverAccess([member], ["organization/acme", id]), id)
        .rejects.toThrow(/subresource/i);
    }
    expect(member.checkSubresourceAccess).not.toHaveBeenCalled();
  });

  it("accepts, on a project binding, only its own project, under any organization", async () => {
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "project", ref: REF });
    const member = observer("member", () => true);

    // The project may have moved to another organization since a read reported it.
    await expect(facet.verifyObserverAccess([member], [PROJECT_ID, `organization/elsewhere/project/${REF}`]))
      .resolves.toEqual({ allowedObserverIds: ["member"] });
    for (const id of ["organization/acme", `organization/acme/project/${OTHER_REF}`]) {
      await expect(facet.verifyObserverAccess([member], [PROJECT_ID, id]), id)
        .rejects.toThrow(/subresource/i);
    }
  });

  it("fails the whole call when an observer's access cannot be determined", async () => {
    const { gatekeeper: facet } = gatekeeper({ resourceKind: "project", ref: REF });
    const unreachable = {
      id: "unreachable",
      verifier: { checkSubresourceAccess: async () => { throw new Error("credentials expired"); } } as never,
    };

    await expect(facet.verifyObserverAccess([observer("member", () => true), unreachable], [PROJECT_ID]))
      .rejects.toThrow("credentials expired");
  });
});

describe("UserAccount.checkSubresourceAccess", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  });

  it("answers every project from one project list, whatever organization its ID names", async () => {
    const requests = serve({ "/v1/projects": [project(REF, "moved")] });
    const { account } = connectedAccount();

    await expect(account.checkSubresourceAccess([
      PROJECT_ID, `organization/acme/project/${OTHER_REF}`, `organization/elsewhere/project/${REF}`,
    ])).resolves.toEqual([true, false, true]);
    expect(requests.map(({ request }) => request)).toEqual(["GET /v1/projects"]);
  });

  it("answers every organization from one organization list", async () => {
    const requests = serve({ "/v1/organizations": [{ slug: "acme", name: "Acme" }] });
    const { account } = connectedAccount();

    await expect(account.checkSubresourceAccess(["organization/acme", "organization/other"]))
      .resolves.toEqual([true, false]);
    expect(requests.map(({ request }) => request)).toEqual(["GET /v1/organizations"]);
  });

  it("reuses an allowed answer for 15 minutes and a denial for 15 seconds", async () => {
    let reachable = [project(REF, "acme")];
    const requests = serve({ "/v1/projects": () => json(reachable) });
    const { account } = connectedAccount();
    const otherId = `organization/acme/project/${OTHER_REF}`;

    await expect(account.checkSubresourceAccess([PROJECT_ID, otherId])).resolves.toEqual([true, false]);
    reachable = [project(OTHER_REF, "acme")];

    vi.setSystemTime(Date.now() + 10_000);
    await expect(account.checkSubresourceAccess([PROJECT_ID, otherId])).resolves.toEqual([true, false]);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(Date.now() + 6_000);
    await expect(account.checkSubresourceAccess([PROJECT_ID, otherId])).resolves.toEqual([true, true]);
    expect(requests).toHaveLength(2);

    vi.setSystemTime(Date.now() + 15 * 60_000 - 15_000);
    await expect(account.checkSubresourceAccess([PROJECT_ID, otherId])).resolves.toEqual([false, true]);
    expect(requests).toHaveLength(3);
  });

  it("asks again under credentials a reconnect installs", async () => {
    let reachable = [project(REF, "acme")];
    const requests = serve({ "/v1/projects": () => json(reachable) });
    const { account, kv } = connectedAccount();

    await expect(account.checkSubresourceAccess([PROJECT_ID])).resolves.toEqual([true]);
    reachable = [];
    const stageId = stageCredentials(kv, {
      accessToken: "token-2", refreshToken: "refresh-2", accessTokenExpiresAt: Date.now() + 3_600_000,
    }, Date.now());
    await account.commitReconnect(stageId);

    await expect(account.checkSubresourceAccess([PROJECT_ID])).resolves.toEqual([false]);
    expect(requests.map(({ token }) => token)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("fails a check a reconnect lands in rather than combining two accounts' answers", async () => {
    let reachable = [project(REF, "acme")];
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<Response>();
    serve({
      "/v1/projects": () => json(reachable),
      "/v1/oauth/token": () => {
        started.resolve();
        return refreshed.promise;
      },
    });
    const { account, kv } = connectedAccount();
    const otherId = `organization/acme/project/${OTHER_REF}`;
    await expect(account.checkSubresourceAccess([PROJECT_ID])).resolves.toEqual([true]);

    // The first account's token expires, and the reconnect installs one that reaches only the other project.
    kv.put("accessTokenExpiresAt", Date.now());
    const checking = account.checkSubresourceAccess([PROJECT_ID, otherId]);
    await started.promise;
    reachable = [project(OTHER_REF, "acme")];
    await account.commitReconnect(stageCredentials(kv, {
      accessToken: "token-2", refreshToken: "refresh-2", accessTokenExpiresAt: Date.now() + 3_600_000,
    }, Date.now()));
    refreshed.resolve(json({ access_token: "token-1b", refresh_token: "refresh-1b", expires_in: 3600 }));

    await expect(checking).rejects.toThrow(/changed while their access was being checked/);
  });

  it("keeps a reconnected grant when a refresh of the replaced one finishes after it", async () => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<Response>();
    serve({ "/v1/oauth/token": () => {
      started.resolve();
      return refreshed.promise;
    } });
    const { account, kv } = connectedAccount();
    kv.put("accessTokenExpiresAt", Date.now());

    const token = account.getAccessToken();
    await started.promise;
    await account.commitReconnect(stageCredentials(kv, {
      accessToken: "token-2", refreshToken: "refresh-2", accessTokenExpiresAt: Date.now() + 3_600_000,
    }, Date.now()));
    refreshed.resolve(json({ access_token: "token-1b", refresh_token: "refresh-1b", expires_in: 3600 }));

    await expect(token).resolves.toMatchObject({ token: "token-2" });
    expect([kv.get("accessToken"), kv.get("refreshToken")]).toEqual(["token-2", "refresh-2"]);
  });

  it("throws, caching nothing, when Supabase refuses the request", async () => {
    let response = () => json({ message: "unauthorized" }, 401);
    const requests = serve({ "/v1/projects": () => response() });
    const { account } = connectedAccount();

    await expect(account.checkSubresourceAccess([PROJECT_ID])).rejects.toThrow(/expired or been revoked/);
    response = () => json({ message: "slow down" }, 429);
    await expect(account.checkSubresourceAccess([PROJECT_ID])).rejects.toThrow();
    response = () => json({ message: "unavailable" }, 503);
    await expect(account.checkSubresourceAccess([PROJECT_ID])).rejects.toThrow();
    response = () => json([project(REF, "acme")]);
    await expect(account.checkSubresourceAccess([PROJECT_ID])).resolves.toEqual([true]);
    expect(requests).toHaveLength(4);
  });

  it("throws without asking when the account has no credentials or an ID is not its own", async () => {
    const requests = serve({ "/v1/projects": [project(REF, "acme")] });
    const { account, kv } = connectedAccount();

    await expect(account.checkSubresourceAccess([PROJECT_ID, "repo/1"])).rejects.toThrow(/subresource/i);
    kv.delete("refreshToken");
    await expect(account.checkSubresourceAccess([PROJECT_ID])).rejects.toThrow(/not been configured/);
    expect(requests).toEqual([]);
  });
});
