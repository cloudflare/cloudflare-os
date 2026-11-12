/** Module-only prefix of the Google Docs declaration. */
export const DOCS_TYPES_MODULE_PREFIX =
  'import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";\n' +
  'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
  'export type { DocMetadata, GoogleDocReadSession, GoogleDocTab } from "./docs-read-types";\n\n';

/** Module-only prefix of the read-only Google Drive declaration. */
export const DRIVE_READ_TYPES_MODULE_PREFIX =
  'import type { DriveComment } from "./comment-types";\n' +
  'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
  'import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";\n' +
  'import type { GooglePresentationReadSession } from "./slides-read-types";\n' +
  'export type * from "./comment-types";\n\n';

/** Module-only prefix of the read and write Google Drive declaration. */
export const DRIVE_TYPES_MODULE_PREFIX =
  'import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";\n' +
  'import type { GoogleDriveFolderReadSession, GoogleDriveReadSession } from "./drive-read-types";\n' +
  'export type * from "./drive-read-types";\n\n';

/** Module-only prefix of the Gmail declaration; the flat vendor bundle gets RpcStub from chat-types instead. */
export const GMAIL_TYPES_MODULE_PREFIX = 'import type { RpcStub } from "cloudflare:workers";\n\n';

/** Module-only prefix of the Google Slides declaration. */
export const SLIDES_TYPES_MODULE_PREFIX =
  "import type {\n" +
  "  GooglePresentationReadSession, ParagraphFormat, SlideBounds, SlideColor, ThemeColorName,\n" +
  '} from "./slides-read-types";\n' +
  'export type * from "./slides-read-types";\n\n';

/** Module-only prefix of the Google Sheets declaration. */
export const SHEETS_TYPES_MODULE_PREFIX =
  "import type {\n" +
  "  GoogleSpreadsheetReadSession, SheetBorder, SheetColor, SheetNumberFormat,\n" +
  '} from "./sheets-read-types";\n' +
  'export type * from "./sheets-read-types";\n\n';

/** Remove a declaration's expected module prefix before adding it to the flat agent type bundle. */
export function stripTypeModulePrefix(source: string, prefix: string): string {
  if (!source.startsWith(prefix)) {
    throw new Error("Agent type declaration has an unexpected module prefix.");
  }
  return source.slice(prefix.length);
}
