// A staged action of a generated gatekeeper, through the kit's test host: what a session shows
// while it waits, and what applying and rejecting it do.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { failure, seedCredentials, unwrap } from "@gadgets/gatekeeper-kit/test-support";

const ITEM = { id: "item1", title: "First", updated_at: "2026-01-01T00:00:00Z" };
const testEnv = env as any;

/** The provider with one item, which a `PATCH` retitles. */
function fakeProvider(): string[] {
  const item = { ...ITEM };
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === "PATCH") Object.assign(item, await request.json());
    return Response.json(item);
  });
  return requests;
}

async function scenario() {
  const id = testEnv.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(testEnv.USER_ACCOUNT.get(id), async (_account: unknown, state: DurableObjectState) => {
    seedCredentials(state.storage.kv, { accessToken: "key" });
    state.storage.kv.put("identity", { userId: "u-alice", name: "Alice", fetchedAt: Date.now() });
  });
  const host = testEnv.TEST_HOST.get(testEnv.TEST_HOST.idFromName("host"));
  const facet = crypto.randomUUID();
  const props = { userObjectId: id.toString(), itemId: ITEM.id };
  const title = async () => (unwrap(await host.run(facet, props, [["get"]])) as { title: string }).title;
  const staged = async () => (await host.queueLog(facet)).submitted.map(({ actionId }: { actionId: number }) => actionId);
  return { host, facet, props, title, staged };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows a rename while it waits, and drops it when it is rejected", async () => {
  const requests = fakeProvider();
  const { host, facet, props, title, staged } = await scenario();

  unwrap(await host.run(facet, props, [["rename", "Second"]]));
  const [actionId] = await staged();
  expect(await title()).toBe("Second");

  unwrap(await host.rejectAction(facet, props, actionId));
  expect(await title()).toBe("First");
  expect(requests).not.toContain("PATCH /items/item1");
});

it("applies an approved rename to the provider", async () => {
  const requests = fakeProvider();
  const { host, facet, props, title, staged } = await scenario();

  unwrap(await host.run(facet, props, [["rename", "Second"]]));
  unwrap(await host.applyAction(facet, props, (await staged())[0]));
  expect(requests).toContain("PATCH /items/item1");
  expect(await title()).toBe("Second");
});

it("reports the step that failed, not the cleanup after it", async () => {
  fakeProvider();
  const { host, facet, props } = await scenario();

  // `rename` returns nothing, so there is nothing to call `get` on.
  const message = failure(await host.run(facet, props, [["rename", "Second"], ["get"]]));
  expect(message).toMatch(/undefined/);
  expect(message).not.toMatch(/dispose/);
});
