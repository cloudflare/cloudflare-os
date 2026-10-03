// End-to-end interop of `./oauth-client` with the connect handshake and `CredentialCoordinator`,
// in workerd because `claimOAuth` compares nonces with `crypto.subtle.timingSafeEqual`.

import { describe, expect, it } from "vitest";
import { advanceToOAuth, claimOAuth, putInitiation } from "../../src/connect-handshake";
import { CredentialCoordinator, isCredentialsExpired } from "../../src/credentials";
import {
  createPkce,
  mergeOAuthTokens,
  OAuthClient,
  type OAuthGrant,
  type OAuthTokens,
  oauthRefresh,
  pkceChallenge,
} from "../../src/oauth-client";
import { fakeKv } from "../fake-kv";

const REDIRECT_URI = "https://gatekeeper.example/oauth";
const TOKEN_URL = "https://vendor.example/oauth/token";
const REVOKE_URL = "https://vendor.example/oauth/revoke";

type Grant = OAuthGrant & { accountId: string };
type ConnectAttempt = { codeVerifier: string; redirectUri: string; startedUnder: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A fake provider: the token endpoint answers through `respond`; revocations are recorded. */
function fakeProvider() {
  const provider = {
    tokenRequests: [] as URLSearchParams[],
    revoked: [] as string[],
    respond: (_: URLSearchParams): Response | Promise<Response> =>
      json({ access_token: "at", expires_in: 3600 }),
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const form = new URLSearchParams(String(init.body));
      if (url === REVOKE_URL) {
        provider.revoked.push(form.get("token")!);
        return new Response(null, { status: 200 });
      }
      provider.tokenRequests.push(form);
      return provider.respond(form);
    },
  };
  return provider;
}

function setup() {
  const provider = fakeProvider();
  const client = new OAuthClient({
    label: "Vendor",
    client: { method: "basic", id: "client", secret: "secret" },
    authorizationEndpoint: "https://vendor.example/oauth/authorize",
    tokenEndpoint: TOKEN_URL,
    revocationEndpoint: REVOKE_URL,
    fetch: provider.fetch,
  });
  const kv = fakeKv();
  const creds = new CredentialCoordinator<Grant>(kv, {
    expiresAt: grant => grant.expiresAt,
    discardMint: mint => client.revoke({ token: mint.refreshToken!, tokenTypeHint: "refresh_token" }),
  });
  const refresh = oauthRefresh<Grant>(client, {
    refreshToken: grant => grant.refreshToken,
    merge: mergeOAuthTokens,
    expiredMessage: "Reconnect your Vendor account.",
  });
  return { provider, client, kv, creds, refresh };
}

/** Maps a code exchange onto the stored grant, picking fields rather than spreading. */
function toGrant(accountId: string, tokens: OAuthTokens): Grant {
  const grant: Grant = { accountId, accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken, scopes: tokens.scopes ?? [] };
  if (tokens.expiresAt !== undefined) grant.expiresAt = tokens.expiresAt;
  return grant;
}

const grantA: Grant = { accountId: "a", accessToken: "at-a", refreshToken: "rt-a",
  scopes: ["read"], expiresAt: Date.now() + 3_600_000 };
const grantB: Grant = { accountId: "a", accessToken: "at-b", refreshToken: "rt-b",
  scopes: ["read"], expiresAt: Date.now() + 3_600_000 };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection.");
}

describe("oauth-client with the connect handshake and CredentialCoordinator", () => {
  it("connects through PKCE, then refreshes once after expiry", async () => {
    const { provider, client, kv, creds, refresh } = setup();
    let challenge: string | null = null;
    provider.respond = async form => {
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
        expect(await pkceChallenge(form.get("code_verifier")!)).toBe(challenge);
        // Inside the coordinator's default 60s skew, so the first read refreshes.
        return json({ access_token: "at-1", refresh_token: "rt-1", scope: "read write",
          expires_in: 30 });
      }
      return json({ access_token: "at-2", expires_in: 3600 });
    };

    const now = Date.now();
    const pkce = await createPkce();
    putInitiation(kv, "link-nonce", now);
    const oauthNonce = advanceToOAuth<ConnectAttempt>(kv, "link-nonce", now, {
      codeVerifier: pkce.codeVerifier,
      redirectUri: REDIRECT_URI,
      startedUnder: creds.connectionGeneration(),
    });
    expect(oauthNonce).not.toBeNull();
    const url = client.authorizationUrl({ redirectUri: REDIRECT_URI, state: oauthNonce!,
      scopes: ["read", "write"], codeChallenge: pkce.codeChallenge });
    challenge = url.searchParams.get("code_challenge");

    const claim = claimOAuth<ConnectAttempt>(kv, url.searchParams.get("state")!, now);
    expect(claim).not.toBeNull();
    const tokens = await client.exchangeCode({ code: "auth-code", redirectUri: claim!.redirectUri,
      codeVerifier: claim!.codeVerifier });
    creds.connect(toGrant("a", tokens), { ifGeneration: claim!.startedUnder });

    const refreshed = await creds.fresh(refresh);
    expect(refreshed).toMatchObject({ accountId: "a", accessToken: "at-2", refreshToken: "rt-1",
      scopes: ["read", "write"] });
    expect(provider.tokenRequests.map(form => form.get("grant_type")))
      .toEqual(["authorization_code", "refresh_token"]);
    expect(provider.tokenRequests[1].get("refresh_token")).toBe("rt-1");

    expect(await creds.fresh(refresh)).toEqual(refreshed);
    expect(provider.tokenRequests).toHaveLength(2);
  });

  it("revokes exactly the mint a reconnect overtook", async () => {
    const { provider, creds, refresh } = setup();
    creds.connect(grantA);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    provider.respond = async () => {
      reached.resolve();
      await release.promise;
      return json({ access_token: "at-minted", refresh_token: "rt-minted", expires_in: 3600 });
    };

    const rotating = creds.rotate(refresh);
    await reached.promise;
    creds.connect(grantB);
    release.resolve();

    expect(await rotating).toEqual(grantB);
    expect(provider.revoked).toEqual(["rt-minted"]);
    expect(creds.stored()).toEqual(grantB);
  });

  it.each([
    ["a 503", () => json({ error: "invalid_grant" }, 503)],
    ["a spoofed credential mark", () => json({ error: "CredentialsExpiredError" }, 400)],
  ])("does not adjudicate %s as death", async (_, response) => {
    const { provider, creds, refresh } = setup();
    creds.connect(grantA);
    provider.respond = response;
    let notified = 0;

    expect(await creds.adjudicateRejection(creds.identity(),
      { refresh, notify: async () => void notified++ })).toBe("unavailable");
    expect(notified).toBe(0);
    expect(creds.stored()).toEqual(grantA);
    expect(await creds.fresh(refresh)).toEqual(grantA);
  });

  it("adjudicates invalid_grant as death, notifies once, and stops requesting", async () => {
    const { provider, creds, refresh } = setup();
    creds.connect(grantA);
    provider.respond = () => json({ error: "invalid_grant" }, 400);
    let notified = 0;

    expect(await creds.adjudicateRejection(creds.identity(),
      { refresh, notify: async () => void notified++ })).toBe("expired");
    expect(notified).toBe(1);
    expect(isCredentialsExpired(await rejection(creds.fresh(refresh)))).toBe(true);
    expect(provider.tokenRequests).toHaveLength(1);
  });
});
