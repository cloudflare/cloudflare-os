import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
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

// Magic-number prefixes checked when attaching. Like the image signatures, the PDF one ("%PDF-")
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

/** Normalize and validate an upload's metadata and bytes before attaching it to a message. */
export function validateChatAttachmentUpload<T extends {
  mimeType: string; content: Uint8Array; name?: string;
}>(attachment: T): T {
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

/** Keep oversized or unrecognized image headers workspace-only, without changing stored bytes. */
export function canInlineChatAttachmentImage(
    mimeType: string, bytes: Uint8Array, maxEdge = 8000): boolean {
  const dimensions = imageDimensions(sanitizeChatAttachmentMimeType(mimeType), bytes);
  // Anthropic permits 8000 pixels normally, but only 2000 in many-image requests. This is a
  // model-input guard, not an upload restriction: originals remain in the worktree/downloads.
  // https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
  return dimensions !== undefined && dimensions.every(edge => edge > 0 && edge <= maxEdge);
}

// Read dimensions from supported format headers only; never decode/decompress pixel data.
// Unknown or truncated headers fall back to the workspace rather than breaking model replay.
function imageDimensions(mimeType: string, bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png" && bytes.length >= 24 &&
      view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mimeType === "image/webp" && bytes.length >= 20 &&
      view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    switch (view.getUint32(12)) {
      case 0x56503858: // VP8X: extended canvas dimensions, encoded minus one.
        if (bytes.length >= 30) return [
          1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
          1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        ];
        break;
      case 0x5650384c: // VP8L: lossless bit-packed dimensions.
        if (bytes.length >= 25 && bytes[20] === 0x2f) {
          const bits = view.getUint32(21, true);
          return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
        }
        break;
      case 0x56503820: // VP8: lossy key-frame header.
        if (bytes.length >= 30 && (bytes[20] & 1) === 0 &&
            bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
          return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
        }
    }
  }
  if (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 0xff) return undefined;
      while (bytes[offset] === 0xff) ++offset;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return undefined; // Scan data/end before SOF.
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue; // No segment length.
      if (offset + 2 > bytes.length) return undefined;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) return undefined;
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  return undefined;
}
