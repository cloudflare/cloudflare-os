// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { Toasty } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContextApi,
  ContextCollectionMetadata,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { ContextApiProvider } from "../bridge";
import type { NavigatorDeleteTarget } from "./DeleteNavigatorNodeDialog";
import type { SkillNavigatorCollection } from "./skillNavigatorModel";
import { SkillsNavigatorTree } from "./SkillsNavigatorTree";
import type { UploadSkillsTarget } from "./UploadSkillsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (id: string): EnabledCollectionInfo => ({
  id,
  title: id,
  description: "",
  source: "private",
  lastUpdated: new Date(),
});

const navigator = (collectionId: string): SkillNavigatorCollection[] => [{
  collection: info(collectionId),
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
    manageable = writable,
    metadataAvailable = true,
    source = "web",
    visibility = "private",
    onUploadSkills = () => {},
  }: {
    writable: boolean;
    manageable?: boolean;
    metadataAvailable?: boolean;
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
    const api = {
      renameContextSkill: async () => {},
      syncContextCollectionArtifactSource,
    } as unknown as RpcStub<ContextApi>;
    act(() => root?.render(
      <ContextApiProvider value={api}>
        <Toasty>
          <SkillsNavigatorTree
            navigator={navigator("collection")}
            collectionMetadata={metadataAvailable
              ? new Map([["collection", metadata(source, visibility)]])
              : new Map()}
            manageableCollectionIds={manageable ? new Set(["collection"]) : new Set()}
            writableCollectionIds={writable ? new Set(["collection"]) : new Set()}
            supportsGitCollections
            expandAll
            onSelectSkill={() => {}}
            onAddSkill={() => {}}
            onUploadSkills={onUploadSkills}
            onEditCollection={() => {}}
            onDelete={onDelete}
            onChanged={() => {}}
          />
        </Toasty>
      </ContextApiProvider>,
    ));
    return { onDelete, syncContextCollectionArtifactSource };
  };

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

  it("moves skills but not legacy directories in a writable collection", () => {
    renderTree({ writable: true });

    expect(row("Incident Response")?.draggable).toBe(true);
    expect(row("Incident Response")?.textContent).toContain("Review code");
    expect(row("Incident Response")?.textContent).toContain("12m ago");
    expect(row("Incident Response")?.querySelector('[aria-label="Updated 12 minutes ago"]'))
      .not.toBeNull();
    expect(row("legacy")?.draggable).toBe(false);
  });

  it("identifies and refreshes a manageable Git collection", async () => {
    const { syncContextCollectionArtifactSource } = renderTree({
      writable: false,
      manageable: true,
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
    renderTree({ writable: true, visibility: "public" });

    expect(row("collection")?.textContent).toContain("Organization");
  });

  it("keeps delete available when collection metadata fails to load", () => {
    const { onDelete } = renderTree({
      writable: false,
      manageable: true,
      metadataAvailable: false,
    });

    act(() => row("collection")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const menuItems = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(menuItems.map((item) => item.textContent)).toEqual(["Delete"]);

    act(() => menuItems[0]?.click());
    expect(onDelete).toHaveBeenCalledWith({
      type: "collection",
      collectionId: "collection",
      name: "collection",
    });
  });

  it("shows collection actions in the narrow-layout drawer", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    renderTree({ writable: true });

    act(() => row("collection")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const drawer = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(drawer).not.toBeNull();
    expect([...drawer!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map((item) => item.textContent)).toEqual([
        "Add skill",
        "Upload skills",
        "Edit",
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
    renderTree(true);

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
