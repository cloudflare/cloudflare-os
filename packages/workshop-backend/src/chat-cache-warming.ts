import type { Usage } from "@earendil-works/pi-ai";
import type { CachedRequest } from "./ai-models.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.cache-warming");

// How long before a cached prompt would expire its ping goes out, leaving room for timer and
// network delays.
const PING_LEAD_MS = 60_000;

type Warming = {
  request: CachedRequest;
  // When the latest request that read the cache (the turn's, then each ping) was sent.
  sentAt: number;
  pings: number;
  timer?: ReturnType<typeof setTimeout>;
};

type ChatViewers = {
  count: number;
  warming?: Warming;
};

/**
 * Keeps the model provider's cache of a chat's last request warm while someone views the chat,
 * so the user's next message reads the conversation from the cache instead of paying to write it
 * again.
 *
 * When a turn ends in a viewed chat, its last request is sent again, with the smallest response
 * cap, shortly before the cached copy would expire, and again after each such ping. Warming stops
 * when the last viewer leaves, before a ping would take the pings past what the cache miss they
 * avoid costs, when a ping fails or finds the cache gone, and on stop(). The viewers' open
 * connections keep the Durable Object in memory meanwhile. Warming is held in memory only, like
 * the request it resends, so a restart ends it.
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
      if (--chat.count > 0) return;
      this.stop(chatId);
      this.#chats.delete(chatId);
    };
  }

  /**
   * Starts keeping `request`'s prompt cached while someone views `chatId`, replacing any earlier
   * warming. Called when a turn ends, with its last request.
   */
  start(chatId: number, request: CachedRequest): void {
    this.stop(chatId);
    let chat = this.#chats.get(chatId);
    // Nobody views the chat, the first ping would come after the cache expired, or even one ping
    // would cost more than the miss it avoids.
    if (!chat || pingDue(request, request.sentAt) <= Date.now() || !worthPinging(request, 0)) {
      return;
    }
    let warming: Warming = {request, sentAt: request.sentAt, pings: 0};
    chat.warming = warming;
    this.#schedule(chatId, warming);
  }

  /** Stops warming `chatId`: its next turn caches a new request, or the chat is gone. */
  stop(chatId: number): void {
    let chat = this.#chats.get(chatId);
    if (!chat?.warming) return;
    clearTimeout(chat.warming.timer);
    chat.warming = undefined;
  }

  #schedule(chatId: number, warming: Warming) {
    warming.timer = setTimeout(() => void this.#ping(chatId, warming),
        pingDue(warming.request, warming.sentAt) - Date.now());
  }

  async #ping(chatId: number, warming: Warming) {
    let current = () => this.#chats.get(chatId)?.warming === warming;
    let sentAt = Date.now();
    let usage: Usage;
    try {
      usage = await warming.request.resend();
    } catch (error) {
      logger.warn("cache warm ping failed", {event: "chat.cache_warm.failed", chatId, error});
      if (current()) this.stop(chatId);
      return;
    }
    warming.pings++;
    logger.info("cache warm ping", {
      event: "chat.cache_warm.ping", chatId, costUsd: usage.cost.total,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    });
    if (!current()) return;
    // A write means the cached copy had already expired, or no longer matches the request.
    if (usage.cacheWrite > 0 || !worthPinging(warming.request, warming.pings)) {
      return this.stop(chatId);
    }
    warming.sentAt = sentAt;
    this.#schedule(chatId, warming);
  }
}

// When the ping after a request sent at `sentAt` is due.
function pingDue(request: CachedRequest, sentAt: number): number {
  return sentAt + request.cacheLifetime - PING_LEAD_MS;
}

// Ski rental: whether `pings` pings and one more still cost less than the cache miss they avoid.
// So warming costs less than one miss, and if the user replies, less than twice what the best
// choice in hindsight would have.
function worthPinging(request: CachedRequest, pings: number): boolean {
  return (pings + 1) * request.resendCost < request.expiryCost;
}
