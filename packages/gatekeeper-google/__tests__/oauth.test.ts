import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode } from "../src/google-api";
import {
  decodeGoogleOAuthState,
  decodeLegacyGoogleOAuthState,
  encodeGoogleOAuthState,
  encodeLegacyGoogleOAuthState,
  getDynamicGoogleOAuthReturnUrl,
  getRegisteredGoogleOAuthRedirectUri,
  isCurrentGoogleOAuthCallback,
  isGoogleOAuthPreviewRedirectEnabled,
  redirectToGoogleOAuthReturnUrl,
  validateGoogleOAuthReturnUrl,
  type GoogleOAuthState,
} from "../src/oauth";

const STATE_SECRET = "test-state-secret";
const STATE_KEY = new TextEncoder().encode(STATE_SECRET);
const PREVIEW_RETURN_URL =
  "https://preview-gatekeeper-google.gadgets-staging.workers.dev/oauth";
const DOT_PREVIEW_RETURN_URL =
  "https://preview.gatekeeper-google.gadgets-staging.workers.dev/oauth";
const STATE: GoogleOAuthState = {
  userObjectId: "0".repeat(64),
  oauthNonce: "1".repeat(64),
  returnUrl: PREVIEW_RETURN_URL,
};
const STABLE_ENV = {
  BASE_URL: "https://gatekeeper-google.gadgets-staging.workers.dev",
  OAUTH_ALLOW_PREVIEW_REDIRECTS: "true",
};
const PREVIEW_ENV = {
  ...STABLE_ENV,
  BASE_URL: "https://preview-gatekeeper-google.gadgets-staging.workers.dev",
  OAUTH_REDIRECT_URI: "https://gatekeeper-google.gadgets-staging.workers.dev/oauth",
};

afterEach(() => vi.unstubAllGlobals());

describe("Google OAuth callback relay", () => {
  it("round-trips signed and legacy OAuth state", async () => {
    const signed = await encodeGoogleOAuthState(STATE, STATE_SECRET);
    await expect(decodeGoogleOAuthState(signed, STATE_SECRET)).resolves.toEqual(STATE);

    const directState = { userObjectId: STATE.userObjectId, oauthNonce: STATE.oauthNonce };
    expect(decodeLegacyGoogleOAuthState(encodeLegacyGoogleOAuthState(directState)))
      .toEqual(directState);
  });

  it("rejects tampered, expired, and malformed OAuth state", async () => {
    const encoded = await encodeGoogleOAuthState(STATE, STATE_SECRET);
    const segments = encoded.split(".");
    if (segments.length !== 3 || !segments[1]) throw new Error("Expected a three-segment JWT");
    segments[1] = `${segments[1].startsWith("A") ? "B" : "A"}${segments[1].slice(1)}`;
    await expect(decodeGoogleOAuthState(segments.join("."), STATE_SECRET)).rejects.toThrow();

    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT(STATE)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(STATE_KEY);
    await expect(decodeGoogleOAuthState(expired, STATE_SECRET)).rejects.toThrow();
    expect(() => decodeLegacyGoogleOAuthState("not-valid-state")).toThrow(/invalid/i);
  });

  it("uses a direct callback unless a preview has a registered stable redirect", () => {
    expect(isGoogleOAuthPreviewRedirectEnabled(STABLE_ENV)).toBe(true);
    expect(isGoogleOAuthPreviewRedirectEnabled({
      ...STABLE_ENV,
      OAUTH_ALLOW_PREVIEW_REDIRECTS: true,
    })).toBe(true);
    expect(isGoogleOAuthPreviewRedirectEnabled({
      ...STABLE_ENV,
      OAUTH_ALLOW_PREVIEW_REDIRECTS: "false",
    })).toBe(false);
    expect(isGoogleOAuthPreviewRedirectEnabled({
      ...STABLE_ENV,
      OAUTH_ALLOW_PREVIEW_REDIRECTS: "TRUE",
    })).toBe(false);
    expect(getRegisteredGoogleOAuthRedirectUri(STABLE_ENV)).toBe(
      "https://gatekeeper-google.gadgets-staging.workers.dev/oauth",
    );
    expect(getDynamicGoogleOAuthReturnUrl(STABLE_ENV)).toBeUndefined();
    expect(getRegisteredGoogleOAuthRedirectUri(PREVIEW_ENV)).toBe(
      "https://gatekeeper-google.gadgets-staging.workers.dev/oauth",
    );
    expect(getDynamicGoogleOAuthReturnUrl(PREVIEW_ENV)).toBe(STATE.returnUrl);
    expect(() => getDynamicGoogleOAuthReturnUrl({
      ...PREVIEW_ENV,
      OAUTH_ALLOW_PREVIEW_REDIRECTS: "false",
    })).toThrow(/OAUTH_ALLOW_PREVIEW_REDIRECTS/);
  });

  it("accepts only the stable callback and its Worker Preview hosts", () => {
    expect(validateGoogleOAuthReturnUrl(
      "https://gatekeeper-google.gadgets-staging.workers.dev/oauth",
      STABLE_ENV,
    ).hostname).toBe("gatekeeper-google.gadgets-staging.workers.dev");
    expect(validateGoogleOAuthReturnUrl(PREVIEW_RETURN_URL, STABLE_ENV).hostname)
      .toBe("preview-gatekeeper-google.gadgets-staging.workers.dev");
    expect(validateGoogleOAuthReturnUrl(DOT_PREVIEW_RETURN_URL, STABLE_ENV).hostname)
      .toBe("preview.gatekeeper-google.gadgets-staging.workers.dev");
    expect(() => validateGoogleOAuthReturnUrl(PREVIEW_RETURN_URL, {
      ...STABLE_ENV,
      OAUTH_ALLOW_PREVIEW_REDIRECTS: "false",
    })).toThrow(/host/);
    expect(() => validateGoogleOAuthReturnUrl("https://attacker.example/oauth", STABLE_ENV))
      .toThrow(/host/);
    expect(() => validateGoogleOAuthReturnUrl(
      "https://preview-gatekeeper-google.gadgets-staging.workers.dev/not-oauth",
      STABLE_ENV,
    )).toThrow(/path/);
    expect(() => validateGoogleOAuthReturnUrl(`${PREVIEW_RETURN_URL}?next=bad`, STABLE_ENV))
      .toThrow(/path/);
  });

  it("relays only the provider result and unchanged signed state", () => {
    const target = validateGoogleOAuthReturnUrl(PREVIEW_RETURN_URL, STABLE_ENV);
    const callback = new URL(
      "https://gatekeeper-google.gadgets-staging.workers.dev/oauth" +
      "?error=access_denied&error_description=provider-secret",
    );
    const response = redirectToGoogleOAuthReturnUrl(target, callback, "signed-state");
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(STATE.returnUrl);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("signed-state");
    expect(location.searchParams.has("error_description")).toBe(false);
    expect(isCurrentGoogleOAuthCallback(location, STABLE_ENV)).toBe(false);
    expect(isCurrentGoogleOAuthCallback(location, PREVIEW_ENV)).toBe(true);
  });

  it("sends the selected redirect URI unchanged during code exchange", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "openid",
      });
    }));

    await exchangeAuthCode(
      "code",
      "client-id",
      "client-secret",
      PREVIEW_ENV.OAUTH_REDIRECT_URI,
    );

    const body = calls[0]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("redirect_uri")).toBe(PREVIEW_ENV.OAUTH_REDIRECT_URI);
  });
});
