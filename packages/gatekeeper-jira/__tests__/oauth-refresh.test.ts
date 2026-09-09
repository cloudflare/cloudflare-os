import { afterEach, describe, expect, it, vi } from "vitest";
import { UserAccount } from "../src/jira";

const SITES = [{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }];

describe("Jira OAuth refresh rotation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("singleflights concurrent refreshes and persists the rotated refresh token silently after the legacy repair marker", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") {
        await new Promise<void>(resolve => { release = resolve; });
        return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" });
      }
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 });
    kv.set("refreshRestoredNotified", true);

    const first = account.getAccessToken();
    const second = account.getAccessToken();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["access-2", "access-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.get("grant")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(callback.credentialsRestored).not.toHaveBeenCalled();
    expect(callback.credentialsExpired).not.toHaveBeenCalled();
  });

  it("repairs legacy Workshop access-token expiry once on the first successful refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 });

    await expect(account.getAccessToken()).resolves.toBe("access-2");

    expect(callback.credentialsRestored).toHaveBeenCalledWith(undefined);
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
    expect(kv.get("refreshRestoredNotified")).toBe(0);
  });

  it("schedules proactive refresh alarms when a grant is accepted", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, setAlarm } = makeAccount();

    await account.setCallback({ complete: vi.fn(), credentialsRestored: vi.fn(), credentialsExpired: vi.fn() }, "a".repeat(64));
    const begun = await account.beginOAuthFlow("a".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);

    const scheduled = setAlarm.mock.calls.at(-1)?.[0] as number;
    expect(scheduled).toBeGreaterThan(Date.now() + 45 * 60 * 1000);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + 50 * 60 * 1000);
  });

  it("keeps normal scheduled refresh silent without leaving restored notification pending", async () => {
    const tokenResponses = [
      () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "read:jira-work" }),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return tokenResponses.shift()?.() ?? json({ error: "unexpected" }, 500);
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback, setAlarm } = makeAccount();
    await completeOAuth(account, callback, "a");
    callback.credentialsRestored.mockClear();
    kv.set("grant", { ...(kv.get("grant") as object), expiresAt: Date.now() - 1 });

    await account.alarm();

    expect(kv.get("grant")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(callback.credentialsRestored).not.toHaveBeenCalled();
    expect(kv.has("refreshRestoredPending")).toBe(false);
    const scheduled = setAlarm.mock.calls.at(-1)?.[0] as number;
    expect(scheduled).toBeGreaterThan(Date.now() + 45 * 60 * 1000);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + 50 * 60 * 1000);
  });

  it("preserves discovered sites during token rotation when resource discovery would fail", async () => {
    let accessibleResourceCalls = 0;
    const tokenResponses = [
      () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "read:jira-work" }),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return tokenResponses.shift()?.() ?? json({ error: "unexpected" }, 500);
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
        accessibleResourceCalls++;
        if (accessibleResourceCalls === 1) return json([{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);
        return json({ error: "unavailable" }, 503);
      }
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();
    await completeOAuth(account, callback, "a");
    expect(kv.get("sites")).toEqual([{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);
    kv.set("grant", { ...(kv.get("grant") as object), expiresAt: Date.now() - 1 });

    await expect(account.getAccessToken()).resolves.toBe("access-2");

    expect(accessibleResourceCalls).toBe(1);
    expect(kv.get("sites")).toEqual([{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);
  });

  it("does not send access-token expiry to Workshop for refreshable grants", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, callback } = makeAccount();

    await account.setCallback(callback, "a".repeat(64));
    const begun = await account.beginOAuthFlow("a".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);

    expect(callback.complete).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("rolls back a new grant when the initial Workshop completion callback fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback, setAlarm } = makeAccount();
    callback.complete.mockRejectedValueOnce(new Error("callback unavailable"));

    await account.setCallback(callback, "a".repeat(64));
    const begun = await account.beginOAuthFlow("a".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await expect(account.acceptAuthCode("code", begun.oauthNonce)).rejects.toThrow(/callback unavailable/);

    expect(kv.has("grant")).toBe(false);
    expect(kv.has("sites")).toBe(false);
    expect(kv.has("refreshRestoredNotified")).toBe(false);
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThan(Date.now());
  });

  it("does send expiry for non-refreshable grants", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, callback } = makeAccount();

    await account.setCallback(callback, "a".repeat(64));
    const begun = await account.beginOAuthFlow("a".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);

    expect(callback.complete.mock.calls[0]?.[1]).toBeInstanceOf(Date);
  });

  it("reuses alarms for pending reconnect cleanup without deleting an active grant", async () => {
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 });

    await account.prepareReconnect("b".repeat(64));
    kv.set("oauthCleanupAt", Date.now() - 1);
    await account.alarm();

    expect(kv.get("grant")).toMatchObject({ refreshToken: "refresh" });
    expect(kv.has("nonce")).toBe(false);
    expect(kv.has("reconnecting")).toBe(false);
  });

  it("keeps a still-valid access token active for transient refresh failures and retries later", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ error: "server_error" }, 500);
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback, setAlarm } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 5 * 60 * 1000 });

    await expect(account.getAccessToken()).resolves.toBe("access");

    expect(kv.get("grant")).toMatchObject({ refreshToken: "refresh" });
    expect(callback.credentialsExpired).not.toHaveBeenCalled();
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(Date.now() + 4 * 60 * 1000);
  });

  it("marks terminal invalid_grant expired once and reconnect resets the expired state", async () => {
    let refreshFails = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token" && refreshFails) return json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() - 1 });
    kv.set("sites", [{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);

    await expect(account.getAccessToken()).rejects.toThrow(/invalid_grant/);
    await expect(account.getAccessToken()).rejects.toThrow(/No Jira credentials/);

    expect(kv.has("grant")).toBe(false);
    expect(kv.has("sites")).toBe(false);
    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);

    refreshFails = false;
    await account.prepareReconnect("c".repeat(64));
    const begun = await account.beginOAuthFlow("c".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);

    expect(kv.get("grant")).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(kv.has("credentialsExpiredNotified")).toBe(false);
    expect(callback.credentialsRestored).toHaveBeenCalledWith(undefined);
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
  });

  it("retries a failed legacy credentialsRestored notification without marking it delivered", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" });
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback, setAlarm } = makeAccount();
    callback.credentialsRestored.mockRejectedValueOnce(new Error("callback unavailable"));
    kv.set("grant", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 });

    await expect(account.getAccessToken()).resolves.toBe("access-2");

    expect(kv.has("refreshRestoredNotified")).toBe(false);
    expect(kv.get("refreshRestoredPending")).toBe(true);
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    kv.set("callbackRetryAt", Date.now() - 1);
    await account.alarm();

    expect(callback.credentialsRestored).toHaveBeenCalledTimes(2);
    expect(kv.get("refreshRestoredNotified")).toBe(0);
    expect(kv.has("refreshRestoredPending")).toBe(false);
  });

  it("retries a failed terminal credentialsExpired notification while blocking API tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback, setAlarm } = makeAccount();
    callback.credentialsExpired.mockRejectedValueOnce(new Error("callback unavailable"));
    kv.set("grant", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() - 1 });
    kv.set("sites", [{ id: "site", name: "Site", url: "https://example.atlassian.net", scopes: ["read:jira-work"] }]);

    await expect(account.getAccessToken()).rejects.toThrow(/invalid_grant/);

    expect(kv.has("grant")).toBe(false);
    expect(kv.has("sites")).toBe(false);
    expect(kv.has("credentialsExpiredNotified")).toBe(false);
    expect(kv.get("credentialsExpiredPending")).toBe(true);
    expect(setAlarm.mock.calls.at(-1)?.[0]).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    await expect(account.getAccessToken()).rejects.toThrow(/No Jira credentials/);

    kv.set("callbackRetryAt", Date.now() - 1);
    await account.alarm();

    expect(callback.credentialsExpired).toHaveBeenCalledTimes(2);
    expect(kv.get("credentialsExpiredNotified")).toBe(0);
    expect(kv.has("credentialsExpiredPending")).toBe(false);
  });

  it("rejects a held refresh after revoke without returning or persisting the fresh token", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1 });
    const pending = account.getAccessToken();
    await account.revoke();
    release();
    await expect(pending).rejects.toThrow(/revoked/);
    await expect(account.getAccessToken()).rejects.toThrow(/No Jira credentials/);
    expect(kv.size).toBe(0);
    expect(callback.credentialsRestored).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["revoke", "replace"] as const)("rechecks credentials after a paused restoration notification: %s", async change => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })));
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1 });
    let release!: () => void;
    const paused = new Promise<void>(resolve => {
      callback.credentialsRestored.mockImplementationOnce(() => new Promise<void>(done => {
        release = done;
        resolve();
      }));
    });
    const pending = account.getAccessToken();
    await paused;
    expect(kv.get("grant")).toMatchObject({ accessToken: "fresh-access" });
    if (change === "revoke") await account.revoke();
    else kv.set("grant", { accessToken: "replacement-access", refreshToken: "replacement-refresh", expiresAt: Date.now() + 3600_000 });
    release();
    if (change === "revoke") {
      await expect(pending).rejects.toThrow(/revoked/);
      await expect(account.getAccessToken()).rejects.toThrow(/No Jira credentials/);
      expect(kv.size).toBe(0);
    } else {
      await expect(pending).resolves.toBe("replacement-access");
      expect(kv.get("grant")).toMatchObject({ accessToken: "replacement-access", refreshToken: "replacement-refresh" });
    }
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
  });

  it("does not let stale in-flight refresh success overwrite a newer reconnect grant", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") {
        await new Promise<void>(resolve => { release = resolve; });
        return json({ access_token: "stale-access", refresh_token: "stale-refresh", expires_in: 3600, scope: "read:jira-work" });
      }
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1 });

    const pending = account.getAccessToken();
    kv.set("grant", { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3600_000 });
    release();

    await expect(pending).resolves.toBe("new-access");
    expect(kv.get("grant")).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("does not let stale in-flight invalid_grant delete a newer reconnect grant", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") {
        await new Promise<void>(resolve => { release = resolve; });
        return json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
      }
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();
    kv.set("grant", { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1 });

    const pending = account.getAccessToken();
    kv.set("grant", { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3600_000 });
    release();

    await expect(pending).resolves.toBe("new-access");
    expect(kv.get("grant")).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(callback.credentialsExpired).not.toHaveBeenCalled();
  });

  it("restores after an initial accept, terminal invalid_grant, and reconnect lifecycle", async () => {
    const tokenResponses = [
      () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "read:jira-work" }),
      () => json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return tokenResponses.shift()?.() ?? json({ error: "unexpected" }, 500);
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();

    await completeOAuth(account, callback, "a");
    expect(callback.complete).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(kv.get("refreshRestoredNotified")).toBe(1);

    kv.set("grant", { ...(kv.get("grant") as object), expiresAt: Date.now() - 1 });
    await expect(account.getAccessToken()).rejects.toThrow(/invalid_grant/);
    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);
    expect(kv.has("refreshRestoredNotified")).toBe(false);

    await account.prepareReconnect("b".repeat(64));
    const begun = await account.beginOAuthFlow("b".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);

    expect(kv.get("grant")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(callback.credentialsRestored).toHaveBeenCalledWith(undefined);
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
    expect(kv.get("refreshRestoredNotified")).toBe(2);
  });

  it("fresh reconnect clears stale failed expiration notification before its alarm retry", async () => {
    const tokenResponses = [
      () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "read:jira-work" }),
      () => json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "read:jira-work" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://auth.atlassian.com/oauth/token") return tokenResponses.shift()?.() ?? json({ error: "unexpected" }, 500);
      if (url === "https://api.atlassian.com/oauth/token/accessible-resources") return json(SITES);
      if (url === "https://api.atlassian.com/me") return json({ account_id: "acct" });
      throw new Error(`unexpected URL ${url}`);
    }));
    const { account, kv, callback } = makeAccount();
    await completeOAuth(account, callback, "a");
    callback.credentialsExpired.mockRejectedValueOnce(new Error("callback unavailable"));
    kv.set("grant", { ...(kv.get("grant") as object), expiresAt: Date.now() - 1 });

    await expect(account.getAccessToken()).rejects.toThrow(/invalid_grant/);
    expect(kv.get("credentialsExpiredPending")).toBe(true);

    await account.prepareReconnect("b".repeat(64));
    const begun = await account.beginOAuthFlow("b".repeat(64));
    if (!begun) throw new Error("OAuth flow did not begin.");
    await account.acceptAuthCode("code", begun.oauthNonce);
    kv.set("callbackRetryAt", Date.now() - 1);
    await account.alarm();

    expect(callback.credentialsExpired).toHaveBeenCalledTimes(1);
    expect(kv.has("credentialsExpiredPending")).toBe(false);
    expect(kv.has("credentialsExpiredNotified")).toBe(false);
    expect(callback.credentialsRestored).toHaveBeenCalledTimes(1);
  });
});

async function completeOAuth(account: UserAccount, callback: { complete: ReturnType<typeof vi.fn>; credentialsRestored: ReturnType<typeof vi.fn>; credentialsExpired: ReturnType<typeof vi.fn> }, noncePrefix: string): Promise<void> {
  const nonce = noncePrefix.repeat(64).slice(0, 64);
  await account.setCallback(callback, nonce);
  const begun = await account.beginOAuthFlow(nonce);
  if (!begun) throw new Error("OAuth flow did not begin.");
  await account.acceptAuthCode("code", begun.oauthNonce);
}

function makeAccount(): { account: UserAccount; kv: Map<string, unknown>; callback: { complete: ReturnType<typeof vi.fn>; credentialsRestored: ReturnType<typeof vi.fn>; credentialsExpired: ReturnType<typeof vi.fn> }; setAlarm: ReturnType<typeof vi.fn> } {
  const account = new UserAccount();
  const kv = new Map<string, unknown>();
  const callback = { complete: vi.fn(), credentialsRestored: vi.fn(), credentialsExpired: vi.fn() };
  const setAlarm = vi.fn();
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
        setAlarm,
        deleteAlarm: vi.fn(),
        deleteAll: vi.fn(() => kv.clear()),
      },
    },
  });
  kv.set("callback", callback);
  return { account, kv, callback, setAlarm };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
