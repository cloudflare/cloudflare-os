/**
 * Input limits and validators for Gmail-facing arguments.
 *
 * Separate from `google.ts` so the resource-URL parser and the session both reach them without a
 * cycle, and so the boundaries are unit-testable.
 */

/** Maximum recipients on a single outbound message. */
export const MAX_GMAIL_RECIPIENTS = 100;
/** Maximum subject length, in UTF-8 bytes (RFC 5322 line limit). */
export const MAX_GMAIL_SUBJECT_BYTES = 998;
/** Maximum body length, in UTF-8 bytes. */
export const MAX_GMAIL_BODY_BYTES = 64 * 1024;
/** Maximum search query length, in UTF-8 bytes. */
export const MAX_GMAIL_QUERY_BYTES = 4096;
/** Maximum email address length, in UTF-8 bytes (RFC 3696 path limit). */
export const MAX_GMAIL_ADDRESS_BYTES = 320;
/** Maximum label name length, in UTF-8 bytes. */
export const MAX_GMAIL_LABEL_BYTES = 320;
/** Maximum messages returned for a single thread. */
export const MAX_GMAIL_VISIBLE_THREAD_MESSAGES = 100;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Rejects a query whose quotes or grouping delimiters are unbalanced.
 *
 * A binding may restrict a session to a base query, which is then combined with the caller's as
 * `(base) (caller)`. An unterminated quote or bracket in either would swallow the other's
 * parentheses and let the caller escape the restriction.
 */
export function validateGmailQueryForGrouping(query: string): void {
  if (utf8Bytes(query) > MAX_GMAIL_QUERY_BYTES) {
    throw new Error(`Gmail search query must be at most ${MAX_GMAIL_QUERY_BYTES} bytes.`);
  }
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (const char of query) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "}") {
      if (stack.pop() !== (char === ")" ? "(" : "{")) {
        throw new Error("Gmail query has mismatched grouping delimiters.");
      }
    }
  }
  if (quote || stack.length > 0) {
    throw new Error("Gmail query has unterminated grouping or quotes.");
  }
}

/** Rejects a label name that is empty or over the byte limit. */
export function validateGmailLabelName(labelName: string): void {
  if (!labelName || utf8Bytes(labelName) > MAX_GMAIL_LABEL_BYTES) {
    throw new Error(`Gmail label name must be between 1 and ${MAX_GMAIL_LABEL_BYTES} bytes.`);
  }
}

/** Rejects an address that is empty or over the byte limit. */
export function validateGmailAddress(address: string): void {
  if (!address || utf8Bytes(address) > MAX_GMAIL_ADDRESS_BYTES) {
    throw new Error(`Email address must be at most ${MAX_GMAIL_ADDRESS_BYTES} bytes.`);
  }
}

/** Rejects a body over the byte limit. */
export function validateGmailBody(body: string): void {
  if (utf8Bytes(body) > MAX_GMAIL_BODY_BYTES) {
    throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
  }
}

/** Rejects a recipient list that is empty or over the count limit. */
export function validateGmailRecipientCount(to: readonly string[]): void {
  if (to.length === 0 || to.length > MAX_GMAIL_RECIPIENTS) {
    throw new Error(`Email must have between 1 and ${MAX_GMAIL_RECIPIENTS} recipients.`);
  }
}

/** Rejects any out-of-bounds field of an outbound message. */
export function validateOutboundInput(to: string[], subject: string, body: string): void {
  validateGmailRecipientCount(to);
  for (const address of to) validateGmailAddress(address);
  if (utf8Bytes(subject) > MAX_GMAIL_SUBJECT_BYTES) {
    throw new Error(`Email subject must be at most ${MAX_GMAIL_SUBJECT_BYTES} UTF-8 bytes.`);
  }
  validateGmailBody(body);
}
