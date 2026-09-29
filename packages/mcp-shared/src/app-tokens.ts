// App-link tokens: how long a sidecar link lives, how it is found again, and what a mint writes.
//
// Storage has no `list()`, so a record can only be read by naming it. The link a resource already
// has is therefore found through a pointer key, and a record no pointer names can never be found
// again -- which is why a mint that rotates deletes the record it replaced. Without that, every
// rotation would leave a value behind that nothing could ever collect.
//
// Every decision here is a pure function of what storage returned, including the clock the caller
// read once, so the reuse and rotation rules are testable without a Durable Object. `account.ts`
// makes the KV calls and owns nothing else.

import type { AppBinding, AppCallSnapshot } from "./apps.js";
import { endpointTag } from "./scope.js";
import { hexEncode } from "./util.js";

/**
 * Length of an app link's token, in bytes. 32 bytes (64 hex characters) is far beyond guessing, and
 * the HTTP route stops a token of any other length before it reaches an account.
 */
export const APP_TOKEN_BYTES = 32;

/**
 * How long an app link stays usable: long enough to open a result from yesterday's chat, short
 * enough that a link abandoned in a transcript stops working.
 */
export const APP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

// The largest value Durable Object storage accepts under one key. A tool result is the only part of
// a record that is not already bounded -- it can be most of a server response -- so a mint measures
// the record it is about to write rather than assuming the call it carries was small.
const MAX_APP_RECORD_BYTES = 128 * 1024;

const encoder = new TextEncoder();

/** What a link is, apart from the call that happens to be on it now. */
type AppLink = {
  /** The binding that minted it, as it stood then: every app call is checked against this grant. */
  binding: AppBinding;
  /** The `ui://` resource the link renders. */
  uri: string;
  /** Display name for the link, when the server gave one. */
  title?: string;
  /** When the link was minted. */
  createdAt: number;
  /** When the link stops working. */
  expiresAt: number;
};

/**
 * One minted link, stored under `appTokenKey(token)`.
 *
 * Carries the binding rather than a way to look it up: a sidecar page outlives the chat that opened
 * it, so this record is the only thing left that says which grant the app may call under.
 */
export type AppTokenRecord = AppLink & {
  /** The most recent call whose result the page opens on. */
  call?: AppCallSnapshot;
  /**
   * True when the call snapshot's result was dropped to fit the storage limit. The page reports that
   * by showing the tool call and no result at all; this keeps the reason recorded, so a stored
   * snapshot cannot later be read as one whose caller simply passed no result.
   */
  resultDropped?: boolean;
};

/** What one mint leaves in storage, and what it clears away. */
export type AppLinkPlan = {
  /** The token the link carries: the one already live for this resource, or a fresh one. */
  token: string;
  /** The value to write under `appTokenKey(token)`. */
  record: AppTokenRecord;
  /**
   * The token whose record this plan replaces, when it replaced one. The caller must delete it: the
   * pointer now names a different token, so nothing else could ever find the old record again.
   */
  superseded?: string;
};

/** Storage key holding one link's record. */
export function appTokenKey(token: string): string {
  return `appToken:${token}`;
}

/**
 * Storage key holding the token currently minted for one resource of one binding.
 *
 * The resource is part of the key because one binding can render several apps, and the endpoint half
 * goes through `endpointTag` so two spellings of one endpoint share a link rather than quietly
 * minting a second. `\u0000` separates them: it cannot appear in either a URL or a URI.
 */
export function appTokenPointerKey(endpoint: string, uri: string): string {
  return `appTokenFor:${endpointTag(endpoint)}\u0000${uri}`;
}

/**
 * The link a user opens for one token.
 *
 * A pure function of its parts so the shape can be pinned without an account, and so the path a mint
 * hands out and the path the HTTP route answers cannot drift apart.
 */
export function appLinkUrl(baseUrl: string, accountId: string, token: string): string {
  return `${baseUrl}/app/${accountId}/${token}`;
}

/**
 * Whether a stored record is still usable. The predicate form is what lets a caller that tested it
 * go on to read the record without a second check.
 */
export function appTokenLive(
  record: AppTokenRecord | undefined, now: number,
): record is AppTokenRecord {
  return record !== undefined && now < record.expiresAt;
}

/**
 * Decides what one mint writes for one resource of one binding.
 *
 * A live link is reused rather than replaced, so a URL already sitting in a chat keeps working and a
 * resource rendered on every call cannot grow the account's keys without bound. Its expiry is not
 * slid forward on reuse, so a token over a busy resource still dies when it was minted to die rather
 * than living as long as it keeps being called.
 */
export function planAppLink(input: {
  binding: AppBinding;
  resource: { uri: string; title?: string };
  call?: AppCallSnapshot;
  /** The token `appTokenPointerKey` named, when it named one. */
  pointer?: string;
  /** The record that token names, when it is still stored. */
  existing?: AppTokenRecord;
  /** The caller's clock, read once, so this stays a function of its inputs alone. */
  now: number;
}): AppLinkPlan {
  const { binding, resource, pointer, existing, call, now } = input;
  if (pointer !== undefined && appTokenLive(existing, now)
      && sameResourceNaming(existing.binding, binding)) {
    // Reuse keeps the identity fields and swaps the call. The binding is one of them on purpose: a
    // link was handed out under a grant, and a later binding for the same endpoint -- wider or
    // narrower -- must not silently re-point the grant that link calls under. The one thing it
    // cannot keep is a binding that addresses the resource differently from the one being minted:
    // that link can read nothing, so it is replaced instead (see `sameResourceNaming`).
    return {
      token: pointer,
      record: withCall({
        binding: existing.binding,
        uri: existing.uri,
        title: resource.title ?? existing.title,
        createdAt: existing.createdAt,
        expiresAt: existing.expiresAt,
      }, call),
    };
  }
  return {
    token: hexEncode(crypto.getRandomValues(new Uint8Array(APP_TOKEN_BYTES))),
    record: withCall({
      binding,
      uri: resource.uri,
      title: resource.title,
      createdAt: now,
      expiresAt: now + APP_TOKEN_LIFETIME_MS,
    }, call),
    superseded: pointer,
  };
}

// Whether a stored link reads the resource the way the binding being minted now does. A deployment
// that changes how an endpoint is addressed -- the release that taught a portal connector to ask for
// namespaced resource URIs, say -- leaves links minted before it unable to read anything, and a mint
// that reused one would keep handing it back for the rest of its day.
function sameResourceNaming(existing: AppBinding, minted: AppBinding): boolean {
  return existing.resourceUriPrefix === minted.resourceUriPrefix;
}

/**
 * Attaches the call a link opens on, dropping a result too large for storage to hold.
 *
 * Storage refuses an oversized value outright, which would take the link down with it; the result is
 * dropped whole rather than truncated, because half a document renders as a broken app while a call
 * with no result is something the page can say plainly. The flag is recomputed with every call, so a
 * later, smaller result fills the record back in.
 */
function withCall(link: AppLink, call: AppCallSnapshot | undefined): AppTokenRecord {
  if (call?.result === undefined) return { ...link, call };
  if (encodedBytes({ ...link, call }) <= MAX_APP_RECORD_BYTES) return { ...link, call };
  return {
    ...link,
    call: { toolName: call.toolName, input: call.input },
    resultDropped: true,
  };
}

// Measured as the UTF-8 length of the JSON text, the way the tool catalog's budget is: storage
// serialization is not JSON, but for data that came from JSON this is the larger of the two, so a
// record that fits here fits there.
//
// A value JSON cannot represent at all -- a cycle, a bigint -- has no measurable size, and is
// reported as too large so the result is dropped rather than the whole mint failing.
function encodedBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
