import { describe, expect, it, vi } from "vitest";
import {
  clearCredentialExpiryLatch,
  notifyCredentialsExpiredOnce,
  type ExpiryLatchKv,
} from "../../src/credential-expiry";
import { fakeKv } from "../fake-kv";

// Pin the legacy latch key because renaming it would re-notify existing accounts.
const EXPIRED_NOTIFIED_KEY = "expiredNotified";

// Pin the adjacent arm key for the same compatibility reason.
const EXPIRY_ARM_KEY = "expiredNotifiedArm";

function makeKv(): ExpiryLatchKv {
  return fakeKv();
}

type Callback = NonNullable<Parameters<typeof notifyCredentialsExpiredOnce>[1]>;

function makeCallback(credentialsExpired: () => Promise<void>): Callback {
  return { credentialsExpired } as unknown as Callback;
}

describe("notifyCredentialsExpiredOnce", () => {
  it("notifies once across sequential calls", async () => {
    const kv = makeKv();
    const credentialsExpired = vi.fn(async () => {});
    const callback = makeCallback(credentialsExpired);

    await notifyCredentialsExpiredOnce(kv, callback, "test");
    await notifyCredentialsExpiredOnce(kv, callback, "test");

    expect(credentialsExpired).toHaveBeenCalledOnce();
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(true);
  });

  it("retries after a callback that throws before it returns a promise", async () => {
    const kv = makeKv();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A disposed stub throws on the call itself, so the notification settles inside the same
      // synchronous frame that started it -- before anything could record it as in flight.
      const broken = makeCallback((() => {
        throw new Error("RPC stub used after disposal");
      }) as unknown as () => Promise<void>);
      await notifyCredentialsExpiredOnce(kv, broken, "test");
      expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBeUndefined();

      // A dead in-flight entry left behind here would swallow every later expiry for this arm.
      const credentialsExpired = vi.fn(async () => {});
      await notifyCredentialsExpiredOnce(kv, makeCallback(credentialsExpired), "test");
      expect(credentialsExpired).toHaveBeenCalledOnce();
      expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("sets the latch only after the callback resolves", async () => {
    const kv = makeKv();
    const { promise, resolve } = Promise.withResolvers<void>();
    const notifying = notifyCredentialsExpiredOnce(kv, makeCallback(() => promise), "test");

    await Promise.resolve();
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBeUndefined();

    resolve();
    await notifying;
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(true);
  });

  it("does not latch when a reconnect re-armed during the notification", async () => {
    const kv = makeKv();
    const { promise, resolve } = Promise.withResolvers<void>();
    const credentialsExpired = vi.fn(() => promise);
    const callback = makeCallback(credentialsExpired);

    const notifying = notifyCredentialsExpiredOnce(kv, callback, "test");
    clearCredentialExpiryLatch(kv);
    resolve();
    await notifying;

    // The stale notification must not silence the reconnected account's next expiry.
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(false);
    await notifyCredentialsExpiredOnce(kv, callback, "test");
    expect(credentialsExpired).toHaveBeenCalledTimes(2);
  });

  it("notifies again for an expiry that arrives after a reconnect re-armed", async () => {
    const kv = makeKv();
    const first = Promise.withResolvers<void>();
    const credentialsExpired = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => {});
    const callback = makeCallback(credentialsExpired);

    const stale = notifyCredentialsExpiredOnce(kv, callback, "test");
    clearCredentialExpiryLatch(kv);

    // The new expiry must not coalesce onto the notification for the credentials just replaced.
    const fresh = notifyCredentialsExpiredOnce(kv, callback, "test");
    first.resolve();
    await Promise.all([stale, fresh]);

    expect(credentialsExpired).toHaveBeenCalledTimes(2);
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(true);
  });

  it("never throws when the latch itself cannot be read", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = {
        get: () => { throw new Error("storage unavailable"); },
        put: () => {},
      } as unknown as ExpiryLatchKv;

      await expect(notifyCredentialsExpiredOnce(broken, makeCallback(async () => {}), "test"))
        .resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("leaves the latch unset when the callback fails, so a later call notifies again", async () => {
    const kv = makeKv();
    const credentialsExpired = vi.fn()
      .mockRejectedValueOnce(new Error("dropped RPC"))
      .mockResolvedValueOnce(undefined);
    const callback = makeCallback(credentialsExpired);

    await expect(notifyCredentialsExpiredOnce(kv, callback, "test")).resolves.toBeUndefined();
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBeUndefined();

    await notifyCredentialsExpiredOnce(kv, callback, "test");
    expect(credentialsExpired).toHaveBeenCalledTimes(2);
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(true);
  });

  it("shares one notification between concurrent callers", async () => {
    const kv = makeKv();
    const { promise, resolve } = Promise.withResolvers<void>();
    const credentialsExpired = vi.fn(() => promise);
    const callback = makeCallback(credentialsExpired);

    const both = Promise.all([
      notifyCredentialsExpiredOnce(kv, callback, "test"),
      notifyCredentialsExpiredOnce(kv, callback, "test"),
    ]);
    resolve();
    await both;

    expect(credentialsExpired).toHaveBeenCalledOnce();
  });

  it("does nothing without a callback", async () => {
    const kv = makeKv();
    await notifyCredentialsExpiredOnce(kv, undefined, "test");
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBeUndefined();
  });

  it("honors a latch left set by an older gatekeeper, and re-arms on clear", async () => {
    const kv = makeKv();
    kv.put(EXPIRED_NOTIFIED_KEY, true);
    const credentialsExpired = vi.fn(async () => {});
    const callback = makeCallback(credentialsExpired);

    await notifyCredentialsExpiredOnce(kv, callback, "test");
    expect(credentialsExpired).not.toHaveBeenCalled();

    clearCredentialExpiryLatch(kv);
    await notifyCredentialsExpiredOnce(kv, callback, "test");
    expect(credentialsExpired).toHaveBeenCalledOnce();
  });

  it("cannot latch a reconnect that re-armed after a revoke wiped the arm", async () => {
    // One DO's storage, so the wipe and the re-arm land where the in-flight notification will look.
    const values = new Map<string, unknown>();
    const kv: ExpiryLatchKv = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key, value) => void values.set(key, value),
    };
    clearCredentialExpiryLatch(kv);
    const { promise, resolve } = Promise.withResolvers<void>();

    // Connection A starts notifying, and is still awaiting its callback.
    const notifying = notifyCredentialsExpiredOnce(kv, makeCallback(() => promise), "test");

    // What revoke() and the self-destruct alarm do, followed by a fresh connection arming again.
    // A counter would restart from zero and hand B exactly the arm A is still holding.
    values.clear();
    clearCredentialExpiryLatch(kv);

    resolve();
    await notifying;

    // A's callback resolved for credentials that no longer exist, so B is still owed its first
    // notification.
    expect(kv.get(EXPIRED_NOTIFIED_KEY)).toBe(false);
    const credentialsExpired = vi.fn(async () => {});
    await notifyCredentialsExpiredOnce(kv, makeCallback(credentialsExpired), "test");
    expect(credentialsExpired).toHaveBeenCalledOnce();
  });

  it("cannot latch a wiped account that was imported without an arm", async () => {
    // What a pre-kit gatekeeper leaves behind: the boolean, no arm.
    const values = new Map<string, unknown>([[EXPIRED_NOTIFIED_KEY, false]]);
    const kv: ExpiryLatchKv = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key, value) => void values.set(key, value),
    };
    const { promise, resolve } = Promise.withResolvers<void>();

    const notifying = notifyCredentialsExpiredOnce(kv, makeCallback(() => promise), "test");
    // revoke() during the callback, with nothing reconnecting after it.
    values.clear();
    resolve();
    await notifying;

    expect([...values.keys()]).toEqual([]);
  });

  it("mints a distinct arm on every re-arm, so a wiped counter cannot recur", () => {
    const first = makeKv();
    const second = makeKv();
    clearCredentialExpiryLatch(first);
    clearCredentialExpiryLatch(second);

    // Same key, same call order, different value: nothing about the sequence is reproducible.
    expect(first.get(EXPIRY_ARM_KEY)).not.toBe(second.get(EXPIRY_ARM_KEY));
  });
});
