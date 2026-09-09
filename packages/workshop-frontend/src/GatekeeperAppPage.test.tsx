// @vitest-environment jsdom

import React, { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperAppInfo } from "@gadgets/workshop-shared/api";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import GatekeeperAppPage from "./GatekeeperAppPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "scrollTo", { value: vi.fn<() => void>(), configurable: true });

const sandboxedGatekeeperApp = vi.hoisted(() => vi.fn<(_props: unknown) => ReactElement>((_props) => React.createElement('div', { 'data-testid': 'gatekeeper-app' })));
const getGatekeeperApp = vi.hoisted(() => vi.fn<(_id: string) => Promise<GatekeeperUiFrame | null>>());
const authenticatedApi = vi.hoisted(() => ({ getGatekeeperApp, listGatekeeperApps: vi.fn<() => Promise<GatekeeperAppInfo[]>>() }));
const appsRef = vi.hoisted(() => ({ current: [] as GatekeeperAppInfo[] }));

vi.mock("./SandboxedGatekeeperApp", () => ({
  default: sandboxedGatekeeperApp,
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

vi.mock("./useGatekeeperApps", async () => {
  const actual = await vi.importActual<typeof import("./useGatekeeperApps")>("./useGatekeeperApps");
  return {
    ...actual,
    useGatekeeperApps: () => appsRef.current,
  };
});

vi.mock("./components/sessions/SessionsContext", () => ({
  useSessionsContext: () => ({ github: { state: "connected" }, prepareSession: vi.fn<(_title: string, _input: unknown) => void>() }),
}));

vi.mock("./errorReporting", () => ({
  reportIssue: vi.fn<(_site: string, _caught: unknown, _metadata?: Record<string, unknown>) => void>(),
}));

function frame(label: string): GatekeeperUiFrame {
  return { iframeHtml: `<!doctype html><title>${label}</title>`, ui: { [Symbol.dispose]: vi.fn<() => void>() } };
}

describe("GatekeeperAppPage Work Items composition", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sandboxedGatekeeperApp.mockClear();
    getGatekeeperApp.mockReset();
    appsRef.current = [];
    authenticatedApi.listGatekeeperApps.mockReset();
  });

  it.each([false, true])("discovers existing sources independently of the nav cache and retries failed loads (%s)", async (failSource) => {
    const shell: GatekeeperAppInfo = { id: "shell", vendorId: "work-items", title: "Work Items", composition: { kind: "work-items" } };
    const jira: GatekeeperAppInfo = { id: "jira", vendorId: "jira", title: "Jira", composition: { kind: "work-items", role: "jira", embeddedOnly: true } };
    authenticatedApi.listGatekeeperApps.mockResolvedValue([shell, jira]);
    const shellFrame = frame("shell");
    const sourceFrame = frame("jira");
    getGatekeeperApp.mockImplementation(async (id) => {
      if (id === "shell") return shellFrame;
      if (failSource) throw new Error("offline");
      return sourceFrame;
    });
    const rootRoute = createRootRoute({ component: () => <GatekeeperAppPage appId="shell" /> });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await vi.waitFor(() => expect(sandboxedGatekeeperApp).toHaveBeenCalled());
    const props = sandboxedGatekeeperApp.mock.lastCall![0] as { dependencies: { capability: unknown; error?: string }[]; onRetryProviders(): void; workItemHandoffs: boolean };
    expect(props.workItemHandoffs).toBe(true);
    expect(props.dependencies).toHaveLength(1);
    expect(props.dependencies[0].error).toEqual(failSource ? "Could not load Jira. Retry, or check its connection in Connectors." : undefined);
    expect(props.dependencies[0].capability).toBe(failSource ? null : sourceFrame.ui);
    getGatekeeperApp.mockImplementation(async (id) => frame(id));
    await act(async () => props.onRetryProviders());
    expect(authenticatedApi.listGatekeeperApps).toHaveBeenCalledTimes(2);
    expect((shellFrame.ui as unknown as Disposable)[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("does not grant Work Items dependencies or handoffs to an impostor shell", async () => {
    const impostor: GatekeeperAppInfo = {
      id: "impostor-shell",
      vendorId: "context",
      title: "Impostor",
      composition: { kind: "work-items" },
    };
    const jira: GatekeeperAppInfo = {
      id: "jira-source",
      vendorId: "jira",
      title: "Jira",
      composition: { kind: "work-items", role: "jira", embeddedOnly: true },
    };
    appsRef.current = [impostor, jira];
    authenticatedApi.listGatekeeperApps.mockResolvedValue(appsRef.current);
    getGatekeeperApp.mockImplementation(async (id) => id === impostor.id ? frame("Impostor") : frame(id));

    const rootRoute = createRootRoute({ component: () => <GatekeeperAppPage appId={impostor.id} /> });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<RouterProvider router={router} />));
    await vi.waitFor(() => expect(sandboxedGatekeeperApp).toHaveBeenCalled());

    expect(getGatekeeperApp).toHaveBeenCalledTimes(1);
    expect(getGatekeeperApp).toHaveBeenCalledWith(impostor.id);
    expect(sandboxedGatekeeperApp).toHaveBeenLastCalledWith(expect.objectContaining({
      gatekeeperVendorId: "context",
      dependencies: [],
      workItemHandoffs: false,
    }), undefined);
  });

  it("loads the frame concurrently and keeps unrelated apps usable when discovery fails", async () => {
    let rejectDiscovery!: (error: Error) => void;
    authenticatedApi.listGatekeeperApps.mockImplementation(() => new Promise((_resolve, reject) => { rejectDiscovery = reject; }));
    const appFrame = frame("context");
    getGatekeeperApp.mockResolvedValue(appFrame);
    const rootRoute = createRootRoute({ component: () => <GatekeeperAppPage appId="context" /> });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/" })]) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await vi.waitFor(() => expect(getGatekeeperApp).toHaveBeenCalledWith("context"));
    await act(async () => rejectDiscovery(new Error("Discovery unavailable")));
    await vi.waitFor(() => expect(sandboxedGatekeeperApp).toHaveBeenLastCalledWith(expect.objectContaining({
      frame: appFrame, dependencies: [], workItemHandoffs: false,
    }), undefined));
    const retry = container.querySelector("button")!;
    expect(retry.textContent).toBe("Retry provider discovery");
    authenticatedApi.listGatekeeperApps.mockResolvedValue([]);
    await act(async () => retry.click());
    expect(authenticatedApi.listGatekeeperApps).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Provider discovery is unavailable");
  });
});
