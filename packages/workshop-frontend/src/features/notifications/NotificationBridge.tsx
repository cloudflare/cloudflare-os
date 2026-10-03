import { useEffect, useRef } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  NotificationSubscriber,
  UserNotification,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";

const DEVICE_REGISTRATION_EVENT = "cloudflare-os:notification-device-registration";

type NativeNotificationWindow = Window & {
  __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__?: string;
  __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?: () => void;
  webkit?: { messageHandlers?: { cloudflareOSNotificationReady?: {
    postMessage: (message: { type: "ready" | "failed" }) => void;
  } } };
};

class NotificationSubscriberImpl extends RpcTarget implements NotificationSubscriber {
  constructor(private readonly present: (notification: UserNotification) => void) {
    super();
  }

  async notify(notification: UserNotification): Promise<void> {
    if (document.visibilityState !== "visible") {
      throw new Error("notification client is not visible");
    }
    this.present(notification);
  }
}

const eventDeviceRegistration = (event: Event): string | undefined => {
  if (!(event instanceof CustomEvent)) return undefined;
  let detail = event.detail as { deviceRegistrationId?: unknown } | null;
  return typeof detail?.deviceRegistrationId === "string" ? detail.deviceRegistrationId : undefined;
};

/** Connects the authenticated SPA to native enrollment and live notification delivery. */
export const NotificationBridge = ({
  authenticatedApi,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
}) => {
  const toasts = useKumoToastManager();
  const addToast = useRef(toasts.add);
  addToast.current = toasts.add;

  useEffect(() => {
    let lastRegistered: string | undefined;
    let nativeWindow = window as NativeNotificationWindow;
    let register = async (deviceRegistrationId: string | undefined) => {
      if (!deviceRegistrationId || deviceRegistrationId === lastRegistered) return;
      lastRegistered = deviceRegistrationId;
      // The native handle is single-use. Claim it before awaiting so an Effect restart cannot
      // submit it concurrently or retry it after the central exchange consumed it.
      if (nativeWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__ ===
          deviceRegistrationId) {
        delete nativeWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
      }
      try {
        await authenticatedApi.registerNotificationDevice(deviceRegistrationId);
        nativeWindow.webkit?.messageHandlers?.cloudflareOSNotificationReady
          ?.postMessage({ type: "ready" });
      } catch (error) {
        lastRegistered = undefined;
        nativeWindow.webkit?.messageHandlers?.cloudflareOSNotificationReady
          ?.postMessage({ type: "failed" });
        logRpcFailure("Failed to register notification device:", error);
      }
    };
    let onDeviceRegistration = (event: Event) => {
      void register(eventDeviceRegistration(event));
    };

    void register(nativeWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__);
    window.addEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
    nativeWindow.__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?.();
    return () => window.removeEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
  }, [authenticatedApi]);

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;

    let updateSubscription = () => {
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (document.visibilityState !== "visible") return;

      let subscriber = new NotificationSubscriberImpl(notification => {
        addToast.current({
          id: notification.id,
          title: notification.kind === "taskCompleted"
            ? `${notification.chatTitle || "Task"} completed`
            : `${notification.chatTitle || "Task"} needs permission`,
          variant: notification.kind === "taskCompleted" ? "success" : "info",
          actions: [{
            children: "Open task",
            onClick: () => window.location.assign(notification.targetPath),
          }],
        });
      }) as unknown as RpcStub<NotificationSubscriber>;
      let nextSubscription = authenticatedApi.subscribeToNotifications(subscriber);
      subscription = nextSubscription;
      nextSubscription.catch(error => {
        if (subscription !== nextSubscription) return;
        logRpcFailure("Notification subscription failed:", error);
      });
    };

    document.addEventListener("visibilitychange", updateSubscription);
    updateSubscription();
    return () => {
      document.removeEventListener("visibilitychange", updateSubscription);
      subscription?.[Symbol.dispose]();
    };
  }, [authenticatedApi]);

  return null;
};
