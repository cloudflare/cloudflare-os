// The subresource IDs Google Drive, Docs, Sheets and Slides reads report, shared by those
// gatekeepers and by the UserAccount that checks an observer against them.
//
// Each names the file a read returned data from, as the API that read it names that file:
//   - `drive/file/<fileId>`: a Drive file's metadata, or a PDF's text, which an observer's own
//     account may see when Drive lets it see the file.
//   - `drive/folder/<folderId>`: that a Drive folder's children can be listed, which only an
//     observer whose own account can list them may see. A folder is a Drive file with the same ID,
//     so the kind is what tells this check from the one above.
//   - `docs/document/<documentId>`, `sheets/spreadsheet/<spreadsheetId>` and
//     `slides/presentation/<presentationId>`: a native file's metadata or content, which an
//     observer's own account may see when that API opens the file for it. Google shares a file as a
//     whole, so one ID covers every tab, worksheet or slide.
//
// Imports neither google.ts nor the gatekeeper modules that report these IDs.

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { DriveObservation } from "./drive-observers";

/** The namespace of the Drive subresource IDs: files and folders. */
export const DRIVE_SUBRESOURCE_NAMESPACE = "drive";
/** The namespace of the Google Docs subresource IDs. */
export const DOCS_SUBRESOURCE_NAMESPACE = "docs";
/** The namespace of the Google Sheets subresource IDs. */
export const SHEETS_SUBRESOURCE_NAMESPACE = "sheets";
/** The namespace of the Google Slides subresource IDs. */
export const SLIDES_SUBRESOURCE_NAMESPACE = "slides";

/** A native file: what a Docs, Sheets or Slides read reads, as that API names the file. */
export type NativeFileSubresource = {
  kind: "document" | "spreadsheet" | "presentation";
  fileId: string;
};

/** What a Drive, Docs, Sheets or Slides subresource ID names: a Drive unit, or a native file. */
export type FileSubresource = DriveObservation | NativeFileSubresource;

/** The namespace and fragment name each kind of file subresource is spelled with. */
const SPELLINGS: Record<FileSubresource["kind"], { namespace: string; name: string }> = {
  file: { namespace: DRIVE_SUBRESOURCE_NAMESPACE, name: "file" },
  folder: { namespace: DRIVE_SUBRESOURCE_NAMESPACE, name: "folder" },
  document: { namespace: DOCS_SUBRESOURCE_NAMESPACE, name: "document" },
  spreadsheet: { namespace: SHEETS_SUBRESOURCE_NAMESPACE, name: "spreadsheet" },
  presentation: { namespace: SLIDES_SUBRESOURCE_NAMESPACE, name: "presentation" },
};

const KINDS = Object.keys(SPELLINGS) as FileSubresource["kind"][];

/** The subresource ID a read reports for `resource`, such as `docs/document/<documentId>`. */
export function fileSubresourceId(resource: FileSubresource): string {
  let { namespace, name } = SPELLINGS[resource.kind];
  return formatSubresourceId({ namespace, fragments: [{ name, id: resource.fileId }] });
}

/** The subresource IDs of `resources`, each once, for one read that depends on all of them. */
export function fileSubresourceIds(resources: readonly FileSubresource[]): string[] {
  return [...new Set(resources.map(fileSubresourceId))];
}

/** What a {@link fileSubresourceId} ID names; throws for any other ID. */
export function parseFileSubresource(id: string): FileSubresource {
  let { namespace, fragments } = parseSubresourceId(id);
  if (fragments.length === 1) {
    let [{ name, id: fileId }] = fragments;
    let kind = KINDS.find(candidate =>
      SPELLINGS[candidate].namespace === namespace && SPELLINGS[candidate].name === name);
    if (kind) return { kind, fileId };
  }
  throw new Error("Not a Google Drive, Docs, Sheets or Slides subresource ID.");
}

/**
 * Refuses, for a binding's verifyObserverAccess(), every ID that names none of `kinds`: the IDs its
 * reads never report, which the account would otherwise check, since it checks those of every
 * Google gatekeeper.
 */
export function requireFileSubresources(
  subresources: readonly string[], kinds: readonly FileSubresource["kind"][],
): void {
  for (let id of subresources) {
    if (!kinds.includes(parseFileSubresource(id).kind)) {
      throw new Error("Not a subresource ID this Google binding reports.");
    }
  }
}
