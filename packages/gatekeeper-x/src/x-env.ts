// Configuration shared by every part of the X gatekeeper: the Worker's environment, X's endpoints,
// the connectable resources with their URL patterns, and the OAuth scopes each one needs.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";

/** The vendor id: the router's `/gatekeeper/x/` path segment, and the log attribution. */
export const VENDOR_ID = "x";

/** The Worker's environment. Every value is optional: each has a default or turns a feature off. */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/x`. */
  BASE_URL?: string;
  /** The X app's OAuth 2.0 client ID. */
  CLIENT_ID?: string;
  /** The X app's OAuth 2.0 client secret. */
  CLIENT_SECRET?: string;
  /**
   * Billable read resources each connection may read per UTC day; `0` lifts the limit. Defaults
   * to `DEFAULT_DAILY_READ_LIMIT`.
   */
  X_DAILY_READ_LIMIT?: string;
  /** The public https origin X delivers push notifications to. Unset, hooks are refused. */
  WEBHOOK_ORIGIN?: string;
  /**
   * The X app's app-only bearer token, which X's webhook endpoints take and nothing else does.
   * Unset, hooks are refused.
   */
  X_APP_BEARER_TOKEN?: string;
};

/** The header X signs each webhook delivery in, with the app's OAuth 2.0 client secret. */
export const SIGNATURE_HEADER = "X-Twitter-Webhooks-Signature-OAuth2";

/** Where the Worker sends API requests. */
export const X_API_ORIGIN = "https://api.x.com";
/** The browser-facing authorization page. */
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
/** The token endpoint, for code exchange and refresh. */
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
/** The RFC 7009 revocation endpoint. */
export const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";

/**
 * The Account resource's canonical URL. It names no user, so a blueprint re-resolving it under
 * another account binds that account, and no profile pattern matches it (see the plan, §4).
 */
export const ACCOUNT_URL = "https://x.com/settings/account";

/** The default `X_DAILY_READ_LIMIT`: about $10 a day at X's post-read price. */
export const DEFAULT_DAILY_READ_LIMIT = 2000;

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/x");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** The OAuth callback registered with the X app. */
export function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/**
 * The URL X delivers push notifications to, or undefined when this deployment has not configured
 * them: that takes both `WEBHOOK_ORIGIN` and `X_APP_BEARER_TOKEN`.
 * @throws If `WEBHOOK_ORIGIN` is not an https origin without a port, the only kind X accepts.
 */
export function webhookUrl(env: Env): string | undefined {
  if (env.WEBHOOK_ORIGIN === undefined || !env.X_APP_BEARER_TOKEN) return undefined;
  const origin = URL.parse(env.WEBHOOK_ORIGIN);
  if (origin?.protocol !== "https:" || origin.port !== "" || origin.href !== `${origin.origin}/`) {
    throw new Error("WEBHOOK_ORIGIN must be an https origin without a port, such as https://gadgets.example.com.");
  }
  return `${origin.origin}${getBasePath(env)}/webhook`;
}

/**
 * The daily read limit in force.
 * @returns The limit, or `null` when reads are unlimited.
 */
export function dailyReadLimit(env: Env): number | null {
  const raw = env.X_DAILY_READ_LIMIT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_DAILY_READ_LIMIT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0) return DEFAULT_DAILY_READ_LIMIT;
  return limit === 0 ? null : limit;
}

/** The kinds of resource a binding can be. */
export type ResourceKind = "account" | "post" | "list" | "profile";

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type XGatekeeperImplProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
} & (
  | { resourceKind: "account" }
  | { resourceKind: "post"; postId: string }
  | { resourceKind: "list"; listId: string }
  /** `username` is the handle as the binding was made; the user's ID is pinned at first lookup. */
  | { resourceKind: "profile"; username: string }
);

/** The hosts every pattern accepts, with or without `www.` or `mobile.`. */
const HOST = "{(www|mobile).}?(x|twitter).com";

/** X's profile tabs, which still name the profile they belong to. */
export const PROFILE_TABS = [
  "with_replies", "media", "highlights", "articles", "followers", "following", "verified_followers",
] as const;

/**
 * The connectable resources. The Post pattern's leading `*` also covers X's `/i/web/status/:id`
 * links, and the Profile pattern takes only a handle plus a known tab, so the Account's
 * `/settings/account` matches nothing narrower than the catch-all.
 */
export const RESOURCES: Record<ResourceKind, SupportedResource> = {
  post: {
    urlPattern: `https://${HOST}/*/status/:postId{/*}?`,
    title: "X Post",
    description: "Read one post and its conversation, and reply, like, repost, bookmark, or hide " +
      "replies in it.",
    grantable: true,
  },
  list: {
    urlPattern: `https://${HOST}/i/lists/:listId{/*}?`,
    title: "X List",
    description: "Read one List's posts and members, and manage its members if you own it.",
    grantable: true,
  },
  profile: {
    urlPattern: `https://${HOST}/:username([A-Za-z0-9_]{1,15}){/(${PROFILE_TABS.join("|")})}?`,
    title: "X Profile",
    description: "Read one user's public profile and posts. Read-only.",
    grantable: true,
  },
  account: {
    urlPattern: "https://*",
    title: "X Account",
    description: "Whole-account access: your timelines, mentions, search, bookmarks and likes, " +
      "and publishing, liking, reposting, and following as you.",
    grantable: true,
  },
};

/** The resources in the order the picker lists them: whole account first. */
export const ALL_RESOURCES: SupportedResource[] = [
  RESOURCES.account, RESOURCES.post, RESOURCES.list, RESOURCES.profile,
];

/** Scopes every connection carries: identity, post reads, and a refresh token. */
export const BASE_SCOPES = ["tweet.read", "users.read", "offline.access"] as const;

/** The scopes each resource adds to `BASE_SCOPES`. */
export const RESOURCE_SCOPES: Record<ResourceKind, readonly string[]> = {
  account: [
    "tweet.write", "like.read", "like.write", "bookmark.read", "bookmark.write", "follows.read",
    "follows.write", "mute.write", "list.read", "list.write", "media.write", "tweet.moderate.write",
  ],
  post: ["tweet.write", "like.write", "bookmark.write", "media.write", "tweet.moderate.write"],
  list: ["list.read", "list.write"],
  profile: [],
};

/** The resource kind a `SupportedResource.urlPattern` names, or `undefined` for none of ours. */
export function kindOfPattern(urlPattern: string): ResourceKind | undefined {
  return (Object.keys(RESOURCES) as ResourceKind[]).find(kind => RESOURCES[kind].urlPattern === urlPattern);
}

/**
 * The scopes a connection limited to `resourceUrlPatterns` requests.
 * @param resourceUrlPatterns The resource types to grant; omitted grants every type, and `[]` none
 * beyond the base scopes.
 * @throws For a pattern that is not one of this gatekeeper's.
 */
export function scopesFor(resourceUrlPatterns?: readonly string[]): string[] {
  const scopes = new Set<string>(BASE_SCOPES);
  const kinds = resourceUrlPatterns === undefined
    ? (Object.keys(RESOURCES) as ResourceKind[])
    : resourceUrlPatterns.map(pattern => {
      const kind = kindOfPattern(pattern);
      if (kind === undefined) throw new Error(`Unknown X resource type: ${pattern}`);
      return kind;
    });
  for (const kind of kinds) for (const scope of RESOURCE_SCOPES[kind]) scopes.add(scope);
  return [...scopes];
}

/**
 * The resource types a grant covers: those whose every scope, base scopes included, was granted.
 * @param grantedScopes The scopes X reported granting.
 */
export function grantedResourcePatterns(grantedScopes: readonly string[]): string[] {
  const granted = new Set(grantedScopes);
  if (!BASE_SCOPES.every(scope => granted.has(scope))) return [];
  return ALL_RESOURCES.filter(resource => {
    const kind = kindOfPattern(resource.urlPattern)!;
    return RESOURCE_SCOPES[kind].every(scope => granted.has(scope));
  }).map(resource => resource.urlPattern);
}
