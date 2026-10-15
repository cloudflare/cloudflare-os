// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextApi, ContextCollectionMetadata } from "../../src/context-types";
import { DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { EditCollectionDialog } from "./EditCollectionDialog";

const mocks = vi.hoisted(() => ({ api: null as ContextApi | null }));

vi.mock("../bridge", () => ({
  useContextApi: () => mocks.api,
  useResolvedThemeMode: () => "light",
}));

vi.mock("./useMutationDialog", () => ({
  useMutationDialog: () => ({
    open: true,
    requestClose: () => {},
    closeAfterSuccess: () => {},
    onOpenChangeComplete: () => {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.PointerEvent = MouseEvent as typeof PointerEvent;

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.includes(label));

const radio = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  .find((candidate) => candidate.closest("label")?.textContent?.includes(label));

describe("collection dialogs", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    document.body.replaceChildren();
  });

  const render = (node: React.ReactNode) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Toasty>{node}</Toasty>));
  };

  it("creates public Git collections for admins", async () => {
    const createdCollection: ContextCollectionMetadata = {
      id: "created",
      title: "Engineering",
      description: "",
      visibility: "public",
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: {
        source: "git",
        remote: "https://artifacts.example/created",
        branch: "main",
        lastRefreshedAt: new Date(),
      },
    };
    const createContextCollection = vi.fn<ContextApi["createContextCollection"]>(
      async () => createdCollection,
    );
    const createContextCollectionGitToken = vi.fn<ContextApi["createContextCollectionGitToken"]>(
      async () => ({
        id: "token",
        plaintext: "secret",
        remote: "https://artifacts.example/created",
      }),
    );
    mocks.api = {
      createContextCollection,
      createContextCollectionGitToken,
    } as unknown as ContextApi;
    render(
      <CreateCollectionDialog
        viewerInfo={{ isAdmin: true, supportsGitCollections: true }}
        onCreated={() => {}}
        onClose={() => {}}
      />,
    );

    act(() => {
      setInputValue(document.querySelector<HTMLInputElement>(
        'input[placeholder^="A short name"]',
      )!, "Engineering");
    });
    act(() => radio("Git mirror")?.click());
    act(() => radio("Everyone")?.click());
    await act(async () => {
      button("Add collection")?.click();
      await Promise.resolve();
    });

    expect(createContextCollection).toHaveBeenCalledWith(
      "Engineering",
      "",
      "public",
      DEFAULT_COLLECTION_ICON,
      "git",
    );
    expect(createContextCollectionGitToken).toHaveBeenCalledWith("created");
    expect(document.body.textContent).toContain("Set up the mirror");
    expect(document.body.textContent).toContain("you do not enter a source repository URL here");
  });

  it("updates a Git branch and exposes token management", async () => {
    const updateContextCollection = vi.fn<ContextApi["updateContextCollection"]>(async () => {});
    mocks.api = {
      updateContextCollection,
      listContextCollectionGitTokens: async () => ({ tokens: [] }),
    } as unknown as ContextApi;
    const collection: ContextCollectionMetadata = {
      id: "collection",
      title: "Engineering",
      description: "",
      visibility: "private",
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: {
        source: "git",
        remote: "",
        branch: "main",
        lastRefreshedAt: new Date(),
      },
    };
    render(
      <EditCollectionDialog
        collection={collection}
        supportsGitCollections
        onUpdated={() => {}}
        onClose={() => {}}
      />,
    );
    await act(async () => Promise.resolve());
    expect(button("Create token")).toBeDefined();

    act(() => setInputValue(document.querySelector<HTMLInputElement>('input[value="main"]')!, "release"));
    await act(async () => {
      button("Save changes")?.click();
      await Promise.resolve();
    });

    expect(updateContextCollection).toHaveBeenCalledWith("collection", { branch: "release" });
  });
});
