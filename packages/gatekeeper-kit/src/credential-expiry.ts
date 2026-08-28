import { createLogger } from "@gadgets/backend-utils/logger";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "./connect-nonce";
import type { KvReadWrite } from "./kv";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

/** KV key holding the expiry-notification latch. Unchanged from every current gatekeeper. */
const EXPIRED_NOTIFIED_KEY = "expiredNotified";

/**
 * Identifies the current arming of the latch, in its own key so the latch itself stays the plain
 * boolean every existing gatekeeper wrote. A notification that started before a reconnect must not
 * set the latch after it.
 *
 * Random per re-arm, and compared for equality only -- never a counter, for the same reason
 * `CredentialCoordinator.identity()` is not one: `revoke()` and the self-destruct alarm call
 * `deleteAll()`, and a counter restarting from zero would hand the replacement connection an arm a
 * notification for the revoked one is still holding, silencing the new account's first expiry.
 * An account imported from a pre-kit gatekeeper has no arm, so the first notification mints one
 * before calling out: an absent arm read as `""` would still equal `""` after a `deleteAll()`, and
 * the notification would latch a wiped account back into existence.
 */
const EXPIRY_ARM_KEY = "expiredNotifiedArm";

/**
 * The Durable Object KV surface used by the expiry latch.
 *
 * Pass the DO's own `ctx.storage.kv`, not a fresh wrapper per call: the coalescing below is keyed
 * by this object's identity, so two adapters over one account's storage can both notify for a
 * single arm. The `GatekeeperConnectCallback` contract tolerates that duplicate -- a crash between
 * the callback and the latch write produces one anyway -- but nothing else recovers it.
 */
export type ExpiryLatchKv = KvReadWrite;

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.connect" });

/** Both latch writes tolerate a storage failure the same way: logged, never thrown. */
function warnLatchFailure(vendorId: string, error: unknown): void {
  logger.warn("expiry latch storage failed", {
    event: "credentials.expiry.latch.failed",
    vendorId,
    error,
  });
}

/**
 * One in-flight notification per account *per arm*: a caller arriving after a reconnect re-armed
 * the latch needs its own notification, not the one already awaiting a callback for the credentials
 * that were replaced.
 */
const notifications = perStorage(() => new SingleFlight());

/**
 * Tell the Workshop the credentials need attention, at most once per expiry.
 *
 * The latch is set only after the callback resolves: a crash mid-notify then re-notifies later,
 * which is harmless, whereas claiming it up front would let a crash before the release silence
 * every future expiry and leave the user never asked to reconnect.
 *
 * Never throws — including from its own storage reads. Callers await this and then throw their own
 * "please reconnect", which neither a broken stored callback nor a failing latch may replace.
 */
export async function notifyCredentialsExpiredOnce(
  kv: ExpiryLatchKv,
  callback: Fetcher<GatekeeperConnectCallback> | undefined,
  vendorId: string,
): Promise<void> {
  if (callback === undefined) return;

  try {
    if (kv.get<boolean>(EXPIRED_NOTIFIED_KEY)) return;

    // Before the in-flight lookup, or a second caller would key off the new arm and notify twice.
    let arm = kv.get<string>(EXPIRY_ARM_KEY);
    if (arm === undefined) {
      arm = generateNonce();
      kv.put(EXPIRY_ARM_KEY, arm);
    }

    await notifications(kv).run(arm, () => notify(kv, callback, vendorId, arm));
  } catch (error) {
    warnLatchFailure(vendorId, error);
  }
}

async function notify(
  kv: ExpiryLatchKv,
  callback: Fetcher<GatekeeperConnectCallback>,
  vendorId: string,
  arm: string,
): Promise<void> {
  try {
    await callback.credentialsExpired();
  } catch (error) {
    logger.warn("failed to notify credential expiry", {
      event: "credentials.expiry.notify.failed",
      vendorId,
      error,
    });
    return;
  }

  try {
    // A reconnect during the call re-armed the latch, and a revoke deleted it; either way latching
    // now would silence the next expiry. Separate from the RPC so a storage failure is not reported
    // as a failed notification.
    if (kv.get<string>(EXPIRY_ARM_KEY) === arm) kv.put(EXPIRED_NOTIFIED_KEY, true);
  } catch (error) {
    warnLatchFailure(vendorId, error);
  }
}

/**
 * Re-arm the latch. Call wherever credentials are (re)established.
 *
 * The two writes must stay adjacent and awaitless, so one implicit transaction carries both. Split
 * by an await, a cleared latch could commit with the old arm surviving, and an in-flight
 * notification for the replaced credentials would then match that arm and latch the new ones --
 * silencing the reconnect prompt this module exists to deliver.
 */
export function clearCredentialExpiryLatch(kv: ExpiryLatchKv): void {
  const arm = generateNonce();
  kv.put(EXPIRED_NOTIFIED_KEY, false);
  kv.put(EXPIRY_ARM_KEY, arm);
}
