// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, NotificationSubscriber, UserNotification,
} from "@gadgets/workshop-shared/api";
import { NotificationBridge } from "./NotificationBridge";

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
