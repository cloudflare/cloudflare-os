// Sign in with ChatGPT: the OAuth flow that lets a user run OpenAI models on their own ChatGPT
// subscription (see docs/chatgpt-sign-in.md). It is pi's public-client flow (pi-ai's
// auth/oauth/openai-chatgpt), minus the local callback server it listens with: OpenAI accepts only
// loopback redirects, so unless the Workshop itself is served from one, the browser lands on an
// address nothing answers and the user pastes it back. Pure apart from `fetch`, which tests replace.

import { CHATGPT_CALLBACK_PATH } from "@gadgets/workshop-shared/api";

/**
 * Where OpenAI sends the browser once the user has signed in, unless the Workshop is served from a
 * loopback address (see chatGptRedirectUri()); the same address pi and Codex use.
 */
export const CHATGPT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

/**
 * The redirect for a Workshop served at `publicBaseUrl`: its own CHATGPT_CALLBACK_PATH when that is
 * an http loopback address with a port, the only kind OpenAI accepts besides CHATGPT_REDIRECT_URI
 * (as in local development), and otherwise CHATGPT_REDIRECT_URI.
 */
export function chatGptRedirectUri(publicBaseUrl: string | undefined): string {
  let url = URL.parse(publicBaseUrl ?? "");
  let loopback = url?.protocol === "http:" && url.port !== "" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return loopback ? `${url!.origin}${CHATGPT_CALLBACK_PATH}` : CHATGPT_REDIRECT_URI;
}

/**
 * The API a ChatGPT sign-in's token is for. pi recognizes a sign-in by this exact base URL (with a
 * key that isn't an API key) and leaves out the request fields the subscription refuses.
 */
export const CHATGPT_API_BASE_URL = "https://api.openai.com/v1";

/** How long a started sign-in can be completed. */
export const CHATGPT_SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
// Every sign-in registers a new client under this ID; the callback carries the ID it was issued.
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry, so that no request starts with a token about to lapse.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

/** A started sign-in, held by the user's object until its callback arrives or it expires. */
export type PendingChatGptSignIn = {
  redirectUri: string;
  state: string;
  verifier: string;
  nonce: string;
  expiresAt: Date;
};

/** A ChatGPT sign-in. Secret: never logged, and never leaves the user's object but as a token. */
export type ChatGptCredential = {
  accessToken: string;
  refreshToken: string;
  /** When to stop sending `accessToken`, a little before OpenAI says it expires. */
  expiresAt: Date;
  /** The client ID OpenAI issued this sign-in, which refreshing it requires. */
  clientId: string;
  /** The ChatGPT account's email, when OpenAI reported one. For display only. */
  email?: string;
};

/** An access token from a ChatGPT sign-in, and when to stop sending it. */
export type ChatGptAccessToken = { token: string; expiresAt: Date };

/** The sign-in was refused at refresh: revoked, expired, or signed out elsewhere. */
export class ChatGptGrantRevoked extends Error {}

type Fetch = typeof fetch;

function randomValue(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toBase64({alphabet: "base64url", omitPadding: true});
}

/**
 * Start a sign-in for the installation `agentHostId` (a UUID OpenAI identifies the agent host by)
 * that returns to `redirectUri` (see chatGptRedirectUri()). Returns the page to send the user to
 * and what completing the sign-in will need.
 */
export async function startSignIn(agentHostId: string, redirectUri: string)
    : Promise<{ authorizeUrl: string; pending: PendingChatGptSignIn }> {
  let verifier = randomValue();
  let challenge = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(verifier))).toBase64({alphabet: "base64url", omitPadding: true});
  let pending: PendingChatGptSignIn = {
    redirectUri,
    state: randomValue(),
    verifier,
    nonce: randomValue(),
    expiresAt: new Date(Date.now() + CHATGPT_SIGN_IN_LIFETIME_MS),
  };
  let url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: "Gadgets",
    ext_agent_host_id: `urn:uuid:${agentHostId}`,
    response_type: "code",
    redirect_uri: redirectUri,
    resource: CHATGPT_API_BASE_URL,
    scope: SCOPE,
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: pending.nonce,
  }).toString();
  return { authorizeUrl: url.toString(), pending };
}

/**
 * The authorization code and issued client ID in the address the browser was sent to, which the
 * user pasted. Throws if it is not the callback of `pending`, or OpenAI refused the sign-in.
 */
export function parseCallback(callbackUrl: string, pending: PendingChatGptSignIn)
    : { code: string; clientId: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new Error("Paste the full address from the tab that ChatGPT sent you to.");
  }
  let expected = new URL(pending.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`The address should start with ${pending.redirectUri}.`);
  }
  if (url.searchParams.get("state") !== pending.state) {
    throw new Error("That address is from a different sign-in. Paste the one from the tab you " +
        "signed in with most recently.");
  }
  let error = url.searchParams.get("error");
  if (error) throw new Error(`ChatGPT refused the sign-in (${error}).`);
  let code = url.searchParams.get("code");
  let clientId = url.searchParams.get("client_id")?.trim();
  if (!code || !clientId) throw new Error("That address is missing part of the sign-in.");
  return { code, clientId };
}

/** Exchange the code from parseCallback() for a sign-in. */
export async function exchangeCode(
    callback: { code: string; clientId: string }, pending: PendingChatGptSignIn,
    fetchFn: Fetch = fetch): Promise<ChatGptCredential> {
  let token = await requestToken(fetchFn, {
    grant_type: "authorization_code",
    client_id: callback.clientId,
    code: callback.code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: CHATGPT_API_BASE_URL,
  });
  // The ID token came straight from OpenAI over TLS, so its claims are read without checking its
  // signature. Its nonce ties it to this sign-in; its email is only shown to the user.
  let claims = typeof token.id_token === "string" ? decodeJwtClaims(token.id_token) : undefined;
  if (claims?.nonce !== pending.nonce) {
    throw new Error("ChatGPT's sign-in response did not match this sign-in.");
  }
  let credential = credentialFrom(token, callback.clientId, undefined);
  if (typeof claims.email === "string") credential.email = claims.email;
  return credential;
}

/**
 * Refresh `credential`'s access token. Throws ChatGptGrantRevoked if OpenAI no longer honors the
 * sign-in, so the user must sign in again.
 */
export async function refreshCredential(credential: ChatGptCredential, fetchFn: Fetch = fetch)
    : Promise<ChatGptCredential> {
  let token = await requestToken(fetchFn, {
    grant_type: "refresh_token",
    client_id: credential.clientId,
    refresh_token: credential.refreshToken,
    resource: CHATGPT_API_BASE_URL,
  });
  let refreshed = credentialFrom(token, credential.clientId, credential.refreshToken);
  if (credential.email !== undefined) refreshed.email = credential.email;
  return refreshed;
}

async function requestToken(fetchFn: Fetch, body: Record<string, string>)
    : Promise<Record<string, unknown>> {
  let response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  let data: unknown = await response.json().catch(() => undefined);
  let fields = typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown> : {};
  if (!response.ok) {
    // Only OAuth's error fields are quoted: they say why, and hold nothing secret.
    let error = typeof fields.error === "string" ? fields.error : undefined;
    if (error === "invalid_grant") {
      throw new ChatGptGrantRevoked("Your ChatGPT sign-in has expired or was revoked.");
    }
    let description = typeof fields.error_description === "string"
        ? `: ${fields.error_description}` : "";
    throw new Error(`ChatGPT sign-in failed (${response.status}${error ? ` ${error}` : ""})` +
        description);
  }
  return fields;
}

// The sign-in a token response describes. A refresh that returns no new refresh token keeps
// `previousRefresh`; one that returns no scope keeps the scope it was granted.
function credentialFrom(token: Record<string, unknown>, clientId: string,
                        previousRefresh: string | undefined): ChatGptCredential {
  let accessToken = token.access_token;
  let refreshToken = token.refresh_token ?? previousRefresh;
  let expiresIn = token.expires_in;
  if (typeof accessToken !== "string" || !accessToken ||
      typeof refreshToken !== "string" || !refreshToken ||
      typeof expiresIn !== "number" || !(expiresIn > 0)) {
    throw new Error("ChatGPT's sign-in response was incomplete.");
  }
  let scope = token.scope;
  if (previousRefresh === undefined || scope !== undefined) {
    if (typeof scope !== "string" || !scope.split(/\s+/).includes(DIRECT_TOKEN_SCOPE)) {
      throw new Error("ChatGPT did not grant the access needed to run models.");
    }
  }
  return {
    accessToken,
    refreshToken,
    // A token that lives no longer than twice the margin is kept for half its life instead.
    expiresAt: new Date(Date.now() + expiresIn * 1000 - Math.min(EXPIRY_MARGIN_MS, expiresIn * 500)),
    clientId,
  };
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  try {
    let payload = new TextDecoder().decode(
        Uint8Array.fromBase64(jwt.split(".")[1], {alphabet: "base64url"}));
    let claims: unknown = JSON.parse(payload);
    return typeof claims === "object" && claims !== null ? claims as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
