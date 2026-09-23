// The refresh path of `UserAccount.getAccessToken`: only a refresh the provider refuses outright
// expires the account, concurrent reads redeem a rotating refresh token once, and a reconnect that
// lands mid-refresh is neither overwritten by the refresh it overtook nor made to wait for it.
//
// Each test runs inside the account's own context: a promise the test resolves would otherwise hand
// the account's continuation to the test's context, which may not touch the account's I/O.

import { env, runInDurableObject } from "cloudflare:test";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expiryNotices, type TestExports, type UserAccount } from "../worker.js";

type StoredAccessToken = { token: string; expires: number };

afterEach(() => vi.unstubAllGlobals());

let accounts = 0;

/** Runs `test` in a connected account holding `refresh-1`, whose cached `access-1` expires at `expires`. */
function inAccount<R>(expires: number,
  test: (account: UserAccount, state: DurableObjectState) => Promise<R>): Promise<R> {
  return runInDurableObject(env.USER_ACCOUNT.getByName(`account-${accounts++}`), (account, state) => {
    state.storage.kv.put("refreshToken", "refresh-1");
    state.storage.kv.put<StoredAccessToken>("accessToken", { token: "access-1", expires });
    return test(account, state);
  });
}

/**
 * Stubs the token endpoint, answering with `respond(refreshToken)`; each response waits for
 * `release`, if one is given.
 */
function tokenEndpoint(respond: (refreshToken: string | null) => Response | Promise<Response>,
  release?: Promise<void>) {
  const reached = Promise.withResolvers<void>();
  const fetch = vi.fn(async (_input: string, init: RequestInit) => {
    reached.resolve();
    await release;
    return respond((init.body as URLSearchParams).get("refresh_token"));
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, reached: reached.promise };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection.");
}

describe("UserAccount.getAccessToken", () => {
  it("serves the unexpired cached token through a transient refresh failure", async () => {
    const { fetch } = tokenEndpoint(() => new Response("unavailable", { status: 503 }));

    // Inside the refresh skew, so each read refreshes, but the cached token still works.
    await inAccount(Date.now() + 30_000, async account => {
      expect(await account.getAccessToken()).toBe("access-1");
      // Not expired: the next read tries again rather than giving up on the grant.
      expect(await account.getAccessToken()).toBe("access-1");
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces a transient failure once the cached token has expired", async () => {
    tokenEndpoint(() => new Response("unavailable", { status: 503 }));

    const error = await inAccount(Date.now() - 1000, account => rejection(account.getAccessToken()));

    expect(error).toMatchObject({ name: "OAuthResponseError", httpStatus: 503 });
  });

  it("notifies expiry only when the provider refuses the refresh", async () => {
    const responses = [
      () => new Response("unavailable", { status: 503 }),
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    ];
    tokenEndpoint(() => responses.shift()!());

    await inAccount(Date.now() - 1000, async (account, { storage, exports }) => {
      const callback = (label: string) =>
        (exports as unknown as TestExports).TestConnectCallback({ props: { label } });
      storage.kv.put("callback", callback("failed"));
      await rejection(account.getAccessToken());
      storage.kv.put("callback", callback("refused"));
      expect(await account.getAccessToken()).toBeNull();
    });

    // Notices are unawaited, so one sent for the failure would arrive before the refusal's.
    await vi.waitFor(() => expect(expiryNotices).toContain("refused"));
    expect(expiryNotices).toEqual(["refused"]);
  });

  it("redeems the refresh token once for concurrent reads", async () => {
    const release = Promise.withResolvers<void>();
    const { fetch, reached } = tokenEndpoint(() => Response.json({
      access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600,
    }), release.promise);

    await inAccount(Date.now() - 1000, async (account, { storage }) => {
      const reads = [account.getAccessToken(), account.getAccessToken()];
      await reached;
      release.resolve();

      expect(await Promise.all(reads)).toEqual(["access-2", "access-2"]);
      expect(storage.kv.get("refreshToken")).toBe("refresh-2");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a new refresh token", "refresh-new"],
    ["the refresh token it overtook", "refresh-1"],
  ])("keeps a reconnect with %s that lands while a refresh is in flight", async (_, refreshToken) => {
    const release = Promise.withResolvers<void>();
    const { reached } = tokenEndpoint(() => Response.json({
      access_token: "access-stale", refresh_token: "refresh-stale", expires_in: 3600, scope: "account:read",
    }), release.promise);
    const grant = {
      refreshToken,
      accessToken: { token: "access-new", expires: Date.now() + 3_600_000 },
      grantedScopes: ["user:read", "offline_access"],
    };

    await inAccount(Date.now() - 1000, async (account, { storage }) => {
      const read = account.getAccessToken();
      await reached;
      await account.commitReconnect(stageCredentials(storage.kv, grant, Date.now()));
      release.resolve();

      expect(await read).toBe("access-new");
      expect(storage.kv.get("refreshToken")).toBe(refreshToken);
      expect(storage.kv.get("accessToken")).toEqual(grant.accessToken);
      expect(storage.kv.get("grantedScopes")).toEqual(grant.grantedScopes);
    });
  });

  it("refreshes a reconnected grant in its own flight, not the one it overtook", async () => {
    const oldGrant = Promise.withResolvers<void>();
    const newGrant = Promise.withResolvers<void>();
    const { fetch, reached } = tokenEndpoint(async refreshToken => {
      await (refreshToken === "refresh-1" ? oldGrant : newGrant).promise;
      return Response.json({
        access_token: `access-from-${refreshToken}`,
        refresh_token: `${refreshToken}-rotated`,
        expires_in: 3600,
      });
    });

    await inAccount(Date.now() - 1000, async (account, { storage }) => {
      const overtaken = account.getAccessToken();
      await reached;
      // Inside the refresh skew, so reads of the reconnected grant have to refresh it.
      await account.commitReconnect(stageCredentials(storage.kv, {
        refreshToken: "refresh-new",
        accessToken: { token: "access-new", expires: Date.now() + 30_000 },
        grantedScopes: ["user:read", "offline_access"],
      }, Date.now()));
      const read = account.getAccessToken();

      oldGrant.resolve();
      expect(await overtaken).toBe("access-new");
      // Settling the overtaken flight must not release the reconnected grant's.
      const joined = account.getAccessToken();
      newGrant.resolve();

      expect(await read).toBe("access-from-refresh-new");
      expect(await joined).toBe("access-from-refresh-new");
      expect(storage.kv.get("refreshToken")).toBe("refresh-new-rotated");
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
