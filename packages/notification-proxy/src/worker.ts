import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { UserNotification } from "@gadgets/workshop-shared/api";
import type {
  NotificationDeliveryService as NotificationDeliveryContract,
} from "@gadgets/workshop-shared/notification-delivery";
import { deliver, registerDevice } from "./delegate.js";

/** Platform-private install-local proxy that signs requests to the central notification service. */
@validateRpc()
export class NotificationDeliveryService
  extends WorkerEntrypoint<Cloudflare.Env>
  implements NotificationDeliveryContract
{
  registerDevice(deviceRegistrationId: string): Promise<string> {
    return registerDevice(this.env, deviceRegistrationId);
  }

  deliver(subscriptionId: string, notification: UserNotification): Promise<void> {
    return deliver(this.env, subscriptionId, notification);
  }
}

export default NotificationDeliveryService;
