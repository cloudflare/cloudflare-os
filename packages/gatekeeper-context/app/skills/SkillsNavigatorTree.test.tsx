// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { Toasty } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextApi, EnabledCollectionInfo } from "../../src/context-types";
import { ContextApiProvider } from "../bridge";
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
      lastUpdated: new Date(),
    }],
  }],
}];

describe("SkillsNavigatorTree", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
  });

  const renderTree = (
    writable: boolean,
    onUploadSkills: (target: UploadSkillsTarget) => void = () => {},
  ) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const api = { renameContextSkill: async () => {} } as unknown as RpcStub<ContextApi>;
    act(() => root?.render(
      <ContextApiProvider value={api}>
        <Toasty>
          <SkillsNavigatorTree
            navigator={navigator("collection")}
            writableCollectionIds={writable ? new Set(["collection"]) : new Set()}
            expandAll
            onSelectSkill={() => {}}
            onAddSkill={() => {}}
            onUploadSkills={onUploadSkills}
            onEditCollection={() => {}}
            onDelete={() => {}}
            onChanged={() => {}}
          />
        </Toasty>
      </ContextApiProvider>,
    ));
  };

  const row = (name: string) => [...container!.querySelectorAll<HTMLElement>(
    "[data-hierarchical-list-row]",
  )].find((candidate) => candidate.textContent?.includes(name));

  it("provides no actions or movement for a read-only collection", () => {
    renderTree(false);
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
    renderTree(true);

    expect(row("Incident Response")?.draggable).toBe(true);
    expect(row("Incident Response")?.textContent).toContain("Review code");
    expect(row("Incident Response")?.textContent).toContain("now");
    expect(row("Incident Response")?.querySelector('[aria-label="Updated just now"]'))
      .not.toBeNull();
    expect(row("legacy")?.draggable).toBe(false);
  });

  it("uploads skills into a writable legacy directory from its context menu", () => {
    const onUploadSkills = vi.fn<(target: UploadSkillsTarget) => void>();
    renderTree(true, onUploadSkills);

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

  it("starts inline renaming from a skill context menu", () => {
    renderTree(true);

    act(() => row("Incident Response")?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const rename = [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((item) => item.textContent?.includes("Rename"));
    act(() => rename?.click());

    expect(container?.querySelector('[aria-label="Rename skill"]')).not.toBeNull();
  });
});
