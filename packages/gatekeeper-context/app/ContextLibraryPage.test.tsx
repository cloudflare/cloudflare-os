// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContextApi,
  ContextCollectionMetadata,
  ContextDocument,
  ContextDocumentSummary,
} from "../src/context-types";
import { AppLocationProvider, ContextApiProvider, createAppLocation, type NavigateAppPath } from "./bridge";
import ContextLibraryPage from "./ContextLibraryPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const updated = new Date(0);

const metadata: ContextCollectionMetadata = {
  id: "c1",
  title: "Runbooks",
  description: "",
  visibility: "private",
  created: updated,
  lastUpdated: updated,
  documentCount: 2,
  content: { source: "web" },
};

const summary = (path: string): ContextDocumentSummary => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  description: "",
  contentType: "text/markdown",
  lastUpdated: updated,
});

const contextDocument = (path: string): ContextDocument => ({
  ...summary(path),
  body: `# Body of ${path}`,
});

// A web collection "c1" the viewer can edit, holding a nested document and a root one.
class FakeContextApi {
  readonly #docs = new Map([
    ["guides/setup.md", contextDocument("guides/setup.md")],
    ["other.md", contextDocument("other.md")],
  ]);

  constructor(readonly collectionExists = true) {}

  getContextCollectionMetadata = vi.fn<ContextApi["getContextCollectionMetadata"]>(
    async () => this.collectionExists ? metadata : null);
  listContextDocuments = vi.fn<ContextApi["listContextDocuments"]>(
    async () => [...this.#docs.keys()].map(summary));
  getContextCollectionPermissions = vi.fn<ContextApi["getContextCollectionPermissions"]>(async () => ({
    canEdit: true, canShare: true, canManageOwners: true, canDelete: true,
  }));
  getViewerInfo = vi.fn<ContextApi["getViewerInfo"]>(
    async () => ({ isAdmin: false, supportsGitCollections: false }));
  getContextCollectionSharing = vi.fn<ContextApi["getContextCollectionSharing"]>(
    async () => ({ members: [], everyoneCanView: false, hasOwner: true }));
  getContextDocument = vi.fn<ContextApi["getContextDocument"]>(
    async (_collectionId, path) => this.#docs.get(path) ?? null);
  moveContextDocument = vi.fn<ContextApi["moveContextDocument"]>(async (_collectionId, from, to) => {
    const moved = this.#docs.get(from);
    this.#docs.delete(from);
    if (moved) this.#docs.set(to, { ...moved, path: to });
  });
}

describe("ContextLibraryPage deep links", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
  });

  async function render(api: FakeContextApi, path: string | null) {
    const navigate = vi.fn<NavigateAppPath>(async () => {});
    const appLocation = createAppLocation(navigate);
    if (path !== null) appLocation.setPath(path);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ContextApiProvider value={api as unknown as RpcStub<ContextApi>}>
        <AppLocationProvider value={appLocation}>
          <TooltipProvider>
            <Toasty>
              <ContextLibraryPage />
            </Toasty>
          </TooltipProvider>
        </AppLocationProvider>
      </ContextApiProvider>,
    ));
    return { navigate, appLocation };
  }

  const text = () => container!.textContent ?? "";

  function button(label: string): HTMLButtonElement {
    const match = [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button "${label}"`);
    return match;
  }

  // A file row in the tree, found by its file name.
  function fileRow(name: string): HTMLElement {
    const label = [...container!.querySelectorAll("span")].find((span) => span.textContent === name);
    if (!label?.parentElement) throw new Error(`Missing file row "${name}"`);
    return label.parentElement;
  }

  it("waits for the host's first path before showing anything", async () => {
    const api = new FakeContextApi();
    const { appLocation } = await render(api, null);
    expect(text()).toBe("");
    expect(api.getContextCollectionMetadata).not.toHaveBeenCalled();
    await act(async () => appLocation.setPath("/collections/c1"));
    await vi.waitFor(() => expect(text()).toContain("Runbooks"));
  });

  it("opens a nested document from its path and expands the folders above it", async () => {
    const api = new FakeContextApi();
    await render(api, "/collections/c1/files/guides/setup.md");
    await vi.waitFor(() => expect(text()).toContain("Body of guides/setup.md"));
    expect(api.getContextDocument).toHaveBeenCalledWith("c1", "guides/setup.md");
    // The tree row only renders inside an expanded "guides" folder.
    expect(fileRow("setup.md")).toBeTruthy();
  });

  it("asks the host to navigate rather than selecting locally, and follows the host's path", async () => {
    const api = new FakeContextApi();
    const { navigate, appLocation } = await render(api, "/collections/c1/files/guides/setup.md");
    await vi.waitFor(() => expect(text()).toContain("Body of guides/setup.md"));

    await act(async () => fileRow("other.md").click());
    expect(navigate).toHaveBeenLastCalledWith("/collections/c1/files/other.md", { replace: false });
    // Nothing changes until the host commits the path.
    expect(text()).toContain("Body of guides/setup.md");

    // Back/Forward arrive as host paths and never echo a navigation back.
    navigate.mockClear();
    await act(async () => appLocation.setPath("/collections/c1/files/other.md"));
    await vi.waitFor(() => expect(text()).toContain("Body of other.md"));
    await act(async () => appLocation.setPath("/collections/c1"));
    await vi.waitFor(() => expect(text()).not.toContain("Body of other.md"));
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => button("Context & Skills").click());
    expect(navigate).toHaveBeenLastCalledWith("/", { replace: false });
  });

  it("replaces the entry when renaming the open document, so Back skips the stale path", async () => {
    const api = new FakeContextApi();
    const { navigate } = await render(api, "/collections/c1/files/other.md");
    await vi.waitFor(() => expect(text()).toContain("Body of other.md"));

    const title = container!.querySelector<HTMLInputElement>('input[value="other.md"]');
    if (!title) throw new Error("Missing document title");
    await act(async () => {
      title.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "renamed.md");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => title.blur());
    await vi.waitFor(() => expect(api.moveContextDocument).toHaveBeenCalledWith("c1", "other.md", "renamed.md"));
    expect(navigate).toHaveBeenLastCalledWith("/collections/c1/files/renamed.md", { replace: true });
  });

  it("shows a missing document as unavailable, not as an empty file", async () => {
    const api = new FakeContextApi();
    const { navigate } = await render(api, "/collections/c1/files/gone.md");
    await vi.waitFor(() => expect(text()).toContain("This document is unavailable"));
    expect(container!.querySelector('input[value="gone.md"]')).toBeNull();
    await act(async () => button("Back to collection").click());
    expect(navigate).toHaveBeenLastCalledWith("/collections/c1", { replace: true });
  });

  it("shows a missing or inaccessible collection as unavailable", async () => {
    const api = new FakeContextApi(false);
    const { navigate } = await render(api, "/collections/c1/files/guides/setup.md");
    await vi.waitFor(() => expect(text()).toContain("This collection is unavailable"));
    await act(async () => button("Context & Skills").click());
    expect(navigate).toHaveBeenLastCalledWith("/", { replace: true });
  });

  it("reads nothing for a malformed path", async () => {
    const api = new FakeContextApi();
    const { navigate } = await render(api, "/collections/c1/files/../secret.md");
    expect(text()).toContain("This page doesn't exist");
    expect(api.getContextCollectionMetadata).not.toHaveBeenCalled();
    expect(api.getContextDocument).not.toHaveBeenCalled();
    await act(async () => button("Context & Skills").click());
    expect(navigate).toHaveBeenLastCalledWith("/", { replace: true });
  });
});
