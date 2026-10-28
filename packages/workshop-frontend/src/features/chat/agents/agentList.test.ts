import { describe, expect, it } from "vitest";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import {
  agentsNeedingAttention, deriveAgents, formatLastRun, formatRunAge, ownConversations,
} from "./agentList";

const MODEL = {type: "agent", id: "m", name: "Model"} as const;
const NOW = new Date("2026-11-12T17:00:00Z");

const chat = (over: Partial<AiChatMetadata> & {id: number}): AiChatMetadata => ({
  title: `Chat ${over.id}`,
  started: new Date("2026-11-12T09:00:00Z"),
  lastActive: new Date("2026-11-12T09:00:00Z"),
  ...over,
});

const run = (id: number, spawnerName: string, over: Partial<AiChatMetadata> = {}) =>
  chat({id, spawnerName, ...over});

describe("deriveAgents", () => {
  it("lists one agent per spawner, keeping the chat list's order inside each", () => {
    const agents = deriveAgents([
      run(1, "Email joker"), chat({id: 2}), run(3, "Weekly digest"), run(4, "Email joker"),
    ], new Set(), NOW);

    expect(agents.map(a => a.name)).toEqual(["Email joker", "Weekly digest"]);
    expect(agents[0].runs.map(r => r.id)).toEqual([1, 4]);
  });

  it("keeps a renamed spawner's runs together, and same-named spawners apart", () => {
    const agents = deriveAgents([
      run(1, "Invoice watcher", {spawnerId: 7}),
      run(2, "Invoice checker", {spawnerId: 7}),
      run(3, "Invoice watcher", {spawnerId: 9}),
    ], new Set(), NOW);

    // The newest run carries the spawner's current name.
    expect(agents.map(a => [a.name, a.runs.map(r => r.id)]))
      .toEqual([["Invoice watcher", [1, 2]], ["Invoice watcher", [3]]]);
  });

  it("puts runs that predate spawner ids with the agent now using their name", () => {
    const agents = deriveAgents([
      run(1, "Invoice watcher", {spawnerId: 7}),
      run(2, "Invoice watcher"),
      run(3, "Weekly digest"),
    ], new Set(), NOW);

    expect(agents.map(a => a.runs.map(r => r.id))).toEqual([[1, 2], [3]]);
  });

  it("leaves out conversations the user started", () => {
    expect(deriveAgents([chat({id: 1}), chat({id: 2})], new Set(), NOW)).toEqual([]);
  });

  it("reports the most recent activity across an agent's runs", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {lastActive: new Date("2026-11-12T09:00:00Z")}),
      run(2, "Inbox triage", {lastActive: new Date("2026-11-12T14:35:00Z")}),
      run(3, "Inbox triage", {lastActive: new Date("2026-11-11T08:00:00Z")}),
    ], new Set(), NOW);

    expect(agents[0].lastRun).toEqual(new Date("2026-11-12T14:35:00Z"));
    expect(agents[0].runs).toHaveLength(3);
  });

  it("counts only the runs that are working", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {activeAgent: MODEL}),
      run(2, "Inbox triage"),
      run(3, "Inbox triage", {activeAgent: MODEL}),
    ], new Set(), NOW);

    expect(agents[0].running).toBe(2);
  });

  it("flags unaccepted work as pending changes", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {proposedChangeWorkpieces: [7]}), run(2, "Inbox triage"),
    ], new Set(), NOW);

    expect(agents[0].attention).toBe("changes");
    expect(agents[0].waiting).toBe(1);
  });

  it("treats an empty proposed-change list as nothing to review", () => {
    const agents = deriveAgents([run(1, "Inbox triage", {proposedChangeWorkpieces: []})], new Set(), NOW);

    expect(agents[0].attention).toBeUndefined();
    expect(agents[0].waiting).toBe(0);
  });

  it("ranks a run needing review above unreviewed changes", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {proposedChangeWorkpieces: [7]}), run(2, "Inbox triage"),
    ], new Set([2]), NOW);

    expect(agents[0].attention).toBe("review");
    // Both runs want the user, however differently.
    expect(agents[0].waiting).toBe(2);
  });

  it("asks for review of a run stopped on a decision the action log does not hold", () => {
    const agents = deriveAgents([run(1, "Inbox triage", {awaitingDecision: true})], new Set(), NOW);

    expect(agents[0].attention).toBe("review");
    expect(agents[0].waiting).toBe(1);
  });

  it("sums cost only across runs that reported one", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {totalCost: 0.25}), run(2, "Inbox triage"),
      run(3, "Weekly digest"),
    ], new Set(), NOW);

    expect(agents[0].cost).toBeCloseTo(0.25);
    expect(agents[1].cost).toBeUndefined();
  });

  it("counts only the runs active today", () => {
    // Local times, since "today" is the calendar day wherever the user is.
    const now = new Date("2026-11-12T17:00:00");
    const agents = deriveAgents([
      run(1, "Inbox triage", {lastActive: new Date("2026-11-12T09:00:00")}),
      run(2, "Inbox triage", {lastActive: new Date("2026-11-12T14:00:00")}),
      run(3, "Inbox triage", {lastActive: new Date("2026-11-04T09:00:00")}),
    ], new Set(), now);

    expect(agents[0].today).toBe(2);
    expect(agents[0].runs).toHaveLength(3);
  });

  it("sums unread messages across an agent's runs", () => {
    const agents = deriveAgents(
      [run(1, "Inbox triage"), run(2, "Inbox triage"), run(3, "Weekly digest")],
      new Set(),
      NOW,
      new Map([[1, 2], [2, 3]]),
    );

    expect(agents[0].unread).toBe(5);
    expect(agents[1].unread).toBe(0);
  });
});

describe("formatRunAge", () => {
  const now = new Date("2026-11-12T17:00:00Z");

  it("counts back from now in the largest unit that still reads", () => {
    expect(formatRunAge(new Date("2026-11-12T16:59:30Z"), now)).toBe("now");
    expect(formatRunAge(new Date("2026-11-12T16:49:00Z"), now)).toBe("11m");
    expect(formatRunAge(new Date("2026-11-12T14:00:00Z"), now)).toBe("3h");
    expect(formatRunAge(new Date("2026-11-10T17:00:00Z"), now)).toBe("2d");
  });

  it("falls back to a date once an elapsed time stops meaning anything", () => {
    expect(formatRunAge(new Date("2026-10-02T17:00:00Z"), now)).toMatch(/Oct|10/);
  });
});

describe("agentsNeedingAttention", () => {
  it("counts agents with review work, pending changes, or unread output", () => {
    const agents = deriveAgents([
      run(1, "Inbox triage", {proposedChangeWorkpieces: [7]}),
      run(2, "Inbox triage", {proposedChangeWorkpieces: [8]}),
      run(3, "Weekly digest"),
    ], new Set(), NOW, new Map([[3, 2]]));

    expect(agentsNeedingAttention(agents)).toBe(2);
  });
});

describe("ownConversations", () => {
  it("keeps only the chats no spawner started", () => {
    expect(ownConversations([chat({id: 1}), run(2, "Inbox triage"), chat({id: 3})])
      .map(c => c.id)).toEqual([1, 3]);
  });
});

describe("formatLastRun", () => {
  const now = new Date("2026-11-12T17:00:00");

  it("shows a time for today and drops it for older runs", () => {
    const today = formatLastRun(new Date("2026-11-12T14:35:00"), now);
    const thisWeek = formatLastRun(new Date("2026-11-09T11:08:00"), now);
    const older = formatLastRun(new Date("2026-10-02T11:08:00"), now);

    expect(today).toMatch(/2:35/);
    // Within the week the weekday is what locates it, not the date.
    expect(thisWeek).toMatch(/Mon/);
    expect(thisWeek).toMatch(/11:08/);
    expect(older).not.toMatch(/11:08/);
    expect(older).toMatch(/Oct|10/);
  });
});
