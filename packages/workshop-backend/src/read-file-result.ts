// The readFile tool's result content: a line window of text (line-window.ts), or an image the
// model can see. Like readFileWindow, it is the one renderer for the live tool and for history
// replay, which re-renders a recorded read from its blob rather than storing what the model saw,
// so the same bytes must always produce the same content.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { imageDimensions, MAX_INLINE_ATTACHMENT_BYTES } from "./chat-attachment-validation";
import { readFileWindow, type LineSource, type ReadFileWindow } from "./line-window";

/**
 * The longest side, in pixels, of an image readFile shows: Anthropic's limit for requests of up to
 * MAX_INLINE_ATTACHMENTS images, which replay counts image reads toward as it counts attachments.
 * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 */
export const MAX_READ_FILE_IMAGE_EDGE = 8000;

// How much of a file too large to show is searched for an image header, to tell an oversized
// image (an error saying so) from a mislabeled file (read as text).
const IMAGE_HEADER_PREFIX = 64 * 1024;

const IMAGE_EXTENSIONS = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

/**
 * The image MIME type a path's extension names, among those readFile can show; undefined for any
 * other path. The extension only nominates a file: its header must also match (readFileResult).
 */
export function readFileImageMimeType(path: string): string | undefined {
  let match = /\.([^./]+)$/.exec(path);
  return match ? IMAGE_EXTENSIONS.get(match[1].toLowerCase()) : undefined;
}

/**
 * Renders a readFile result as the exact content the model sees. A stored file whose extension
 * names a supported image type, and whose header confirms it, is shown as that image (preceded
 * by a line giving its type and size) when no line window is asked for, and `imageBytes` gives
 * its size; one over the byte or pixel bounds is an error. Every other read, including a windowed
 * read of an image and a file whose header does not match its extension, is the text window
 * readFileWindow renders.
 */
export function readFileResult(source: LineSource, window: ReadFileWindow, path: string,
                               maxChars: number)
    : { content: (TextContent | ImageContent)[], imageBytes?: number } {
  let mimeType = readFileImageMimeType(path);
  if (source.kind === "blob" && mimeType !== undefined &&
      window.startLine === undefined && window.lineCount === undefined) {
    let { reader } = source;
    let tooBig = reader.size > MAX_INLINE_ATTACHMENT_BYTES;
    // An oversized file's header is looked for in its first bytes only; a JPEG whose header lies
    // beyond them falls through to the text window, which reports it as binary.
    let bytes = reader.read(0, tooBig ? IMAGE_HEADER_PREFIX : reader.size);
    let dimensions = imageDimensions(mimeType, bytes);
    if (dimensions !== undefined && dimensions.every(edge => edge > 0)) {
      let [width, height] = dimensions;
      if (tooBig) {
        throw new Error(`${path} is ${reader.size} bytes, too large to view as an image ` +
            `(the limit is ${MAX_INLINE_ATTACHMENT_BYTES} bytes).`);
      }
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
  }
  return { content: [{ type: "text", text: readFileWindow(source, window, path, maxChars) }] };
}
