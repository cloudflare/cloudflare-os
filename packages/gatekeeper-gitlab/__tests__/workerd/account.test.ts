// UserAccount on the kit's CredentialCoordinator: refresh shortly before expiry with the rotated
// pair persisted before use, one redemption of the single-use refresh token, invalid_grant as the
// grant's death and every other refresh failure as transient, refusals adjudicated against the
// token they were about, reconnects fenced to the connection they replace, the under-scoped-grant
// remedy, and the identity read. GitLab is faked at `fetch`; the account is driven through its
// Durable Object stub.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedirectUri, withAccountApi, type Env } from "../../src/gitlab-env.js";
import { FakeGitLab, hooks, json, seedAccount, stageReconnect, tokenResponse, unwrap } from "./fake-gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `getAccessToken()` through TestHooks, so an expected rejection is data rather than an RPC error. */
async function token(userObjectId: string): Promise<string> {
  return await unwrap(await hooks().accountToken(userObjectId));
}

function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

type StoredGrant = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };

/** The grant record the kit keeps (see storage-schema.md). */
async function storedGrant(userObjectId: string): Promise<StoredGrant | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<StoredGrant>("credentials"));
}

/**
 * GitLab's token endpoint, added to `gitlab`: authorization code `code-N` is answered with grant
 * N, after `beforeAnswering` has run; refresh token `refresh-N` with grant N + 10, and the seeded
 * `test-refresh` as already redeemed. Returns the revoked tokens.
 */
function fakeOAuth(beforeAnswering: (code: string) => Promise<void> = async () => {}, gitlab = new FakeGitLab()): string[] {
  const revoked: string[] = [];
  gitlab.on("POST", /^\/oauth\/token/, async request => {
    const form = new URLSearchParams(request.body);
    const code = form.get("code");
    if (code !== null) {
      await beforeAnswering(code);
      return json(tokenResponse(Number(code.slice("code-".length))));
    }
    const refreshToken = form.get("refresh_token")!;
    if (refreshToken === "test-refresh") return json({ error: "invalid_grant" }, { status: 400 });
    return json(tokenResponse(Number(refreshToken.slice("refresh-".length)) + 10));
  });
  gitlab.on("POST", /^\/oauth\/revoke/, request => {
    revoked.push(new URLSearchParams(request.body).get("token")!);
    return json({});
  });
  gitlab.install();
  return revoked;
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
      // A refresh request carries no redirect_uri: RFC 6749 §6 defines none.
      expect(form.has("redirect_uri")).toBe(false);
      return json(tokenResponse(redemptions));
    });
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 10_000 });  // inside the 60s safety window
    expect(await token(id)).toBe("access-1");
    expect(redemptions).toBe(1);

    const grant = await storedGrant(id);
    expect(grant).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", scopes: ["api", "write_repository"] });
    expect(grant!.expiresAt).toBeGreaterThan(Date.now() + 7000 * 1000);
    // The pre-kit keys went with the migration.
    await runInDurableObject(accountStub(id), async (_instance, state) => {
      expect(state.storage.kv.get("refreshToken")).toBeUndefined();
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
    await expect(unwrap(await hooks().userDescribe(id))).rejects.toThrow(/expired or been revoked. Please reconnect/);
    // The death is stored with the grant, not just remembered: much later -- or after a restart
    // of the object -- the dead token is still not sent again.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await expect(unwrap(await hooks().userDescribe(id))).rejects.toThrow(/expired or been revoked. Please reconnect/);
    expect(redemptions).toBe(1);
    expect(await hooks().expiredNotices(id)).toBe(1);
    // The dead pair is left in place: a reconnect replaces it, and nothing else should.
    expect((await storedGrant(id))?.refreshToken).toBe("test-refresh");
    // A later refusal of the same grant says nothing new.
    expect(await hooks().reportTokenRejected(id, "test-token")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it.each([
    ["a 5xx", () => new Response("bad gateway", { status: 502 })],
    ["an Access login redirect", () => new Response(null, {
      status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/gitlab-api.example.com" },
    })],
  ])("treats %s from the token endpoint as transient: the grant survives, and the next request asks again", async (_label, answer) => {
    const gitlab = new FakeGitLab();
    let attempts = 0;
    gitlab.on("POST", /^\/oauth\/token/, () => ++attempts === 1 ? answer() : json(tokenResponse(1)));
    gitlab.install();

    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    await expect(token(id)).rejects.toThrow(/Could not refresh GitLab credentials/);
    expect(await hooks().expiredNotices(id)).toBe(0);
    expect((await storedGrant(id))?.refreshToken).toBe("test-refresh");
    // No cooldown replays the failure: a retry straight after is a fresh request.
    expect(await token(id)).toBe("access-1");
    expect(attempts).toBe(2);
  });

  it("still serves a stub-era grant that has no scopes record, reporting it as no scopes", async () => {
    new FakeGitLab().install();
    const id = await seedAccount({ scopes: null, accessToken: "stub-era" });
    expect(await token(id)).toBe("stub-era");
    expect(await accountStub(id).getScopes()).toEqual([]);
  });
});

describe("UserAccount.reportTokenRejected", () => {
  it("dismisses a refusal of a token that a refresh has since replaced", async () => {
    // GitLab invalidates an access token when it issues the next one, so a request that took
    // token A and was still in flight when A was refreshed comes back 401. That is a fact about
    // A, which is gone, and says nothing about the account: same grant, healthy new token.
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, request =>
      new URLSearchParams(request.body).get("refresh_token") === "test-refresh"
        ? json(tokenResponse(1))
        : json({ error: "invalid_grant" }, { status: 400 }));
    gitlab.install();
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    expect(await token(id)).toBe("access-1");

    expect(await hooks().reportTokenRejected(id, "test-token")).toBe("superseded");
    expect(await hooks().expiredNotices(id)).toBe(0);
    expect(gitlab.count("POST", /^\/oauth\/token/)).toBe(1);
    // The live token's refusal is adjudicated: GitLab refuses its refresh token too, so the grant
    // is dead and the Workshop hears of it.
    expect(await hooks().reportTokenRejected(id, "access-1")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(1);
  });

  it("latches only once the Workshop has heard: a notice the Workshop could not take is retried by the next refusal", async () => {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, () => json({ error: "invalid_grant" }, { status: 400 }));
    gitlab.install();
    const id = await seedAccount();
    await hooks().installCallback(id, 1);
    expect(await hooks().reportTokenRejected(id, "test-token")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(0);
    await runInDurableObject(accountStub(id), async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).not.toBe(true);
    });
    expect(await hooks().reportTokenRejected(id, "test-token")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(1);
    await runInDurableObject(accountStub(id), async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).toBe(true);
    });
    // The death was recorded the first time: the second refusal did not ask GitLab again.
    expect(gitlab.count("POST", /^\/oauth\/token/)).toBe(1);
  });

  it("re-arms when a reconnect replaces the grant, so the replacement's own death is announced", async () => {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, request => {
      const code = new URLSearchParams(request.body).get("code");
      return code === null
        ? json({ error: "invalid_grant" }, { status: 400 })
        : json(tokenResponse(Number(code.slice("code-".length))));
    });
    gitlab.install();
    const id = await seedAccount();
    await hooks().installCallback(id);
    expect(await hooks().reportTokenRejected(id, "test-token")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(1);

    await runInDurableObject(accountStub(id), async account => {
      await account.commitReconnect(await stageReconnect(account, "code-1"));
    });
    expect(await token(id)).toBe("access-1");
    expect(await hooks().reportTokenRejected(id, "access-1")).toBe("expired");
    expect(await hooks().expiredNotices(id)).toBe(2);
  });
});

describe("withAccountApi", () => {
  const ADA = { id: 1, username: "ada", name: "Ada", web_url: "https://gitlab.example.com/ada" };

  function readUser(userObjectId: string, options: { replayable?: true } = {}) {
    return withAccountApi(env as Env, accountStub(userObjectId), api => api.getCurrentUser(), options);
  }

  /**
   * GitLab holding the first `/user` request, which presents `access-1`, until `release`, then
   * refusing it: a refresh replaced that token while the request was in flight. `access-1` is
   * issued nearly expired, so a concurrent caller refreshes it again, to `access-2`.
   */
  function replacedInFlight() {
    const gitlab = new FakeGitLab();
    const asked = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let issued = 0;
    gitlab.on("POST", /^\/oauth\/token/, () => {
      issued += 1;
      return json({ ...tokenResponse(issued), expires_in: issued === 1 ? 30 : 7200 });
    });
    gitlab.on("GET", /^\/api\/v4\/user$/, async request => {
      if (request.headers.get("authorization") !== "Bearer access-1") return json(ADA);
      asked.resolve();
      await released.promise;
      return json({ message: "401 Unauthorized" }, { status: 401 });
    });
    gitlab.install();
    return { gitlab, asked: asked.promise, release: released.resolve };
  }

  it("replays a read whose token a refresh replaced in flight, rather than asking for a reconnect", async () => {
    const { gitlab, asked, release } = replacedInFlight();
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    const read = readUser(id, { replayable: true });
    await asked;
    // A concurrent caller refreshes while the read is in flight, which makes GitLab refuse the
    // token the read presented.
    expect(await token(id)).toBe("access-2");
    release();
    expect((await read).username).toBe("ada");
    expect(gitlab.count("POST", /^\/oauth\/token/)).toBe(2);
    expect(await hooks().expiredNotices(id)).toBe(0);
  });

  it("fails a call that may not be replayed as retryable when its token was replaced in flight", async () => {
    const { asked, release } = replacedInFlight();
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    const read = readUser(id);
    await asked;
    expect(await token(id)).toBe("access-2");
    release();
    await expect(read).rejects.toThrow(/renewed during this request. Please retry/);
    expect(await hooks().expiredNotices(id)).toBe(0);
    expect(await token(id)).toBe("access-2");
  });

  /** GitLab refusing the seeded token at `/user` and answering its refresh with `refresh`. */
  function refusingSeededToken(refresh: () => Response): FakeGitLab {
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, refresh);
    gitlab.on("GET", /^\/api\/v4\/user$/, request => request.headers.get("authorization") === "Bearer test-token"
      ? json({ message: "401 Unauthorized" }, { status: 401 })
      : json(ADA));
    gitlab.install();
    return gitlab;
  }

  it("refreshes past a refused token it still holds, rather than taking the refusal for the grant's death", async () => {
    // GitLab kills an access token when it issues the successor, so the refusal of a token the
    // account still holds is also what a request sees while that token's refresh is in flight.
    const gitlab = refusingSeededToken(() => json(tokenResponse(1)));
    const id = await seedAccount();
    await hooks().installCallback(id);
    expect((await readUser(id, { replayable: true })).username).toBe("ada");
    expect(gitlab.count("POST", /^\/oauth\/token/)).toBe(1);
    expect(await hooks().expiredNotices(id)).toBe(0);
    // The refused token is no longer handed out.
    expect(await token(id)).toBe("access-1");
  });

  it("stops handing out a refused live token once GitLab refuses its refresh token too", async () => {
    const gitlab = refusingSeededToken(() => json({ error: "invalid_grant" }, { status: 400 }));
    const id = await seedAccount();
    await hooks().installCallback(id);
    await expect(readUser(id, { replayable: true })).rejects.toThrow(/expired or been revoked. Please reconnect/);
    expect(await hooks().expiredNotices(id)).toBe(1);
    await expect(token(id)).rejects.toThrow(/expired/);
    expect(gitlab.count("GET", /^\/api\/v4\/user$/)).toBe(1);
  });
});

describe("UserAccount.commitReconnect", () => {
  it("discards a reconnect that another overtook, revoking its tokens rather than committing them over the newer grant", async () => {
    // Reconnect 1's code exchange is still running when reconnect 2 starts, finishes and is
    // committed. Reconnect 1's ticket is still good once its exchange returns, but the connection
    // it was to replace is gone: committing it would put its tokens -- perhaps another GitLab
    // user's -- over the grant the owner confirmed last.
    const id = await seedAccount();
    await hooks().installCallback(id);
    await runInDurableObject(accountStub(id), async account => {
      const revoked = fakeOAuth(async code => {
        if (code === "code-1") await account.commitReconnect(await stageReconnect(account, "code-2"));
      });
      const overtaken = await stageReconnect(account, "code-1");
      await expect(account.commitReconnect(overtaken)).rejects.toThrow(/reconnected again/);
      expect(revoked.toSorted()).toEqual(["access-1", "refresh-1"]);
      expect(await account.getAccessToken()).toBe("access-2");
    });
  });

  it("commits a reconnect whose grant was only refreshed meanwhile", async () => {
    // A refresh rotates the replaced grant's tokens, but it is still the connection the reconnect
    // set out to replace.
    const id = await seedAccount({ refreshToken: "refresh-0", expiresInMs: 0 });
    await hooks().installCallback(id);
    fakeOAuth();
    const stageId = await runInDurableObject(accountStub(id), async account => await stageReconnect(account, "code-1"));
    expect(await token(id)).toBe("access-10");
    await runInDurableObject(accountStub(id), async account => { await account.commitReconnect(stageId); });
    expect(await token(id)).toBe("access-1");
  });

  it("revives an account whose refresh token GitLab refused", async () => {
    // The death is recorded against the grant, so it must not outlive it: the reconnected grant
    // is served, and its own refresh token is redeemed as usual.
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    fakeOAuth();
    await expect(token(id)).rejects.toThrow(/refused the refresh token/);
    await runInDurableObject(accountStub(id), async account => {
      await account.commitReconnect(await stageReconnect(account, "code-1"));
    });
    expect(await token(id)).toBe("access-1");
    expect(await hooks().reportTokenRejected(id, "access-1")).toBe("superseded");
    expect(await token(id)).toBe("access-11");
  });
});

describe("UserAccount.acceptAuthCode", () => {
  it("revokes a grant minted for an account that was disconnected while the code was being exchanged", async () => {
    // A disconnect that lands during the exchange must not leave the new tokens live in a wiped
    // account. The fake token endpoint plays the disconnect: it revokes the account before
    // answering. Everything runs inside the object, since the fake's storage writes must come
    // from the object's own I/O context.
    const accountId = env.USER_ACCOUNT.newUniqueId();
    await hooks().installCallback(accountId.toString(), 0, "initiation");
    await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (instance, state) => {
      const flow = await instance.beginOAuthFlow("initiation", getRedirectUri(env));

      const gitlab = new FakeGitLab();
      const revoked: string[] = [];
      gitlab.on("POST", /^\/oauth\/token/, async () => {
        await instance.revoke();
        return json(tokenResponse(7));
      });
      gitlab.on("POST", /^\/oauth\/revoke/, request => {
        revoked.push(new URLSearchParams(request.body).get("token")!);
        return json({});
      });
      gitlab.install();

      await expect(instance.acceptAuthCode("code", flow!.oauthNonce)).rejects.toThrow(/disconnected while it was being authorized/);
      expect(revoked.toSorted()).toEqual(["access-7", "refresh-7"]);
      // Nothing is left behind: no grant, no stage, no key at all.
      expect([...state.storage.kv.list()]).toEqual([]);
    });
  });

  it("revokes the grant a failed first connect leaves, even one rotated while the Workshop described it", async () => {
    // The Workshop describes the new account before staging it; GitLab refusing the fresh token
    // there makes the account refresh past it, so the pair to revoke is the rotated one.
    const accountId = env.USER_ACCOUNT.newUniqueId();
    await hooks().installCallback(accountId.toString(), 0, "initiation");
    await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (instance, state) => {
      // This pool cannot mint the decorated account entrypoint (see `TestUser`); its undecorated
      // twin stands in.
      Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
      const flow = await instance.beginOAuthFlow("initiation", getRedirectUri(env));
      const gitlab = new FakeGitLab();
      gitlab.on("GET", /^\/api\/v4\/user$/, request => request.headers.get("authorization") === "Bearer access-7"
        ? json({ message: "401 Unauthorized" }, { status: 401 })
        : json({ id: 1, username: "ada", name: "Ada", web_url: "https://gitlab.example.com/ada" }));
      const revoked = fakeOAuth(undefined, gitlab);
      await expect(instance.acceptAuthCode("code-7", flow!.oauthNonce)).rejects.toThrow(/Workshop unreachable/);
      expect(revoked.toSorted()).toEqual(["access-17", "refresh-17"]);
    });
  });
});

describe("a refresh overtaken while in flight", () => {
  /** GitLab's token endpoint, answering a refresh with grant 1 once `overtake` has run; returns the revoked tokens. */
  function overtakenRefresh(overtake: () => Promise<void>): string[] {
    const gitlab = new FakeGitLab();
    const revoked: string[] = [];
    gitlab.on("POST", /^\/oauth\/token/, async request => {
      const code = new URLSearchParams(request.body).get("code");
      if (code !== null) return json(tokenResponse(Number(code.slice("code-".length))));
      await overtake();
      return json(tokenResponse(1));
    });
    gitlab.on("POST", /^\/oauth\/revoke/, request => {
      revoked.push(new URLSearchParams(request.body).get("token")!);
      return json({});
    });
    gitlab.install();
    return revoked;
  }

  // Both run inside the object, since the fake's overtaking writes must come from its own I/O context.
  it("revokes the pair it mints once a disconnect has overtaken it", async () => {
    // The disconnect revokes the pair it finds, which the refresh has already rotated out on
    // GitLab. The pair the refresh brings back is the one still live, and nobody is left to use it.
    const id = await seedAccount({ expiresInMs: 0 });
    await runInDurableObject(accountStub(id), async instance => {
      const revoked = overtakenRefresh(async () => { await instance.revoke(); });
      await expect(instance.getAccessToken()).rejects.toThrow(/disconnected while refreshing/);
      expect(revoked.toSorted()).toEqual(["access-1", "refresh-1", "test-refresh", "test-token"]);
    });
  });

  it("drops the pair it mints unrevoked once a reconnect has overtaken it", async () => {
    // GitLab does not document that revoking one refresh token leaves the rest of the
    // authorization standing, so a mint is not revoked where a connection survives it.
    const id = await seedAccount({ expiresInMs: 0 });
    await hooks().installCallback(id);
    await runInDurableObject(accountStub(id), async instance => {
      const revoked = overtakenRefresh(async () => {
        await instance.commitReconnect(await stageReconnect(instance, "code-2"));
      });
      expect(await instance.getAccessToken()).toBe("access-2");
      expect(revoked).toEqual([]);
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
    const gitlab = new FakeGitLab();
    gitlab.on("POST", /^\/oauth\/token/, () => json(tokenResponse(1)));
    gitlab.install();
    for (const scopes of [null, ["read_api", "openid", "profile", "email"], ["read_user"]]) {
      const id = await seedAccount({ scopes });
      await hooks().installCallback(id);
      const result = await unwrap(await hooks().userEnsureResources(id, PATTERNS));
      expect(result.url, JSON.stringify(scopes)).toMatch(new RegExp(`^http://localhost:8787/gatekeeper/gitlab/${id}/[0-9a-f]+$`));
      // The URL starts a reconnect for the full scopes, whose grant is only staged: the handoff
      // names a stage for commitReconnect, and the live grant is untouched meanwhile.
      const initiationNonce = result.url!.split("/").pop()!;
      await runInDurableObject(accountStub(id), async account => {
        const flow = await account.beginOAuthFlow(initiationNonce, getRedirectUri(env));
        expect(flow?.scopes).toEqual(["api", "write_repository"]);
        const handoff = await account.acceptAuthCode("code-1", flow!.oauthNonce);
        expect(handoff?.ticket).toMatch(/^[0-9a-f]+$/);
        expect(await account.getAccessToken()).toBe("test-token");
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
