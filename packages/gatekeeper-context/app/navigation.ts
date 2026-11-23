// The Context Library's app-local paths (see `@gadgets/workshop-shared/gatekeeper-app`), which the
// Workshop shows after /gatekeepers/context:
//
//   /                                         the library
//   /collections/<collectionId>               a collection's overview
//   /collections/<collectionId>/files/<path>  a document in it, by its full document path
//
// A document path is only required to be non-empty. Reads are lenient (a path that names nothing
// reads as missing), and Git-mirrored files can have paths the web editor's mutation rules reject.

/** What an app-local path addresses. */
export type ContextView =
  | { kind: "library" }
  | { kind: "collection"; collectionId: string; documentPath: string | null }
  | { kind: "invalid" };

const INVALID: ContextView = { kind: "invalid" };

/** Parses a path the host delivered. It comes from the address bar, so anything else is invalid. */
export function parseContextPath(path: string): ContextView {
  if (path === "/") return { kind: "library" };
  const [empty, collections, collectionId, files, ...documentSegments] = path.split("/");
  if (empty !== "" || collections !== "collections" || !collectionId) return INVALID;
  if (files === undefined) return { kind: "collection", collectionId, documentPath: null };
  const documentPath = documentSegments.join("/");
  if (files !== "files" || !documentPath) return INVALID;
  return { kind: "collection", collectionId, documentPath };
}

/** The path of the library (no collection), a collection, or a document in it. */
export function contextPath(collectionId: string | null, documentPath: string | null = null): string {
  if (collectionId === null) return "/";
  return documentPath === null
    ? `/collections/${collectionId}`
    : `/collections/${collectionId}/files/${documentPath}`;
}
