// Slack Web API client for user-token reads and OAuth lifecycle. Maps responses to public types and
// resolves known mentions.

import {
  defineUpstream, type CallAnswer, type RetryPolicy,
} from "@gadgets/gatekeeper-kit/upstream";
import { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  SlackConversationInfo, SlackConversationKind, SlackFile, SlackMessage, SlackReaction,
  SlackUser, SlackWorkspaceInfo,
} from "./types";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_TOKEN_URL = `${SLACK_API_BASE}/oauth.v2.access`;
const SLACK_REVOKE_URL = `${SLACK_API_BASE}/auth.revoke`;

/**
 * The Web API methods this gatekeeper calls. A call is counted under its method, which is its
 * operation in the subservice metrics. Every one is a read, sent as a GET, so a call that got no
 * answer is sent again (see `RATE_LIMIT_RETRY`): a method that writes is not sent that way.
 */
export const SLACK_METHODS = [
  "auth.test", "auth.teams.list", "team.info", "users.info", "users.list", "users.conversations",
  "conversations.list", "conversations.info", "conversations.members", "conversations.history",
  "conversations.replies", "search.messages",
] as const;

/** One of the Web API methods this gatekeeper calls. */
export type SlackMethod = (typeof SLACK_METHODS)[number];

/**
 * The client every request to Slack is sent through, counted under the source
 * `gatekeeper.slack.api` and the service `slack`. A Web API call is named by its `SlackMethod`,
 * and a token request `token.exchange`, `token.refresh` or `token.revoke`.
 */
export const slackUpstream = defineUpstream({ vendorId: "slack" });

// Slack's Retry-After header is measured in seconds.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

// A rate-limited Web API call is sent again whatever its method, since Slack refuses it before
// acting on it, and is the only answered call that is. The wait is the one Slack names, or a
// second where it names none. A call that got no answer (a network failure, a timeout) is sent
// again too, within the same three attempts, as the client sends again any GET.
const RATE_LIMIT_RETRY: RetryPolicy = {
  attempts: RATE_LIMIT_MAX_RETRIES + 1,
  maxDelayMs: RATE_LIMIT_MAX_WAIT_MS,
  retryable: status => status === 429,
  delayMs: response => (Number(response.headers.get("Retry-After")) || 1) * 1000,
};

function nextPageCursor(cursor: string | undefined, seen: Set<string>): string | undefined {
  if (cursor && seen.has(cursor)) throw new Error("Slack repeated a pagination cursor.");
  if (cursor) seen.add(cursor);
  return cursor;
}

/** A short-lived Slack access token and its expiry (token rotation issues 12-hour tokens). */
export type SlackAccessToken = {
  token: string;
  expires: Date;
};

/** The result of a completed OAuth code exchange for a user token. */
export type SlackOAuthGrant = {
  accessToken: SlackAccessToken;
  /** Present when token rotation is enabled on the Slack app; absent for legacy long-lived tokens. */
  refreshToken?: string;
  grantedScopes: string[];
  userId: string;
  teamId: string;
  teamName?: string;
  isEnterpriseInstall: boolean;
  enterpriseId?: string;
  enterpriseName?: string;
};

/** Installation identity; the flag is absent on accounts saved before org-install support. */
export type SlackInstallation = {
  teamId: string;
  isEnterpriseInstall?: boolean;
  enterpriseId?: string;
};

/** A selectable workspace, not the enterprise containing it. */
export type SlackWorkspace = { id: string; name: string };

/** Slack workspace IDs begin with T; enterprise IDs must never be used as workspace selectors. */
export function isWorkspaceId(id: string | undefined): id is string {
  return typeof id === "string" && /^T[A-Z0-9]+$/.test(id);
}

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

type RawTokenGrant = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: unknown;
  scope?: unknown;
};

type RawTokenAnswer = SlackApiEnvelope & RawTokenGrant & {
  authed_user?: RawTokenGrant & { id: string };
  team?: { id?: string; name?: string } | null;
  enterprise?: { id?: string; name?: string } | null;
  is_enterprise_install?: boolean;
};

type RawUser = {
  id: string;
  team_id?: string;
  enterprise_user?: { teams?: string[] };
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
  team_id?: string;
  context_team_id?: string;
  shared_team_ids?: string[];
  internal_team_ids?: string[];
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

// ── Answers ─────────────────────────────────────────────────────────

// What the method that sent a call made of an envelope that says `ok`: what it read from it, or
// what it threw for an envelope that lacks what the call was sent for. `flawed` marks one whose
// reading the method goes on with and will refuse.
type Made<R> = { value: R; flawed: boolean } | { thrown: unknown };

// A parsed envelope and the answer it came in, with what the calling method made of the envelope
// where it reads one.
type Answered<T, R = never> = { data: T; response: Response; made?: Made<R> };

async function readEnvelope<T extends SlackApiEnvelope>(response: Response): Promise<Answered<T>> {
  return { data: await response.json<T>(), response };
}

// Whether a parsed body can hold an envelope. Slack answers every call with a JSON object, and
// reading an envelope's members from a body that is JSON's `null` throws.
function holdsEnvelope(data: unknown): boolean {
  return typeof data === "object" && data !== null;
}

// Slack answers a failed call with a 200 whose envelope says `ok: false`: an error of the API,
// or a refusal where the envelope names the rate limit. A 200 with no envelope is an error of the
// API as well, and so is one whose envelope the calling method refused (`Made`). Any other answer
// counts by its status.
function countEnvelope({ data, response, made }: Answered<SlackApiEnvelope, unknown>): CallAnswer | undefined {
  if (!response.ok) return undefined;
  if (!holdsEnvelope(data)) return { outcome: "error", reason: "api" };
  if (!data.ok) {
    return data.error === "ratelimited"
        ? { outcome: "refused", reason: "rate" }
        : { outcome: "error", reason: "api" };
  }
  return made && ("thrown" in made || made.flawed) ? { outcome: "error", reason: "api" } : undefined;
}

// Reads an envelope that says `ok` as the method that sent the call does, keeping what `read`
// throws for the call to be counted by and for the method to throw. A `flawed` that cannot read
// what `read` returned says that the method cannot either.
async function madeOf<T, R>(
    data: T, read: (data: T) => R | Promise<R>, flawed?: (value: R) => boolean): Promise<Made<R>> {
  let value: R;
  try {
    value = await read(data);
  } catch (error) {
    return { thrown: error };
  }
  try {
    return { value, flawed: flawed?.(value) === true };
  } catch {
    return { value, flawed: true };
  }
}

// Whether Slack's answer to a revocation says that the token is revoked or expired already,
// which leaves nothing to revoke.
function alreadyRevoked(data: SlackApiEnvelope): boolean {
  return data.error === "token_revoked" || data.error === "token_expired";
}

// A revocation that found its token revoked already is done, and counts as a success with the
// status Slack gave. Any other answer counts as that of any call does.
function countRevocation(answered: Answered<SlackApiEnvelope>): CallAnswer | undefined {
  return holdsEnvelope(answered.data) && alreadyRevoked(answered.data)
      ? { outcome: "success" }
      : countEnvelope(answered);
}

// ── OAuth ───────────────────────────────────────────────────────────

// The user-token credentials of an answer to a token request, where they hold a token.
type UserGrant<G extends RawTokenGrant> = G & { access_token: string };

function holdsToken<G extends RawTokenGrant>(grant: G | undefined): grant is UserGrant<G> {
  return Boolean(grant?.access_token);
}

// Slack nests user-token credentials under authed_user during code exchange.
function exchangedGrant(data: RawTokenAnswer) {
  return holdsToken(data.authed_user) ? data.authed_user : undefined;
}

// On refresh, the user-token fields come back at the top level (token_type "user").
function refreshedGrant(data: RawTokenAnswer) {
  return holdsToken(data) ? data : undefined;
}

// A token request that Slack answers a success without the user token it asks for has failed: its
// helper throws on the same check, `grantOf`, and the call counts as an error of the API. Any
// other answer counts as that of any call does.
function countGrant(grantOf: (data: RawTokenAnswer) => RawTokenGrant | undefined) {
  return (answered: Answered<RawTokenAnswer>): CallAnswer | undefined => {
    let counted = countEnvelope(answered);
    if (counted || !answered.response.ok || grantOf(answered.data)) return counted;
    return { outcome: "error", reason: "api" };
  };
}

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

  let { data, response } = await postToken("token.exchange", body, exchangedGrant);
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error ?? response.status}`);
  }

  let authedUser = exchangedGrant(data);
  if (!authedUser) {
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
    isEnterpriseInstall: data.is_enterprise_install === true,
    enterpriseId: data.enterprise?.id,
    enterpriseName: data.enterprise?.name,
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

  let { data, response } = await postToken("token.refresh", body, refreshedGrant);

  if (!data.ok) {
    if (data.error === "invalid_refresh_token" || data.error === "token_expired" ||
        data.error === "invalid_grant" || data.error === "token_revoked") {
      return null;
    }
    throw new Error(`Slack token refresh failed: ${data.error ?? response.status}`);
  }

  let grant = refreshedGrant(data);
  if (!grant) {
    throw new Error("Slack token refresh returned no access token.");
  }

  return {
    accessToken: { token: grant.access_token, expires: expiryFrom(grant.expires_in) },
    refreshToken: grant.refresh_token,
    grantedScopes: splitScopes(grant.scope),
  };
}

/**
 * Revokes a Slack access or refresh token. A token that Slack says is revoked or expired already
 * is revoked: the call resolves, and is counted a success.
 */
export async function revokeToken(token: string): Promise<void> {
  let { data, response } = await slackUpstream.read<Answered<SlackApiEnvelope>>(SLACK_REVOKE_URL, {
    operation: "token.revoke",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  }, readEnvelope, countRevocation);
  if (alreadyRevoked(data)) return;
  if (!response.ok || !data.ok) throw slackApiError(data.error, response.status);
}

// Posts a form to Slack's token endpoint, which serves the exchange and the refresh alike.
// `grantOf` gives the user-token credentials the request asks for, where the answer holds them.
function postToken(
    operation: "token.exchange" | "token.refresh", body: URLSearchParams,
    grantOf: (data: RawTokenAnswer) => RawTokenGrant | undefined)
    : Promise<Answered<RawTokenAnswer>> {
  return slackUpstream.read<Answered<RawTokenAnswer>>(SLACK_TOKEN_URL, {
    operation,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, readEnvelope, countGrant(grantOf));
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
  "missing_scope", "not_allowed_token_type", "team_access_not_granted",
]);

// Slack error codes indicating the token itself is expired or revoked.
const AUTH_ERROR_CODES = new Set([
  "invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive",
]);

// The ACCESS_ERROR_CODES that answer whether the token's user can see the resource. A missing
// scope or a disallowed token type says nothing about that, so a subresource access check throws
// on them rather than reading them as a denial.
const DENIAL_ERROR_CODES: Record<string, true> = {
  channel_not_found: true, not_in_channel: true, no_permission: true, access_denied: true,
  team_access_not_granted: true,
};

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

  /**
   * True when Slack answered that the token's user cannot see the requested resource, as opposed
   * to a refusal that leaves their access undetermined (an expired token, a missing scope).
   */
  get isDenial(): boolean {
    return this.code !== undefined && Object.hasOwn(DENIAL_ERROR_CODES, this.code);
  }
}

function slackApiError(code: string | undefined, status: number): SlackApiError {
  return new SlackApiError(code, status);
}

// ── API client ──────────────────────────────────────────────────────

export type SlackConversationTypeFilter = SlackConversationKind;

type SlackApiOptions = {
  teamId?: () => Promise<string>;
  installation?: () => Promise<SlackInstallation>;
};

// The parameters of a Web API call. One that is undefined is left out.
type CallParams = Record<string, string | number | undefined>;

// What `auth.test` answers of the token it is asked with.
type AuthTest = SlackApiEnvelope & {
  team_id?: string; user_id?: string; is_enterprise_install?: boolean;
};

// Whose token a client holds: Slack's answer, and whether the app is installed on an organisation.
type InstallationContext = { auth: AuthTest; orgInstall: boolean };

export class SlackApi {
  #getToken: () => Promise<string>;
  #options: SlackApiOptions;
  #workspaceSelection?: Promise<string>;
  #workspaceAccess?: { token: string; promise: Promise<string> };
  // Per-client cache for author and mention resolution.
  #userCache = new Map<string, SlackUser>();
  // Empty string records a failed workspace-host lookup.
  #host?: string;

  constructor(getToken: () => Promise<string>, options: SlackApiOptions = {}) {
    this.#getToken = getToken;
    this.#options = options;
  }

  /** New request/session context with an immutable workspace selection. */
  forWorkspace(teamId: string): SlackApi {
    if (!isWorkspaceId(teamId)) throw new Error("Select a Slack workspace, not an enterprise.");
    return new SlackApi(this.#getToken, { ...this.#options, teamId: async () => teamId });
  }

  // Asks Slack whose token this is and reads the saved installation once Slack has answered.
  // `pick` takes what its caller needs of the two and throws where the answer lacks it, which
  // counts the call an error of the API. A saved installation that cannot be read is no fault of
  // the answer: the call counts by its status, and what the reading threw is thrown.
  async #installationContext<R>(pick: (context: InstallationContext) => R): Promise<R> {
    let read = await this.#call("auth.test", {}, async (auth: AuthTest) => {
      let saved: SlackInstallation | undefined;
      try {
        saved = await this.#options.installation?.();
      } catch (error) {
        return { unread: error };
      }
      return {
        picked: pick({
          auth,
          orgInstall: saved?.isEnterpriseInstall ??
              (auth.is_enterprise_install === true || !isWorkspaceId(auth.team_id)),
        }),
      };
    });
    if ("unread" in read) throw read.unread;
    return read.picked;
  }

  /** Workspaces both granted to the app and joined by this user; walks every grant page. */
  async listWorkspaces(): Promise<SlackWorkspace[]> {
    return slackUpstream.summed(() => this.#listWorkspaces());
  }

  async #listWorkspaces(): Promise<SlackWorkspace[]> {
    let identity = await this.#installationContext(({ auth, orgInstall }) => {
      if (!orgInstall) {
        if (!isWorkspaceId(auth.team_id)) throw new Error("Slack returned no workspace identity.");
        return { teamId: auth.team_id };
      }
      if (!auth.user_id) throw new Error("Slack returned no user identity.");
      return { userId: auth.user_id };
    });
    if ("teamId" in identity) {
      let info = await this.#readWorkspaceInfo({ team: identity.teamId });
      return [{ id: info.teamId, name: info.name }];
    }
    // The user's workspaces are taken within the call: an answer whose list of them is none says
    // nothing of the user's membership, and is refused, so that an access check throws as
    // indeterminate rather than denying. It counts the call an error of the API.
    let memberships = await this.#call("users.info", { user: identity.userId },
        (user: SlackApiEnvelope & { user?: RawUser }) => {
          let teams: unknown = user.user?.enterprise_user?.teams;
          if (!Array.isArray(teams)) throw new Error("Slack returned a malformed list of the user's workspaces.");
          return new Set<unknown>(teams);
        });
    let workspaces = new Map<string, SlackWorkspace>();
    let cursor: string | undefined;
    let seen = new Set<string>();
    do {
      cursor = await this.#call("auth.teams.list", { cursor, limit: 200 },
          (page: SlackApiEnvelope & { teams?: { id: string; name?: string }[] }) => {
        // A page with no list of grants says nothing of whether the app may reach a workspace: it
        // is refused, so that an access check throws as indeterminate rather than denying.
        if (!Array.isArray(page.teams)) throw new Error("Slack returned a malformed list of workspaces.");
        for (let team of page.teams) {
          if (isWorkspaceId(team.id) && memberships.has(team.id)) {
            workspaces.set(team.id, { id: team.id, name: team.name || team.id });
          }
        }
        return nextPageCursor(nextCursor(page), seen);
      });
    } while (cursor);
    return [...workspaces.values()];
  }

  /** Workspace membership is checked with the caller's credentials, not an enterprise ID. */
  async hasWorkspaceAccess(teamId: string): Promise<boolean> {
    return isWorkspaceId(teamId) && (await this.listWorkspaces()).some(team => team.id === teamId);
  }

  /** Resolve a workspace permalink host without assuming the token has one workspace. */
  async workspaceIdForDomain(domain: string): Promise<string> {
    // The workspace of a workspace install's token, and undefined for an org install's.
    let ownTeamId = await this.#installationContext(({ auth, orgInstall }) => {
      if (orgInstall) return undefined;
      if (!isWorkspaceId(auth.team_id)) throw new Error("Slack returned no workspace identity.");
      return auth.team_id;
    });
    if (ownTeamId !== undefined) {
      // Domain lookup is Enterprise-only; a workspace token may resolve only its own host.
      let info = await this.#readWorkspaceInfo({ team: ownTeamId });
      if (info.domain !== domain) throw new SlackApiError("team_access_not_granted", 200);
      return info.teamId;
    }
    let info = await this.#readWorkspaceInfo({ domain });
    if (!(await this.hasWorkspaceAccess(info.teamId))) {
      throw new SlackApiError("team_access_not_granted", 200);
    }
    return info.teamId;
  }

  async #selectedWorkspaceTeamId(): Promise<string> {
    let selection = this.#workspaceSelection ??= (async () => {
      let teamId = await this.#options.teamId?.();
      if (!isWorkspaceId(teamId)) throw new Error("Select a Slack workspace for this connection.");
      return teamId;
    })();
    try {
      return await selection;
    } catch (error) {
      if (this.#workspaceSelection === selection) this.#workspaceSelection = undefined;
      throw error;
    }
  }

  async #workspaceForToken(token: string): Promise<string> {
    if (this.#workspaceAccess?.token === token) return this.#workspaceAccess.promise;
    let check = {
      token,
      promise: (async () => {
        let teamId = await this.#selectedWorkspaceTeamId();
        // All pages of the access proof use the credential that will make the read. The
        // unbound client avoids recursively checking membership for its own metadata calls.
        let api = new SlackApi(async () => token, { installation: this.#options.installation });
        if (!(await api.hasWorkspaceAccess(teamId))) {
          throw new SlackApiError("team_access_not_granted", 200);
        }
        return teamId;
      })(),
    };
    this.#workspaceAccess = check;
    try {
      return await check.promise;
    } catch (error) {
      // Do not let an older check's failure evict a newer credential's access proof.
      if (this.#workspaceAccess === check) this.#workspaceAccess = undefined;
      throw error;
    }
  }

  /** Keep the workspace pinned, but recheck its authority whenever credentials change. */
  async workspaceTeamId(): Promise<string> {
    return this.#workspaceForToken(await this.#getToken());
  }

  // Org auth.test describes the enterprise host, not necessarily the selected workspace.
  async #getWorkspaceHost(): Promise<string | undefined> {
    if (this.#host === undefined) {
      try {
        let info = await this.getWorkspaceInfo();
        this.#host = info.domain ? `${info.domain}.slack.com` : "";
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

  // Calls one Web API method and resolves to its envelope, or to what `read` makes of it. A
  // method that checks the envelope it is answered, or takes from it what the call was sent for,
  // does so in `read`, which is given an envelope that says `ok`: what `read` throws is thrown to
  // the caller, and counts a call that Slack answered a success an error of the API. `flawed`
  // says whether what `read` returned holds something the method goes on to refuse, which counts
  // the same and throws nothing here.
  #call<T extends SlackApiEnvelope>(method: SlackMethod, params: CallParams): Promise<T>;
  #call<T extends SlackApiEnvelope, R>(
      method: SlackMethod, params: CallParams, read: (data: T) => R | Promise<R>,
      flawed?: (value: R) => boolean): Promise<R>;
  async #call<T extends SlackApiEnvelope, R>(
      method: SlackMethod, params: CallParams, read?: (data: T) => R | Promise<R>,
      flawed?: (value: R) => boolean): Promise<T | R> {
    let url = new URL(`${SLACK_API_BASE}/${method}`);
    for (let [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let { data, response, made } = await slackUpstream.read<Answered<T, R>>(url.toString(), {
      operation: method,
      retry: RATE_LIMIT_RETRY,
      // Asked before every send. Workspace tokens ignore team_id on some reads. Check the actual
      // outgoing credential, including retries, rather than relying on the token used when
      // parameters were built.
      authorize: async () => {
        let token = await this.#getToken();
        if (this.#options.teamId) await this.#workspaceForToken(token);
        return { "Authorization": `Bearer ${token}` };
      },
    }, async answer => {
      let answered = await readEnvelope<T>(answer);
      // The method reads the envelope this helper returns: one that says `ok`.
      if (!read || !holdsEnvelope(answered.data) || !answered.data.ok) return answered;
      return { ...answered, made: await madeOf(answered.data, read, flawed) };
    }, countEnvelope);
    if (!data.ok) {
      throw slackApiError(data.error, response.status);
    }
    if (!made) return data;
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }

  // ── Identity / workspace ──────────────────────────────────────────

  async authedUserId(): Promise<string> {
    let data = await this.#call<SlackApiEnvelope & { user_id?: string }>("auth.test", {});
    return data.user_id ?? "";
  }

  async getWorkspaceInfo(): Promise<SlackWorkspaceInfo> {
    return this.#readWorkspaceInfo({ team: await this.workspaceTeamId() });
  }

  async #readWorkspaceInfo(params: { team?: string; domain?: string }): Promise<SlackWorkspaceInfo> {
    return this.#call("team.info", params, (data: SlackApiEnvelope & {
      team?: { id: string; name: string; domain: string };
    }) => {
      if (!isWorkspaceId(data.team?.id) || (params.team && data.team.id !== params.team)) {
        throw new Error("Slack returned an enterprise or a different workspace instead of the selected workspace.");
      }
      return {
        teamId: data.team?.id ?? "",
        name: data.team?.name ?? "",
        domain: data.team?.domain ?? "",
      };
    });
  }

  // ── Users ─────────────────────────────────────────────────────────

  async getUser(userId: string): Promise<SlackUser> {
    let cached = this.#userCache.get(userId);
    if (cached) return cached;
    let user = await this.#call("users.info", { user: userId },
        (data: SlackApiEnvelope & { user?: RawUser }) => {
      if (!data.user) throw new Error(`Slack user not found: ${userId}`);
      return toUser(data.user);
    });
    this.#userCache.set(userId, user);
    return user;
  }

  /** Direct profile lookup may not expand a workspace binding to the whole org directory. */
  async getWorkspaceUser(userId: string): Promise<SlackUser> {
    return slackUpstream.summed(() => this.#findWorkspaceUser(userId));
  }

  async #findWorkspaceUser(userId: string): Promise<SlackUser> {
    // users.info translates pre-Enterprise IDs to the user's canonical ID.
    let canonical = await this.getUser(userId);
    let cursor: string | undefined;
    let seen = new Set<string>();
    do {
      // The user, where this page holds them, else the cursor of the page after it.
      let found = await this.#usersPage(cursor, 200, page =>
          page.items.find(item => item.id === canonical.id) ?? nextPageCursor(page.nextCursor, seen));
      if (typeof found === "object") return found;
      cursor = found;
    } while (cursor);
    throw new SlackApiError("access_denied", 200);
  }

  /** Qualify workspace accounts by host and org accounts by enterprise ID, not a mutable handle. */
  async getAccountDescription(userId: string, installation: SlackInstallation): Promise<AccountDescription> {
    let auth = await this.#call<SlackApiEnvelope & {
      url?: string; team_id?: string; enterprise_id?: string; is_enterprise_install?: boolean;
    }>("auth.test", {});
    let data = await this.#call<SlackApiEnvelope & { user?: RawUser }>(
        "users.info", { user: userId });
    let profile = data.user?.profile;
    let handle = data.user?.name;
    // A Slack handle is unique only within a workspace, but the Workshop dedupes connected accounts
    // by uniqueName — so an unqualified handle would collapse two workspaces the same person
    // connected into one account. Org accounts instead use the global user and enterprise IDs.
    let orgInstall = installation.isEnterpriseInstall ??
        (auth.is_enterprise_install === true || !isWorkspaceId(auth.team_id));
    // Workspace installs inside an Enterprise also have enterprise_id. Do not collapse them into
    // an org account: their token authority is still workspace-specific.
    let qualifier = orgInstall ? installation.enterpriseId || auth.enterprise_id : undefined;
    qualifier ||= auth.url ? new URL(auth.url).host : installation.teamId;
    let identity = orgInstall ? data.user?.id ?? userId : handle;
    return {
      displayName: profile?.real_name || profile?.display_name || handle,
      uniqueName: identity && qualifier ? `${identity}@${qualifier}` : handle,
      avatar: { url: profile?.image_192 || profile?.image_72 || profile?.image_48 || "" },
    };
  }

  async listUsers(cursor: string | undefined, limit: number): Promise<SlackPage<SlackUser>> {
    return this.#usersPage(cursor, limit, page => page);
  }

  // One page of the workspace's users, as `read` takes it: what `read` throws for a page it
  // refuses counts the call (`#call`).
  async #usersPage<R>(
      cursor: string | undefined, limit: number, read: (page: SlackPage<SlackUser>) => R): Promise<R> {
    return this.#call("users.list", { cursor, limit, team_id: await this.workspaceTeamId() },
        (data: SlackApiEnvelope & { members?: RawUser[] }) => {
      let items = (data.members ?? [])
          .filter(member => !member.deleted)
          .map(toUser);
      for (let user of items) this.#userCache.set(user.id, user);
      return read({ items, nextCursor: nextCursor(data) });
    });
  }

  // ── Conversations ─────────────────────────────────────────────────

  /** Resolve 1:1 DM peers because Slack's member listing may omit them. */
  async listUserConversations(
      types: SlackConversationTypeFilter[], cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackConversationInfo>> {
    // The page's conversations, and the peers of its direct messages, are taken within the call:
    // a page whose conversations are no list of them counts the call an error of the API.
    let { data, listed, peers } = await this.#call(
        "users.conversations",
        { types: types.join(","), cursor, limit, exclude_archived: "false",
          team_id: await this.workspaceTeamId() },
        (page: SlackApiEnvelope & { channels?: RawConversation[] }) => {
      let raws = page.channels ?? [];
      // Each peer is taken as the conversation names it, whatever it names it with.
      return { data: page, listed: raws, peers: raws.filter(raw => raw.is_im && raw.user).flatMap(raw => raw.user ? [raw.user] : []) };
    });
    await this.#prefetchIds(peers);
    let items = listed.map(raw => {
      let info = toConversationInfo(raw);
      if (raw.is_im && raw.user) info.peer = this.#userCache.get(raw.user);
      return info;
    });
    return { items, nextCursor: nextCursor(data) };
  }

  async getConversationInfo(conversationId: string): Promise<SlackConversationInfo> {
    let teamId = await this.workspaceTeamId();
    let channel = await this.#call(
        "conversations.info", { channel: conversationId, client_context_team_id: teamId },
        (data: SlackApiEnvelope & { channel?: RawConversation }) => {
      if (!data.channel || data.channel.id !== conversationId) {
        throw new Error(`Slack conversation not found: ${conversationId}`);
      }
      return data.channel;
    });
    await slackUpstream.summed(() => this.#assertConversationWorkspace(channel, teamId));
    let info = toConversationInfo(channel);
    if (channel.is_im && channel.user) {
      info.peer = await this.getUser(channel.user).catch(() => undefined);
    }
    return info;
  }

  async #assertConversationWorkspace(channel: RawConversation, teamId: string): Promise<void> {
    // Slack Connect can name only external workspaces in shared_team_ids. Its internal
    // workspace membership is reported separately; the requested viewing context is not proof.
    if (channel.internal_team_ids?.includes(teamId)) return;
    // Shared channels belong to several workspaces. Their host is not their access boundary.
    if (channel.shared_team_ids?.length) {
      if (channel.shared_team_ids.includes(teamId)) return;
      // Enterprise DMs can be listed in this workspace while sharing metadata names another.
      // Unlike shared channels, a mismatch must fall through to workspace-scoped DM discovery.
      if (!channel.is_im && !channel.is_mpim) throw new SlackApiError("access_denied", 200);
    } else if (channel.team_id === teamId) return;
    // DMs and older channel responses can omit workspace metadata. Prove membership through a
    // workspace-scoped listing rather than treating an org token's visibility (or its requested
    // context_team_id) as sufficient. This also handles shared channels hosted elsewhere.
    let cursor: string | undefined;
    let seen = new Set<string>();
    do {
      // True where this page lists the conversation, else the cursor of the page after it.
      let found = await this.#call(
          channel.is_im || channel.is_mpim ? "users.conversations" : "conversations.list",
          { team_id: teamId, types: channel.is_im ? "im" : channel.is_mpim ? "mpim" :
              "public_channel,private_channel", limit: 200, cursor, exclude_archived: "false" },
          (page: SlackApiEnvelope & { channels?: RawConversation[] }) =>
              page.channels?.some(item => item.id === channel.id) || nextPageCursor(nextCursor(page), seen));
      if (found === true) return;
      cursor = found;
    } while (cursor);
    throw new SlackApiError("access_denied", 200);
  }

  async #conversationParams(conversationId: string): Promise<{ channel: string; client_context_team_id: string }> {
    await this.getConversationInfo(conversationId);
    return { channel: conversationId, client_context_team_id: await this.workspaceTeamId() };
  }

  async listConversationMembers(
      conversationId: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<string>> {
    let data = await this.#call<SlackApiEnvelope & { members?: string[] }>(
        "conversations.members", { ...await this.#conversationParams(conversationId), cursor, limit });
    return { items: data.members ?? [], nextCursor: nextCursor(data) };
  }

  async listHistory(
      conversationId: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackMessage>> {
    let { data, named } = await this.#call(
        "conversations.history", { ...await this.#conversationParams(conversationId), cursor, limit }, namedIn);
    let items = await this.#withPermalinks(conversationId, await this.#buildMessages(data.messages ?? [], named));
    return { items, nextCursor: nextCursor(data) };
  }

  async listReplies(
      conversationId: string, threadTs: string, cursor: string | undefined, limit: number)
      : Promise<SlackPage<SlackMessage>> {
    let { data, named } = await this.#call(
        "conversations.replies", { ...await this.#conversationParams(conversationId), ts: threadTs, cursor, limit },
        namedIn);
    let items = await this.#withPermalinks(conversationId, await this.#buildMessages(data.messages ?? [], named));
    return { items, nextCursor: nextCursor(data) };
  }

  // ── Search ────────────────────────────────────────────────────────
  // search.messages is page-based (not cursor-based). We encode the page number as the cursor.

  /** Channel-ID filtering is the authority boundary; query syntax is only a search hint. */
  async searchMessages(
      query: string, cursor: string | undefined, count: number, restrictChannelId?: string)
      : Promise<SlackPage<SlackSearchMatch>> {
    return slackUpstream.summed(() => this.#searchPage(query, cursor, count, restrictChannelId));
  }

  async #searchPage(
      query: string, cursor: string | undefined, count: number, restrictChannelId?: string)
      : Promise<SlackPage<SlackSearchMatch>> {
    let page = cursor ? Number(cursor) : 1;
    if (!Number.isFinite(page) || page < 1) page = 1;
    // A match that names no conversation is refused below, once the conversations of the matches
    // before it are looked up: the search counts an error of the API by that same check.
    let { data, matches } = await this.#call(
        "search.messages", { query, count, page, sort: "timestamp", team_id: await this.workspaceTeamId() },
        (found: SlackApiEnvelope & {
          messages?: { matches?: RawMessage[]; paging?: { pages?: number; page?: number } };
        }) => ({
          data: found,
          matches: (found.messages?.matches ?? [])
              .filter(match => !restrictChannelId || match.channel?.id === restrictChannelId),
        }),
        read => read.matches.some(match => !conversationIdOf(match)));
    for (let channelId of new Set(matches.map(conversationIdOf))) {
      if (!channelId) throw new Error("Slack search returned a message without a conversation.");
      await this.getConversationInfo(channelId);
    }
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

  // The messages of a page, with `named`, the users the page names (`namedUserIds`), resolved.
  async #buildMessages(raw: RawMessage[], named: string[]): Promise<SlackMessage[]> {
    await this.#prefetchIds(named);
    return raw.map(message => this.#toMessage(message));
  }

  async #prefetchUsers(messages: RawMessage[]): Promise<void> {
    await this.#prefetchIds(namedUserIds(messages));
  }

  // Stay below the Workers limit of six concurrent outgoing requests.
  async #prefetchIds(ids: string[]): Promise<void> {
    let missing = [...new Set(ids)].filter(id => !this.#userCache.has(id));
    await slackUpstream.summed(async () => {
      for (let i = 0; i < missing.length; i += 5) {
        await Promise.all(missing.slice(i, i + 5).map(id => this.getUser(id).catch(() => undefined)));
      }
    });
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

// The users a list of messages names: the author of each, and those its text mentions.
function namedUserIds(messages: RawMessage[]): string[] {
  let ids = new Set<string>();
  for (let message of messages) {
    if (message.user) ids.add(message.user);
    for (let mentioned of mentionedUserIds(message.text ?? "")) ids.add(mentioned);
  }
  return [...ids];
}

// What Slack answers a page of a conversation's messages with.
type MessagePage = SlackApiEnvelope & { messages?: RawMessage[] };

// A page of a conversation's messages as `#call` reads it, with the users it names. The page is
// read for them within the call: one whose messages are no list of them counts the call an error
// of the API.
function namedIn(data: MessagePage): { data: MessagePage; named: string[] } {
  return { data, named: namedUserIds(data.messages ?? []) };
}

// The conversation a search match was found in, or undefined where the match names none.
function conversationIdOf(match: RawMessage): string | undefined {
  return match.channel?.id || undefined;
}

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
