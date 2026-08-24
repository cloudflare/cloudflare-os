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
  if (!query.trim()) {
    throw new Error("Gmail search query must not be empty.");
  }
  // oxlint-disable-next-line no-control-regex -- provider grammar and approval rendering guard
  if (/[\x00-\x1f\x7f]/.test(query)) {
    throw new Error("Gmail search query must not contain control characters.");
  }
  if (utf8Bytes(query) > MAX_GMAIL_QUERY_BYTES) {
    throw new Error(`Gmail search query must be at most ${MAX_GMAIL_QUERY_BYTES} bytes.`);
  }
  // Gmail does not document backslash escaping precisely enough for us to mirror it safely.
  // Reject it rather than risk parsing a binding wrapper differently from the provider.
  if (query.includes("\\")) {
    throw new Error("Gmail search query must not contain backslashes.");
  }
  const stack: string[] = [];
  let quoted = false;
  for (const char of query) {
    if (char === '"') {
      quoted = !quoted;
    } else if (quoted) {
      continue;
    } else if (char === "(" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "}") {
      if (stack.pop() !== (char === ")" ? "(" : "{")) {
        throw new Error("Gmail query has mismatched grouping delimiters.");
      }
    }
  }
  if (quoted || stack.length > 0) {
    throw new Error("Gmail query has unterminated grouping or quotes.");
  }
}

/** Combine a binding restriction and caller query without allowing either to escape its group. */
export function combineGmailQueries(
    bindingQuery: string | undefined, callerQuery: string | undefined): string | undefined {
  if (bindingQuery !== undefined) validateGmailQueryForGrouping(bindingQuery);
  if (callerQuery !== undefined) validateGmailQueryForGrouping(callerQuery);

  const base = bindingQuery?.trim();
  const caller = callerQuery?.trim();
  if (caller && /^(?:AND|OR)\b/i.test(caller)) {
    throw new Error("Gmail search query cannot start with AND or OR.");
  }
  if (caller && /\b(?:AND|OR)$/i.test(caller)) {
    throw new Error("Gmail search query cannot end with AND or OR.");
  }

  const effective = base && caller
    ? `(${base}) AND (${caller})`
    : base || caller || undefined;
  // Wrappers and the explicit operator count toward Gmail's actual request limit.
  if (effective !== undefined) validateGmailQueryForGrouping(effective);
  return effective;
}

/** Rejects a label name that is empty or over the byte limit. */
export function validateGmailLabelName(labelName: string): void {
  // oxlint-disable-next-line no-control-regex -- label names are rendered into approval text
  if (!labelName.trim() || /[\x00-\x1f\x7f]/.test(labelName) ||
      utf8Bytes(labelName) > MAX_GMAIL_LABEL_BYTES) {
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
  if (body.includes("\0")) throw new Error("Email body must not contain NUL bytes.");
  if (utf8Bytes(body) > MAX_GMAIL_BODY_BYTES) {
    throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
  }
}

/** Keep the complete staged body safely below one Durable Object storage value. */
export function validateGmailBodyAlternatives(text: string, html?: string): void {
  validateGmailBody(text);
  if (html !== undefined) validateGmailBody(html);
  if (utf8Bytes(text) + utf8Bytes(html ?? "") > MAX_GMAIL_BODY_BYTES) {
    throw new Error(
      `Plain-text and HTML email bodies must total at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
  }
}

/** Rejects a recipient list that is empty or over the count limit. */
export function validateGmailRecipientCount(to: readonly string[]): void {
  if (to.length === 0 || to.length > MAX_GMAIL_RECIPIENTS) {
    throw new Error(`Email must have between 1 and ${MAX_GMAIL_RECIPIENTS} recipients.`);
  }
}

/** Drafts may have no recipients yet, but still enforce the aggregate upper bound. */
export function validateGmailRecipientMaximum(recipients: readonly string[]): void {
  if (recipients.length > MAX_GMAIL_RECIPIENTS) {
    throw new Error(`Email must have at most ${MAX_GMAIL_RECIPIENTS} recipients.`);
  }
}

export function validateGmailSubject(subject: string): void {
  // oxlint-disable-next-line no-control-regex -- prevents RFC header injection
  if (/[\x00-\x1f\x7f]/.test(subject) || utf8Bytes(subject) > MAX_GMAIL_SUBJECT_BYTES) {
    throw new Error(
      `Email subject must be at most ${MAX_GMAIL_SUBJECT_BYTES} UTF-8 bytes and contain no control characters.`);
  }
}

/** Rejects any out-of-bounds field of an outbound message. */
export function validateOutboundInput(to: string[], subject: string, body: string): void {
  validateGmailRecipientCount(to);
  for (const address of to) validateGmailAddress(address);
  validateGmailSubject(subject);
  validateGmailBody(body);
}

/** Validate an aggregate To/CC/BCC recipient set and both body alternatives. */
export function validateOutboundFields(
    recipients: {to: string[]; cc: string[]; bcc: string[]}, subject: string, text: string,
    html?: string): void {
  const all = [...recipients.to, ...recipients.cc, ...recipients.bcc];
  validateGmailRecipientCount(all);
  for (const address of all) validateGmailAddress(address);
  validateGmailSubject(subject);
  validateGmailBodyAlternatives(text, html);
}
