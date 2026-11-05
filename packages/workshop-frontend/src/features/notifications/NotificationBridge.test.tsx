// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, NotificationSubscriber, UserNotification,
} from "@gadgets/workshop-shared/api";
import { NotificationBridge } from "./NotificationBridge";
import { disconnectNativeNotificationEnrollment } from "./nativeNotificationEnrollment";
import { reportVisibleChat } from "./visibleChat";

const addToast = vi.fn<(options: { actions: { onClick: () => void }[] }) => void>();
const router = { navigate: vi.fn<(options: object) => void>() };

vi.mock("@cloudflare/kumo", () => ({ useKumoToastManager: () => ({ add: addToast }) }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

const notification: UserNotification = {
  id: "notification-1",
  kind: "taskCompleted",
  workspaceId: "workspace-1",
  chatId: 1,
  chatTitle: "Build the demo",
};

const setVisibility = (visibilityState: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState });
  document.dispatchEvent(new Event("visibilitychange"));
};

type Subscribe = (subscriber: RpcStub<NotificationSubscriber>) => unknown;

describe("NotificationBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let subscribers: RpcStub<NotificationSubscriber>[];
  let dispose: Mock<() => void>;
  let authenticatedApi: {
    registerNotificationDevice: Mock<(deviceRegistrationId: string) => Promise<void>>;
    registerAuthorizedNotificationDevice: Mock<(deviceRegistrationId: string) => Promise<void>>;
    authorizeNotificationDevice: Mock<() => Promise<string>>;
    subscribeToNotifications: Mock<Subscribe>;
  };

  const render = () => act(async () => root.render(
    <NotificationBridge
      authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>} />,
  ));
  // What capnweb does once the server drops its last reference to a subscriber.
  const release = (index: number) => act(async () =>
    (subscribers[index] as unknown as Disposable)[Symbol.dispose]());

  beforeEach(() => {
    addToast.mockClear();
    router.navigate.mockClear();
    setVisibility("visible");
    subscribers = [];
    dispose = vi.fn<() => void>();
    authenticatedApi = {
      authorizeNotificationDevice: vi.fn<() => Promise<string>>().mockResolvedValue("a".repeat(64)),
      registerAuthorizedNotificationDevice: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(),
      registerNotificationDevice: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(),
      subscribeToNotifications: vi.fn<Subscribe>(subscriber => {
        subscribers.push(subscriber);
        return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
      }),
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "cloudflareOSNative");
    Reflect.deleteProperty(window, "__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__");
  });

  it("obtains a CFOS-authorized grant before asking new native apps to enroll", async () => {
    const request = vi.fn<(authorization?: string) => void>();
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true, currentDeviceRegistration: () => undefined,
        requestDeviceRegistration: request, registrationFinished: finished,
      } } });
    await render();
    expect(request).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
    await act(async () => window.dispatchEvent(new CustomEvent(
      "cloudflare-os:notification-device-registration",
      { detail: { deviceRegistrationId: "native-handle" } },
    )));
    expect(authenticatedApi.registerAuthorizedNotificationDevice)
        .toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(authenticatedApi.registerNotificationDevice).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith("ready");
    authenticatedApi = { ...authenticatedApi };
    await render();
    expect(authenticatedApi.authorizeNotificationDevice).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(
      new Event("cloudflare-os:notification-authorization-request")));
    expect(authenticatedApi.authorizeNotificationDevice).toHaveBeenCalledTimes(2);
  });

  it("does not hand a late grant to native after the authenticated view unmounts", async () => {
    let resolve!: (grant: string) => void;
    authenticatedApi.authorizeNotificationDevice.mockReturnValue(
        new Promise(done => { resolve = done; }));
    const request = vi.fn<(authorization?: string) => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true, currentDeviceRegistration: () => undefined,
        requestDeviceRegistration: request,
        registrationFinished: vi.fn<(outcome: "ready" | "failed") => void>(),
      } } });
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => resolve("a".repeat(64)));
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a pending registration as failed when the authenticated view unmounts", async () => {
    const registration = Promise.withResolvers<void>();
    authenticatedApi.registerAuthorizedNotificationDevice.mockReturnValue(registration.promise);
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    const disconnect = vi.fn<() => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true,
        currentDeviceRegistration: () => "pending-handle",
        requestDeviceRegistration: vi.fn<(authorization?: string) => void>(),
        registrationFinished: finished,
        disconnect,
      } } });
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(finished).toHaveBeenCalledExactlyOnceWith("failed");
    expect(disconnect).not.toHaveBeenCalled();
    await act(async () => registration.resolve());
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("stops pending enrollment before disconnecting native on logout", async () => {
    authenticatedApi.registerAuthorizedNotificationDevice.mockReturnValue(new Promise(() => {}));
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    const disconnect = vi.fn<() => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true,
        currentDeviceRegistration: () => "pending-handle",
        requestDeviceRegistration: vi.fn<(authorization?: string) => void>(),
        registrationFinished: finished,
        disconnect,
      } } });
    await render();
    act(() => disconnectNativeNotificationEnrollment());
    expect(finished).toHaveBeenCalledExactlyOnceWith("failed");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("replaces one stale authorized registration without retrying indefinitely", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticatedApi.registerAuthorizedNotificationDevice.mockRejectedValue(
      new Error("registration expired"),
    );
    const request = vi.fn<(authorization?: string) => void>();
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true,
        currentDeviceRegistration: () => "stale-handle",
        requestDeviceRegistration: request,
        registrationFinished: finished,
      } } });
    await render();
    expect(finished).toHaveBeenCalledExactlyOnceWith("failed");
    expect(authenticatedApi.authorizeNotificationDevice).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
  });

  it("hands a pending grant to the active Strict Mode effect", async () => {
    let resolve!: (grant: string) => void;
    authenticatedApi.authorizeNotificationDevice.mockReturnValue(
        new Promise(done => { resolve = done; }));
    const request = vi.fn<(authorization?: string) => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true, currentDeviceRegistration: () => undefined,
        requestDeviceRegistration: request,
        registrationFinished: vi.fn<(outcome: "ready" | "failed") => void>(),
      } } });
    await act(async () => root.render(
      <StrictMode>
        <NotificationBridge
          authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>} />
      </StrictMode>,
    ));
    expect(authenticatedApi.authorizeNotificationDevice).toHaveBeenCalledOnce();
    await act(async () => resolve("a".repeat(64)));
    expect(request).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
  });

  it("reports an injected registration from the active Strict Mode effect", async () => {
    let resolveRegistration!: () => void;
    authenticatedApi.registerAuthorizedNotificationDevice.mockReturnValue(
      new Promise(done => { resolveRegistration = done; }),
    );
    const request = vi.fn<(authorization?: string) => void>();
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    Object.assign(window, { cloudflareOSNative: { version: 1, isAvailable: () => true,
      loginReady: () => {}, returnToInstalls: () => {}, notifications: {
        authorizationRequired: true,
        currentDeviceRegistration: () => "strict-mode-handle",
        requestDeviceRegistration: request,
        registrationFinished: finished,
      } } });
    await act(async () => root.render(
      <StrictMode>
        <NotificationBridge
          authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>} />
      </StrictMode>,
    ));
    expect(authenticatedApi.registerAuthorizedNotificationDevice)
        .toHaveBeenCalledExactlyOnceWith("strict-mode-handle");
    await act(async () => resolveRegistration());
    expect(finished).toHaveBeenCalledExactlyOnceWith("ready");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a legacy-global registration through Strict Mode effect replay", async () => {
    let resolveRegistration!: () => void;
    authenticatedApi.registerNotificationDevice.mockReturnValue(
      new Promise(done => { resolveRegistration = done; }),
    );
    const finished = vi.fn<(message: { type: "ready" | "failed" }) => void>();
    Object.assign(window, {
      __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__: "legacy-handle",
      webkit: { messageHandlers: { cloudflareOSNotificationReady: { postMessage: finished } } },
    });
    await act(async () => root.render(
      <StrictMode>
        <NotificationBridge
          authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>} />
      </StrictMode>,
    ));
    expect(authenticatedApi.registerNotificationDevice)
        .toHaveBeenCalledExactlyOnceWith("legacy-handle");
    await act(async () => resolveRegistration());
    expect(finished).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
    Reflect.deleteProperty(window, "webkit");
  });

  it("keeps one subscription across rerenders and declines while hidden", async () => {
    await render();
    // Kumo returns a new toast manager whenever its consumer renders; resubscribing on each one
    // would fan a single notification out through accumulated subscribers.
    await render();
    expect(authenticatedApi.subscribeToNotifications).toHaveBeenCalledTimes(1);

    await act(async () => setVisibility("hidden"));
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(subscribers[0].notify(notification)).rejects.toThrow("not visible");
    expect(addToast).not.toHaveBeenCalled();
  });

  it("subscribes again when the server drops a live subscription, not after unsubscribing",
      async () => {
    await render();
    // A User DO reset releases the subscriber while the session lives on.
    await release(0);
    expect(authenticatedApi.subscribeToNotifications).toHaveBeenCalledTimes(2);
    await act(() => subscribers[1].notify(notification));
    expect(addToast).toHaveBeenCalledTimes(1);

    // Unsubscribing releases it too, whether hidden or unmounted.
    await act(async () => setVisibility("hidden"));
    await release(1);
    await act(async () => setVisibility("visible"));
    await act(async () => root.unmount());
    await release(2);
    expect(authenticatedApi.subscribeToNotifications).toHaveBeenCalledTimes(3);
    root = createRoot(container);
  });

  it("does not retry a subscription that failed", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticatedApi.subscribeToNotifications.mockImplementationOnce(subscriber => {
      subscribers.push(subscriber);
      return Object.assign(Promise.reject(new Error("unavailable")), { [Symbol.dispose]: dispose });
    });
    await render();
    // A failed call releases its arguments as well.
    await release(0);
    expect(authenticatedApi.subscribeToNotifications).toHaveBeenCalledTimes(1);
  });

  it("opens a notified task in the app", async () => {
    await render();
    await act(() => subscribers[0].notify(notification));
    addToast.mock.calls[0][0].actions[0].onClick();
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id", params: { id: "workspace-1" }, search: { chat: 1, showChat: true },
    });
  });

  it("does not announce a task whose chat is on screen", async () => {
    await render();
    const withdraw = reportVisibleChat(() => ({ workspaceId: "workspace-1", chatId: 1 }));
    await act(() => subscribers[0].notify(notification));
    expect(addToast).not.toHaveBeenCalled();

    await act(() => subscribers[0].notify({ ...notification, chatId: 2 }));
    expect(addToast).toHaveBeenCalledOnce();
    withdraw();
  });

  it("registers the native app's device and reports the outcome", async () => {
    let postMessage = vi.fn<(message: { type: string }) => void>();
    Object.assign(window, {
      webkit: { messageHandlers: { cloudflareOSNotificationReady: { postMessage } } },
    });
    await render();
    await act(async () => window.dispatchEvent(new CustomEvent(
      "cloudflare-os:notification-device-registration",
      { detail: { deviceRegistrationId: "registration-1" } },
    )));
    expect(authenticatedApi.registerNotificationDevice).toHaveBeenCalledWith("registration-1");
    expect(postMessage).toHaveBeenCalledWith({ type: "ready" });
    Reflect.deleteProperty(window, "webkit");
  });

  it("uses notification controls on the versioned native bridge", async () => {
    let request = vi.fn<() => void>();
    let finished = vi.fn<(outcome: "ready" | "failed") => void>();
    Object.assign(window, {
      cloudflareOSNative: {
        version: 1,
        isAvailable: () => true,
        loginReady: () => {},
        returnToInstalls: () => {},
        notifications: {
          currentDeviceRegistration: () => "registration-2",
          requestDeviceRegistration: request,
          registrationFinished: finished,
        },
      },
    });
    await render();
    expect(authenticatedApi.registerNotificationDevice).toHaveBeenCalledWith("registration-2");
    expect(finished).toHaveBeenCalledWith("ready");
    expect(request).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "cloudflareOSNative");
  });

  it("does not redeem a versioned one-use registration again during an RPC reconnect", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    let failRegistration!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { failRegistration = reject; });
    authenticatedApi.registerNotificationDevice.mockReturnValue(pending);
    const finished = vi.fn<(outcome: "ready" | "failed") => void>();
    Object.assign(window, {
      cloudflareOSNative: {
        version: 1,
        isAvailable: () => true,
        loginReady: () => {},
        returnToInstalls: () => {},
        notifications: {
          currentDeviceRegistration: () => "registration-reconnect",
          requestDeviceRegistration: vi.fn<() => void>(),
          registrationFinished: finished,
        },
      },
    });

    await render();
    const firstApi = authenticatedApi;
    authenticatedApi = {
      ...authenticatedApi,
      registerNotificationDevice: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(),
    };
    await render();
    expect(firstApi.registerNotificationDevice).toHaveBeenCalledOnce();
    expect(authenticatedApi.registerNotificationDevice).not.toHaveBeenCalled();

    await act(async () => failRegistration(new Error("registration expired")));
    expect(finished).toHaveBeenCalledExactlyOnceWith("failed");
    Reflect.deleteProperty(window, "cloudflareOSNative");
  });

  it("asks the native app for a registration once, not again on reconnect", async () => {
    let request = vi.fn<() => void>();
    Object.assign(window, { __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__: request });
    await render();
    authenticatedApi = { ...authenticatedApi };
    await render();
    expect(request).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(window, "__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__");
  });

  it("registers an injected id without asking for another", async () => {
    let request = vi.fn<() => void>();
    Object.assign(window, {
      __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__: "registration-1",
      __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__: request,
    });
    await render();
    expect(authenticatedApi.registerNotificationDevice).toHaveBeenCalledWith("registration-1");
    expect(request).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__");
  });
});
