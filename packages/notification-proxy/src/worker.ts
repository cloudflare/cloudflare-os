import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  NotificationDeliveryService as NotificationDeliveryContract,
  PermissionRequestedDelivery,
  TaskCompletedDelivery,
} from "@gadgets/workshop-shared/notification-delivery";
import { NotificationAccountState } from "./account-state.js";

/** Platform-private install-local proxy for the centralized notification service. */
@validateRpc()
export class NotificationDeliveryService
  extends WorkerEntrypoint<Cloudflare.Env>
  implements NotificationDeliveryContract
{
  /** Consume a one-time native registration for an account. */
  registerDevice(accountId: string, deviceRegistrationId: string): Promise<void> {
    return this.#account(accountId).registerDevice(deviceRegistrationId);
  }

  /** Deliver a task-completion notification for an account. */
  deliverTaskCompleted(accountId: string, delivery: TaskCompletedDelivery): Promise<void> {
    return this.#account(accountId).deliverTaskCompleted(delivery);
  }

  /** Alert an account that its task is paused on a permission prompt. */
  deliverPermissionRequested(
    accountId: string,
    delivery: PermissionRequestedDelivery,
  ): Promise<void> {
    return this.#account(accountId).deliverPermissionRequested(delivery);
  }

  #account(accountId: string): DurableObjectStub<NotificationAccountState> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId)) {
      throw new Error("Invalid notification account id.");
    }
    return this.ctx.exports.NotificationAccountState.getByName(accountId);
  }
}

export default NotificationDeliveryService;
export { NotificationAccountState };
