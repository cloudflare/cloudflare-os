import type { ResourceSubject, ResourceSubjectRole } from "@gadgets/workshop-shared/gatekeeper";

/** The Google editors whose files a one-file connection names. */
export type GoogleFileKind = "document" | "spreadsheet" | "presentation";

const EDITORS: Record<GoogleFileKind, { path: string; mediaType: string }> = {
  document: { path: "document", mediaType: "application/vnd.google-apps.document" },
  spreadsheet: { path: "spreadsheets", mediaType: "application/vnd.google-apps.spreadsheet" },
  presentation: { path: "presentation", mediaType: "application/vnd.google-apps.presentation" },
};

/** The URL a Google file opens at in its editor. */
export function googleFileUrl(kind: GoogleFileKind, fileId: string): string {
  return `https://docs.google.com/${EDITORS[kind].path}/d/${encodeURIComponent(fileId)}/edit`;
}

/**
 * The subject of an entry about a Google file (see ResourceSubject): the file by its Drive ID,
 * named as it was when the entry was recorded.
 */
export function googleFileSubject(
  kind: GoogleFileKind, fileId: string, title: string, role: ResourceSubjectRole,
): ResourceSubject {
  return {
    id: fileId,
    title,
    url: googleFileUrl(kind, fileId),
    mediaType: EDITORS[kind].mediaType,
    role,
  };
}
