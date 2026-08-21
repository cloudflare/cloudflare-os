import { describe, expect, it } from "vitest";
import { AccessTokenCache, type AccessTokenRequest } from "../src/auth-retry";

/** A stub authority recording every request, answering with whatever token it currently holds. */
function authority(initial: string) {
  let requests: (AccessTokenRequest | undefined)[] = [];
  let stored = initial;
  let cache = new AccessTokenCache(async opts => {
    requests.push(opts);
    return { token: stored, expires: new Date(Date.now() + 3600_000) };
  });
  return {
    cache,
    requests,
    /** What a reconnect does: replace the stored token, telling no gatekeeper about it. */
    restore(token: string) { stored = token; },
  };
}

describe("AccessTokenCache", () => {
  it("answers repeat calls from the memo", async () => {
    let account = authority("tok");

    expect(await account.cache.get()).toBe("tok");
    expect(await account.cache.get()).toBe("tok");
    expect(account.requests).toHaveLength(1);
  });

  it("picks up a token stored since it memoized, without asking for a mint", async () => {
    let account = authority("narrow");
    expect(await account.cache.get()).toBe("narrow");
    account.restore("widened");

    expect(await account.cache.get()).toBe("narrow");
    expect(await account.cache.get({ reloadStored: true })).toBe("widened");

    expect(account.requests).toEqual([undefined, { reloadStored: true }]);
  });

  it("memoizes the reloaded token, so one 403 costs one round trip", async () => {
    let account = authority("narrow");
    await account.cache.get();
    account.restore("widened");
    await account.cache.get({ reloadStored: true });

    expect(await account.cache.get()).toBe("widened");
    expect(account.requests).toHaveLength(2);
  });
});
