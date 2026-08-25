import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

const OAUTH_CALLBACK_PATH = "/oauth";
const OAUTH_STATE_MAX_AGE = "10m";
const HEX_64 = /^[0-9a-f]{64}$/i;

export type GoogleOAuthEnv = {
  BASE_URL?: string;
  OAUTH_ALLOW_PREVIEW_REDIRECTS?: boolean | string;
  OAUTH_REDIRECT_URI?: string;
  OAUTH_STATE_SIGNING_SECRET?: string;
};

export type GoogleOAuthState = {
  userObjectId: string;
  oauthNonce: string;
  returnUrl?: string;
};

export function getBaseUrl(env: GoogleOAuthEnv): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/google");
}

export function getBasePath(env: GoogleOAuthEnv): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

export function getGoogleOAuthCallbackUri(env: GoogleOAuthEnv): string {
  return `${getBaseUrl(env)}${OAUTH_CALLBACK_PATH}`;
}

export function getRegisteredGoogleOAuthRedirectUri(env: GoogleOAuthEnv): string {
  return env.OAUTH_REDIRECT_URI || getGoogleOAuthCallbackUri(env);
}

export function isGoogleOAuthPreviewRedirectEnabled(env: GoogleOAuthEnv): boolean {
  const value = env.OAUTH_ALLOW_PREVIEW_REDIRECTS;
  return value === true || value === "true";
}

export function getDynamicGoogleOAuthReturnUrl(env: GoogleOAuthEnv): string | undefined {
  if (!env.OAUTH_REDIRECT_URI) return undefined;
  const callback = getGoogleOAuthCallbackUri(env);
  if (new URL(callback).href === new URL(env.OAUTH_REDIRECT_URI).href) return undefined;
  if (!isGoogleOAuthPreviewRedirectEnabled(env)) {
    throw new Error(
      "OAUTH_ALLOW_PREVIEW_REDIRECTS must be enabled when OAUTH_REDIRECT_URI differs from BASE_URL",
    );
  }
  return callback;
}

function oauthStateKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function parseGoogleOAuthState(payload: JWTPayload): GoogleOAuthState {
  const allowedKeys = new Set(["userObjectId", "oauthNonce", "returnUrl", "iat", "exp"]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
      typeof payload.userObjectId !== "string" || !HEX_64.test(payload.userObjectId) ||
      typeof payload.oauthNonce !== "string" || !HEX_64.test(payload.oauthNonce) ||
      (payload.returnUrl !== undefined && typeof payload.returnUrl !== "string")) {
    throw new Error("Invalid Google OAuth state");
  }
  return {
    userObjectId: payload.userObjectId,
    oauthNonce: payload.oauthNonce,
    ...(payload.returnUrl === undefined ? {} : { returnUrl: payload.returnUrl }),
  };
}

export async function encodeGoogleOAuthState(
    state: GoogleOAuthState, secret: string): Promise<string> {
  const payload = parseGoogleOAuthState(state);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(OAUTH_STATE_MAX_AGE)
    .sign(oauthStateKey(secret));
}

export async function decodeGoogleOAuthState(
    state: string, secret: string): Promise<GoogleOAuthState> {
  const { payload } = await jwtVerify(state, oauthStateKey(secret), {
    algorithms: ["HS256"],
    requiredClaims: ["iat", "exp"],
  });
  return parseGoogleOAuthState(payload);
}

export function encodeLegacyGoogleOAuthState(state: GoogleOAuthState): string {
  return `${state.userObjectId}:${state.oauthNonce}`;
}

export function decodeLegacyGoogleOAuthState(state: string): GoogleOAuthState {
  const match = /^([0-9a-f]{64}):([0-9a-f]{64})$/i.exec(state);
  if (!match?.[1] || !match[2]) throw new Error("Invalid Google OAuth state");
  return { userObjectId: match[1], oauthNonce: match[2] };
}

export function isSignedGoogleOAuthState(state: string): boolean {
  return state.split(".").length === 3;
}

export function validateGoogleOAuthReturnUrl(returnUrl: string, env: GoogleOAuthEnv): URL {
  const url = new URL(returnUrl);
  const callback = new URL(getGoogleOAuthCallbackUri(env));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Invalid Google OAuth return URL protocol");
  }
  if (url.pathname !== callback.pathname || url.search || url.hash || url.username || url.password) {
    throw new Error("Invalid Google OAuth return URL path");
  }

  // Worker Preview hosts use either <preview-slug>-<deployed-host> or
  // <preview-slug>.<deployed-host>.
  const allowed = url.origin === callback.origin || Boolean(
    isGoogleOAuthPreviewRedirectEnabled(env) &&
    url.protocol === callback.protocol &&
    url.port === callback.port &&
    (url.hostname.endsWith(`-${callback.hostname}`) ||
      url.hostname.endsWith(`.${callback.hostname}`)),
  );
  if (!allowed) throw new Error("Invalid Google OAuth return URL host");
  return url;
}

export function isCurrentGoogleOAuthCallback(url: URL, env: GoogleOAuthEnv): boolean {
  const callback = new URL(getGoogleOAuthCallbackUri(env));
  return url.origin === callback.origin && url.pathname === callback.pathname;
}

export function redirectToGoogleOAuthReturnUrl(
    target: URL, callbackUrl: URL, state: string): Response {
  for (const key of ["code", "error"]) {
    const value = callbackUrl.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}
