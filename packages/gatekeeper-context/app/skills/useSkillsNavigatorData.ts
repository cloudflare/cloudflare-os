import { useEffect, useState } from "react";
import type { ContextApi, ContextDocumentSummary, EnabledCollectionInfo } from "../../src/context-types";

type SkillsNavigatorData = {
  collections: EnabledCollectionInfo[];
  documents: Map<string, ContextDocumentSummary[]>;
  writableCollectionIds: ReadonlySet<string>;
  status: "loading" | "ready" | "error";
};

/** Loads skill collections, their documents, and the viewer's write permissions. */
export const useSkillsNavigatorData = (
  context: ContextApi,
  reloadKey: number,
): SkillsNavigatorData => {
  const [data, setData] = useState<SkillsNavigatorData>({
    collections: [],
    documents: new Map(),
    writableCollectionIds: new Set(),
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const collections = await context.listEnabledContextCollections();
        const [documentResults, writableIds] = await Promise.all([
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
            return canWrite && metadata?.content.source === "web" ? collection.id : null;
          })),
        ]);
        if (cancelled) return;
        const failedCollectionIds = new Set(documentResults.flatMap(([id, documents]) =>
          documents === null ? [id] : []));
        const loadedDocuments = documentResults.map(([id, documents]) => [
          id,
          documents ?? [],
        ] as const);
        setData({
          collections,
          documents: new Map(loadedDocuments),
          writableCollectionIds: new Set(writableIds.filter((id): id is string =>
            id !== null && !failedCollectionIds.has(id))),
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
