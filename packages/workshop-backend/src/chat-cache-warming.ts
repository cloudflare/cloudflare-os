import type { Usage } from "@earendil-works/pi-ai";
import type { CachedRequest } from "./ai-models.js";
import { createWorkshopLogger, type WorkshopObservabilityFields } from "./observability.js";

const logger = createWorkshopLogger("workshop.cache-warming");

// How long before a cached prompt would expire its ping goes out, leaving room for timer and
// network delays.
const PING_LEAD_MS = 60_000;

type Warming = {
  request: CachedRequest;
  // When the latest request that read the cache (the turn's, then each ping) was sent, and how
  // many prompt tokens it had.
  sentAt: number;
  promptTokens: number;
  pings: number;
  cost: number;
  timer?: ReturnType<typeof setTimeout>;
};

type ChatViewers = {
  count: number;
  warming?: Warming;
};

type StopReason = WorkshopObservabilityFields["cacheWarmStop"];

/**
 * Keeps the model provider's cache of a chat's last request warm while someone views the chat,
 * so the user's next message reads the conversation from the cache instead of paying to write it
 * again.
 *
 * When a turn ends in a viewed chat, its last request is sent again, with the smallest response
 * cap, shortly before the cached copy would expire, and again after each such ping. Warming stops
 * when the last viewer leaves, once the pings have cost as much as the one cache miss they can
 * save, when a ping fails or finds the cache gone, and on stop(). The viewers' open connections
 * keep the Durable Object in memory meanwhile. Warming is held in memory only, like the request
 * it resends, so a restart ends it.
 */
export class ChatCacheWarmer {
  // The chats someone views now.
  #chats = new Map<number, ChatViewers>();

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
      chat.count--;
      if (chat.count > 0) return;
      if (chat.warming) this.#end(chatId, chat, chat.warming, "unviewed");
      this.#chats.delete(chatId);
    };
  }

  /**
   * Starts keeping `request`'s prompt cached while someone views `chatId`, replacing any earlier
   * warming. Called when a turn ends, with its last request and that request's token count.
   */
  start(chatId: number, request: CachedRequest, promptTokens: number): void {
    this.stop(chatId);
    let chat = this.#chats.get(chatId);
    let {cacheRead, cacheWrite} = request.prices;
    // Without a viewer there is nobody to warm for, a request already too old has no cache left
    // to keep, and prices without cheaper reads (or with none, as for models the catalog doesn't
    // price) leave nothing to save.
    if (!chat || pingDue(request, request.sentAt) <= Date.now() ||
        cacheRead <= 0 || cacheWrite <= cacheRead) {
      return;
    }
    let warming: Warming = {request, sentAt: request.sentAt, promptTokens, pings: 0, cost: 0};
    chat.warming = warming;
    this.#schedule(chatId, warming);
  }

  /** Stops warming `chatId`: its next turn caches a new request, or the chat is gone. */
  stop(chatId: number): void {
    let chat = this.#chats.get(chatId);
    if (chat?.warming) this.#end(chatId, chat, chat.warming, "stopped");
  }

  #schedule(chatId: number, warming: Warming) {
    warming.timer = setTimeout(() => void this.#ping(chatId, warming),
        pingDue(warming.request, warming.sentAt) - Date.now());
  }

  async #ping(chatId: number, warming: Warming) {
    let chat = this.#chats.get(chatId);
    if (chat?.warming !== warming) return;
    if (!worthPinging(warming)) return this.#end(chatId, chat, warming, "budget");

    let sentAt = Date.now();
    let usage: Usage;
    try {
      usage = await warming.request.resend();
    } catch (error) {
      if (chat.warming === warming) this.#end(chatId, chat, warming, "failed", error);
      return;
    }
    warming.pings++;
    warming.cost += usage.cost.total;
    logger.info("cache warm ping", {
      event: "chat.cache_warm.ping", chatId, costUsd: usage.cost.total,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    });
    // Stopped while the ping was out.
    if (chat.warming !== warming) return;
    // A write means the cached copy had already expired, or no longer matches the request.
    if (usage.cacheWrite > 0) return this.#end(chatId, chat, warming, "missed");

    warming.sentAt = sentAt;
    warming.promptTokens = usage.input + usage.cacheRead;
    this.#schedule(chatId, warming);
  }

  #end(chatId: number, chat: ChatViewers, warming: Warming, reason: StopReason, error?: unknown) {
    clearTimeout(warming.timer);
    chat.warming = undefined;
    let fields = {
      event: "chat.cache_warm.ended", chatId, cacheWarmStop: reason,
      pingCount: warming.pings, costUsd: warming.cost,
    };
    if (reason === "failed") {
      logger.warn("cache warm ping failed", {...fields, error});
    } else if (warming.pings > 0) {
      logger.info("cache warming ended", fields);
    }
  }
}

// When the ping after a request sent at `sentAt` is due.
function pingDue(request: CachedRequest, sentAt: number): number {
  return sentAt + request.cacheLifetime - PING_LEAD_MS;
}

// Ski rental: whether one more ping keeps all of warming's pings within what the cache miss they
// avoid would cost. Each ping reads the whole prompt, while a miss writes only the chat's own part
// again: the shared head is cached apart from it (for an hour on Anthropic) and every chat of the
// kind reads it. Stopping there means warming never costs more than twice what the best choice in
// hindsight would have.
function worthPinging({request, promptTokens, pings}: Warming): boolean {
  let {cacheRead, cacheWrite} = request.prices;
  let own = Math.max(promptTokens - request.sharedTokens, 0);
  return (pings + 1) * cacheRead * promptTokens <= (cacheWrite - cacheRead) * own;
}
