// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import type * as Kumo from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "./NotificationSettings";

const { enableBrowserPush } = vi.hoisted(() => ({
  enableBrowserPush: vi.fn<(api: object, userId: string, publicKey: string) => Promise<string>>(),
}));
let auth: { authenticatedApi: object; currentUser: { id: string }; isCurrentUserConfirmed: boolean };

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}));
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => auth }));
vi.mock("../../ServerConfigContext", () => ({
  useServerConfig: () => ({ webPushPublicKey: "BKey" }),
}));
vi.mock("./browserPush", () => ({
  browserPushSupport: () => "supported",
  browserPushEnabled: async () => false,
  disableBrowserPush: vi.fn<() => Promise<void>>(),
  enableBrowserPush,
}));

let container: HTMLDivElement;
let root: Root;

const render = (next: typeof auth) => act(async () => {
  auth = next;
  root.render(<NotificationSettings />);
});

beforeEach(() => {
  enableBrowserPush.mockReset().mockResolvedValue("granted");
  vi.stubGlobal("Notification", { permission: "default" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("subscribes no one while a reconnect has yet to confirm who is signed in", async () => {
  let alice = { id: "alice" };
  await render({ authenticatedApi: {}, currentUser: alice, isCurrentUserConfirmed: true });
  // Another tab signed in as someone else, and this tab reconnected with that session.
  await render({ authenticatedApi: {}, currentUser: alice, isCurrentUserConfirmed: false });

  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());

  expect(enableBrowserPush).not.toHaveBeenCalled();
});
