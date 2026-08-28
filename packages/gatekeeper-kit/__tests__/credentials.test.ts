import { describe, expect, it, vi } from "vitest";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  CredentialSource,
  type CredentialCoordinatorOptions,
  type CredentialsKv,
  type CredentialSourceOptions,
  type CredentialsWithIdentity,
} from "../src/credentials";
import { fakeKv } from "./fake-kv";

type Creds = { token: string; expiresAt: number };

function makeKv(): CredentialsKv {
  return fakeKv();
}

function coordinator(
  kv: CredentialsKv,
  upgrade?: CredentialCoordinatorOptions<Creds>["upgrade"],
  legacyKeys: readonly string[] = ["accessToken"],
) {
  return new CredentialCoordinator<Creds>(
    kv, { expiresAt: creds => creds.expiresAt, upgrade, legacyKeys });
}

const live: Creds = { token: "live", expiresAt: Date.now() + 60 * 60 * 1000 };
const stale: Creds = { token: "stale", expiresAt: Date.now() + 1000 };

describe("CredentialCoordinator", () => {
  it("reports expiry when nothing is stored", async () => {
    await expect(coordinator(makeKv()).fresh(async () => live))
      .rejects.toThrow(CredentialsExpiredError);
  });

  it("returns stored credentials until they near expiry, then refreshes once", async () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(live);
    const refresh = vi.fn(async () => ({ token: "refreshed", expiresAt: live.expiresAt }));

    expect(await instance.fresh(refresh)).toEqual(live);
    expect(refresh).not.toHaveBeenCalled();

    instance.connect(stale);
    expect((await instance.fresh(refresh)).token).toBe("refreshed");
    expect(instance.stored()?.token).toBe("refreshed");
  });

  it("rotates an unexpired credential the provider rejected, coalescing a burst", async () => {
    // What `fresh` cannot express: a 401 on a token nowhere near its recorded expiry. Three shipped
    // gatekeepers refresh unconditionally there, and returning the rejected token instead would
    // loop the retry and report a healthy grant dead.
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(live);
    let minted = 0;
    const refresh = vi.fn(async () => ({ token: `rotated${++minted}`, expiresAt: live.expiresAt }));

    const [first, second] = await Promise.all([instance.rotate(refresh), instance.rotate(refresh)]);
    expect(first.token).toBe("rotated1");
    expect(second.token).toBe("rotated1");
    expect(refresh).toHaveBeenCalledOnce();
    expect(instance.stored()?.token).toBe("rotated1");
  });

  it("refuses to rotate an account holding no grant", async () => {
    await expect(coordinator(makeKv()).rotate(async () => live))
      .rejects.toThrow(CredentialsExpiredError);
  });

  it("refuses a refresh window that would read a dead token as live", async () => {
    // Fails open, unlike a bad `maxPending`: a negative skew moves the freshness boundary past
    // expiry, and a non-finite one makes the comparison itself meaningless.
    for (const refreshSkewMs of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(() => new CredentialCoordinator<Creds>(makeKv(), { refreshSkewMs }))
        .toThrow(/refreshSkewMs must be a non-negative finite number/);
    }
    expect(() => new CredentialCoordinator<Creds>(makeKv(), { refreshSkewMs: 0 })).not.toThrow();
  });

  it("requires expiry callbacks to return a finite epoch or undefined", async () => {
    for (const expiresAt of [Infinity, -Infinity, Number.NaN]) {
      const instance = new CredentialCoordinator<Creds>(makeKv(), { expiresAt: () => expiresAt });
      instance.connect(live);
      await expect(instance.fresh(async () => live))
        .rejects.toThrow(`expiresAt must be finite or undefined, got ${expiresAt}.`);
    }

    for (const expiresAt of [undefined, live.expiresAt]) {
      const instance = new CredentialCoordinator<Creds>(makeKv(), { expiresAt: () => expiresAt });
      instance.connect(live);
      await expect(instance.fresh(async () => stale)).resolves.toEqual(live);
    }
  });

  it("honours a refresh window wider than the default", async () => {
    const instance = new CredentialCoordinator<Creds>(makeKv(), {
      expiresAt: creds => creds.expiresAt,
      refreshSkewMs: 5 * 60_000,
    });
    instance.connect({ token: "soon", expiresAt: Date.now() + 3 * 60_000 });

    // Three minutes out: outside the default one-minute window, inside this one.
    const refreshed = await instance.fresh(async () => ({
      token: "refreshed",
      expiresAt: live.expiresAt,
    }));
    expect(refreshed.token).toBe("refreshed");
  });

  it("coalesces concurrent refreshes onto one provider round-trip", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();
    const refresh = vi.fn(() => promise);

    const both = Promise.all([instance.fresh(refresh), instance.fresh(refresh)]);
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await both).map(creds => creds.token)).toEqual(["refreshed", "refreshed"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("coalesces refreshes across coordinator instances over one storage", async () => {
    // The flight is keyed by the storage object, so a port constructing a coordinator per call
    // still spends one single-use refresh token, not one per instance.
    const kv = makeKv();
    const first = coordinator(kv);
    const second = coordinator(kv);
    first.connect(stale);
    let minted = 0;
    const refresh = vi.fn(async () => ({ token: `rotated${++minted}`, expiresAt: live.expiresAt }));

    const both = await Promise.all([first.rotate(refresh), second.rotate(refresh)]);
    expect(both.map(creds => creds.token)).toEqual(["rotated1", "rotated1"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("preserves the connection generation across refresh, rotating it on connect and clear", async () => {
    const instance = coordinator(makeKv());
    // Minted on first read and stored, so it is never "".
    const generation = instance.connectionGeneration();
    expect(generation).toMatch(/^[0-9a-f]{64}$/);
    expect(instance.connectionGeneration()).toBe(generation);

    instance.connect(stale);
    const connected = instance.connectionGeneration();
    expect(connected).not.toBe(generation);

    // A refresh rotates the identity fence but must not invalidate connection-keyed consumers.
    const fence = instance.identity();
    await instance.fresh(async () => live);
    expect(instance.identity()).not.toBe(fence);
    expect(instance.connectionGeneration()).toBe(connected);

    instance.clear();
    expect(instance.connectionGeneration()).not.toBe(connected);
  });

  it("lets a reconnect landing mid-refresh win", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("reports expiry when a revoke lands mid-refresh", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.clear();
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
    expect(instance.stored()).toBeUndefined();
  });

  it("leaves credentials intact when a refresh fails for infrastructure reasons", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);

    await expect(instance.fresh(async () => { throw new Error("502 from origin"); }))
      .rejects.toThrow("502 from origin");
    expect(instance.stored()).toEqual(stale);

    await expect(instance.fresh(async () => {
      throw new CredentialsExpiredError("invalid_grant");
    })).rejects.toThrow(CredentialsExpiredError);
    expect(instance.stored()).toEqual(stale);
  });

  it("propagates an infrastructure failure that races a reconnect, unfenced", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    reject(new Error("502 from origin"));

    // Only grant death is fenced; swallowing this would hide the outage, and fencing it against a
    // clear() would report an infrastructure failure as expiry.
    await expect(refreshing).rejects.toThrow("502 from origin");
  });

  it("issues an unguessable identity per write that a deleteAll cannot reissue", () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    // The one value that is never a fence: no credentials have ever been surfaced.
    expect(instance.identity()).toBe("");

    instance.connect(live);
    const first = instance.identity();
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    instance.connect(live);
    expect(instance.identity()).not.toBe(first);

    // revoke() and the self-destruct alarm both deleteAll, which a counter would restart from 1.
    // Superseding rotates rather than deletes, so a fence taken before it cannot come back.
    instance.clear();
    const superseded = instance.identity();
    expect(superseded).toMatch(/^[0-9a-f]{64}$/);
    expect(superseded).not.toBe(first);
  });

  it("fences a record written before the account had identities", async () => {
    const kv = makeKv();
    // What a pre-kit gatekeeper left behind: the canonical key, with no identity beside it.
    kv.put("credentials", stale);
    const instance = coordinator(kv);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // Raw, as revoke()'s deleteAll() leaves it -- no rotation of its own for the fence to lean on.
    kv.delete("credentials");
    kv.delete("credentials:identity");
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    // Only the identity `stored()` lazily minted for the pre-kit record can fence this: an
    // unfenceable "" would commit it over the wipe and reconnect the account the user revoked.
    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
    expect(kv.get("credentials")).toBeUndefined();
  });

  it("retires the legacy migration when the account is cleared before its first read", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });

    // A reconnect lands before anything read the credentials, so the migration never ran.
    const instance = coordinator(kv, upgrade);
    instance.connect(live);
    instance.clear();

    // Running it now would resurrect the grant the user has since replaced and revoked.
    expect(instance.stored()).toBeUndefined();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("retires the legacy migration for an upgrade the deployment had not shipped yet", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");

    // The port lands in two deployments: this one has no upgrade() at all, and the user
    // disconnects under it.
    coordinator(kv).clear();

    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });

    // The next deployment adds one, and the legacy key it reads is still sitting there. This is why
    // clear() marks unconditionally: it cannot know which upgrade() a later version will bring.
    expect(coordinator(kv, upgrade).stored()).toBeUndefined();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it("cannot resurrect a legacy grant that was adopted and then cleared", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    // This coordinator declares no legacy keys, so the marker is the only thing retiring them.
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    const instance = coordinator(kv, upgrade, []);

    expect(instance.stored()?.token).toBe("legacy");
    instance.clear();

    expect(instance.stored()).toBeUndefined();
    expect(upgrade).toHaveBeenCalledOnce();
  });

  // Both of these pin write ORDER inside a single implicit transaction. A throw does not roll one
  // back, so the order is the only thing deciding what a storage failure leaves behind.
  it("rotates the fence even when the credential write fails", async () => {
    const kv = makeKv();
    let failCredentialWrite = false;
    const failing: CredentialsKv = {
      get: kv.get,
      delete: kv.delete,
      put: (key, value) => {
        if (failCredentialWrite && key === "credentials") throw new Error("storage unavailable");
        kv.put(key, value);
      },
    };
    const instance = coordinator(failing);
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // A reconnect lands mid-refresh and its record write fails -- after the fence rotated.
    failCredentialWrite = true;
    expect(() => instance.connect(live)).toThrow("storage unavailable");
    failCredentialWrite = false;

    resolve({ token: "refreshed", expiresAt: live.expiresAt });
    // Publishing before rotating would leave this refresh's fence matching, and it would commit
    // over a reconnect that had already been accepted.
    expect((await refreshing).token).toBe("stale");
    expect(instance.stored()?.token).toBe("stale");
  });

  it("retires the migration even when the clear cannot finish", () => {
    const kv = makeKv();
    kv.put("legacy-token", "legacy");
    const upgrade = vi.fn((legacy: Pick<CredentialsKv, "get">) => {
      const token = legacy.get<string>("legacy-token");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    let failIdentityWrite = false;
    const failing: CredentialsKv = {
      get: kv.get,
      delete: kv.delete,
      put: (key, value) => {
        if (failIdentityWrite && key === "credentials:identity") {
          throw new Error("storage unavailable");
        }
        kv.put(key, value);
      },
    };
    const instance = coordinator(failing, upgrade, []);

    expect(instance.stored()?.token).toBe("legacy");
    failIdentityWrite = true;
    expect(() => instance.clear()).toThrow("storage unavailable");
    failIdentityWrite = false;

    // The record goes last, so a failure here drops nothing: the account is still connected, and
    // the marker already landed. Dropping it first would leave no record and no marker, and this
    // read would re-run the migration and hand back the grant the user was disconnecting.
    expect(instance.stored()?.token).toBe("legacy");
    expect(upgrade).toHaveBeenCalledOnce();
  });

  it("refuses a refresh fenced out by a revoke and reconnect that wiped storage", async () => {
    const kv = makeKv();
    const instance = coordinator(kv);
    instance.connect(stale);
    const { promise, resolve } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    // What revoke() does, followed by a fresh connection.
    kv.delete("credentials");
    kv.delete("credentials:identity");
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    resolve({ token: "refreshed", expiresAt: live.expiresAt });

    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("never lets a stale grant's death expire the grant that replaced it", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
    reject(new CredentialsExpiredError("invalid_grant"));

    // Fenced out: the failure belonged to the credentials the reconnect replaced.
    expect((await refreshing).token).toBe("reconnected");
    expect(instance.stored()?.token).toBe("reconnected");
  });

  it("still reports expiry when a fenced-out failure finds nothing stored", async () => {
    const instance = coordinator(makeKv());
    instance.connect(stale);
    const { promise, reject } = Promise.withResolvers<Creds>();

    const refreshing = instance.fresh(() => promise);
    instance.clear();
    reject(new CredentialsExpiredError("invalid_grant"));

    await expect(refreshing).rejects.toThrow(CredentialsExpiredError);
  });

  it("migrates legacy keys once, then reads the migrated record", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    const upgrade = vi.fn((storage: Pick<CredentialsKv, "get">) => {
      const token = storage.get<string>("accessToken");
      return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
    });
    const instance = coordinator(kv, upgrade);

    expect(instance.stored()?.token).toBe("legacy");
    expect(instance.stored()?.token).toBe("legacy");
    expect(upgrade).toHaveBeenCalledOnce();
    expect(kv.get("accessToken")).toBeUndefined();
    expect(kv.get<Creds>("credentials")?.token).toBe("legacy");
  });

  it("leaves the legacy grant intact when the migration throws", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    const instance = coordinator(kv, () => {
      throw new Error("malformed legacy record");
    });

    expect(() => instance.stored()).toThrow("malformed legacy record");
    // A throw cannot roll back a Durable Object's implicit transaction, so the migration may not
    // delete anything itself: the grant is still here to retry from, and is not marked migrated.
    expect(kv.get("accessToken")).toBe("legacy");
    expect(kv.get("credentials:migrated")).toBeUndefined();
  });

  it("retries a reap the migration could not finish", () => {
    const kv = makeKv();
    kv.put("accessToken", "legacy");
    let reapable = false;
    const failing: CredentialsKv = {
      ...kv,
      delete: key => {
        if (!reapable && key === "accessToken") throw new Error("storage unavailable");
        kv.delete(key);
      },
    };
    const instance = new CredentialCoordinator<Creds>(failing, {
      expiresAt: creds => creds.expiresAt,
      legacyKeys: ["accessToken"],
      upgrade: storage => {
        const token = storage.get<string>("accessToken");
        return token === undefined ? undefined : { token, expiresAt: live.expiresAt };
      },
    });

    expect(() => instance.stored()).toThrow("storage unavailable");
    // Committed, so no later read re-enters the migration -- the stale grant is still readable by
    // anything that knows the old key.
    expect(kv.get("accessToken")).toBe("legacy");
    expect(instance.stored()?.token).toBe("legacy");

    reapable = true;
    instance.clear();
    expect(kv.get("accessToken")).toBeUndefined();
  });

  it("refuses to declare a legacy key the coordinator owns", () => {
    // Sweeping the whole `credentials:` namespace would take the identity with it, and an
    // unfenceable "" would then let an in-flight refresh commit over a revoke.
    expect(() => coordinator(makeKv(), undefined, ["accessToken", "credentials:identity"]))
      .toThrow('Legacy key "credentials:identity" is one the coordinator owns.');
  });
});

describe("CredentialSource", () => {
  function source(overrides: Partial<CredentialSourceOptions<Creds>> = {}) {
    const getCredentials = vi.fn(async () => ({ creds: live, identity: "id-a" }));
    const noteCredentialsExpired = vi.fn(async (_identity: string) => {});
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
      ...overrides,
    });
    return { instance, getCredentials, noteCredentialsExpired };
  }

  it("coalesces concurrent account round-trips", async () => {
    const { instance, getCredentials } = source();

    const [first, second] = await Promise.all([instance.get(), instance.get()]);
    expect(first).toEqual(live);
    expect(second).toEqual(live);
    expect(getCredentials).toHaveBeenCalledOnce();

    expect(await instance.get()).toEqual(live);
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("hands the operation the credentials it fetched", async () => {
    const { instance } = source();
    expect(await instance.run(async creds => creds.token)).toBe("live");
  });

  it("reports expiry against the identity the failed call used", async () => {
    const { instance, getCredentials, noteCredentialsExpired } = source();

    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");

    await instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("never reports an identity a concurrent refetch installed after the call started", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      let identity = "id-a";
      const noteCredentialsExpired = vi.fn(async (_identity: string) => {});
      const instance = new CredentialSource<Creds>({
        account: () => ({
          getCredentials: async () => ({ creds: live, identity }),
          noteCredentialsExpired,
        }),
        isAuthError: error => error instanceof Error && error.message === "401",
        expiredMessage: "Reconnect the account.",
      });

      await expect(instance.run(async () => {
        // A reconnect lands and another caller refetches while this call is in flight.
        identity = "id-b";
        now.mockReturnValue(1_000 + 30_000);
        await instance.get();
        throw new Error("401");
      })).rejects.toThrow("Reconnect the account.");

      // Reporting id-b would expire the grant the user just reconnected.
      expect(noteCredentialsExpired).toHaveBeenCalledWith("id-a");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps the reconnect message when reporting expiry fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { instance } = source({
        account: () => ({
          getCredentials: async () => ({ creds: live, identity: "id-a" }),
          noteCredentialsExpired: async () => { throw new Error("account unreachable"); },
        }),
      });

      await expect(instance.run(async () => { throw new Error("401"); }))
        .rejects.toThrow("Reconnect the account.");
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("passes other failures through untouched", async () => {
    const { instance, noteCredentialsExpired } = source();

    await expect(instance.run(async () => { throw new Error("500"); })).rejects.toThrow("500");
    expect(noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("never hands a caller the fetch in flight when credentials were reported dead", async () => {
    const fetches: Array<(fetched: CredentialsWithIdentity<Creds>) => void> = [];
    const getCredentials = vi.fn(() => new Promise<CredentialsWithIdentity<Creds>>(resolve => {
      fetches.push(resolve);
    }));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, noteCredentialsExpired: async () => {} }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });

    // Two provider calls share one fetch, the way parallel calls in one gadget request do.
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const firstCall = instance.run(async () => {
      await first.promise;
      throw new Error("401");
    });
    const secondCall = instance.run(async () => {
      await second.promise;
      throw new Error("401");
    });
    fetches[0]?.({ creds: live, identity: "id-a" });

    // The first 401 empties the cache, so the next caller opens a second fetch...
    second.resolve();
    await expect(secondCall).rejects.toThrow("Reconnect the account.");
    const riding = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);

    // ...which is still in flight when the second 401 declares those credentials dead.
    first.resolve();
    await expect(firstCall).rejects.toThrow("Reconnect the account.");

    // Riding it would hand a caller credentials that have already been reported expired.
    const after = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(3);

    const fromSecond = { token: "second-fetch", expiresAt: live.expiresAt };
    const fromThird = { token: "third-fetch", expiresAt: live.expiresAt };
    fetches[1]?.({ creds: fromSecond, identity: "id-b" });
    fetches[2]?.({ creds: fromThird, identity: "id-c" });
    expect(await riding).toEqual(fromSecond);
    expect(await after).toEqual(fromThird);
  });
});
