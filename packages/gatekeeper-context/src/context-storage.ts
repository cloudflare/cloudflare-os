import { Buffer } from "node:buffer";
import { isTextContentType } from "./context-types.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function decodeStoredContextBody(
  contentType: string,
  body: string | Uint8Array,
): string {
  if (typeof body === "string") return body;
  return isTextContentType(contentType)
    ? textDecoder.decode(body)
    : Buffer.from(body).toString("base64");
}

export function encodeStoredContextBody(contentType: string, body: string): Uint8Array {
  return isTextContentType(contentType)
    ? textEncoder.encode(body)
    : new Uint8Array(Buffer.from(body, "base64"));
}
