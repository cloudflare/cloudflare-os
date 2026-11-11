// A session's approval-queue stub lives exactly as long as some capability the session handed out:
// the organization or project it started with, a project an organization opened, or a database. The
// Workshop counts a collaborator as holding a live session, and verifies every read against their
// account, until the gatekeeper lets go of the queue, so a leak keeps that going forever. Every
// test here hands the session a queue through a facet and native Workers RPC, keeps no stub of its
// own, and watches for the queue target's dispose, which runs only once the gatekeeper's last
// duplicate is gone.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps, Outcome } from "./worker";

const REF = "abcdefghijklmnopqrst";
const SIBLING_REF = "bcdefghijklmnopqrstu";
const FOREIGN_REF = "tsrqponmlkjihgfedcba";
const BROKEN_REF = "zyxwvutsrqponmlkjihg";

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
 * Serves the Management API at `fetch`, which reaches the gatekeeper because the suite, TestHooks
 * and the Durable Objects share one isolate. Two projects in `acme`, one in another organization,
 * and one Supabase fails to answer for.
 */
function serveSupabase(): void {
  const routes: Record<string, unknown> = {
    [`/v1/projects/${REF}`]: project(REF, "acme"),
    [`/v1/projects/${SIBLING_REF}`]: project(SIBLING_REF, "acme"),
    [`/v1/projects/${FOREIGN_REF}`]: project(FOREIGN_REF, "elsewhere"),
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const { pathname } = new URL(url);
    if (pathname === `/v1/projects/${BROKEN_REF}`) return json({ message: "unavailable" }, 503);
    if (pathname.endsWith("/functions") || pathname.endsWith("/storage/buckets")) return json([]);
    if (pathname.endsWith("/database/query/read-only")) return json([{ one: 1 }]);
    const body = routes[pathname];
    return body === undefined ? json({ message: "not found" }, 404) : json(body);
  });
}

/** An account holding a live grant, so the gatekeeper reads with its token and never refreshes. */
async function seedAccount(): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("accessToken", "owner-token");
    state.storage.kv.put("refreshToken", "owner-refresh");
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + 3_600_000);
  });
  return id.toString();
}

function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

function unwrap<T>(result: Outcome<T>): T {
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

function failure(result: Outcome<unknown>): string {
  if (!("error" in result)) throw new Error(`expected a failure, got ${JSON.stringify(result.ok)}`);
  return result.error;
}

/** A session on a fresh facet, held by TestHooks as `session`. */
async function startSession(binding: { ref: string } | { slug: string }): Promise<string> {
  const userObjectId = await seedAccount();
  const props: GatekeeperProps = "ref" in binding
    ? { userObjectId, resourceKind: "project", ref: binding.ref }
    : { userObjectId, resourceKind: "organization", slug: binding.slug };
  const facet = crypto.randomUUID();
  unwrap(await hooks().startSession(facet, props, "session"));
  return facet;
}

/**
 * Calls `method` on the capability held as `name`, which must still authorize through the queue,
 * and the queue must still be held.
 */
async function readsThrough(facet: string, name: string, title: string, method: string, ...args: unknown[]):
    Promise<void> {
  const before = (await hooks().queueState(facet)).observations.length;
  unwrap(await hooks().call(facet, name, method, ...args));
  const { observations, released } = await hooks().queueState(facet);
  expect(observations.slice(before)).toEqual([title]);
  expect(released).toBe(false);
}

async function expectReleased(facet: string): Promise<void> {
  await vi.waitFor(async () => expect((await hooks().queueState(facet)).released).toBe(true));
}

const LIST_FUNCTIONS = ["List Supabase edge functions", "listEdgeFunctions"] as const;
const LIST_BUCKETS = ["List Supabase storage buckets", "listStorageBuckets"] as const;
const QUERY = ["Run read-only SQL on Supabase", "query", "select 1"] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an organization session's approval queue", () => {
  it("outlives the organization and each project while a project or database is retained", async () => {
    serveSupabase();
    const facet = await startSession({ slug: "acme" });
    unwrap(await hooks().open(facet, "session", "getProject", [REF], "project"));
    unwrap(await hooks().open(facet, "session", "getProject", [SIBLING_REF], "sibling"));
    unwrap(await hooks().open(facet, "project", "getDatabase", [], "database"));

    await hooks().dispose(facet, "session");
    await readsThrough(facet, "project", ...LIST_FUNCTIONS);
    await readsThrough(facet, "sibling", ...LIST_FUNCTIONS);
    await readsThrough(facet, "database", ...QUERY);

    await hooks().dispose(facet, "project");
    await readsThrough(facet, "sibling", ...LIST_BUCKETS);
    await readsThrough(facet, "database", ...QUERY);

    await hooks().dispose(facet, "sibling");
    await readsThrough(facet, "database", ...QUERY);

    await hooks().dispose(facet, "database");
    await expectReleased(facet);
  });

  it("is released when the organization was the only capability", async () => {
    serveSupabase();
    const facet = await startSession({ slug: "acme" });
    await hooks().dispose(facet, "session");
    await expectReleased(facet);
  });

  it("is kept for a project opened while the organization was disposed mid-call", async () => {
    serveSupabase();
    const facet = await startSession({ slug: "acme" });
    await hooks().hold(facet, "Open Supabase project");
    const opening = hooks().open(facet, "session", "getProject", [REF], "project");
    await vi.waitFor(async () => expect((await hooks().queueState(facet)).waiting).toEqual(["Open Supabase project"]));

    await hooks().dispose(facet, "session");
    await hooks().lift(facet, "Open Supabase project");
    unwrap(await opening);
    await readsThrough(facet, "project", ...LIST_FUNCTIONS);

    await hooks().dispose(facet, "project");
    await expectReleased(facet);
  });

  it.each([
    ["a project in another organization", FOREIGN_REF, /is not part of organization acme/],
    ["a project Supabase fails to return", BROKEN_REF, /unavailable/],
  ])("is released once the remaining capabilities go, after opening %s fails", async (_case, ref, error) => {
    serveSupabase();
    const facet = await startSession({ slug: "acme" });
    unwrap(await hooks().open(facet, "session", "getProject", [REF], "project"));
    expect(failure(await hooks().open(facet, "session", "getProject", [ref], "refused"))).toMatch(error);

    await hooks().dispose(facet, "session");
    await readsThrough(facet, "project", ...LIST_FUNCTIONS);

    await hooks().dispose(facet, "project");
    await expectReleased(facet);
  });
});

describe("a project session's approval queue", () => {
  it("outlives the project while its database is retained", async () => {
    serveSupabase();
    const facet = await startSession({ ref: REF });
    await readsThrough(facet, "session", ...LIST_BUCKETS);
    unwrap(await hooks().open(facet, "session", "getDatabase", [], "database"));

    await hooks().dispose(facet, "session");
    await readsThrough(facet, "database", ...QUERY);

    await hooks().dispose(facet, "database");
    await expectReleased(facet);
  });

  it("is released when the project session is disposed", async () => {
    serveSupabase();
    const facet = await startSession({ ref: REF });
    await readsThrough(facet, "session", "Read Supabase project", "getInfo");
    await hooks().dispose(facet, "session");
    await expectReleased(facet);
  });
});
