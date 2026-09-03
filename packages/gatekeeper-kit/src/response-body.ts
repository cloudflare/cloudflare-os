/** Strict byte-capped response-body decoding. */

import { requirePositiveInt } from "./positive-int";

/** Default maximum response size: 1 MiB. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Thrown when a body exceeds the cap. Callers re-wrap it in their own provider error type. */
export class ResponseTooLargeError extends Error {}

/**
 * Reads a response body up to a byte limit. Oversized bodies are rejected rather than truncated and
 * cancelled immediately; `Content-Length` is only an early check, not the authority.
 * @param response Response to consume.
 * @param maxBytes Maximum body bytes.
 * @returns The decoded response text.
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
  response: Response, maxBytes: number = MAX_RESPONSE_BYTES,
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
