// Two gatekeepers arrived at the same capped reader independently, each missing half of it:
// mcp-shared streams without checking the advertised length (`mcp-shared/src/fetch.ts:60-100`),
// cloudflare checks it but leaks the reader lock when a chunk throws
// (`gatekeeper-cloudflare/src/observability-api.ts:219-253`). This is both.

import { requirePositiveInt } from "./positive-int";

/** Refused body size. 1 MiB is what both existing readers chose. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Thrown when a body exceeds the cap. Callers re-wrap it in their own provider error type. */
export class ResponseTooLargeError extends Error {}

/**
 * Reads a response body as text, refusing one larger than `maxBytes`.
 *
 * Refused rather than truncated: half a JSON document does not parse, and a clipped SSE stream can
 * lose the very event carrying the response, which would surface as a confusing protocol error
 * instead of the size problem it is. The body is cancelled on refusal so the transfer stops rather
 * than running to completion unread.
 *
 * A provider that advertises the overage in `Content-Length` is refused before a byte is read; one
 * that lies, omits it, or streams `chunked` is caught by the running total. Both paths are needed:
 * the header is untrusted, and waiting for the stream wastes the transfer when it was honest.
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
  // Decoded as it arrives rather than buffered and joined: a multi-byte character split across two
  // chunks is carried over by `stream: true`, and nothing holds a second copy of the whole body.
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
  // Flushes a trailing partial sequence as U+FFFD, exactly as a one-shot decode of the whole body
  // would have.
  return text + decoder.decode();
}
