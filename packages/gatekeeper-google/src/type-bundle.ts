/** Module-only prefix of the Google Docs declaration. */
export const DOCS_TYPES_MODULE_PREFIX =
  'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
  'export type { DocMetadata, GoogleDocReadSession } from "./docs-read-types";\n\n';

/** Module-only prefix of the Google Drive declaration. */
export const DRIVE_TYPES_MODULE_PREFIX =
  'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
  'import type { GoogleSpreadsheetSession } from "./sheets-types";\n\n';

/** Remove a declaration's expected module prefix before adding it to the flat agent type bundle. */
export function stripTypeModulePrefix(source: string, prefix: string): string {
  if (!source.startsWith(prefix)) {
    throw new Error("Agent type declaration has an unexpected module prefix.");
  }
  return source.slice(prefix.length);
}
