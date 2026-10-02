// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedApi, NotificationSubscriber } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import { NotificationBridge } from "./NotificationBridge";

const addToast = vi.fn<(options: unknown) => void>();

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: addToast }),
}));

type TestSubscription = RpcStub<{}> & { dispose: ReturnType<typeof vi.fn> };

const subscription = (): TestSubscription => {
  let dispose = vi.fn<() => void>();
  let catchResult = vi.fn<(handler: (error: unknown) => void) => unknown>();
  let value = {
    catch: catchResult,
    dispose,
    [Symbol.dispose]: dispose,
  };
  catchResult.mockReturnValue(value);
  return value as unknown as TestSubscription;
};

describe("NotificationBridge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    addToast.mockClear();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    delete (window as NativeWindow).__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
    delete (window as NativeWindow).__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__;
    delete (window as NativeWindow).webkit;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("registers native subscriptions and subscribes only while visible", async () => {
    let liveSubscription = subscription();
    let registerNotificationDevice = vi.fn<(id: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    let subscriber: RpcStub<NotificationSubscriber> | undefined;
    let subscribeToNotifications = vi.fn<
      (next: RpcStub<NotificationSubscriber>) => TestSubscription
    >((next) => {
      subscriber = next;
      return liveSubscription;
    });
    let authenticatedApi = {
      registerNotificationDevice,
      subscribeToNotifications,
    } as unknown as RpcStub<AuthenticatedApi>;
    let requestSubscription = vi.fn<() => void>();
    let notificationReady = vi.fn<(message: { type: "ready" | "failed" }) => void>();
    (window as NativeWindow).__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__ =
      requestSubscription;
    (window as NativeWindow).webkit = {
      messageHandlers: { cloudflareOSNotificationReady: { postMessage: notificationReady } },
    };

    await act(async () => root.render(
      <NotificationBridge authenticatedApi={authenticatedApi} />,
    ));
    expect(subscribeToNotifications).toHaveBeenCalledTimes(1);
    expect(requestSubscription).toHaveBeenCalledTimes(1);

    // Kumo returns a new manager wrapper whenever its consumer renders. It must not restart this
    // long-lived subscription or one completion fans out through accumulated subscribers.
    await act(async () => root.render(
      <NotificationBridge authenticatedApi={authenticatedApi} />,
    ));
    expect(subscribeToNotifications).toHaveBeenCalledTimes(1);
    expect(liveSubscription.dispose).not.toHaveBeenCalled();

    await act(async () => window.dispatchEvent(new CustomEvent(
      "cloudflare-os:notification-device-registration",
      { detail: { deviceRegistrationId: "a".repeat(64) } },
    )));
    expect(registerNotificationDevice).toHaveBeenCalledWith("a".repeat(64));
    expect(notificationReady).toHaveBeenCalledWith({ type: "ready" });

    await act(async () => subscriber!.notify({
      id: "notification-1",
      kind: "taskCompleted",
      workspaceId: "workspace-1",
      chatId: 1,
      workspaceTitle: "Demo",
      chatTitle: "Build the demo",
      createdAt: new Date(),
      targetPath: "/workspace/workspace-1?chat=1",
    }));
    expect(addToast).toHaveBeenCalledWith({
      id: "notification-1",
      title: "Build the demo completed",
      variant: "success",
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(liveSubscription.dispose).toHaveBeenCalledTimes(1);
  });
});

type NativeWindow = Window & {
  __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__?: string;
  __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?: () => void;
  webkit?: unknown;
};
