// @ts-expect-error node builtin without @types/node
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_PATH } from "../../connectHandoff";

// public/sw.js is served as is, so it runs here against a stand-in for its global scope.
const SOURCE = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const PATH = "/workspace/w1?chat=3&showChat=true";

type WindowClient = {
  url: string;
  focus: () => Promise<void>;
  postMessage: (message: unknown) => void;
};
type Scope = {
  registration: { showNotification: (title: string, options: object) => Promise<void> };
  clients: { matchAll: () => Promise<WindowClient[]>; openWindow: (url: string) => Promise<null> };
};

describe("service worker", () => {
  let listeners: Map<string, (event: object) => void>;
  let windows: WindowClient[];
  let scope: Scope;

  // Dispatches an event and waits for the work it hands to waitUntil().
  const dispatch = async (type: string, event: object) => {
    let work: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work);
  };
  const push = (text: string) => dispatch("push", { data: { json: () => JSON.parse(text) } });
  const click = () => dispatch("notificationclick",
    { notification: { close: vi.fn<() => void>(), data: { path: PATH } } });
  const windowAt = (path: string) => ({
    url: `https://os.example${path}`,
    focus: vi.fn<WindowClient["focus"]>(async () => {}),
    postMessage: vi.fn<WindowClient["postMessage"]>(),
  });

  beforeEach(() => {
    listeners = new Map();
    windows = [];
    scope = {
      registration: {
        showNotification: vi.fn<Scope["registration"]["showNotification"]>(async () => {}),
      },
      clients: {
        matchAll: vi.fn<Scope["clients"]["matchAll"]>(async () => windows),
        openWindow: vi.fn<Scope["clients"]["openWindow"]>(async () => null),
      },
    };
    new Function("self", SOURCE)({
      ...scope,
      location: { origin: "https://os.example" },
      addEventListener: (type: string, listener: (event: object) => void) =>
        listeners.set(type, listener),
    });
  });

  it("shows the notification a push carries", async () => {
    await push(JSON.stringify(
      { title: "Cloudflare OS", body: "Build the demo is complete.", path: PATH, tag: "t1" }));

    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      "Cloudflare OS", { body: "Build the demo is complete.", tag: "t1", data: { path: PATH } });
  });

  it("still shows a notification for a push it can't read", async () => {
    await push("Test push message from DevTools.");

    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      "Cloudflare OS", expect.objectContaining({ data: { path: "/" } }));
  });

  it.each([
    ["another origin", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash path that URL parsing reads as protocol-relative", "/\\evil.example/x"],
    ["no path", undefined],
  ])("keeps a click on this origin when a push names %s", async (_case, path) => {
    await push(JSON.stringify({ title: "Cloudflare OS", path }));

    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      "Cloudflare OS", expect.objectContaining({ data: { path: "/" } }));
  });

  it("brings an open window forward to open the chat", async () => {
    let client = windowAt("/");
    windows = [client];

    await click();

    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(
      { type: "cloudflare-os:open-notification", path: PATH });
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["a connect popup left open", HANDOFF_PATH],
    ["the sign-up page", "/signup"],
  ])("passes over %s, to the Workshop window behind it", async (_page, path) => {
    let [standalone, workshop] = [windowAt(path), windowAt("/workspaces")];
    windows = [standalone, workshop];

    await click();

    expect(standalone.focus).not.toHaveBeenCalled();
    expect(workshop.postMessage).toHaveBeenCalledWith(
      { type: "cloudflare-os:open-notification", path: PATH });
  });

  it("opens the chat in a new window when none is open", async () => {
    await click();

    expect(scope.clients.openWindow).toHaveBeenCalledWith(PATH);
  });
});
