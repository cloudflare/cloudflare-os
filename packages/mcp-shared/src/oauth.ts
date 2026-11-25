import {
  OAuthError,
  type FetchLike,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { clientName, type ConnectionEnv } from "./connection.js";
import { redactSecrets, safeServerText } from "./util.js";

/** SDK tokens plus the absolute expiry used by the account's hot path. */
export type OAuthTokens = StoredOAuthTokens & { expiresAt?: number };

/** Where a connector serves its Client ID Metadata Document, relative to its base URL. */
export const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/**
 * The connector's OAuth client: registered dynamically (RFC 7591), or, where the authorization
 * server supports Client ID Metadata Documents, identified by the URL serving this same document,
 * which that server fetches instead of taking a registration.
 *
 * The document is opt-in (`MCP_CLIENT_METADATA_DOCUMENT`) because the authorization server fetches
 * it without the user's cookies: behind Cloudflare Access it is unreachable until that path is
 * exempted, and the SDK prefers it over registration wherever both are offered, so turning it on
 * unexempted would break servers that registration serves today. It also needs an `https:` base
 * URL, which the SDK requires and local dev lacks. Otherwise `metadataUrl` is `undefined`.
 */
export function oauthClient(baseUrl: string, env: ConnectionEnv) {
  const metadataUrl = env.MCP_CLIENT_METADATA_DOCUMENT === "true" &&
      new URL(baseUrl).protocol === "https:"
    ? `${baseUrl}${CLIENT_METADATA_PATH}`
    : undefined;
  return {
    metadataUrl,
    // No `client_id`: a registration request must not carry one. The served document adds it.
    metadata: {
      client_name: clientName(env),
      redirect_uris: [`${baseUrl}/oauth`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

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
