import {
  FileAudioIcon,
  FileCodeIcon,
  FileDocIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { AttachmentKind } from "./attachmentKind";

/** The icon an attachment of each kind is shown with, in the composer and in the chat. */
export const ATTACHMENT_KIND_ICONS: Record<AttachmentKind, Icon> = {
  image: FileImageIcon,
  pdf: FilePdfIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  spreadsheet: FileXlsIcon,
  document: FileDocIcon,
  presentation: FilePptIcon,
  archive: FileZipIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileIcon,
};
