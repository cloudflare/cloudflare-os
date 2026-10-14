import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
import type { ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import { PDF_MIME_TYPE } from "./chat-attachment-pdf";

// A conservative per-file size that model APIs generally accept; providers' own limits vary by
// API and model, and some may be lower. Mirrored by the frontend's MAX_CHAT_ATTACHMENT_BYTES
// (prepareChatAttachment.ts).
const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const IMAGE_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ["image/jpeg", [0xFF, 0xD8, 0xFF]],
  ["image/png", [0x89, 0x50, 0x4E, 0x47]],
  ["image/webp", [
    0x52, 0x49, 0x46, 0x46,
    null, null, null, null,
    0x57, 0x45, 0x42, 0x50,
  ]],
]);

// Magic-number prefixes checked at upload. Like the image signatures, the PDF one ("%PDF-")
// only stops mislabeled uploads at the door; nothing here parses the content.
const CONTENT_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ...IMAGE_SIGNATURES,
  [PDF_MIME_TYPE, [0x25, 0x50, 0x44, 0x46, 0x2D]],
]);

function sanitizeChatAttachmentMimeType(mimeType: string | undefined): string {
  if (!mimeType || /[\r\n]/.test(mimeType)) return "application/octet-stream";
  return mimeType.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

function sanitizeChatAttachmentName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let result = name.replace(/[\r\n]/g, " ").slice(0, 255).trim();
  return result || undefined;
}

/** Bound uploaded bytes independently of a model's supported input formats. */
export function assertChatAttachmentSize(byteLength: number): void {
  if (byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("Chat attachment is too large.");
  }
}

/** Normalize and validate attachment bytes before staging them in chat storage. */
export function validateChatAttachmentUpload(
  attachment: ChatAttachmentUpload,
): ChatAttachmentUpload {
  attachment.name = sanitizeChatAttachmentName(attachment.name);
  attachment.mimeType = sanitizeChatAttachmentMimeType(attachment.mimeType);
  assertChatAttachmentSize(attachment.content.byteLength);

  let signature = CONTENT_SIGNATURES.get(attachment.mimeType);
  if (signature) {
    for (let [index, expected] of signature.entries()) {
      if (expected !== null && attachment.content[index] !== expected) {
        throw new Error("Chat attachment content does not match its MIME type.");
      }
    }
  }

  return attachment;
}

/** Decode only genuine UTF-8 text; all other attachments retain opaque byte semantics. */
export function decodeChatAttachmentText(mimeType: string, bytes: Uint8Array): string | undefined {
  if (!isTextLikeAttachmentMimeType(mimeType) || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Whether a MIME type is one of the image encodings Workshop accepts for chat attachments. */
export function isAllowedChatAttachmentImageMimeType(mimeType: string | undefined): boolean {
  return IMAGE_SIGNATURES.has(sanitizeChatAttachmentMimeType(mimeType));
}
