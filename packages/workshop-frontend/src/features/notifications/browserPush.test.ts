// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, WebPushSubscription } from "@gadgets/workshop-shared/api";
import { browserPushEnabled, disableBrowserPush, enableBrowserPush, syncBrowserPush } from "./browserPush";

const OWNER_KEY = "gadgets:notifications:browserPushOwner";
const ENDPOINT = "https://fcm.googleapis.com/wp/new";
const KEY = "BKey";

type FakeSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  toJSON: () => PushSubscriptionJSON;
  unsubscribe: Mock<() => Promise<boolean>>;
};

const fakeSubscription = (endpoint: string, key = KEY): FakeSubscription => ({
  endpoint,
  options: { applicationServerKey: Uint8Array.from(atob(key), c => c.charCodeAt(0)).buffer },
  // As browsers serialize it, expirationTime included.
  toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BP", auth: "AA" } }),
  unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
});

describe("browser push", () => {
  let current: FakeSubscription | null;
  let subscribe: Mock<() => Promise<FakeSubscription>>;
  let registerNotificationDevice: Mock<(registration: WebPushSubscription) => Promise<void>>;
  let api: RpcStub<AuthenticatedApi>;

  beforeEach(() => {
    current = null;
    subscribe = vi.fn<() => Promise<FakeSubscription>>(
      async () => (current ??= fakeSubscription(ENDPOINT)));
    let pushManager = { getSubscription: async () => current, subscribe };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      register: async () => ({}),
      ready: Promise.resolve({ pushManager }),
      getRegistration: async () => ({ pushManager }),
    } });
    // One transition at a time, as Web Locks grants them.
    let held: Promise<unknown> = Promise.resolve();
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: (_name: string, transition: () => Promise<unknown>) =>
        (held = held.catch(() => {}).then(transition)),
    } });
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: async () => "granted" });
    registerNotificationDevice = vi.fn<(registration: WebPushSubscription) => Promise<void>>(
      async () => {});
    api = { registerNotificationDevice } as unknown as RpcStub<AuthenticatedApi>;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("registers only the fields the service accepts and records the owner", async () => {
    await expect(enableBrowserPush(api, "alice", KEY)).resolves.toBe("granted");

    expect(registerNotificationDevice.mock.calls).toEqual(
      [[{ endpoint: ENDPOINT, keys: { p256dh: "BP", auth: "AA" } }]]);
    await expect(browserPushEnabled("alice")).resolves.toBe(true);
    await expect(browserPushEnabled("bob")).resolves.toBe(false);
  });

  it("leaves no subscription behind when registration fails", async () => {
    registerNotificationDevice.mockRejectedValue(new Error("offline"));

    await expect(enableBrowserPush(api, "alice", KEY)).rejects.toThrow("offline");

    expect(current!.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
  });

  it("keeps a subscription another tab enabled when registering it again fails", async () => {
    current = fakeSubscription(ENDPOINT);
    localStorage.setItem(OWNER_KEY, "alice");
    registerNotificationDevice.mockRejectedValue(new Error("offline"));

    await expect(enableBrowserPush(api, "alice", KEY)).rejects.toThrow("offline");

    expect(current.unsubscribe).not.toHaveBeenCalled();
    await expect(browserPushEnabled("alice")).resolves.toBe(true);
  });

  it("drops another account's subscription without registering it", async () => {
    current = fakeSubscription("https://fcm.googleapis.com/wp/alice");
    localStorage.setItem(OWNER_KEY, "alice");

    await syncBrowserPush(api, "bob", KEY);

    expect(current.unsubscribe).toHaveBeenCalled();
    expect(registerNotificationDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
  });

  it("registers the signed-in user's own subscription again", async () => {
    current = fakeSubscription(ENDPOINT);
    localStorage.setItem(OWNER_KEY, "alice");

    await syncBrowserPush(api, "alice", KEY);

    expect(current.unsubscribe).not.toHaveBeenCalled();
    expect(registerNotificationDevice.mock.calls).toEqual(
      [[{ endpoint: ENDPOINT, keys: { p256dh: "BP", auth: "AA" } }]]);
  });

  it("replaces the user's subscription made with a key the deployment no longer advertises", async () => {
    let stale = current = fakeSubscription("https://fcm.googleapis.com/wp/stale", "BOld");
    stale.unsubscribe.mockImplementation(async () => {
      current = null;
      return true;
    });
    localStorage.setItem(OWNER_KEY, "alice");

    await syncBrowserPush(api, "alice", KEY);

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(registerNotificationDevice.mock.calls).toEqual(
      [[{ endpoint: ENDPOINT, keys: { p256dh: "BP", auth: "AA" } }]]);
  });

  it("subscribes again at the next sign-in after replacing the subscription failed", async () => {
    let stale = current = fakeSubscription("https://fcm.googleapis.com/wp/stale", "BOld");
    stale.unsubscribe.mockImplementation(async () => {
      current = null;
      return true;
    });
    localStorage.setItem(OWNER_KEY, "alice");
    subscribe.mockRejectedValueOnce(new Error("push service unavailable"));

    await expect(syncBrowserPush(api, "alice", KEY)).rejects.toThrow("push service unavailable");
    await syncBrowserPush(api, "alice", KEY);

    expect(registerNotificationDevice.mock.calls).toEqual(
      [[{ endpoint: ENDPOINT, keys: { p256dh: "BP", auth: "AA" } }]]);
    await expect(browserPushEnabled("alice")).resolves.toBe(true);
  });

  it("unsubscribes at once rather than behind a registration in flight", async () => {
    current = fakeSubscription(ENDPOINT);
    localStorage.setItem(OWNER_KEY, "alice");
    let register!: () => void;
    registerNotificationDevice.mockReturnValue(new Promise(resolve => { register = resolve; }));
    let sync = syncBrowserPush(api, "alice", KEY);
    await vi.waitFor(() => expect(registerNotificationDevice).toHaveBeenCalled());

    let disabled = disableBrowserPush();
    await vi.waitFor(() => expect(current!.unsubscribe).toHaveBeenCalled());
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();

    register();
    await Promise.all([sync, disabled]);
  });
});
