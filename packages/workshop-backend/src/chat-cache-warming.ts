import type { CachedRequest, Resent } from "./ai-models.js";
import { createWorkshopLogger } from "./observability.js";

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
 * when the last viewer leaves, an hour after the turn, before a ping could take the pings past
 * what the cache miss they avoid costs, when a ping's timer fires after the cached copy expired,
 * when a ping fails or finds the cache gone, and on stop(). The viewers' open connections keep
 * the Durable Object in memory meanwhile. Warming is held in memory only, like the request it
 * resends, so a restart ends it.
 */
export class ChatCacheWarmer {
  // The chats someone views now.
  #chats = new Map<number, ChatViewers>();
  readonly #onResent: (chatId: number, resent: Resent) => void;

  /** `onResent` receives each ping the provider answered, to add its cost to the chat's. */
  constructor(onResent: (chatId: number, resent: Resent) => void) {
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
    // A turn that ended with nobody viewing the chat, such as a callback's, isn't warmed.
    if (!chat) return;
    chat.warming = {request, sentAt: request.sentAt, spent: 0};
    this.#schedule(chatId, chat.warming);
  }

  /**
   * Stops warming `chatId`: its next turn caches a new request, a revert changed what that turn
   * will send, or the chat is gone.
   */
  stop(chatId: number): void {
    let chat = this.#chats.get(chatId);
    if (!chat?.warming) return;
    clearTimeout(chat.warming.timer);
    chat.warming = undefined;
  }

  // Schedules the next ping, unless the cached copy would expire first, the ping would come after
  // the warming limit, or it could take the pings past what the cache miss they avoid costs.
  #schedule(chatId: number, warming: Warming) {
    let due = expiry(warming) - PING_LEAD_MS;
    if (due <= Date.now() || due > warming.request.sentAt + WARMING_LIMIT_MS ||
        !worthPinging(warming)) {
      return this.stop(chatId);
    }
    warming.timer = setTimeout(() => void this.#ping(chatId, warming), due - Date.now());
  }

  async #ping(chatId: number, warming: Warming) {
    // A timer delayed past the lead, e.g. while the Durable Object was busy, would pay for a
    // write of the whole prompt.
    if (Date.now() >= expiry(warming)) return this.stop(chatId);
    let current = () => this.#chats.get(chatId)?.warming === warming;
    let sentAt = Date.now();
    let resent: Resent;
    try {
      resent = await warming.request.resend();
    } catch (error) {
      logger.warn("cache warm ping failed", {event: "chat.cache_warm.failed", chatId, error});
      if (current()) this.stop(chatId);
      return;
    }
    let {usage} = resent;
    warming.spent += usage.cost.total;
    logger.info("cache warm ping", {
      event: "chat.cache_warm.ping", chatId, costUsd: usage.cost.total,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    });
    // Charged even if warming stopped while the ping was out.
    this.#onResent(chatId, resent);
    if (!current()) return;
    // A ping that read nothing found no cached copy to keep, and one that wrote found it expired
    // or changed.
    if (usage.cacheRead === 0 || usage.cacheWrite > 0) return this.stop(chatId);
    warming.sentAt = sentAt;
    this.#schedule(chatId, warming);
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
