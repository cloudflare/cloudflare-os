// UserAccount: token refresh under the lock, rotation persisted before use, terminal vs.
// transient refresh failures, the under-scoped-grant remedy, and the identity read. GitLab is faked
// at `fetch`; the account is driven through its Durable Object stub.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGitLab, hooks, json, seedAccount, unwrap } from "./fake-gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `getAccessToken()` through TestHooks, so an expected rejection is data rather than an RPC error. */
async function token(userObjectId: string): Promise<string> {
  return await unwrap(await hooks().accountToken(userObjectId));
}

function tokenResponse(n: number) {
  return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 7200, token_type: "bearer" };
}

describe("UserAccount.getAccessToken", () => {
  it("returns the stored token without a network call while it is fresh", async () => {
    const gitlab = new FakeGitLab();
    gitlab.install();
    const id = await seedAccount({ accessToken: "fresh" });
    expect(await token(id)).toBe("fresh");
    expect(gitlab.requests).toHaveLength(0);
  });

  it("refreshes an expiring token, persisting the rotated pair before returning", async () => {
    const gitlab = new FakeGitLab();
    let redemptions = 0;
    gitlab.on("POST", /^\/oauth\/token/, request => {
      redemptions += 1;
      const form = new URLSearchParams(request.body);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("test-refresh");
      expect(form.get("client_id")).toBe("test-client-id");
      expect(form.get("client_secret")).toBe("test-client-secret");
      expect(form.get("redirect_uri")).toBe("http://localhost:8787/gatekeeper/gitlab/oauth");
      return json(tokenResponse(redemptions));
    });
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 10_000 });  // inside the 60s safety window
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    expect(await token(id)).toBe("access-1");
    expect(redemptions).toBe(1);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.kv.get("refreshToken")).toBe("refresh-1");
      expect(state.storage.kv.get("accessToken")).toBe("access-1");
      const expiresAt = state.storage.kv.get<number>("accessTokenExpiresAt")!;
      expect(expiresAt).toBeGreaterThan(Date.now() + 7000 * 1000);
    });

    // Now fresh: no further redemption.
    expect(await token(id)).toBe("access-1");
    expect(redemptions).toBe(1);
  });

  it("collapses concurrent callers into exactly one redemption of the single-use refresh token", async () => {
    const gitlab = new FakeGitLab();
    let redemptions = 0;
    gitlab.on("POST", /^\/oauth\/token/, async () => {
      redemptions += 1;
      // Hold the exchange open so every caller is waiting when the first one completes.
      await new Promise(resolve => setTimeout(resolve, 20));
      return json(tokenResponse(redemptions));
    });
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 0 });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => token(id)));
    expect(new Set(tokens)).toEqual(new Set(["access-1"]));
    expect(redemptions).toBe(1);
  });

  it("treats invalid_grant as terminal: reconnect error, credentialsExpired once, no retry storm", async () => {
    const gitlab = new FakeGitLab();
    let redemptions = 0;
    gitlab.on("POST", /^\/oauth\/token/, () => {
      redemptions += 1;
      return json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
    });
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    await expect(token(id)).rejects.toThrow(/expired or been revoked. Please reconnect/);
    await expect(token(id)).rejects.toThrow(/expired or been revoked. Please reconnect/);
    // The cooldown answers the second call from memory.
    expect(redemptions).toBe(1);
    expect(await hooks().expiredNotices(id)).toBe(1);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.kv.get("expiredNotified")).toBe(true);
      // The dead pair is left in place: a reconnect replaces it, and nothing else should.
      expect(state.storage.kv.get("refreshToken")).toBe("test-refresh");
    });
    // A later refusal of the same grant says nothing new.
    await hooks().credentialsRejected(id, undefined);
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it("treats a 5xx from the token endpoint as transient: the refresh token survives", async () => {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, () => new Response("bad gateway", { status: 502 }));
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 0 });
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    await expect(token(id)).rejects.toThrow(/Could not refresh GitLab credentials/);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.kv.get("expiredNotified")).toBeUndefined();
      expect(state.storage.kv.get("refreshToken")).toBe("test-refresh");
    });
  });

  it("still serves a stub-era grant that has no scopes record: the token is the token", async () => {
    new FakeGitLab().install();
    const id = await seedAccount({ scopes: null, accessToken: "stub-era" });
    expect(await token(id)).toBe("stub-era");
  });
});

describe("UserAccount.credentialsRejected", () => {
  it("ignores a refusal of a grant that a reconnect has since replaced", async () => {
    // A request took grant A's token; a reconnect installed grant B while it was in flight; A's
    // 401 arrives late. It is a fact about A, and B is healthy.
    new FakeGitLab().install();
    const id = await seedAccount();
    await hooks().installCallback(id);
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    await runInDurableObject(stub, async (_i, state) => { state.storage.kv.put("grantId", "grant-b"); });
    await hooks().credentialsRejected(id, "grant-a");
    expect(await hooks().expiredNotices(id)).toBe(0);
    // The live grant's refusal is reported.
    await hooks().credentialsRejected(id, "grant-b");
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it("latches only once the Workshop has heard: a notice the Workshop could not take is retried by the next refusal", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    await hooks().installCallback(id, 1);
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    await runInDurableObject(stub, async (_i, state) => { state.storage.kv.put("grantId", "grant-a"); });
    await hooks().credentialsRejected(id, "grant-a");
    expect(await hooks().expiredNotices(id)).toBe(0);
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).not.toBe(true);
    });
    await hooks().credentialsRejected(id, "grant-a");
    expect(await hooks().expiredNotices(id)).toBe(1);
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).toBe(true);
    });
  });

  it("re-arms when a grant is written, so the replacement's own death is announced", async () => {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, () => json(tokenResponse(2)));
    gitlab.install();
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    await hooks().credentialsRejected(id, undefined);
    expect(await hooks().expiredNotices(id)).toBe(1);
    // A refresh writes a new pair (same grant): the latch is re-armed by the write.
    await token(id);
    await hooks().credentialsRejected(id, undefined);
    expect(await hooks().expiredNotices(id)).toBe(2);
  });
});

describe("UserAccount.acceptAuthCode", () => {
  it("revokes a grant minted for an account that was disconnected while the code was being exchanged", async () => {
    // The exchange is a network call outside the account's lock; a disconnect that lands during
    // it must not leave the new tokens live in a wiped account. The fake token endpoint plays
    // the disconnect: it wipes the account before answering. Everything runs inside the object,
    // since the fake's storage writes must come from the object's own I/O context.
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.newUniqueId());
    const nonce = "a".repeat(64);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + 60_000, stage: "oauth" });
      state.storage.kv.put("codeVerifier", "verifier");
      state.storage.kv.put("requestedScopes", ["api", "write_repository"]);
      // Only its presence matters here: the guard fires before the callback would be used.
      state.storage.kv.put("callback", "placeholder");

      const gitlab = new FakeGitLab();
      const revoked: string[] = [];
      gitlab.on("POST", /^\/oauth\/token/, async () => {
        await state.storage.deleteAll();
        return json(tokenResponse(7));
      });
      gitlab.on("POST", /^\/oauth\/revoke/, request => {
        revoked.push(new URLSearchParams(request.body).get("token")!);
        return json({});
      });
      gitlab.install();

      await expect(instance.acceptAuthCode("code", nonce)).rejects.toThrow(/disconnected while it was being authorized/);
      expect(revoked.toSorted()).toEqual(["access-7", "refresh-7"]);
      expect(state.storage.kv.get("accessToken")).toBeUndefined();
      expect(state.storage.kv.get("stagedCredentials")).toBeUndefined();
    });
  });
});

describe("GatekeeperUserImpl.ensureResources", () => {
  const PATTERNS = ["https://gitlab.example.com/:project+"];

  it("needs nothing for a grant that carries the full scopes", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    expect(await unwrap(await hooks().userEnsureResources(id, PATTERNS))).toEqual({});
  });

  it("answers an under-scoped or stub-era grant with a reconnect URL rather than binding it", async () => {
    new FakeGitLab().install();
    for (const scopes of [null, ["read_api", "openid", "profile", "email"], ["read_user"]]) {
      const id = await seedAccount({ scopes });
      const result = await unwrap(await hooks().userEnsureResources(id, PATTERNS));
      expect(result.url, JSON.stringify(scopes)).toMatch(new RegExp(`^http://localhost:8787/gatekeeper/gitlab/${id}/[0-9a-f]+$`));
      // The URL is a reconnect: the flow is staged as one, so the eventual grant is only made
      // live through commitReconnect.
      await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id)), async (_instance, state) => {
        expect(state.storage.kv.get<{ reconnect?: true }>("nonce")?.reconnect).toBe(true);
        expect(state.storage.kv.get("requestedScopes")).toEqual(["api", "write_repository"]);
      });
    }
  });
});

describe("GatekeeperUserImpl identity", () => {
  it("reports the confirmed primary email, and null when unconfirmed", async () => {
    const gitlab = new FakeGitLab();
    let confirmed = true;
    gitlab.on("GET", /^\/api\/v4\/user$/, request => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      return json({
        id: 1, username: "ada", name: "Ada", web_url: "https://gitlab.example.com/ada",
        avatar_url: "https://gitlab.example.com/a.png",
        email: "ada@example.com", public_email: "",
        confirmed_at: confirmed ? "2024-01-01T00:00:00Z" : null,
      });
    });
    gitlab.install();

    const id = await seedAccount();
    expect(await unwrap(await hooks().userEmail(id))).toBe("ada@example.com");
    const described = await unwrap(await hooks().userDescribe(id));
    expect(described.uniqueName).toBe("ada");
    expect(described.displayName).toBe("Ada");
    confirmed = false;
    expect(await unwrap(await hooks().userEmail(id))).toBeNull();
  });
});
