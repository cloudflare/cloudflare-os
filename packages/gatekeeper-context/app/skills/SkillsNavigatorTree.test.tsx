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
import type { SkillNavigatorCollection } from "./skillNavigatorModel";
import { SkillsNavigatorTree } from "./SkillsNavigatorTree";

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
      lastUpdated: new Date(),
    }],
  }],
}];

const metadata = (source: "web" | "git"): ContextCollectionMetadata => ({
  id: "collection",
  title: "collection",
  description: "",
  visibility: "private",
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
  });

  const renderTree = ({
    writable,
    manageable = writable,
    source = "web",
  }: {
    writable: boolean;
    manageable?: boolean;
    source?: "web" | "git";
  }) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const syncContextCollectionArtifactSource = vi.fn<
      ContextApi["syncContextCollectionArtifactSource"]
    >(async () => {});
    const api = {
      renameContextSkill: async () => {},
      syncContextCollectionArtifactSource,
    } as unknown as RpcStub<ContextApi>;
    act(() => root?.render(
      <ContextApiProvider value={api}>
        <Toasty>
          <SkillsNavigatorTree
            navigator={navigator("collection")}
            collectionMetadata={new Map([["collection", metadata(source)]])}
            manageableCollectionIds={manageable ? new Set(["collection"]) : new Set()}
            writableCollectionIds={writable ? new Set(["collection"]) : new Set()}
            supportsGitCollections
            expandAll
            onSelectSkill={() => {}}
            onAddSkill={() => {}}
            onEditCollection={() => {}}
            onDelete={() => {}}
            onChanged={() => {}}
          />
        </Toasty>
      </ContextApiProvider>,
    ));
    return { syncContextCollectionArtifactSource };
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
    expect(row("Incident Response")?.textContent).toContain("now");
    expect(row("Incident Response")?.querySelector('[aria-label="Updated just now"]'))
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
});
