import { RpcStub } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatekeeperUserImpl, GatekeeperVendor, UserAccount, validateNativeReturnUrl } from "../src/jira";

const nativeReturnUrl = "https://workshop.example/native/oauth-return/abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";

describe("Jira native OAuth return handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates only Workshop native OAuth return URLs", () => {
    const env = { BASE_URL: "https://workshop.example/gatekeeper/jira" };

    expect(validateNativeReturnUrl(nativeReturnUrl, env)).toBe(nativeReturnUrl);
    expect(() => validateNativeReturnUrl("https://evil.example/native/oauth-return/abcdefghijklmnopqrstuvwxyz", env)).toThrow(/outside/);
    expect(() => validateNativeReturnUrl("https://workshop.example/native/oauth-return/short", env)).toThrow(/handle/);
    expect(() => validateNativeReturnUrl(`${nativeReturnUrl}?next=https://evil.example`, env)).toThrow(/outside/);
    expect(() => validateNativeReturnUrl(`${nativeReturnUrl}#frag`, env)).toThrow(/outside/);
  });

  it("threads a validated native return URL through connect nonce state", async () => {
    const callback = { complete: vi.fn(), credentialsRestored: vi.fn() };
    const setCallback = vi.fn();
    const vendor = new GatekeeperVendor();
    Object.assign(vendor, {
      env: { BASE_URL: "https://workshop.example/gatekeeper/jira" },
      ctx: {
        exports: {
          UserAccount: {
            newUniqueId: () => ({ toString: () => "e".repeat(64) }),
            get: () => ({ setCallback }),
          },
        },
      },
    });

    await expect(vendor.connectAccount(new RpcStub(callback), { returnUrl: nativeReturnUrl })).resolves.toMatchObject({
      url: expect.stringContaining(`/${"e".repeat(64)}/`),
    });
    expect(setCallback).toHaveBeenCalledWith(expect.any(RpcStub), expect.stringMatching(/^[0-9a-f]{64}$/), nativeReturnUrl);
  });

  it("preserves the native return URL across connect OAuth nonce state", async () => {
    const callback = { complete: vi.fn(), credentialsRestored: vi.fn() };
    const account = makeAccount(callback);

    await account.setCallback(callback, "a".repeat(64), nativeReturnUrl);
    const begun = await account.beginOAuthFlow("a".repeat(64));
    expect(begun).toBeTruthy();
    if (!begun) throw new Error("OAuth flow did not begin.");

    const accepted = await account.acceptAuthCode("code", begun.oauthNonce);

    expect(accepted).toEqual({ returnUrl: nativeReturnUrl });
    expect(callback.complete).toHaveBeenCalledTimes(1);
    expect(callback.credentialsRestored).not.toHaveBeenCalled();
  });

  it("threads a validated native return URL through reconnect nonce state", async () => {
    const prepareReconnect = vi.fn();
    const user = new GatekeeperUserImpl();
    Object.assign(user, {
      env: { BASE_URL: "https://workshop.example/gatekeeper/jira" },
      ctx: {
        props: { userObjectId: "f".repeat(64) },
        exports: {
          UserAccount: {
            idFromString: (id: string) => id,
            get: () => ({ prepareReconnect }),
          },
        },
      },
    });

    await expect(user.reconnect({ returnUrl: nativeReturnUrl })).resolves.toMatchObject({
      url: expect.stringContaining(`/${"f".repeat(64)}/`),
    });
    expect(prepareReconnect).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), nativeReturnUrl);
  });

  it("preserves the native return URL across reconnect OAuth nonce state", async () => {
    const callback = { complete: vi.fn(), credentialsRestored: vi.fn() };
    const account = makeAccount(callback);

    await account.setCallback(callback, "a".repeat(64));
    await account.prepareReconnect("b".repeat(64), nativeReturnUrl);
    const begun = await account.beginOAuthFlow("b".repeat(64));
    expect(begun).toBeTruthy();
    if (!begun) throw new Error("OAuth flow did not begin.");

    const accepted = await account.acceptAuthCode("code", begun.oauthNonce);

    expect(accepted).toEqual({ returnUrl: nativeReturnUrl });
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
    expect(callback.complete).not.toHaveBeenCalled();
  });

  it("consumes initiation and OAuth nonces exactly once", async () => {
    const callback = { complete: vi.fn(), credentialsRestored: vi.fn() };
    const account = makeAccount(callback);

    await account.setCallback(callback, "c".repeat(64), nativeReturnUrl);
    const begun = await account.beginOAuthFlow("c".repeat(64));
    expect(begun).toBeTruthy();
    await expect(account.beginOAuthFlow("c".repeat(64))).resolves.toBeNull();
    if (!begun) throw new Error("OAuth flow did not begin.");

    await expect(account.acceptAuthCode("code", begun.oauthNonce)).resolves.toEqual({ returnUrl: nativeReturnUrl });
    await expect(account.acceptAuthCode("code", begun.oauthNonce)).resolves.toBeNull();
    expect(callback.complete).toHaveBeenCalledTimes(1);
  });
});

function makeAccount(callback: { complete: ReturnType<typeof vi.fn>; credentialsRestored: ReturnType<typeof vi.fn> }): UserAccount {
  const account = new UserAccount();
  const kv = new Map<string, unknown>();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://auth.atlassian.com/oauth/token") {
      return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read:jira-work" });
    }
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json([{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);
    if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
    throw new Error(`unexpected URL ${url}`);
  }));
  Object.assign(account, {
    env: { BASE_URL: "https://workshop.example/gatekeeper/jira", CLIENT_ID: "client", CLIENT_SECRET: "secret" },
    ctx: {
      id: { toString: () => "d".repeat(64) },
      exports: { GatekeeperUserImpl: () => ({}) },
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => kv.set(key, value),
          delete: (key: string) => kv.delete(key),
        },
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn(),
        deleteAll: vi.fn(() => kv.clear()),
      },
    },
  });
  kv.set("callback", callback);
  return account;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
