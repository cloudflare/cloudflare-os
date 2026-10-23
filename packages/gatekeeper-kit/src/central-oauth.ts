/** Installer-owned identity for Cloudflare-managed instances. No provider client secret is shipped. */
export type CentralOAuthEnv = {
  CENTRAL_GATEKEEPER_URL?: string;
  /** Optional Access service token for this broker origin; configure both as Worker secrets. */
  CENTRAL_GATEKEEPER_ACCESS_CLIENT_ID?: string;
  CENTRAL_GATEKEEPER_ACCESS_CLIENT_SECRET?: string;
  CFOS_INSTALL_ID?: string;
  CFOS_INSTALL_KEY_ID?: string;
  CFOS_INSTALL_PRIVATE_KEY?: string;
};
/** Short-lived provider token plus an installation-bound reference to the central refresh grant. */
export type CentralOAuthGrant = {
  credentialId: string; accessToken: string; expiresAt: number; scopes: string[];
  /** Provider-owned installation metadata. The consuming gatekeeper validates its schema. */
  providerData?: Record<string, unknown>;
};
type Provider = string;
const HEX64 = /^[0-9a-f]{64}$/;
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid central OAuth response");
  return value as Record<string, unknown>;
};
const grant = (value: unknown): CentralOAuthGrant => {
  const result = record(value);
  if (typeof result.credentialId !== "string" || !HEX64.test(result.credentialId) ||
      typeof result.accessToken !== "string" || !result.accessToken || result.accessToken.length > 4096 ||
      typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt) ||
      !Array.isArray(result.scopes) || !result.scopes.every(s => typeof s === "string")) {
    throw new Error("Invalid central OAuth grant");
  }
  return { credentialId: result.credentialId, accessToken: result.accessToken,
    expiresAt: result.expiresAt, scopes: result.scopes as string[],
    ...(result.providerData === undefined ? {} : { providerData: record(result.providerData) }) };
};
const credentialId = (reference: string): string => {
  if (!reference.startsWith("cgc1.") || !HEX64.test(reference.slice(5))) {
    throw new Error("Reconnect this account to use the managed central gatekeeper");
  }
  return reference.slice(5);
};
const call = async (env: CentralOAuthEnv, provider: Provider, path: string, payload: object,
                    signal?: AbortSignal): Promise<Record<string, unknown>> => {
  if (!env.CENTRAL_GATEKEEPER_URL || !env.CFOS_INSTALL_ID || !env.CFOS_INSTALL_KEY_ID ||
      !env.CFOS_INSTALL_PRIVATE_KEY) throw new Error("Managed central OAuth is not configured");
  const url = new URL(env.CENTRAL_GATEKEEPER_URL);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash ||
      url.username || url.password) throw new Error("CENTRAL_GATEKEEPER_URL must be an HTTPS origin");
  const accessId = env.CENTRAL_GATEKEEPER_ACCESS_CLIENT_ID;
  const accessSecret = env.CENTRAL_GATEKEEPER_ACCESS_CLIENT_SECRET;
  if ((accessId !== undefined || accessSecret !== undefined) && (!accessId || !accessSecret)) {
    throw new Error("Central gatekeeper Access credentials must be configured together");
  }
  url.pathname = path;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.byteLength > 16_384) throw new Error("Central OAuth request exceeds limit");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const digest = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  const canonical = [`CFOS-CENTRAL-${provider.toUpperCase()}-1`, "POST", path,
    env.CFOS_INSTALL_ID, env.CFOS_INSTALL_KEY_ID, timestamp, nonce, digest].join("\n");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(env.CFOS_INSTALL_PRIVATE_KEY),
    c => c.charCodeAt(0)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    key, new TextEncoder().encode(canonical))));
  const response = await fetch(url, { method: "POST", body, redirect: "manual",
    signal: signal ?? AbortSignal.timeout(20_000), headers: { "content-type": "application/json",
      ...(accessId && accessSecret ? { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret } : {}),
      "x-cfos-install-id": env.CFOS_INSTALL_ID, "x-cfos-key-id": env.CFOS_INSTALL_KEY_ID,
      "x-cfos-timestamp": timestamp, "x-cfos-nonce": nonce, "x-cfos-content-digest": digest,
      "x-cfos-signature": signature } });
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Central ${provider} OAuth request failed (${response.status})`);
  }
  return record(await response.json());
};

/** Begin consent through the provider's single registered central callback. */
export const beginCentralOAuth = async (env: CentralOAuthEnv, provider: Provider, input: {
  accountId: string; nonce: string; scopes: string[]; callbackPath: string; providerOrigin?: string;
}, authorizationEndpoint: string): Promise<string> => {
  const result = await call(env, provider, "/begin", input);
  if (typeof result.authorizationUrl !== "string") throw new Error("Invalid authorization URL");
  const url = new URL(result.authorizationUrl);
  if (url.protocol !== "https:" || url.username || url.password ||
      `${url.origin}${url.pathname}` !== authorizationEndpoint) throw new Error("Unexpected authorization URL");
  return url.href;
};

/** Redeem a one-time ticket over a signed server request; the browser never receives tokens. */
export const redeemCentralOAuth = async (env: CentralOAuthEnv, provider: Provider, ticket: string): Promise<{
  accountId: string; nonce: string; grant: CentralOAuthGrant;
}> => {
  if (!HEX64.test(ticket)) throw new Error("Invalid OAuth ticket");
  const result = await call(env, provider, "/redeem", { ticket });
  if (typeof result.accountId !== "string" || !HEX64.test(result.accountId) ||
      typeof result.nonce !== "string" || !HEX64.test(result.nonce)) throw new Error("Invalid OAuth handoff");
  return { accountId: result.accountId, nonce: result.nonce, grant: grant(result.grant) };
};

/** Renew credentials. Pass the rejected token after a 401 so an unexpired cached token is replaced. */
export const refreshCentralOAuth = async (env: CentralOAuthEnv, provider: Provider, reference: string,
  rejectedAccessToken?: string, signal?: AbortSignal): Promise<
    { ok: true; grant: CentralOAuthGrant } | { ok: false; reason: "revoked" | "policyBlocked" }
  > => {
  const result = await call(env, provider, "/refresh", { credentialId: credentialId(reference),
    rejectedAccessToken }, signal);
  if (result.ok === false && (result.reason === "revoked" || result.reason === "policyBlocked")) {
    return { ok: false, reason: result.reason };
  }
  if (result.ok !== true) throw new Error("Invalid central refresh result");
  return { ok: true, grant: grant(result.grant) };
};

/** Disable this central refresh grant. Existing access tokens expire at the provider's deadline. */
export const revokeCentralOAuth = async (env: CentralOAuthEnv, provider: Provider,
                                         reference: string): Promise<void> => {
  const result = await call(env, provider, "/revoke", { credentialId: credentialId(reference) });
  if (result.ok !== true) throw new Error("Central credential disconnect failed");
};
