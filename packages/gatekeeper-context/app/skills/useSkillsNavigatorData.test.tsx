// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ContextApi, ContextCollectionMetadata, EnabledCollectionInfo } from "../../src/context-types";
import { useSkillsNavigatorData } from "./useSkillsNavigatorData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const collection = (id: string, source: EnabledCollectionInfo["source"]): EnabledCollectionInfo => ({
  id,
  title: id,
  description: "",
  source,
  lastUpdated: new Date(),
});

const metadata = (id: string, source: "web" | "git"): ContextCollectionMetadata => ({
  id,
  title: id,
  description: "",
  visibility: "private",
  created: new Date(),
  lastUpdated: new Date(),
  documentCount: 0,
  content: source === "web"
    ? { source }
    : { source, remote: "", branch: "main", lastRefreshedAt: new Date() },
});

describe("useSkillsNavigatorData", () => {
  it("tracks capabilities and reports partial document failures", async () => {
    const collections = [
      collection("owned-web", "private"),
      collection("organization", "public"),
      collection("owned-git", "private"),
      collection("failed-web", "private"),
      collection("metadata-failed-web", "private"),
    ];
    const api = {
      listEnabledContextCollections: async () => collections,
      getViewerInfo: async () => ({ isAdmin: true, supportsGitCollections: true }),
      listContextDocuments: async (id: string) => {
        if (id === "failed-web") throw new Error("unavailable");
        return [];
      },
      canWriteContextCollection: async (id: string) => id !== "organization",
      getContextCollectionMetadata: async (id: string) => {
        if (id === "metadata-failed-web") throw new Error("unavailable");
        return metadata(id, id === "owned-git" ? "git" : "web");
      },
    } as unknown as ContextApi;
    let writableIds: readonly string[] = [];
    let manageableIds: readonly string[] = [];
    let failedDocumentIds: readonly string[] = [];
    let loadedMetadata: ReadonlyMap<string, ContextCollectionMetadata> = new Map();
    let viewerInfo = { isAdmin: false, supportsGitCollections: false };
    let status = "loading";

    const Harness = () => {
      const data = useSkillsNavigatorData(api, 0);
      writableIds = [...data.writableCollectionIds];
      manageableIds = [...data.manageableCollectionIds];
      failedDocumentIds = [...data.failedDocumentCollectionIds];
      loadedMetadata = data.collectionMetadata;
      viewerInfo = data.viewerInfo;
      status = data.status;
      return null;
    };

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writableIds).toEqual(["owned-web"]);
    expect(manageableIds).toEqual([
      "owned-web",
      "owned-git",
      "failed-web",
      "metadata-failed-web",
    ]);
    expect(failedDocumentIds).toEqual(["failed-web"]);
    expect(loadedMetadata.has("failed-web")).toBe(true);
    expect(loadedMetadata.has("metadata-failed-web")).toBe(false);
    expect(loadedMetadata.get("owned-git")?.content.source).toBe("git");
    expect(viewerInfo).toEqual({ isAdmin: true, supportsGitCollections: true });
    expect(status).toBe("ready");
    act(() => root.unmount());
  });

  it("restores documents and write access after a successful retry", async () => {
    let attempts = 0;
    const retriedDocument = {
      path: "review/SKILL.md",
      name: "SKILL.md",
      description: "Review changes",
      contentType: "text/markdown",
      skillName: "review",
      lastUpdated: new Date(),
    };
    const api = {
      listEnabledContextCollections: async () => [collection("failed-web", "private")],
      getViewerInfo: async () => ({ isAdmin: false, supportsGitCollections: false }),
      listContextDocuments: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("unavailable");
        return [retriedDocument];
      },
      canWriteContextCollection: async () => true,
      getContextCollectionMetadata: async () => metadata("failed-web", "web"),
    } as unknown as ContextApi;
    let current: ReturnType<typeof useSkillsNavigatorData> | undefined;

    const Harness = () => {
      current = useSkillsNavigatorData(api, 0);
      return null;
    };

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect([...current!.failedDocumentCollectionIds]).toEqual(["failed-web"]);

    await act(async () => current!.retryDocumentCollection("failed-web"));

    expect(current!.documents.get("failed-web")).toEqual([retriedDocument]);
    expect([...current!.failedDocumentCollectionIds]).toEqual([]);
    expect([...current!.writableCollectionIds]).toEqual(["failed-web"]);
    act(() => root.unmount());
  });
});
