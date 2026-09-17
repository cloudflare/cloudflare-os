import { resourceUrlPatternsToOAuthScopes, validateResourceUrlPatterns } from "./resources";

const FLOW_KEY = "oauthFlow";
const NONCE_LIFETIME_MS = 10 * 60 * 1000;
const LEGACY_FLOW_KEYS = [
  "nonce", "requestedScopes", "requestedResources", "reconnecting", "ephemeral",
] as const;

export type OAuthFlowMode = "connect" | "auth" | "reconnect";

export type StoredOAuthFlow = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  mode: OAuthFlowMode;
  requestedResources: string[];
  oauthRedirectUri?: string;
};

type SynchronousKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
};

/**
 * Compares fixed-length hex nonces without leaking how far a match got.
 *
 * The early length check reveals only the nonce's fixed, public length. Keep this pure JavaScript:
 * this module also runs in Node tests, where Workers' `SubtleCrypto.timingSafeEqual` is unavailable.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function matchesFlow(flow: StoredOAuthFlow | undefined, stage: StoredOAuthFlow["stage"],
                 nonce: string, now: number): flow is StoredOAuthFlow {
  return !!flow && flow.stage === stage && now < flow.expiresAt &&
    constantTimeEqual(flow.value, nonce);
}

export function prepareOAuthFlow(kv: SynchronousKv, initiationNonce: string,
                                 requestedResources: readonly string[], mode: OAuthFlowMode,
                                 now: number): void {
  validateResourceUrlPatterns(requestedResources);
  for (let key of LEGACY_FLOW_KEYS) kv.delete(key);
  kv.put<StoredOAuthFlow>(FLOW_KEY, {
    value: initiationNonce,
    expiresAt: now + NONCE_LIFETIME_MS,
    stage: "initiation",
    mode,
    requestedResources: [...requestedResources],
  });
}

/** Merge resources from an OAuth completion with grants committed by an overlapping flow. */
export function mergeGrantedResources(
    kv: SynchronousKv, requestedResources: readonly string[]): void {
  let grantedResources = kv.get<string[]>("grantedResources") ?? [];
  kv.put("grantedResources", [...new Set([...grantedResources, ...requestedResources])]);
}

export function beginStoredOAuthFlow(kv: SynchronousKv, initiationNonce: string,
                                     oauthNonce: string, oauthRedirectUri: string, now: number)
    : {oauthNonce: string, scopes: string[]} | null {
  let flow = kv.get<StoredOAuthFlow>(FLOW_KEY);
  if (!matchesFlow(flow, "initiation", initiationNonce, now)) return null;

  kv.put<StoredOAuthFlow>(FLOW_KEY, {
    ...flow, value: oauthNonce, expiresAt: now + NONCE_LIFETIME_MS, stage: "oauth",
    oauthRedirectUri,
  });
  return { oauthNonce, scopes: resourceUrlPatternsToOAuthScopes(flow.requestedResources) };
}

export function claimStoredOAuthFlow(kv: SynchronousKv, oauthNonce: string, now: number)
    : {mode: OAuthFlowMode, requestedResources: string[], oauthRedirectUri: string} | null {
  let flow = kv.get<StoredOAuthFlow>(FLOW_KEY);
  if (!matchesFlow(flow, "oauth", oauthNonce, now) || !flow.oauthRedirectUri) return null;

  kv.delete(FLOW_KEY);
  return {
    mode: flow.mode,
    requestedResources: [...flow.requestedResources],
    oauthRedirectUri: flow.oauthRedirectUri,
  };
}

/** Preserve destructive intent across the `ephemeral` to cleanup-marker deployment cutover. */
export function shouldDeleteCredentialsOnAlarm(kv: SynchronousKv): boolean {
  return kv.get<string>("refreshToken") === undefined ||
    kv.get<boolean>("deleteCredentialsOnAlarm") === true ||
    kv.get<boolean>("ephemeral") === true;
}
