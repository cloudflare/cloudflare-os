// The capabilities a gadget holds: the account session, and the post, user, profile and List
// capabilities it hands out. Every read fetches, replays pending actions over the result, decides
// whether what it reveals is public or private to the account (plans/x-gatekeeper.md §7), and
// authorizes the observation before returning. Every write validates, then stages an action; none
// reaches X before approval.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, HookDescription } from "@gadgets/workshop-shared/gatekeeper";
import { sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import {
  escapeObservationValue, type ObservationGate, type ObservationScope,
} from "@gadgets/gatekeeper-kit/observers";
import type {
  Cursor, XAccountSession, XList, XListInfo, XPageOptions, XPost, XPostDraft, XPostInfo, XProfile,
  XSearchOptions, XTimeRangeOptions, XTimelineOptions, XUser, XUserInfo, XUserSummary,
} from "./types";
import {
  LIST_FIELDS, POST_FIELDS, USER_FIELDS, XApi, pageQuery, requireData, requirePage, xTime, type XEnvelope,
} from "./x-api";
import { MAX_THREAD_POSTS, validateDraft, validateReplyParent, type StoredDraft, type XActions } from "./x-actions";
import type { StoredIdentity } from "./x-credentials";
import { XCursor, type XPage } from "./x-cursor";
import type { XHookParams, XPostHookTarget } from "./x-hooks";
import {
  authorsUnverified, indexIncludes, isMutedStatus, mentionsProtectedAuthor, toListInfo, toPostInfo, toUserInfo,
  type WireList, type WirePost, type WireUser,
} from "./x-normalize";
import {
  meSummary, overlayFollowing, overlayList, overlayMembers, overlayMuted, overlayOwnedLists,
  overlayPost, overlayPosts, overlayUser, pendingList, pendingPost, pendingPosts, pendingTexts, withinBounds,
  type Pending, type PostOverlay,
} from "./x-simulation";
import { SNOWFLAKE, parseListRef, parsePostRef, parseUsernameRef } from "./x-urls";
import { duplicateKey } from "./x-text";

/** How long a post read stays cached. */
export const POST_TTL_MS = 5 * 60 * 1000;
/** How long a profile read stays cached. */
export const USER_TTL_MS = 60 * 60 * 1000;
/** How long a List's details stay cached. */
export const LIST_TTL_MS = 15 * 60 * 1000;
/** How long a listing's newest page stays cached, absorbing a gadget polling it. */
export const PAGE_TTL_MS = 60 * 1000;
/**
 * How old the privacy a fresh read is judged by may be: the connected account's protection, or a
 * List's. X allows 75 identity or List lookups per 15 minutes, too few to look again for every page or
 * profile, so a minute, as long as a listing page is cached.
 */
export const PRIVACY_TTL_MS = 60 * 1000;
/** Listings' default page size. */
export const DEFAULT_PAGE_SIZE = 20;
/** Listings' largest page. */
export const MAX_PAGE_SIZE = 100;
/** Longest search query X's self-serve tier accepts. */
const MAX_QUERY_LENGTH = 512;

/** The collection every owner-private read names; see `XGatekeeperImpl` for who may see it. */
export const OWNER_COLLECTION = "owner";
const OWNER: ObservationScope = { kind: "collections", ids: [OWNER_COLLECTION] };
const BASELINE: ObservationScope = { kind: "baseline" };

/** What a session may ask of the gatekeeper Durable Object. */
export type XSessionHost = {
  /**
   * The X user the connection is pinned to, as X described it within `maxAgeMs` if given (else up to a
   * day ago); one X can't describe that recently is refused.
   */
  me(options?: { maxAgeMs?: number }): Promise<StoredIdentity>;
  /** Runs a read as the connection, within its daily read limit; `reserve` is the rows expected. */
  read<T>(reserve: number, op: (api: XApi, me: StoredIdentity) => Promise<XEnvelope<T>>): Promise<XEnvelope<T>>;
  /** A cached value, partitioned by connection. */
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  /** Actions waiting for a decision, for simulation. */
  pending(): Pending;
  /** The ID X assigned a temporary ID, or the ID itself. */
  resolve(id: string): string;
  /** Allocates a temporary ID for a post or List this session creates. */
  allocate(kind: "post" | "list"): string;
  submit<K extends keyof XActions>(queue: ActionSubmitter, kind: K, payload: XActions[K]): Promise<number>;
  captureImage(bytes: Uint8Array): Promise<ActionFileReference>;
  /** Binds `hook` to the posts `params` names; see `XAccountSession.subscribeMentions()`. */
  bindHook(queue: RpcStub<ApprovalQueue>, params: XHookParams, hook: RpcStub<XPostHookTarget>,
           description: HookDescription): Promise<void>;
};

/**
 * What one capability owns: the gatekeeper host, its own approval-queue stub for staging actions,
 * and its own observation gate. A capability handed out takes duplicates, so disposing one
 * capability never disturbs another.
 */
export class SessionContext implements Disposable {
  readonly host: XSessionHost;
  readonly queue: RpcStub<ApprovalQueue>;
  readonly gate: ObservationGate;

  constructor(host: XSessionHost, queue: RpcStub<ApprovalQueue>, gate: ObservationGate) {
    this.host = host;
    this.queue = queue;
    this.gate = gate;
  }

  dup(): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), this.gate.lease());
  }

  [Symbol.dispose](): void {
    this.gate[Symbol.dispose]();
    this.queue[Symbol.dispose]();
  }
}

const isProvisional = (id: string): boolean => id.startsWith("~");

function who(user: XUserSummary): string {
  return user.username ? `@${escapeObservationValue(user.username)}` : "an X user";
}

/**
 * The rows a page asks X for: the caller's page size, raised to the endpoint's `min`, below which X
 * returns (and bills) its minimum anyway, so the read limit reserves what X will return.
 */
function pageSize(options: XPageOptions | undefined, min = 1): number {
  const size = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new Error(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return Math.max(min, size);
}

function snowflake(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!SNOWFLAKE.test(value)) throw new Error(`${name} must be an X post ID.`);
  return value;
}

/**
 * `options` with a temporary post ID among its bounds resolved, so polling on from a post that is still
 * waiting keeps working: to the ID X assigned once it is published, and until then to when it was
 * submitted, the time its pending row shows and is filtered by.
 */
async function resolveBounds<T extends XTimeRangeOptions>(ctx: SessionContext, options: T | undefined):
    Promise<T | undefined> {
  if (!options) return options;
  const { host } = ctx;
  let bounds = options;
  for (const key of ["sinceId", "untilId"] as const) {
    const id = bounds[key];
    if (id === undefined || !isProvisional(id)) continue;
    const assigned = host.resolve(id);
    if (!isProvisional(assigned)) {
      bounds = key === "sinceId" ? { ...bounds, sinceId: assigned } : { ...bounds, untilId: assigned };
      continue;
    }
    const post = pendingPost(assigned, host.pending(), await host.me(), ref => host.resolve(ref));
    if (!post) throw new Error(`${key} names no pending post; it may have been rejected.`);
    const at = post.createdAt;
    bounds = key === "sinceId"
      ? { ...bounds, sinceId: undefined, startTime: latest(bounds.startTime, new Date(at.getTime() + 1)) }
      : { ...bounds, untilId: undefined, endTime: earliest(bounds.endTime, at) };
  }
  return bounds;
}

function latest(bound: Date | undefined, other: Date): Date {
  return bound && bound > other ? bound : other;
}

function earliest(bound: Date | undefined, other: Date): Date {
  return bound && bound < other ? bound : other;
}

function timeQuery(options: XTimeRangeOptions | undefined): Record<string, string | undefined> {
  return {
    since_id: snowflake(options?.sinceId, "sinceId"),
    until_id: snowflake(options?.untilId, "untilId"),
    start_time: options?.startTime ? xTime(options.startTime) : undefined,
    end_time: options?.endTime ? xTime(options.endTime) : undefined,
  };
}

function excludeQuery(options: XTimelineOptions | undefined): Record<string, string | undefined> {
  const exclude = [options?.excludeReplies && "replies", options?.excludeReposts && "retweets"].filter(Boolean);
  return { exclude: exclude.length ? exclude.join(",") : undefined };
}

/**
 * The scope a read disclosing `posts` needs: the owner's when `restricted` -- a private source, or
 * authors whose privacy X did not report -- or when any post is a protected account's.
 */
function postScope(posts: readonly XPostInfo[], restricted = false): ObservationScope {
  return restricted || mentionsProtectedAuthor(posts) ? OWNER : BASELINE;
}

/** `post` with every author it names taken as protected. */
function withProtectedAuthors(post: XPostInfo): XPostInfo {
  return {
    ...post,
    author: { ...post.author, protected: true },
    ...(post.repostOf ? { repostOf: { ...post.repostOf, author: { ...post.repostOf.author, protected: true } } } : {}),
    ...(post.quoteOf ? { quoteOf: { ...post.quoteOf, author: { ...post.quoteOf.author, protected: true } } } : {}),
  };
}

function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** What every hook's description ends with: what enabling it allows, and what it costs. */
const HOOK_TERMS = "X bills each delivered post as a post read.";

function hookDescription(title: string, watching: string, canAct: boolean): HookDescription {
  return {
    title: sanitizeTitle(title),
    description: `Call this hook with each ${watching}, letting it read the post` +
      `${canAct ? " and queue a reply or other actions for approval" : ""}. ${HOOK_TERMS}`,
  };
}

// ---------------------------------------------------------------------------
// Listings

type PostListing = {
  request(api: XApi, me: StoredIdentity, token: string | undefined, size: number): Promise<XEnvelope<WirePost[]>>;
  overlay: PostOverlay;
  /** Whether pending posts may join the first page. */
  newestFirst: boolean;
  /** The range the listing asked X for, which pending posts must fall within too. */
  bounds?: XTimeRangeOptions;
  /**
   * Whether the source itself is private to the account, whatever its posts; asked again for each
   * page where that can change.
   */
  privateSource?: boolean | (() => Promise<boolean>);
  title: string;
  describe(count: number): string;
  /** Caches the newest page under this key, so a gadget polling it does not pay every time. */
  cacheKey?: string;
};

function postsCursor(ctx: SessionContext, size: number, listing: PostListing): Cursor<XPostInfo> {
  const gate = ctx.gate.lease();
  const { host } = ctx;
  return new XCursor<XPostInfo>({
    fetchPage: async token => {
      const me = await host.me();
      // Checked before it is cached, so a failed read is asked again rather than replayed.
      const load = () => host.read<WirePost[]>(size, (api, current) => listing.request(api, current, token, size))
        .then(requirePage);
      const envelope = token === undefined && listing.cacheKey
        ? await host.cached(`page:${listing.cacheKey}:${size}`, PAGE_TTL_MS, load)
        : await load();
      const includes = indexIncludes(envelope.includes);
      const wire = envelope.data ?? [];
      const fetched = wire.map(post => toPostInfo(post, includes));
      const items = overlayPosts(fetched, host.pending(), listing.overlay, {
        me, resolve: id => host.resolve(id), newestPage: token === undefined && listing.newestFirst,
        bounds: listing.bounds,
      });
      const privateSource = typeof listing.privateSource === "function"
        ? await listing.privateSource()
        : listing.privateSource === true;
      return {
        items,
        nextToken: envelope.meta?.next_token,
        observation: { title: listing.title, description: listing.describe(items.length) },
        scope: postScope(items, privateSource || authorsUnverified(wire, includes)),
      };
    },
    authorize: page => gate.authorize(page.observation, page.scope),
    dispose: () => gate[Symbol.dispose](),
  });
}

/** A walk over posts that exist only while pending: there is nothing on X to read yet. */
function pendingCursor(items: XPostInfo[]): Cursor<XPostInfo> {
  return new XCursor<XPostInfo>({
    fetchPage: async () => ({ items, observation: { title: "", description: "" }, scope: BASELINE }),
    // The pending posts are the session's own drafts; nothing from X is disclosed.
    authorize: async () => {},
  });
}

type UserListing = {
  request(api: XApi, me: StoredIdentity, token: string | undefined, size: number): Promise<XEnvelope<WireUser[]>>;
  /** Whether to report each user's relationship to the connected account. */
  relationship: boolean;
  overlay(users: XUserInfo[], newestPage: boolean): XUserInfo[];
  /**
   * Whether the listing is private to the account (a protected account's follow graph, a private
   * List's members), asked after each page.
   */
  privateSource(): Promise<boolean>;
  title: string;
  describe(count: number): string;
};

function usersCursor(ctx: SessionContext, size: number, listing: UserListing): Cursor<XUserInfo> {
  const gate = ctx.gate.lease();
  const { host } = ctx;
  return new XCursor<XUserInfo>({
    fetchPage: async token => {
      const me = await host.me();
      const envelope = await host.read<WireUser[]>(size, (api, current) => listing.request(api, current, token, size))
        .then(requirePage);
      const fetched = (envelope.data ?? []).map(user => toUserInfo(user, listing.relationship && user.id !== me.id));
      const items = listing.overlay(fetched, token === undefined);
      return {
        items,
        nextToken: envelope.meta?.next_token,
        observation: { title: listing.title, description: listing.describe(items.length) },
        scope: await listing.privateSource() ? OWNER : BASELINE,
      };
    },
    authorize: page => gate.authorize(page.observation, page.scope),
    dispose: () => gate[Symbol.dispose](),
  });
}

// ---------------------------------------------------------------------------
// Single reads. These authorize nothing: the method returning the data does.

/** A read post, and whether X left unsaid if an author it discloses is protected (`authorsUnverified`). */
export type PostRead = { info: XPostInfo; unverified: boolean };

/**
 * Loads one resource for the cache, refusing an answer that holds an error in its place: cached, a
 * transient one would go on being thrown for the whole TTL after X recovered. An answer with the
 * resource and partial errors beside it is kept.
 */
function resourceLoad<T>(host: XSessionHost, what: string, op: (api: XApi) => Promise<XEnvelope<T>>):
    () => Promise<XEnvelope<T>> {
  return async () => {
    const envelope = await host.read<T>(1, api => op(api));
    requireData(envelope, what);
    return envelope;
  };
}

/** A post as X has it, cached, with no pending action replayed. */
export async function fetchPost(host: XSessionHost, id: string): Promise<PostRead> {
  const envelope = await host.cached(`post:${id}`, POST_TTL_MS,
    resourceLoad(host, "post", api => api.get<WirePost>(`/2/tweets/${id}`, POST_FIELDS)));
  const post = requireData(envelope, "post");
  const includes = indexIncludes(envelope.includes);
  return { info: toPostInfo(post, includes), unverified: authorsUnverified([post], includes) };
}

/** A List as X has it, cached for up to `maxAgeMs`, with no pending action replayed. */
export async function fetchList(host: XSessionHost, id: string, maxAgeMs = LIST_TTL_MS): Promise<XListInfo> {
  const envelope = await host.cached(`list:${id}`, maxAgeMs,
    resourceLoad(host, "List", api => api.get<WireList>(`/2/lists/${id}`, LIST_FIELDS)));
  return toListInfo(requireData(envelope, "List"), indexIncludes(envelope.includes));
}

async function readPost(ctx: SessionContext, id: string): Promise<PostRead> {
  const { host } = ctx;
  const resolved = host.resolve(id);
  if (isProvisional(resolved)) {
    const pending = pendingPost(resolved, host.pending(), await host.me(), ref => host.resolve(ref));
    if (!pending) throw new Error("No pending post has this temporary ID; it may have been rejected.");
    if (!overlayPost(pending, host.pending(), ref => host.resolve(ref))) throw new Error("This post has been deleted.");
    // The account's own draft: its author is the connected account, whose privacy is known.
    return { info: pending, unverified: false };
  }
  const { info, unverified } = await fetchPost(host, resolved);
  const visible = overlayPost(info, host.pending(), ref => host.resolve(ref));
  if (!visible) throw new Error("This post has been deleted.");
  return { info: visible, unverified };
}

/** A user to look up: by handle, or by the ID X assigned them. */
export type UserTarget = { username: string } | { id: string };

/** A user's profile, cached. Authorizes nothing: the method returning it does. */
export async function readUser(host: XSessionHost, target: UserTarget): Promise<WireUser> {
  const envelope = "id" in target
    ? await host.cached(`user:${target.id}`, USER_TTL_MS,
      resourceLoad(host, "user", api => api.get<WireUser>(`/2/users/${target.id}`, USER_FIELDS)))
    : await host.cached(`username:${target.username.toLowerCase()}`, USER_TTL_MS,
      resourceLoad(host, "user", api => api.get<WireUser>(`/2/users/by/username/${target.username}`, USER_FIELDS)));
  return requireData(envelope, "user");
}

/**
 * A List with pending actions replayed, and whether reading it is private to the account: X says
 * the List is private, or a pending change makes it so. A pending change to public lifts nothing,
 * since the List stays private on X until that change is approved.
 */
async function readList(ctx: SessionContext, id: string, maxAgeMs?: number):
    Promise<{ info: XListInfo; restricted: boolean }> {
  const { host } = ctx;
  const resolved = host.resolve(id);
  if (isProvisional(resolved)) {
    const pending = pendingList(resolved, host.pending(), ref => host.resolve(ref));
    if (!pending) throw new Error("No pending List has this temporary ID; it may have been rejected.");
    return { info: pending, restricted: pending.private };
  }
  const info = await fetchList(host, resolved, maxAgeMs);
  const visible = overlayList(info, host.pending(), ref => host.resolve(ref));
  if (!visible) throw new Error("This List has been deleted.");
  return { info: visible, restricted: info.private || visible.private };
}

/**
 * Whether a page of a List's posts or members is private to the account, judged by the List as X
 * described it within `PRIVACY_TTL_MS`: the List as cached can be 15 minutes old, from before it became
 * private on X or through another binding of this connection, whose approval invalidates only its own
 * cache. One already cached as private needs no second look, and one X can't vouch for counts as
 * private, so a page already paid for is withheld rather than lost.
 */
async function pageRestricted(ctx: SessionContext, id: string): Promise<boolean> {
  try {
    return (await readList(ctx, id)).restricted || (await readList(ctx, id, PRIVACY_TTL_MS)).restricted;
  } catch {
    return true;
  }
}

/**
 * Whether the connected account is protected, which decides who may observe its follow graph and
 * home timeline: as X described it within `PRIVACY_TTL_MS`, not as the identity kept for display, which
 * can be a day old. One already known to be protected needs no second look, and one X can't vouch for
 * counts as protected.
 */
async function accountProtected(host: XSessionHost): Promise<boolean> {
  try {
    return (await host.me()).protected || (await host.me({ maxAgeMs: PRIVACY_TTL_MS })).protected;
  } catch {
    return true;
  }
}

/** Captures a draft's images for the action that will upload them once approved. */
async function storeDraft(ctx: SessionContext, draft: XPostDraft): Promise<StoredDraft> {
  const images = [];
  for (const image of draft.images ?? []) {
    images.push({
      file: await ctx.host.captureImage(image.data),
      mediaType: image.mediaType,
      ...(image.altText ? { altText: image.altText } : {}),
    });
  }
  return {
    text: draft.text ?? "",
    ...(images.length ? { images } : {}),
    ...(draft.poll ? { poll: { options: draft.poll.options, durationMinutes: draft.poll.durationMinutes } } : {}),
    ...(draft.replySettings && draft.replySettings !== "everyone" ? { replySettings: draft.replySettings } : {}),
    ...(draft.madeWithAi ? { madeWithAi: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Posts

/** Confines a capability to one conversation, by a lazily read conversation ID. */
type ConversationScope = () => Promise<string>;

@validateRpc()
export class XPostImpl extends RpcTarget implements XPost {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #scope?: ConversationScope;
  #conversation?: Promise<string>;

  constructor(ctx: SessionContext, id: string, scope?: ConversationScope) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#scope = scope;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  /** The post, confined to its scope. Authorizes nothing. */
  async #read(): Promise<PostRead> {
    const read = await readPost(this.#ctx, this.#id);
    if (this.#scope) {
      const allowed = this.#ctx.host.resolve(await this.#scope());
      if (this.#ctx.host.resolve(read.info.conversationId) !== allowed) {
        throw new Error("This post isn't part of the conversation this capability was granted for.");
      }
    }
    return read;
  }

  async #info(): Promise<XPostInfo> {
    return (await this.#read()).info;
  }

  /** This post's conversation: what `getConversationPost` confines its posts to. */
  #ownConversation(): Promise<string> {
    this.#conversation ??= this.#info().then(info => info.conversationId).catch(error => {
      this.#conversation = undefined;
      throw error;
    });
    return this.#conversation;
  }

  async getInfo(): Promise<XPostInfo> {
    const { info, unverified } = await this.#read();
    await this.#ctx.gate.authorize(
      { title: "Read an X post", description: `Read a post by ${who(info.author)}.` }, postScope([info], unverified));
    return info;
  }

  async listReplies(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options, 10);
    const bounds = await resolveBounds(this.#ctx, options);
    const query = timeQuery(bounds);
    const { host } = this.#ctx;
    if (this.#scope) await this.#info();
    const id = host.resolve(this.#id);
    if (isProvisional(id)) {
      const me = await host.me();
      return pendingCursor(pendingPosts(host.pending(), me, ref => host.resolve(ref))
        .filter(post => post.replyTo?.postId === id && withinBounds(post, bounds)));
    }
    return postsCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WirePost[]>("/2/tweets/search/recent", {
        ...POST_FIELDS, query: `in_reply_to_tweet_id:${id}`, ...query,
        ...pageQuery(size, token, { min: 10, max: 100 }, "next_token"),
      }),
      overlay: { kind: "replies", parentId: id },
      newestFirst: true,
      bounds,
      title: "Read replies to an X post",
      describe: count => `Read ${countOf(count, "reply", "replies")} to an X post.`,
    });
  }

  async listConversation(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options, 10);
    const bounds = await resolveBounds(this.#ctx, options);
    const query = timeQuery(bounds);
    const { host } = this.#ctx;
    const conversation = host.resolve(await this.#ownConversation());
    if (isProvisional(conversation)) {
      const me = await host.me();
      return pendingCursor(pendingPosts(host.pending(), me, ref => host.resolve(ref))
        .filter(post => host.resolve(post.conversationId) === conversation && withinBounds(post, bounds)));
    }
    return postsCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WirePost[]>("/2/tweets/search/recent", {
        ...POST_FIELDS, query: `conversation_id:${conversation}`, ...query,
        ...pageQuery(size, token, { min: 10, max: 100 }, "next_token"),
      }),
      overlay: { kind: "conversation", conversationId: conversation },
      newestFirst: true,
      bounds,
      title: "Read an X conversation",
      describe: count => `Read ${countOf(count, "post")} from an X conversation.`,
    });
  }

  async listQuotes(options?: XPageOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options, 10);
    if (this.#scope) await this.#info();
    const id = this.#ctx.host.resolve(this.#id);
    if (isProvisional(id)) return pendingCursor([]);
    return postsCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WirePost[]>(`/2/tweets/${id}/quote_tweets`, {
        ...POST_FIELDS, ...pageQuery(size, token, { min: 10, max: 100 }),
      }),
      overlay: { kind: "others" },
      newestFirst: false,
      title: "Read quotes of an X post",
      describe: count => `Read ${countOf(count, "post")} quoting an X post.`,
    });
  }

  getConversationPost(postId: string): XPost {
    return new XPostImpl(this.#ctx.dup(), parsePostRef(postId), () => this.#ownConversation());
  }

  async reply(draft: XPostDraft): Promise<XPost> {
    const { host } = this.#ctx;
    const parent = await this.#info();
    const me = await host.me();
    validateReplyParent(parent, me);
    validateDraft(draft, me, pendingTexts(host.pending()));
    const stored = await storeDraft(this.#ctx, draft);
    const ref = host.allocate("post");
    await host.submit(this.#ctx.queue, "reply", {
      ref,
      draft: stored,
      parent: { id: host.resolve(this.#id), info: parent },
      conversationId: parent.conversationId,
      submittedAt: Date.now(),
    });
    const conversation = parent.conversationId;
    return new XPostImpl(this.#ctx.dup(), ref, async () => conversation);
  }

  async like(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "like", { post: await this.#target(), on: true });
  }

  async unlike(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "like", { post: await this.#target(), on: false });
  }

  async repost(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "repost",
      { post: await this.#target(), on: true, submittedAt: Date.now() });
  }

  async undoRepost(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "repost",
      { post: await this.#target(), on: false, submittedAt: Date.now() });
  }

  async bookmark(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "bookmark", { post: await this.#target(), on: true });
  }

  async removeBookmark(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "bookmark", { post: await this.#target(), on: false });
  }

  async delete(): Promise<void> {
    const target = await this.#target();
    if (target.info.author.id !== (await this.#ctx.host.me()).id) {
      throw new Error("Only the connected account's own posts can be deleted.");
    }
    await this.#ctx.host.submit(this.#ctx.queue, "deletePost", { post: target });
  }

  async hide(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "hide", { post: await this.#reply(), hidden: true });
  }

  async unhide(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "hide", { post: await this.#reply(), hidden: false });
  }

  async subscribeReplies(hook: RpcStub<XPostHookTarget>): Promise<void> {
    const { id, info } = await this.#target();
    if (isProvisional(id)) throw new Error("This post can't be watched until it is published.");
    const me = await this.#ctx.host.me();
    // X reports replies only to the account's own posts.
    if (info.author.id !== me.id) throw new Error("Only replies to the connected account's own posts can be watched.");
    await this.#ctx.host.bindHook(this.#ctx.queue, { kind: "reply", postId: id, conversationId: info.conversationId },
      hook, hookDescription("Hear of replies to a post on X", `direct reply to ${info.url ?? "the post"}`, true));
  }

  /**
   * The post an action targets, read to describe it to the approver: not an observation. The
   * action keeps it, and a read simulating the action can show it (a pending repost among the
   * account's posts), so authors whose privacy X didn't report are kept as protected.
   */
  async #target(): Promise<{ id: string; info: XPostInfo }> {
    const { info, unverified } = await this.#read();
    return { id: this.#ctx.host.resolve(this.#id), info: unverified ? withProtectedAuthors(info) : info };
  }

  /**
   * The reply a hide targets. X hides replies only in a conversation the account started, and a hide
   * may be approved without anyone looking, so any other is refused here rather than fail at X unseen.
   */
  async #reply(): Promise<{ id: string; info: XPostInfo }> {
    const target = await this.#target();
    if (!target.info.replyTo) throw new Error("Only replies can be hidden.");
    const { host } = this.#ctx;
    const me = await host.me();
    const root = host.resolve(target.info.conversationId);
    // A conversation X hasn't seen yet starts with one of the account's pending posts.
    const starter = isProvisional(root) ? me.id : (await fetchPost(host, root)).info.author.id;
    if (starter !== me.id) throw new Error("Only replies in a conversation the connected account started can be hidden.");
    return target;
  }
}

// ---------------------------------------------------------------------------
// Users and profiles

async function profileInfo(ctx: SessionContext, user: WireUser, relationship: boolean): Promise<XUserInfo> {
  const me = await ctx.host.me();
  const info = toUserInfo(user, relationship && user.id !== me.id);
  return overlayUser(info, ctx.host.pending());
}

async function profilePosts(ctx: SessionContext, user: WireUser, options: XTimelineOptions | undefined):
    Promise<Cursor<XPostInfo>> {
  const size = pageSize(options, 5);
  const me = await ctx.host.me();
  const mine = user.id === me.id;
  const bounds = await resolveBounds(ctx, options);
  const query = { ...timeQuery(bounds), ...excludeQuery(options) };
  const name = user.username ? `@${escapeObservationValue(user.username)}` : "an X user";
  return postsCursor(ctx, size, {
    request: (api, _me, token) => api.get<WirePost[]>(`/2/users/${user.id}/tweets`, {
      ...POST_FIELDS, ...query, ...pageQuery(size, token, { min: 5, max: 100 }),
    }),
    overlay: mine
      ? { kind: "mine", excludeReplies: options?.excludeReplies, excludeReposts: options?.excludeReposts }
      : { kind: "others" },
    newestFirst: true,
    bounds,
    title: `Read ${name}'s X posts`,
    describe: count => `Read ${countOf(count, "post")} by ${name}.`,
    cacheKey: `posts:${user.id}:${JSON.stringify(query)}`,
  });
}

/** Resolves the user a profile capability names. */
type UserResolver = () => Promise<WireUser>;

@validateRpc()
export class XProfileImpl extends RpcTarget implements XProfile {
  readonly #ctx: SessionContext;
  readonly #resolve: UserResolver;

  constructor(ctx: SessionContext, resolve: UserResolver) {
    super();
    this.#ctx = ctx;
    this.#resolve = resolve;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async getInfo(): Promise<XUserInfo> {
    const info = await profileInfo(this.#ctx, await this.#resolve(), false);
    await this.#ctx.gate.authorize(
      { title: "Read an X profile", description: `Read the profile of ${who(info)}.` }, BASELINE);
    return info;
  }

  async listPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>> {
    return await profilePosts(this.#ctx, await this.#resolve(), options);
  }

  async subscribePosts(hook: RpcStub<XPostHookTarget>): Promise<void> {
    await subscribeToPosts(this.#ctx, await this.#resolve(), hook, false);
  }
}

/** Binds `hook` to `user`'s posts; only an account binding's events carry a capability to act. */
async function subscribeToPosts(ctx: SessionContext, user: WireUser, hook: RpcStub<XPostHookTarget>,
                                canAct: boolean): Promise<void> {
  if (user.id === (await ctx.host.me()).id) {
    throw new Error("The connected account's own posts can't be watched: a hook would hear of the posts it made.");
  }
  const name = user.username ? `@${user.username}` : "an X user";
  await ctx.host.bindHook(ctx.queue, { kind: "post", userId: user.id }, hook,
    hookDescription(`Hear of new posts by ${name} on X`, `post ${name} publishes`, canAct));
}

@validateRpc()
export class XUserImpl extends RpcTarget implements XUser {
  readonly #ctx: SessionContext;
  readonly #target: UserTarget;

  constructor(ctx: SessionContext, target: UserTarget) {
    super();
    this.#ctx = ctx;
    this.#target = target;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async getInfo(): Promise<XUserInfo> {
    const info = await profileInfo(this.#ctx, await readUser(this.#ctx.host, this.#target), true);
    // The relationship is one edge of the connected account's follow graph, which is private to it
    // when it is protected, as `listFollowing` and `listFollowers` treat the whole graph.
    const restricted = info.relationship !== undefined && await accountProtected(this.#ctx.host);
    await this.#ctx.gate.authorize(
      { title: "Read an X profile", description: `Read the profile of ${who(info)}.` }, restricted ? OWNER : BASELINE);
    return info;
  }

  async listPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>> {
    return await profilePosts(this.#ctx, await readUser(this.#ctx.host, this.#target), options);
  }

  async subscribePosts(hook: RpcStub<XPostHookTarget>): Promise<void> {
    await subscribeToPosts(this.#ctx, await readUser(this.#ctx.host, this.#target), hook, true);
  }

  async isMuted(): Promise<boolean> {
    const user = await readUser(this.#ctx.host, this.#target);
    const muted = overlayMuted(isMutedStatus(user), this.#ctx.host.pending(), user.id);
    // Whom the account mutes is private to it.
    await this.#ctx.gate.authorize({
      title: "Check whether an X account is muted",
      description: `Checked whether ${who(toUserInfo(user, false))} is muted.`,
    }, OWNER);
    return muted;
  }

  async follow(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "follow", { user: await this.#info(), on: true });
  }

  async unfollow(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "follow", { user: await this.#info(), on: false });
  }

  async mute(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "mute", { user: await this.#info(), on: true });
  }

  async unmute(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "mute", { user: await this.#info(), on: false });
  }

  /** The user an action targets, read to describe it to the approver: not an observation. */
  /** The user an action targets, with its relationship, which a pending follow's row keeps. */
  async #info(): Promise<XUserInfo> {
    const user = await readUser(this.#ctx.host, this.#target);
    if (user.id === (await this.#ctx.host.me()).id) throw new Error("That is the connected account itself.");
    return toUserInfo(user, true);
  }
}

// ---------------------------------------------------------------------------
// Lists

/** X's limits on a List's name and description. */
const MAX_LIST_NAME = 25;
const MAX_LIST_DESCRIPTION = 100;

function validateListFields(changes: { name?: string; description?: string }): void {
  if (changes.name !== undefined && (changes.name.trim().length < 1 || changes.name.length > MAX_LIST_NAME)) {
    throw new Error(`A List name must be 1 to ${MAX_LIST_NAME} characters.`);
  }
  if (changes.description !== undefined && changes.description.length > MAX_LIST_DESCRIPTION) {
    throw new Error(`A List description must be at most ${MAX_LIST_DESCRIPTION} characters.`);
  }
}

@validateRpc()
export class XListImpl extends RpcTarget implements XList {
  readonly #ctx: SessionContext;
  readonly #id: string;

  constructor(ctx: SessionContext, id: string) {
    super();
    this.#ctx = ctx;
    this.#id = id;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async getInfo(): Promise<XListInfo> {
    const { info, restricted } = await readList(this.#ctx, this.#id);
    await this.#ctx.gate.authorize({
      title: "Read an X List",
      description: `Read the List "${escapeObservationValue(info.name)}".`,
    }, restricted ? OWNER : BASELINE);
    return info;
  }

  async listPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options);
    const { info: list } = await readList(this.#ctx, this.#id);
    const id = this.#ctx.host.resolve(this.#id);
    if (isProvisional(id)) return pendingCursor([]);
    const name = escapeObservationValue(list.name);
    return postsCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WirePost[]>(`/2/lists/${id}/tweets`, {
        ...POST_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      overlay: { kind: "others" },
      newestFirst: false,
      // For each page: a cursor can outlive the List being public.
      privateSource: () => pageRestricted(this.#ctx, id),
      title: "Read an X List's posts",
      describe: count => `Read ${countOf(count, "post")} from the List "${name}".`,
      cacheKey: `list-posts:${id}`,
    });
  }

  async listMembers(options?: XPageOptions): Promise<Cursor<XUserInfo>> {
    const size = pageSize(options);
    const { info: list } = await readList(this.#ctx, this.#id);
    const id = this.#ctx.host.resolve(this.#id);
    const name = escapeObservationValue(list.name);
    const { host } = this.#ctx;
    if (isProvisional(id)) {
      // The List isn't on X yet, but the profiles of the members pending actions add were read from it.
      const added = overlayMembers([], host.pending(), id, ref => host.resolve(ref), true);
      const gate = this.#ctx.gate.lease();
      return new XCursor<XUserInfo>({
        fetchPage: async () => ({
          items: added,
          observation: { title: "Read an X List's members", description: `Read ${countOf(added.length, "member")} of the List "${name}".` },
          scope: list.private ? OWNER : BASELINE,
        }),
        authorize: page => gate.authorize(page.observation, page.scope),
        dispose: () => gate[Symbol.dispose](),
      });
    }
    return usersCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WireUser[]>(`/2/lists/${id}/members`, {
        ...USER_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      relationship: false,
      overlay: (users, newestPage) => overlayMembers(users, host.pending(), id, ref => host.resolve(ref), newestPage),
      // For each page: a cursor can outlive the List being public.
      privateSource: () => pageRestricted(this.#ctx, id),
      title: "Read an X List's members",
      describe: count => `Read ${countOf(count, "member")} of the List "${name}".`,
    });
  }

  async addMember(username: string): Promise<void> {
    await this.#member(username, true);
  }

  async removeMember(username: string): Promise<void> {
    await this.#member(username, false);
  }

  async update(changes: { name?: string; description?: string; private?: boolean }): Promise<void> {
    validateListFields(changes);
    const picked = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.private !== undefined ? { private: changes.private } : {}),
    };
    if (Object.keys(picked).length === 0) throw new Error("Nothing to change: pass a name, description, or private.");
    await this.#ctx.host.submit(this.#ctx.queue, "updateList", { list: await this.#owned(), changes: picked });
  }

  async delete(): Promise<void> {
    await this.#ctx.host.submit(this.#ctx.queue, "deleteList", { list: await this.#owned() });
  }

  async #member(username: string, add: boolean): Promise<void> {
    const list = await this.#owned();
    const user = await readUser(this.#ctx.host, { username: parseUsernameRef(username) });
    await this.#ctx.host.submit(this.#ctx.queue, "listMember", { list, user: toUserInfo(user, false), add });
  }

  /** The List an action targets, which the connected account must own: not an observation. */
  async #owned(): Promise<{ id: string; info: XListInfo }> {
    const { info } = await readList(this.#ctx, this.#id);
    if (info.owner.id !== (await this.#ctx.host.me()).id) {
      throw new Error("Only Lists the connected account owns can be changed.");
    }
    return { id: this.#ctx.host.resolve(this.#id), info };
  }
}

// ---------------------------------------------------------------------------
// The account

@validateRpc()
export class XAccountSessionImpl extends RpcTarget implements XAccountSession {
  readonly #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async getProfile(): Promise<XUserInfo> {
    const me = await this.#ctx.host.me();
    const info = toUserInfo(await readUser(this.#ctx.host, { id: me.id }), false);
    await this.#ctx.gate.authorize({ title: "Read the connected X profile", description: `Read ${who(info)}'s profile.` },
      BASELINE);
    return info;
  }

  async listHomeTimeline(options?: XTimelineOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options);
    const bounds = await resolveBounds(this.#ctx, options);
    const query = { ...timeQuery(bounds), ...excludeQuery(options) };
    return postsCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WirePost[]>(`/2/users/${me.id}/timelines/reverse_chronological`, {
        ...POST_FIELDS, ...query, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      overlay: { kind: "others" },
      newestFirst: true,
      bounds,
      // Whose posts it shows is whom the account follows, private to a protected account.
      privateSource: () => accountProtected(this.#ctx.host),
      title: "Read the X home timeline",
      describe: count => `Read ${countOf(count, "post")} from the home timeline.`,
      cacheKey: `home:${JSON.stringify(query)}`,
    });
  }

  async listMentions(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options, 5);
    const bounds = await resolveBounds(this.#ctx, options);
    const query = timeQuery(bounds);
    return postsCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WirePost[]>(`/2/users/${me.id}/mentions`, {
        ...POST_FIELDS, ...query, ...pageQuery(size, token, { min: 5, max: 100 }),
      }),
      overlay: { kind: "others" },
      newestFirst: true,
      bounds,
      title: "Read X mentions",
      describe: count => `Read ${countOf(count, "post")} mentioning the connected account.`,
      cacheKey: `mentions:${JSON.stringify(query)}`,
    });
  }

  async listMyPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>> {
    const me = await this.#ctx.host.me();
    return await profilePosts(this.#ctx, await readUser(this.#ctx.host, { id: me.id }), options);
  }

  async searchPosts(query: string, options?: XSearchOptions): Promise<Cursor<XPostInfo>> {
    if (typeof query !== "string" || query.trim() === "") throw new Error("A search query is required.");
    if (query.length > MAX_QUERY_LENGTH) throw new Error(`A search query must be at most ${MAX_QUERY_LENGTH} characters.`);
    const size = pageSize(options, 10);
    const sortOrder = options?.sortOrder;
    if (sortOrder !== undefined && sortOrder !== "recency" && sortOrder !== "relevancy") {
      throw new Error('sortOrder must be "recency" or "relevancy".');
    }
    const range = timeQuery(await resolveBounds(this.#ctx, options));
    const shown = escapeObservationValue(query.length > 120 ? `${query.slice(0, 117)}...` : query);
    return postsCursor(this.#ctx, size, {
      request: (api, _me, token) => api.get<WirePost[]>("/2/tweets/search/recent", {
        ...POST_FIELDS, query, ...range, ...(sortOrder ? { sort_order: sortOrder } : {}),
        ...pageQuery(size, token, { min: 10, max: 100 }, "next_token"),
      }),
      overlay: { kind: "others" },
      newestFirst: false,
      title: "Search X posts",
      describe: count => `Searched X for "${shown}" and read ${countOf(count, "post")}.`,
    });
  }

  async listBookmarks(options?: XPageOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options);
    return postsCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WirePost[]>(`/2/users/${me.id}/bookmarks`, {
        ...POST_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      overlay: { kind: "bookmarks" },
      newestFirst: true,
      // Bookmarks are private to the account.
      privateSource: true,
      title: "Read X bookmarks",
      describe: count => `Read ${countOf(count, "bookmarked post")}.`,
    });
  }

  async listLikedPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>> {
    const size = pageSize(options, 5);
    return postsCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WirePost[]>(`/2/users/${me.id}/liked_tweets`, {
        ...POST_FIELDS, ...pageQuery(size, token, { min: 5, max: 100 }),
      }),
      overlay: { kind: "liked" },
      newestFirst: true,
      // X has made likes private to the account that made them.
      privateSource: true,
      title: "Read X likes",
      describe: count => `Read ${countOf(count, "liked post")}.`,
    });
  }

  async listFollowing(options?: XPageOptions): Promise<Cursor<XUserInfo>> {
    const size = pageSize(options);
    const { host } = this.#ctx;
    return usersCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WireUser[]>(`/2/users/${me.id}/following`, {
        ...USER_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      relationship: true,
      overlay: (users, newestPage) => overlayFollowing(users, host.pending(), newestPage),
      // A protected account's follow graph is visible only to its approved followers.
      privateSource: () => accountProtected(this.#ctx.host),
      title: "Read the accounts the connected account follows",
      describe: count => `Read ${countOf(count, "followed account")}.`,
    });
  }

  async listFollowers(options?: XPageOptions): Promise<Cursor<XUserInfo>> {
    const size = pageSize(options);
    return usersCursor(this.#ctx, size, {
      request: (api, me, token) => api.get<WireUser[]>(`/2/users/${me.id}/followers`, {
        ...USER_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
      }),
      relationship: true,
      // A follow-back gadget re-listing its followers sees the follows it has already staged.
      overlay: users => users.map(user => overlayUser(user, this.#ctx.host.pending())),
      privateSource: () => accountProtected(this.#ctx.host),
      title: "Read the connected account's followers",
      describe: count => `Read ${countOf(count, "follower")}.`,
    });
  }

  async listOwnedLists(options?: XPageOptions): Promise<Cursor<XListInfo>> {
    const size = pageSize(options);
    const { host } = this.#ctx;
    const gate = this.#ctx.gate.lease();
    return new XCursor<XListInfo>({
      fetchPage: async token => {
        const envelope = await host.read<WireList[]>(size, (api, me) => api.get<WireList[]>(`/2/users/${me.id}/owned_lists`, {
          ...LIST_FIELDS, ...pageQuery(size, token, { min: 1, max: 100 }),
        })).then(requirePage);
        const includes = indexIncludes(envelope.includes);
        const fetched = (envelope.data ?? []).map(list => toListInfo(list, includes));
        const items = overlayOwnedLists(fetched, host.pending(), ref => host.resolve(ref), token === undefined);
        return {
          items,
          nextToken: envelope.meta?.next_token,
          observation: { title: "List owned X Lists", description: `Read ${countOf(items.length, "owned List")}.` },
          // As `readList`: what X says is private stays so, whatever a pending change would make it.
          scope: [...fetched, ...items].some(list => list.private) ? OWNER : BASELINE,
        } satisfies XPage<XListInfo>;
      },
      authorize: page => gate.authorize(page.observation, page.scope),
      dispose: () => gate[Symbol.dispose](),
    });
  }

  getPost(idOrUrl: string): XPost {
    return new XPostImpl(this.#ctx.dup(), parsePostRef(idOrUrl));
  }

  getUser(usernameOrUrl: string): XUser {
    return new XUserImpl(this.#ctx.dup(), { username: parseUsernameRef(usernameOrUrl) });
  }

  getUserById(userId: string): XUser {
    if (!SNOWFLAKE.test(userId)) throw new Error("Expected a numeric X user ID.");
    return new XUserImpl(this.#ctx.dup(), { id: userId });
  }

  getList(idOrUrl: string): XList {
    return new XListImpl(this.#ctx.dup(), parseListRef(idOrUrl));
  }

  async createPost(draft: XPostDraft): Promise<XPost> {
    const [created] = await this.#publish([draft]);
    return created;
  }

  async createThread(drafts: XPostDraft[]): Promise<XPost[]> {
    if (!Array.isArray(drafts) || drafts.length === 0) throw new Error("A thread needs at least one post.");
    if (drafts.length > MAX_THREAD_POSTS) throw new Error(`A thread can hold at most ${MAX_THREAD_POSTS} posts.`);
    return await this.#publish(drafts);
  }

  async createList(name: string, options?: { description?: string; private?: boolean }): Promise<XList> {
    validateListFields({ name, description: options?.description });
    const { host } = this.#ctx;
    const me = await host.me();
    const ref = host.allocate("list");
    await host.submit(this.#ctx.queue, "createList", {
      ref,
      name,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.private ? { private: true } : {}),
      owner: meSummary(me),
      submittedAt: Date.now(),
    });
    return new XListImpl(this.#ctx.dup(), ref);
  }

  async subscribeMentions(hook: RpcStub<XPostHookTarget>): Promise<void> {
    const me = await this.#ctx.host.me();
    await this.#ctx.host.bindHook(this.#ctx.queue, { kind: "mention" }, hook,
      hookDescription(`Hear of posts mentioning @${me.username} on X`, `post that mentions @${me.username}`, true));
  }

  async subscribeReplies(hook: RpcStub<XPostHookTarget>): Promise<void> {
    const me = await this.#ctx.host.me();
    await this.#ctx.host.bindHook(this.#ctx.queue, { kind: "reply" }, hook,
      hookDescription(`Hear of replies to @${me.username}'s posts on X`, `direct reply to a post by @${me.username}`, true));
  }

  async #publish(drafts: XPostDraft[]): Promise<XPost[]> {
    const { host } = this.#ctx;
    const me = await host.me();
    const taken = pendingTexts(host.pending());
    for (const draft of drafts) {
      validateDraft(draft, me, taken);
      if (draft.text?.trim()) taken.add(duplicateKey(draft.text));
    }
    const stored: StoredDraft[] = [];
    for (const draft of drafts) stored.push(await storeDraft(this.#ctx, draft));
    const refs = stored.map(() => host.allocate("post"));
    await host.submit(this.#ctx.queue, "createPost", { refs, drafts: stored, submittedAt: Date.now() });
    return refs.map(ref => new XPostImpl(this.#ctx.dup(), ref));
  }
}
