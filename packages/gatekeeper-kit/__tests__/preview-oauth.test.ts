import { decodeJwt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  PreviewOAuth,
  PreviewOAuthConfigurationError,
  type PreviewOAuthEnv,
  type PreviewOAuthState,
} from "../src/preview-oauth";

const STATE_SECRET = "test-state-secret";
const STATE_KEY = new TextEncoder().encode(STATE_SECRET);
const STABLE_CALLBACK = "https://gatekeeper.example.workers.dev/oauth";
const PREVIEW_CALLBACK = "https://preview-gatekeeper.example.workers.dev/oauth";
const DOT_PREVIEW_CALLBACK = "https://preview.gatekeeper.example.workers.dev/oauth";
const STATE: PreviewOAuthState = {
  userObjectId: "0".repeat(64),
  oauthNonce: "1".repeat(64),
};
const STABLE_ENV: PreviewOAuthEnv = {
  OAUTH_ALLOW_PREVIEW_REDIRECTS: "true",
  OAUTH_STATE_SIGNING_SECRET: STATE_SECRET,
};
const PREVIEW_ENV: PreviewOAuthEnv = {
  ...STABLE_ENV,
  OAUTH_REDIRECT_URI: STABLE_CALLBACK,
};

async function signedState(returnUrl: string, extra: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ ...STATE, returnUrl, ...extra })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(STATE_KEY);
}

describe("PreviewOAuth", () => {
  it("keeps direct callbacks on the legacy state wire format", async () => {
    const oauth = new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: {} });
    const encoded = await oauth.createAuthorizationState(STATE);

    expect(oauth.redirectUri).toBe(STABLE_CALLBACK);
    expect(encoded).toBe(`${STATE.userObjectId}:${STATE.oauthNonce}`);
    await expect(oauth.handleCallback(new URL(`${STABLE_CALLBACK}?state=${encoded}`)))
      .resolves.toEqual({ kind: "local", state: STATE });
  });

  it("creates Google's compatible short-lived HS256 state for a preview", async () => {
    const oauth = new PreviewOAuth({ callbackUri: PREVIEW_CALLBACK, env: PREVIEW_ENV });
    const encoded = await oauth.createAuthorizationState(STATE);
    const payload = decodeJwt(encoded);

    expect(oauth.redirectUri).toBe(STABLE_CALLBACK);
    expect(encoded.split(".")).toHaveLength(3);
    expect(payload).toMatchObject({ ...STATE, returnUrl: PREVIEW_CALLBACK });
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(10 * 60);

    await expect(oauth.handleCallback(
      new URL(`${PREVIEW_CALLBACK}?code=code&state=${encodeURIComponent(encoded)}`),
    )).resolves.toEqual({ kind: "local", state: STATE });
  });

  it("requires the exact enable value and a signing secret for dynamic callbacks", () => {
    for (const value of [undefined, false, "false", "TRUE"]) {
      expect(() => new PreviewOAuth({
        callbackUri: PREVIEW_CALLBACK,
        env: { ...PREVIEW_ENV, OAUTH_ALLOW_PREVIEW_REDIRECTS: value },
      })).toThrow(PreviewOAuthConfigurationError);
    }

    expect(() => new PreviewOAuth({
      callbackUri: PREVIEW_CALLBACK,
      env: { ...PREVIEW_ENV, OAUTH_ALLOW_PREVIEW_REDIRECTS: true },
    })).not.toThrow();
    expect(() => new PreviewOAuth({
      callbackUri: PREVIEW_CALLBACK,
      env: { ...PREVIEW_ENV, OAUTH_STATE_SIGNING_SECRET: undefined },
    })).toThrow(/signing secret/i);
  });

  it("returns OAUTH_REDIRECT_URI byte-for-byte", () => {
    const redirectUri = "https://gatekeeper.example.workers.dev:443/oauth";
    const oauth = new PreviewOAuth({
      callbackUri: PREVIEW_CALLBACK,
      env: { ...PREVIEW_ENV, OAUTH_REDIRECT_URI: redirectUri },
    });

    expect(oauth.redirectUri).toBe(redirectUri);
  });

  it("rejects unsafe or unrelated callback configuration before authorization", () => {
    for (const callbackUri of [
      "http://preview-gatekeeper.example.workers.dev/oauth",
      "https://user:pass@preview-gatekeeper.example.workers.dev/oauth",
      `${PREVIEW_CALLBACK}?next=bad`,
      `${PREVIEW_CALLBACK}#fragment`,
      "https://unrelated.example.workers.dev/oauth",
      "https://preview-gatekeeper.example.workers.dev/not-oauth",
    ]) {
      expect(() => new PreviewOAuth({ callbackUri, env: PREVIEW_ENV }))
        .toThrow(PreviewOAuthConfigurationError);
    }
    expect(() => new PreviewOAuth({
      callbackUri: PREVIEW_CALLBACK,
      env: { ...PREVIEW_ENV, OAUTH_REDIRECT_URI: "http://gatekeeper.example.workers.dev/oauth" },
    })).toThrow(PreviewOAuthConfigurationError);
  });

  it("rejects tampered, expired, malformed, and non-HS256 state", async () => {
    const oauth = new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: STABLE_ENV });
    const valid = await signedState(PREVIEW_CALLBACK);
    const segments = valid.split(".");
    if (!segments[1]) throw new Error("Expected a three-segment JWT");
    segments[1] = `${segments[1].startsWith("A") ? "B" : "A"}${segments[1].slice(1)}`;
    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(segments.join("."))}`),
    )).rejects.toThrow();

    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ ...STATE, returnUrl: PREVIEW_CALLBACK })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(STATE_KEY);
    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(expired)}`),
    )).rejects.toThrow();

    const wrongAlgorithm = await new SignJWT({ ...STATE, returnUrl: PREVIEW_CALLBACK })
      .setProtectedHeader({ alg: "HS384", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(STATE_KEY);
    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(wrongAlgorithm)}`),
    )).rejects.toThrow();
    await expect(oauth.handleCallback(new URL(`${STABLE_CALLBACK}?state=not-valid-state`)))
      .rejects.toThrow(/invalid/i);
  });

  it("requires exact signed claims and well-formed local identifiers", async () => {
    const oauth = new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: STABLE_ENV });
    const unexpected = await signedState(PREVIEW_CALLBACK, { unexpected: true });
    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(unexpected)}`),
    )).rejects.toThrow(/invalid/i);

    const missingTimes = await new SignJWT({ ...STATE, returnUrl: PREVIEW_CALLBACK })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(STATE_KEY);
    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(missingTimes)}`),
    )).rejects.toThrow();

    await expect(new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: {} })
      .createAuthorizationState({ ...STATE, userObjectId: "not-an-id" }))
      .rejects.toThrow(/invalid/i);
    await expect(oauth.handleCallback(new URL(STABLE_CALLBACK))).rejects.toThrow(/state/i);
  });

  it("accepts only the stable callback and its Worker Preview hosts", async () => {
    const oauth = new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: STABLE_ENV });
    for (const returnUrl of [STABLE_CALLBACK, PREVIEW_CALLBACK, DOT_PREVIEW_CALLBACK]) {
      const encoded = await signedState(returnUrl);
      await expect(oauth.handleCallback(
        new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(encoded)}`),
      )).resolves.toMatchObject(returnUrl === STABLE_CALLBACK
        ? { kind: "local", state: STATE }
        : { kind: "relay" });
    }

    for (const returnUrl of [
      "https://attacker.example/oauth",
      "https://gatekeeper.example.workers.dev.attacker.example/oauth",
      "https://preview-gatekeeper.example.workers.dev/not-oauth",
      `${PREVIEW_CALLBACK}?next=bad`,
      `${PREVIEW_CALLBACK}#fragment`,
      "https://user:pass@preview-gatekeeper.example.workers.dev/oauth",
      "http://preview-gatekeeper.example.workers.dev/oauth",
      "https://preview-gatekeeper.example.workers.dev:8443/oauth",
    ]) {
      const encoded = await signedState(returnUrl);
      await expect(oauth.handleCallback(
        new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(encoded)}`),
      )).rejects.toThrow(/return URL/i);
    }
  });

  it("does not accept a signed return URL when preview redirects are disabled", async () => {
    const oauth = new PreviewOAuth({
      callbackUri: STABLE_CALLBACK,
      env: { OAUTH_STATE_SIGNING_SECRET: STATE_SECRET },
    });
    const encoded = await signedState(PREVIEW_CALLBACK);

    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(encoded)}`),
    )).rejects.toThrow(/not allowed/i);
  });

  it("requires the shared secret when a stable Worker receives signed state", async () => {
    const oauth = new PreviewOAuth({
      callbackUri: STABLE_CALLBACK,
      env: { OAUTH_ALLOW_PREVIEW_REDIRECTS: "true" },
    });
    const encoded = await signedState(PREVIEW_CALLBACK);

    await expect(oauth.handleCallback(
      new URL(`${STABLE_CALLBACK}?state=${encodeURIComponent(encoded)}`),
    )).rejects.toBeInstanceOf(PreviewOAuthConfigurationError);
  });

  it("relays only the provider result and unchanged signed state", async () => {
    const oauth = new PreviewOAuth({ callbackUri: STABLE_CALLBACK, env: STABLE_ENV });
    const encoded = await signedState(PREVIEW_CALLBACK);
    const callback = new URL(STABLE_CALLBACK);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("error_description", "provider-secret");
    callback.searchParams.set("scope", "private-scope");
    callback.searchParams.set("state", encoded);
    const result = await oauth.handleCallback(callback);
    if (result.kind !== "relay") throw new Error("Expected a relay response");
    const location = new URL(result.response.headers.get("location") ?? "");

    expect(result.response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(PREVIEW_CALLBACK);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(encoded);
    expect(location.searchParams.has("error_description")).toBe(false);
    expect(location.searchParams.has("scope")).toBe(false);
  });

  it("relays successful callbacks behind a shared router path", async () => {
    const stableCallback = "https://router.example.workers.dev/gatekeeper/google/oauth";
    const previewCallback = "https://preview-router.example.workers.dev/gatekeeper/google/oauth";
    const preview = new PreviewOAuth({
      callbackUri: previewCallback,
      env: { ...PREVIEW_ENV, OAUTH_REDIRECT_URI: stableCallback },
    });
    const encoded = await preview.createAuthorizationState(STATE);
    const stable = new PreviewOAuth({ callbackUri: stableCallback, env: STABLE_ENV });
    const result = await stable.handleCallback(
      new URL(`${stableCallback}?code=authorization-code&state=${encodeURIComponent(encoded)}`),
    );
    if (result.kind !== "relay") throw new Error("Expected a relay response");
    const location = new URL(result.response.headers.get("location") ?? "");

    expect(location.origin + location.pathname).toBe(previewCallback);
    expect(location.searchParams.get("code")).toBe("authorization-code");
    expect(location.searchParams.get("state")).toBe(encoded);
  });
});
