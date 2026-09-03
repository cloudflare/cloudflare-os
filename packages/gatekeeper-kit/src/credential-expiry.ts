/** Durable, deduplicated Workshop notification for expired credentials. */

import { createLogger } from "@gadgets/backend-utils/logger";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "./connect-nonce";
import type { KvReadWrite } from "./kv";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

// Kept compatible with existing gatekeepers.
const EXPIRED_NOTIFIED_KEY = "expiredNotified";

// Random arm tokens stop notifications started before reconnect or revoke from latching new credentials.
const EXPIRY_ARM_KEY = "expiredNotifiedArm";

/**
 * Durable Object KV used by the expiry latch. Pass the stable `ctx.storage.kv` object so
 * notifications coalesce across adapters.
 */
export type ExpiryLatchKv = KvReadWrite;

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.connect" });

function warnLatchFailure(vendorId: string, error: unknown): void {
  logger.warn("expiry latch storage failed", {
    event: "credentials.expiry.latch.failed",
    vendorId,
    error,
  });
}

// Coalesce one notification per storage object and arm.
const notifications = perStorage(() => new SingleFlight());

/**
 * Notifies the Workshop once per credential expiry. Concurrent calls share one flight per stable
 * storage object and arm. The latch is written after notification, so a crash may duplicate a
 * notice but cannot silence future expiry. Notification and storage failures are logged, not thrown.
 * @param kv Stable Durable Object expiry-latch storage.
 * @param callback Workshop callback, when connected.
 * @param vendorId Vendor ID for log attribution.
 *
 * @example
 * ```ts
 * const callback = this.ctx.storage.kv
 *   .get<Fetcher<GatekeeperConnectCallback>>("callback");
 * await notifyCredentialsExpiredOnce(this.ctx.storage.kv, callback, VENDOR_ID);
 * ```
 */
export async function notifyCredentialsExpiredOnce(
  kv: ExpiryLatchKv,
  callback: Fetcher<GatekeeperConnectCallback> | undefined,
  vendorId: string,
): Promise<void> {
  if (callback === undefined) return;

  try {
    if (kv.get<boolean>(EXPIRED_NOTIFIED_KEY)) return;

    // Read the arm before joining its in-flight notification.
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
    // Do not latch credentials reconnected or revoked during notification.
    if (kv.get<string>(EXPIRY_ARM_KEY) === arm) kv.put(EXPIRED_NOTIFIED_KEY, true);
  } catch (error) {
    warnLatchFailure(vendorId, error);
  }
}

/**
 * Re-arms the credential-expiry latch. Both writes must stay adjacent and awaitless so the arm and
 * latch commit together.
 * @param kv Stable Durable Object expiry-latch storage.
 */
export function clearCredentialExpiryLatch(kv: ExpiryLatchKv): void {
  const arm = generateNonce();
  kv.put(EXPIRED_NOTIFIED_KEY, false);
  kv.put(EXPIRY_ARM_KEY, arm);
}
