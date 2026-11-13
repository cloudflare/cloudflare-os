import { isCompoundFile } from "@gadgets/office-content";
import { AttachmentPreviewError } from "../attachmentPreviewers";

/**
 * Refuses an Office file that is encrypted. Such a file keeps its modern extension but is an OLE
 * compound file rather than a ZIP package, so the parsers would only call it malformed.
 */
export const assertOpenXml = (bytes: Uint8Array) => {
  if (isCompoundFile(bytes)) {
    throw new AttachmentPreviewError("This file is password-protected. Download it to open it.");
  }
};
