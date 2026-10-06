import type { WorkerEntrypoint } from "cloudflare:workers";
import type { UserNotification } from "./api.js";

/** Platform-private service binding implemented by the install-local notification proxy. */
export interface NotificationDeliveryService extends WorkerEntrypoint {
  /** Exchange a one-time native device registration for an install-bound push subscription id. */
  registerDevice(deviceRegistrationId: string): Promise<string>;

  /** Push a notification to the device behind `subscriptionId`. */
  deliver(subscriptionId: string, notification: UserNotification): Promise<void>;
}
