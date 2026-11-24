import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";
import { canInlineChatAttachmentImage } from "./chat-attachment-validation";
import type { BlobReader } from "./git-chunked-blob";

/** Maximum bytes read into one model image, matching the chat attachment limit. */
export const MAX_FILE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Raw-byte budget for file images, after reserving space for existing chat attachments. */
export const MAX_FILE_IMAGE_CONTEXT_BYTES = 12 * 1024 * 1024;

/** Newest file images retained in model history; older files remain available to read again. */
export const MAX_FILE_IMAGE_CONTEXT_COUNT = 4;

/** Replacement for pixels discarded from model history. The immutable file is still readable. */
export const ELIDED_FILE_IMAGE = "Older image pixels omitted from model history. Read the file again if needed.";

/** Pixels omitted after a provider rejected image data; the original file is unchanged. */
export const REJECTED_FILE_IMAGE = "Image pixels omitted because the provider could not decode an image in this request. Convert or replace the file before reading it again.";

// Gemini's SDK can report a nested JSON error without an HTTP-status prefix.
const NestedImageError = z.object({error: z.object({
  code: z.union([z.literal(400), z.literal(422)]), message: z.string(),
})});

/** Only definite image-data errors merit removing pixels; never hide other request failures. */
export function isImageDecodeError(message: string, status: number | undefined): boolean {
  // Responses can fail within an HTTP 200 SSE stream; its explicit error code is authoritative.
  if (/^(?:Error Code )?image_parse_error:/.test(message)) return true;
  try {
    const nested = NestedImageError.safeParse(JSON.parse(message));
    if (nested.success) {
      status = nested.data.error.code;
      message = nested.data.error.message;
    }
  } catch { /* Other adapters use plain error text. */ }
  return (status === 400 || status === 422) &&
    /invalid image (?:data|content|format)\b|(?:could not|cannot|unable to|failed to) (?:decode|process) (?:the |an? )?(?:input )?image|image[^\n]{0,160}(?:could not be decoded|cannot be decoded|is corrupt)/i.test(message);
}

/** Recognize supported images without loading or encoding the payload. */
export function fileImageMimeType(reader: BlobReader): string | undefined {
  const head = reader.read(0, Math.min(12, reader.size));
  let mimeType: string;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    mimeType = "image/png";
  } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    mimeType = "image/jpeg";
  } else if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 &&
      new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true) + 8 === reader.size) {
    mimeType = "image/webp";
  } else {
    return undefined;
  }
  return mimeType;
}

/** Load pixels only after the caller has admitted the read against its count/byte budget. */
export function readFileImage(reader: BlobReader, mimeType = fileImageMimeType(reader)): ImageContent | undefined {
  if (mimeType === undefined) return undefined;
  if (reader.size > MAX_FILE_IMAGE_BYTES) {
    throw new Error("Image exceeds 4 MiB. Resize or crop it in the worktree before reading it.");
  }
  const bytes = reader.read(0, reader.size);
  // OpenAI's original/auto detail rejects images above 30,000 32px patches rather than
  // resizing them. Bound resolution before persisting a successful read, preserving coordinates
  // and fine detail for accepted images instead of silently selecting a downsampled detail level.
  if (!canInlineChatAttachmentImage(mimeType, bytes, 8000, 30_000)) {
    throw new Error("Image header is unsupported, dimensions exceed 8000 pixels, or resolution exceeds 30,000 32px patches. Resize, crop or convert the file first.");
  }
  return { type: "image", data: bytes.toBase64(), mimeType };
}
