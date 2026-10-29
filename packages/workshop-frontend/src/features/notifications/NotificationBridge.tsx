import { useEffect, useRef } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  NotificationSubscriber,
  UserNotification,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";
import { nativeApp } from "../native-app/nativeApp";
import { registerNativeNotificationEnrollment } from "./nativeNotificationEnrollment";
import { isChatVisible } from "./visibleChat";

const DEVICE_REGISTRATION_EVENT = "cloudflare-os:notification-device-registration";
const NOTIFICATION_AUTHORIZATION_REQUEST_EVENT =
  "cloudflare-os:notification-authorization-request";

type LegacyNativeNotificationWindow = Window & {
  __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__?: string;
  __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?: () => void;
  webkit?: { messageHandlers?: { cloudflareOSNotificationReady?: {
    postMessage: (message: { type: "ready" | "failed" }) => void;
  } } };
};

class NotificationSubscriberImpl extends RpcTarget implements NotificationSubscriber {
  constructor(
    private readonly present: (notification: UserNotification) => void,
    private readonly onReleased: () => void,
  ) {
    super();
  }

  async notify(notification: UserNotification): Promise<void> {
    if (document.visibilityState !== "visible") {
      throw new Error("notification client is not visible");
    }
    this.present(notification);
  }

  // capnweb calls this once the server drops its last reference to the subscriber.
  [Symbol.dispose]() {
    this.onReleased();
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
  const router = useRouter();
  const currentApi = useRef(authenticatedApi);
  currentApi.current = authenticatedApi;
  const askedNative = useRef(false);
  const mounted = useRef(false);
  const requestingAuthorization = useRef(false);
  const claimedRegistrations = useRef(new Set<string>());
  const pendingRegistrations = useRef(0);
  const retriedAuthorizedRegistration = useRef(false);
  const activeEnrollmentEffect = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const effect = Symbol();
    activeEnrollmentEffect.current = effect;
    let legacyWindow = window as LegacyNativeNotificationWindow;
    let notifications = nativeApp()?.notifications;
    let stopped = false;
    mounted.current = true;
    const reportRegistration = (outcome: "ready" | "failed") => {
      if (notifications) {
        notifications.registrationFinished(outcome);
      } else {
        legacyWindow.webkit?.messageHandlers?.cloudflareOSNotificationReady
          ?.postMessage({ type: outcome });
      }
    };
    const requestRegistration = async () => {
      if (!mounted.current) return;
      if (!notifications?.authorizationRequired) {
        if (notifications) notifications.requestDeviceRegistration();
        else legacyWindow.__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?.();
        return;
      }
      if (requestingAuthorization.current) return;
      requestingAuthorization.current = true;
      try {
        const authorization = await currentApi.current.authorizeNotificationDevice();
        if (mounted.current) notifications.requestDeviceRegistration(authorization);
      } catch (error) {
        if (mounted.current) {
          reportRegistration("failed");
          logRpcFailure("Failed to authorize notification device:", error);
        }
      } finally {
        requestingAuthorization.current = false;
      }
    };
    const register = async (deviceRegistrationId: string | undefined) => {
      if (!mounted.current || !deviceRegistrationId ||
          claimedRegistrations.current.has(deviceRegistrationId)) return;
      // Native handles are single-use. The mounted ref lets the original exchange report through
      // Strict Mode's effect replay without redeeming the handle again.
      claimedRegistrations.current.add(deviceRegistrationId);
      if (legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__ ===
          deviceRegistrationId) {
        delete legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
      }
      let outcome: "ready" | "failed" = "ready";
      pendingRegistrations.current++;
      try {
        if (notifications?.authorizationRequired) {
          await currentApi.current.registerAuthorizedNotificationDevice(deviceRegistrationId);
        } else {
          await currentApi.current.registerNotificationDevice(deviceRegistrationId);
        }
      } catch (error) {
        outcome = "failed";
        logRpcFailure("Failed to register notification device:", error);
      } finally {
        pendingRegistrations.current--;
      }
      if (!mounted.current) return;
      reportRegistration(outcome);
      // An injected handle may have expired before this authenticated mount. Ask native to mint
      // one fresh handle, but never turn a service outage into an authorization retry loop.
      if (outcome === "failed" && notifications?.authorizationRequired &&
          !retriedAuthorizedRegistration.current) {
        retriedAuthorizedRegistration.current = true;
        void requestRegistration();
      }
    };
    const onDeviceRegistration = (event: Event) => {
      void register(eventDeviceRegistration(event));
    };

    // The legacy globals remain only for the currently distributed TestFlight build. New shells
    // expose notification controls through the same versioned object as navigation and login.
    let injected = notifications?.currentDeviceRegistration() ??
      legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
    void register(injected);
    window.addEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
    const onAuthorizationRequest = () => { void requestRegistration(); };
    window.addEventListener(NOTIFICATION_AUTHORIZATION_REQUEST_EVENT, onAuthorizationRequest);
    const stopEnrollment = () => {
      if (stopped) return;
      stopped = true;
      mounted.current = false;
      if (requestingAuthorization.current || pendingRegistrations.current > 0) {
        reportRegistration("failed");
      }
      try {
        notifications?.disconnect?.();
      } catch (error) {
        console.error("Failed to disconnect native notifications:", error);
      }
    };
    const unregisterEnrollment = registerNativeNotificationEnrollment(stopEnrollment);
    // Each id costs a central registration. Ask at most once per authenticated mount, and not at
    // all when native already injected one.
    if (!askedNative.current) {
      askedNative.current = true;
      if (!injected) {
        void requestRegistration();
      }
    }
    return () => {
      const enrollmentWasPending =
        requestingAuthorization.current || pendingRegistrations.current > 0;
      mounted.current = false;
      window.removeEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
      window.removeEventListener(NOTIFICATION_AUTHORIZATION_REQUEST_EVENT, onAuthorizationRequest);
      unregisterEnrollment();
      // React Strict Mode immediately starts a replacement effect. Defer the terminal callback so
      // that replay can retain the one-use handle while a real unmount never strands native.
      queueMicrotask(() => {
        if (!stopped && enrollmentWasPending &&
            activeEnrollmentEffect.current === effect && !mounted.current) {
          reportRegistration("failed");
        }
      });
    };
  // Enrollment belongs to this authenticated mount, not each replacement WebSocket stub.
  }, []);

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;

    let updateSubscription = () => {
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (document.visibilityState !== "visible") return;

      let live = false;
      let subscriber = new NotificationSubscriberImpl(notification => {
        let { id, kind, workspaceId, chatId, chatTitle } = notification;
        if (isChatVisible(workspaceId, chatId)) return;
        let completed = kind === "taskCompleted";
        addToast.current({
          id,
          title: `${chatTitle || "Task"} ${completed ? "completed" : "needs permission"}`,
          variant: completed ? "success" : "info",
          actions: [{
            children: "Open task",
            onClick: () => router.navigate({
              to: "/workspace/$id",
              params: { id: workspaceId },
              search: { chat: chatId, showChat: true },
            }),
          }],
        });
      }, () => {
        // Released while still ours, after it took: the User DO reset and forgot it. (A failed
        // subscribe releases it too, so `live` keeps that from retrying in a loop.)
        if (live && subscription === nextSubscription) updateSubscription();
      }) as unknown as RpcStub<NotificationSubscriber>;
      let nextSubscription = authenticatedApi.subscribeToNotifications(subscriber);
      subscription = nextSubscription;
      nextSubscription.then(() => { live = true; }, error => {
        if (subscription !== nextSubscription) return;
        logRpcFailure("Notification subscription failed:", error);
      });
    };

    document.addEventListener("visibilitychange", updateSubscription);
    updateSubscription();
    return () => {
      document.removeEventListener("visibilitychange", updateSubscription);
      subscription?.[Symbol.dispose]();
      subscription = undefined;
    };
  }, [authenticatedApi, router]);

  return null;
};
