// How a gadget's uncaught exception is shaped and bounded before it is kept: the text an entry
// keeps (redacted, then cut), the entry made of an exception of the gadget's server and of one a
// browser reported, and the limit on how many are kept for one gadget.

import {
  MAX_GADGET_ERROR_TEXT_LENGTH, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH,
  type ConsoleLogEvent, type GadgetErrorEntry, type ReportedGadgetError, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { cutAdminAuditText } from "./admin-access.js";

// --- Redaction ---

const REDACTED = "[redacted]";

// A credential holds an upper-case letter or a digit; the words that follow "bearer" or "sk-" in
// ordinary text ("the bearer responsibilities", "sk-learn-contrib") hold neither.
const isTokenLike = (token: string) => /[A-Z\d]/.test(token);

// How a name ends when its value is a secret: "access_token", "clientSecret", "X-Amz-Signature",
// "SecretAccessKey". The URL parameter pattern and both member patterns are built from it.
const SECRET_NAME_END =
    /(?:token|secret|passw(?:or)?d|signature|credential|(?:api|private|secret|access)[_-]?key)/
        .source;
const SECRET_MEMBER_NAME =
    `(?:[\\w.-]*${SECRET_NAME_END}|(?:proxy-)?authorization|(?:set-)?cookie)`;
// A URL query or fragment parameter named like a secret, or by one of the short names that carry
// one ("code", "sig", "key"), alone or after a separator. Its value ends before an "&", a "#", a
// space, a double quote or an angle bracket, so that what follows a URL in JSON or in markup is
// kept. It does not end at an apostrophe, which encodeURIComponent() leaves in a value as it is.
const SECRET_PARAMETER = new RegExp(
    `((?:[?&#]|&amp;)(?:[\\w.~%-]*${SECRET_NAME_END}|` +
        `(?:[\\w.~%-]*[._-])?(?:key|sig|code|auth|jwt|pwd|session(?:id)?))=)[^&#\\s"<>]+`,
    "gi");
// A member of plain JSON: its value runs to the closing quote, escaped characters included.
const SECRET_MEMBER = new RegExp(`("${SECRET_MEMBER_NAME}"\\s*:\\s*")(?:[^"\\\\]|\\\\.)+`, "gi");
// A member of JSON held in a JSON string, once or twice over, where a run of backslashes precedes
// every quote: its value runs to the closing quote, which follows the same run as the opening one,
// escaped characters included. An escape in the value is that run and one more backslash, then the
// character: a quote or a backslash after the run again, any other as it is.
const ESCAPED_SECRET_MEMBER = new RegExp(
    `("${SECRET_MEMBER_NAME}\\\\{1,3}"\\s*:\\s*(\\\\{1,3})")` +
        `(?:[^"\\\\]|\\2\\\\(?:\\2["\\\\]|[^"\\\\]))+`,
    "gi");

// Where a token that is known by its shape may start: not directly after a letter or digit,
// because "task-force" is a word and "keyJoinColumns" an identifier, unless that letter or digit
// ends an escape, which stands for the character that was there. An error message that quotes
// JSON holds it as it was written, where a token on a line of its own follows a backslash and an
// "n", and a token inside an encoded URL follows "%3D" or "%20". A `\b` here would miss both, and
// a token after an underscore as well. No lookbehind reads back more than six characters, so each
// costs a constant.
const TOKEN_START =
    /(?:(?<![A-Za-z\d])|(?<=%[\dA-Fa-f]{2})|(?<=\\(?:[bfnrt]|u[\dA-Fa-f]{4})))/.source;
// "Bearer <token>", "Basic <credentials>"
const BEARER_OR_BASIC = new RegExp(`${TOKEN_START}(Bearer|Basic)(\\s+)([\\w.~+/=-]{16,})`, "gi");
// JSON Web Tokens, whole or cut short, and any other base64 of a JSON object. A segment after the
// first may be empty, as the key of a directly encrypted token is.
const JSON_WEB_TOKEN = new RegExp(`${TOKEN_START}eyJ[\\w-]{8,}(?:\\.[\\w-]*){0,4}`, "g");
// sk-..., sk_live_...
const SK_KEY = new RegExp(`${TOKEN_START}sk[-_][\\w-]{16,}`, "g");

// A PEM private key. Its BEGIN and END lines are kept and what is between them is replaced, so
// that redacting again changes nothing. With no END line the match runs to the end of the text, so
// that a key the read bound cut is still replaced. There is one run of label characters before
// "PRIVATE KEY" and none after it: two adjacent runs are quadratic on "PRIVATE KEYPRIVATE KEY...".
const PRIVATE_KEY =
    /(-----BEGIN [A-Z\d ]*PRIVATE KEY(?: BLOCK)?-----)[\s\S]*?(-----END [A-Z\d ]*PRIVATE KEY|$)/g;

// The password in a URL's user information, scheme://user:password@host. The user name and the
// password may each hold "@" (an address as a user name, say), and the password ends at the last
// one before the path, as a URL parser reads it. Neither holds a double quote, so that a URL in
// compact JSON is not read on into the members after it. The pattern starts at the literal "://":
// one that began with the scheme's letters would rescan every run of letters and dots.
const URL_PASSWORD = /(:\/\/[^\s/?#:"]*:)[^\s/?#"]+(?=@)/g;

/**
 * `text` with token-shaped strings replaced by "[redacted]": bearer and basic credentials, `sk-`
 * secret keys, JSON Web Tokens, PEM private keys, the password in a URL's user information, and
 * the values of URL parameters and JSON members named like a secret. A backstop for a credential
 * that an error message holds, applied before an entry's text is cut: each pattern matches a
 * token from its start through all that follows of it, so one that runs past the kept length is
 * replaced whole. It errs towards redacting, so some ordinary text that has one of these shapes
 * goes too. Linear in the length of `text`.
 */
export function redactGadgetErrorText(text: string): string {
  // Whether what follows "bearer", "basic" or "sk-" is a credential is decided in a callback: a
  // lookahead doing the same would be quadratic on "sk-sk-sk-...".
  //
  // The member patterns come before the parameter pattern. A parameter's value takes backslashes
  // and ends at a quote, so where an escaped quote follows it the escape's backslash is replaced
  // with it and the quote is left bare: a member's value would then end there, and the rest of it
  // be kept. The patterns before them replace a JSON escape whole or not at all.
  return text
      .replace(BEARER_OR_BASIC,
          (match, scheme: string, gap: string, token: string) =>
              isTokenLike(token) ? `${scheme}${gap}${REDACTED}` : match)
      .replace(JSON_WEB_TOKEN, REDACTED)
      .replace(SK_KEY, match => isTokenLike(match.slice(3)) ? REDACTED : match)
      .replace(PRIVATE_KEY, `$1${REDACTED}$2`)
      .replace(URL_PASSWORD, `$1${REDACTED}`)
      .replace(SECRET_MEMBER, `$1${REDACTED}`)
      .replace(ESCAPED_SECRET_MEMBER, `$1${REDACTED}`)
      .replace(SECRET_PARAMETER, `$1${REDACTED}`);
}

// --- Text ---

// The characters of the tokens that are known by their length: a bearer or basic credential, an
// `sk-` key, a JSON Web Token.
const TOKEN_CHARACTER = /[\w.~+/=-]/;

/**
 * An error's text as an entry keeps it (see GadgetErrorEntry.text): redacted, then cut with its
 * cut marked, and well-formed UTF-16. At most MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH characters
 * are read. Text that reaches that bound may stop inside a credential, with too little of it left
 * for a pattern to know it, so its last run of token characters is dropped, with any URL password
 * left unfinished before it, and it is marked as cut however short redaction leaves it.
 */
export function gadgetErrorText(text: string): string {
  let read = text.slice(0, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH);

  // Text that reaches the bound may stop inside a credential before a pattern can know it: a
  // token known by its length, or a URL's password, known by the "@" after it. Redaction can
  // shorten what precedes it by more than is kept, which would bring that fragment into the kept
  // text, so the last run of token characters goes, and with it what is left of such a password.
  // The run is found by a loop from the end: a pattern anchored at the end would rescan from every
  // start. The password's remains are taken with the characters the password pattern takes, "@"
  // included, since a password may hold one and text that stops after it may still be inside.
  let bounded = text.length >= MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH;
  if (bounded) {
    let end = read.length;
    while (end > 0 && TOKEN_CHARACTER.test(read[end - 1])) end--;
    read = read.slice(0, end).replace(/(:\/\/[^\s/?#:"]*:)[^\s/?#"]+$/, "$1");
  }

  // Bounded text is not all there was: the added "…" marks it where redaction leaves it short of
  // the kept length, and is cut away with the rest where it does not.
  let redacted = redactGadgetErrorText(read);
  return cutAdminAuditText(bounded ? `${redacted}…` : redacted, MAX_GADGET_ERROR_TEXT_LENGTH)
      .toWellFormed();
}

/**
 * What a marker says of `count` errors that were dropped instead of kept: "1 error dropped",
 * "37 errors dropped". Every marker is worded by this.
 */
export function droppedGadgetErrorsText(count: number): string {
  return count === 1 ? "1 error dropped" : `${count} errors dropped`;
}

// --- Entries ---

/**
 * The entry kept for one exception of a gadget's server, which `event` carries as the one value
 * of its message: a string as it is, anything else (what a gadget threw that was neither an
 * Error nor a string) named by its kind, "[object Object]", without reading it. Its time is the
 * event's.
 */
export function serverGadgetErrorEntry(
    gadgetId: WorkpieceId, chatId: number | null, event: ConsoleLogEvent): GadgetErrorEntry {
  // Neither JSON.stringify() nor String() is applied to a thrown value: each costs what the
  // thrower chose.
  let thrown: unknown = event.message[0];
  let text = typeof thrown === "string" ? thrown : Object.prototype.toString.call(thrown);
  return {
    time: Number.isNaN(event.timestamp.getTime()) ? new Date() : event.timestamp,
    gadgetId, chatId, source: "server",
    text: gadgetErrorText(text),
  };
}

/**
 * The entry kept for one error that `userId`'s browser reported in a call that arrived at
 * `receivedAt`, which is the entry's time. Only `reported.text` is read: whatever else a browser
 * put there is ignored.
 */
export function clientGadgetErrorEntry(
    gadgetId: WorkpieceId, chatId: number | null, userId: string,
    reported: ReportedGadgetError, receivedAt: Date): GadgetErrorEntry {
  // Built field by field: validation lets members it does not know through, so a spread could
  // carry a `source`, a `userId` or a `time` the browser chose.
  return {
    time: receivedAt,
    gadgetId, chatId, source: "client", userId,
    text: gadgetErrorText(reported.text),
  };
}

// --- Rate limit ---

/** How many errors a GadgetErrorLimiter lets one gadget keep in a minute. */
export const GADGET_ERRORS_PER_MINUTE = 30;

// One gadget's current minute.
type GadgetErrorWindow = {
  // When the window started, in milliseconds.
  start: number;

  // How many errors were admitted in it.
  admitted: number;

  // How many of the gadget's errors were dropped and are not yet counted by a marker.
  unmarked: number;

  // Whether a marker was asked for in it.
  marked: boolean;
};

/**
 * Bounds what is kept per gadget to `limit` errors in each one-minute window, which starts at the
 * gadget's first error after its last window ended, and counts what it drops so that a marker can
 * say how many. The budget is the gadget's, whoever its errors come from: where browsers report
 * them, one viewer whose copy throws in a loop can use it up for everyone else viewing the gadget
 * until the minute ends.
 */
export class GadgetErrorLimiter {
  // Kept in memory, as the user object's count of notification-service calls is, so a restart
  // forgets at most one window: what it admitted, and the drops no marker has counted.
  #windows = new Map<WorkpieceId, GadgetErrorWindow>();
  #limit: number;

  /** `limit` is how many errors one gadget may keep in a minute. */
  constructor(limit: number = GADGET_ERRORS_PER_MINUTE) {
    this.#limit = limit;
  }

  /**
   * Takes `offered` errors for `gadgetId` at `now` (milliseconds). `admitted` is how many to
   * keep, from the first: at most `cap`, and at most what is left of the gadget's minute.
   * `dropped`, when positive, is how many errors to mark as dropped: all of the gadget's that
   * were dropped and not yet marked, this call's included. A gadget is marked at most once a
   * minute, so later drops wait for the first call of its next minute.
   */
  admit(gadgetId: WorkpieceId, offered: number, now: number, cap: number = offered)
      : { admitted: number; dropped: number } {
    if (offered === 0) return { admitted: 0, dropped: 0 };

    let window = this.#windows.get(gadgetId);
    if (window === undefined || now - window.start >= 60_000) {
      window = { start: now, admitted: 0, unmarked: window?.unmarked ?? 0, marked: false };
      this.#windows.set(gadgetId, window);
    }

    let admitted = Math.max(0, Math.min(offered, cap, this.#limit - window.admitted));
    window.admitted += admitted;
    window.unmarked += offered - admitted;

    let dropped = 0;
    if (window.unmarked > 0 && !window.marked) {
      dropped = window.unmarked;
      window.unmarked = 0;
      window.marked = true;
    }
    return { admitted, dropped };
  }

  /**
   * Counts `dropped` errors of `gadgetId` as not yet marked again, for a marker that admit()
   * asked for and that could not be written: the gadget's next marker counts them. The gadget is
   * still marked at most once a minute, and what was admitted with them stays counted against
   * its minute.
   */
  unmark(gadgetId: WorkpieceId, dropped: number): void {
    let window = this.#windows.get(gadgetId);
    if (window !== undefined) window.unmarked += dropped;
  }
}
