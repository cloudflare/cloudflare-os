// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import {
  buildChatDisplayEntries, computeMessageStates, type CompactionBoundary,
} from "./ChatInterface";

const AUTHOR = { type: "agent", id: "test-model", name: "Test" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

function changes(sequence: number, update: Uint8Array): AiChatMessage {
  return message(sequence, { type: "changes", update });
}

function merge(sequence: number, mergeThrough: number): AiChatMessage {
  return message(sequence, { type: "merge", mergeThrough, version: 1, commits: [] });
}

function revert(sequence: number, revertFrom: number): AiChatMessage {
  return message(sequence, { type: "revert", revertFrom });
}

function boundary(to: number, proposedChanges?: Uint8Array): CompactionBoundary {
  return { to, summary: "Earlier work", proposedChanges };
}

const PRE_BOUNDARY = new Uint8Array([1, 2, 3]);
const LOADED = new Uint8Array([4, 5, 6]);
const OLDER = new Uint8Array([7, 8, 9]);

describe("computeMessageStates compaction seeding", () => {
  it("counts the boundary's proposed changes as one entry below the oldest loaded message", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 9, update: PRE_BOUNDARY },
      { sequence: 10, update: LOADED },
    ]);
  });

  it("ignores a boundary that carries no proposed changes", () => {
    const { activeChanges } = computeMessageStates([changes(10, LOADED)], boundary(10));

    expect(activeChanges).toEqual([{ sequence: 10, update: LOADED }]);
  });

  // Accepting changes must clear the compacted prefix's update too, or the chat keeps reporting
  // proposed changes that the user already accepted.
  it("resolves the boundary entry when a merge reaches across it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), merge(11, 10), changes(12, OLDER)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 12, update: OLDER }]);
  });

  it("keeps the boundary entry when a revert stops above it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), revert(11, 10)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 9, update: PRE_BOUNDARY }]);
  });

  // The boundary's update is the merge of the "changes" messages before it, so it must drop out the
  // moment those messages load -- otherwise the same edits are counted twice.
  it("drops the boundary entry once the messages before it have loaded", () => {
    const { activeChanges } = computeMessageStates(
      [changes(5, OLDER), changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 5, update: OLDER },
      { sequence: 10, update: LOADED },
    ]);
  });

  it("leaves loaded messages' change status alone", () => {
    const { changeStatus } = computeMessageStates(
      [changes(10, LOADED), merge(11, 10)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(changeStatus.get(10)).toBe("merged");
  });
});

describe("announcing a compaction", () => {
  const compact = (sequence: number) => message(sequence,
    {type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""}});
  const boundary = (to: number): CompactionBoundary => ({to, summary: `summary ${to}`});

  // The cut leaves a working tail, so it lands back from where the user typed. Announcing it there
  // would put the acknowledgement out of sight, so it is announced at the request instead.
  it("announces a requested compaction at the request", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "summarized"}),
      message(2, {type: "message", message: "kept"}),
      compact(3),
    ], new Map(), [boundary(2)]);

    expect(entries.map(entry => entry.type)).toEqual(
      ["message", "compactionCut", "message", "compactionBoundary"]);
  });

  // Nothing asked for it, so there is no request to announce at and the cut speaks for itself.
  it("announces an unrequested compaction at the cut", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "summarized"}),
      message(2, {type: "message", message: "kept"}),
    ], new Map(), [boundary(2)]);

    expect(entries.map(entry => entry.type)).toEqual(
      ["message", "compactionBoundary", "message"]);
  });

  // A request that compacted nothing left no boundary, so claiming otherwise would be a lie.
  it("shows nothing for a request that compacted nothing", () => {
    expect(buildChatDisplayEntries([compact(1)], new Map())).toEqual([]);
  });

  // A later request can only produce a later cut, which is what lets each be matched to its own.
  it("matches each request to the compaction it produced", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "a"}),
      compact(2),
      message(3, {type: "message", message: "b"}),
      compact(4),
    ], new Map(), [boundary(1), boundary(3)]);

    expect(entries.map(entry =>
      entry.type === "compactionBoundary" ? `announce-${entry.boundary.to}` : entry.type)).toEqual(
      ["compactionCut", "message", "announce-1", "compactionCut", "message", "announce-3"]);
  });

  // The announcement reports what survived the cut, so the reader can tell how much the agent still
  // has verbatim without scrolling back to find the line.
  it("reports how many rows the cut spared", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "summarized"}),
      message(2, {type: "message", message: "kept"}),
      message(3, {type: "message", message: "kept"}),
      compact(4),
    ], new Map(), [boundary(2)]);

    const announcement = entries.find(entry => entry.type === "compactionBoundary");
    expect(announcement).toMatchObject({keptRows: 2});
  });

  // Compaction that ran on its own is not swept up by a later request.
  it("leaves an unrequested compaction at its cut when a request follows", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "a"}),
      message(3, {type: "message", message: "b"}),
      compact(4),
    ], new Map(), [boundary(1), boundary(3)]);

    expect(entries.map(entry =>
      entry.type === "compactionBoundary" ? `announce-${entry.boundary.to}` : entry.type)).toEqual(
      ["announce-1", "message", "compactionCut", "message", "announce-3"]);
  });
});
