import { formatAttachmentSize } from "../../attachmentFormatting";

export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MAX_EDGE = 1568;
// The lossless PNG encoder ignores it.
const CHAT_ATTACHMENT_IMAGE_QUALITY = 0.85;

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Failed to encode image.")),
      type,
      quality,
    );
  });

export const prepareChatAttachment = async (
  file: File,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (!file.type.startsWith("image/")) {
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
      );
    }
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `Images must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES)} or smaller before resizing.`,
    );
  }

  const bitmap = await createImageBitmap(file);
  try {
    const supportedOriginalType = file.type === "image/jpeg" || file.type === "image/png" ||
      file.type === "image/webp";
    if (supportedOriginalType && file.size <= MAX_CHAT_ATTACHMENT_BYTES &&
        Math.max(bitmap.width, bitmap.height) <= CHAT_ATTACHMENT_IMAGE_MAX_EDGE) {
      return { blob: file, mimeType: file.type };
    }

    const scale = Math.min(1, CHAT_ATTACHMENT_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to get 2D canvas context.");
    context.drawImage(bitmap, 0, 0, width, height);

    // Retaining PNG/WebP avoids losing transparency. A resized PNG photograph can still exceed the
    // cap, so it falls back to WebP, then to JPEG for browsers such as Safari that encode WebP
    // requests as PNG.
    const outputMimeType = supportedOriginalType ? file.type : "image/jpeg";
    const encodings = outputMimeType === "image/png"
      ? ["image/png", "image/webp", "image/jpeg"]
      : [outputMimeType];
    for (const type of encodings) {
      const blob = await canvasToBlob(canvas, type, CHAT_ATTACHMENT_IMAGE_QUALITY);
      if (blob.size <= MAX_CHAT_ATTACHMENT_BYTES) return { blob, mimeType: blob.type || type };
    }
    throw new Error(
      `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
    );
  } finally {
    bitmap.close();
  }
};
