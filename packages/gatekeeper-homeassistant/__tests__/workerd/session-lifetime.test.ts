// A session's approval-queue duplicate keeps its collaborator counted as live, so it must be
// released exactly when the last capability holding it is, and never stranded by a failed start.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

const hooks = () => env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));

async function account(credentials?: { baseUrl: string; token: string }): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    if (credentials) state.storage.kv.put("credentials", credentials);
  });
  return id.toString();
}

describe("session approval queue lifetime", () => {
  it("releases the queue when credential resolution fails", async () => {
    const userObjectId = await account();
    const result = await hooks().openTracked("no-creds", { userObjectId, resourceKind: "instance" }, []);
    expect(result).toEqual({ error: expect.stringMatching(/credentials are not configured/) });
    await vi.waitFor(async () => {
      expect((await hooks().trackedQueue("no-creds")).released).toBe(true);
    });
  });

  it("keeps the queue authorizing while a forked child outlives its parent, then releases it", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/api/states/light.kitchen");
      return Response.json({ entity_id: "light.kitchen", state: "on", attributes: {} });
    });
    const userObjectId = await account({ baseUrl: "http://ha.test", token: "t" });
    const facet = "retained-child";
    expect(await hooks().openTracked(facet, { userObjectId, resourceKind: "instance" },
      [["getEntity", "light.kitchen"]])).toEqual({ ok: null });

    await hooks().disposeHeld(facet, 0);
    const before = (await hooks().trackedQueue(facet)).observations;
    expect(await hooks().callHeld(facet, 1, "getState")).toHaveProperty("ok");
    const after = await hooks().trackedQueue(facet);
    expect(after).toEqual({ released: false, observations: before + 1 });

    await hooks().disposeHeld(facet, 1);
    await vi.waitFor(async () => {
      expect((await hooks().trackedQueue(facet)).released).toBe(true);
    });
  });
});
