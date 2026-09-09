// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collaboratorFor, normalizeCollaborator } from "../src/collaborator.ts";
import { HEARTBEAT_MS, type PresenceEvent, PresenceReporter, PresenceRoster, STALE_MS, THROTTLE_MS } from "../src/presence.ts";

type Caret = { blockId: string | null; offset: number };

const join = (clientId: string, name: string, color = "#123456"): PresenceEvent<Caret> => ({ type: "join", clientId, name, color });
const cursor = (clientId: string, name: string, blockId: string, offset: number): PresenceEvent<Caret> => ({
  type: "cursor", at: 5, clientId, name, color: "#123456", blockId, offset,
});

describe("PresenceRoster", () => {
  it("ignores itself and the nameless, lists a joiner, keeps a caret through a second join, forgets a leaver", () => {
    let now = 1_000;
    const roster = new PresenceRoster<Caret>("me", () => now);
    expect(roster.apply(join("me", "Me"))).toBe(false);
    expect(roster.apply({ type: "leave", clientId: "" })).toBe(false);
    expect(roster.people()).toEqual([]);

    expect(roster.apply(join("ada", "Ada"))).toBe(true);
    expect(roster.people()).toEqual([{ clientId: "ada", name: "Ada", color: "#123456" }]);
    expect(roster.get("ada")).toEqual({ clientId: "ada", name: "Ada", color: "#123456", cursor: null, seenAt: 1_000 });

    now = 2_000;
    roster.apply(cursor("ada", "Ada", "b1", 5));
    expect(roster.entries()).toEqual([{ clientId: "ada", name: "Ada", color: "#123456", cursor: { blockId: "b1", offset: 5 }, seenAt: 2_000 }]);

    now = 3_000;
    roster.apply(join("ada", "Ada L.", "#654321"));
    expect(roster.get("ada")).toEqual({ clientId: "ada", name: "Ada L.", color: "#654321", cursor: { blockId: "b1", offset: 5 }, seenAt: 3_000 });

    expect(roster.apply({ type: "leave", clientId: "ada" })).toBe(true);
    expect(roster.apply({ type: "leave", clientId: "ada" })).toBe(false);
    expect(roster.people()).toEqual([]);
    expect(roster.get("ada")).toBeNull();
  });

  it("expires a collaborator not heard from for STALE_MS", () => {
    const roster = new PresenceRoster("me", () => 10_000);
    roster.apply(join("ada", "Ada"));
    roster.apply(join("bob", "Bob"));
    expect(roster.expire(10_000 + STALE_MS)).toBe(false);
    expect(roster.people()).toHaveLength(2);
    expect(roster.expire(10_000 + STALE_MS + 1)).toBe(true);
    expect(roster.people()).toEqual([]);
    expect(roster.expire(10_000 + STALE_MS + 1)).toBe(false);
  });
});

describe("PresenceReporter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("throttles a burst into one send and sends nothing when there is nothing to say", async () => {
    const sent: number[] = [];
    let position: number | null = 1;
    const reporter = new PresenceReporter(() => position, async (update: number) => void sent.push(update));
    reporter.schedule();
    reporter.schedule();
    position = 2;
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(THROTTLE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([2]);

    position = null;
    reporter.sendNow();
    expect(sent).toEqual([2]);
  });

  it("swallows a failed send", async () => {
    const reporter = new PresenceReporter(() => 1, () => Promise.reject(new Error("offline")));
    reporter.sendNow();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("heartbeats until stopped, running the gadget's tick after each send", async () => {
    const sent: number[] = [];
    const beats: number[] = [];
    const reporter = new PresenceReporter(() => 7, async (update: number) => void sent.push(update));
    const stop = reporter.startHeartbeat(() => beats.push(sent.length));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sent).toEqual([7, 7]);
    expect(beats).toEqual([1, 2]);
    reporter.schedule();
    stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sent).toEqual([7, 7]);
  });
});

describe("collaborators", () => {
  it("derives a stable guest identity from a client id", () => {
    const guest = collaboratorFor("k7x2abzz");
    expect(guest).toEqual({ clientId: "k7x2abzz", name: "Guest K7X2", color: `hsl(${parseInt("k7x2ab", 36) % 360} 62% 48%)` });
    expect(collaboratorFor("k7x2abzz")).toEqual(guest);
  });

  it("bounds and defaults what a client says about itself", () => {
    expect(normalizeCollaborator({ clientId: "c1", name: "  Ada  ", color: "hsl(10 62% 48%)" })).toEqual({ clientId: "c1", name: "Ada", color: "hsl(10 62% 48%)" });
    expect(normalizeCollaborator({ clientId: "c1", name: "", color: "url(javascript:x)" })).toEqual({ clientId: "c1", name: "Guest", color: "#e1632e" });
    expect(normalizeCollaborator(null)).toEqual({ clientId: "", name: "Guest", color: "#e1632e" });
    expect(normalizeCollaborator({ clientId: "x".repeat(200), name: "n".repeat(50) })).toEqual({ clientId: "x".repeat(100), name: "n".repeat(40), color: "#e1632e" });
    expect(normalizeCollaborator({ clientId: "c1", color: "hsl(10deg, 62%, 48%)" }).color).toBe("hsl(10deg, 62%, 48%)");
  });

  it("rejects an over-long colour before matching it, so a hostile one cannot stall the server", () => {
    // Long runs of spaces are what made the old separator pattern backtrack polynomially.
    const hostile = `hsl(1${" ".repeat(20_000)}x${" ".repeat(20_000)}x${" ".repeat(20_000)}x`;
    const started = performance.now();
    expect(normalizeCollaborator({ clientId: "c1", color: hostile }).color).toBe("#e1632e");
    expect(normalizeCollaborator({ clientId: "c1", color: `hsl(1 ${" ".repeat(30)}50% 50% x` }).color).toBe("#e1632e");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
