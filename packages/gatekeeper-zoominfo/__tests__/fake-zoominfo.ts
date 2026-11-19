// ZoomInfo, faked at the `fetch` boundary for the workerd suite. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the test file, TestHooks and the Durable Objects all run in
// one isolate. Tokens and codes name users. The token endpoint redeems an authorization code or a
// refresh token once, returning a new grant and, as ZoomInfo documents for both, an ID token naming
// the user; the data API answers with JSON:API documents. Anything else fails the test.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { CredentialCoordinator } from "@gadgets/gatekeeper-kit/credentials";

/** The OAuth client the suite's gatekeeper runs as (see vitest.config.ts). */
export const CLIENT_ID = "test-client-id";

export type FakeUser = { sub: string; name: string; email: string };

export const ALICE: FakeUser = { sub: "00u1alice", name: "Alice", email: "alice@example.com" };
export const BOB: FakeUser = { sub: "00u2bob", name: "Bob", email: "bob@example.com" };

export type FakeRequest = { method: string; path: string; token?: string };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWT with `claims` and a signature nobody checks, as the token endpoint's ID token is used. */
function unsignedJwt(claims: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "RS256", kid: "test" })}.${base64UrlJson(claims)}.signature`;
}

const GRANTED_SCOPES = ["api:data:company", "api:data:contact"];

export class FakeZoomInfo {
  readonly requests: FakeRequest[] = [];
  /** The claims of the ID token a grant for `user` carries; `null` sends none. */
  idToken: (user: FakeUser) => Record<string, unknown> | null =
    user => ({ sub: user.sub, aud: CLIENT_ID, name: user.name, email: user.email });
  /** Enrichments fail as an outage would. */
  failEnrichment = false;
  /** How long the token endpoint takes to answer, so requests to it can overlap. */
  tokenLatencyMs = 0;
  /** While set, the token endpoint holds each refresh until it settles, so a test can act mid-refresh. */
  holdRefreshes?: Promise<void>;
  /** While set, the token endpoint refuses each refresh with this OAuth error. */
  refuseRefreshes?: { status: number; error: string };
  /** Scopes the provider requests when a refresh omits scope; may exceed the original grant. */
  refreshScopeDefaults: readonly string[] = GRANTED_SCOPES;
  /** While set, the data API holds each lookup until it settles, so a test can act mid-load. */
  holdLookups?: Promise<void>;
  /** The user each live access token, refresh token and authorization code belongs to. */
  readonly #owners = new Map<string, FakeUser>();
  #issued = 0;

  install(): this {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.#handle(new Request(input, init)));
    return this;
  }

  /** A new access and refresh token for `user`. */
  grant(user: FakeUser): { accessToken: string; refreshToken: string } {
    const n = ++this.#issued;
    const grant = { accessToken: `access-${user.sub}-${n}`, refreshToken: `refresh-${user.sub}-${n}` };
    this.#owners.set(grant.accessToken, user).set(grant.refreshToken, user);
    return grant;
  }

  /** The authorization code ZoomInfo redirects back with once `user` signs in. */
  code(user: FakeUser): string {
    const code = `code-${++this.#issued}`;
    this.#owners.set(code, user);
    return code;
  }

  /** How many requests matched `pattern`, tested against `METHOD /path`. */
  count(pattern: RegExp): number {
    return this.requests.filter(request => pattern.test(`${request.method} ${request.path}`)).length;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    this.requests.push({ method: request.method, path: url.pathname, token });
    if (url.origin !== "https://api.zoominfo.com") throw new Error(`Unexpected request: ${url}`);
    if (url.pathname === "/gtm/oauth/v1/token") {
      const form = new URLSearchParams(await request.text());
      if (this.tokenLatencyMs > 0) await scheduler.wait(this.tokenLatencyMs);
      if (form.get("grant_type") === "refresh_token") {
        await this.holdRefreshes;
        if (this.refuseRefreshes) return json({ error: this.refuseRefreshes.error }, this.refuseRefreshes.status);
      }
      return this.#token(form);
    }

    const user = token === undefined ? undefined : this.#owners.get(token);
    if (!user) return json({ errors: [{ detail: "Invalid token" }] }, 401);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /gtm/data/v1/companies/search":
        return json({ data: [{ type: "Company", id: "7", attributes: { name: "Acme" } }], meta: { totalResults: 1 } });
      case "POST /gtm/data/v1/companies/enrich":
        if (this.failEnrichment) return json({ errors: [{ detail: "Service unavailable" }] }, 503);
        return json({ data: [{
          type: "Company", id: "7", attributes: { name: "Acme", enrichedFor: user.name },
          meta: { matchStatus: "FULL_MATCH" },
        }] });
      case "GET /gtm/data/v1/users/usage":
        return json({ data: [{ type: "UserUsage", id: "usage", attributes: { usage: [{ limitType: "record", currentUsage: 3 }] } }] });
    }
    // A lookup names its user, so a test can tell whose entitlements shaped a cached value.
    if (url.pathname.startsWith("/gtm/data/v1/lookup/")) {
      await this.holdLookups;
      return json({ data: [{ type: "Value", id: "1", attributes: { name: `${user.name}'s value` } }] });
    }
    // Every other read finds nothing.
    if (/^\/gtm\/(data|copilot)\/v1\//.test(url.pathname)) return json({ data: [] });
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  }

  #token(form: URLSearchParams): Response {
    const redeemed = form.get("grant_type") === "authorization_code" ? form.get("code") : form.get("refresh_token");
    const user = redeemed === null ? undefined : this.#owners.get(redeemed);
    if (!user || redeemed === null) return json({ error: "invalid_grant" }, 400);
    const scopes = form.get("grant_type") === "refresh_token"
      ? (form.get("scope")?.split(" ") ?? this.refreshScopeDefaults)
      : GRANTED_SCOPES;
    if (scopes.some(scope => !GRANTED_SCOPES.includes(scope))) {
      return json({ error: "access_denied", error_description: "Requested scopes exceed the original grant" }, 400);
    }
    this.#owners.delete(redeemed);
    const grant = this.grant(user);
    const claims = this.idToken(user);
    return json({
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      expires_in: 1000,
      scope: scopes.join(" "),
      token_type: "Bearer",
      ...(claims ? { id_token: unsignedJwt(claims) } : {}),
    });
  }
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/**
 * Seeds a connected account for `user` whose token needs no refresh, as a completed connect leaves
 * one, with a Workshop callback. `legacy` stores it as a version from before the gatekeeper kept the
 * user's ID did. Returns the account id.
 */
export async function seedAccount(fake: FakeZoomInfo, user: FakeUser, options: {
  legacy?: boolean; expiresInMs?: number; scopes?: string[];
} = {}): Promise<string> {
  const grant = fake.grant(user);
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), (_instance, state) => {
    const kv = state.storage.kv;
    const stored = {
      ...grant,
      accessTokenExpiresAt: Date.now() + (options.expiresInMs ?? 60 * 60 * 1000),
      scopes: options.scopes ?? ["api:data:company"],
      identity: { displayName: user.name, uniqueName: user.email },
    };
    if (options.legacy) {
      // One key per value, and no user ID.
      for (const [key, value] of Object.entries(stored)) kv.put(key, value);
    } else {
      new CredentialCoordinator(kv).connect({ ...stored, userId: user.sub });
    }
  });
  await hooks().installCallback(id.toString(), generateNonce());
  return id.toString();
}

/** The account's stored grant, read as the kit's CredentialCoordinator holds it. */
export async function storedGrant(userObjectId: string): Promise<Record<string, unknown> | undefined> {
  return await runInDurableObject(accountStub(userObjectId),
    (_instance, state) => new CredentialCoordinator<Record<string, unknown>>(state.storage.kv).stored());
}

/** Runs a reconnect in which `user` signs in to ZoomInfo, through the Workshop's commit. */
export async function reconnectAs(fake: FakeZoomInfo, userObjectId: string, user: FakeUser): Promise<void> {
  const initiation = generateNonce();
  await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation);
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    const handoff = await instance.acceptAuthCode(fake.code(user), flow.oauthNonce);
    if (!handoff) throw new Error("the reconnect was refused");
    await instance.commitReconnect(handoff.ticket);
  });
}

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T>(outcome: { ok: T } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: { ok: unknown } | { error: string }): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}
