import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type { ChatHistory } from "../src/agent.js";
import type { CachedRequest } from "../src/ai-models.js";
import type { ChatCacheWarmer } from "../src/chat-cache-warming.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const API_URL = "https://anthropic.test";
const CHAT = 3;
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CLAUDE: AiChatAuthorInfo = { type: "agent", id: "claude", name: "Claude" };
const OPUS: TurnModel = {
  profile: CLAUDE,
  config: { provider: "anthropic", model: "claude-opus-5-5", apiToken: "key", apiUrl: API_URL },
};
const GPT: TurnModel = {
  profile: CLAUDE,
  config: { provider: "openai", model: "gpt-6-luna", apiToken: "key", apiUrl: API_URL },
};

interface TurnModel {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals {
  cacheWarmer: ChatCacheWarmer;
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
  storage: {
    chatMeta: {
      get(id: number): AiChatMetadata | undefined;
      put(meta: AiChatMetadata): void;
      delete(id: number): void;
    };
    chats: { put(message: AiChatMessage): void };
    activeAgents: { list(): Iterable<unknown> };
    chatCompactions: { list(): Iterable<unknown> };
    totalCost: { get(): number };
  };
  nextChatSequence(chatId: number): number;
  getChatTimestamp(): Date;
  nextChatSequencePeek(chatId: number): number;
  loadChatHistory(chatId: number): ChatHistory;
  startAgent(chatId: number, aiModel: TurnModel, initiator: AiChatAuthorInfo,
             initiatorUserId: string): void;
  waitForAllAgentsToComplete(): Promise<void>;
  destroyLiveChat(chatId: number): void;
  withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T>;
  revertChanges(chatId: number, revertFrom: number, author: AiChatAuthorInfo): Promise<void>;
}

const Body = z.looseObject({
  messages: z.array(z.unknown()).optional(),
  max_tokens: z.number().optional(),
  compaction: z.unknown().optional(),
});
type Body = z.infer<typeof Body>;

function sse(events: object[]): string {
  return events.map(event => {
    const { type } = z.object({ type: z.string() }).parse(event);
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

const messageStart = (usage: object) => ({ type: "message_start", message: {
  id: "message", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
  stop_reason: null, stop_sequence: null, usage,
} });

// The turn's answer, to a prompt it read from the cache but for its last message.
const answer = (cacheRead: number) => sse([
  messageStart({ input_tokens: 10, cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0, output_tokens: 1 }),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);

const BLOCK = { type: "compaction", content: "The user asked for an answer.", signature: "sig" };
// Anthropic's summary of a prompt it read from the cache, reported only in `usage.iterations`.
const SUMMARY_READ = 300_010;
const SUMMARY_OUTPUT = 80;
const summary = sse([
  messageStart({ input_tokens: 0, output_tokens: 0 }),
  { type: "content_block_start", index: 0, content_block: BLOCK },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "compaction" }, usage: {
    input_tokens: 0, output_tokens: 0,
    iterations: [{ type: "compaction", input_tokens: 0, cache_read_input_tokens: SUMMARY_READ,
      output_tokens: SUMMARY_OUTPUT }],
  } },
  { type: "message_stop" },
]);

// The provider: turns read `cacheRead` tokens of their prompt from the cache, and a summary
// answers once `release` is called, unless `held` is false, with a summary unless `answered` is
// what the model wrote instead.
function provider({ cacheRead = 300_000, held = false, answered = summary } = {}) {
  const turns: Body[] = [];
  const summaries: { body: Body, signal: AbortSignal | undefined }[] = [];
  const release = Promise.withResolvers<void>();
  if (!held) release.resolve();
  const summarizing = Promise.withResolvers<void>();
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Request(input, init);
    if (new URL(sent.url).origin !== API_URL) return realFetch(input, init);
    const headers = { "content-type": "text/event-stream" };
    const body = Body.parse(await sent.json());
    if (new URL(sent.url).pathname.endsWith("/responses")) {
      turns.push(body);
      return new Response(sse([{ type: "response.completed", response: {
        id: "response", status: "completed", output: [],
        usage: { input_tokens: cacheRead + 10, output_tokens: 1, total_tokens: cacheRead + 11,
          input_tokens_details: { cached_tokens: cacheRead } },
      } }]), { headers });
    }
    if (body.compaction === undefined) {
      turns.push(body);
      return new Response(answer(cacheRead), { headers });
    }
    summaries.push({ body, signal: init?.signal ?? undefined });
    summarizing.resolve();
    await release.promise;
    init?.signal?.throwIfAborted();
    return new Response(answered, { headers });
  });
  return { turns, summaries, summarizing: summarizing.promise, release: release.resolve };
}

// The idle compaction event, once logged, and its warning if it failed.
function compactionLogged(): Promise<Record<string, unknown>> {
  const logged = Promise.withResolvers<Record<string, unknown>>();
  const Logged = z.looseObject({ event: z.literal("chat.cache_warm.compaction") });
  const listen = (entry: unknown) => {
    const parsed = Logged.safeParse(entry);
    if (parsed.success) logged.resolve(parsed.data);
  };
  vi.spyOn(console, "info").mockImplementation(listen);
  vi.spyOn(console, "warn").mockImplementation(listen);
  return logged.promise;
}

type Chat = {
  impl: OverseerInternals;
  // What the turn's end handed the warmer: its last request, and what to call when warming stops.
  request: CachedRequest;
  expiring: (expiresAt: number) => void;
  // The sequence of the turn's answer.
  answered: number;
  // A turn on another message, run to its end.
  turn(text: string): Promise<void>;
};

// Runs a turn in a viewed chat with `model` and resolves with what its end handed the warmer.
// `before` seeds the chat's log before the turn's message.
async function withChat(
    fn: (chat: Chat) => Promise<void>,
    { model = OPUS, before = (_impl: OverseerInternals) => {} } = {}): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`idle-compaction-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as { impl: OverseerInternals }).impl;
    impl.ownerId = "owner-user-do";
    impl.users = {
      idFromString: id => id,
      get: () => ({
        getChatContext: async () => ({ profile: OWNER, aiModel: model }),
        getCloudflareGatekeeperAccount: async () => null,
        consumeDailyLlmCall: async () => ({ withinLimits: false }),
        whoami: async () => OWNER,
        messageArrived: async () => {},
      }),
    };
    impl.storage.chatMeta.put(
        { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    before(impl);
    const turn = async (text: string) => {
      impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
        timestamp: impl.getChatTimestamp(), author: OWNER, type: "message", message: text });
      const meta = impl.storage.chatMeta.get(CHAT);
      if (meta) impl.storage.chatMeta.put({ ...meta, activeAgent: CLAUDE });
      impl.startAgent(CHAT, model, OWNER, "owner-user-do");
      await impl.waitForAllAgentsToComplete();
    };
    const leave = impl.cacheWarmer.view(CHAT);
    const start = vi.spyOn(impl.cacheWarmer, "start");
    try {
      await turn("Answer at length.");
      const [, request, , expiring] = start.mock.calls[0] ?? [];
      if (!request || !expiring) throw new Error("The turn's end warmed no request.");
      const answered = impl.nextChatSequencePeek(CHAT) - 1;
      await fn({ impl, request, expiring, answered, turn });
    } finally {
      leave();
    }
  });
}

const inHalfAMinute = () => Date.now() + 30_000;

describe("compacting a chat as its warming stops", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("summarizes the turn's last request, keeps the answer, and charges what it used",
      async () => {
    const model = provider({ held: true });
    await withChat(async ({ impl, request, expiring, answered }) => {
      const logged = compactionLogged();
      const workspaceCost = impl.storage.totalCost.get();
      const before = impl.storage.chatMeta.get(CHAT);
      const sequence = impl.nextChatSequencePeek(CHAT);

      expiring(inHalfAMinute());
      await model.summarizing;
      // Nothing to resume after a restart: no turn is running.
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      model.release();
      const event = await logged;

      // The request is the turn's last, read from the cache, with Anthropic's summary asked of it.
      const [turn] = model.turns;
      const [{ body }] = model.summaries;
      expect(model.turns).toHaveLength(1);
      expect(body.compaction).toBeDefined();
      expect(withoutMarkers(body.messages)).toEqual(withoutMarkers(turn.messages));

      const checkpoint = impl.loadChatHistory(CHAT).checkpoint;
      expect(checkpoint).toMatchObject({ compactedTo: answered, summary: BLOCK.content });
      // The chat logged nothing and the model answered nothing.
      expect(impl.nextChatSequencePeek(CHAT)).toBe(sequence);
      // Priced from the catalog (AI Gateway logs it at no cost), and no activity.
      const cost = (SUMMARY_READ * 0.2 + SUMMARY_OUTPUT * 20) / 1e6;
      const meta = impl.storage.chatMeta.get(CHAT);
      expect((meta?.totalCost ?? 0) - (before?.totalCost ?? 0)).toBeCloseTo(cost, 8);
      expect(impl.storage.totalCost.get() - workspaceCost).toBeCloseTo(cost, 8);
      expect(meta?.lastActive).toEqual(before?.lastActive);
      expect(event).toMatchObject({ chatId: CHAT, modelId: CLAUDE.id, ownTokens: request.ownTokens,
        idleMs: expect.any(Number), costUsd: expect.closeTo(cost, 8) });
      expect(event).not.toHaveProperty("compactionSkip");
    });
  });

  // E.g. a model that answers instead of summarizing.
  it("charges a response without a summary, and publishes nothing", async () => {
    provider({ answered: answer(300_000) });
    await withChat(async ({ impl, expiring }) => {
      const logged = compactionLogged();
      const before = impl.storage.chatMeta.get(CHAT)?.totalCost ?? 0;
      expiring(inHalfAMinute());
      const event = await logged;
      const charged = (impl.storage.chatMeta.get(CHAT)?.totalCost ?? 0) - before;
      expect(charged).toBeGreaterThan(0);
      expect(event).toMatchObject({ compactionSkip: "failed", costUsd: expect.closeTo(charged, 8) });
      expect(impl.loadChatHistory(CHAT).checkpoint).toBeUndefined();
    });
  });

  it.each([
    // Within GPT's budget, which a larger prompt would compact during the turn.
    { name: "a model Anthropic can't summarize for", skip: "model", model: GPT,
      cacheRead: 220_000 },
    { name: "a chat of fewer than 200k own tokens", skip: "small", model: OPUS,
      cacheRead: 150_000 },
  ])("skips $name", async ({ skip, model, cacheRead }) => {
    const answering = provider({ cacheRead });
    await withChat(async ({ impl, expiring }) => {
      const logged = compactionLogged();
      expiring(inHalfAMinute());
      expect(await logged).toMatchObject({ compactionSkip: skip });
      expect(answering.summaries).toEqual([]);
      expect(impl.loadChatHistory(CHAT).checkpoint).toBeUndefined();
    }, { model });
  });

  it.each([
    { name: "a turn is running", skip: "busy", change: (impl: OverseerInternals) => {
      const meta = impl.storage.chatMeta.get(CHAT);
      if (meta) impl.storage.chatMeta.put({ ...meta, activeAgent: CLAUDE });
    } },
    { name: "a message followed the answer", skip: "unfinished",
      change: (impl: OverseerInternals) => {
        impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
          timestamp: impl.getChatTimestamp(), author: OWNER, type: "message", message: "And?", steered: true });
      } },
    { name: "the answer awaits a decision", skip: "unfinished",
      change: (impl: OverseerInternals) => {
        impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
          timestamp: impl.getChatTimestamp(), author: CLAUDE, type: "message", message: "",
          toolCalls: [{ toolCallId: "call", toolName: "readFile", input: { filename: "a" } }] });
      } },
  ])("skips a chat where $name", async ({ skip, change }) => {
    const answering = provider();
    await withChat(async ({ impl, expiring }) => {
      const logged = compactionLogged();
      change(impl);
      expiring(inHalfAMinute());
      expect(await logged).toMatchObject({ compactionSkip: skip });
      expect(answering.summaries).toEqual([]);
      expect(impl.loadChatHistory(CHAT).checkpoint).toBeUndefined();
    });
  });

  it("skips a chat already compacted after the answer", async () => {
    const answering = provider();
    await withChat(async ({ impl, expiring, answered }) => {
      let logged = compactionLogged();
      expiring(inHalfAMinute());
      await logged;
      vi.restoreAllMocks();
      logged = compactionLogged();
      expiring(inHalfAMinute());
      expect(await logged).toMatchObject({ compactionSkip: "cut" });
      expect(answering.summaries).toHaveLength(1);
      expect(impl.loadChatHistory(CHAT).checkpoint?.compactedTo).toBe(answered);
    });
  });

  it.each([
    { name: "wouldn't read the cached prompt", skip: "mismatch",
      prepare: (request: CachedRequest) => {
        vi.spyOn(request, "prefixes").mockReturnValue(false);
        return inHalfAMinute();
      } },
    { name: "would be sent after the cached copy expired", skip: "late",
      prepare: () => Date.now() - 1 },
  ])("sends no request that $name", async ({ skip, prepare }) => {
    const answering = provider();
    await withChat(async ({ impl, request, expiring }) => {
      const logged = compactionLogged();
      expiring(prepare(request));
      expect(await logged).toMatchObject({ compactionSkip: skip });
      expect(answering.summaries).toEqual([]);
      expect(answering.turns).toHaveLength(1);
      expect(impl.loadChatHistory(CHAT).checkpoint).toBeUndefined();
    });
  });

  // A record that starts no turn, as a draft's changes do.
  it("discards the summary after a message", async () => {
    const model = provider({ held: true });
    await withChat(async ({ impl, expiring }) => {
      const logged = compactionLogged();
      expiring(inHalfAMinute());
      await model.summarizing;
      impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
        timestamp: impl.getChatTimestamp(), author: OWNER, type: "changes", change: {} });
      model.release();
      expect(await logged).toMatchObject({ compactionSkip: "changed" });
      expect(impl.loadChatHistory(CHAT).checkpoint).toBeUndefined();
      // It was answered, so it is paid for.
      expect(impl.storage.chatMeta.get(CHAT)?.totalCost).toBeGreaterThan(0);
    });
  });

  it.each([
    { name: "the chat is deleted", change: async ({ impl }: Chat) => {
      impl.destroyLiveChat(CHAT);
      impl.storage.chatMeta.delete(CHAT);
    } },
    { name: "a turn starts", change: async ({ turn }: Chat) => turn("Thanks.") },
    { name: "the chat's changes are reverted", change: async ({ impl }: Chat) => {
      await impl.withChatLock(CHAT, () => impl.revertChanges(CHAT, 0, OWNER));
    } },
  ])("stops when $name", async ({ change }) => {
    const model = provider({ held: true });
    await withChat(async chat => {
      const logged = compactionLogged();
      chat.expiring(inHalfAMinute());
      await model.summarizing;
      await change(chat);
      expect(model.summaries[0]?.signal?.aborted).toBe(true);
      model.release();
      expect(await logged).toMatchObject({ compactionSkip: "changed" });
      expect([...chat.impl.storage.chatCompactions.list()]).toEqual([]);
    }, { before: impl => {
      // A change for the revert to undo.
      impl.storage.chats.put({ chatId: CHAT, sequence: impl.nextChatSequence(CHAT),
        timestamp: impl.getChatTimestamp(), author: OWNER, type: "changes", change: {} });
    } });
  });
});

// A request's messages without the markers that say where to cache the prompt.
const withoutMarkers = (messages: unknown): unknown =>
    JSON.parse(JSON.stringify(messages, (key, value: unknown) =>
        key === "cache_control" ? undefined : value));
