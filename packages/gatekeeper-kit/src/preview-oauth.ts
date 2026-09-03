import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const OAUTH_STATE_MAX_AGE = "10m";
const HEX_64 = /^[0-9a-f]{64}$/i;

type AuthorizationMode =
  | { kind: "direct" }
  | { kind: "preview"; returnUrl: string; signingSecret: string };

/** Runtime configuration shared by stable and preview OAuth gatekeepers. */
export type PreviewOAuthEnv = Readonly<{
  /** Whether callbacks may be relayed to Worker Preview hostnames. */
  OAUTH_ALLOW_PREVIEW_REDIRECTS?: boolean | string;
  /** Stable callback URI registered with the OAuth provider. Set only on previews. */
  OAUTH_REDIRECT_URI?: string;
  /** HMAC secret shared by the stable Worker and its previews. */
  OAUTH_STATE_SIGNING_SECRET?: string;
}>;

/** Gatekeeper-owned identifiers carried through an OAuth authorization round trip. */
export type PreviewOAuthState = Readonly<{
  /** Durable Object ID for the account completing authorization. */
  userObjectId: string;
  /** Single-use nonce for the OAuth callback stage. */
  oauthNonce: string;
}>;

/** Result of verifying an OAuth callback and applying preview relay policy. */
export type PreviewOAuthCallbackResult =
  | Readonly<{
    /** Indicates that this Worker owns the callback. */
    kind: "local";
    /** Verified account and nonce identifiers. */
    state: PreviewOAuthState;
  }>
  | Readonly<{
    /** Indicates that the stable Worker must relay the callback to its preview. */
    kind: "relay";
    /** Redirect containing only the provider result and unchanged signed state. */
    response: Response;
  }>;

/** Thrown when preview OAuth runtime configuration is incomplete or invalid. */
export class PreviewOAuthConfigurationError extends Error {
  /**
   * @param message Display-safe configuration failure.
   * @param options Optional error cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreviewOAuthConfigurationError";
  }
}

function configurationUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new PreviewOAuthConfigurationError(`${label} must be a valid absolute URL.`, {
      cause: error,
    });
  }
}

function validatePreviewConfigurationUrl(url: URL, label: string): void {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new PreviewOAuthConfigurationError(`${label} must use HTTPS or HTTP on localhost.`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new PreviewOAuthConfigurationError(
      `${label} must not include credentials, a query, or a fragment.`,
    );
  }
}

function stateKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function previewRedirectsEnabled(env: PreviewOAuthEnv): boolean {
  const value = env.OAUTH_ALLOW_PREVIEW_REDIRECTS;
  return value === true || value === "true";
}

function parseLocalState(state: object): PreviewOAuthState {
  const allowedKeys = new Set(["userObjectId", "oauthNonce"]);
  const value = state as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowedKeys.has(key)) ||
      typeof value.userObjectId !== "string" || !HEX_64.test(value.userObjectId) ||
      typeof value.oauthNonce !== "string" || !HEX_64.test(value.oauthNonce)) {
    throw new Error("Invalid OAuth state");
  }
  return { userObjectId: value.userObjectId, oauthNonce: value.oauthNonce };
}

function parseSignedState(payload: JWTPayload): PreviewOAuthState & { returnUrl?: string } {
  const allowedKeys = new Set(["userObjectId", "oauthNonce", "returnUrl", "iat", "exp"]);
  if (Object.keys(payload).some(key => !allowedKeys.has(key)) ||
      typeof payload.userObjectId !== "string" || !HEX_64.test(payload.userObjectId) ||
      typeof payload.oauthNonce !== "string" || !HEX_64.test(payload.oauthNonce) ||
      (payload.returnUrl !== undefined && typeof payload.returnUrl !== "string")) {
    throw new Error("Invalid OAuth state");
  }
  return {
    userObjectId: payload.userObjectId,
    oauthNonce: payload.oauthNonce,
    ...(payload.returnUrl === undefined ? {} : { returnUrl: payload.returnUrl }),
  };
}

function encodeLegacyState(state: PreviewOAuthState): string {
  return `${state.userObjectId}:${state.oauthNonce}`;
}

function decodeLegacyState(state: string): PreviewOAuthState {
  const match = /^([0-9a-f]{64}):([0-9a-f]{64})$/i.exec(state);
  if (!match?.[1] || !match[2]) throw new Error("Invalid OAuth state");
  return { userObjectId: match[1], oauthNonce: match[2] };
}

function isSignedState(state: string): boolean {
  return state.split(".").length === 3;
}

function validateReturnUrl(returnUrl: string, callback: URL, enabled: boolean): URL {
  const url = new URL(returnUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Invalid OAuth return URL protocol");
  }
  if (url.pathname !== callback.pathname || url.search || url.hash || url.username || url.password) {
    throw new Error("Invalid OAuth return URL path");
  }

  // Worker Preview hosts use either <preview-slug>-<deployed-host> or
  // <preview-slug>.<deployed-host>.
  const allowed = url.origin === callback.origin || Boolean(
    enabled &&
    url.protocol === callback.protocol &&
    url.port === callback.port &&
    (url.hostname.endsWith(`-${callback.hostname}`) ||
      url.hostname.endsWith(`.${callback.hostname}`)),
  );
  if (!allowed) throw new Error("Invalid OAuth return URL host");
  return url;
}

function isCurrentCallback(url: URL, callback: URL): boolean {
  return url.origin === callback.origin && url.pathname === callback.pathname;
}

function relayCallback(target: URL, callbackUrl: URL, state: string): Response {
  for (const key of ["code", "error"]) {
    const value = callbackUrl.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

/** Preview-safe OAuth state and callback handling for one gatekeeper deployment. */
export class PreviewOAuth {
  readonly #authorizationMode: AuthorizationMode;
  readonly #callback: URL;
  readonly #enabled: boolean;
  readonly #signingSecret: string | undefined;

  /** Exact callback URI to send to the provider and retain for the code exchange. */
  readonly redirectUri: string;

  /**
   * Validates the current callback and stable/preview configuration. The `redirectUri` property must
   * be retained with the OAuth nonce and reused unchanged during authorization-code exchange.
   * @param options Current callback URI and the shared preview OAuth environment.
   */
  constructor(options: {
    /** Exact callback URI served by the current Worker. */
    callbackUri: string;
    /** Stable/preview runtime variables and signing secret. */
    env: PreviewOAuthEnv;
  }) {
    this.#callback = configurationUrl(options.callbackUri, "OAuth callback URI");
    const configuredRedirect = options.env.OAUTH_REDIRECT_URI;
    this.redirectUri = configuredRedirect || options.callbackUri;
    const redirect = configurationUrl(this.redirectUri, "OAUTH_REDIRECT_URI");
    this.#enabled = previewRedirectsEnabled(options.env);
    const returnUrl = configuredRedirect && this.#callback.href !== redirect.href
      ? options.callbackUri
      : undefined;
    const signingSecret = options.env.OAUTH_STATE_SIGNING_SECRET;

    if (returnUrl) {
      if (!this.#enabled) {
        throw new PreviewOAuthConfigurationError(
          "OAUTH_ALLOW_PREVIEW_REDIRECTS must be enabled when OAUTH_REDIRECT_URI differs from the callback URI",
        );
      }
      if (!signingSecret) {
        throw new PreviewOAuthConfigurationError("OAuth state signing secret is not configured.");
      }
      validatePreviewConfigurationUrl(this.#callback, "OAuth callback URI");
      validatePreviewConfigurationUrl(redirect, "OAUTH_REDIRECT_URI");
      try {
        validateReturnUrl(returnUrl, redirect, this.#enabled);
      } catch (error) {
        throw new PreviewOAuthConfigurationError(
          "OAuth callback URI must be an allowed Worker Preview callback for OAUTH_REDIRECT_URI.",
          { cause: error },
        );
      }
      this.#authorizationMode = { kind: "preview", returnUrl, signingSecret };
    } else {
      this.#authorizationMode = { kind: "direct" };
    }
    this.#signingSecret = signingSecret;
  }

  /**
   * Encodes authorization state, using the legacy direct form for a local callback and a signed JWT
   * when the result must return through a stable Worker.
   * @param state Durable Object ID and one-time OAuth nonce.
   * @returns Provider-facing OAuth state.
   */
  async createAuthorizationState(state: PreviewOAuthState): Promise<string> {
    const parsed = parseLocalState(state);
    if (this.#authorizationMode.kind === "direct") return encodeLegacyState(parsed);

    return new SignJWT({ ...parsed, returnUrl: this.#authorizationMode.returnUrl })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(OAUTH_STATE_MAX_AGE)
      .sign(stateKey(this.#authorizationMode.signingSecret));
  }

  /**
   * Verifies a callback and either returns local state or a validated relay response.
   * @param callbackUrl Provider callback URL received by the Worker.
   * @returns A local callback or completed relay result.
   */
  async handleCallback(callbackUrl: URL): Promise<PreviewOAuthCallbackResult> {
    const encodedState = callbackUrl.searchParams.get("state");
    if (!encodedState) throw new Error("No OAuth state was provided");

    let state: PreviewOAuthState & { returnUrl?: string };
    if (isSignedState(encodedState)) {
      if (!this.#signingSecret) {
        throw new PreviewOAuthConfigurationError("OAuth state signing secret is not configured.");
      }
      const { payload } = await jwtVerify(encodedState, stateKey(this.#signingSecret), {
        algorithms: ["HS256"],
        requiredClaims: ["iat", "exp"],
      });
      state = parseSignedState(payload);
    } else {
      state = decodeLegacyState(encodedState);
    }

    if (state.returnUrl) {
      if (!this.#enabled) throw new Error("OAuth return URLs are not allowed.");
      const target = validateReturnUrl(state.returnUrl, this.#callback, this.#enabled);
      if (!isCurrentCallback(target, this.#callback)) {
        return { kind: "relay", response: relayCallback(target, callbackUrl, encodedState) };
      }
    }

    return {
      kind: "local",
      state: { userObjectId: state.userObjectId, oauthNonce: state.oauthNonce },
    };
  }
}
