import { z } from "zod";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { inlineChatAttachmentImageDimensions } from "./chat-attachment-validation";
import type { BlobReader } from "./git-chunked-blob";

/** Maximum bytes read into one model image, matching the chat attachment limit. */
export const MAX_FILE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Raw-byte budget for file images, after reserving space for existing chat attachments. */
export const MAX_FILE_IMAGE_CONTEXT_BYTES = 12 * 1024 * 1024;

/** Newest file images retained in model history; older files remain available to read again. */
export const MAX_FILE_IMAGE_CONTEXT_COUNT = 4;

/** Replacement for pixels discarded from model history. The immutable file is still readable. */
export const ELIDED_FILE_IMAGE = "Older image pixels omitted from model history. Read the file again if needed.";

/** A bounded overflow retry omits file pixels for this execution without rejecting the source. */
export const OVERFLOW_FILE_IMAGE = "Image pixels omitted for this turn after the provider's context limit was exceeded. The original file is unchanged. Reduce text/image context before rereading in a fresh turn.";

/** A text-only model keeps the immutable reference for a later switch to a vision model. */
export const UNSUPPORTED_FILE_IMAGE = "Image pixels omitted because the selected model does not support images. Switch to a vision model to inspect this file.";

/** Pixels omitted after a provider rejected image data; the original file is unchanged. */
export const REJECTED_FILE_IMAGE = "Image pixels omitted because the provider rejected an image in this request. The original file is unchanged.";

// Request-local metadata, rebuilt on replay. Keep it off the model payload and durable chat.
const admittedDimensions = new WeakMap<ImageContent, [number, number]>();
export function admittedImageDimensions(image: ImageContent): [number, number] | undefined {
  return admittedDimensions.get(image);
}
export function withImageDimensions(image: ImageContent, dimensions: [number, number]): ImageContent {
  admittedDimensions.set(image, dimensions);
  return image;
}

/** Claude's content frame, shared by coordinate descriptions and visual-token accounting. */
export function claudeImageFrame(dimensions: [number, number], model: Model<Api>): [number, number] | undefined {
  const [width, height] = dimensions;
  // Claude documents its native resize rule. Other providers and routed/aliased models must
  // not inherit a guessed coordinate frame. Keep this aligned with:
  // https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
  const version = /claude[-.](?:opus|sonnet|haiku)[-.](\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(model.id);
  if (model.api !== "anthropic-messages" || !version) return undefined;
  const highResolution = Number(version[1]) > 4 ||
    (Number(version[1]) === 4 && Number(version[2] ?? 0) >= 7);
  const edge = highResolution ? 2576 : 1568, tokens = highResolution ? 4784 : 1568;
  const fits = (w: number, h: number) => Math.ceil(w / 28) * 28 <= edge &&
    Math.ceil(h / 28) * 28 <= edge && Math.ceil(w / 28) * Math.ceil(h / 28) <= tokens;
  let resizedWidth = width, resizedHeight = height;
  if (!fits(width, height)) {
    // Search the long edge, preserving aspect ratio, exactly as Claude's reference helper.
    const landscape = width >= height, long = Math.max(width, height), short = Math.min(width, height);
    const aspectRatio = long / short;
    // Python's round() in the documented helper uses ties-to-even, unlike Math.round().
    const shortEdge = (value: number) => {
      const scaled = value / aspectRatio, floor = Math.floor(scaled);
      return Math.max(1, scaled - floor === 0.5 ? floor + floor % 2 : Math.round(scaled));
    };
    let low = 1, high = long;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(mid, shortEdge(mid))) low = mid;
      else high = mid;
    }
    [resizedWidth, resizedHeight] = landscape
      ? [low, shortEdge(low)]
      : [shortEdge(low), low];
  }
  return [resizedWidth, resizedHeight];
}

/** Explain the pixel frame for file images; providers can resize otherwise unchanged bytes. */
export function fileImageDescription(image: ImageContent, model: Model<Api>): string {
  const dimensions = admittedImageDimensions(image);
  if (!dimensions) return "Image file. Provider coordinate mapping unavailable; crop/resize within the selected model's native vision limits before using pixel coordinates.";
  const [width, height] = dimensions;
  const source = `Image file. Source: ${width} x ${height} pixels.`;
  const frame = claudeImageFrame(dimensions, model);
  if (!frame) return source +
    " Provider coordinate mapping unavailable: pixels may be resized. Before coordinate-sensitive actions, crop/resize within the selected model's native vision limits and retain the scale and crop offset back to the source; prefer semantic element targeting when available.";
  const [resizedWidth, resizedHeight] = frame;
  return source + ` Claude content frame: ${resizedWidth} x ${resizedHeight} pixels before bottom/right padding.` +
    ` Map model pixel (x,y) to source (x * ${width}/${resizedWidth}, y * ${height}/${resizedHeight}); do not scale by padded dimensions.` +
    " For screen input, also apply the screenshot's crop origin and desktop/DPI transform. Normalize image orientation before coordinate-sensitive use.";
}

const ImageDataErrorCode = z.enum([
  "image_parse_error", "invalid_image", "invalid_image_format", "invalid_image_mode", "invalid_base64_image",
  "unsupported_image_media_type", "empty_image_file",
]);
const OpenAIImageError = z.object({code: z.string()});
// Responses and Chat Completions adapters wrap the same structured error differently.
const IMAGE_ERROR_ENVELOPE = /^(?:OpenAI API error \((?:400|422)\)|(?:400|422)):\s*/;

// Gemini's SDK can report a nested JSON error without an HTTP-status prefix.
const NestedImageError = z.object({error: z.object({
  code: z.union([z.literal(400), z.literal(422)]), message: z.string(),
})});

/** An explicit image-policy refusal must be surfaced without retrying the turn. */
export function isImagePolicyError(message: string): boolean {
  if (/^(?:Error Code )?image_content_policy_violation:/.test(message)) return true;
  const envelope = IMAGE_ERROR_ENVELOPE.exec(message);
  if (!envelope) return false;
  try {
    const body = OpenAIImageError.safeParse(JSON.parse(message.slice(envelope[0].length)));
    return body.success && body.data.code === "image_content_policy_violation";
  } catch { return false; }
}

/** Only definite image-data errors merit removing pixels; never hide other request failures. */
export function isImageDecodeError(message: string, status: number | undefined, provider?: string): boolean {
  // Ollama wraps WebP decoder errors with a stable prefix; PNG/JPEG use llama.cpp's
  // multimodal loader error. Scope both HTTP 500 cases to Ollama, never generic server errors.
  if (provider === "ollama" && status === 500 &&
      /\bdecode WebP image:|\bFailed to load image or audio file\b/i.test(message)) return true;
  // Responses can fail within an HTTP 200 SSE stream; its explicit error code is authoritative.
  const streamCode = /^(?:Error Code )?([a-z0-9_]+):/.exec(message)?.[1];
  if (ImageDataErrorCode.safeParse(streamCode).success) return true;
  try {
    // The same adapter wraps a structured JSON error on HTTP 400/422 instead of SSE failure.
    const envelope = IMAGE_ERROR_ENVELOPE.exec(message);
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

/** Load pixels after count/byte checks and optional header-only admission, such as visual token cost. */
export function readFileImage(
    reader: BlobReader, mimeType = fileImageMimeType(reader),
    admit?: (image: ImageContent) => boolean): ImageContent | undefined {
  if (mimeType === undefined) return undefined;
  if (reader.size > MAX_FILE_IMAGE_BYTES) {
    throw new Error("Image exceeds 4 MiB. Resize or crop it in the worktree before reading it.");
  }
  // OpenAI's original/auto detail rejects images above 30,000 32px patches rather than
  // resizing them. Bound resolution before persisting a successful read. Preserve original
  // bytes here; fileImageDescription explains provider resizing before coordinate use.
  const dimensions = inlineChatAttachmentImageDimensions(mimeType, reader, 8000, 30_000);
  if (!dimensions) {
    throw new Error("Image header is unsupported, dimensions exceed 8000 pixels, or resolution exceeds 30,000 32px patches. Resize, crop or convert the file first.");
  }
  const image = withImageDimensions({type: "image", data: "", mimeType}, dimensions);
  if (admit && !admit(image)) return undefined;
  image.data = reader.read(0, reader.size).toBase64();
  return image;
}
