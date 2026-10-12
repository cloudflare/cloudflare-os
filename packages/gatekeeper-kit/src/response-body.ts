/** Byte-capped body decoding: strict whole-body reads, and best-effort prefixes for error text. */

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

/**
 * Decodes at most the first `maxBytes` bytes of a body as UTF-8, for best-effort decoration of an
 * error already being raised -- an excerpt of an oversized HTML error page, say. Unlike
 * `readTextCapped`, a longer body is truncated rather than refused, and `Content-Length` is
 * ignored. The chunk crossing the cap is sliced, so nothing past it is decoded or kept; a cut
 * inside a character ends in U+FFFD. The rest of the body is cancelled.
 *
 * Never throws for the body itself: a missing, used, or locked body, a failed read, or a failed
 * cancel yields whatever decoded before it, possibly `""`. Only an invalid `maxBytes` throws.
 *
 * The excerpt is provider-authored and travels with the error into logs and issue reports, and
 * redacting it is unsound: the cut can end inside a secret the far side echoed, or inside one of
 * its characters as U+FFFD, and the head left behind matches nothing. Where a body may echo a
 * credential, read it whole with `readTextCapped`, fall back to the status when that refuses, and
 * redact before cutting for display.
 * @param body Response or request to consume.
 * @param maxBytes Maximum bytes decoded; a positive safe integer.
 * @returns The decoded prefix.
 *
 * @example
 * ```ts
 * if (!response.ok) {
 *   const detail = (await readTextPrefix(response, 200)).trim();
 *   throw new VendorApiError(response.status, detail || response.statusText);
 * }
 * ```
 */
export async function readTextPrefix(body: Request | Response, maxBytes: number): Promise<string> {
  requirePositiveInt("maxBytes", maxBytes);
  const decoder = new TextDecoder();
  let text = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = body.body?.getReader();
    for (let left = maxBytes; left > 0;) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      const { value } = chunk;
      const kept = value.subarray(0, left);
      left -= kept.byteLength;
      text += decoder.decode(kept, { stream: true });
    }
  } catch {
    // Decoration must not replace the error being raised; keep what arrived.
  } finally {
    // A no-op on a finished stream; on a live one it stops the transfer past the cap.
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
  return text + decoder.decode();
}
