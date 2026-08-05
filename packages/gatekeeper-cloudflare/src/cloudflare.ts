import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  SupportedResource, ResourceConfiguratorFrame, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { getOAuthConfig, buildAuthorizeUrl, generatePkce, exchangeCode, refreshTokens, AUTH_SCOPES, FULL_SCOPES } from "./oauth";
import { fetchIdentity } from "./cloudflare-api";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one is active at a time; `stage`
// tracks where we are. For the OAuth stage we also stash the PKCE verifier alongside the nonce.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  verifier?: string;
  scopes?: string[];
};

// A cached access token plus its absolute expiry (unix ms).
type StoredAccessToken = { token: string; expires: number };

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// Official Cloudflare logomark (orange cloud on a transparent background), as a data URI so it can
// be rendered directly as the vendor/account avatar.
const CLOUDFLARE_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74">` +
  `<path fill="#f4801f" d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.75,22.27-16.71l4.34-11.36a2.68,2.68,0,0,0,.18-1,3.31,3.31,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z"/>` +
  `<path fill="#f9ab41" d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.09.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.55,1.55,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z"/>` +
  `</svg>`,
);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Optional env vars (may be omitted from wrangler.jsonc; secrets come from .dev.vars / dashboard).
type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/cloudflare");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><body>
<script type="text/javascript">window.close();</script>
<p>Authorization complete. You may close this tab and return to Cloudflare OS.
</body></html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Authorization Link Expired</h1>
<p>This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
<button onclick="window.close()">Close</button></body></html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Configuration Required</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Cloudflare Gatekeeper Not Configured</h1>
<p>Please see the README.md for instructions on configuring an OAuth client ID and secret.</p>
</body></html>`;

// Main HTTP entrypoint — used only to initiate and complete the OAuth flow.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env))!;
      const authUrl = buildAuthorizeUrl(config, `${doId}:${begun.oauthNonce}`, begun.challenge, begun.scopes);
      return Response.redirect(authUrl, 302);
    } else if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }
      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      const doId = state.slice(0, colonIdx);
      const oauthNonce = state.slice(colonIdx + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

// =======================================================================================

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare",
      url: "https://cloudflare.com",
      logo: { url: CLOUDFLARE_LOGO_URL },
      color: "#fbece0",
      tagline: "Sign in with Cloudflare",
      description:
          "Sign in with your Cloudflare account. Usage beyond the free tier can be billed to your " +
          "own Cloudflare AI Gateway credits.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly ? AUTH_SCOPES : FULL_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  // No gadget/agent resource types yet — the Cloudflare gatekeeper currently provides auth only.
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  #config() {
    const config = getOAuthConfig(this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env));
    if (!config) throw new Error("The Cloudflare Gatekeeper is not configured.");
    return config;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    scopes?: string[], ephemeral?: boolean) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    // Scopes to request (auth-only for sign-in, or the full capability set). Reused on reconnect.
    if (scopes) this.ctx.storage.kv.put<string[]>("scopes", scopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Verify+consume the initiation nonce; mint a fresh OAuth nonce + PKCE pair. Returns the OAuth
  // nonce (for the `state`) and the PKCE challenge (for the authorize URL), or null if invalid.
  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; challenge: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const { verifier, challenge } = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      verifier,
    });
    const scopes = this.ctx.storage.kv.get<string[]>("scopes") ?? FULL_SCOPES;
    return { oauthNonce, challenge, scopes };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    const tokens = await exchangeCode(this.#config(), code, stored.verifier);
    if (!tokens || !tokens.refreshToken) {
      throw new Error("Cloudflare OAuth exchange failed or returned no refresh token.");
    }

    this.ctx.storage.kv.put<string>("refreshToken", tokens.refreshToken);
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", {
      token: tokens.accessToken,
      expires: Date.now() + tokens.expiresIn * 1000,
    });

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call a provider revoke endpoint; we just drop
      // our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }
    return true;
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  // Returns a usable access token (refreshing if needed), or null if the credentials are gone or
  // can no longer be refreshed (in which case the workshop is notified via credentialsExpired()).
  async getAccessToken(): Promise<string | null> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return null;

    const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
    if (cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return cached.token;
    }

    const refreshed = await refreshTokens(this.#config(), refreshToken);
    if (!refreshed) {
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsExpired().catch(err =>
        logger.warn("failed to notify credential expiry", {
          event: "credentials.expiry.notify.failed", error: err,
        }));
      return null;
    }
    if (refreshed.refreshToken) {
      this.ctx.storage.kv.put<string>("refreshToken", refreshed.refreshToken);
    }
    const token: StoredAccessToken = {
      token: refreshed.accessToken,
      expires: Date.now() + refreshed.expiresIn * 1000,
    };
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", token);
    return token.token;
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements CloudflareGatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const token = await this.#account().getAccessToken();
    const identity = token ? await fetchIdentity(token) : null;
    return {
      displayName: identity?.displayName,
      uniqueName: identity?.email,
      avatar: { url: CLOUDFLARE_LOGO_URL },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    const token = await this.#account().getAccessToken();
    if (!token) return null;
    const identity = await fetchIdentity(token);
    return identity?.email ?? null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getUsableAccessToken(): Promise<string | null> {
    return this.#account().getAccessToken();
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    throw new Error("The Cloudflare gatekeeper does not provide any resources yet.");
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Cloudflare gatekeeper does not provide any resources yet.");
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  // Mint a verifier representing this account. The Cloudflare gatekeeper currently exposes no
  // resource bindings (getGatekeeperClassFor always throws), so it is never an in-scope binding and
  // this verifier is never consulted by the observer flow — but getVerifier is part of the
  // GatekeeperUser contract, so it must exist. Returns a trivial verifier with no identity.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CloudflareVerifier({});
  }
}

// The Cloudflare gatekeeper provides no resources, so no observer verification is performed.
@validateRpc()
export class CloudflareVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
