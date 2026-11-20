// The client every request to Google goes through (`@gadgets/gatekeeper-kit/upstream`): it times
// each attempt, sends a request that is safe to send twice again after a transient failure, and
// counts each attempt as one subservice metric point under the source `gatekeeper.google.api`.
// What is Google's own is declared here: the service and the name of a request, which answers
// are a success, and which are sent again.

import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { googleOperation, googleService } from "./call-metrics";

/**
 * The names given where a request is made, to one whose URL does not say what it does: a token's
 * exchange and its refresh share a URL, a batch is of any request, a library fetches the keys a
 * push is signed with, and Google makes the URL of an operation to poll, of a thumbnail and of
 * an upload session.
 */
export const NAMED_OPERATIONS = [
  "token.exchange", "token.refresh", "certs.get", "files.get.batch", "operations.get",
  "thumbnail.download", "upload.send", "upload.getStatus", "upload.cancel",
] as const;

/** A name given where a request is made: one of `NAMED_OPERATIONS`. */
export type NamedOperation = (typeof NAMED_OPERATIONS)[number];

/**
 * The Google gatekeeper's upstream. A request is named from its method and URL
 * (`googleOperation`), counted under the service its URL belongs to (`googleService`), given 30
 * seconds an attempt unless it says otherwise, and follows no redirect unless it says so.
 *
 * A request that is safe to send twice (a GET, or one marked `idempotent`) is sent again after a
 * 429 and after any 5xx, three times at most. Neither says whether the request took effect
 * before its answer, so a write is sent once.
 */
export const googleUpstream = defineUpstream({
  vendorId: "google",
  service: googleService,
  operation: googleOperation,
  // Only what differs from the client's rule, by which a request that follows no redirect has
  // succeeded below 300, and one that follows them below 400.
  succeeded(status, operation) {
    switch (operation) {
      // Drive asks for more of an upload with a 308, which is no redirect and no failure.
      case "upload.send": case "upload.getStatus": return status === 308 ? true : undefined;
      // And answers the cancel of an upload session with a 499 once it has cancelled it. Any
      // other answer to the cancel below 400 is its success, a redirect included.
      case "upload.cancel": return status < 400 || status === 499;
      default: return undefined;
    }
  },
  retry: {
    retryable: (status, request) =>
      request.idempotent && (status === 429 || (status >= 500 && status <= 599)),
  },
});

/**
 * Milliseconds an attempt may take where a request moves the bytes of a file, a message or an
 * attachment in one answer or one body, which the client's 30 seconds would cut short.
 */
export const TRANSFER_TIMEOUT_MS = {
  /** Bytes read whole from Google: an attachment, or a message with its bodies in it. */
  download: 60_000,
  /** Bytes sent whole to Google, or a file Google converts before it answers. */
  upload: 120_000,
} as const;
