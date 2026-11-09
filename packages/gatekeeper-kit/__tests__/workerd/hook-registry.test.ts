import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// The Node fake hands back the stubs it was given. Real storage hands back fresh ones on every
// read, and each delivery disposes its own.
it("delivers through stored stubs, which outlive each delivery's copy and a replacement's release", async () => {
  const host = env.HOOK_HOST.getByName("delivers");
  await host.enable("hook");

  expect(await host.deliver("hook", "first")).toEqual(["first"]);
  expect(await host.deliver("hook", "second")).toEqual(["first", "second"]);

  await host.enable("hook");
  expect(await host.deliver("hook", "third")).toEqual(["first", "second", "third"]);
});
