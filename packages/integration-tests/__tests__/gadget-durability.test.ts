import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent-session.js";
import { startHarness, type Harness, type WorkerConfig } from "../src/harness.js";
import { DURABLE_NOTES_SERVER, OVERSELLING_DESK_SERVER } from "../fixtures/seeded-gadgets.js";

// Scope: a Gadget facet restarting, and whether an application's state survives it. A whole Durable
// Object resetting is a separate concern, covered in `workshop-backend/__integration__`, which runs
// in-process and can abort one object through `cloudflare:test`.

// Seeded gadgets never call a model, but AgentSession.create() selects one from listModels(), which
// is empty unless the Workshop believes a gateway is configured. These values are never dialled.
function offlineModelConfig(config: WorkerConfig): void {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: "unused",
    CF_AI_GATEWAY_ACCOUNT_ID: "unused",
    CF_AI_GATEWAY_API_TOKEN: "unused",
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
  };
}

interface NotesApi {
  put(input: { id: string; body: string }): Promise<{ ok: boolean }>;
  all(): Promise<{ id: string; body: string }[]>;
  liveness(): Promise<{ instance: string; callsSinceStart: number }>;
}

interface DeskApi {
  defineSlot(input: { slotId: string; capacity: number }): Promise<{ ok: boolean }>;
  book(input: { bookingId: string; slotId: string }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  bookedCount(input: { slotId: string }): Promise<number>;
}

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop: offlineModelConfig,
  });
}, 120_000);

afterAll(async () => {
  await harness?.server.close();
});

describe("Gadget durability across abrupt server restarts", () => {
  it("restarts the server for real, keeping storage and dropping memory", async () => {
    using session = await AgentSession.create(harness.url, { usernamePrefix: "durable" });
    const id = await session.seedGadget({
      title: "Notes", bindingName: "NOTES", files: { "server.js": DURABLE_NOTES_SERVER },
    });

    const before = await session.connectToGadget<NotesApi>(id, "accepted");
    await before.put({ id: "a", body: "first" });
    const livenessBefore = await before.liveness();
    expect(livenessBefore.callsSinceStart).toBeGreaterThan(0);

    await session.restartGadgets();

    // The abort invalidates outstanding stubs, which is what proves it actually happened. Without
    // this the rest of the suite could pass against a restart that never occurred.
    await expect(before.all()).rejects.toThrow();
    before[Symbol.dispose]();

    using after = await session.connectToGadget<NotesApi>(id, "accepted");
    // Read the counter before anything else, since every other method bumps it.
    const livenessAfter = await after.liveness();
    expect(livenessAfter.instance).not.toBe(livenessBefore.instance);
    expect(livenessAfter.callsSinceStart).toBe(0);
    expect(await after.all()).toEqual([{ id: "a", body: "first" }]);
  }, 120_000);

  it("keeps every row across repeated restarts", async () => {
    using session = await AgentSession.create(harness.url, { usernamePrefix: "durable" });
    const id = await session.seedGadget({
      title: "Notes", bindingName: "NOTES", files: { "server.js": DURABLE_NOTES_SERVER },
    });

    const instances: string[] = [];
    for (let round = 0; round < 5; round++) {
      using api = await session.connectToGadget<NotesApi>(id, "accepted");
      await api.put({ id: `note-${round}`, body: `body-${round}` });
      expect(await api.all()).toHaveLength(round + 1);
      instances.push((await api.liveness()).instance);
      await session.restartGadgets();
    }

    using api = await session.connectToGadget<NotesApi>(id, "accepted");
    expect(await api.all()).toEqual(
        Array.from({ length: 5 }, (_unused, round) => ({ id: `note-${round}`, body: `body-${round}` })));
    // Every round really did run in a fresh instance.
    expect(new Set(instances).size).toBe(5);
  }, 180_000);

  it("leaves storage consistent when a restart lands on an unfinished write", async () => {
    using session = await AgentSession.create(harness.url, { usernamePrefix: "durable" });
    const id = await session.seedGadget({
      title: "Notes", bindingName: "NOTES", files: { "server.js": DURABLE_NOTES_SERVER },
    });

    const writer = await session.connectToGadget<NotesApi>(id, "accepted");
    await writer.put({ id: "settled", body: "already committed" });
    // Dispatched but deliberately not awaited, so the restart races it.
    const inFlight = writer.put({ id: "racing", body: "may or may not land" }).catch(() => undefined);
    await session.restartGadgets();
    await inFlight;
    writer[Symbol.dispose]();

    using api = await session.connectToGadget<NotesApi>(id, "accepted");
    const rows = await api.all();
    // Either outcome is correct for the racing write; what must hold is that the committed row is
    // intact, the table is readable, and no half-written row appeared.
    expect(rows).toContainEqual({ id: "settled", body: "already committed" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2);
    for (const row of rows) expect(typeof row.body).toBe("string");
  }, 120_000);
});

describe("Concurrent RPC interleaving", () => {
  // Pins the platform behaviour that any "never oversells" assertion depends on: if a naive
  // implementation could not oversell here, such an assertion would hold for the wrong reason.
  it("lets a check-then-write implementation oversell", async () => {
    using session = await AgentSession.create(harness.url, { usernamePrefix: "oversell" });
    const id = await session.seedGadget({
      title: "Broken Desk", bindingName: "DESK", files: { "server.js": OVERSELLING_DESK_SERVER },
    });

    using api = await session.connectToGadget<DeskApi>(id, "accepted");
    const capacity = 3;
    await api.defineSlot({ slotId: "race", capacity });

    const results = await Promise.all(Array.from({ length: 10 }, (_unused, index) =>
      api.book({ bookingId: `race-${index}`, slotId: "race" })));
    const accepted = results.filter(result => result.ok).length;

    expect(accepted).toBeGreaterThan(capacity);
    expect(await api.bookedCount({ slotId: "race" })).toBeGreaterThan(capacity);
  }, 120_000);
});
