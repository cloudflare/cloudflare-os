// X, faked at the `fetch` boundary for the workerd suites. Installed with `vi.stubGlobal`, which
// reaches the gatekeeper because the whole suite -- test file, TestHooks, and the Durable Objects --
// runs in one isolate. The fake keeps state: tokens name users, a created post is visible to the
// reads that follow (reconciliation depends on that), and likes, follows and the rest are recorded
// as X would hold them. A test injects a failure with `on()`, whose routes answer before the
// built-in ones, latest first. Anything unrouted, or sent anywhere but X, fails the test.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { StoredIdentity } from "../../src/x-credentials";
import { getRedirectUri, scopesFor, type Env } from "../../src/x-env";
import type { WireList, WirePost, WireUser } from "../../src/x-normalize";
import { extractUrls } from "../../src/x-text";

type WireLink = NonNullable<NonNullable<WirePost["entities"]>["urls"]>[number];

export const API = "https://api.x.com";

export type FakeRequest = { method: string; url: URL; headers: Headers; body?: string; form?: FormData };
type Handler = (request: FakeRequest) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

function problem(status: number, detail: string, type = "about:blank"): Response {
  return json({ title: "Problem", detail, type, status }, { status });
}

/** The app-only bearer token, `X_APP_BEARER_TOKEN` in vitest.worker.config.ts. */
export const APP_TOKEN = "test-app-token";

/** The event types only the filtered user's own token may subscribe to. */
const PRIVATE_EVENTS = new Set(["post.mention.create", "post.reply.create"]);

export type FakeSubscription = {
  subscription_id: string; event_type: string; filter: { user_id?: string }; webhook_id?: string; tag?: string;
  /** Who made it: "app", or the user whose token did. */
  by: string;
};

export const ALICE: WireUser = {
  id: "1001", username: "alice", name: "Alice", verified: false, protected: false,
  public_metrics: { followers_count: 10, following_count: 5, tweet_count: 3, listed_count: 0 },
};
export const BOB: WireUser = { id: "1002", username: "bob", name: "Bob", protected: false };
export const CAROL: WireUser = { id: "1003", username: "carol", name: "Carol", protected: true };

export class FakeX {
  readonly requests: FakeRequest[] = [];
  readonly users = new Map<string, WireUser>([[ALICE.id, ALICE], [BOB.id, BOB], [CAROL.id, CAROL]]);
  readonly posts = new Map<string, WirePost>();
  readonly lists = new Map<string, WireList>();
  readonly listMembers = new Map<string, Set<string>>();
  /** Which user each access token belongs to. */
  readonly tokens = new Map<string, string>();
  /** Which user each authorization code authorizes. */
  readonly codes = new Map<string, string>();
  /** Refresh tokens already redeemed or revoked. */
  readonly spentRefreshTokens = new Set<string>();
  readonly revoked: string[] = [];
  /** `user:target` pairs. */
  readonly likes = new Set<string>();
  readonly reposts = new Set<string>();
  readonly bookmarks = new Set<string>();
  readonly following = new Set<string>();
  readonly muting = new Set<string>();
  readonly hidden = new Set<string>();
  readonly media = new Map<string, { type: string; altText?: string }>();
  /** The app's webhooks, by ID. */
  readonly webhooks = new Map<string, { id: string; url: string; valid: boolean }>();
  /** The app's X Activity API subscriptions, by ID. */
  readonly subscriptions = new Map<string, FakeSubscription>();
  /** Each published post's text as sent, before its links were shortened: what duplicates compare. */
  readonly #sentTexts = new Map<string, string>();
  #nextId = 1_900_000_000_000_000_000n;
  #nextGrant = 100;
  #nextLink = 1;
  #routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  install(): this {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
    return this;
  }

  /** Answers before the built-in routes; return `undefined` to fall through to them. */
  on(method: string, pattern: RegExp, handler: Handler): this {
    this.#routes.unshift({ method, pattern, handler });
    return this;
  }

  /** Acts on the next matching request as X would, then loses the answer, as a reset connection does. */
  loseAnswer(method: string, pattern: RegExp): this {
    let lost = false;
    return this.on(method, pattern, request => {
      if (lost) return undefined;
      lost = true;
      this.#builtIn(request);
      throw new TypeError("connection reset");
    });
  }

  /** How many recorded requests match. */
  count(method: string, pattern: RegExp): number {
    return this.requests.filter(r => r.method === method && pattern.test(r.url.pathname + r.url.search)).length;
  }

  /** A fresh ID, as X issues them. */
  id(): string {
    return String(this.#nextId++);
  }

  /**
   * Delivers one event to the registered webhook, as X does: the X Activity API's envelope, signed
   * with the app's client secret. Returns the status the worker answered.
   */
  async deliver(eventType: string, userId: string | undefined, payload: unknown, options: {
    id?: string; createdAt?: string; includes?: unknown; secret?: string;
  } = {}): Promise<number> {
    const [webhook] = this.webhooks.values();
    if (!webhook) throw new Error("fake X: no webhook is registered");
    const body = JSON.stringify({
      data: {
        event_uuid: options.id ?? this.id(),
        created_at: options.createdAt ?? new Date().toISOString(),
        filter: userId === undefined ? {} : { user_id: userId },
        event_type: eventType,
        payload,
        ...(options.includes === undefined ? {} : { includes: options.includes }),
      },
    });
    const signature = await hmacBase64(options.secret ?? "test-client-secret", body);
    const response = await SELF.fetch(webhook.url, {
      method: "POST", body, headers: { "X-Twitter-Webhooks-Signature-OAuth2": `sha256=${signature}` },
    });
    return response.status;
  }

  /** Mints a token for `userId`, as a code exchange or refresh would. */
  grant(userId: string): { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string } {
    const n = this.#nextGrant++;
    this.tokens.set(`access-${n}`, userId);
    this.tokens.set(`refresh-${n}`, userId);
    return {
      access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 7200, token_type: "bearer",
      scope: "tweet.read users.read offline.access tweet.write like.read like.write bookmark.read bookmark.write " +
        "follows.read follows.write mute.write list.read list.write media.write tweet.moderate.write",
    };
  }

  /** Adds a post by `author`. */
  post(author: WireUser, text: string, extra: Partial<WirePost> = {}): WirePost {
    const id = extra.id ?? this.id();
    const post: WirePost = {
      id, text, author_id: author.id, conversation_id: id, created_at: new Date().toISOString(), ...extra,
    };
    this.posts.set(id, post);
    return post;
  }

  async #handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== API) throw new Error(`fake X: ${request.method} ${url} was not sent to ${API}`);
    if (request.redirect !== "manual" && !url.pathname.startsWith("/2/oauth2/")) {
      throw new Error(`fake X: ${request.method} ${url} would follow redirects`);
    }
    const recorded: FakeRequest = { method: request.method, url, headers: new Headers(request.headers) };
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      recorded.form = await request.formData();
    } else if (request.body) {
      recorded.body = new TextDecoder().decode(await request.arrayBuffer());
    }
    this.requests.push(recorded);
    for (const route of this.#routes) {
      if (route.method === request.method && route.pattern.test(url.pathname + url.search)) {
        const answer = await route.handler(recorded);
        if (answer) return answer;
      }
    }
    return this.#builtIn(recorded);
  }

  #builtIn(request: FakeRequest): Response {
    const { method, url } = request;
    const path = url.pathname;
    if (path === "/2/oauth2/token") return this.#token(request);
    if (path === "/2/oauth2/revoke") {
      const token = new URLSearchParams(request.body).get("token")!;
      this.revoked.push(token);
      this.spentRefreshTokens.add(token);
      this.tokens.delete(token);
      return json({ revoked: true });
    }

    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    let match: RegExpMatchArray | null;
    const body = () => JSON.parse(request.body ?? "{}") as Record<string, unknown>;

    if (path === "/2/webhooks" || path.startsWith("/2/webhooks/")) {
      if (token !== APP_TOKEN) return problem(403, "This endpoint requires an OAuth2 app-only bearer token.");
      const id = path.split("/")[3];
      if (method === "GET" && !id) return json({ data: [...this.webhooks.values()] });
      if (method === "POST" && !id) {
        const webhook = { id: this.id(), url: String(body().url), valid: true };
        this.webhooks.set(webhook.id, webhook);
        return json({ data: webhook });
      }
      const webhook = this.webhooks.get(id ?? "");
      if (!webhook) return problem(404, "Webhook not found");
      if (method === "PUT") {
        webhook.valid = true;
        return json({ data: { valid: true } });
      }
      if (method === "DELETE") {
        this.webhooks.delete(webhook.id);
        return json({ data: { deleted: true } });
      }
    }
    if (path === "/2/activity/subscriptions" || path.startsWith("/2/activity/subscriptions/")) {
      const caller = token === APP_TOKEN ? "app" : this.tokens.get(token);
      if (caller === undefined) return problem(401, "Unauthorized");
      const id = path.split("/")[4];
      if (method === "POST" && !id) {
        const { event_type: eventType, filter = {}, webhook_id: webhookId, tag } =
          body() as { event_type: string; filter?: { user_id?: string }; webhook_id?: string; tag?: string };
        if (PRIVATE_EVENTS.has(eventType) && caller !== filter.user_id) {
          return problem(403, "Private events need the filtered user's own authorization.");
        }
        if ([...this.subscriptions.values()].some(existing =>
            existing.event_type === eventType && existing.filter.user_id === filter.user_id)) {
          return json({ title: "DuplicateSubscription", detail: "A matching subscription already exists.", type: "about:blank" },
            { status: 409 });
        }
        const subscription: FakeSubscription = {
          subscription_id: this.id(), event_type: eventType, filter, webhook_id: webhookId, tag, by: caller,
        };
        this.subscriptions.set(subscription.subscription_id, subscription);
        const { by: _by, ...echoed } = subscription;
        return json({ data: { subscription: echoed } });
      }
      if (caller !== "app") return problem(403, "This endpoint requires an OAuth2 app-only bearer token.");
      if (method === "GET" && !id) return json({ data: [...this.subscriptions.values()] });
      if (method === "DELETE" && id) {
        if (!this.subscriptions.delete(id)) return problem(404, "Subscription not found");
        return json({ data: { deleted: true } });
      }
    }

    const me = this.tokens.get(token);
    if (me === undefined) return problem(401, "Unauthorized");

    if (method === "GET" && path === "/2/users/me") return json({ data: this.users.get(me) });
    if (method === "GET" && (match = path.match(/^\/2\/users\/by\/username\/(\w+)$/))) {
      const user = [...this.users.values()].find(candidate => candidate.username?.toLowerCase() === match![1].toLowerCase());
      return user ? json({ data: this.#withStatus(me, user) }) : this.#notFound("user", match[1]);
    }
    if (method === "GET" && (match = path.match(/^\/2\/tweets\/(\d+)$/))) {
      const post = this.posts.get(match[1]);
      if (!post || !this.#visible(me, post)) return this.#notFound("tweet", match[1]);
      return json({ data: post, ...this.#includes(url, [post]) });
    }
    if (method === "GET" && (match = path.match(/^\/2\/lists\/(\d+)$/))) {
      const list = this.lists.get(match[1]);
      if (!list || (list.private && list.owner_id !== me)) return this.#notFound("list", match[1]);
      return json({ data: list, ...(this.#expands(url, "owner_id") ? { includes: { users: [this.users.get(list.owner_id ?? "")].filter(Boolean) } } : {}) });
    }
    if (method === "GET" && (match = path.match(/^\/2\/users\/(\d+)$/))) {
      const user = this.users.get(match[1]);
      return user ? json({ data: this.#withStatus(me, user) }) : this.#notFound("user", match[1]);
    }
    if (method === "GET" && (match = path.match(/^\/2\/users\/(\d+)\/(tweets|mentions|bookmarks|liked_tweets|timelines\/reverse_chronological)$/))) {
      const [, userId, kind] = match;
      const since = Date.parse(url.searchParams.get("start_time") ?? "");
      const until = Date.parse(url.searchParams.get("end_time") ?? "");
      const posts = [...this.posts.values()].filter(post => {
        const created = Date.parse(post.created_at ?? "");
        if (created < since || created > until) return false;
        switch (kind) {
          case "tweets": return post.author_id === userId;
          case "mentions": return post.text?.includes(`@${this.users.get(userId)?.username}`) ?? false;
          case "bookmarks": return this.bookmarks.has(`${userId}:${post.id}`);
          case "liked_tweets": return this.likes.has(`${userId}:${post.id}`);
          default: return post.author_id !== userId && this.#visible(me, post);
        }
      });
      return this.#page(url, posts.toReversed(), "pagination_token", items => this.#includes(url, items).includes);
    }
    if (method === "GET" && path === "/2/tweets/search/recent") {
      const query = url.searchParams.get("query") ?? "";
      const replyTo = query.match(/^in_reply_to_tweet_id:(\d+)$/)?.[1];
      const conversation = query.match(/^conversation_id:(\d+)$/)?.[1];
      const posts = [...this.posts.values()].filter(post => this.#visible(me, post) && (
        replyTo ? (post.referenced_tweets ?? []).some(ref => ref.type === "replied_to" && ref.id === replyTo)
          : conversation ? post.conversation_id === conversation
            : post.text?.toLowerCase().includes(query.toLowerCase())));
      return this.#page(url, posts.toReversed(), "next_token", items => this.#includes(url, items).includes);
    }
    if (method === "GET" && (match = path.match(/^\/2\/users\/(\d+)\/(following|followers)$/))) {
      const [, userId, kind] = match;
      const ids = [...this.following].map(pair => pair.split(":"))
        .filter(([from, to]) => kind === "following" ? from === userId : to === userId)
        .map(([from, to]) => kind === "following" ? to : from);
      return this.#page(url, ids.flatMap(id => this.users.get(id) ?? []).map(user => this.#withStatus(me, user)), "pagination_token");
    }
    if (method === "GET" && (match = path.match(/^\/2\/users\/(\d+)\/owned_lists$/))) {
      const lists = [...this.lists.values()].filter(list => list.owner_id === match![1]);
      return this.#page(url, lists, "pagination_token",
        () => this.#expands(url, "owner_id") ? { users: [this.users.get(match![1])] } : undefined);
    }
    if (method === "GET" && (match = path.match(/^\/2\/lists\/(\d+)\/members$/))) {
      const members = [...this.listMembers.get(match[1]) ?? []].flatMap(id => this.users.get(id) ?? []);
      return this.#page(url, members, "pagination_token");
    }
    if (method === "GET" && (match = path.match(/^\/2\/lists\/(\d+)\/tweets$/))) {
      const members = this.listMembers.get(match[1]) ?? new Set<string>();
      const posts = [...this.posts.values()].filter(post => members.has(post.author_id ?? ""));
      return this.#page(url, posts.toReversed(), "pagination_token", items => this.#includes(url, items).includes);
    }

    // Writes, as the connected user.
    if (method === "POST" && path === "/2/tweets") {
      const { text, reply, media } = body() as { text: string; reply?: { in_reply_to_tweet_id: string }; media?: { media_ids: string[] } };
      const recent = [...this.posts.values()]
        .find(post => post.author_id === me && (this.#sentTexts.get(post.id) ?? post.text) === text);
      if (recent && text) return problem(403, "You are not allowed to create a Tweet with duplicate content.");
      const parent = reply ? this.posts.get(reply.in_reply_to_tweet_id) : undefined;
      if (reply && !parent) return problem(400, "The Tweet you are replying to has been deleted.");
      const author = this.users.get(me)!;
      const id = this.id();
      const shortened = this.#shorten(text, `https://x.com/${author.username}/status/${id}/photo/1`, media?.media_ids);
      const post = this.post(author, shortened.text, {
        id,
        ...(parent ? {
          conversation_id: parent.conversation_id, in_reply_to_user_id: parent.author_id,
          referenced_tweets: [{ type: "replied_to", id: parent.id }],
        } : {}),
        ...(media ? { attachments: { media_keys: media.media_ids.map(mediaId => `3_${mediaId}`) } } : {}),
        ...(shortened.urls.length ? { entities: { urls: shortened.urls } } : {}),
      });
      this.#sentTexts.set(id, text);
      return json({ data: { id: post.id, text: post.text } }, { status: 201 });
    }
    if (method === "DELETE" && (match = path.match(/^\/2\/tweets\/(\d+)$/))) {
      const post = this.posts.get(match[1]);
      if (!post) return problem(404, "Not found");
      if (post.author_id !== me) return problem(403, "You can only delete your own posts.");
      this.posts.delete(match[1]);
      return json({ data: { deleted: true } });
    }
    if (method === "PUT" && (match = path.match(/^\/2\/tweets\/(\d+)\/hidden$/))) {
      const key = match[1];
      if (body().hidden) this.hidden.add(key); else this.hidden.delete(key);
      return json({ data: { hidden: body().hidden } });
    }
    const toggles: Record<string, [Set<string>, string]> = {
      likes: [this.likes, "tweet_id"], retweets: [this.reposts, "tweet_id"], bookmarks: [this.bookmarks, "tweet_id"],
      following: [this.following, "target_user_id"], muting: [this.muting, "target_user_id"],
    };
    if ((match = path.match(/^\/2\/users\/(\d+)\/(likes|retweets|bookmarks|following|muting)(?:\/(\d+))?$/))) {
      const [, userId, kind, target] = match;
      if (userId !== me) return problem(403, "You can only act as yourself.");
      const [set, field] = toggles[kind];
      if (method === "POST") {
        const id = String(body()[field]);
        if (field === "tweet_id" && !this.posts.has(id)) return problem(400, "The post was deleted.");
        set.add(`${me}:${id}`);
        return json({ data: { [kind]: true } });
      }
      if (method === "DELETE" && target) {
        set.delete(`${me}:${target}`);
        return json({ data: { [kind]: false } });
      }
    }
    if (method === "POST" && path === "/2/lists") {
      const { name, description, private: isPrivate } = body() as { name: string; description?: string; private?: boolean };
      const id = this.id();
      this.lists.set(id, {
        id, name, description: description ?? "", private: isPrivate === true, owner_id: me, member_count: 0, follower_count: 0,
        created_at: new Date().toISOString(),
      });
      return json({ data: { id, name } });
    }
    if ((match = path.match(/^\/2\/lists\/(\d+)$/))) {
      const list = this.lists.get(match[1]);
      if (!list || list.owner_id !== me) return problem(404, "Not found");
      if (method === "PUT") {
        Object.assign(list, body());
        return json({ data: { updated: true } });
      }
      if (method === "DELETE") {
        this.lists.delete(match[1]);
        return json({ data: { deleted: true } });
      }
    }
    if ((match = path.match(/^\/2\/lists\/(\d+)\/members(?:\/(\d+))?$/))) {
      const members = this.listMembers.get(match[1]) ?? new Set<string>();
      this.listMembers.set(match[1], members);
      if (method === "POST") members.add(String(body().user_id));
      else if (method === "DELETE" && match[2]) members.delete(match[2]);
      return json({ data: { is_member: method === "POST" } });
    }
    if (method === "POST" && path === "/2/media/upload") {
      const id = this.id();
      this.media.set(id, { type: (request.form?.get("media") as Blob | null)?.type ?? "" });
      return json({ data: { id, media_key: `3_${id}` } });
    }
    if (method === "POST" && path === "/2/media/metadata") {
      const { id, metadata } = body() as { id: string; metadata: { alt_text: { text: string } } };
      const item = this.media.get(id);
      if (item) item.altText = metadata.alt_text.text;
      return json({ data: { associated_metadata: true } });
    }
    throw new Error(`fake X: unrouted ${method} ${url}`);
  }

  #token(request: FakeRequest): Response {
    if (request.headers.get("authorization") !== `Basic ${btoa("test-client-id:test-client-secret")}`) {
      return json({ error: "invalid_client" }, { status: 401 });
    }
    const form = new URLSearchParams(request.body);
    if (form.get("grant_type") === "authorization_code") {
      const user = this.codes.get(form.get("code") ?? "");
      if (!user || !form.get("code_verifier")) return json({ error: "invalid_grant" }, { status: 400 });
      this.codes.delete(form.get("code")!);
      return json(this.grant(user));
    }
    const refreshToken = form.get("refresh_token") ?? "";
    const user = this.tokens.get(refreshToken);
    if (!user || this.spentRefreshTokens.has(refreshToken)) {
      return json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 });
    }
    this.spentRefreshTokens.add(refreshToken);
    return json(this.grant(user));
  }

  /**
   * A post's text as X keeps it: each link replaced by a t.co link and listed in `entities.urls`
   * as written (a bare domain gaining `http://`), and attached media given a t.co link of its own.
   */
  #shorten(text: string, mediaUrl: string, mediaIds: string[] = []): { text: string; urls: WireLink[] } {
    const urls: WireLink[] = [];
    let shortened = text;
    for (const url of extractUrls(text)) {
      const short = `https://t.co/${this.#nextLink++}`;
      shortened = shortened.replace(url, short);
      urls.push({ url: short, expanded_url: /^https?:\/\//i.test(url) ? url : `http://${url}` });
    }
    if (mediaIds.length > 0) {
      const short = `https://t.co/${this.#nextLink++}`;
      shortened = `${shortened} ${short}`.trim();
      urls.push({ url: short, expanded_url: mediaUrl, media_key: `3_${mediaIds[0]}` });
    }
    return { text: shortened, urls };
  }

  #visible(viewer: string, post: WirePost): boolean {
    const author = this.users.get(post.author_id ?? "");
    return !author?.protected || author.id === viewer || this.following.has(`${viewer}:${author.id}`);
  }

  #withStatus(viewer: string, user: WireUser): WireUser {
    const status = [
      ...this.following.has(`${viewer}:${user.id}`) ? ["following"] : [],
      ...this.following.has(`${user.id}:${viewer}`) ? ["followed_by"] : [],
      ...this.muting.has(`${viewer}:${user.id}`) ? ["muting"] : [],
    ];
    return { ...user, connection_status: status };
  }

  /** Whether the request asked X to expand `field`; X includes nothing it was not asked for. */
  #expands(url: URL, field: string): boolean {
    return (url.searchParams.get("expansions") ?? "").split(",").includes(field);
  }

  #includes(url: URL, posts: WirePost[]): { includes?: { users: WireUser[] } } {
    if (!this.#expands(url, "author_id")) return {};
    const authors = new Set(posts.map(post => post.author_id));
    return { includes: { users: [...authors].flatMap(id => this.users.get(id ?? "") ?? []) } };
  }

  #notFound(type: string, id: string): Response {
    return json({
      errors: [{ resource_id: id, resource_type: type, type: "https://api.twitter.com/2/problems/resource-not-found", detail: "Not found" }],
    });
  }

  #page<T>(url: URL, items: T[], tokenParam: string, includes?: (items: T[]) => unknown): Response {
    const size = Number(url.searchParams.get("max_results") ?? "10");
    const start = Number(url.searchParams.get(tokenParam) ?? "0");
    const page = items.slice(start, start + size);
    const next = start + size < items.length ? String(start + size) : undefined;
    return json({
      ...(page.length ? { data: page } : {}),
      ...(includes && page.length ? { includes: includes(page) } : {}),
      meta: { result_count: page.length, ...(next ? { next_token: next } : {}) },
    });
  }
}

/** `base64(HMAC-SHA256(secret, text))`, as X signs a delivery and answers a challenge. */
export async function hmacBase64(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...mac));
}

export function identityOf(user: WireUser, extra: Partial<StoredIdentity> = {}): StoredIdentity {
  return {
    id: user.id, username: user.username!, name: user.name!, protected: user.protected === true,
    verified: user.verified === true, fetchedAt: Date.now(), ...extra,
  };
}

/**
 * Seeds a connected account for `user` whose token X will accept and that needs no refresh, the
 * way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(x: FakeX, user: WireUser = ALICE, options: {
  expiresInMs?: number; scopes?: string[]; identity?: Partial<StoredIdentity>;
} = {}): Promise<string> {
  const grant = x.grant(user.id);
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("credentials", {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: Date.now() + (options.expiresInMs ?? 60 * 60 * 1000),
      scopes: options.scopes ?? grant.scope.split(" "),
    });
    state.storage.kv.put("identity", identityOf(user, options.identity));
  });
  return accountId.toString();
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/**
 * Runs a reconnect inside the account, X authorizing `user`, up to the callback: a handoff naming
 * the stage to commit, or a refusal. The account needs a Workshop callback (`installCallback`).
 */
export async function reconnectAs(x: FakeX, userObjectId: string, user: WireUser) {
  const initiation = generateNonce();
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation, scopesFor());
    const flow = await instance.beginOAuthFlow(initiation, getRedirectUri(env as Env));
    if (!flow) throw new Error("the reconnect did not start");
    const code = `code-${crypto.randomUUID()}`;
    x.codes.set(code, user.id);
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T>(outcome: { ok: T } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: { ok: unknown } | { error: string }): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}
