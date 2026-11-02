import { afterEach, describe, expect, it, vi } from "vitest";
import { type CentralOAuthEnv, beginCentralOAuth, redeemCentralOAuth, refreshCentralOAuth, revokeCentralOAuth } from "../src/central-oauth";

const identity = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { publicKey: pair.publicKey, env: { CENTRAL_GATEKEEPER_URL: "https://central.example.test",
    CFOS_INSTALL_ID: `${"a".repeat(32)}:example`, CFOS_INSTALL_KEY_ID: crypto.randomUUID(),
    CFOS_INSTALL_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer))) } };
};
const grant = { credentialId: "b".repeat(64), accessToken: "usable-access-token",
  expiresAt: Date.now() + 3_600_000, scopes: ["openid"] };
afterEach(() => vi.restoreAllMocks());

describe("managed central OAuth client", () => {
  it("signs the provider-specific handoff protocol and accepts only the provider consent origin", async () => {
    const { env, publicKey } = await identity();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init!.headers);
      expect(String(input)).toBe("https://central.example.test/begin");
      const canonical = ["CFOS-CENTRAL-GOOGLE-1", "POST", "/begin", env.CFOS_INSTALL_ID,
        env.CFOS_INSTALL_KEY_ID, headers.get("x-cfos-timestamp"), headers.get("x-cfos-nonce"),
        headers.get("x-cfos-content-digest")].join("\n");
      const signature = headers.get("x-cfos-signature")!;
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
        Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)),
        new TextEncoder().encode(canonical))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))).toEqual({
        accountId: "c".repeat(64), nonce: "d".repeat(64), scopes: ["openid"], callbackPath: "/gatekeeper/google/oauth" });
      return Response.json({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" });
    });
    expect(await beginCentralOAuth(env, "google", { accountId: "c".repeat(64), nonce: "d".repeat(64),
      scopes: ["openid"], callbackPath: "/gatekeeper/google/oauth" }, "https://accounts.google.com/o/oauth2/v2/auth")).toContain("accounts.google.com");
    vi.mocked(fetch).mockResolvedValue(Response.json({ authorizationUrl: "https://attacker.test/consent" }));
    await expect(beginCentralOAuth(env, "google", { accountId: "c".repeat(64), nonce: "d".repeat(64),
      scopes: ["openid"], callbackPath: "/gatekeeper/google/oauth" }, "https://accounts.google.com/o/oauth2/v2/auth")).rejects.toThrow("Unexpected");
  });

  it("redeems usable access credentials and sends rejected tokens during 401 recovery", async () => {
    const { env } = await identity();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ accountId: "c".repeat(64),
      nonce: "d".repeat(64), grant })).mockResolvedValueOnce(Response.json({ ok: true, grant }));
    expect((await redeemCentralOAuth(env, "google", "e".repeat(64))).grant).toEqual(grant);
    expect(await refreshCentralOAuth(env, "google", `cgc1.${grant.credentialId}`, "rejected-access"))
      .toEqual({ ok: true, grant });
    const [url, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(url)).toBe("https://central.example.test/refresh");
    expect(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))).toEqual({
      credentialId: grant.credentialId, rejectedAccessToken: "rejected-access" });
  });

  it("preserves permanent provider errors, disconnects the central grant, and fails before network on a legacy credential", async () => {
    const { env } = await identity();
    const mock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: false, reason: "policyBlocked" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await refreshCentralOAuth(env, "google", `cgc1.${grant.credentialId}`)).toEqual({ ok: false, reason: "policyBlocked" });
    await revokeCentralOAuth(env, "google", `cgc1.${grant.credentialId}`);
    await expect(refreshCentralOAuth(env, "github", "ghg1.old.encrypted")).rejects.toThrow("Reconnect");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("authenticates all broker operations through Access without changing the signed protocol", async () => {
    const { env: identityEnv, publicKey } = await identity();
    const env: CentralOAuthEnv = { ...identityEnv, CENTRAL_GATEKEEPER_ACCESS_CLIENT_ID: "broker-client",
      CENTRAL_GATEKEEPER_ACCESS_CLIENT_SECRET: "broker-secret" };
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init!.headers);
      paths.push(url.pathname);
      expect(url.origin).toBe(env.CENTRAL_GATEKEEPER_URL);
      expect(url.search).toBe("");
      expect(init!.redirect).toBe("manual");
      expect(headers.get("CF-Access-Client-Id")).toBe("broker-client");
      expect(headers.get("CF-Access-Client-Secret")).toBe("broker-secret");
      const body = init!.body as Uint8Array;
      expect(new TextDecoder().decode(body)).not.toContain("broker-secret");
      const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", body))))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      expect(headers.get("x-cfos-content-digest")).toBe(digest);
      const canonical = ["CFOS-CENTRAL-GOOGLE-1", "POST", url.pathname, env.CFOS_INSTALL_ID,
        env.CFOS_INSTALL_KEY_ID, headers.get("x-cfos-timestamp"), headers.get("x-cfos-nonce"), digest].join("\n");
      const sig = headers.get("x-cfos-signature")!;
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
        Uint8Array.from(atob(sig.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)),
        new TextEncoder().encode(canonical))).toBe(true);
      return Response.json(url.pathname === "/begin" ? { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" }
        : url.pathname === "/redeem" ? { accountId: "c".repeat(64), nonce: "d".repeat(64), grant }
        : { ok: true, grant });
    });
    await beginCentralOAuth(env, "google", { accountId: "c".repeat(64), nonce: "d".repeat(64),
      scopes: ["openid"], callbackPath: "/gatekeeper/google/oauth" }, "https://accounts.google.com/o/oauth2/v2/auth");
    await redeemCentralOAuth(env, "google", "e".repeat(64));
    await refreshCentralOAuth(env, "google", `cgc1.${grant.credentialId}`);
    await revokeCentralOAuth(env, "google", `cgc1.${grant.credentialId}`);
    expect(paths).toEqual(["/begin", "/redeem", "/refresh", "/revoke"]);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://login.example.com" } }));
    await expect(revokeCentralOAuth(env, "google", `cgc1.${grant.credentialId}`)).rejects.toThrow("failed (302)");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([
    { CENTRAL_GATEKEEPER_ACCESS_CLIENT_ID: "id" },
    { CENTRAL_GATEKEEPER_ACCESS_CLIENT_SECRET: "secret" },
    { CENTRAL_GATEKEEPER_ACCESS_CLIENT_ID: "", CENTRAL_GATEKEEPER_ACCESS_CLIENT_SECRET: "" },
  ])("fails before sending a partially configured Access credential", async access => {
    const { env } = await identity();
    const network = vi.spyOn(globalThis, "fetch");
    await expect(revokeCentralOAuth({ ...env, ...access }, "google", `cgc1.${grant.credentialId}`))
      .rejects.toThrow("credentials must be configured together");
    expect(network).not.toHaveBeenCalled();
  });
});
