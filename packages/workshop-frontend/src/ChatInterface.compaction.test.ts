// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody, ChatCodeBase } from "@gadgets/workshop-shared/api";
import type { CodeOp } from "@gadgets/workshop-shared/code-op";
import {
  buildChatDisplayEntries, computeChatEpochOps, computeMessageStates,
  type CompactionBoundary,
} from "./ChatInterface";

const AUTHOR = { type: "agent", id: "test-model", name: "Test" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

function changes(sequence: number, op: CodeOp): AiChatMessage {
  return message(sequence, { type: "changes", op });
}

function merge(sequence: number, mergeThrough: number): AiChatMessage {
  return message(sequence, { type: "merge", mergeThrough, commits: [], epochBoundary: true });
}

function revert(sequence: number, revertFrom: number): AiChatMessage {
  return message(sequence, { type: "revert", revertFrom });
}

function boundary(to: number, proposedOp?: CodeOp): CompactionBoundary {
  return { to, summary: "Earlier work", proposedOp };
}

function codeBase(overrides?: Partial<ChatCodeBase>): ChatCodeBase {
  return { pins: [], generation: 0, revision: 0, ...overrides };
}

// Ops on distinct files, so their compositions are easy to recognize (a union of `set`s).
const PRE_BOUNDARY: CodeOp = { 1: [["pre.txt", { set: "pre" }]] };
const LOADED: CodeOp = { 1: [["loaded.txt", { set: "loaded" }]] };
const OLDER: CodeOp = { 1: [["older.txt", { set: "older" }]] };

describe("computeMessageStates compaction seeding", () => {
  it("counts the boundary's proposed changes as one entry below the oldest loaded message", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 9, op: PRE_BOUNDARY },
      { sequence: 10, op: LOADED },
    ]);
  });

  it("ignores a boundary that carries no proposed changes", () => {
    const { activeChanges } = computeMessageStates([changes(10, LOADED)], boundary(10));

    expect(activeChanges).toEqual([{ sequence: 10, op: LOADED }]);
  });

  // Accepting changes must clear the compacted prefix's op too, or the chat keeps reporting
  // proposed changes that the user already accepted.
  it("resolves the boundary entry when a merge reaches across it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), merge(11, 10), changes(12, OLDER)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 12, op: OLDER }]);
  });

  it("keeps the boundary entry when a revert stops above it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), revert(11, 10)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 9, op: PRE_BOUNDARY }]);
  });

  // The boundary's op is the composition of the "changes" messages before it, so it must drop out
  // the moment those messages load -- otherwise the same edits are counted twice.
  it("drops the boundary entry once the messages before it have loaded", () => {
    const { activeChanges } = computeMessageStates(
      [changes(5, OLDER), changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 5, op: OLDER },
      { sequence: 10, op: LOADED },
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

// The durable half of the chat's content: the current epoch's non-reverted ops composed into
// one, with the oldest loaded boundary's proposedOp standing in for the compacted pages, plus
// the current generation's materialization watermark (see ChatCodeChanges).
describe("computeChatEpochOps", () => {
  it("composes non-reverted ops in order", () => {
    const { epochOp } = computeChatEpochOps([
      changes(10, LOADED),
      changes(12, OLDER),
    ]);

    expect(epochOp).toEqual({
      1: [["loaded.txt", { set: "loaded" }], ["older.txt", { set: "older" }]],
    });
  });

  it("skips reverted ops", () => {
    const { epochOp } = computeChatEpochOps([
      changes(10, LOADED),
      revert(11, 10),
      changes(12, OLDER),
    ]);

    expect(epochOp).toEqual(OLDER);
  });

  it("seeds from the boundary's proposed op", () => {
    const { epochOp } = computeChatEpochOps(
      [changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(epochOp).toEqual({
      1: [["loaded.txt", { set: "loaded" }], ["pre.txt", { set: "pre" }]],
    });
  });

  it("drops the boundary's proposed op when a revert reaches across it", () => {
    const { epochOp } = computeChatEpochOps(
      [changes(10, LOADED), revert(11, 0)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(epochOp).toBeUndefined();
  });

  it("drops the boundary op once the messages before it have loaded", () => {
    const { epochOp } = computeChatEpochOps(
      [changes(5, OLDER), changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(epochOp).toEqual({
      1: [["loaded.txt", { set: "loaded" }], ["older.txt", { set: "older" }]],
    });
  });

  it("keeps a creation-only batch out of the composition", () => {
    const { epochOp } = computeChatEpochOps([
      message(10, {
        type: "changes",
        createdGadgets: [{ gadgetId: 1, title: "New", bindingName: "NEW" }],
      }),
      changes(11, LOADED),
    ]);

    expect(epochOp).toEqual(LOADED);
  });

  // Only the current generation's watermarks position the live-row cursor: revisions restart
  // per generation, so an older generation's watermark says nothing about the current stream.
  it("reports the current generation's materialization watermark", () => {
    const { rowsThrough } = computeChatEpochOps(
      [
        message(10, { type: "changes", op: LOADED,
                      watermark: { opsGeneration: 1, throughRevision: 7 } }),
        message(12, { type: "changes", op: OLDER,
                      watermark: { opsGeneration: 2, throughRevision: 3 } }),
      ],
      undefined,
      codeBase({ generation: 2 }),
    );

    expect(rowsThrough).toBe(3);
  });
});

// Accepting changes closes the chat's epoch: the content resets and rebuilds from the new
// epoch's pins, so ops before ChatCodeBase.epoch -- the epoch-opening merge's sequence -- are no
// longer part of it. A migrated chat's epoch instead points at its own conversionBoundary
// *changes* message, whose op is part of the current content, hence the inclusive comparison.
describe("computeChatEpochOps epoch scoping", () => {
  it("drops ops from closed epochs, keeping the current epoch's", () => {
    const { epochOp } = computeChatEpochOps(
      [changes(10, OLDER), merge(11, 10), changes(12, LOADED)],
      undefined,
      codeBase({ epoch: 11 }),
    );

    expect(epochOp).toEqual(LOADED);
  });

  it("applies no epoch cutoff when epoch is absent", () => {
    const { epochOp } = computeChatEpochOps(
      [changes(10, OLDER), merge(11, 10), changes(12, LOADED)],
      undefined,
      codeBase(),
    );

    expect(epochOp).toEqual({
      1: [["loaded.txt", { set: "loaded" }], ["older.txt", { set: "older" }]],
    });
  });

  it("includes the epoch-opening message itself (a conversion boundary)", () => {
    const { epochOp } = computeChatEpochOps(
      [
        message(10, { type: "changes", op: OLDER, conversionBoundary: true }),
        changes(12, LOADED),
      ],
      undefined,
      codeBase({ epoch: 10 }),
    );

    expect(epochOp).toEqual({
      1: [["loaded.txt", { set: "loaded" }], ["older.txt", { set: "older" }]],
    });
  });

  // The boundary's op stands in at sequence `to - 1`, so an epoch boundary past that point
  // covers its content too (it was all accepted into commits).
  it("drops the boundary op when the epoch reaches past it", () => {
    const { epochOp } = computeChatEpochOps(
      [merge(11, 10), changes(12, LOADED)],
      boundary(10, PRE_BOUNDARY),
      codeBase({ epoch: 11 }),
    );

    expect(epochOp).toEqual(LOADED);
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
