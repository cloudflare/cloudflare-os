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

/** A text-only model keeps the immutable reference for a later switch to a vision model. */
export const UNSUPPORTED_FILE_IMAGE = "Image pixels omitted because the selected model does not support images. Switch to a vision model to inspect this file.";

/** Pixels omitted after a provider rejected image data; the original file is unchanged. */
export const REJECTED_FILE_IMAGE = "Image pixels omitted because the provider rejected an image in this request. The original file is unchanged.";

const ImageDataErrorCode = z.enum([
  "image_parse_error", "invalid_image", "invalid_image_format", "invalid_image_mode", "invalid_base64_image",
  "unsupported_image_media_type", "empty_image_file",
]);
const OpenAIImageError = z.object({code: z.string()});

// Gemini's SDK can report a nested JSON error without an HTTP-status prefix.
const NestedImageError = z.object({error: z.object({
  code: z.union([z.literal(400), z.literal(422)]), message: z.string(),
})});

/** An explicit image-policy refusal must be surfaced without retrying the turn. */
export function isImagePolicyError(message: string): boolean {
  if (/^(?:Error Code )?image_content_policy_violation:/.test(message)) return true;
  const envelope = /^OpenAI API error \((?:400|422)\):\s*/.exec(message);
  if (!envelope) return false;
  try {
    const body = OpenAIImageError.safeParse(JSON.parse(message.slice(envelope[0].length)));
    return body.success && body.data.code === "image_content_policy_violation";
  } catch { return false; }
}

/** Only definite image-data errors merit removing pixels; never hide other request failures. */
export function isImageDecodeError(message: string, status: number | undefined): boolean {
  // Responses can fail within an HTTP 200 SSE stream; its explicit error code is authoritative.
  const streamCode = /^(?:Error Code )?([a-z0-9_]+):/.exec(message)?.[1];
  if (ImageDataErrorCode.safeParse(streamCode).success) return true;
  try {
    // The same adapter wraps a structured JSON error on HTTP 400/422 instead of SSE failure.
    const envelope = /^OpenAI API error \((?:400|422)\):\s*/.exec(message);
    const body: unknown = JSON.parse(envelope ? message.slice(envelope[0].length) : message);
    if (envelope) {
      const error = OpenAIImageError.safeParse(body);
      if (error.success && ImageDataErrorCode.safeParse(error.data.code).success) return true;
    }
    const nested = NestedImageError.safeParse(body);
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
  // OpenAI's original/auto detail rejects images above 30,000 32px patches rather than
  // resizing them. Bound resolution before persisting a successful read, preserving coordinates
  // and fine detail for accepted images instead of silently selecting a downsampled detail level.
  if (!canInlineChatAttachmentImage(mimeType, reader, 8000, 30_000)) {
    throw new Error("Image header is unsupported, dimensions exceed 8000 pixels, or resolution exceeds 30,000 32px patches. Resize, crop or convert the file first.");
  }
  return { type: "image", data: reader.read(0, reader.size).toBase64(), mimeType };
}
