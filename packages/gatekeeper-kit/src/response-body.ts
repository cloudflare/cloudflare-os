/** Strict byte-capped body decoding. */

import { requirePositiveInt } from "./positive-int";

/** Default maximum response size: 1 MiB. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Thrown when a body exceeds the cap. Callers re-wrap it in their own provider error type. */
export class ResponseTooLargeError extends Error {}

/**
 * Reads a response body, or an inbound request body such as a connect form, up to a byte limit.
 * Oversized bodies are rejected rather than truncated and cancelled immediately; `Content-Length`
 * is only an early check, not the authority.
 * @param response Response or request to consume.
 * @param maxBytes Maximum body bytes.
 * @returns The decoded body text.
 *
 * @example
 * ```ts
 * const response = await fetch(endpoint);
 * const payload = parseVendorResponse(
 *   await readTextCapped(response, 256 * 1024),
 * );
 * ```
 */
export async function readTextCapped(
  response: Request | Response, maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  requirePositiveInt("maxBytes", maxBytes);
  const tooLarge = `The server's response exceeded ${maxBytes} bytes.`;

  if (!response.body) return "";

  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(tooLarge);
  }

  const reader = response.body.getReader();
  // Stream decoding handles split characters without buffering a second body copy.
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(tooLarge);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  // Flush a trailing partial sequence as U+FFFD, matching one-shot decoding.
  return text + decoder.decode();
}

/**
 * Reads a response body as raw bytes up to a byte limit, with the same rules as `readTextCapped`:
 * an oversized body is rejected with `ResponseTooLargeError` and cancelled as soon as the limit
 * is passed, so the bound holds on what the Worker buffers, not on what the server sent.
 * @param response Response or request to consume.
 * @param maxBytes Maximum body bytes.
 * @returns The body bytes.
 */
export async function readBytesCapped(
  response: Request | Response, maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  requirePositiveInt("maxBytes", maxBytes);
  const tooLarge = `The server's response exceeded ${maxBytes} bytes.`;

  if (!response.body) return new Uint8Array();

  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(tooLarge);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(tooLarge);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
