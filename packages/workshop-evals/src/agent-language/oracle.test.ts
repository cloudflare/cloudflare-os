import { it, expect } from "vitest";
import { tasks, verify } from "./tasks.ts";
import { createWorld } from "./world.ts";
it("rejects hardcoded answers without required tool use", () => {
  for (const t of tasks.filter((t) => !["aggregate", "authorization"].includes(t.id))) {
    const world = createWorld();
    expect(verify(t, { result: t.expected, state: world.state(), calls: [], runtimeMs: 0 })).toBe(
      false,
    );
  }
});
it("rejects close with wrong valid resolution and missing tags", async () => {
  const world = createWorld();
  await world.fetch(
    new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ tool: "close", input: { id: "a", resolution: "duplicate" } }),
    }),
  );
  expect(
    verify(
      tasks.find((t) => t.id === "workflow")!,
      { result: "closed", state: world.state(), calls: world.calls, runtimeMs: 0 },
    ),
  ).toBe(false);
});
it("accepts safe serial read-write increments", async () => {
  const world = createWorld();
  for (let i = 0; i < 2; i++) {
    await world.fetch(
      new Request("http://test", { method: "POST", body: JSON.stringify({ tool: "read" }) }),
    );
    await world.fetch(
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify({ tool: "write", input: i + 1 }),
      }),
    );
  }
  expect(
    verify(
      tasks.find((t) => t.id === "counter")!,
      { result: 2, state: world.state(), calls: world.calls, runtimeMs: 0 },
    ),
  ).toBe(true);
});
