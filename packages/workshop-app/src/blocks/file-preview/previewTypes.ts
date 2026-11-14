/** What a previewer is given: the whole file, already loaded. */
export type FilePreviewProps = {
  bytes: Uint8Array
  name: string
  mimeType: string
}

/**
 * A failure whose message is written for the person looking at the file, such as a document that
 * needs a password. Anything else a previewer throws is shown as a generic failure.
 */
export class FilePreviewError extends Error {}
