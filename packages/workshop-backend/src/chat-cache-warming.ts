import type { CachedRequest, Resent } from "./ai-models.js";
import { createWorkshopLogger, type WorkshopObservabilityFields } from "./observability.js";

const logger = createWorkshopLogger("workshop.cache-warming");

// How long before a cached prompt would expire its ping goes out, leaving room for timer and
// network delays.
const PING_LEAD_MS = 30_000;

// No ping is due later than this after the turn's last request. A user who hasn't replied by
// then has likely left the tab open, and warming would only spend toward its cost cap.
const WARMING_LIMIT_MS = 60 * 60_000;

type Warming = {
  request: CachedRequest;
  // When the latest request that read the cache (the turn's, then each ping) was sent.
  sentAt: number;
  // What the pings have cost so far, in dollars.
  spent: number;
  timer?: ReturnType<typeof setTimeout>;
  // Whether a ping is out, whose answer schedules the next.
  pinging?: boolean;
};

// A viewed chat's wait for its next turn after a turn ends, logged when it ends to learn how long
// users stay away. It keeps the turn's model and what warming costs, not its request, so a pause
// that outlives its warming holds no prompt in memory.
type Pause = Pick<CachedRequest, "sentAt" | "cacheLifetime" | "resendCost" | "expiryCost"> & {
  modelId: string;
};

// How a pause ended: the chat's next turn started, its last viewer left, a revert changed what
// the next turn will send, or the chat was deleted.
type PauseEnd = WorkshopObservabilityFields["pauseEnd"];

type ChatViewers = {
  count: number;
  pause?: Pause;
  warming?: Warming;
};

/**
 * Keeps the model provider's cache of a chat's last request warm while someone views the chat,
 * so the user's next message reads the conversation from the cache instead of paying to write it
 * again.
 *
 * When a turn ends in a viewed chat, its last request is sent again, with the smallest response
 * cap, shortly before the cached copy would expire, and again after each such ping. Warming stops
 * when the last viewer leaves, an hour after the turn, before a ping could take the pings past
 * what the cache miss they avoid costs, when a ping's timer fires after the cached copy expired,
 * when a ping fails or finds the cache gone, and on end(). The viewers' open connections keep
 * the Durable Object in memory meanwhile. Warming is held in memory only, like the request it
 * resends, so a restart ends it.
 *
 * A request whose response is still streaming is kept cached the same way, viewed or not, so that
 * a response outliving the cached copy doesn't make the turn's next request write it again.
 *
 * Each pause after such a turn is logged when it ends, with how long it lasted and what a ping and
 * a miss cost, to show how long warming should run.
 */
export class ChatCacheWarmer {
  // The chats someone views now.
  #chats = new Map<number, ChatViewers>();
  // The warming of each chat's request whose response is streaming.
  #streams = new Map<number, Warming>();
  // The warming each request had while its response streamed, which start() carries on.
  #streamed = new WeakMap<CachedRequest, Warming>();
  readonly #logger: typeof logger;
  readonly #onResent: (chatId: number, resent: Resent) => void;

  /**
   * `gadgetId` names the workspace in the logs. `onResent` receives each ping the provider
   * answered, to add its cost to the chat's.
   */
  constructor(gadgetId: string, onResent: (chatId: number, resent: Resent) => void) {
    this.#logger = logger.with({gadgetId});
    this.#onResent = onResent;
  }

  /** Records that a client shows `chatId` until the returned function is called. */
  view(chatId: number): () => void {
    let chat = this.#chats.get(chatId);
    if (!chat) {
      chat = {count: 0};
      this.#chats.set(chatId, chat);
    }
    chat.count++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--chat.count > 0) return;
      this.end(chatId, "left");
      this.#chats.delete(chatId);
    };
  }

  /**
   * Starts keeping `request`'s prompt cached while someone views `chatId`, replacing any earlier
   * warming. Called when a turn ends, with its last request and the turn's model.
   */
  start(chatId: number, request: CachedRequest, modelId: string): void {
    this.#stop(chatId, this.#chats.get(chatId)?.warming);
    this.#stop(chatId, this.#streams.get(chatId));
    let chat = this.#chats.get(chatId);
    // A turn that ended with nobody viewing the chat, such as a callback's, isn't warmed.
    if (!chat) return;
    let {sentAt, cacheLifetime, resendCost, expiryCost} = request;
    chat.pause = {modelId, sentAt, cacheLifetime, resendCost, expiryCost};
    // Carries on the warming the request had while its response streamed: its last ping is when
    // the prompt was last read, and its pings count against the same miss.
    chat.warming = this.#streamed.get(request) ?? {request, sentAt, spent: 0};
    if (!chat.warming.pinging) this.#schedule(chatId, chat.warming);
  }

  /**
   * Keeps `request`'s prompt cached while its response streams, whether or not anyone views
   * `chatId`, replacing the warming of the chat's previous request. Called once the provider
   * reports caching the prompt; the returned function is called when the response ends.
   */
  warmWhileStreaming(chatId: number, request: CachedRequest): () => void {
    this.#stop(chatId, this.#streams.get(chatId));
    let warming: Warming = {request, sentAt: request.sentAt, spent: 0};
    this.#streams.set(chatId, warming);
    this.#streamed.set(request, warming);
    this.#schedule(chatId, warming);
    return () => {
      // Not once start() carried it on.
      if (this.#streams.get(chatId) === warming) this.#stop(chatId, warming);
    };
  }

  /**
   * Ends `chatId`'s pause and its warming, logging how long the pause lasted. Called when the
   * chat's next turn starts, a revert changes what that turn will send, or the chat is deleted.
   */
  end(chatId: number, reason: PauseEnd): void {
    this.#stop(chatId, this.#chats.get(chatId)?.warming);
    let chat = this.#chats.get(chatId);
    let pause = chat?.pause;
    if (!chat || !pause) return;
    chat.pause = undefined;
    this.#logger.info("chat pause ended", {
      event: "chat.cache_warm.pause.ended", chatId, modelId: pause.modelId, pauseEnd: reason,
      durationMs: Date.now() - pause.sentAt, cacheLifetimeMs: pause.cacheLifetime,
      resendCostUsd: pause.resendCost, missCostUsd: pause.expiryCost,
    });
  }

  // Stops `warming` if it still keeps `chatId`'s cache warm.
  #stop(chatId: number, warming: Warming | undefined) {
    let chat = this.#chats.get(chatId);
    if (warming && chat?.warming === warming) chat.warming = undefined;
    else if (warming && this.#streams.get(chatId) === warming) this.#streams.delete(chatId);
    else return;
    clearTimeout(warming.timer);
  }

  // Schedules the next ping, unless the cached copy would expire first, the ping would come after
  // the warming limit, or it could take the pings past what the cache miss they avoid costs.
  #schedule(chatId: number, warming: Warming) {
    let due = expiry(warming) - PING_LEAD_MS;
    if (due <= Date.now() || due > warming.request.sentAt + WARMING_LIMIT_MS ||
        !worthPinging(warming)) {
      return this.#stop(chatId, warming);
    }
    warming.timer = setTimeout(() => void this.#ping(chatId, warming), due - Date.now());
  }

  async #ping(chatId: number, warming: Warming) {
    // A timer delayed past the lead, e.g. while the Durable Object was busy, would pay for a
    // write of the whole prompt.
    if (Date.now() >= expiry(warming)) return this.#stop(chatId, warming);
    let streaming = this.#streams.get(chatId) === warming;
    let sentAt = Date.now();
    let resent: Resent;
    warming.pinging = true;
    try {
      resent = await warming.request.resend();
    } catch (error) {
      this.#logger.warn("cache warm ping failed",
          {event: "chat.cache_warm.failed", chatId, streaming, error});
      return this.#stop(chatId, warming);
    } finally {
      warming.pinging = false;
    }
    let {usage} = resent;
    warming.spent += usage.cost.total;
    this.#logger.info("cache warm ping", {
      event: "chat.cache_warm.ping", chatId, streaming, costUsd: usage.cost.total,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    });
    // Charged even if warming stopped while the ping was out.
    this.#onResent(chatId, resent);
    // A ping that read nothing found no cached copy to keep, and one that wrote found it expired
    // or changed.
    if (usage.cacheRead === 0 || usage.cacheWrite > 0) return this.#stop(chatId, warming);
    // Kept even if warming stopped while the ping was out: start() may carry it on.
    warming.sentAt = sentAt;
    if (this.#chats.get(chatId)?.warming === warming || this.#streams.get(chatId) === warming) {
      this.#schedule(chatId, warming);
    }
  }
}

// When the provider would drop the cached copy, counted from the start of the latest request
// that read it.
const expiry = (warming: Warming) => warming.sentAt + warming.request.cacheLifetime;

// Ski rental: whether the pings so far and one more still cost less than the cache miss they
// avoid. So warming costs less than one miss, and if the user replies, less than twice what the
// best choice in hindsight would have.
const worthPinging = (warming: Warming) =>
  warming.spent + warming.request.resendCost < warming.request.expiryCost;
