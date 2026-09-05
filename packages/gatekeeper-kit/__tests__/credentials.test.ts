import { describe, expect, it, vi } from "vitest";
import {
  CredentialCoordinator,
  CredentialsChangedError,
  CredentialsExpiredError,
  CredentialSource,
  isCredentialsChanged,
  isCredentialsExpired,
  type CredentialCoordinatorOptions,
  type CredentialsKv,
  type CredentialSourceOptions,
  type CredentialsWithIdentity,
  type CredentialRead,
  type RejectionVerdict,
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

/** A notify that stalls until released, resolving `entered` once the notification is in flight. */
function stallingNotify() {
  const entered = Promise.withResolvers<void>();
  const stalled = Promise.withResolvers<void>();
  return {
    notify: () => { entered.resolve(); return stalled.promise; },
    entered: entered.promise,
    release: stalled.resolve,
  };
}

/** Starts a run whose 401 stalls until released, resolving once the operation has entered. */
async function stalledRun(
  instance: CredentialSource<Creds>, options: { replayable?: boolean } = {},
) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const run = instance.run(async () => {
    entered.resolve();
    await gate.promise;
    throw new Error("401");
  }, options);
  await entered.promise;
  return { run, release: gate.resolve };
}

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

  describe("snapshot", () => {
    it("returns a coherent triple of the stored credentials", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);

      const read = await instance.snapshot(async () => live);
      expect(read).toEqual({
        creds: live,
        identity: instance.identity(),
        generation: instance.connectionGeneration(),
      });
      expect(read.identity).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps the triple coherent against a connect landing mid-refresh", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { promise, resolve } = Promise.withResolvers<Creds>();

      const reading = instance.snapshot(() => promise);
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      const identity = instance.identity();
      const generation = instance.connectionGeneration();
      resolve({ token: "refreshed", expiresAt: live.expiresAt });

      // The reconnect won the refresh; the triple must be its credentials under its identity and
      // generation, never the refresh result under the reconnect's fence.
      expect(await reading).toEqual({
        creds: { token: "reconnected", expiresAt: live.expiresAt },
        identity,
        generation,
      });
    });

    it("notifies the Workshop before rethrowing a confirmed expiry of the stored grant", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});

      await expect(instance.snapshot(async () => {
        throw new CredentialsExpiredError("invalid_grant");
      }, { notify })).rejects.toThrow("invalid_grant");
      expect(notify).toHaveBeenCalledOnce();

      // A notify that throws is logged account-side; the caller still gets the expiry verdict.
      const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(instance.snapshot(async () => {
          throw new CredentialsExpiredError("invalid_grant");
        }, { notify: async () => { throw new Error("workshop unreachable"); } }))
          .rejects.toThrow("invalid_grant");
      } finally {
        logged.mockRestore();
      }
    });

    it("serves a reconnect that lands mid-notify instead of the stale death", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { notify, entered, release } = stallingNotify();

      const reading = instance.snapshot(async () => {
        throw new CredentialsExpiredError("invalid_grant");
      }, { notify });
      await entered;
      instance.connect(live);
      release();

      expect(await reading).toEqual({
        creds: live,
        identity: instance.identity(),
        generation: instance.connectionGeneration(),
      });
    });

    it("keeps the death's provenance when a disconnect lands mid-notify", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { notify, entered, release } = stallingNotify();

      const reading = instance.snapshot(async () => {
        throw new CredentialsExpiredError("invalid_grant");
      }, { notify });
      await entered;
      instance.clear();
      release();

      // The disconnect moved the fence like a reconnect would, but nothing replaced the grant:
      // still expiry, chaining the death instead of fabricating a causeless one.
      const thrown = await reading.then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(CredentialsExpiredError);
      expect((thrown as Error).message).toBe("This account is not connected.");
      expect(((thrown as Error).cause as Error).message).toBe("invalid_grant");
    });

    it("never notifies for a disconnect", async () => {
      const notify = vi.fn(async () => {});
      // Nothing stored: reading a disconnected account is not grant death.
      await expect(coordinator(makeKv()).snapshot(async () => live, { notify }))
        .rejects.toThrow(CredentialsExpiredError);

      // A revoke mid-refresh is the user's own action; announcing expiry would misattribute it.
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const { promise, resolve } = Promise.withResolvers<Creds>();
      const reading = instance.snapshot(() => promise, { notify });
      instance.clear();
      resolve({ token: "refreshed", expiresAt: live.expiresAt });
      await expect(reading).rejects.toThrow(CredentialsExpiredError);

      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("adjudicateRejection", () => {
    const notifyless = { notify: async () => {} };

    it("answers superseded for an identity that is no longer current, before any heal", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const refresh = vi.fn(async () => live);
      const notify = vi.fn(async () => {});

      await expect(instance.adjudicateRejection("someone-elses-fence", { refresh, notify }))
        .resolves.toBe("superseded");
      expect(refresh).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('never matches "" against a never-connected account', async () => {
      // A never-connected read carries identity ""; the account's own identity() is also "". An
      // equality gate alone would heal — or expire — an account that was never connected.
      const notify = vi.fn(async () => {});
      await expect(coordinator(makeKv()).adjudicateRejection("", { notify }))
        .resolves.toBe("superseded");
      expect(notify).not.toHaveBeenCalled();
    });

    it("expires a current identity on a grant-death provider, notifying first", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const order: string[] = [];
      const notify = vi.fn(async () => { order.push("notify"); });

      const verdict = await instance.adjudicateRejection(instance.identity(), { notify });
      order.push("verdict");
      expect(verdict).toBe("expired");
      expect(order).toEqual(["notify", "verdict"]);
      expect(instance.stored()).toEqual(live);
    });

    it("heals a current rejected identity and answers superseded", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});
      const refresh = vi.fn(async () => ({ token: "minted", expiresAt: live.expiresAt }));

      await expect(instance.adjudicateRejection(instance.identity(), { refresh, notify }))
        .resolves.toBe("superseded");
      expect(instance.stored()?.token).toBe("minted");
      expect(notify).not.toHaveBeenCalled();
    });

    it("expires the grant when the heal confirms its death, keeping the verdict past a failed notify", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const refresh = async (): Promise<Creds> => {
        throw new CredentialsExpiredError("invalid_grant");
      };
      const notify = vi.fn(async () => {});

      await expect(instance.adjudicateRejection(instance.identity(), { refresh, notify }))
        .resolves.toBe("expired");
      expect(notify).toHaveBeenCalledOnce();

      // A throwing notify is the account's own trouble, never a different verdict.
      const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(instance.adjudicateRejection(instance.identity(), {
          refresh, notify: async () => { throw new Error("workshop unreachable"); },
        })).resolves.toBe("expired");
      } finally {
        logged.mockRestore();
      }
    });

    it.each([
      { death: "a grant-death verdict", refresh: undefined },
      { death: "a dead mint's verdict",
        refresh: async () => { throw new CredentialsExpiredError("invalid_grant"); } },
    ])("supersedes $death when a reconnect lands mid-notify", async ({ refresh }) => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const { notify, entered, release } = stallingNotify();

      const verdict = instance.adjudicateRejection(instance.identity(), { refresh, notify });
      await entered;
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      release();

      await expect(verdict).resolves.toBe("superseded");
    });

    it.each([
      { death: "a grant-death verdict", refresh: undefined },
      { death: "a dead mint's verdict",
        refresh: async () => { throw new CredentialsExpiredError("invalid_grant"); } },
    ])("keeps $death expired when a disconnect lands mid-notify", async ({ refresh }) => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const { notify, entered, release } = stallingNotify();

      const verdict = instance.adjudicateRejection(instance.identity(), { refresh, notify });
      await entered;
      instance.clear();
      release();

      // "Superseded" promises a successor; the disconnect left none to re-enter into.
      await expect(verdict).resolves.toBe("expired");
    });

    it("expires a rejected identity a disconnect moved past, without notifying", async () => {
      const instance = coordinator(makeKv());
      instance.connect(live);
      const rejected = instance.identity();
      const notify = vi.fn(async () => {});
      instance.clear();

      await expect(instance.adjudicateRejection(rejected, { notify })).resolves.toBe("expired");
      expect(notify).not.toHaveBeenCalled();
    });

    it("expires the rejection when a disconnect lands during a failing mint", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const notify = vi.fn(async () => {});
      const mint = Promise.withResolvers<Creds>();

      const adjudicating = instance.adjudicateRejection(rejected, {
        refresh: () => mint.promise, notify,
      });
      instance.clear();
      mint.reject(new Error("502 from token endpoint"));

      // Neither "unavailable" nor "superseded" helps a caller whose account is gone.
      await expect(adjudicating).resolves.toBe("expired");
      expect(notify).not.toHaveBeenCalled();
    });

    it("answers unavailable when the heal fails for non-credential reasons", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const notify = vi.fn(async () => {});
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(instance.adjudicateRejection(instance.identity(), {
          refresh: async () => { throw new Error("502 from token endpoint"); },
          notify,
        })).resolves.toBe("unavailable");
      } finally {
        logged.mockRestore();
      }

      // Nothing adjudicated: the grant is intact and no expiry was announced.
      expect(instance.stored()).toEqual(stale);
      expect(notify).not.toHaveBeenCalled();
    });

    it("lets a reconnect racing the heal win as superseded, even when the mint dies", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const notify = vi.fn(async () => {});
      const mint = Promise.withResolvers<Creds>();

      const adjudicating = instance.adjudicateRejection(rejected, {
        refresh: () => mint.promise, notify,
      });
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      mint.reject(new CredentialsExpiredError("invalid_grant"));

      // The dead mint belonged to the grant the reconnect replaced; expiring now would retire the
      // grant the user just connected.
      await expect(adjudicating).resolves.toBe("superseded");
      expect(notify).not.toHaveBeenCalled();
      expect(instance.stored()?.token).toBe("reconnected");
    });

    it("lets a reconnect racing the heal win when the mint fails for other reasons", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const mint = Promise.withResolvers<Creds>();

      const adjudicating = instance.adjudicateRejection(rejected, {
        refresh: () => mint.promise, ...notifyless,
      });
      instance.connect({ token: "reconnected", expiresAt: live.expiresAt });
      mint.reject(new Error("502 from token endpoint"));

      // The rejected identity is demonstrably superseded; unavailable would hand the caller its
      // original 401 right after the user reconnected.
      await expect(adjudicating).resolves.toBe("superseded");
      expect(instance.stored()?.token).toBe("reconnected");
    });

    it("collapses concurrent heals of one identity onto one mint", async () => {
      const instance = coordinator(makeKv());
      instance.connect(stale);
      const rejected = instance.identity();
      const mint = Promise.withResolvers<Creds>();
      const refresh = vi.fn(() => mint.promise);

      const verdicts = Promise.all([
        instance.adjudicateRejection(rejected, { refresh, ...notifyless }),
        instance.adjudicateRejection(rejected, { refresh, ...notifyless }),
      ]);
      mint.resolve({ token: "minted", expiresAt: live.expiresAt });

      expect(await verdicts).toEqual(["superseded", "superseded"]);
      expect(refresh).toHaveBeenCalledOnce();
    });
  });
});

describe("credential errors", () => {
  /** Mirrors capnweb's error round trip: rebuilt as a plain `Error`, own enumerable props kept. */
  function overCapnweb(error: Error): Error {
    const kept = Object.entries(error)
      .filter(([key]) => key !== "name" && key !== "message" && key !== "stack");
    return Object.assign(new Error(error.message), Object.fromEntries(kept));
  }

  it("pins the fixed retryable message", () => {
    // The one place the message is asserted: it is display-safe wording, not the contract — the
    // contract is the name/code, matched below.
    expect(new CredentialsChangedError().message)
      .toBe("This account's credentials changed during the operation; retry it.");
  });

  it("matches a mid-operation replacement by name or transport-surviving code", () => {
    expect(isCredentialsChanged(new CredentialsChangedError({ cause: new Error("401") })))
      .toBe(true);
    expect(isCredentialsChanged(
      Object.assign(new Error("stripped by transport"), { name: "CredentialsChangedError" })))
      .toBe(true);
    const wire = overCapnweb(new CredentialsChangedError());
    expect(wire.name).toBe("Error");
    expect(isCredentialsChanged(wire)).toBe(true);
    expect(isCredentialsChanged(new Error("some other failure"))).toBe(false);
    expect(isCredentialsChanged(new CredentialsExpiredError("expired"))).toBe(false);
    expect(isCredentialsChanged("not an error")).toBe(false);
  });

  it("matches confirmed expiry by name or transport-surviving code", () => {
    expect(isCredentialsExpired(new CredentialsExpiredError("expired"))).toBe(true);
    expect(isCredentialsExpired(
      Object.assign(new Error("stripped by transport"), { name: "CredentialsExpiredError" })))
      .toBe(true);
    const wire = overCapnweb(new CredentialsExpiredError("expired"));
    expect(wire.name).toBe("Error");
    expect(isCredentialsExpired(wire)).toBe(true);
    expect(isCredentialsExpired(new Error("some other failure"))).toBe(false);
    expect(isCredentialsExpired(new CredentialsChangedError())).toBe(false);
    expect(isCredentialsExpired(undefined)).toBe(false);
  });
});

describe("CredentialSource", () => {
  // The one literal in the suite: run() must surface exactly the configured message on expiry, and
  // every other assertion matches the error class instead.
  const expiredMessage = "Reconnect the account.";

  const fresh: Creds = { token: "fresh", expiresAt: Date.now() + 60 * 60 * 1000 };

  type SourceOverrides = Partial<Omit<CredentialSourceOptions<Creds>, "account">> & {
    getCredentials?: () => Promise<CredentialsWithIdentity<Creds>>;
    reportCredentialsRejected?: (identity: string) => Promise<RejectionVerdict>;
  };

  /** A source over a stub account; unset halves serve one live read and answer expired. */
  function source(overrides: SourceOverrides = {}) {
    const { getCredentials: read, reportCredentialsRejected: report, ...options } = overrides;
    const getCredentials = vi.fn<() => Promise<CredentialsWithIdentity<Creds>>>(
      read ?? (async () => ({ creds: live, identity: "id-a", generation: "gen-a" })));
    const reportCredentialsRejected = vi.fn<(identity: string) => Promise<RejectionVerdict>>(
      report ?? (async () => "expired"));
    const instance = new CredentialSource<Creds>({
      account: () => ({ getCredentials, reportCredentialsRejected }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage,
      ...options,
    });
    return { instance, getCredentials, reportCredentialsRejected };
  }

  /** A source whose account parks every read for the test to release in order. */
  function queuedSource(overrides: SourceOverrides = {}) {
    const reads: PromiseWithResolvers<CredentialsWithIdentity<Creds>>[] = [];
    const parked = source({
      getCredentials: () => {
        const read = Promise.withResolvers<CredentialsWithIdentity<Creds>>();
        reads.push(read);
        return read.promise;
      },
      ...overrides,
    });
    return { reads, ...parked };
  }

  /**
   * A source over one mutable account triple: reads serve a copy of `current`, the report answers
   * with the given verdict, and `set` — the callback's or the returned one — replaces the triple
   * the way a refresh commit or a reconnect does.
   */
  function mutableSource(
    report: (
      identity: string,
      current: CredentialsWithIdentity<Creds>,
      set: (next: CredentialsWithIdentity<Creds>) => void,
    ) => RejectionVerdict,
  ) {
    let current: CredentialsWithIdentity<Creds> =
      { creds: live, identity: "id-a", generation: "gen-a" };
    const set = (next: CredentialsWithIdentity<Creds>) => { current = next; };
    return {
      ...source({
        getCredentials: async () => ({ ...current }),
        reportCredentialsRejected: async identity => report(identity, current, set),
      }),
      set,
    };
  }

  /**
   * An account whose adjudication heals: while the rejected identity is current, the report mints
   * a successor in place and answers superseded, the way `adjudicateRejection` does for a derived
   * bearer.
   */
  function healingSource() {
    return mutableSource((identity, current, set) => {
      if (identity === current.identity) {
        set({ creds: fresh, identity: "id-b", generation: current.generation });
      }
      return "superseded";
    });
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

  it("hands the operation the identity and generation of its own read", async () => {
    const { instance } = source();

    const read = await instance.run(async (_creds, attempt) => attempt);
    expect(read).toEqual({ identity: "id-a", generation: "gen-a" });
  });

  it("hands each attempt a fresh read of its own credentials", async () => {
    const { instance } = healingSource();
    const handed: CredentialRead[] = [];
    const seen: CredentialRead[] = [];

    const result = await instance.run(async (creds, attempt) => {
      handed.push(attempt);
      seen.push({ ...attempt });
      // A caller may hold or even mutate its read; the source's own state must not ride on it —
      // a mangled shared triple would report and fence the wrong identity below.
      attempt.identity = "mangled";
      attempt.generation = "mangled";
      if (creds.token === "live") throw new Error("401");
      return creds.token;
    }, { replayable: true });

    // The retry's read names the credentials that attempt actually ran under — the fence an
    // action capture must ride, since authority() can move mid-operation.
    expect(result).toBe("fresh");
    expect(seen).toEqual([
      { identity: "id-a", generation: "gen-a" },
      { identity: "id-b", generation: "gen-a" },
    ]);
    expect(handed[0]).not.toBe(handed[1]);
  });

  it("surfaces the authority only while the principal is known", async () => {
    let identity = "id-a";
    let generation = "gen-a";
    const { instance } =
      source({ getCredentials: async () => ({ creds: live, identity, generation }) });
    // Nothing fetched yet: a cache keyed on this must bypass, not hit a props-keyed partition.
    expect(instance.authority()).toBeUndefined();

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // A reported expiry means a reconnect will rotate the generation; forget the old one.
    await expect(instance.run(async () => { throw new Error("401"); }))
      .rejects.toThrow(CredentialsExpiredError);
    expect(instance.authority()).toBeUndefined();

    // The account keeps the dead grant until reconnect: refetching the same identity must not
    // restore its partition, or hit-only cache paths would mask the outage for the TTL.
    await instance.get();
    expect(instance.authority()).toBeUndefined();

    // A fetch adopting a different identity — refresh or reconnect — re-establishes it.
    identity = "id-b";
    generation = "gen-b";
    await instance.get();
    expect(instance.authority()).toBe("gen-b");
  });

  it("reports the rejection against the identity the failed call used", async () => {
    const { instance, getCredentials, reportCredentialsRejected } = source();

    const failure = instance.run(async () => { throw new Error("401"); });
    await expect(failure).rejects.toThrow(CredentialsExpiredError);
    // The one message pin: expiry surfaces exactly the configured display-safe wording.
    await expect(failure).rejects.toThrow(expiredMessage);
    expect(reportCredentialsRejected).toHaveBeenCalledWith("id-a");

    await instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("retries a replayable operation once after the account heals past the rejection", async () => {
    const { instance, getCredentials, reportCredentialsRejected } = healingSource();

    const result = await instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      return creds.token;
    }, { replayable: true });

    expect(result).toBe("fresh");
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
    expect(reportCredentialsRejected).toHaveBeenCalledWith("id-a");
    // The retry reads fresh — the verdict's fence bump forgot the pre-ask flight — and the
    // single-threaded account answers it after the heal's commit.
    expect(getCredentials).toHaveBeenCalledTimes(2);
    // A healed rejection is a stale bearer, not expiry; the connection survives, and the retry's
    // own read re-establishes the authority.
    expect(instance.authority()).toBe("gen-a");
  });

  it("reports the identity the retry actually used when its credentials are rejected too", async () => {
    const { instance, reportCredentialsRejected } = mutableSource((identity, _current, set) => {
      if (identity !== "id-a") return "expired";
      set({ creds: fresh, identity: "id-b", generation: "gen-a" });
      return "superseded";
    });
    const operation = vi.fn(async () => { throw new Error("401"); });

    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow(CredentialsExpiredError);

    // The second ask names what the retry ran under: naming the first grant instead would be
    // gated out as moved-past, leaving the dead successor reading as retryable forever.
    expect(operation).toHaveBeenCalledTimes(2);
    expect(reportCredentialsRejected).toHaveBeenNthCalledWith(1, "id-a");
    expect(reportCredentialsRejected).toHaveBeenNthCalledWith(2, "id-b");
    expect(instance.authority()).toBeUndefined();
  });

  it("resolves a superseded verdict on a non-replayable operation into a retryable error", async () => {
    // Another consumer over the same account healed past id-a; this snapshot cannot see that, so
    // the account's answer is what keeps the caller off a false reconnect prompt — and without
    // `replayable`, off a second execution the operation cannot afford.
    const operation = vi.fn(async () => { throw new Error("401"); });
    const { instance, reportCredentialsRejected } =
      source({ reportCredentialsRejected: async () => "superseded" });

    await expect(instance.run(operation)).rejects.toThrow(CredentialsChangedError);
    expect(operation).toHaveBeenCalledOnce();
    expect(reportCredentialsRejected).toHaveBeenCalledWith("id-a");
    // The verdict proves this snapshot stale: its authority cannot vouch for the current
    // principal, so caches bypass until the next read re-establishes it.
    expect(instance.authority()).toBeUndefined();
  });

  it("surfaces the original rejection when the account cannot adjudicate", async () => {
    const rejection = new Error("401");
    const operation = vi.fn(async () => { throw rejection; });
    const { instance } = source({
      reportCredentialsRejected: async () => "unavailable",
      isAuthError: error => error === rejection,
    });

    // Nothing was adjudicated — replayable or not, the caller gets the provider error it actually
    // saw, and the heal's own failure lives in the account's logs.
    await expect(instance.run(operation, { replayable: true })).rejects.toBe(rejection);
    await expect(instance.run(operation)).rejects.toBe(rejection);
    expect(operation).toHaveBeenCalledTimes(2);

    // No verdict landed: the identity was never marked dead, so the next fetch re-adopts it —
    // only the round-trip window bypassed the cache.
    await instance.get();
    expect(instance.authority()).toBe("gen-a");
  });

  it("fails closed on a malformed verdict", async () => {
    // The RPC boundary can hand back anything; an unrecognized answer must not read as retryable.
    const { instance } = source({
      reportCredentialsRejected: async () => "definitely" as unknown as RejectionVerdict,
    });

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
        .rejects.toThrow(CredentialsExpiredError);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
    expect(instance.authority()).toBeUndefined();
  });

  it("fails closed when the report cannot reach the account", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { instance } = source({
        reportCredentialsRejected: async () => { throw new Error("account unreachable"); },
      });

      // An outage must not mask a dead grant as retryable; the caller sees expiry.
      await expect(instance.run(async () => { throw new Error("401"); }))
        .rejects.toThrow(CredentialsExpiredError);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("refuses the retry when the refetch crosses a reconnect", async () => {
    const operation = vi.fn(async () => { throw new Error("401"); });
    const { instance, reportCredentialsRejected } = mutableSource((_identity, _current, set) => {
      // A reconnect lands while the report is in flight; the account's gate answers superseded.
      set({ creds: fresh, identity: "id-b", generation: "gen-b" });
      return "superseded";
    });

    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow(CredentialsChangedError);

    // The replacement belongs to a connection the caller never fetched: running under it could
    // act as a different principal, so the caller re-enters and fetches it deliberately. The
    // refetch itself adopted the live reconnect, so its authority stands.
    expect(operation).toHaveBeenCalledOnce();
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
    expect(instance.authority()).toBe("gen-b");
  });

  it("refuses the retry when the refetch re-serves the rejected identity", async () => {
    // A hand-written account whose "heal" lazily re-serves the very credentials the provider
    // rejected: superseded promised a successor, so the same identity back means re-entering,
    // never burning the one retry on a corpse and then falsely retiring the grant.
    const operation = vi.fn(async () => { throw new Error("401"); });
    const { instance, reportCredentialsRejected } =
      source({ reportCredentialsRejected: async () => "superseded" });

    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow(CredentialsChangedError);
    expect(operation).toHaveBeenCalledOnce();
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
    // The refetch adopted the very identity the provider rejected, so its vouch is dropped:
    // a cache-first re-entry bypasses instead of serving the partition it failed to defend.
    expect(instance.authority()).toBeUndefined();
  });

  it("refuses a retry whose fenced-out refetch an adopted reconnect postdates", async () => {
    // Two runs read one grant and both 401. The first's post-verdict refetch dangles; the second's
    // verdict fences it out, and the second's own refetch adopts a reconnect. The dangling
    // response — same generation as the rejected read — must never be executed under.
    const { instance, reads } =
      queuedSource({ reportCredentialsRejected: async () => "superseded" });

    const gate = Promise.withResolvers<void>();
    const first = vi.fn(async () => { throw new Error("401"); });
    const second = vi.fn(async () => { await gate.promise; throw new Error("401"); });
    const runFirst = instance.run(first, { replayable: true });
    const runSecond = instance.run(second, { replayable: true });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });

    // The first run's verdict lands and its refetch dangles before the second run even fails.
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    gate.resolve();
    await vi.waitFor(() => expect(reads).toHaveLength(3));

    // The second run's refetch adopts a reconnect; the dangling one answers under the old
    // generation. Both re-enter — neither runs under a read the source no longer stands behind.
    reads[2].resolve({ creds: fresh, identity: "id-c", generation: "gen-c" });
    await expect(runSecond).rejects.toThrow(CredentialsChangedError);
    reads[1].resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await expect(runFirst).rejects.toThrow(CredentialsChangedError);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(instance.authority()).toBe("gen-c");
  });

  it("keeps a reconnect's authority when a fenced-out refetch re-serves the rejected identity", async () => {
    // Same shape as above, but the dangling response re-serves the rejected identity itself. The
    // re-serve branch undoes a refetch's adoption — this refetch adopted nothing, so acting on it
    // would destroy the reconnect's live authority instead.
    const { instance, reads } =
      queuedSource({ reportCredentialsRejected: async () => "superseded" });

    const gate = Promise.withResolvers<void>();
    const runFirst = instance.run(async () => { throw new Error("401"); }, { replayable: true });
    const runSecond = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    }, { replayable: true });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });

    await vi.waitFor(() => expect(reads).toHaveLength(2));
    gate.resolve();
    await vi.waitFor(() => expect(reads).toHaveLength(3));

    reads[2].resolve({ creds: fresh, identity: "id-c", generation: "gen-c" });
    await expect(runSecond).rejects.toThrow(CredentialsChangedError);
    reads[1].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    await expect(runFirst).rejects.toThrow(CredentialsChangedError);

    expect(instance.authority()).toBe("gen-c");
  });

  it("never runs the retry under a successor already adjudicated dead", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance } = mutableSource((identity, _current, set) => {
      if (identity === "id-b") return "expired";
      set({ creds: fresh, identity: "id-b", generation: "gen-a" });
      return "superseded";
    });

    // Two calls share one read; the slow one's rejection lands after the healed successor was
    // itself rejected and adjudicated dead.
    const slowOp = vi.fn(async () => {
      await gate.promise;
      throw new Error("401");
    });
    const fast = instance.run(async () => { throw new Error("401"); }, { replayable: true });
    const slow = instance.run(slowOp, { replayable: true });
    await expect(fast).rejects.toThrow(CredentialsExpiredError);

    gate.resolve();
    await expect(slow).rejects.toThrow(CredentialsExpiredError);
    // The slow retry's refetch returned the dead grant the account still serves: no provider call
    // runs under credentials the source confirmed dead.
    expect(slowOp).toHaveBeenCalledOnce();
  });

  it("re-enters instead of expiring when a dead successor's fenced-out refetch postdates a reconnect", async () => {
    const { instance, reads } = queuedSource({
      reportCredentialsRejected: async identity =>
        identity === "id-b" ? "expired" : "superseded",
    });

    const gate = Promise.withResolvers<void>();
    const first = vi.fn(async () => { throw new Error("401"); });
    const runFirst = instance.run(first, { replayable: true });
    const runSecond = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    }, { replayable: true });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });

    // The first run's refetch dangles; the second's verdict fences it out, and the second's own
    // refetch adopts the healed successor — whose repeat rejection is then adjudicated dead.
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    gate.resolve();
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    reads[2].resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });
    await expect(runSecond).rejects.toThrow(CredentialsExpiredError);

    // A reconnect is adopted before the dangling refetch answers with the dead successor.
    const revived = instance.get();
    await vi.waitFor(() => expect(reads).toHaveLength(4));
    reads[3].resolve({ creds: fresh, identity: "id-c", generation: "gen-c" });
    await revived;
    reads[1].resolve({ creds: fresh, identity: "id-b", generation: "gen-a" });

    // Stale evidence about a read the source no longer stands behind: re-enter, don't tell the
    // caller a freshly reconnected account is expired.
    await expect(runFirst).rejects.toThrow(CredentialsChangedError);
    expect(first).toHaveBeenCalledOnce();
    expect(instance.authority()).toBe("gen-c");
  });

  it("makes at most two attempts however many verdicts answer superseded", async () => {
    let minted = 0;
    const operation = vi.fn(async () => { throw new Error("401"); });
    const { instance, reportCredentialsRejected } = mutableSource((_identity, _current, set) => {
      minted += 1;
      set({ creds: fresh, identity: `id-${minted}`, generation: "gen-a" });
      return "superseded";
    });

    await expect(instance.run(operation, { replayable: true }))
      .rejects.toThrow(CredentialsChangedError);

    // The account would heal forever; the source stops at two executions and hands the caller
    // the retryable error instead of looping.
    expect(operation).toHaveBeenCalledTimes(2);
    expect(reportCredentialsRejected).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of rejections onto one ask and one refetch", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, getCredentials, reportCredentialsRejected } = healingSource();
    const operation = async (creds: Creds) => {
      if (creds.token === "live") {
        await gate.promise;
        throw new Error("401");
      }
      return creds.token;
    };

    // Two provider calls 401 together, the way one dead bearer fails parallel calls in a request.
    const calls = [
      instance.run(operation, { replayable: true }),
      instance.run(operation, { replayable: true }),
    ];
    gate.resolve();

    expect(await Promise.all(calls)).toEqual(["fresh", "fresh"]);
    // One shared read, one shared ask — the account's fence-keyed heal collapses behind it — and
    // one shared refetch serving both retries.
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
    expect(getCredentials).toHaveBeenCalledTimes(2);
  });

  it("replays under a successor a sibling's heal already adopted, spending no ask", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, reportCredentialsRejected } = healingSource();
    const operation = async (creds: Creds) => {
      if (creds.token !== "live") return creds.token;
      await gate.promise;
      throw new Error("401");
    };

    const slow = instance.run(operation, { replayable: true });
    // A sibling call heals and adopts the successor before the slow call's 401 lands.
    expect(await instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      return creds.token;
    }, { replayable: true })).toBe("fresh");

    // The stale failure resolves by replay, not by a re-entry the heal was meant to hide — and
    // the adopted successor already answers the ask the moved-past gate would.
    gate.resolve();
    expect(await slow).toBe("fresh");
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
  });

  it("re-enters instead of replaying when the adopted successor reaches a non-replayable call", async () => {
    const gate = Promise.withResolvers<void>();
    const { instance, reportCredentialsRejected } = healingSource();
    const operation = vi.fn(async (creds: Creds) => {
      if (creds.token !== "live") return creds.token;
      await gate.promise;
      throw new Error("401");
    });

    const slow = instance.run(operation);
    // A sibling call heals and adopts the successor before the slow call's 401 lands.
    expect(await instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      return creds.token;
    }, { replayable: true })).toBe("fresh");

    // The successor answers what an ask would, but a second execution is not this caller's to
    // spend: the operation runs once and the caller re-enters.
    gate.resolve();
    await expect(slow).rejects.toThrow(CredentialsChangedError);
    expect(operation).toHaveBeenCalledOnce();
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
  });

  it("adjudicates a repeat report afresh instead of caching the verdict", async () => {
    const { instance, reportCredentialsRejected, set } = mutableSource((identity, current) =>
      identity === current.identity ? "expired" : "superseded");

    await expect(instance.run(async () => { throw new Error("401"); }, { replayable: true }))
      .rejects.toThrow(CredentialsExpiredError);

    // A straggler reads the dead grant the account still serves, then the user reconnects.
    const stalled = await stalledRun(instance, { replayable: true });
    set({ creds: fresh, identity: "id-b", generation: "gen-b" });
    stalled.release();

    // The account re-adjudicates and answers moved-past; a cached verdict would expire the
    // reconnect the caller only needs to re-enter into.
    await expect(stalled.run).rejects.toThrow(CredentialsChangedError);
    expect(reportCredentialsRejected).toHaveBeenCalledTimes(2);
    expect(await instance.run(async creds => creds.token)).toBe("fresh");
  });

  it("skips the ask when a reconnect was adopted before the rejection resolved", async () => {
    const reads = [
      { creds: live, identity: "id-a", generation: "gen-a" },
      { creds: fresh, identity: "id-b", generation: "gen-b" },
    ];
    const { instance, reportCredentialsRejected } =
      source({ getCredentials: async () => reads.shift()! });

    const stalled = await stalledRun(instance, { replayable: true });

    // A plain read adopts a reconnect while the operation is still in flight.
    expect(await instance.get()).toEqual(fresh);
    expect(instance.authority()).toBe("gen-b");

    // The outcome is already decided: no ask is spent on the superseded read, and a heal or its
    // failure cannot reach a caller who only needs to re-enter.
    stalled.release();
    await expect(stalled.run).rejects.toThrow(CredentialsChangedError);
    expect(reportCredentialsRejected).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-b");
  });

  it("skips the second ask when a reconnect is adopted during the retry", async () => {
    const replaying = Promise.withResolvers<void>();
    const replayGate = Promise.withResolvers<void>();
    const { instance, reportCredentialsRejected, set } =
      mutableSource((_identity, _current, mint) => {
        mint({ creds: fresh, identity: "id-b", generation: "gen-a" });
        return "superseded";
      });

    const call = instance.run(async creds => {
      if (creds.token === "live") throw new Error("401");
      replaying.resolve();
      await replayGate.promise;
      throw new Error("401");
    }, { replayable: true });
    await replaying.promise;

    // A reconnect lands and a plain read adopts it while the retry is out.
    set({ creds: live, identity: "id-c", generation: "gen-c" });
    expect(await instance.get()).toEqual(live);
    expect(instance.authority()).toBe("gen-c");

    // The retry ran under credentials the reconnect superseded: the only verdict the account
    // could return is already known, so the caller re-enters without a second ask and the live
    // authority stands.
    replayGate.resolve();
    await expect(call).rejects.toThrow(CredentialsChangedError);
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
    expect(instance.authority()).toBe("gen-c");
  });

  it("passes a retry failure that is not a credential rejection through untouched", async () => {
    const { instance, reportCredentialsRejected } = healingSource();

    await expect(instance.run(async creds => {
      throw new Error(creds.token === "live" ? "401" : "500");
    }, { replayable: true })).rejects.toThrow("500");
    expect(reportCredentialsRejected).toHaveBeenCalledOnce();
  });

  it.each([
    { verdict: "expired", error: CredentialsExpiredError, readopted: undefined },
    { verdict: "superseded", error: CredentialsChangedError, readopted: "gen-a" },
  ] as const)("never re-adopts the rejected identity while its verdict is pending ($verdict)",
    async ({ verdict, error, readopted }) => {
      const answer = Promise.withResolvers<RejectionVerdict>();
      const { instance, reportCredentialsRejected } =
        source({ reportCredentialsRejected: () => answer.promise });

      const report = instance.run(async () => { throw new Error("401"); });
      await vi.waitFor(() => expect(reportCredentialsRejected).toHaveBeenCalled());

      // A read landing mid-adjudication is served but never adopted: the rejected partition must
      // not come back to cache-first readers while the verdict is out.
      expect(await instance.get()).toEqual(live);
      expect(instance.authority()).toBeUndefined();

      answer.resolve(verdict);
      await expect(report).rejects.toThrow(error);

      // The bypass is the round trip, not the identity: once superseded settles, a fresh read
      // adopts again, while a confirmed-dead identity stays refused.
      await instance.get();
      expect(instance.authority()).toBe(readopted);
    });

  it("stops vouching for a rejected authority while the verdict is pending", async () => {
    const answer = Promise.withResolvers<RejectionVerdict>();
    const { instance, reportCredentialsRejected } =
      source({ reportCredentialsRejected: () => answer.promise });

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // The rejection alone drops the authority: cache-first readers bypass during the round trip
    // rather than serving the partition the provider just rejected.
    const report = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reportCredentialsRejected).toHaveBeenCalled());
    expect(instance.authority()).toBeUndefined();

    answer.resolve("expired");
    await expect(report).rejects.toThrow(CredentialsExpiredError);
  });

  it("reports a rejection served by a fenced read once the authority is unknown", async () => {
    const answer = Promise.withResolvers<RejectionVerdict>();
    const { instance, reads, reportCredentialsRejected } = queuedSource({
      reportCredentialsRejected: async identity =>
        identity === "id-a" ? answer.promise : "expired",
    });

    const first = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    await vi.waitFor(() => expect(reportCredentialsRejected).toHaveBeenCalledWith("id-a"));

    // A second run's read starts before the verdict lands, so its result arrives fenced: served
    // to the caller, never adopted.
    const second = instance.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    answer.resolve("superseded");
    await expect(first).rejects.toThrow(CredentialsChangedError);
    reads[1].resolve({ creds: fresh, identity: "id-b", generation: "gen-b" });

    // The retained id-a identity is no successor once its authority dropped — the failure under
    // the account's actual current credential must reach the account, not resolve as stale.
    await expect(second).rejects.toThrow(CredentialsExpiredError);
    expect(reportCredentialsRejected).toHaveBeenLastCalledWith("id-b");
  });

  it("treats an auth failure under superseded credentials as stale, not expiry", async () => {
    let identity = "id-a";
    let generation = "gen-a";
    const { instance, reportCredentialsRejected } =
      source({ getCredentials: async () => ({ creds: live, identity, generation }) });

    await expect(instance.run(async () => {
      // A reconnect lands and another caller refetches while this call is in flight.
      identity = "id-b";
      generation = "gen-b";
      await instance.get();
      throw new Error("401");
    })).rejects.toThrow(CredentialsChangedError);

    // Reporting would expire the grant the user just reconnected, and clearing the authority
    // would drop its live partition; both belong to the grant that actually died.
    expect(reportCredentialsRejected).not.toHaveBeenCalled();
    expect(instance.authority()).toBe("gen-b");
  });

  it("passes other failures through untouched", async () => {
    const { instance, reportCredentialsRejected } = source();

    await expect(instance.run(async () => { throw new Error("500"); })).rejects.toThrow("500");
    expect(reportCredentialsRejected).not.toHaveBeenCalled();
  });

  it("never lets a fenced read opened after a report restore authority", async () => {
    const { instance, reads } = queuedSource();

    const gate = Promise.withResolvers<void>();
    const fast = instance.run(async () => { throw new Error("401"); });
    const slow = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    await expect(fast).rejects.toThrow(CredentialsExpiredError);
    expect(instance.authority()).toBeUndefined();

    // A read opens while the authority is unknown, and a second report fences it in flight.
    const pending = instance.get();
    gate.resolve();
    await expect(slow).rejects.toThrow(CredentialsExpiredError);

    // Resolving now must not restore authority: this is a fenced response, not a fetch started
    // after the report — however its generation compares to the unknown one it opened under.
    reads[1].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await pending).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });

  it("never hands a caller the fetch in flight when credentials were reported dead", async () => {
    const { instance, reads, getCredentials } = queuedSource();

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
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });

    // The first 401 empties the cache, so the next caller opens a second fetch...
    second.resolve();
    await expect(secondCall).rejects.toThrow(CredentialsExpiredError);
    const riding = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);

    // ...which is still in flight when the second 401 declares those credentials dead.
    first.resolve();
    await expect(firstCall).rejects.toThrow(CredentialsExpiredError);

    // Riding it would hand a caller credentials that have already been reported expired.
    const after = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(3);

    const fromSecond = { token: "second-fetch", expiresAt: live.expiresAt };
    const fromThird = { token: "third-fetch", expiresAt: live.expiresAt };
    reads[1].resolve({ creds: fromSecond, identity: "id-b", generation: "gen-a" });
    reads[2].resolve({ creds: fromThird, identity: "id-c", generation: "gen-a" });
    expect(await riding).toEqual(fromSecond);
    expect(await after).toEqual(fromThird);
  });

  it("never resurrects a generation cleared while another fetch was in flight", async () => {
    const { instance, reads, getCredentials } = queuedSource();

    const gate = Promise.withResolvers<void>();
    const call = instance.run(async () => {
      await gate.promise;
      throw new Error("401");
    });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);

    // Another caller's fetch opens while the provider call is out, and is still in flight when the
    // 401 clears the generation.
    const pending = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(call).rejects.toThrow(CredentialsExpiredError);
    expect(instance.authority()).toBeUndefined();

    // That fetch resolving carries the dead grant's generation; adopting it would put the cache
    // back on the dead partition.
    reads[1].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await pending).toEqual(live);
    expect(instance.authority()).toBeUndefined();

    // A fetch opened after the clear re-establishes the principal.
    const after = instance.get();
    reads[2].resolve({ creds: live, identity: "id-b", generation: "gen-b" });
    expect(await after).toEqual(live);
    expect(instance.authority()).toBe("gen-b");
  });

  it("drops the authority only when a fetch fails with confirmed expiry", async () => {
    let failure: Error | undefined;
    const { instance } = source({
      getCredentials: async () => {
        if (failure) throw failure;
        return { creds: live, identity: "id-a", generation: "gen-a" };
      },
    });

    await instance.get();
    expect(instance.authority()).toBe("gen-a");

    // An account hiccup is not an expiry: the partition survives and warm reads keep hitting.
    failure = new Error("account unreachable");
    await expect(instance.get()).rejects.toThrow("account unreachable");
    expect(instance.authority()).toBe("gen-a");

    // A failed refresh is a confirmed expiry. RPC strips the class, so the name is the contract.
    failure = Object.assign(new Error("grant expired upstream"),
      { name: "CredentialsExpiredError" });
    await expect(instance.get()).rejects.toThrow("grant expired upstream");
    expect(instance.authority()).toBeUndefined();
  });

  it("ignores a straggler fetch that rejects with expiry after the partition revived", async () => {
    const { instance, reads } = queuedSource();

    // Grant A is adopted, another fetch opens, then A's expiry forgets that fetch mid-flight.
    const gate = Promise.withResolvers<void>();
    const call = instance.run(async () => { await gate.promise; throw new Error("401"); });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const straggler = instance.get();
    gate.resolve();
    await expect(call).rejects.toThrow(CredentialsExpiredError);

    // A successful refresh commits a new identity on the same connection: the partition revives.
    const revived = instance.get();
    reads[2].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await revived).toEqual(live);
    expect(instance.authority()).toBe("gen-a");

    // The forgotten fetch's stale coalesced refresh finally fails; it must not clear the revival.
    reads[1].reject(
      Object.assign(new Error("grant expired upstream"), { name: "CredentialsExpiredError" }));
    await expect(straggler).rejects.toThrow("grant expired upstream");
    expect(instance.authority()).toBe("gen-a");
  });

  it("never adopts a straggler fetch that outlived later expiry reports", async () => {
    const { instance, reads, getCredentials } = queuedSource();

    // Grant A is adopted, another fetch opens, then A's expiry forgets that fetch mid-flight.
    const gate = Promise.withResolvers<void>();
    const callA = instance.run(async () => { await gate.promise; throw new Error("401"); });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const straggler = instance.get();
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(callA).rejects.toThrow(CredentialsExpiredError);

    // Grant B is adopted and dies too, rotating the dead marker away from A.
    const callB = instance.run(async () => { throw new Error("401"); });
    reads[2].resolve({ creds: live, identity: "id-b", generation: "gen-b" });
    await expect(callB).rejects.toThrow(CredentialsExpiredError);
    expect(instance.authority()).toBeUndefined();

    // The straggler resolves with A, which no longer matches the marker. Adopting it would
    // resurrect a dead partition and misroute genuine B failures as superseded.
    reads[1].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await straggler).toEqual(live);
    expect(instance.authority()).toBeUndefined();

    // A failure under the still-current dead grant routes to expiry, not "retry".
    const callC = instance.run(async () => { throw new Error("401"); });
    reads[3].resolve({ creds: live, identity: "id-b", generation: "gen-b" });
    await expect(callC).rejects.toThrow(CredentialsExpiredError);
    expect(instance.authority()).toBeUndefined();
  });

  it("reports a failure under fenced-out credentials as expiry when nothing live succeeded them", async () => {
    const { instance, reads, getCredentials, reportCredentialsRejected } = queuedSource();

    // Grant A is adopted, a concurrent operation's fetch opens, then A's expiry fences it out.
    const gate = Promise.withResolvers<void>();
    const callA = instance.run(async () => { await gate.promise; throw new Error("401"); });
    reads[0].resolve({ creds: live, identity: "id-a", generation: "gen-a" });
    expect(await instance.get()).toEqual(live);
    const callB = instance.run(async () => { throw new Error("401"); });
    expect(getCredentials).toHaveBeenCalledTimes(2);
    gate.resolve();
    await expect(callA).rejects.toThrow(CredentialsExpiredError);

    // The fenced-out fetch delivers B, which fails too. Nothing live was adopted since A's
    // report, so "the credentials changed" would be a lie — B's death is fresh evidence.
    reads[1].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    await expect(callB).rejects.toThrow(CredentialsExpiredError);
    expect(reportCredentialsRejected).toHaveBeenCalledWith("id-b");
    expect(instance.authority()).toBeUndefined();

    // The account keeps serving the unrefreshed grant; readopting it would let cache hits mask
    // the expiry it just confirmed.
    const refetch = instance.get();
    reads[2].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await refetch).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });

  it("keeps a dead grant refused however many stale failures report after it", async () => {
    const { instance, reads } = queuedSource();

    // Nine operations park holding distinct stale identities, read one at a time so nothing
    // coalesces.
    const stale: Array<{ run: Promise<unknown>; release: () => void }> = [];
    for (let index = 0; index < 9; index += 1) {
      const stalling = stalledRun(instance);
      reads[index].resolve({ creds: live, identity: `id-stale-${index}`, generation: "gen-a" });
      stale.push(await stalling);
    }

    // Grant B — a same-generation rotation, so no adopted successor proves the stale reads
    // superseded — is adopted and dies, then every stale operation reports its own identity dead.
    const callB = instance.run(async () => { throw new Error("401"); });
    reads[9].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    await expect(callB).rejects.toThrow(CredentialsExpiredError);
    for (const { release } of stale) release();
    for (const { run } of stale) await expect(run).rejects.toThrow(CredentialsExpiredError);

    // The stale reports land after B's in mark order; none may push B back into adoption.
    const refetch = instance.get();
    reads[10].resolve({ creds: live, identity: "id-b", generation: "gen-a" });
    expect(await refetch).toEqual(live);
    expect(instance.authority()).toBeUndefined();
  });
});

describe("CredentialSource over a CredentialCoordinator", () => {
  // The two halves composed the way a port wires them: `getCredentials` projects
  // `coordinator.snapshot(...)`, the rejection report delegates to `adjudicateRejection`, and in
  // production `notify` is `notifyCredentialsExpiredOnce` over the same storage.
  function harness(options: { mint?: (current: Creds) => Promise<Creds> } = {}) {
    const kv = fakeKv();
    const instance = new CredentialCoordinator<Creds>(kv);
    const notify = vi.fn(async () => {});
    const mint = vi.fn(options.mint
      ?? (async () => ({ token: "minted", expiresAt: Date.now() + 3_600_000 })));
    const account = {
      getCredentials: () => instance.snapshot(async current => current, { notify }),
      reportCredentialsRejected:
        (identity: string) => instance.adjudicateRejection(identity, { refresh: mint, notify }),
    };
    const newSource = () => new CredentialSource<Creds>({
      account: () => account,
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect.",
    });
    return { coordinator: instance, source: newSource(), newSource, notify, mint };
  }

  /** A provider accepting exactly the given tokens, rejecting everything else as a 401. */
  function providerAccepting(...tokens: string[]) {
    return vi.fn(async (creds: Creds) => {
      if (!tokens.includes(creds.token)) throw new Error("401");
      return creds.token;
    });
  }

  const hour = 3_600_000;

  it("heals a stale bearer invisibly with one mint and no notification", async () => {
    const { coordinator, source, notify, mint } = harness();
    coordinator.connect({ token: "stale-bearer", expiresAt: Date.now() + hour });
    const operation = providerAccepting("minted");

    expect(await source.run(operation, { replayable: true })).toBe("minted");

    // The whole recovery happened inside the report round trip: one provider mint, the caller
    // never saw an error, and the Workshop was never told anything.
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(coordinator.stored()?.token).toBe("minted");
  });

  it("spends one mint and one notification on a dead grant under concurrent runs", async () => {
    const { coordinator, source, notify, mint } = harness({
      mint: async () => { throw new CredentialsExpiredError("invalid_grant"); },
    });
    coordinator.connect({ token: "dead-bearer", expiresAt: Date.now() + hour });

    const runs = [
      source.run(async () => { throw new Error("401"); }, { replayable: true }),
      source.run(async () => { throw new Error("401"); }, { replayable: true }),
      source.run(async () => { throw new Error("401"); }, { replayable: true }),
    ];
    for (const run of runs) await expect(run).rejects.toThrow(CredentialsExpiredError);

    // The burst coalesces: one read, one ask, one doomed mint, one Workshop notification.
    expect(mint).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    // The grant stays stored until reconnect; the account made its verdict, not a disconnect.
    expect(coordinator.stored()?.token).toBe("dead-bearer");
  });

  it("hands a non-replayable caller a retryable error whose re-entry needs no second mint", async () => {
    const { coordinator, source, notify, mint } = harness();
    coordinator.connect({ token: "stale-bearer", expiresAt: Date.now() + hour });
    const operation = providerAccepting("minted");

    // The branch's old footgun, closed: a stale derived bearer on a non-replayable call heals
    // account-side all the same — the caller re-enters instead of retiring a healthy account.
    await expect(source.run(operation)).rejects.toThrow(CredentialsChangedError);
    expect(await source.run(operation)).toBe("minted");

    expect(mint).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a disconnect landing mid-heal as expiry, not a retryable change", async () => {
    const gate = Promise.withResolvers<Creds>();
    const { coordinator, source, notify, mint } = harness({ mint: () => gate.promise });
    coordinator.connect({ token: "stale-bearer", expiresAt: Date.now() + hour });

    const run = source.run(async () => { throw new Error("401"); });
    await vi.waitFor(() => expect(mint).toHaveBeenCalled());
    coordinator.clear();
    gate.reject(new Error("502 from token endpoint"));

    // "Retry it" would bounce the caller into a disconnected account; expiry says reconnect.
    await expect(run).rejects.toThrow(CredentialsExpiredError);
    await expect(run).rejects.toThrow("Reconnect.");
    expect(notify).not.toHaveBeenCalled();
  });

  it("resolves a rejection under a mid-operation reconnect as retryable without healing", async () => {
    const { coordinator, source, notify, mint } = harness();
    coordinator.connect({ token: "old", expiresAt: Date.now() + hour });
    const { run: call, release } = await stalledRun(source, { replayable: true });

    coordinator.connect({ token: "reconnected", expiresAt: Date.now() + hour });
    release();

    // The rejected identity was already replaced: the moved-past gate answers superseded with no
    // mint, and the crossed generation keeps the retry off the new principal — the caller
    // re-enters and runs under the reconnect deliberately.
    await expect(call).rejects.toThrow(CredentialsChangedError);
    expect(mint).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await source.run(providerAccepting("reconnected"))).toBe("reconnected");
  });

  it("spends one mint however many facets report their stale bearers", async () => {
    const { coordinator, source, newSource, notify, mint } = harness();
    coordinator.connect({ token: "first-bearer", expiresAt: Date.now() + hour });
    const operation = providerAccepting("minted");

    // A facet's run reads the first bearer and stalls mid-operation.
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const slow = source.run(async creds => {
      if (creds.token === "first-bearer") {
        entered.resolve();
        await gate.promise;
        throw new Error("401");
      }
      return operation(creds);
    }, { replayable: true });
    await entered.promise;

    // The account rotates in place — a sibling refresh — and a second facet's rejection of the
    // rotated bearer heals: the one mint.
    await coordinator.rotate(async () => ({ token: "second-bearer", expiresAt: Date.now() + hour }));
    expect(await newSource().run(operation, { replayable: true })).toBe("minted");
    expect(mint).toHaveBeenCalledOnce();

    // The first facet's report names an identity the account moved past twice over: the gate
    // answers superseded without minting, and its retry rides the healed grant.
    gate.resolve();
    expect(await slow).toBe("minted");
    expect(mint).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("caps a heal the provider keeps rejecting at two attempts", async () => {
    const { coordinator, source, notify, mint } = harness();
    coordinator.connect({ token: "stale-bearer", expiresAt: Date.now() + hour });
    const operation = providerAccepting();

    // Every mint succeeds and honestly supersedes the rejected identity, so no verdict ever says
    // expired — the source still stops at two executions and hands re-entry to the caller.
    await expect(source.run(operation, { replayable: true }))
      .rejects.toThrow(CredentialsChangedError);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });
});
