// X's URL grammar: what a pasted link names, and the canonical links this gatekeeper hands out.
// The configurators carry their own copy of the parts they need, since each configurator module is
// transpiled alone; `__tests__/configurator-url.test.ts` keeps the copies in step.

import { ACCOUNT_URL, PROFILE_TABS } from "./x-env";

/** Hosts that serve X links. */
const HOSTS = new Set([
  "x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
]);

/** A post or List ID: a snowflake, at most 19 digits. */
export const SNOWFLAKE = /^[0-9]{1,19}$/;

/** A handle. */
export const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * First path segments X reserves for its own pages, so they are never handles even where the
 * handle grammar admits them.
 */
export const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "about", "account", "bookmarks", "communities", "compose", "download", "explore", "hashtag",
  "help", "home", "i", "intent", "jobs", "lists", "login", "logout", "messages", "notifications",
  "premium", "privacy", "search", "settings", "share", "signup", "topics", "tos",
]);

const TABS: ReadonlySet<string> = new Set(PROFILE_TABS);

/** What an X link names. */
export type ParsedXUrl =
  | { kind: "account" }
  | { kind: "post"; postId: string }
  | { kind: "list"; listId: string }
  | { kind: "profile"; username: string };

/**
 * Parses an x.com or twitter.com link.
 * @returns What it names, or `null` when it names nothing this gatekeeper binds.
 */
export function parseXUrl(raw: string): ParsedXUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 2 && segments[0] === "settings" && segments[1] === "account") {
    return { kind: "account" };
  }
  if (segments[0] === "i") {
    if (segments[1] === "web" && segments[2] === "status" && SNOWFLAKE.test(segments[3] ?? "")) {
      return { kind: "post", postId: segments[3] };
    }
    if (segments[1] === "status" && SNOWFLAKE.test(segments[2] ?? "")) {
      return { kind: "post", postId: segments[2] };
    }
    if (segments[1] === "lists" && SNOWFLAKE.test(segments[2] ?? "")) {
      return { kind: "list", listId: segments[2] };
    }
    return null;
  }
  if (segments.length >= 3 && segments[1] === "status" && SNOWFLAKE.test(segments[2])) {
    return { kind: "post", postId: segments[2] };
  }
  const handle = segments[0];
  if (segments.length >= 1 && segments.length <= 2 && isHandle(handle)
      && (segments.length === 1 || TABS.has(segments[1]))) {
    return { kind: "profile", username: handle };
  }
  return null;
}

/** Whether `value` is a handle X could have issued: the grammar, and not a reserved page. */
export function isHandle(value: string): boolean {
  return HANDLE.test(value) && !RESERVED_FIRST_SEGMENTS.has(value.toLowerCase());
}

/**
 * Reads a post reference: a post ID, a temporary `~` ID, or a post link.
 * @throws When `ref` names no post.
 */
export function parsePostRef(ref: string): string {
  const trimmed = ref.trim();
  if (SNOWFLAKE.test(trimmed) || /^~[0-9]+$/.test(trimmed)) return trimmed;
  const parsed = parseXUrl(trimmed);
  if (parsed?.kind === "post") return parsed.postId;
  throw new Error("Expected a post ID or an x.com post link.");
}

/**
 * Reads a List reference: a List ID, a temporary `~` ID, or a List link.
 * @throws When `ref` names no List.
 */
export function parseListRef(ref: string): string {
  const trimmed = ref.trim();
  if (SNOWFLAKE.test(trimmed) || /^~[0-9]+$/.test(trimmed)) return trimmed;
  const parsed = parseXUrl(trimmed);
  if (parsed?.kind === "list") return parsed.listId;
  throw new Error("Expected a List ID or an x.com List link.");
}

/**
 * Reads a user reference: a handle with or without the "@", or a profile link.
 * @throws When `ref` names no user.
 */
export function parseUsernameRef(ref: string): string {
  const trimmed = ref.trim().replace(/^@/, "");
  if (isHandle(trimmed)) return trimmed;
  const parsed = parseXUrl(ref);
  if (parsed?.kind === "profile") return parsed.username;
  throw new Error("Expected an X username, such as @XDevelopers, or a profile link.");
}

/** A post's canonical link, by its author's handle when known. */
export function postUrl(id: string, username?: string): string {
  return username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

/** A profile's canonical link. */
export function profileUrl(username: string): string {
  return `https://x.com/${username}`;
}

/** A List's canonical link. */
export function listUrl(id: string): string {
  return `https://x.com/i/lists/${id}`;
}

export { ACCOUNT_URL };
