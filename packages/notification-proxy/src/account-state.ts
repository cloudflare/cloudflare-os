import { DurableObject } from "cloudflare:workers";
import type {
  PermissionRequestedDelivery, TaskCompletedDelivery,
} from "@gadgets/workshop-shared/notification-delivery";
import { registerDevice, sendPermissionRequested, sendTaskCompleted } from "./delegate.js";

const SUBSCRIPTION_KEY = "deliverySubscription";

/** Durable storage and central-delivery boundary for one installation user. */
export class NotificationAccountState extends DurableObject<Cloudflare.Env> {
  /** Exchange a one-time device registration for an install-bound delivery subscription. */
  async registerDevice(deviceRegistrationId: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(deviceRegistrationId)) {
      throw new Error("Invalid notification device registration.");
    }
    let { serviceUrl, identity } = this.#configuration();
    let subscriptionId = await registerDevice(
      serviceUrl, identity, deviceRegistrationId,
    );
    this.ctx.storage.kv.put(SUBSCRIPTION_KEY, subscriptionId);
  }

  /** Deliver a typed task completion using the stored grant. */
  async deliverTaskCompleted(delivery: TaskCompletedDelivery): Promise<void> {
    let subscriptionId = this.ctx.storage.kv.get<string>(SUBSCRIPTION_KEY);
    if (!subscriptionId) return;
    let { serviceUrl, identity } = this.#configuration();
    await sendTaskCompleted(serviceUrl, identity, subscriptionId, delivery);
  }

  /** Deliver a permission-request alert using the existing install-bound subscription. */
  async deliverPermissionRequested(delivery: PermissionRequestedDelivery): Promise<void> {
    let subscriptionId = this.ctx.storage.kv.get<string>(SUBSCRIPTION_KEY);
    if (!subscriptionId) return;
    let { serviceUrl, identity } = this.#configuration();
    await sendPermissionRequested(serviceUrl, identity, subscriptionId, delivery);
  }

  #configuration() {
    let serviceUrl = this.env.NOTIFICATION_SERVICE_URL;
    if (!serviceUrl) throw new Error("Notification service is not configured.");
    let installId = this.env.CFOS_INSTALL_ID;
    let keyId = this.env.CFOS_INSTALL_KEY_ID;
    let privateKey = this.env.CFOS_INSTALL_PRIVATE_KEY;
    if (!installId || !keyId || !privateKey) {
      throw new Error("Cloudflare OS install identity is not configured.");
    }
    return { serviceUrl, identity: { installId, keyId, privateKey } };
  }
}
