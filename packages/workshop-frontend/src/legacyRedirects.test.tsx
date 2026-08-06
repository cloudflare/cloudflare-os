// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Route as GadgetRedirectRouteImport } from "./routes/gadget.$id";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom doesn't implement scrolling; the router's hash scroll restoration calls it on mount.
window.scrollTo = () => {};

// Exercises the real legacy-route module (routes/gadget.$id.tsx) against a stub /workspace/$id
// target, the same way routeTree.gen.ts wires it into the app's router. The stub avoids
// rendering the heavyweight editor; only the redirect behavior is under test.
function makeRouter(initialEntry: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace/$id",
    component: () => null,
  });
  const gadgetRoute = GadgetRedirectRouteImport.update({
    id: "/gadget/$id",
    path: "/gadget/$id",
    getParentRoute: () => rootRoute,
  } as never);
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  return createRouter({
    history,
    routeTree: rootRoute.addChildren([workspaceRoute, gadgetRoute]),
  });
}

describe("legacy workspace URL redirects", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  async function renderAt(initialEntry: string) {
    const router = makeRouter(initialEntry);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
  }

  it("redirects /gadget/$id to /workspace/$id preserving search and hash", async () => {
    const router = await renderAt("/gadget/my-workspace?chat=5&other=thing#share=abc123");

    expect(router.state.location.pathname).toBe("/workspace/my-workspace");
    expect(router.state.location.search).toEqual({ chat: 5, other: "thing" });
    expect(router.state.location.hash).toBe("share=abc123");
    // The redirect replaces the legacy entry, so Back doesn't bounce off it.
    expect(router.history.length).toBe(1);
  });

  it("redirects a bare /gadget/$id without search or hash", async () => {
    const router = await renderAt("/gadget/my-workspace");

    expect(router.state.location.pathname).toBe("/workspace/my-workspace");
    expect(router.state.location.search).toEqual({});
    expect(router.state.location.hash).toBe("");
  });

});
