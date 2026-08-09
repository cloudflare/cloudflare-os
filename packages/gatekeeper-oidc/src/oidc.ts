// Generic OIDC sign-in connector.
//
// One connector serves every deployment: issuer, client credentials and scopes are configuration,
// so Keycloak, ADFS, Okta on-prem, Authentik and Dex all take the same path. That matters because
// FieldOS runs for multiple customers, each with their own identity provider.
//
// Scope is deliberately narrow. This vendor authenticates and nothing else: it exposes no
// resources, mints no agent-facing sessions, and keeps no access token. Its whole job is to answer
// "who is this?" with an email the Workshop can trust.
//
// The pieces live apart so each can be read on its own:
//   identity.ts  — discovery, and verifying what the provider claims
//   oauth.ts     — nonces, the authorize URL, and the code exchange
//   this file    — the durable state and the Workshop-facing contract

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { obsContext } from "./observability.js";
import {
  AccountDescription,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  OidcConfig, OidcEndpoints, OidcIdentity, OrgClaimConfig, discoverEndpoints, verifyIdToken,
} from "./identity.js";
import {
  INITIATION_NONCE_LIFETIME_MS, OAUTH_NONCE_LIFETIME_MS, StoredNonce,
  authorizeUrl, exchangeCode, generateNonce, nonceIsValid,
} from "./oauth.js";

const VENDOR_ID = "oidc";

// Inlined as a data URI rather than fetched: there is no vendor-hosted logo for "whatever identity
// provider this deployment uses", and an airgapped instance can reach no external image anyway.
const SSO_ICON =
    "data:image/svg+xml;utf8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
        `stroke="#2d6a4f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<rect x="3" y="11" width="18" height="11" rx="2"/>` +
        `<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`);

const logger = obsContext.createLogger({ component: "gatekeeper.oidc", vendorId: VENDOR_ID });

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_SCOPES?: string;
  // Org separation. Unset means this deployment does not use it, and every sign-in resolves to no
  // org. See resolveOrg() in identity.ts for why an unresolvable org is never a default one.
  OIDC_GROUPS_CLAIM?: string;
  OIDC_ORG_PREFIX?: string;
};

// A sign-in grant is read once, for the email, and then discarded. Two minutes is long enough for
// the Workshop to call getAuthenticatedEmail() and far short of anything worth stealing.
const SIGN_IN_GRANT_LIFETIME_MS = 2 * 60 * 1000;
// An abandoned connection attempt should not leave a durable object behind forever.
const ABANDONED_ATTEMPT_LIFETIME_MS = 60 * 60 * 1000;

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? `http://localhost:8787/gatekeeper/${VENDOR_ID}`);
}

function getBasePath(env: Env): string {
  return new URL(getBaseUrl(env)).pathname.replace(/\/$/, "");
}

/** Reads deployment config, or throws a message aimed at whoever installed the connector. */
function getConfig(env: Env): OidcConfig {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    throw new Error(
        "The OIDC connector is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and " +
        "OIDC_CLIENT_SECRET on this deployment.");
  }
  return {
    issuer: stripTrailingSlashes(env.OIDC_ISSUER),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES ?? "",
  };
}

/** How this deployment maps group claims onto orgs. Absent claim ⇒ org separation is off. */
function getOrgConfig(env: Env): OrgClaimConfig {
  return { claim: env.OIDC_GROUPS_CLAIM, prefix: env.OIDC_ORG_PREFIX };
}

function redirectUri(env: Env): string {
  return `${getBaseUrl(env)}/callback`;
}

function html(body: string, status = 200): Response {
  return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign in</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `${body}</body></html>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// HTTP handler: the two hops of the redirect dance.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);

    // Hop 2: the provider redirects the user back here with a code.
    if (relPath === "/callback") {
      return handleCallback(url, env, ctx);
    }

    // Hop 1: the user opens the link the Workshop gave them. Spending the initiation nonce here
    // — rather than when the link was minted — is what stops the link being reused.
    const path = relPath.slice(1).split("/");
    if (path.length === 2 && path[1].length > 0) {
      return handleStart(path[0], path[1], env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleStart(
  doId: string, initiationNonce: string, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  let config: OidcConfig;
  try {
    config = getConfig(env);
  } catch (err) {
    return html(`<h1>Not configured</h1><p>${(err as Error).message}</p>`, 500);
  }

  let stub;
  try {
    stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
  } catch {
    return html("<h1>Invalid link</h1><p>This sign-in link is malformed.</p>", 400);
  }

  const begun = await stub.beginAuthFlow(initiationNonce);
  if (!begun) {
    return html(
        "<h1>Link expired</h1><p>This sign-in link is no longer valid. " +
        "Please start again from FieldOS.</p>", 400);
  }

  let endpoints: OidcEndpoints;
  try {
    endpoints = await discoverEndpoints(config.issuer);
  } catch (err) {
    logger.error("OIDC discovery failed", {
      event: "oidc.discovery.failed", error: err, issuer: config.issuer,
    });
    return html(
        "<h1>Cannot reach the identity provider</h1>" +
        `<p>${(err as Error).message}</p>`, 502);
  }

  return Response.redirect(authorizeUrl({
    endpoints, config,
    redirectUri: redirectUri(env),
    // `state` ties the callback back to this DO; the DO half is not secret, the nonce half is.
    state: `${doId}:${begun.oauthNonce}`,
    idTokenNonce: begun.idTokenNonce,
  }), 302);
}

async function handleCallback(
  url: URL, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const providerError = url.searchParams.get("error");
  if (providerError) {
    // The provider's description is shown as text, never as markup.
    const description = url.searchParams.get("error_description") ?? providerError;
    return html(
        `<h1>Sign-in was refused</h1><p>Your identity provider reported: ` +
        `${escapeHtml(description)}</p>`, 400);
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    return html("<h1>Invalid response</h1><p>The provider's response was incomplete.</p>", 400);
  }

  const separator = state.indexOf(":");
  if (separator < 0) {
    return html("<h1>Invalid response</h1><p>The provider returned malformed state.</p>", 400);
  }
  const doId = state.slice(0, separator);
  const oauthNonce = state.slice(separator + 1);

  let stub;
  try {
    stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
  } catch {
    return html("<h1>Invalid response</h1><p>The provider returned malformed state.</p>", 400);
  }

  try {
    await stub.completeAuthFlow(code, oauthNonce);
  } catch (err) {
    logger.warn("OIDC sign-in failed", { event: "oidc.signin.failed", error: err });
    return html(`<h1>Sign-in failed</h1><p>${escapeHtml((err as Error).message)}</p>`, 400);
  }

  return html("<h1>Signed in</h1><p>You may close this tab and return to FieldOS.</p>");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Single sign-on",
      url: this.env.OIDC_ISSUER ?? "",
      color: "#2d6a4f",
      tagline: "Sign in with your organization's identity provider",
      description:
          "Sign in with your organization's identity provider. Works with any standards-compliant " +
          "OpenID Connect service, including Keycloak, Okta, Authentik, Dex and ADFS.",
      providesAuth: true,
      // Only claim to provide an org when this deployment configured a claim to read it from.
      // Advertising it unconditionally would make every sign-in look like a deliberate "no org"
      // answer rather than "org separation is not in use here".
      providesOrg: !!this.env.OIDC_GROUPS_CLAIM,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // `options.scopes` is ignored: this vendor only ever performs sign-in, so there is no wider
    // grant for "full" to request. The grant is always transient.
    getConfig(this.env);

    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);

    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  // Sign-in only: nothing here is grantable to a gadget or an agent.
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return "";
  }
}

// ---------------------------------------------------------------------------
// UserAccount: one per connection attempt, holding the nonce and the verified identity.

export class UserAccount extends DurableObject<Env> {
  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
  ): Promise<void> {
    // Reap the object if the user never finishes; cancelled once an identity is stored.
    await this.ctx.storage.setAlarm(Date.now() + ABANDONED_ATTEMPT_LIFETIME_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * Spends the initiation nonce and issues the pair the redirect needs: the `state` nonce that
   * ties the callback back here, and the OIDC `nonce` the provider echoes into the ID token.
   */
  async beginAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; idTokenNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!nonceIsValid(stored, initiationNonce, "initiation")) return null;

    const oauthNonce = generateNonce();
    const idTokenNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    this.ctx.storage.kv.put("idTokenNonce", idTokenNonce);
    return { oauthNonce, idTokenNonce };
  }

  /**
   * Exchanges the code, verifies the ID token, and hands the Workshop a capability it can read the
   * email from.
   */
  async completeAuthFlow(code: string, oauthNonce: string): Promise<void> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!nonceIsValid(stored, oauthNonce, "oauth")) {
      throw new Error("This sign-in link has expired. Please start again from FieldOS.");
    }
    // Spent before the exchange, so a replayed callback cannot reach the provider a second time.
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete sign-in. Please try again.");
    }

    const config = getConfig(this.env);
    const endpoints = await discoverEndpoints(config.issuer);
    const { idToken } = await exchangeCode({
      code, endpoints, config, redirectUri: redirectUri(this.env),
    });

    const identity = await verifyIdToken(idToken, config, endpoints, getOrgConfig(this.env));

    // The provider must echo back the nonce we sent, binding this ID token to this request.
    // Checked after signature verification, so the claim is trustworthy by the time we read it.
    const expectedNonce = this.ctx.storage.kv.get<string>("idTokenNonce");
    if (expectedNonce) {
      const { payload } = decodeClaims(idToken);
      if (payload.nonce !== expectedNonce) {
        throw new Error("The identity provider returned a mismatched nonce.");
      }
    }

    this.ctx.storage.kv.put<OidcIdentity>("identity", identity);
    this.ctx.storage.kv.delete("idTokenNonce");

    try {
      const props = { userObjectId: this.ctx.id.toString() };
      await callback.complete(this.ctx.exports.OidcUserImpl({ props }));
    } catch (err) {
      // Leave nothing half-connected behind.
      this.ctx.storage.kv.delete("identity");
      throw err;
    }

    // The Workshop has read the email by now. The grant exists only to answer that one question,
    // so it self-destructs rather than lingering as a stored identity.
    await this.ctx.storage.setAlarm(Date.now() + SIGN_IN_GRANT_LIFETIME_MS);
  }

  async getIdentity(): Promise<OidcIdentity | null> {
    return this.ctx.storage.kv.get<OidcIdentity>("identity") ?? null;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Reads the claims of an already-verified token.
 *
 * Only ever called on a token `verifyIdToken` has accepted, to re-read one claim jose does not
 * check for us. Never use it to make a trust decision on an unverified token.
 */
function decodeClaims(idToken: string): { payload: Record<string, unknown> } {
  const segments = idToken.split(".");
  if (segments.length !== 3) return { payload: {} };
  try {
    const json = atob(segments[1].replace(/-/g, "+").replace(/_/g, "/"));
    return { payload: JSON.parse(json) as Record<string, unknown> };
  } catch {
    return { payload: {} };
  }
}

// ---------------------------------------------------------------------------
// The account capability handed to the Workshop.

type OidcUserImplProps = { userObjectId: string };

@validateRpc()
export class OidcUserImpl extends WorkerEntrypoint<Env, OidcUserImplProps>
    implements GatekeeperUser {
  #account() {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().getIdentity();
    return {
      displayName: identity?.email ?? "Single sign-on",
      uniqueName: identity?.email,
      avatar: { url: SSO_ICON },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The single sign-on connector provides no configurable resources.");
  }

  async getGatekeeperClassFor(_url: string): Promise<never> {
    throw new Error("The single sign-on connector provides no resources.");
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async ensureResources(_patterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async reconnect(): Promise<{ url: string }> {
    // Nothing to restore: a sign-in grant is discarded once read, so re-authenticating means
    // starting a fresh flow rather than repairing this one.
    throw new Error("Sign in again to re-authenticate.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    const identity = await this.#account().getIdentity();
    return identity?.email ?? null;
  }

  async getAuthenticatedOrg(): Promise<string | null> {
    const identity = await this.#account().getIdentity();
    // Undefined and null both mean "no org". Never substitute a default: a user whose group claim
    // was missing or ambiguous must reach nothing org-scoped rather than inherit someone else's
    // org. See resolveOrg() in identity.ts.
    return identity?.orgId ?? null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.OidcVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

// ---------------------------------------------------------------------------

type OidcVerifierProps = { userObjectId: string };

@validateRpc()
export class OidcVerifier extends WorkerEntrypoint<Env, OidcVerifierProps>
    implements GatekeeperUserVerifier {
  // No resources means nothing to authorize against; the verifier exists to satisfy the contract.
}
