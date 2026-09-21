import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOG_TTL_MS, HydratedTools } from "../src/catalog.js";
import type { McpTool } from "../src/client.js";

const tool = (name: string): McpTool => ({ name });

afterEach(() => {
  vi.useRealTimers();
});

describe("HydratedTools", () => {
  it("fetches a tool once per TTL", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (name: string) => tool(name));
    const cache = new HydratedTools();

    await expect(cache.resolve("a", load)).resolves.toEqual(tool("a"));
    await expect(cache.resolve("a", load)).resolves.toEqual(tool("a"));
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CATALOG_TTL_MS + 1);
    await expect(cache.resolve("a", load)).resolves.toEqual(tool("a"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent loads of one tool", async () => {
    let release!: (value: McpTool) => void;
    const load = vi.fn((name: string) => new Promise<McpTool>(resolve => {
      release = resolve;
    }));
    const cache = new HydratedTools();

    const first = cache.resolve("a", load);
    const second = cache.resolve("a", load);
    expect(load).toHaveBeenCalledTimes(1);

    release(tool("a"));
    await expect(Promise.all([first, second])).resolves.toEqual([tool("a"), tool("a")]);
  });

  it("remembers that a tool does not exist", async () => {
    // Without this, a Gadget naming a tool that is not there sends one full paginated listing to the
    // endpoint per call -- a cheap way to make this gatekeeper hammer a server on an agent's behalf.
    const load = vi.fn(async () => undefined);
    const cache = new HydratedTools();

    await expect(cache.resolve("ghost", load)).resolves.toBeUndefined();
    await expect(cache.resolve("ghost", load)).resolves.toBeUndefined();
    await expect(cache.resolve("ghost", load)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds how much a Gadget can make it hold", async () => {
    const cache = new HydratedTools();
    const load = vi.fn(async (name: string) => tool(name));
    const total = HydratedTools.MAX_ENTRIES + 10;
    for (let i = 0; i < total; i++) await cache.resolve(`t${i}`, load);
    expect(load).toHaveBeenCalledTimes(total);

    // The most recent are still cached; the oldest were evicted to make room for them.
    load.mockClear();
    await cache.resolve(`t${total - 1}`, load);
    expect(load).not.toHaveBeenCalled();
    await cache.resolve("t0", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts definitions to keep aggregate retained bytes bounded", async () => {
    const cache = new HydratedTools();
    const large = (name: string): McpTool => ({
      name,
      description: "x".repeat(4000),
      inputSchema: { type: "object", description: "y".repeat(20_000) },
    });
    for (let i = 0; i < 50; i++) await cache.resolve(`large_${i}`, async name => large(name));

    const reload = vi.fn(async (name: string) => large(name));
    await cache.resolve("large_0", reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
