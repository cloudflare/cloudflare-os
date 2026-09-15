import { useEffect, useState } from "react";
import type {
  ContextApi,
  ContextCollectionMetadata,
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../../src/context-types";

type SkillsNavigatorData = {
  collections: EnabledCollectionInfo[];
  collectionMetadata: ReadonlyMap<string, ContextCollectionMetadata>;
  documents: Map<string, ContextDocumentSummary[]>;
  manageableCollectionIds: ReadonlySet<string>;
  writableCollectionIds: ReadonlySet<string>;
  viewerInfo: { isAdmin: boolean; supportsGitCollections: boolean };
  status: "loading" | "ready" | "error";
};

/** Loads skill collections, their documents, and the viewer's write permissions. */
export const useSkillsNavigatorData = (
  context: ContextApi,
  reloadKey: number,
): SkillsNavigatorData => {
  const [data, setData] = useState<SkillsNavigatorData>({
    collections: [],
    collectionMetadata: new Map(),
    documents: new Map(),
    manageableCollectionIds: new Set(),
    writableCollectionIds: new Set(),
    viewerInfo: { isAdmin: false, supportsGitCollections: false },
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [collections, viewerInfo] = await Promise.all([
          context.listEnabledContextCollections(),
          context.getViewerInfo().catch(() => ({
            isAdmin: false,
            supportsGitCollections: false,
          })),
        ]);
        const [documentResults, accessResults] = await Promise.all([
          Promise.all(collections.map(async (collection) => {
            try {
              return [collection.id, await context.listContextDocuments(collection.id)] as const;
            } catch {
              return [collection.id, null] as const;
            }
          })),
          Promise.all(collections.map(async (collection) => {
            const [canWrite, metadata] = await Promise.all([
              context.canWriteContextCollection(collection.id).catch(() => false),
              context.getContextCollectionMetadata(collection.id).catch(() => null),
            ]);
            return { id: collection.id, canWrite, metadata };
          })),
        ]);
        if (cancelled) return;
        const failedCollectionIds = new Set(documentResults.flatMap(([id, documents]) =>
          documents === null ? [id] : []));
        const loadedDocuments = documentResults.map(([id, documents]) => [
          id,
          documents ?? [],
        ] as const);
        const collectionMetadata = new Map(accessResults.flatMap(({ id, metadata }) =>
          metadata ? [[id, metadata] as const] : []));
        const manageableCollectionIds = new Set(accessResults.flatMap(({ id, canWrite, metadata }) =>
          canWrite && metadata ? [id] : []));
        setData({
          collections,
          collectionMetadata,
          documents: new Map(loadedDocuments),
          manageableCollectionIds,
          writableCollectionIds: new Set(accessResults.flatMap(({ id, canWrite, metadata }) =>
            canWrite && metadata?.content.source === "web" && !failedCollectionIds.has(id)
              ? [id]
              : [])),
          viewerInfo,
          status: "ready",
        });
      } catch {
        if (!cancelled) setData((current) => ({ ...current, status: "error" }));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [context, reloadKey]);

  return data;
};
