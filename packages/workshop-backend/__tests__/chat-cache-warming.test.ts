import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import type { CachedRequest } from "../src/ai-models.js";
import { ChatCacheWarmer } from "../src/chat-cache-warming.js";

const MINUTE = 60_000;
const CHAT = 7;

function usage(cacheRead: number, cacheWrite = 0): Usage {
  return {
    input: 10, output: 1, cacheRead, cacheWrite, totalTokens: 11 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  };
}

// A request sent now that answers every resend with `answer`, as a cache hit by default. With
// Anthropic's prices (reads at a tenth of input, 5-minute writes at 1.25x), a miss of the whole
// prompt costs 11.5 reads of it.
function request(
    answer: () => Promise<Usage> = async () => usage(100_000),
    overrides: Partial<CachedRequest> = {}) {
  const resend = vi.fn(answer);
  const cached: CachedRequest = {
    sentAt: Date.now(), cacheLifetime: 5 * MINUTE, resendCost: 1, expiryCost: 11.5, resend,
    ...overrides,
  };
  return { cached, resend };
}

describe("ChatCacheWarmer", () => {
  let warmer: ChatCacheWarmer;

  beforeEach(() => {
    vi.useFakeTimers();
    warmer = new ChatCacheWarmer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends a viewed chat's request a minute before its cache would expire", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(4 * MINUTE - 1);
    expect(resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resend).toHaveBeenCalledTimes(1);
    // Each ping restarts the lifetime.
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  // A turn nobody watched, such as a callback's, keeps no timer, even if someone opens it later.
  it("doesn't warm a turn that ended with nobody viewing the chat", async () => {
    warmer.view(CHAT)();
    const { cached, resend } = request();
    warmer.start(CHAT, cached);
    warmer.view(CHAT);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops when the last viewer leaves", async () => {
    const leaveFirst = warmer.view(CHAT);
    const leaveSecond = warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached);

    // Leaving twice counts once, so the chat is still viewed.
    leaveFirst();
    leaveFirst();
    await vi.advanceTimersByTimeAsync(8 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(2);

    leaveSecond();
    // Nothing is left pending to keep the Durable Object in memory.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("stops once the pings have cost as much as the miss they avoid", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(24 * 4 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(11);
  });

  it("doesn't warm a request whose miss costs no more than one ping", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(undefined, { expiryCost: 1 });
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("doesn't warm a request whose ping would already be late", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it.each([
    { name: "writes to the cache", answer: async () => usage(0, 100_000) },
    { name: "reads nothing from the cache", answer: async () => usage(0) },
    { name: "fails", answer: async (): Promise<Usage> => { throw new Error("overloaded"); } },
  ])("stops after a ping that $name", async ({ answer }) => {
    warmer.view(CHAT);
    const { cached, resend } = request(answer);
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("stops on stop(), and when a newer request replaces the warmed one", async () => {
    warmer.view(CHAT);
    const first = request();
    warmer.start(CHAT, first.cached);
    warmer.stop(CHAT);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(first.resend).not.toHaveBeenCalled();

    const second = request();
    warmer.start(CHAT, second.cached);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const third = request();
    warmer.start(CHAT, third.cached);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(second.resend).not.toHaveBeenCalled();
    expect(third.resend).toHaveBeenCalledTimes(1);
  });

  it("drops a ping that was out when warming stopped", async () => {
    warmer.view(CHAT);
    let answer!: (usage: Usage) => void;
    const { cached, resend } = request(() => new Promise(resolve => { answer = resolve; }));
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
    warmer.stop(CHAT);
    answer(usage(100_000));
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
  });
});
