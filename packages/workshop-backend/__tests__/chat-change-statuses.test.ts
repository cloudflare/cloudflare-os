import { describe, expect, it } from "vitest";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { chatChangeStatuses } from "../src/agent-compaction";

const AUTHOR = { type: "user" as const, id: "alice@example.com", name: "Alice" };

function msg(sequence: number, body: object): AiChatMessage {
  return {
    chatId: 1, sequence, timestamp: new Date(sequence), author: AUTHOR, ...body,
  } as AiChatMessage;
}

describe("chatChangeStatuses", () => {
  it("marks merged changes inclusively through mergeThrough", () => {
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "changes" }),
      msg(2, { type: "merge", mergeThrough: 1, commits: [] }),
      msg(3, { type: "changes" }),
    ]);
    expect(statuses.get(0)).toBe("merged");
    expect(statuses.get(1)).toBe("merged");
    expect(statuses.get(3)).toBeUndefined();
  });

  it("marks reverted changes from revertFrom up to the revert message", () => {
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "changes" }),
      msg(2, { type: "revert", revertFrom: 1 }),
      msg(3, { type: "changes" }),
    ]);
    expect(statuses.get(0)).toBeUndefined();
    expect(statuses.get(1)).toBe("reverted");
    expect(statuses.get(3)).toBeUndefined();
  });

  it("lets the earlier marking win, exactly like agent replay", () => {
    // Change 0 is merged, then a (nonsensical, but historically possible) revert names it too:
    // the merge already claimed it. Change 1 is reverted first, so a later merge through it
    // cannot resurrect it.
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "merge", mergeThrough: 0, commits: [] }),
      msg(2, { type: "changes" }),
      msg(3, { type: "revert", revertFrom: 0 }),
      msg(4, { type: "merge", mergeThrough: 2, commits: [] }),
    ]);
    expect(statuses.get(0)).toBe("merged");
    expect(statuses.get(2)).toBe("reverted");
  });

  it("shields the change at exactly mergeThrough from a later revert", () => {
    // A revert naming an already-merged sequence must not resurrect it as reverted -- the
    // accepted content is part of the committed head. This is the inclusive-boundary case
    // (mergeThrough itself), which agent replay historically got wrong.
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "merge", mergeThrough: 0, commits: [] }),
      msg(2, { type: "changes" }),
      msg(3, { type: "revert", revertFrom: 0 }),
    ]);
    expect(statuses.get(0)).toBe("merged");
    expect(statuses.get(2)).toBe("reverted");
  });

  it("does not mark changes recorded after the marking message", () => {
    // Processing is strictly in log order, like foldProposedChanges: a merge (or revert) can
    // only cover changes that existed when it was recorded. A merge message naming a future
    // sequence -- which mergeChanges() now rejects, but a hostile or corrupted log could carry
    // -- must not retroactively claim later changes.
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "merge", mergeThrough: 5, commits: [] }),
      msg(2, { type: "changes" }),
      msg(3, { type: "revert", revertFrom: 0 }),
    ]);
    expect(statuses.get(0)).toBe("merged");
    // Not claimed by the earlier merge despite sequence 2 <= mergeThrough 5; the revert gets it.
    expect(statuses.get(2)).toBe("reverted");
  });

  it("marks non-changes messages in a range, for replay's reverted-read elision", () => {
    // Agent replay elides tool reads (type "message") whose sequence lies in a reverted range;
    // the map must cover them, not just "changes" messages.
    let statuses = chatChangeStatuses([
      msg(0, { type: "changes" }),
      msg(1, { type: "message", toolCalls: [] }),
      msg(2, { type: "revert", revertFrom: 0 }),
    ]);
    expect(statuses.get(0)).toBe("reverted");
    expect(statuses.get(1)).toBe("reverted");
    expect(statuses.get(2)).toBeUndefined();  // the revert itself is not in its own range
  });

  it("works on a log tail, marking only messages present in it", () => {
    // Agent replay passes the post-checkpoint tail; merges and reverts may name sequences below
    // it, which simply have no entry to mark.
    let statuses = chatChangeStatuses([
      msg(10, { type: "changes" }),
      msg(11, { type: "merge", mergeThrough: 10, commits: [] }),
      msg(12, { type: "revert", revertFrom: 3 }),
    ]);
    expect(statuses.get(10)).toBe("merged");
    // The merge message itself lies in the revert's range; nothing queries merge messages'
    // statuses, but nothing below sequence 10 is marked.
    expect(statuses.get(11)).toBe("reverted");
    expect(statuses.get(3)).toBeUndefined();
    expect(statuses.get(9)).toBeUndefined();
  });
});
