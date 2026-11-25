// The readFile tool's result content: a line window of text (line-window.ts), or an image the
// model can see. Like readFileWindow, it is the one renderer for the live tool and for history
// replay, which re-renders a recorded read from its blob rather than storing what the model saw,
// so the same bytes must always produce the same content.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  CHAT_ATTACHMENT_SIGNATURE_BYTES, imageDimensions, imageMimeTypeOf, MAX_INLINE_ATTACHMENT_BYTES,
} from "./chat-attachment-validation";
import { readFileWindow, type LineSource, type ReadFileWindow } from "./line-window";

/**
 * The longest side, in pixels, of an image readFile shows: Anthropic's limit for requests of up to
 * MAX_INLINE_ATTACHMENTS images, which replay counts image reads toward as it counts attachments.
 * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 */
export const MAX_READ_FILE_IMAGE_EDGE = 8000;

/**
 * Renders a readFile result as the exact content the model sees. A stored file that begins with a
 * PNG, JPEG or WebP signature is an image: it is shown as itself (preceded by a line giving its
 * type and size), and `imageBytes` gives its size. Reading one with a line window, with a model
 * that can't view images (`showImages` false), or past the byte or pixel bounds is an error, as
 * is a header too damaged to give its size. Every other read is the text window readFileWindow
 * renders.
 */
export function readFileResult(source: LineSource, window: ReadFileWindow, path: string,
                               maxChars: number, showImages = true)
    : { content: (TextContent | ImageContent)[], imageBytes?: number } {
  let reader = source.kind === "blob" ? source.reader : undefined;
  let mimeType = reader &&
      imageMimeTypeOf(reader.read(0, Math.min(reader.size, CHAT_ATTACHMENT_SIGNATURE_BYTES)));
  if (reader === undefined || mimeType === undefined) {
    return { content: [{ type: "text", text: readFileWindow(source, window, path, maxChars) }] };
  }
  if (window.startLine !== undefined || window.lineCount !== undefined) {
    throw new Error(`${path} is an image, which has no lines: omit startLine and lineCount to ` +
        "view it.");
  }
  if (!showImages) {
    throw new Error(`${path} is an image, which this model can't view. Choose a model that ` +
        "takes images to see it.");
  }
  if (reader.size > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error(`${path} is ${reader.size} bytes, too large to view as an image ` +
        `(the limit is ${MAX_INLINE_ATTACHMENT_BYTES} bytes).`);
  }
  let bytes = reader.read(0, reader.size);
  let dimensions = imageDimensions(mimeType, bytes);
  if (dimensions === undefined || !dimensions.every(edge => edge > 0)) {
    throw new Error(`${path} begins like an image (${mimeType}), but its header is unreadable.`);
  }
  let [width, height] = dimensions;
  if (width > MAX_READ_FILE_IMAGE_EDGE || height > MAX_READ_FILE_IMAGE_EDGE) {
    throw new Error(`${path} is a ${width}x${height} image, too large to view: readFile ` +
        `shows images up to ${MAX_READ_FILE_IMAGE_EDGE} pixels on each side.`);
  }
  return {
    content: [
      { type: "text", text: `${path}: ${mimeType}, ${width}x${height} pixels` },
      { type: "image", data: bytes.toBase64(), mimeType },
    ],
    imageBytes: reader.size,
  };
}
