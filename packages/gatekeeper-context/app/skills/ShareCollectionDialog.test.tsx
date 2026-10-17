// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextApi, ContextCollectionSharing } from "../../src/context-types";
import type { SelectUsers, UserSelectionReceiver } from "../bridge";
import { ShareCollectionDialog } from "./ShareCollectionDialog";

const mocks = vi.hoisted(() => ({
  api: null as ContextApi | null,
  selectUsers: null as SelectUsers | null,
}));

vi.mock("../bridge", () => ({
  useContextApi: () => mocks.api,
  useSelectUsers: () => mocks.selectUsers,
}));

vi.mock("./useMutationDialog", () => ({
  useMutationDialog: () => ({
    open: true,
    requestClose: () => {},
    closeAfterSuccess: () => {},
    onOpenChangeComplete: () => {},
  }),
}));

// jsdom lacks PointerEvent, which Kumo's Base UI controls dispatch.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, PointerEvent: MouseEvent });

const sharing: ContextCollectionSharing = {
  members: [{ memberId: "me", role: "owner", displayName: "Ada", isViewer: true }],
  everyoneCanView: false,
  hasOwner: true,
};

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === label);

describe("ShareCollectionDialog", () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    document.body.replaceChildren();
  });

  it("delivers picks with the role chosen when the picker opened and surfaces backend refusals", async () => {
    const shareContextCollection = vi.fn<ContextApi["shareContextCollection"]>(async (_id, ticket) => {
      if (ticket === "refused") throw new Error("They have no Context account yet.");
    });
    mocks.api = {
      getContextCollectionSharing: async () => sharing,
      getContextCollectionPermissions: async () => ({
        canEdit: true,
        canShare: true,
        canManageOwners: true,
        canDelete: true,
      }),
      shareContextCollection,
    } as unknown as ContextApi;
    let receiver: UserSelectionReceiver | undefined;
    let closePicker: (() => void) | undefined;
    mocks.selectUsers = vi.fn<SelectUsers>((picked) => {
      receiver = picked;
      return new Promise<void>((resolve) => { closePicker = resolve; });
    });

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ShareCollectionDialog
          collection={{ id: "collection", title: "Engineering" }}
          onChanged={() => {}}
          onLeft={() => {}}
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => button("Select users")?.click());
    expect(receiver).toBeDefined();

    // Change the role control while the picker is still open.
    const roleTrigger = [...document.querySelectorAll<HTMLElement>("button")]
      .find((candidate) => candidate.textContent?.includes("Viewer"));
    await act(async () => {
      roleTrigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      roleTrigger?.click();
    });
    const editorOption = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((option) => option.textContent === "Editor");
    expect(editorOption).toBeDefined();
    await act(async () => {
      editorOption?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      editorOption?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      editorOption?.click();
    });

    await act(async () => receiver!.receive({ ticket: "accepted" }));
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "accepted", "viewer");

    await expect(receiver!.receive({ ticket: "refused" }))
      .rejects.toThrow("They have no Context account yet.");
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "refused", "viewer");

    await act(async () => closePicker?.());
  });
});
