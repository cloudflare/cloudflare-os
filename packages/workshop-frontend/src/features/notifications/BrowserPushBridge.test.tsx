// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPushBridge } from "./BrowserPushBridge";

const { router, syncBrowserPush } = vi.hoisted(() => ({
  router: { navigate: vi.fn<(options: object) => Promise<void>>() },
  syncBrowserPush: vi.fn<(api: object, userId: string, publicKey: string) => Promise<void>>(),
}));
let auth: { authenticatedApi: object; currentUser: { id: string } | null; isCurrentUserConfirmed: boolean };
let webPushPublicKey: string;

vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => auth }));
vi.mock("../../ServerConfigContext", () => ({ useServerConfig: () => ({ webPushPublicKey }) }));
vi.mock("./browserPush", () => ({ browserPushSupport: () => "supported", syncBrowserPush }));

describe("BrowserPushBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let serviceWorker: EventTarget;

  const render = (next: typeof auth) => act(async () => {
    auth = next;
    root.render(<BrowserPushBridge />);
  });

  beforeEach(() => {
    router.navigate.mockReset();
    syncBrowserPush.mockReset().mockResolvedValue();
    webPushPublicKey = "BKey";
    serviceWorker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("syncs only a user the current connection confirmed, once across reconnects", async () => {
    let alice = { id: "alice" };
    let [first, second] = [{}, {}];
    // A reconnecting API still shows the previous connection's user.
    await render({ authenticatedApi: first, currentUser: alice, isCurrentUserConfirmed: false });
    expect(syncBrowserPush).not.toHaveBeenCalled();

    await render({ authenticatedApi: first, currentUser: alice, isCurrentUserConfirmed: true });
    await render({ authenticatedApi: second, currentUser: alice, isCurrentUserConfirmed: false });
    await render({ authenticatedApi: second, currentUser: alice, isCurrentUserConfirmed: true });
    expect(syncBrowserPush.mock.calls).toEqual([[first, "alice", "BKey"]]);
  });

  it("retries a failed sync on the next reconnect", async () => {
    let alice = { id: "alice" };
    let [first, second] = [{}, {}];
    syncBrowserPush.mockRejectedValueOnce(new Error("connection lost"));
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});

    await render({ authenticatedApi: first, currentUser: alice, isCurrentUserConfirmed: true });
    await render({ authenticatedApi: second, currentUser: alice, isCurrentUserConfirmed: true });
    expect(syncBrowserPush.mock.calls).toEqual([[first, "alice", "BKey"], [second, "alice", "BKey"]]);
  });

  it("syncs again when a reconnect brings a new key", async () => {
    let alice = { id: "alice" };
    let [first, second] = [{}, {}];
    await render({ authenticatedApi: first, currentUser: alice, isCurrentUserConfirmed: true });
    webPushPublicKey = "BNew";
    await render({ authenticatedApi: second, currentUser: alice, isCurrentUserConfirmed: true });
    expect(syncBrowserPush.mock.calls).toEqual([[first, "alice", "BKey"], [second, "alice", "BNew"]]);
  });

  it("opens the chat a clicked notification names", async () => {
    await render({ authenticatedApi: {}, currentUser: null, isCurrentUserConfirmed: false });

    let path = "/workspace/w1?chat=3&showChat=true";
    serviceWorker.dispatchEvent(new MessageEvent("message",
      { data: { type: "cloudflare-os:open-notification", path } }));

    expect(router.navigate).toHaveBeenCalledWith({ href: path });
  });
});
