/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";

const { VENDORS } = vi.hoisted(() => {
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`)}`;
// A full-bleed round mark and a square one: the shapes most likely to be cropped.
const vendors = [
  { vendorId: "confluence", displayName: "Confluence", logo: svg('<rect width="16" height="16" fill="#1868db"/>') },
  { vendorId: "email", displayName: "Email", logo: svg('<rect x="1" y="3" width="14" height="10" fill="none" stroke="#000" stroke-width="1.5"/>') },
  { vendorId: "github", displayName: "GitHub", logo: svg('<circle cx="8" cy="8" r="8" fill="#000"/>') },
  { vendorId: "linear", displayName: "Linear", logo: svg('<circle cx="8" cy="8" r="8" fill="#5e6ad2"/>') },
];
return { VENDORS: vendors };
});
// One API object, as the real context holds: a new one each render would resubscribe forever.
const api = vi.hoisted(() => ({
    subscribeConnectedAccounts: (subscriber: { add(...args: unknown[]): void }) => {
      VENDORS.forEach((v, id) => subscriber.add(id, {}, { displayName: v.displayName, logo: { url: v.logo } }, [], true, v.vendorId));
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} });
    },
}));
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));
import { SidebarConnections } from "./SidebarConnections";

let host: HTMLDivElement | undefined, root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

it("stacks the connected services' logos without covering any, and fans them out on hover", async () => {
  const base = createRootRoute({ component: () => <div className="p-4"><SidebarConnections /></div> });
  const router = createRouter({ routeTree: base, history: createMemoryHistory() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RouterProvider router={router} />));
  const pill = page.getByRole("link");
  await expect.element(pill).toBeVisible();
  await expect.element(pill).toHaveTextContent("+1");
  const tiles = [...pill.element().querySelectorAll("img")].map(img => img.getBoundingClientRect());
  // Each logo starts after the one before it ends: nothing is hidden beneath its neighbour.
  for (let i = 1; i < tiles.length; i++) expect(tiles[i].left).toBeGreaterThanOrEqual(tiles[i - 1].right);
  await userEvent.hover(pill);
  await new Promise(resolve => setTimeout(resolve, 300));
});
