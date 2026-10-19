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
  closeDialog: null as (() => void) | null,
}));

vi.mock("../bridge", () => ({
  useContextApi: () => mocks.api,
  useSelectUsers: () => mocks.selectUsers,
}));

vi.mock("./useMutationDialog", () => ({
  useMutationDialog: (_busy: boolean, onClosed: () => void) => {
    mocks.closeDialog = onClosed;
    return {
      open: true,
      requestClose: () => {},
      closeAfterSuccess: () => {},
      onOpenChangeComplete: () => {},
    };
  },
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

const choose = async (trigger: HTMLElement | null | undefined, label: string) => {
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger?.click();
  });
  const option = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
    .find((candidate) => candidate.textContent === label);
  expect(option).toBeDefined();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    option?.click();
  });
};

const ownerPermissions = { canEdit: true, canShare: true, canManageOwners: true, canDelete: true };
const twoOwners: ContextCollectionSharing = {
  members: [
    { memberId: "me", role: "owner", displayName: "Ada", isViewer: true },
    { memberId: "bob", role: "owner", displayName: "Bob", isViewer: false },
  ],
  everyoneCanView: false,
  hasOwner: true,
};

const renderDialog = async (onChanged: () => void = () => {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  await act(async () => {
    created.render(
      <ShareCollectionDialog
        collection={{ id: "collection", title: "Engineering" }}
        onChanged={onChanged}
        onLeft={() => {}}
        onClose={() => {}}
      />,
    );
    await Promise.resolve();
  });
  return created;
};

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

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

  it("stops granting owner once the viewer can no longer manage owners", async () => {
    let permissions = ownerPermissions;
    const shareContextCollection = vi.fn<ContextApi["shareContextCollection"]>(async () => {});
    mocks.api = {
      getContextCollectionSharing: async () => twoOwners,
      getContextCollectionPermissions: async () => permissions,
      setContextCollectionMemberRole: async () => {
        permissions = { ...ownerPermissions, canManageOwners: false };
      },
      shareContextCollection,
    } as unknown as ContextApi;
    let receiver: UserSelectionReceiver | undefined;
    mocks.selectUsers = vi.fn<SelectUsers>(async (picked) => { receiver = picked; });
    root = await renderDialog();

    const addRole = () => document.querySelector<HTMLElement>("[aria-label='Role for users you add']");
    await choose(addRole(), "Owner");
    expect(addRole()?.textContent).toContain("Owner");

    await choose(document.querySelector<HTMLElement>("[aria-label='Role for you']"), "Can edit");
    await flush();
    expect(addRole()?.textContent).toContain("Editor");

    await act(async () => button("Select users")?.click());
    await receiver!.receive({ ticket: "picked" });
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "picked", "editor");
  });

  it("reports possibly committed rejections on close and surfaces failed refreshes", async () => {
    let loads = 0;
    const getContextCollectionSharing = vi.fn(async () => {
      loads += 1;
      if (loads === 2) throw new Error("Network down.");
      return twoOwners;
    });
    mocks.api = {
      getContextCollectionSharing,
      getContextCollectionPermissions: async () => ownerPermissions,
      setContextCollectionMemberRole: async () => {
        throw new Error("Access was changed, but Git tokens could not be revoked yet.");
      },
    } as unknown as ContextApi;
    const onChanged = vi.fn();
    root = await renderDialog(onChanged);

    await choose(document.querySelector<HTMLElement>("[aria-label='Role for Bob']"), "Can edit");
    await flush();
    expect(document.body.textContent).toContain("Git tokens could not be revoked yet");
    expect(document.body.textContent).toContain("Network down.");
    expect(document.body.textContent).toContain("Bob");

    await act(async () => button("Retry")?.click());
    await flush();
    expect(getContextCollectionSharing).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("Network down.");

    act(() => mocks.closeDialog?.());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
