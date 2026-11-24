import type { ClipboardPayload, BillowDocument, ItemRegistry } from "./types.js";
import { deserializeDocument, documentToPlainText, serializeDocument } from "./model.js";

export const CLIPBOARD_MIME = "application/x-cloudflare-billow+json";
export const MAX_CLIPBOARD_METADATA_BYTES = 1024 * 1024;

export function createClipboardPayload<Registry extends ItemRegistry>(document: BillowDocument<Registry>, registry: Registry): ClipboardPayload {
  return {
    plainText: documentToPlainText(document, registry),
    metadata: JSON.stringify(serializeDocument(document, registry)),
  };
}

export function parseClipboardMetadata<Registry extends ItemRegistry>(
  metadata: string,
  registry: Registry,
  createId?: () => string,
): BillowDocument<Registry> | null {
  try {
    if (!metadata) return null;
    if (metadata.length > MAX_CLIPBOARD_METADATA_BYTES
      || new TextEncoder().encode(metadata).byteLength > MAX_CLIPBOARD_METADATA_BYTES) return null;
    const value: unknown = JSON.parse(metadata);
    return createId
      ? deserializeDocument(value, registry, createId)
      : deserializeDocument(value, registry);
  } catch {
    return null;
  }
}
