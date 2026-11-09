import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// What only real storage and RPC show: stubs are read back out of storage and called, and a firing's
// own stubs are handed on to the delivery. A loopback entrypoint's stub has nothing to dispose, and
// this pool cannot mint the `ctx.restore()` stub a facet delivers through, so disposal is checked
// against copies in the Node suite and against real stubs in integration-tests' workshop-hooks.
it("delivers through the stubs it stored, across deliveries and a replacement", async () => {
  const host = env.HOOK_HOST.getByName("delivers");
  await host.enable("hook");

  expect(await host.deliver("hook", "first")).toEqual(["first"]);
  expect(await host.deliver("hook", "second")).toEqual(["first", "second"]);

  await host.enable("hook");
  expect(await host.deliver("hook", "third")).toEqual(["first", "second", "third"]);
});
