import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig,
} from "@gadgets/workshop-shared/api";
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
const WORKSPACE = "workspace";
const MODEL = "model";
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

// The log entry for a pause that ended, with `fields`.
const pauseEnded = (fields: object) =>
  expect.objectContaining({ event: "chat.cache_warm.pause.ended", ...fields });

describe("ChatCacheWarmer", () => {
  let warmer: ChatCacheWarmer;
  let resent: ReturnType<typeof vi.fn<ConstructorParameters<typeof ChatCacheWarmer>[1]>>;

  beforeEach(() => {
    vi.useFakeTimers();
    resent = vi.fn();
    warmer = new ChatCacheWarmer(WORKSPACE, resent);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends a viewed chat's request half a minute before its cache would expire", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached, MODEL);

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
    warmer.start(CHAT, cached, MODEL);
    warmer.view(CHAT);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops when the last viewer leaves", async () => {
    const leaveFirst = warmer.view(CHAT);
    const leaveSecond = warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached, MODEL);

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
    warmer.start(CHAT, cached, MODEL);

    await vi.advanceTimersByTimeAsync(24 * FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(11);
  });

  // A ping can cost more than its estimate, e.g. if it wrote part of the prompt or answered at
  // length.
  it("counts what the pings actually cost against the miss", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(async () => usage(100_000, 0, 2));
    warmer.start(CHAT, cached, MODEL);

    // After five pings costing 2, a sixth estimated at 1 still costs less than 11.5; a seventh
    // would not.
    await vi.advanceTimersByTimeAsync(24 * FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(6);
  });

  it("drops a ping whose timer fires after the cached copy expired", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    warmer.start(CHAT, cached, MODEL);

    // The clock moves past the expiry without the timer firing, as when the Durable Object is busy.
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("stops an hour after the turn", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(undefined, { cacheLifetime: 30 * MINUTE, expiryCost: 1000 });
    warmer.start(CHAT, cached, MODEL);

    // Pings at 29.5 and 59 minutes; the next would come after an hour.
    await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("doesn't warm a request whose miss costs no more than one ping", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request(undefined, { expiryCost: 1 });
    warmer.start(CHAT, cached, MODEL);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).not.toHaveBeenCalled();
  });

  it("doesn't warm a request whose ping would already be late", async () => {
    warmer.view(CHAT);
    const { cached, resend } = request();
    await vi.advanceTimersByTimeAsync(FIRST_PING);
    warmer.start(CHAT, cached, MODEL);

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
    warmer.start(CHAT, cached, MODEL);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("stops at the next turn, and when a newer request replaces the warmed one", async () => {
    warmer.view(CHAT);
    const first = request();
    warmer.start(CHAT, first.cached, MODEL);
    warmer.end(CHAT, "turn");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(first.resend).not.toHaveBeenCalled();

    const second = request();
    warmer.start(CHAT, second.cached, MODEL);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const third = request();
    warmer.start(CHAT, third.cached, MODEL);
    await vi.advanceTimersByTimeAsync(FIRST_PING);
    expect(second.resend).not.toHaveBeenCalled();
    expect(third.resend).toHaveBeenCalledTimes(1);
  });

  it("drops a ping that was out when warming stopped, but still charges its cost", async () => {
    warmer.view(CHAT);
    let answer!: (usage: Usage) => void;
    const { cached, resend } = request(() => new Promise(resolve => { answer = resolve; }));
    warmer.start(CHAT, cached, MODEL);

    await vi.advanceTimersByTimeAsync(FIRST_PING);
    expect(resend).toHaveBeenCalledTimes(1);
    warmer.end(CHAT, "turn");
    answer(usage(100_000));
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resent).toHaveBeenCalledExactlyOnceWith(CHAT, { usage: usage(100_000) });
  });

  describe("while a response streams", () => {
    it("resends its request once per cache lifetime, viewed or not, until the response ends",
        async () => {
      const leave = warmer.view(CHAT);
      const { cached, resend } = request();
      const ended = warmer.warmWhileStreaming(CHAT, cached);
      // The viewer leaving doesn't stop it: the turn's next request reads the cached copy.
      leave();

      await vi.advanceTimersByTimeAsync(FIRST_PING - 1);
      expect(resend).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resend).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FIRST_PING);
      expect(resend).toHaveBeenCalledTimes(2);
      expect(resent).toHaveBeenCalledTimes(2);
      expect(resent).toHaveBeenLastCalledWith(CHAT, { usage: usage(100_000) });

      ended();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(resend).toHaveBeenCalledTimes(2);
    });

    it("stops at the turn's next request", async () => {
      const first = request();
      warmer.warmWhileStreaming(CHAT, first.cached);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      const second = request();
      warmer.warmWhileStreaming(CHAT, second.cached);

      await vi.advanceTimersByTimeAsync(FIRST_PING);
      expect(first.resend).not.toHaveBeenCalled();
      expect(second.resend).toHaveBeenCalledTimes(1);
    });

    it("stops at the end of a turn nobody views", async () => {
      const { cached, resend } = request();
      warmer.warmWhileStreaming(CHAT, cached);
      warmer.start(CHAT, cached, MODEL);

      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(resend).not.toHaveBeenCalled();
    });

    // Without the pings, the cached copy of a response that streamed this long has expired.
    it("leaves the turn's end to warm on from the last ping", async () => {
      warmer.view(CHAT);
      const { cached, resend } = request();
      const ended = warmer.warmWhileStreaming(CHAT, cached);
      await vi.advanceTimersByTimeAsync(FIRST_PING + MINUTE);
      ended();
      warmer.start(CHAT, cached, MODEL);

      await vi.advanceTimersByTimeAsync(FIRST_PING - MINUTE - 1);
      expect(resend).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(resend).toHaveBeenCalledTimes(2);
    });

    it("leaves the turn's end to warm on from a ping still out", async () => {
      warmer.view(CHAT);
      let answer!: (usage: Usage) => void;
      const { cached, resend } = request(() => new Promise(resolve => { answer = resolve; }));
      const ended = warmer.warmWhileStreaming(CHAT, cached);
      await vi.advanceTimersByTimeAsync(FIRST_PING);
      expect(resend).toHaveBeenCalledTimes(1);
      ended();
      warmer.start(CHAT, cached, MODEL);
      answer(usage(100_000));

      await vi.advanceTimersByTimeAsync(FIRST_PING);
      expect(resend).toHaveBeenCalledTimes(2);
    });

    // The pings during the turn's last response and after the turn avoid the same miss.
    it("counts its pings against the miss the turn's end warms against", async () => {
      warmer.view(CHAT);
      const { cached, resend } = request();
      const ended = warmer.warmWhileStreaming(CHAT, cached);
      await vi.advanceTimersByTimeAsync(2 * FIRST_PING + MINUTE);
      ended();
      warmer.start(CHAT, cached, MODEL);

      await vi.advanceTimersByTimeAsync(24 * FIRST_PING);
      expect(resend).toHaveBeenCalledTimes(11);
    });
  });

  describe("logs each pause", () => {
    let logs: MockInstance<typeof console.info>;

    beforeEach(() => {
      logs = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The data that sets the warming limit includes returns after warming has stopped.
    it("from the turn's last request to the next turn, though warming stopped", async () => {
      warmer.view(CHAT);
      warmer.start(CHAT, request().cached, MODEL);

      await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
      // Warming has stopped, and the open pause keeps no timer to hold the Durable Object.
      expect(vi.getTimerCount()).toBe(0);
      expect(logs).not.toHaveBeenCalledWith(pauseEnded({}));
      warmer.end(CHAT, "turn");
      expect(logs).toHaveBeenLastCalledWith(pauseEnded({
        gadgetId: WORKSPACE, chatId: CHAT, modelId: MODEL, pauseEnd: "turn",
        durationMs: 3 * 60 * MINUTE, cacheLifetimeMs: 5 * MINUTE, resendCostUsd: 1,
        missCostUsd: 11.5,
      }));

      // Deleting the chat during its next turn doesn't log the ended pause again.
      logs.mockClear();
      warmer.end(CHAT, "deleted");
      expect(logs).not.toHaveBeenCalled();
    });

    it("once, when the last viewer leaves", async () => {
      const leaveFirst = warmer.view(CHAT);
      const leaveSecond = warmer.view(CHAT);
      warmer.start(CHAT, request().cached, MODEL);

      await vi.advanceTimersByTimeAsync(MINUTE);
      leaveFirst();
      expect(logs).not.toHaveBeenCalled();
      leaveSecond();
      leaveSecond();
      warmer.end(CHAT, "turn");
      expect(logs).toHaveBeenCalledExactlyOnceWith(
          pauseEnded({ pauseEnd: "left", durationMs: MINUTE }));
    });

    it("only after a turn that ended in a viewed chat", () => {
      warmer.start(CHAT, request().cached, MODEL);
      warmer.view(CHAT);
      warmer.end(CHAT, "turn");
      expect(logs).not.toHaveBeenCalled();
    });
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
        impl.cacheWarmer.start(CHAT, request(async () => usage(100_000, 0, 0.25)).cached, MODEL);
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

// The OverseerImpl members a test running a whole turn drives.
interface TurnInternals extends OverseerInternals {
  ownerId: string;
  users: {
    idFromString(id: string): string;
    get(id: string): {
      getChatContext(): Promise<{ profile: AiChatAuthorInfo, aiModel: TurnModel }>;
      getCloudflareGatekeeperAccount(): Promise<null>;
      consumeDailyLlmCall(): Promise<{ withinLimits: boolean }>;
      whoami(): Promise<AiChatAuthorInfo>;
      messageArrived(): Promise<void>;
    };
  };
  storage: OverseerInternals["storage"] & { chats: { put(message: AiChatMessage): void } };
  nextChatSequence(chatId: number): number;
  startAgent(chatId: number, aiModel: TurnModel, initiator: AiChatAuthorInfo,
             initiatorUserId: string): void;
  waitForAllAgentsToComplete(): Promise<void>;
}

interface TurnModel {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

// An Anthropic answer to a 100k-token prompt that wrote `cacheWrite` tokens of it to the cache and
// read the rest, as server-sent events.
function anthropicAnswer(cacheWrite: number): Uint8Array[] {
  return [
    { type: "message_start", message: {
      id: "message", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, cache_read_input_tokens: 100_000 - cacheWrite,
        cache_creation_input_tokens: cacheWrite, output_tokens: 1 },
    } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(event =>
      new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
}

describe("a turn whose response streams past its cache lifetime", () => {
  const API_URL = "https://anthropic.test";
  const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
  const TURN_MODEL: TurnModel = {
    profile: { type: "agent", id: "claude", name: "Claude" },
    config: { provider: "anthropic", model: "claude-opus-5-5", apiToken: "key", apiUrl: API_URL },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resends its request while it streams, and the turn's end warms on from that ping",
      async () => {
    // The turn's request streams its first event at once and the rest once released; resends,
    // capped at one token, answer at once from the cache.
    let released = Promise.withResolvers<void>();
    let resends = 0;
    let realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      let sent = new Request(input, init);
      if (new URL(sent.url).origin !== API_URL) return realFetch(input, init);
      let headers = { "content-type": "text/event-stream" };
      if (z.object({ max_tokens: z.literal(1) }).safeParse(await sent.json()).success) {
        resends++;
        return new Response(new Blob(anthropicAnswer(0)), { headers });
      }
      let [first, ...rest] = anthropicAnswer(10_000);
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(first);
          await released.promise;
          for (let event of rest) controller.enqueue(event);
          controller.close();
        },
      }), { headers });
    });

    let stub = env.TEST_OVERSEER.getByName(`chat-cache-warming-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: TurnInternals }).impl;
      impl.ownerId = "owner-user-do";
      impl.users = {
        idFromString: id => id,
        get: () => ({
          getChatContext: async () => ({ profile: OWNER, aiModel: TURN_MODEL }),
          getCloudflareGatekeeperAccount: async () => null,
          consumeDailyLlmCall: async () => ({ withinLimits: false }),
          whoami: async () => OWNER,
          messageArrived: async () => {},
        }),
      };
      impl.storage.chatMeta.put({ id: CHAT, title: "Chat", started: new Date(0),
        lastActive: new Date(0), activeAgent: TURN_MODEL.profile });
      impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
        timestamp: new Date(0), author: OWNER, type: "message", message: "Write a long answer." });
      let leave = impl.cacheWarmer.view(CHAT);
      // Resolves once the provider reported caching the turn's prompt.
      let streaming = Promise.withResolvers<void>();
      let warm = impl.cacheWarmer.warmWhileStreaming.bind(impl.cacheWarmer);
      vi.spyOn(impl.cacheWarmer, "warmWhileStreaming").mockImplementation((chatId, cached) => {
        streaming.resolve();
        return warm(chatId, cached);
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        impl.startAgent(CHAT, TURN_MODEL, OWNER, "owner-user-do");
        await streaming.promise;
        await vi.advanceTimersByTimeAsync(FIRST_PING - 1);
        expect(resends).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(resends).toBe(1);

        // The response ends a minute past its prompt's own cache lifetime.
        await vi.advanceTimersByTimeAsync(MINUTE);
        released.resolve();
        await impl.waitForAllAgentsToComplete();

        await vi.advanceTimersByTimeAsync(FIRST_PING - MINUTE - 1);
        expect(resends).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(resends).toBe(2);
      } finally {
        leave();
        vi.useRealTimers();
      }
    });
  });
});
