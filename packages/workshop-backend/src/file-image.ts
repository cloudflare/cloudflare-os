import type {ImageContent} from "@earendil-works/pi-ai";
import {canInlineChatAttachmentImage, MAX_INLINE_ATTACHMENT_BYTES} from "./chat-attachment-validation";
import type {BlobReader} from "./git-chunked-blob";

/** Recognize file images by bytes, leaving other files on readFile's existing text path. */
export function fileImageMimeType(reader: BlobReader): string | undefined {
  const head = reader.read(0, Math.min(12, reader.size));
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 &&
      new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true) + 8 === reader.size) return "image/webp";
  return undefined;
}

/** Load a bounded image using the same formats and dimension guard as uploaded attachments. */
export function readFileImage(reader: BlobReader): ImageContent | undefined {
  const mimeType = fileImageMimeType(reader);
  if (!mimeType) return undefined;
  if (reader.size > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error("Image exceeds the inline attachment size limit. Crop or resize it before reading.");
  }
  const bytes = reader.read(0, reader.size);
  if (!canInlineChatAttachmentImage(mimeType, bytes)) {
    throw new Error("Image header is unsupported or dimensions exceed 8000 pixels. Crop, resize or convert it first.");
  }
  return {type: "image", mimeType, data: bytes.toBase64()};
}
