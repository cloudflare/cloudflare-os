import type { EnabledCollectionInfo } from "../../src/context-types";

export const hasDuplicateCollectionTitle = (
  collections: readonly EnabledCollectionInfo[],
  title: string,
  excludeCollectionId?: string,
): boolean => {
  const normalizedTitle = title.trim().toLowerCase();
  return normalizedTitle.length > 0 && collections.some((collection) =>
    collection.id !== excludeCollectionId
    && collection.title.trim().toLowerCase() === normalizedTitle);
};
