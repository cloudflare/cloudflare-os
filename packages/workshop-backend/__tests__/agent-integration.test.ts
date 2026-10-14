import { describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant, beginIntegrationTurn, closeIntegrationTurn,
  deliverIntegrationEvent, requireIntegrationTurn } from "../src/agent-integration";

let nextId = 0;
const id = () => `identity-${++nextId}`;

describe("trusted integration grants", () => {
  it("requires exact per-vendor opt-in, separate from ambience", () => {
    const config = '{"container":{"lifecycle":true},"other":{"contextualActions":true}}';
    expect(agentIntegrationGrant(config, "container")).toEqual({ lifecycle: true, contextualActions: false, worktreeReplica: false, recoverableActions: false });
    expect(agentIntegrationGrant(config, "other")).toEqual({ lifecycle: false, contextualActions: true, worktreeReplica: false, recoverableActions: false });
    expect(agentIntegrationGrant(config, "Container")).toEqual({});
    expect(agentIntegrationGrant(undefined, "container")).toEqual({});
  });
  it.each(["broken", "null", "[]", '{"container":true}',
    '{"container":{"lifecycle":"true"}}', '{"container":{"worktreeReplica":"true"}}',
    '{"container":{"contextualActions":1}}'])("fails closed on %s", config => {
    expect(agentIntegrationGrant(config, "container")).toEqual({});
  });
  it("requires a separate explicit replica grant", () => {
    expect(agentIntegrationGrant('{"container":{"worktreeReplica":true}}', "container"))
      .toEqual({ lifecycle: false, contextualActions: false, worktreeReplica: true, recoverableActions: false });
    expect(agentIntegrationGrant('{"container":{"arbitraryOidRead":true}}', "container")).toEqual({});
  });
  it("requires explicit administrator opt-in for idempotent approval recovery", () => {
    expect(agentIntegrationGrant('{"container":{"recoverableActions":true}}', "container"))
      .toEqual({ lifecycle: false, contextualActions: false, worktreeReplica: false, recoverableActions: true });
    expect(agentIntegrationGrant('{"container":{"recoverableActions":"true"}}', "container")).toEqual({});
  });
});

describe("logical agent turns", () => {
  it("allows cancellation to terminate an already suspended turn, without reviving it", () => {
    const first = beginIntegrationTurn(undefined, 1, "prompt-1", id);
    const paused = closeIntegrationTurn(first, "approval", id);
    const canceled = closeIntegrationTurn(paused, "canceled", id);
    expect(canceled).toMatchObject({state: "finished", closing: {kind: "finished", reason: "canceled"}});
    expect(closeIntegrationTurn(canceled, "approval", id)).toBe(canceled);
    expect(() => requireIntegrationTurn(canceled, first, "applyingAction")).toThrow(/expired/);
  });
  it.each(["approval", "connection"] as const)("resumes the same turn after %s with a new segment", reason => {
    const first = beginIntegrationTurn(undefined, 1, "prompt-1", id);
    const paused = closeIntegrationTurn(first, reason, id);
    const resumed = beginIntegrationTurn(paused, 1, "prompt-1", id);
    expect(paused.closing).toMatchObject({ kind: "suspended", reason });
    expect(resumed.turnId).toBe(first.turnId);
    expect(resumed.segmentId).not.toBe(first.segmentId);
    expect(resumed.entry.kind).toBe("resumed");
    expect(resumed.closing).toBeUndefined();
  });
  it.each(["completed", "canceled", "failed", "abandoned"] as const)("starts fresh after %s", reason => {
    const first = beginIntegrationTurn(undefined, 1, "prompt-1", id);
    const ended = closeIntegrationTurn(first, reason, id);
    const next = beginIntegrationTurn(ended, 1, "prompt-1", id);
    expect(ended.closing).toMatchObject({ kind: "finished", reason });
    expect(next.turnId).not.toBe(first.turnId);
    expect(next.entry.kind).toBe("started");
  });
  it("does not borrow a newer prompt's turn or retry id", () => {
    const first = beginIntegrationTurn(undefined, 1, "prompt-1", id);
    const paused = closeIntegrationTurn(first, "approval", id);
    expect(closeIntegrationTurn(paused, "approval", id)).toBe(paused);
    const next = beginIntegrationTurn(paused, 1, "prompt-2", id);
    expect(next.turnId).not.toBe(first.turnId);
    expect(() => requireIntegrationTurn(next, first, "applyingAction")).toThrow(/expired/);
  });
  it("rejects stale segments and running contexts during cleanup", () => {
    const first = beginIntegrationTurn(undefined, 1, "prompt-1", id);
    const paused = closeIntegrationTurn(first, "approval", id);
    expect(() => requireIntegrationTurn(paused, first, "running")).toThrow(/expired/);
    expect(requireIntegrationTurn(paused, first, "applyingAction").phase).toBe("applyingAction");
    const resumed = beginIntegrationTurn(paused, 1, "prompt-1", id);
    expect(() => requireIntegrationTurn(resumed, first, "applyingAction")).toThrow(/expired/);
    const ended = closeIntegrationTurn(resumed, "completed", id);
    expect(() => requireIntegrationTurn(ended, resumed, "applyingAction")).toThrow(/expired/);
    expect(requireIntegrationTurn(ended, resumed, "finishing").phase).toBe("finishing");
  });
  it("does not acknowledge callback rejection or timeout as delivery", async () => {
    await expect(deliverIntegrationEvent(async () => { throw new Error("retry me"); })).rejects.toThrow("retry me");
    await expect(deliverIntegrationEvent(() => new Promise(() => {}), 10)).rejects.toThrow("timed out");
    await expect(deliverIntegrationEvent(async () => {})).resolves.toBeUndefined();
  });
  it("waits for long snapshot cleanup instead of failing the turn after five seconds", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      let delivered = false;
      const cleanup = new Promise<void>(resolve => { finish = resolve; });
      const delivery = deliverIntegrationEvent(() => cleanup);
      const result = expect(delivery.then(() => { delivered = true; })).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(delivered).toBe(false);
      finish();
      await result;
      expect(delivered).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("still rejects a wedged lifecycle callback at the hour-long default deadline", async () => {
    vi.useFakeTimers();
    try {
      const delivery = deliverIntegrationEvent(() => new Promise(() => {}));
      const result = expect(delivery).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
