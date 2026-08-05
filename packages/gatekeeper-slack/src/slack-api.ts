// Slack Web API client for user-token reads and OAuth lifecycle. Maps responses to public types and
// resolves known mentions.

import { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  SlackConversationInfo, SlackConversationKind, SlackFile, SlackMessage, SlackReaction,
  SlackUser, SlackWorkspaceInfo,
} from "./types";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_TOKEN_URL = `${SLACK_API_BASE}/oauth.v2.access`;
const SLACK_REVOKE_URL = `${SLACK_API_BASE}/auth.revoke`;

// Slack's Retry-After header is measured in seconds.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** A short-lived Slack access token and its expiry (token rotation issues 12-hour tokens). */
export type SlackAccessToken = {
  token: string;
  expires: Date;
};

/** The result of a completed OAuth code exchange for a user token. */
export type SlackOAuthGrant = {
  accessToken: SlackAccessToken;
  // Present when token rotation is enabled on the Slack app; absent for legacy long-lived tokens.
  refreshToken?: string;
  grantedScopes: string[];
  userId: string;
  teamId: string;
  teamName?: string;
};

/** The result of refreshing a rotating token. */
export type SlackTokenRefresh = {
  accessToken: SlackAccessToken;
  refreshToken?: string;
  grantedScopes: string[];
};

// ── Raw Slack API response shapes (only the fields we use) ──────────

type SlackApiEnvelope = {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string; messages?: string[] };
};

type RawUser = {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_192?: string;
    image_72?: string;
    image_48?: string;
  };
};

type RawConversation = {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
  user?: string;
};

type RawReaction = { name: string; count: number };

type RawFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
};

type RawMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: RawReaction[];
  files?: RawFile[];
  subtype?: string;
  permalink?: string;
  // search.messages matches carry the channel they were found in.
  channel?: { id: string; name?: string };
};

/** A result page and its continuation token, omitted after the last page. */
export type SlackPage<T> = {
  items: T[];
  nextCursor?: string;
};

/** A search result and the conversation containing it. */
export type SlackSearchMatch = {
  message: SlackMessage;
  channelId: string;
};

// ── OAuth ───────────────────────────────────────────────────────────

/** Exchanges an OAuth code for Slack user-token credentials. */
export async function exchangeAuthCode(
    code: string, clientId: string, clientSecret: string, redirectUri: string)
    : Promise<SlackOAuthGrant> {
  let body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  let data = await postToken(body);

  // Slack nests user-token credentials under authed_user during code exchange.
  let authedUser = data.authed_user;
  if (!authedUser?.access_token) {
    throw new Error(
        "Slack did not return a user token. Make sure the app requests user scopes (user_scope).");
  }

  return {
    accessToken: {
      token: authedUser.access_token,
      expires: expiryFrom(authedUser.expires_in),
    },
    refreshToken: authedUser.refresh_token,
    grantedScopes: splitScopes(authedUser.scope),
    userId: authedUser.id,
    teamId: data.team?.id ?? "",
    teamName: data.team?.name,
  };
}

/** Refreshes a rotating user token, returning null when reauthorization is required. */
export async function refreshAccessToken(
    refreshToken: string, clientId: string, clientSecret: string)
    : Promise<SlackTokenRefresh | null> {
  let body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  let response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  let data = await response.json<any>();

  if (!data.ok) {
    if (data.error === "invalid_refresh_token" || data.error === "token_expired" ||
        data.error === "invalid_grant" || data.error === "token_revoked") {
      return null;
    }
    throw new Error(`Slack token refresh failed: ${data.error ?? response.status}`);
  }

  // On refresh, the user-token fields come back at the top level (token_type "user").
  if (!data.access_token) {
    throw new Error("Slack token refresh returned no access token.");
  }

  return {
    accessToken: { token: data.access_token, expires: expiryFrom(data.expires_in) },
    refreshToken: data.refresh_token,
    grantedScopes: splitScopes(data.scope),
  };
}

/** Revokes a Slack access or refresh token. */
export async function revokeToken(token: string): Promise<void> {
  let response = await fetch(SLACK_REVOKE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
  let data = await response.json<SlackApiEnvelope>();
  if (data.error === "token_revoked" || data.error === "token_expired") return;
  if (!response.ok || !data.ok) throw slackApiError(data.error, response.status);
}

async function postToken(body: URLSearchParams): Promise<any> {
  let response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  let data = await response.json<any>();
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error ?? response.status}`);
  }
  return data;
}

function expiryFrom(expiresIn: unknown): Date {
  // Slack omits expires_in for legacy non-rotating tokens; use a distant sentinel expiry.
  let seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : 100 * 365 * 24 * 3600;
  return new Date(Date.now() + seconds * 1000);
}

function splitScopes(scope: unknown): string[] {
  return typeof scope === "string" ? scope.split(",").filter(Boolean) : [];
}

// ── Errors ──────────────────────────────────────────────────────────

// Map known Slack errors without exposing endpoint names.
const SLACK_ERROR_MESSAGES: Record<string, string> = {
  user_not_found: "Slack user not found.",
  users_not_found: "Slack user not found.",
  channel_not_found: "Slack conversation not found.",
  thread_not_found: "Slack thread not found.",
  message_not_found: "Slack message not found.",
  not_in_channel: "Not a member of this Slack conversation.",
  is_archived: "This Slack conversation is archived.",
  missing_scope: "This Slack connection lacks permission for that request.",
  not_allowed_token_type: "This Slack connection lacks permission for that request.",
  no_permission: "Slack denied access to that resource.",
  access_denied: "Slack denied access to that resource.",
  invalid_auth: "Slack authentication has expired. Please reconnect the account.",
  not_authed: "Slack authentication has expired. Please reconnect the account.",
  token_expired: "Slack authentication has expired. Please reconnect the account.",
  token_revoked: "Slack authentication has expired. Please reconnect the account.",
  account_inactive: "Slack authentication has expired. Please reconnect the account.",
  ratelimited: "Slack rate limit reached. Please try again shortly.",
};

// Slack error codes indicating the token's user cannot see the requested resource (vs. a transient
// or malformed-request failure). Used by observer verification to distinguish "no access" from
// errors that should propagate. `missing_scope`/`not_allowed_token_type` are treated as no-access:
// a token that cannot demonstrate access is conservatively deemed to lack it.
const ACCESS_ERROR_CODES = new Set([
  "channel_not_found", "not_in_channel", "no_permission", "access_denied",
  "missing_scope", "not_allowed_token_type",
]);

// Slack error codes indicating the token itself is expired or revoked.
const AUTH_ERROR_CODES = new Set([
  "invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive",
]);

/** An error from a Slack API call, carrying the raw error code for callers that must branch on it. */
export class SlackApiError extends Error {
  /** The Slack `error` code (e.g. `channel_not_found`), or undefined for a bare HTTP failure. */
  readonly code?: string;
  /** The HTTP status of the failed response. */
  readonly status: number;

  constructor(code: string | undefined, status: number) {
    super(code && SLACK_ERROR_MESSAGES[code]
        ? SLACK_ERROR_MESSAGES[code]
        : `Slack request failed: ${code ?? status}`);
    this.code = code;
    this.status = status;
  }

  /** True when the token's user cannot see the requested resource. */
  get isAccessError(): boolean {
    return this.code !== undefined && ACCESS_ERROR_CODES.has(this.code);
  }

  /** True when the token has expired or been revoked. */
  get isAuthError(): boolean {
    return this.code !== undefined && AUTH_ERROR_CODES.has(this.code);
  }
}

function slackApiError(code: string | undefined, status: number): SlackApiError {
  return new SlackApiError(code, status);
}

// ── API client ──────────────────────────────────────────────────────

export type SlackConversationTypeFilter = SlackConversationKind;

export class SlackApi {
  #getToken: () => Promise<string>;
  // Per-client cache for author and mention resolution.
  #userCache = new Map<string, SlackUser>();
  // Empty string records a failed workspace-host lookup.
  #host?: string;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  // auth.test needs no extra scope, so permalink construction works for scoped tokens.
  async #getWorkspaceHost(): Promise<string | undefined> {
    if (this.#host === undefined) {
      try {
        let data = await this.#call<SlackApiEnvelope & { url?: string }>("auth.test", {});
        this.#host = data.url ? new URL(data.url).host : "";
      } catch {
        this.#host = "";
      }
    }
    return this.#host || undefined;
  }

  async #withPermalinks(channelId: string, messages: SlackMessage[]): Promise<SlackMessage[]> {
    if (messages.every(message => message.permalink)) return messages;
    let host = await this.#getWorkspaceHost();
    if (!host) return messages;
    for (let message of messages) {
      message.permalink ??= buildPermalink(host, channelId, message.ts, message.threadTs);
    }
    return messages;
  }

  // ── Low-level request helper ──────────────────────────────────────

  async #call<T extends SlackApiEnvelope>(
      method: string, params: Record<string, string | number | undefined>): Promise<T> {
    let url = new URL(`${SLACK_API_BASE}/${method}`);
    for (let [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      let token = await this.#getToken();
      let response = await fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${token}` },
      });

      if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
        let retryAfter = Number(response.headers.get("Retry-After")) || 1;
        let waitMs = Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT_MS);
        response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      let data = await response.json<T>();
      if (!data.ok) {
        throw slackApiError(data.error, response.status);
      }
      return data;
    }
  }

  // ── Identity / workspace ──────────────────────────────────────────

  async authedUserId(): Promise<string> {
    let data = await this.#call<SlackApiEnvelope & { user_id?: string }>("auth.test", {});
    return data.user_id ?? "";
  }

  // The team the token belongs to, used by observer verification to confirm workspace membership.
  async authedTeamId(): Promise<string> {
    let data = await this.#call<SlackApiEnvelope & { team_id?: string }>("auth.test", {});
    return data.team_id ?? "";
  }

  async getWorkspaceInfo(): Promise<SlackWorkspaceInfo> {
    let data = await this.#call<SlackApiEnvelope & {
      team?: { id: string; name: string; domain: string };
    }>("team.info", {});
    return {
      teamId: data.team?.id ?? "",
      name: data.team?.name ?? "",
      domain: data.team?.domain ?? "",
    };
  }

  // ── Users ─────────────────────────────────────────────────────────

  async getUser(userId: string): Promise<SlackUser> {
    let cached = this.#userCache.get(userId);
    if (cached) return cached;
    let data = await this.#call<SlackApiEnvelope & { user?: RawUser }>(
        "users.info", { user: userId });
    if (!data.user) throw new Error(`Slack user not found: ${userId}`);
    let user = toUser(data.user);
    this.#userCache.set(userId, user);
    return user;
  }

  async getAccountDescription(userId: string): Promise<AccountDescription> {
    let data = await this.#call<SlackApiEnvelope & { user?: RawUser }>(
        "users.info", { user: userId });
    let profile = data.user?.profile;
    return {
      displayName: profile?.real_name || profile?.display_name || data.user?.name,
      uniqueName: data.user?.name,
      avatar: { url: profile?.image_192 || profile?.image_72 || profile?.image_48 || "" },
    };
  }

  async listUsers(cursor: string | undefined, limit: number): Promise<SlackPage<SlackUser>> {
    let data = await this.#call<SlackApiEnvelope & { members?: RawUser[] }>(
        "users.list", { cursor, limit });
    let items = (data.members ?? [])
        .filter(member => !member.deleted)
        .map(toUser);
    for (let user of items) this.#userCache.set(user.id, user);
    return { items, nextCursor: nextCursor(data) };
  }

  // ── Conversations ─────────────────────────────────────────────────

  // Resolve 1:1 DM peers because Slack's member listing may omit them.
  async listUserConversations(
      types: SlackConversationTypeFilter[], cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackConversationInfo>> {
    let data = await this.#call<SlackApiEnvelope & { channels?: RawConversation[] }>(
        "users.conversations",
        { types: types.join(","), cursor, limit, exclude_archived: "false" });
    let raws = data.channels ?? [];
    await this.#prefetchIds(raws.filter(raw => raw.is_im && raw.user).map(raw => raw.user!));
    let items = raws.map(raw => {
      let info = toConversationInfo(raw);
      if (raw.is_im && raw.user) info.peer = this.#userCache.get(raw.user);
      return info;
    });
    return { items, nextCursor: nextCursor(data) };
  }

  async getConversationInfo(conversationId: string): Promise<SlackConversationInfo> {
    let data = await this.#call<SlackApiEnvelope & { channel?: RawConversation }>(
        "conversations.info", { channel: conversationId });
    if (!data.channel) throw new Error(`Slack conversation not found: ${conversationId}`);
    let info = toConversationInfo(data.channel);
    if (data.channel.is_im && data.channel.user) {
      info.peer = await this.getUser(data.channel.user).catch(() => undefined);
    }
    return info;
  }

  async listConversationMembers(
      conversationId: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<string>> {
    let data = await this.#call<SlackApiEnvelope & { members?: string[] }>(
        "conversations.members", { channel: conversationId, cursor, limit });
    return { items: data.members ?? [], nextCursor: nextCursor(data) };
  }

  async listHistory(
      conversationId: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackMessage>> {
    let data = await this.#call<SlackApiEnvelope & { messages?: RawMessage[] }>(
        "conversations.history", { channel: conversationId, cursor, limit });
    let items = await this.#withPermalinks(conversationId, await this.#buildMessages(data.messages ?? []));
    return { items, nextCursor: nextCursor(data) };
  }

  async listReplies(
      conversationId: string, threadTs: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackMessage>> {
    let data = await this.#call<SlackApiEnvelope & { messages?: RawMessage[] }>(
        "conversations.replies", { channel: conversationId, ts: threadTs, cursor, limit });
    let items = await this.#withPermalinks(conversationId, await this.#buildMessages(data.messages ?? []));
    return { items, nextCursor: nextCursor(data) };
  }

  // ── Search ────────────────────────────────────────────────────────
  // search.messages is page-based (not cursor-based). We encode the page number as the cursor.

  // Channel-ID filtering is the authority boundary; query syntax is only a search hint.
  async searchMessages(
      query: string, cursor: string | undefined, count: number, restrictChannelId?: string)
      : Promise<SlackPage<SlackSearchMatch>> {
    let page = cursor ? Number(cursor) : 1;
    if (!Number.isFinite(page) || page < 1) page = 1;
    let data = await this.#call<SlackApiEnvelope & {
      messages?: { matches?: RawMessage[]; paging?: { pages?: number; page?: number } };
    }>("search.messages", { query, count, page, sort: "timestamp" });

    let matches = (data.messages?.matches ?? [])
        .filter(match => !restrictChannelId || match.channel?.id === restrictChannelId);
    await this.#prefetchUsers(matches);
    let items: SlackSearchMatch[] = matches.map(match => ({
      message: this.#toMessage(match),
      channelId: match.channel?.id ?? "",
    }));
    let paging = data.messages?.paging;
    let hasMore = paging?.pages !== undefined && paging.page !== undefined
        ? paging.page < paging.pages
        : (data.messages?.matches?.length ?? 0) === count;
    return { items, nextCursor: hasMore ? String(page + 1) : undefined };
  }

  // ── Message construction / name resolution ────────────────────────

  async #buildMessages(raw: RawMessage[]): Promise<SlackMessage[]> {
    await this.#prefetchUsers(raw);
    return raw.map(message => this.#toMessage(message));
  }

  async #prefetchUsers(messages: RawMessage[]): Promise<void> {
    let ids = new Set<string>();
    for (let message of messages) {
      if (message.user) ids.add(message.user);
      for (let mentioned of mentionedUserIds(message.text ?? "")) ids.add(mentioned);
    }
    await this.#prefetchIds([...ids]);
  }

  // Stay below the Workers limit of six concurrent outgoing requests.
  async #prefetchIds(ids: string[]): Promise<void> {
    let missing = [...new Set(ids)].filter(id => !this.#userCache.has(id));
    for (let i = 0; i < missing.length; i += 5) {
      await Promise.all(missing.slice(i, i + 5).map(id => this.getUser(id).catch(() => undefined)));
    }
  }

  #userName(userId: string): string {
    let user = this.#userCache.get(userId);
    return user?.displayName || user?.username || userId;
  }

  #toMessage(raw: RawMessage): SlackMessage {
    let author: SlackUser | null = null;
    if (raw.user) {
      author = this.#userCache.get(raw.user)
          ?? { id: raw.user, username: raw.user, isBot: isSystemOrBot({ id: raw.user }) };
    } else if (raw.bot_id) {
      author = { id: raw.bot_id, username: raw.username || "bot", isBot: true };
    }

    return {
      ts: raw.ts,
      author,
      text: resolveText(raw.text ?? "", id => this.#userName(id)),
      timestamp: new Date(Number(raw.ts.split(".")[0]) * 1000),
      // Search omits thread_ts; recover it from reply permalinks.
      threadTs: raw.thread_ts ?? threadTsFromPermalink(raw.permalink),
      replyCount: raw.reply_count,
      reactions: (raw.reactions ?? []).map(toReaction),
      files: (raw.files ?? []).map(toFile),
      permalink: raw.permalink,
    };
  }
}

// ── Pure transforms ─────────────────────────────────────────────────

function nextCursor(data: SlackApiEnvelope): string | undefined {
  let cursor = data.response_metadata?.next_cursor;
  return cursor && cursor.length > 0 ? cursor : undefined;
}

// Slack's built-in system identities incorrectly report is_bot: false.
const SLACK_SYSTEM_USER_IDS = new Set(["USLACKBOT", "USLACK"]);

function isSystemOrBot(raw: Pick<RawUser, "id" | "is_bot">): boolean {
  return (raw.is_bot ?? false) || SLACK_SYSTEM_USER_IDS.has(raw.id);
}

function toUser(raw: RawUser): SlackUser {
  return {
    id: raw.id,
    username: raw.name ?? raw.id,
    displayName: raw.profile?.display_name || undefined,
    realName: raw.real_name || raw.profile?.real_name || undefined,
    isBot: isSystemOrBot(raw),
  };
}

// Search omits thread_ts; reply permalinks retain it.
function threadTsFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  try {
    return new URL(permalink).searchParams.get("thread_ts") || undefined;
  } catch {
    return undefined;
  }
}

// Construct Slack archive URLs that also match the thread resource pattern.
function buildPermalink(
    host: string, channelId: string, ts: string, threadTs: string | undefined): string {
  let base = `https://${host}/archives/${channelId}/p${ts.replace(".", "")}`;
  if (threadTs && threadTs !== ts) {
    return `${base}?${new URLSearchParams({ thread_ts: threadTs, cid: channelId })}`;
  }
  return base;
}

function conversationKind(raw: RawConversation): SlackConversationKind {
  if (raw.is_im) return "im";
  if (raw.is_mpim) return "mpim";
  if (raw.is_private) return "private_channel";
  return "public_channel";
}

function toConversationInfo(raw: RawConversation): SlackConversationInfo {
  return {
    id: raw.id,
    kind: conversationKind(raw),
    name: raw.name,
    topic: raw.topic?.value || undefined,
    purpose: raw.purpose?.value || undefined,
    memberCount: raw.num_members,
    isArchived: raw.is_archived ?? false,
  };
}

function toReaction(raw: RawReaction): SlackReaction {
  return { name: raw.name, count: raw.count };
}

function toFile(raw: RawFile): SlackFile {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    title: raw.title || undefined,
    mimetype: raw.mimetype || undefined,
    size: raw.size,
    permalink: raw.permalink || undefined,
  };
}

function mentionedUserIds(text: string): string[] {
  let ids: string[] = [];
  for (let match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    ids.push(match[1]);
  }
  return ids;
}

const SLACK_TEXT_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

/** Converts Slack mention/link markup and HTML entities to readable text. */
export function resolveText(text: string, userName: (id: string) => string): string {
  let out = text
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
          (_m, id: string, label?: string) => `@${label || userName(id)}`)
      .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g,
          (_m, id: string, label?: string) => `#${label || id}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g,
          (_m, label?: string) => label || "@group")
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, name: string) => `@${name}`)
      .replace(/<(https?:[^|>]+)(?:\|([^>]*))?>/g,
          (_m, url: string, label?: string) => label ? `${label} (${url})` : url)
      .replace(/<(mailto:[^|>]+)(?:\|([^>]*))?>/g,
          (_m, url: string, label?: string) => label || url.replace(/^mailto:/, ""));
  return out.replace(/&(amp|lt|gt);/g, (_match, name: string) => SLACK_TEXT_ENTITIES[name]);
}
