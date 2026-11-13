// The approval queue a session was opened with is held exactly as long as the session or a
// capability minted from it is: the Workshop counts the collaborator live until native RPC releases
// the queue, so a stranded duplicate keeps them counted forever.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BOB, FakeX, failure, hooks, seedAccount, unwrap } from "./fake-x";
import type { GatekeeperProps, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  const x = new FakeX().install();
  const props: GatekeeperProps = { userObjectId: await seedAccount(x), resourceKind: "account" };
  return { x, props, name: crypto.randomUUID() };
}

describe("approval queue release", () => {
  const VALID_POST = "1234567890123456789";
  for (const [label, steps] of [
    ["getPost", [["getPost", "not a post"]]],
    ["getUser", [["getUser", "not a user!"]]],
    ["getList", [["getList", "not a list"]]],
    ["getConversationPost", [["getPost", VALID_POST], ["getConversationPost", "not a post"]]],
  ] as [string, Step[]][]) {
    it(`releases the queue after ${label} rejects its argument`, async () => {
      const { props, name } = await setup();
      expect(failure(await hooks().openTracked(name, props, steps))).toBeTruthy();
      for (let index = steps.length - 1; index >= 0; index--) await hooks().disposeHeld(name, index);
      await vi.waitFor(async () => expect((await hooks().trackedQueue(name)).released).toBe(true));
    });
  }

  it("keeps the queue while a post outlives its session, and releases it with the post", async () => {
    const { x, props, name } = await setup();
    const post = x.post(BOB, "retained");
    unwrap(await hooks().openTracked(name, props, [["getPost", post.id]]));
    await hooks().disposeHeld(name, 0);
    expect(unwrap(await hooks().callHeld(name, 1, "getInfo"))).toMatchObject({ text: "retained" });
    expect(await hooks().trackedQueue(name)).toEqual({ released: false, observations: 1 });
    await hooks().disposeHeld(name, 1);
    await vi.waitFor(async () => expect((await hooks().trackedQueue(name)).released).toBe(true));
  });
});
