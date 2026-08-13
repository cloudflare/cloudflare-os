import {
  OAuthError,
  type FetchLike,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { redactSecrets, safeServerText } from "./util.js";

/** SDK tokens plus the absolute expiry used by the account's hot path. */
export type OAuthTokens = StoredOAuthTokens & { expiresAt?: number };

const CREDENTIAL_REJECTIONS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
]);

/** Only an authorization-server verdict retires a credential; transport failures remain retryable. */
export function isCredentialRejection(err: unknown): boolean {
  return OAuthError.isInstance(err) && CREDENTIAL_REJECTIONS.has(String(err.code));
}

/** SDK errors may quote a rejected request. Scrub submitted credentials before logging or display. */
export function safeOAuthError(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  client?: StoredOAuthClientInformation,
): Error {
  const text = err instanceof Error ? err.message : String(err);
  const basic = client?.client_secret
    ? btoa(`${client.client_id}:${client.client_secret}`)
    : undefined;
  const encodedBasic = client?.client_secret
    ? btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)
    : undefined;
  const detail = safeServerText(redactSecrets(
    text, [...secrets, client?.client_secret, basic, encodedBasic]));
  return new Error(detail ?? "The authorization server refused the request.");
}

/** Best-effort RFC 7009 revocation; the SDK does not expose a revocation helper. */
export async function revokeToken(
  discovery: OAuthDiscoveryState,
  client: StoredOAuthClientInformation,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  fetchFn: FetchLike,
): Promise<void> {
  const metadata = discovery.authorizationServerMetadata;
  const endpoint = metadata && "revocation_endpoint" in metadata &&
    typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : undefined;
  if (!endpoint) return;
  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: client.client_id,
  });
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  // The account registers as a public client with token_endpoint_auth_method "none".
  const response = await fetchFn(endpoint, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`Token revocation failed with HTTP ${response.status}.`);
}
