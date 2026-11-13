// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import type { AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findChatActions, findOtherToggle } from "./chatListFocus";
import { chatListViewStorageKey } from "./chatListViewStore";
import { useChatOrganizer, type ChatOrganizer } from "./useChatOrganizer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: number, extra: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(id), ...extra });

const fakeOverseer = () => ({
  setChatPlacement: vi.fn<Overseer["setChatPlacement"]>(async () => {}),
  renameChatFolder: vi.fn<Overseer["renameChatFolder"]>(async () => {}),
});

// The view store keeps each key's view for the session, so each test uses keys of its own.
let workspaces = 0;
const freshKey = () => chatListViewStorageKey("user-1", `workspace-${++workspaces}`);

const roots: Root[] = [];
let toastTitles: string[] = [];

let showChats: (chats: AiChatMetadata[]) => void = () => {};

// Mounts the hook over `chats`, which showChats() replaces the way the list's metadata does, and
// returns a getter for its latest value. Rows render as in a list whose Other is hidden, re-created
// when a chat moves.
const mount = (viewStorageKey: string | null, overseer = fakeOverseer(), chats: AiChatMetadata[] = []) => {
  let latest: ChatOrganizer | undefined;
  const Probe = () => {
    const [shown, setShown] = useState(chats);
    showChats = setShown;
    latest = useChatOrganizer(overseer as unknown as RpcStub<Overseer>, shown, viewStorageKey);
    toastTitles = useKumoToastManager().toasts.map((toast) => String(toast.title));
    return (
      <>
        {shown.filter((row) => row.pinned || row.folder !== undefined).map((row) => (
          <button
            key={`${row.id}:${row.pinned}:${row.folder}`}
            aria-label={`Actions for ${row.title}`}
            data-chat-actions={row.id}
          />
        ))}
        <button data-chat-other-toggle>Other</button>
      </>
    );
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  act(() => root.render(<Toasty><Probe /></Toasty>));
  return () => latest!;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  toastTitles = [];
});

describe("useChatOrganizer", () => {
  it("moves a pinned chat into a folder out of Pinned, opening the folder", async () => {
    const overseer = fakeOverseer();
    const organizer = mount(freshKey(), overseer);
    act(() => organizer().toggleFolder("Vendors"));
    expect(organizer().view.collapsedFolders).toEqual(["Vendors"]);

    await act(() => organizer().moveToFolder(chat(2, { pinned: true }), "Vendors"));

    expect(overseer.setChatPlacement).toHaveBeenCalledExactlyOnceWith(
      2, { folder: "Vendors", pinned: false });
    expect(organizer().view.collapsedFolders).toEqual([]);
  });

  it("names a new folder for a chat, and makes none for a blank name", async () => {
    const overseer = fakeOverseer();
    const organizer = mount(freshKey(), overseer);

    act(() => organizer().startNewFolder(chat(3)));
    expect(organizer().newFolderFor?.id).toBe(3);
    await act(() => organizer().finishNaming("   "));
    expect(organizer().newFolderFor).toBeNull();
    expect(overseer.setChatPlacement).not.toHaveBeenCalled();

    act(() => organizer().startNewFolder(chat(3)));
    await act(() => organizer().finishNaming(" Board deck "));
    // A chat that wasn't pinned isn't unpinned, so the change can't undo someone else's pin.
    expect(overseer.setChatPlacement).toHaveBeenCalledExactlyOnceWith(3, { folder: "Board deck" });
  });

  it("renames a folder for everyone, keeping it collapsed for this person", async () => {
    const overseer = fakeOverseer();
    const organizer = mount(freshKey(), overseer);
    act(() => organizer().toggleFolder("Board deck"));

    act(() => organizer().startRenamingFolder("Board deck"));
    expect(organizer().renamingFolder).toBe("Board deck");
    await act(() => organizer().finishNaming("Board deck"));
    expect(overseer.renameChatFolder).not.toHaveBeenCalled();

    act(() => organizer().startRenamingFolder("Board deck"));
    await act(() => organizer().finishNaming("Investor deck"));
    expect(overseer.renameChatFolder).toHaveBeenCalledWith("Board deck", "Investor deck");
    expect(organizer().view.collapsedFolders).toEqual(["Investor deck"]);
  });

  it("focuses a moved chat once the list shows it there, or else Other's toggle", async () => {
    const overseer = fakeOverseer();
    const organizer = mount(freshKey(), overseer, [chat(1)]);

    // The change resolves before the list's metadata shows it.
    await act(() => organizer().pin(1));
    expect(findChatActions(1)).toBeNull();
    act(() => showChats([chat(1, { pinned: true })]));
    expect(document.activeElement).toBe(findChatActions(1));

    // Or the metadata comes first, and the chat goes into a hidden Other.
    overseer.setChatPlacement.mockImplementation(async () => showChats([chat(1)]));
    await act(() => organizer().unpin(1));
    expect(document.activeElement).toBe(findOtherToggle());
  });

  it("keeps a folder collapsed under its old name when renaming it fails", async () => {
    const overseer = fakeOverseer();
    overseer.renameChatFolder.mockRejectedValue(new Error("Unauthorized"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const organizer = mount(freshKey(), overseer);
    act(() => organizer().toggleFolder("Board deck"));

    act(() => organizer().startRenamingFolder("Board deck"));
    await act(() => organizer().finishNaming("Investor deck"));

    expect(organizer().view.collapsedFolders).toEqual(["Board deck"]);
  });

  it("says so when a change fails", async () => {
    const overseer = fakeOverseer();
    overseer.setChatPlacement.mockRejectedValue(new Error("Unauthorized"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const organizer = mount(freshKey(), overseer);

    await act(() => organizer().pin(1));

    expect(toastTitles).toEqual(["Couldn't pin the conversation"]);
  });

  it("keeps each person's collapsed parts per workspace, even when they can't be saved", () => {
    const key = freshKey();
    const first = mount(key);
    const second = mount(key);
    const otherWorkspace = mount(freshKey());

    act(() => first().setOtherHidden(true));
    expect(second().view.otherHidden).toBe(true);
    expect(otherWorkspace().view.otherHidden).toBe(false);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    act(() => first().toggleFolder("Vendors"));
    expect(second().view.collapsedFolders).toEqual(["Vendors"]);
  });

  it("collapses nothing until it knows whose list it is", () => {
    const organizer = mount(null);
    act(() => {
      organizer().toggleFolder("Vendors");
      organizer().setOtherHidden(true);
    });
    expect(organizer().view).toEqual({ collapsedFolders: [], otherHidden: false });
    expect(localStorage.length).toBe(0);
  });
});
