const LAST_PICKED_COLLECTION_KEY = "gatekeeper-context:last-picked-skill-collection";

/** Reads the last collection selected while creating a skill. */
export const getLastPickedCollectionId = (): string | null => {
  try {
    return localStorage.getItem(LAST_PICKED_COLLECTION_KEY);
  } catch {
    return null;
  }
};

/** Remembers the collection selected while creating a skill. */
export const saveLastPickedCollectionId = (collectionId: string): void => {
  try {
    localStorage.setItem(LAST_PICKED_COLLECTION_KEY, collectionId);
  } catch {
    // Storage may be unavailable in private mode or when full.
  }
};
