import { env, runDurableObjectAlarm } from "cloudflare:test";
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

// A throw alone undoes no write, so the stubs `set()` stores first would outlive it.
it("leaves a hook as it was when the driver's transaction around set() fails", async () => {
  const host = env.HOOK_HOST.getByName("rolls-back");
  const refused = (key: string) => host.enable(key, false).then(() => false, () => true);

  expect(await refused("new")).toBe(true);
  expect(await host.holdsStubs("new")).toBe(false);

  await host.enable("hook");
  expect(await refused("hook")).toBe(true);
  expect(await host.deliver("hook", "message")).toEqual(["message"]);
});

// The wake resolves a promise the alarm's run awaits from another request's context.
it("wakes a run waiting in the alarm when another request queues a row", async () => {
  const host = env.HOOK_HOST.getByName("wakes");
  await host.enable("held");
  await host.enable("woken");
  await host.enqueue("held", "held", true);
  const alarm = runDurableObjectAlarm(host);
  await host.arrived("held");

  // Returns at once: the delivery it starts runs in the alarm, while "held" still holds the run.
  await host.enqueue("woken", "woken");
  await host.arrived("woken");
  await host.release();

  expect(await alarm).toBe(true);
  expect(await host.row("woken:woken")).toEqual({ deliveredAt: expect.any(Number) });
  expect(await host.reports()).toEqual([]);
});
