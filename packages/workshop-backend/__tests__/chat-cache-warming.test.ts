import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { CachedRequest } from "../src/ai-models.js";
import { ChatCacheWarmer } from "../src/chat-cache-warming.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const MINUTE = 60_000;
const CHAT = 7;
// When the first ping goes out after a request with a 5-minute cache.
const FIRST_PING = 4.5 * MINUTE;

// A resend's usage, costing `cost`: by default, as much as the requests below estimate.
function usage(cacheRead: number, cacheWrite = 0, cost = 1): Usage {
  return {
    input: 10, output: 1, cacheRead, cacheWrite, totalTokens: 11 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

// A request sent now that answers every resend with `answer`, as a cache hit by default. With
// Anthropic's prices (reads at a tenth of input, 5-minute writes at 1.25x), a miss of the whole
// prompt costs 11.5 reads of it.
function request(
    answer: () => Promise<Usage> = async () => usage(100_000),
    overrides: Partial<CachedRequest> = {}) {
  const resend = vi.fn(async () => ({ usage: await answer() }));
  const cached: CachedRequest = {
    sentAt: Date.now(), cacheLifetime: 5 * MINUTE, resendCost: 1, expiryCost: 11.5, resend,
    ...overrides,
  };
  return { cached, resend };
}

describe("ChatCacheWarmer", () => {
  let warmer: ChatCacheWarmer;
  let resent: ReturnType<typeof vi.fn<ConstructorParameters<typeof ChatCacheWarmer>[0]>>;

  beforeEach(() => {
    vi.useFakeTimers();
    resent = vi.fn();
    warmer = new ChatCacheWarmer(resent);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends a viewed chat's request half a minute before its cache would expire", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(FIRST_PING - 1);
    expect(resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resend).toHaveBeenCalledTimes(1);
    // Each ping restarts the lifetime.
    await vi.advanceTimersByTimeAsync(FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(2);
    expect(resent).toHaveBeenCalledTimes(2);
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
    await vi.advanceTimersByTimeAsync(2 * FIRST_PING);
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

    await vi.advanceTimersByTimeAsync(24 * FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(11);
  });

  // A ping can cost more than its estimate, e.g. if it wrote part of the prompt or answered at
  // length.
  it("counts what the pings actually cost against the miss", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(async () => usage(100_000, 0, 2));
    warmer.start(CHAT, cached);

    // After five pings costing 2, a sixth estimated at 1 still costs less than 11.5; a seventh
    // would not.
    await vi.advanceTimersByTimeAsync(24 * FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(6);
  });

  it("drops a ping whose timer fires after the cached copy expired", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached);

    // The clock moves past the expiry without the timer firing, as when the Durable Object is busy.
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops an hour after the turn", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(undefined, { cacheLifetime: 30 * MINUTE, expiryCost: 1000 });
    warmer.start(CHAT, cached);

    // Pings at 29.5 and 59 minutes; the next would come after an hour.
    await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(2);
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
    await vi.advanceTimersByTimeAsync(FIRST_PING);
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it.each([
    // The shared head is still cached, but the chat's own part had expired.
    { name: "writes to the cache", answer: async () => usage(10_000, 90_000) },
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
    await vi.advanceTimersByTimeAsync(FIRST_PING);
    expect(second.resend).not.toHaveBeenCalled();
    expect(third.resend).toHaveBeenCalledTimes(1);
  });

  it("drops a ping that was out when warming stopped, but still charges its cost", async () => {
    warmer.view(CHAT);
    let answer!: (usage: Usage) => void;
    const { cached, resend } = request(() => new Promise(resolve => { answer = resolve; }));
    warmer.start(CHAT, cached);

    await vi.advanceTimersByTimeAsync(FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(1);
    warmer.stop(CHAT);
    answer(usage(100_000));
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resent).toHaveBeenCalledExactlyOnceWith(CHAT, { usage: usage(100_000) });
  });
});

// The OverseerImpl members this test drives; the class itself is private to overseer.ts.
interface OverseerInternals {
  cacheWarmer: ChatCacheWarmer;
  storage: {
    chatMeta: { get(id: number): AiChatMetadata | undefined, put(meta: AiChatMetadata): void };
    totalCost: { get(): number };
  };
}

describe("a workspace's warm pings", () => {
  // A ping is no activity: counting it as one would move an idle open chat, and its workspace, to
  // the top of every list every few minutes.
  it("adds each ping's cost to the chat's and workspace's totals, not to its activity",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("chat-cache-warming");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: OverseerInternals }).impl;
      impl.storage.chatMeta.put(
          { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
      let workspaceCost = impl.storage.totalCost.get();

      impl.cacheWarmer.view(CHAT);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        impl.cacheWarmer.start(CHAT, request(async () => usage(100_000, 0, 0.25)).cached);
        await vi.advanceTimersByTimeAsync(2 * FIRST_PING);
      } finally {
        vi.useRealTimers();
      }

      expect(impl.storage.chatMeta.get(CHAT)).toMatchObject(
          { totalCost: 0.5, lastActive: new Date(0) });
      expect(impl.storage.totalCost.get() - workspaceCost).toBe(0.5);
    });
  });
});
