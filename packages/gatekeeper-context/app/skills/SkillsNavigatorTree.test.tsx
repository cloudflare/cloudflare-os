// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { Toasty } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContextApi,
  ContextCollectionMetadata,
  ContextCollectionPermissions,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { ContextApiProvider } from "../bridge";
import type { NavigatorDeleteTarget } from "./DeleteNavigatorNodeDialog";
import type { SkillNavigatorCollection } from "./skillNavigatorModel";
import { SkillsNavigatorTree } from "./SkillsNavigatorTree";
import type { UploadSkillsTarget } from "./UploadSkillsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (
  id: string,
  access: Pick<EnabledCollectionInfo, "source" | "membership">,
): EnabledCollectionInfo => ({
  id,
  title: id,
  description: "",
  lastUpdated: new Date(),
  ...access,
});

const OWNED: Pick<EnabledCollectionInfo, "source" | "membership"> = {
  source: "private",
  membership: { role: "owner", shared: false },
};

const navigator = (
  collectionId: string,
  access = OWNED,
): SkillNavigatorCollection[] => [{
  collection: info(collectionId, access),
  children: [{
    type: "directory",
    path: "legacy",
    name: "legacy",
    children: [{
      type: "skill",
      collectionId,
      manifestPath: "legacy/review/SKILL.md",
      directoryPath: "legacy/review",
      name: "incident-response",
      description: "Review code",
      lastUpdated: new Date(Date.now() - 12 * 60_000),
    }],
  }],
}];

const metadata = (
  source: "web" | "git",
  visibility: ContextCollectionMetadata["visibility"] = "private",
): ContextCollectionMetadata => ({
  id: "collection",
  title: "collection",
  description: "",
  visibility,
  created: new Date(),
  lastUpdated: new Date(),
  documentCount: 1,
  content: source === "web"
    ? { source }
    : { source, remote: "", branch: "main", lastRefreshedAt: new Date() },
});

const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];

describe("SkillsNavigatorTree", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  const renderTree = ({
    writable,
    permissions = writable
      ? { canEdit: true, canShare: true, canManageOwners: true, canDelete: true }
      : undefined,
    access = OWNED,
    metadataAvailable = true,
    documentsFailed = false,
    retryFails = false,
    source = "web",
    visibility = "private",
    onUploadSkills = () => {},
  }: {
    writable: boolean;
    permissions?: ContextCollectionPermissions;
    access?: Pick<EnabledCollectionInfo, "source" | "membership">;
    metadataAvailable?: boolean;
    documentsFailed?: boolean;
    retryFails?: boolean;
    source?: "web" | "git";
    visibility?: ContextCollectionMetadata["visibility"];
    onUploadSkills?: (target: UploadSkillsTarget) => void;
  }) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const syncContextCollectionArtifactSource = vi.fn<
      ContextApi["syncContextCollectionArtifactSource"]
    >(async () => {});
    const onDelete = vi.fn<(target: NavigatorDeleteTarget) => void>();
    const onOpenCollection = vi.fn<(collectionId: string) => void>();
    const onShareCollection = vi.fn<(collection: { id: string; title: string }) => void>();
    const onLeaveCollection = vi.fn<(collection: { id: string; title: string }) => void>();
    const onRetryCollection = vi.fn<(collectionId: string) => Promise<void>>(async () => {
      if (retryFails) throw new Error("unavailable");
    });
    const api = {
      renameContextSkill: async () => {},
      syncContextCollectionArtifactSource,
    } as unknown as RpcStub<ContextApi>;
    act(() => root?.render(
      <ContextApiProvider value={api}>
        <Toasty>
          <SkillsNavigatorTree
            navigator={navigator("collection", access)}
            collectionMetadata={metadataAvailable
              ? new Map([["collection", metadata(source, visibility)]])
              : new Map()}
            collectionPermissions={permissions ? new Map([["collection", permissions]]) : new Map()}
            failedDocumentCollectionIds={documentsFailed ? new Set(["collection"]) : new Set()}
            writableCollectionIds={writable ? new Set(["collection"]) : new Set()}
            supportsGitCollections
            expandAll
            onSelectSkill={() => {}}
            onOpenCollection={onOpenCollection}
            onAddSkill={() => {}}
            onUploadSkills={onUploadSkills}
            onEditCollection={() => {}}
            onShareCollection={onShareCollection}
            onLeaveCollection={onLeaveCollection}
            onDelete={onDelete}
            onRetryCollection={onRetryCollection}
            onChanged={() => {}}
          />
        </Toasty>
      </ContextApiProvider>,
    ));
    return {
      onDelete, onLeaveCollection, onOpenCollection, onRetryCollection, onShareCollection,
      syncContextCollectionArtifactSource,
    };
  };

  const editor: ContextCollectionPermissions = {
    canEdit: true,
    canShare: true,
    canManageOwners: false,
    canDelete: false,
  };

  const openMenu = (name: string) => act(() => row(name)?.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  })));

  const row = (name: string) => [...container!.querySelectorAll<HTMLElement>(
    "[data-hierarchical-list-row]",
  )].find((candidate) => candidate.textContent?.includes(name));

  it("provides no actions or movement for a read-only collection", () => {
    renderTree({ writable: false });
    const skillRow = row("Incident Response");

    expect(skillRow?.draggable).toBe(false);
    act(() => skillRow?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    expect(document.body.textContent).not.toContain("Rename");
    expect(document.body.textContent).not.toContain("Delete");
  });

  it("lets a viewer open or leave a collection shared with them, without management actions", () => {
    const { onLeaveCollection, onOpenCollection } = renderTree({
      writable: false,
      permissions: { canEdit: false, canShare: false, canManageOwners: false, canDelete: false },
      access: { source: "private", membership: { role: "viewer", shared: true } },
    });

    expect(row("collection")?.textContent).toContain("Shared with you · Viewer");
    openMenu("collection");
    expect(menuItems().map((item) => item.textContent)).toEqual(["Open collection", "Leave"]);

    act(() => menuItems().find((item) => item.textContent === "Leave")?.click());
    expect(onLeaveCollection).toHaveBeenCalledWith({ id: "collection", title: "collection" });
    openMenu("collection");
    act(() => menuItems().find((item) => item.textContent === "Open collection")?.click());
    expect(onOpenCollection).toHaveBeenCalledWith("collection");
  });

  it("offers editors sharing but not deletion", () => {
    const { onShareCollection } = renderTree({
      writable: true,
      permissions: editor,
      access: { source: "private", membership: { role: "editor", shared: true } },
    });

    expect(row("collection")?.textContent).toContain("Shared with you · Editor");
    openMenu("collection");
    expect([...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .map((item) => item.textContent)).toEqual([
      "Open collection",
      "Add skill",
      "Upload skills",
      "Edit",
      "Share",
      "Leave",
    ]);

    const share = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((item) => item.textContent === "Share");
    act(() => share?.click());
    expect(onShareCollection).toHaveBeenCalledWith({ id: "collection", title: "collection" });
  });

  it("labels an owned collection as shared once others can read it", () => {
    renderTree({
      writable: true,
      access: { source: "private", membership: { role: "owner", shared: true } },
    });

    expect(row("collection")?.textContent).toContain("Shared");
    expect(row("collection")?.textContent).not.toContain("Shared with you");
  });

  it("moves skills but not legacy directories in a writable collection", () => {
    renderTree({ writable: true });

    expect(row("Incident Response")?.draggable).toBe(true);
    expect(row("Incident Response")?.textContent).toContain("Review code");
    expect(row("Incident Response")?.textContent).toContain("12m ago");
    expect(row("Incident Response")?.querySelector('[aria-label="Updated 12 minutes ago"]'))
      .not.toBeNull();
    expect(row("legacy")?.draggable).toBe(false);
  });

  it("identifies and refreshes an editable Git collection", async () => {
    const { syncContextCollectionArtifactSource } = renderTree({
      writable: false,
      permissions: editor,
      source: "git",
    });
    const collectionRow = row("collection");

    expect(collectionRow?.textContent).toContain("Git managed");
    expect(collectionRow?.textContent).toContain("Private");
    expect(collectionRow?.textContent).toContain("just now");
    expect(collectionRow?.querySelector('[aria-label="Updated just now"]')).not.toBeNull();
    act(() => collectionRow?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const refresh = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((item) => item.textContent?.includes("Refresh"));
    expect(refresh).toBeDefined();

    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });
    expect(syncContextCollectionArtifactSource).toHaveBeenCalledWith("collection");
  });

  it("identifies an organization collection", () => {
    renderTree({ writable: true, access: { source: "public" }, visibility: "public" });

    expect(row("collection")?.textContent).toContain("Organization");
  });

  it("keeps delete available when collection metadata fails to load", () => {
    const { onDelete } = renderTree({
      writable: false,
      permissions: { ...editor, canDelete: true },
      metadataAvailable: false,
    });

    openMenu("collection");
    expect(menuItems().map((item) => item.textContent)).toEqual(["Open collection", "Share", "Delete"]);

    act(() => menuItems()[2]?.click());
    expect(onDelete).toHaveBeenCalledWith({
      type: "collection",
      collectionId: "collection",
      name: "collection",
    });
  });

  it("shows document load failures with retry and withholds collection deletion", () => {
    const { onRetryCollection } = renderTree({
      writable: false,
      permissions: { ...editor, canShare: false, canDelete: true },
      documentsFailed: true,
    });

    const retryRow = row("click to try again");
    expect(retryRow?.textContent).toBe("Couldn't load contents, click to try again");

    openMenu("collection");
    const menu = document.querySelector<HTMLElement>("[role=menu]");
    expect([...menu!.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .map((item) => item.textContent)).toEqual(["Open collection", "Edit"]);

    act(() => retryRow?.click());
    expect(onRetryCollection).toHaveBeenCalledWith("collection");
  });

  it("shows a toast when retrying a document load fails", async () => {
    renderTree({
      writable: false,
      permissions: editor,
      documentsFailed: true,
      retryFails: true,
    });

    await act(async () => {
      row("click to try again")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Couldn't load collection contents");
  });

  it("shows collection actions in the action menu", () => {
    renderTree({ writable: true });

    act(() => row("collection")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect([...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map((item) => item.textContent)).toEqual([
        "Open collection",
        "Add skill",
        "Upload skills",
        "Edit",
        "Share",
        "Delete",
      ]);
  });

  it("uploads skills into a writable legacy directory from its context menu", () => {
    const onUploadSkills = vi.fn<(target: UploadSkillsTarget) => void>();
    renderTree({ writable: true, onUploadSkills });

    act(() => row("legacy")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const upload = [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((item) => item.textContent?.includes("Upload skills"));
    act(() => upload?.click());

    expect(onUploadSkills).toHaveBeenCalledWith({
      collectionId: "collection",
      directoryPath: "legacy",
      collectionEditable: false,
    });
  });

  it("starts inline renaming after the skill context menu closes", () => {
    vi.useFakeTimers();
    renderTree({ writable: true });

    act(() => row("Incident Response")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const rename = [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((item) => item.textContent?.includes("Rename"));
    act(() => rename?.click());

    expect(container?.querySelector('[aria-label="Rename skill"]')).toBeNull();
    act(() => vi.advanceTimersByTime(0));
    expect(container?.querySelector('[aria-label="Rename skill"]')).not.toBeNull();
  });
});
