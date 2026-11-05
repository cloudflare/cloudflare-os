import type { ContextCollectionRole } from "../../src/context-types";

export const COLLECTION_ROLE_LABELS: Record<ContextCollectionRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  owner: "Owner",
};
