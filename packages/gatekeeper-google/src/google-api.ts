// Basic helpers talking to Google API
//
// This file was largely vibe-coded based on an interface spec.

import { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  EmailAddress, GmailAttachmentInfo, GmailComposeOptions, GmailHeader, GmailReplyOptions,
} from "./types";
import { createMimeMessage } from "mimetext/browser";
import PostalMime, { addressParser } from "postal-mime";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

/**
 * Internal type for parsed message info with raw label IDs (not yet resolved
 * to GmailLabel objects). The stub layer resolves labels via the label map.
 */
export type GmailMessageInfoRaw = {
  id: string;
  threadId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  timestamp: Date;
  labelIds: string[];
};

export type GmailThreadInfoRaw = {
  id: string;
  snippet?: string;
  subject: string;
  messageCount: number;
  timestamp: Date;
  participants: EmailAddress[];
  unread: boolean;
  labelIds: string[];
};

export type GmailNormalizedRecipients = {
  to: string[];
  cc: string[];
  bcc: string[];
};

export type GmailOutboundAttachment = {
  filename: string;
  contentType: string;
  data: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
  description: string;
};

export type GmailOutboundSpec = GmailNormalizedRecipients & {
  from: string;
  replyTo?: string[];
  date?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  attachments: GmailOutboundAttachment[];
};

export type GmailOutboundMessage = {
  raw: string;
  from: string;
  replyTo: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  attachments: GmailOutboundAttachment[];
};

export type GoogleAccessToken = {
  token: string;
  expires: Date;
};

export type GoogleOAuthGrant = {
  refreshToken: string;
  accessToken: GoogleAccessToken;
  grantedScopes: string[];
};

/** `signal` lets the caller bound the round trip; UserAccount holds the credential mutex across this. */
export async function exchangeAuthCode(
    code: string, clientId: string, clientSecret: string, redirectUri: string,
    signal?: AbortSignal)
    : Promise<GoogleOAuthGrant> {
  let params = new URLSearchParams();
  params.set("code", code);
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("redirect_uri", redirectUri);
  params.set("grant_type", "authorization_code");

  let response = await fetch(
      "https://oauth2.googleapis.com/token",
      {method: "POST", body: params, ...(signal ? { signal } : {})});

  let contentType = response.headers.get("Content-Type");
  let isJson = contentType && contentType.startsWith("application/json");

  if (!response.ok) {
    if (isJson) {
      let body = await response.json<any>();
      throw new Error(`Failed to obtain refresh token: ${body.error} ${body.error_description}`);
    } else {
      throw new Error(
          `Failed to obtain refresh token: ${response.status} ${response.statusText}`);
    }
  }

  if (!isJson) {
    throw new Error("Token endpoint didn't return JSON?");
  }

  let body = await response.json<any>();

  return {
    accessToken: {
      token: body.access_token,
      expires: new Date(Date.now() + body.expires_in * 1000),
    },
    refreshToken: body.refresh_token,
    grantedScopes: typeof body.scope === "string"
        ? body.scope.split(" ").filter(Boolean)
        : [],
  };
}

export type RefreshFailure =
  | { ok: false; reason: "revoked" }
  | { ok: false; reason: "policyBlocked"; detail: string };

export type AccessTokenResult = { ok: true; token: GoogleAccessToken } | RefreshFailure;

/** Exchange a refresh token for an access token. `signal` lets the caller bound the round trip */
export async function getAccessToken(
    refreshToken: string, clientId: string, clientSecret: string, signal?: AbortSignal)
    : Promise<AccessTokenResult> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    let contentType = response.headers.get("Content-Type");
    let isJson = contentType && contentType.startsWith("application/json");

    if (isJson) {
      let body = await response.json<{error?: string, error_description?: string}>();
      if (body.error === "invalid_grant") {
        return { ok: false, reason: "revoked" };
      }
      if (body.error === "admin_policy_enforced") {
        return { ok: false, reason: "policyBlocked",
                 detail: body.error_description ?? "admin_policy_enforced" };
      }
      throw new Error(
          `Failed to refresh access token: ${body.error} ${body.error_description}`);
    }

    let errorText = await readErrorText(response);
    throw new Error(`Failed to refresh access token: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  return {
    ok: true,
    token: {
      token: data.access_token,
      expires: new Date(Date.now() + data.expires_in * 1000),
    },
  };
}

type GoogleAccountProfile = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

async function getGoogleAccountProfile(accessToken: string): Promise<GoogleAccountProfile> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as Partial<GoogleAccountProfile>;
  if (!data.sub) throw new Error("Google user info did not include a stable account ID.");
  return data as GoogleAccountProfile;
}

/** Return the stable Google subject used to pin long-lived Gmail capabilities to one account. */
export async function getGoogleAccountSubject(accessToken: string): Promise<string> {
  return (await getGoogleAccountProfile(accessToken)).sub;
}

export async function getGoogleAccountDescription(accessToken: string)
    : Promise<AccountDescription> {
  const data = await getGoogleAccountProfile(accessToken);

  // Mapping the response to our specific interface
  return {
    displayName: data.name,
    uniqueName: data.email,
    avatar: {url: data.picture ?? ""},
  };
}

/**
 * Fetch the account's email for use as a sign-in identity, but only if Google reports it as
 * verified (`email_verified`). Returns null otherwise, so the Workshop never keys an account by an
 * unverified address.
 */
export async function getGoogleVerifiedEmail(accessToken: string): Promise<string | null> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
  }

  let data: any = await response.json();
  if (!data.email || data.email_verified !== true) return null;
  return data.email;
}

/** `signal` lets the caller bound the round trip; UserAccount holds the credential mutex across this. */
export async function revokeGoogleToken(
    refreshToken: string, signal?: AbortSignal): Promise<void> {
  // Although we are revoking the token anyway, it's nice to avoid ever putting tokens in the
  // URL, so we instead use the format where the URL is in the POST body.
  const body = new URLSearchParams();
  body.append('token', refreshToken);

  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });

  let contentType = response.headers.get("Content-Type");
  let isJson = contentType && contentType.startsWith("application/json");

  if (response.ok) {
    // Read response body to be polite, but we don't really need it.
    await response.text();
  } else if (isJson) {
    let body = await response.json<{error: string}>();
    if (response.status === 400 && body.error === "invalid_token") {
      // Token may have been revoked previously, or may have never been valid. We don't really
      // know. But for the sake of idempotency, treat this as success.
    } else {
      throw new Error(`Failed to revoke token: ${body.error}`);
    }
  } else {
    throw new Error(`Failed to revoke token: ${response.status} ${response.statusText}`);
  }
}

// =======================================================================================
// Gmail API
// =======================================================================================

/** Minimal thread data; message MIME is fetched lazily by message capabilities. */
export type GmailThreadRaw = {
  id: string;
  snippet: string;
  messages: Array<{ id: string; threadId: string }>;
};

/**
 * Message data from Gmail API when using format=raw. The `raw` field
 * contains the full RFC 2822 MIME message as a base64url-encoded string,
 * which postal-mime parses into structured headers and body content.
 */
export type GmailMessageRaw = {
  id: string;
  threadId: string;
  labelIds?: string[];
  raw: string;
  internalDate: string;
};

export type GmailMessageRef = {
  id: string;
  threadId: string;
  snippet?: string;
};

export type GmailPayloadPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{name: string; value: string}>;
  body?: {attachmentId?: string; size?: number; data?: string};
  parts?: GmailPayloadPart[];
};

export type GmailMessageFull = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  sizeEstimate?: number;
  payload?: GmailPayloadPart;
};

export type GmailAttachmentSnapshot = {
  key: string;
  messageId: string;
  attachmentId?: string;
  inlineData?: string;
  info: GmailAttachmentInfo;
};

export type GmailDraftRaw = {
  id: string;
  message: GmailMessageRaw;
};

export type GmailDraftFull = {
  id: string;
  message: GmailMessageFull;
};

export type GmailDraftRef = {
  id: string;
  message?: {id: string; threadId?: string};
};

export type GmailLabelRaw = {
  id: string;
  name: string;
  type: "system" | "user";
};

// Metadata-only thread response (format=metadata). Used by getThreadInfo()
// to avoid downloading full message payloads.
type GmailThreadMetadata = {
  id: string;
  snippet?: string;
  historyId?: string;
  messages?: GmailMessageFull[];
};

// Decode a base64url-encoded string to raw bytes.
/** Maximum attachment content exposed through Gmail capabilities. */
export const MAX_GMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Conservative raw-message ceiling aligned with Gmail's documented 25 MB personal limit. */
export const MAX_GMAIL_FORWARD_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_GMAIL_MESSAGE_HEADERS = 256;
const MAX_GMAIL_MESSAGE_HEADER_BYTES = 128 * 1024;

function boundedGmailHeaders<T>(headers: Iterable<T>, convert: (header: T) => GmailHeader): GmailHeader[] {
  const encoder = new TextEncoder();
  const result: GmailHeader[] = [];
  let totalBytes = 0;
  for (const source of headers) {
    if (result.length === MAX_GMAIL_MESSAGE_HEADERS) {
      throw new Error(`Gmail message has more than ${MAX_GMAIL_MESSAGE_HEADERS} headers.`);
    }
    const header = convert(source);
    const remainingBytes = MAX_GMAIL_MESSAGE_HEADER_BYTES - totalBytes;
    // UTF-8 uses at least one byte per UTF-16 code unit, so reject obviously oversized values
    // before TextEncoder allocates an equally unbounded byte array.
    if (header.name.length + header.value.length > remainingBytes) {
      throw new Error(
        `Gmail message headers exceed the ${MAX_GMAIL_MESSAGE_HEADER_BYTES}-byte safe-read limit.`);
    }
    const encodedBytes = encoder.encode(header.name).byteLength +
      encoder.encode(header.value).byteLength;
    if (encodedBytes > remainingBytes) {
      throw new Error(
        `Gmail message headers exceed the ${MAX_GMAIL_MESSAGE_HEADER_BYTES}-byte safe-read limit.`);
    }
    totalBytes += encodedBytes;
    result.push(header);
  }
  return result;
}

/** Return the exact decoded byte length of valid padded or unpadded base64url data. */
export function base64UrlDecodedByteLength(data: string): number {
  const match = /^([A-Za-z0-9_-]*)(={0,2})$/.exec(data);
  if (!match || match[0].length !== data.length) throw new Error("Invalid base64url data.");
  const contentLength = match[1].length;
  const paddingLength = match[2].length;
  const remainder = contentLength % 4;
  if (remainder === 1 || (paddingLength > 0 &&
      (data.length % 4 !== 0 || paddingLength !== 4 - remainder))) {
    throw new Error("Invalid base64url padding.");
  }
  if (remainder === 2 || remainder === 3) {
    const sextet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      .indexOf(match[1].at(-1)!);
    const unusedBits = remainder === 2 ? 4 : 2;
    if ((sextet & ((1 << unusedBits) - 1)) !== 0) {
      throw new Error("Invalid base64url padding bits.");
    }
  }
  return Math.floor(contentLength * 3 / 4);
}

function base64UrlToBase64(data: string): string {
  base64UrlDecodedByteLength(data);
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

export function decodeBase64UrlToBytes(data: string): Uint8Array {
  const binary = atob(base64UrlToBase64(data));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

class UnsafeMimeReconstructionError extends Error {}

const parsedMimeReconstructionErrors = new WeakMap<import("postal-mime").Email, string>();

/**
 * Parse a format=raw Gmail message from bytes, preserving per-part charset decoding.
 */
export async function parseMimeMessage(raw: string): Promise<import("postal-mime").Email> {
  const bytes = decodeBase64UrlToBytes(raw);
  try {
    const parsed = await PostalMime.parse(bytes);
    try {
      const metadata = extractMimeAttachmentMetadata(bytes);
      if (metadata.length === parsed.attachments.length &&
          metadata.every((item, index) => {
            const attachment = parsed.attachments[index];
            return baseMimeType(item.contentType) === baseMimeType(attachment.mimeType) &&
              item.disposition === (attachment.disposition?.toLowerCase() ?? null) &&
              item.contentId === normalizeMimeContentId(attachment.contentId);
          })) {
        parsedAttachmentMetadata.set(parsed, metadata);
      }
    } catch (error) {
      if (error instanceof UnsafeMimeReconstructionError) {
        parsedMimeReconstructionErrors.set(parsed, error.message);
      }
      // Body/header reads can still use PostalMime. Attachment-preserving writes fail closed below.
    }
    return parsed;
  } catch {
    // Parser errors may quote malformed header or body content; keep them safe for server logs.
    throw new Error("Unable to parse Gmail MIME message.");
  }
}

function parseAddressList(
    value: string, options?: import("postal-mime").AddressParserOptions): import("postal-mime").Address[] {
  try {
    return addressParser(value, options);
  } catch {
    throw new Error("Unable to parse an email address list.");
  }
}

// Convert a postal-mime Address to our EmailAddress type.
function postalAddressToEmailAddress(addr: import("postal-mime").Address): EmailAddress {
  if (addr.address) {
    return addr.name ? { address: addr.address, name: addr.name } : { address: addr.address };
  }
  // Group address — take the first mailbox, or fall back to the group name.
  const first = addr.group?.[0];
  if (first?.address) {
    return first.name ? { address: first.address, name: first.name } : { address: first.address };
  }
  return { address: '', name: addr.name };
}

function postalAddressListToEmailAddresses(addrs: import("postal-mime").Address[] | undefined): EmailAddress[] {
  if (!addrs) return [];
  const result: EmailAddress[] = [];
  for (const addr of addrs) {
    if (addr.address) {
      result.push(addr.name ? { address: addr.address, name: addr.name } : { address: addr.address });
    } else if (addr.group) {
      for (const mb of addr.group) {
        result.push(mb.name ? { address: mb.address, name: mb.name } : { address: mb.address });
      }
    }
  }
  return result;
}

function parseEmailRecipient(input: string): EmailAddress {
  // oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (header-injection guard)
  if (/[\x00-\x1f\x7f]/.test(input)) {
    throw new Error("Email addresses must not contain control characters.");
  }
  const parsed = parseAddressList(input);
  if (parsed.length !== 1 || !parsed[0].address || parsed[0].group) {
    throw new Error("Expected exactly one recipient mailbox.");
  }
  const address = parsed[0].address.trim();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1 || address.length > 320 || /[<>\s,;]/.test(address)) {
    throw new Error("Invalid recipient mailbox.");
  }
  const name = parsed[0].name?.trim();
  return name ? {address, name} : {address};
}

function formatEmailAddress(value: EmailAddress): string {
  if (!value.name) return value.address;
  return `"${value.name.replace(/(["\\])/g, "\\$1")}" <${value.address}>`;
}

/** Parse a normalized recipient while retaining its display name for public metadata. */
export function emailRecipientToAddress(input: string): EmailAddress {
  return parseEmailRecipient(input);
}

function parseEmailRecipients(inputs: string[]): EmailAddress[] {
  const result: EmailAddress[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const recipient = parseEmailRecipient(input);
    const key = recipient.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(recipient);
    }
  }
  return result;
}

export function normalizeEmailRecipients(inputs: string[]): string[] {
  return parseEmailRecipients(inputs).map(formatEmailAddress);
}

/**
 * Canonicalize and de-duplicate recipients across all three delivery fields.
 * Earlier fields win, so an address can never be emitted in To and again in CC/BCC.
 */
export function normalizeAggregateRecipients(
    to: string[] = [], cc: string[] = [], bcc: string[] = []): GmailNormalizedRecipients {
  const seen = new Set<string>();
  const normalizeField = (values: string[]) => parseEmailRecipients(values).filter(recipient => {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(formatEmailAddress);
  return {
    to: normalizeField(to),
    cc: normalizeField(cc),
    bcc: normalizeField(bcc),
  };
}

const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
// Gmail search has its own operators and grouping syntax. Keep reconciliation IDs to the small
// dot-atom subset without search delimiters that cannot introduce a second term when interpolated
// into `q`. Domain literals and other obsolete forms fail closed.
const GMAIL_QUERY_MESSAGE_ID_RE =
  /^<[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`|~-]*@[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`|~-]*>$/;
const MAX_SUBJECT_BYTES = 998;
const MAX_REFERENCES_BYTES = 4096;
const MAX_GMAIL_DRAFT_LOOKUP_PAGES = 20;

function validateMessageId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!MESSAGE_ID_RE.test(trimmed) || new TextEncoder().encode(trimmed).byteLength > MAX_SUBJECT_BYTES) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

/** Return a Message-ID only when it is safe to use as a Gmail `rfc822msgid:` query value. */
export function gmailMessageIdQueryValue(value: string): string {
  const messageId = validateMessageId(value, "Message-ID");
  if (!GMAIL_QUERY_MESSAGE_ID_RE.test(messageId)) {
    throw new Error("Message-ID cannot be used safely in a Gmail search query.");
  }
  return messageId.slice(1, -1);
}

function foldReferenceTokens(tokens: string[]): string {
  let lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current && current.length + 1 + token.length > 76) {
      lines.push(current);
      current = token;
    } else {
      current = current ? `${current} ${token}` : token;
    }
  }
  if (current) lines.push(current);
  return lines.join('\r\n ');
}

function parseReferenceTokens(references: string, enforceBudget = true): string[] {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < references.length) {
    while (offset < references.length && /\s/.test(references[offset]!)) offset++;
    if (offset === references.length) break;
    if (references[offset] !== "<") throw new Error("Invalid References header.");
    const end = references.indexOf(">", offset + 1);
    if (end < 0) throw new Error("Invalid References header.");
    const token = references.slice(offset, end + 1);
    tokens.push(validateMessageId(token, "References header"));
    offset = end + 1;
    if (offset < references.length && !/\s/.test(references[offset]!)) {
      throw new Error("Invalid References header.");
    }
  }
  if (tokens.length === 0 || (enforceBudget &&
      new TextEncoder().encode(foldReferenceTokens(tokens)).byteLength > MAX_REFERENCES_BYTES)) {
    throw new Error("Invalid References header.");
  }
  return tokens;
}

function normalizeReferences(references: string): string {
  return foldReferenceTokens(parseReferenceTokens(references));
}

function foldReferences(references: string | undefined, parentId: string): string {
  let valid: string[] = [];
  if (references) {
    try {
      valid = parseReferenceTokens(references, false);
    } catch {
      // A malformed provider header contributes no history; the current parent remains enough to
      // thread the reply safely.
    }
  }
  const bounded = valid.length > 20
    ? [valid[0], ...valid.slice(-18)]
    : valid;
  const tokens = [...bounded.filter(token => token !== parentId), parentId];
  while (new TextEncoder().encode(foldReferenceTokens(tokens)).byteLength > MAX_REFERENCES_BYTES) {
    if (tokens.length === 1) throw new Error("Invalid source Message-ID.");
    // Retain the oldest reference and newest context for as long as the byte budget permits.
    tokens.splice(tokens.length > 2 ? 1 : 0, 1);
  }
  return foldReferenceTokens(tokens);
}

function normalizeTextBody(body: string): string {
  if (body.includes('\0')) throw new Error("Email body must not contain NUL bytes.");
  return body.replace(/\r\n|\r|\n/g, '\r\n');
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodeHeaderWords(value: string): string[] {
  // Keep each encoded-word comfortably under RFC 2047's 75-character limit,
  // splitting only between Unicode code points.
  const chunks: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (chunk && new TextEncoder().encode(chunk + char).byteLength > 36) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk += char;
    }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks.map(chunkValue => `=?utf-8?B?${utf8ToBase64(chunkValue)}?=`);
}

function encodeSubjectHeader(subject: string): string {
  const words = encodeHeaderWords(subject);
  return `Subject: ${words[0]}${words.slice(1).map(word => `\r\n ${word}`).join('')}`;
}

function encodeMailboxHeader(values: string[]): string {
  return normalizeEmailRecipients(values).map(value => {
    const mailbox = parseEmailRecipient(value);
    return mailbox.name
      ? `${encodeHeaderWords(mailbox.name).join("\r\n ")} <${mailbox.address}>`
      : mailbox.address;
  }).join(",\r\n ");
}

function replaceMailboxHeader(raw: string, name: string, values: string[]): string {
  const header = `${name}: ${encodeMailboxHeader(values)}`;
  const pattern = new RegExp(`^${name}:[^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*`, "mi");
  if (!pattern.test(raw)) throw new Error(`Unable to encode the ${name} address header safely.`);
  return raw.replace(pattern, header);
}

function validateAttachmentHeaderValue(value: string, label: string): string {
  // oxlint-disable-next-line no-control-regex -- guards MIME attachment header construction
  if (/[\x00-\x1f\x7f]/.test(value) ||
      new TextEncoder().encode(value).byteLength > MAX_SUBJECT_BYTES) {
    throw new Error(`Invalid attachment ${label}.`);
  }
  return value;
}

function validateDateHeader(value: string): string {
  // oxlint-disable-next-line no-control-regex -- guards RFC 5322 header construction
  if (/[^\t\x20-\x7e]/.test(value) || new TextEncoder().encode(value).byteLength > 998 ||
      !Number.isFinite(new Date(value).valueOf())) {
    throw new Error("Invalid email Date header.");
  }
  return value;
}

function validateAttachmentContentType(value: string): string {
  return serializeParameterizedMimeHeader(parseParameterizedMimeHeader(value, true));
}

function baseMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

type MimeParameter = {name: string; value: string};
type ParameterizedMimeHeader = {value: string; parameters: MimeParameter[]};

const MIME_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function parseParameterizedMimeHeader(
    input: string, contentType = false): ParameterizedMimeHeader {
  // oxlint-disable-next-line no-control-regex -- MIME headers must never carry injected line breaks
  if (/[^\t\x20-\x7e]/.test(input) || input.length > 8192) {
    throw new Error("Invalid attachment content type.");
  }
  input = stripMimeComments(input);
  let offset = 0;
  const skipWhitespace = () => {
    while (input[offset] === " " || input[offset] === "\t") offset++;
  };
  skipWhitespace();
  const valueStart = offset;
  while (offset < input.length && input[offset] !== ";") offset++;
  const value = input.slice(valueStart, offset).trim().toLowerCase();
  if (contentType) {
    const [type, subtype, extra] = value.split("/");
    if (!type || !subtype || extra !== undefined ||
        !MIME_TOKEN_RE.test(type) || !MIME_TOKEN_RE.test(subtype)) {
      throw new Error("Invalid attachment content type.");
    }
  } else if (!MIME_TOKEN_RE.test(value)) {
    throw new Error("Invalid MIME structured header.");
  }

  const parameters: MimeParameter[] = [];
  while (offset < input.length) {
    offset++;
    skipWhitespace();
    const nameStart = offset;
    while (offset < input.length && input[offset] !== "=" && input[offset] !== ";" &&
        input[offset] !== " " && input[offset] !== "\t") offset++;
    const name = input.slice(nameStart, offset).toLowerCase();
    skipWhitespace();
    if (!MIME_TOKEN_RE.test(name) || input[offset] !== "=") {
      throw new Error(contentType
        ? "Invalid attachment content type."
        : "Invalid MIME structured header.");
    }
    offset++;
    skipWhitespace();
    let parsedParameterValue = "";
    if (input[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < input.length) {
        const char = input[offset++];
        if (char === '"') {
          closed = true;
          break;
        }
        if (char === "\\") {
          if (offset >= input.length) break;
          parsedParameterValue += input[offset++];
        } else {
          parsedParameterValue += char;
        }
      }
      if (!closed) throw new Error(contentType
        ? "Invalid attachment content type."
        : "Invalid MIME structured header.");
      skipWhitespace();
      if (offset < input.length && input[offset] !== ";") {
        throw new Error(contentType
          ? "Invalid attachment content type."
          : "Invalid MIME structured header.");
      }
    } else {
      const parameterStart = offset;
      while (offset < input.length && input[offset] !== ";" &&
          input[offset] !== " " && input[offset] !== "\t") offset++;
      parsedParameterValue = input.slice(parameterStart, offset);
      skipWhitespace();
      if (!parsedParameterValue || !MIME_TOKEN_RE.test(parsedParameterValue) ||
          (offset < input.length && input[offset] !== ";")) {
        throw new Error(contentType
          ? "Invalid attachment content type."
          : "Invalid MIME structured header.");
      }
    }
    parameters.push({name, value: parsedParameterValue});
  }
  return {value, parameters};
}

function stripMimeComments(input: string): string {
  let result = "";
  let quoted = false;
  let commentDepth = 0;
  for (let offset = 0; offset < input.length; offset++) {
    const char = input[offset];
    if (commentDepth > 0) {
      if (char === "\\") {
        if (++offset >= input.length) throw new Error("Invalid MIME structured header.");
      } else if (char === "(") {
        commentDepth++;
      } else if (char === ")") {
        commentDepth--;
      }
      continue;
    }
    if (quoted) {
      result += char;
      if (char === "\\" && offset + 1 < input.length) result += input[++offset];
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === "(") {
      if (result && !/[ \t]$/.test(result)) result += " ";
      commentDepth = 1;
    } else {
      result += char;
    }
  }
  if (commentDepth !== 0) throw new Error("Invalid MIME structured header.");
  return result;
}

function serializeParameterizedMimeHeader(header: ParameterizedMimeHeader): string {
  return header.value + header.parameters.map(({name, value}) => {
    if (MIME_TOKEN_RE.test(value)) return `; ${name}=${value}`;
    return `; ${name}="${value.replace(/(["\\])/g, "\\$1")}"`;
  }).join("");
}

function encodeMimeParameter(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeContentId(value: string): string {
  const trimmed = value.trim();
  const id = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!id || /[<>\s]/.test(id)) throw new Error("Invalid attachment Content-ID.");
  validateAttachmentHeaderValue(id, "Content-ID");
  return `<${id}>`;
}

function base64UrlEncodeUtf8(value: string): string {
  return utf8ToBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value.replace(/\s/g, "")), char => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid attachment base64 data.");
  }
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function byteSequenceIndex(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;
  for (let i = from; i <= haystack.length - needle.length; i++) {
    let matches = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function replaceByteSequences(
    haystack: Uint8Array,
    replacements: readonly {index: number; length: number; replacement: Uint8Array}[]): Uint8Array {
  const located = replacements.toSorted((left, right) => left.index - right.index);
  for (let i = 1; i < located.length; i++) {
    if (located[i].index < located[i - 1].index + located[i - 1].length) {
      throw new Error("Unable to assemble overlapping nested message attachments.");
    }
  }
  const size = located.reduce(
    (total, item) => total - item.length + item.replacement.length, haystack.length);
  const result = new Uint8Array(size);
  let sourceOffset = 0;
  let resultOffset = 0;
  for (const item of located) {
    const prefix = haystack.subarray(sourceOffset, item.index);
    result.set(prefix, resultOffset);
    resultOffset += prefix.length;
    result.set(item.replacement, resultOffset);
    resultOffset += item.replacement.length;
    sourceOffset = item.index + item.length;
  }
  result.set(haystack.subarray(sourceOffset), resultOffset);
  return result;
}

function uniqueMimeToken(prefix: string, sources: readonly Uint8Array[]): string {
  const encoder = new TextEncoder();
  for (;;) {
    const token = `${prefix}-${crypto.randomUUID()}`;
    const encoded = encoder.encode(token);
    if (sources.every(source => byteSequenceIndex(source, encoded) < 0)) return token;
  }
}

function nestedMessageEncoding(bytes: Uint8Array): "7bit" | "8bit" {
  const headerEnd = byteSequenceIndex(bytes, new TextEncoder().encode("\r\n\r\n"));
  if (headerEnd < 0) throw new Error("A nested email message must contain RFC 5322 headers.");
  let encoding: "7bit" | "8bit" = "7bit";
  let lineLength = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0) throw new Error("A nested email message cannot contain NUL bytes.");
    if (byte === 13) {
      if (bytes[i + 1] !== 10) {
        throw new Error("A nested email message must use CRLF line endings.");
      }
      i++;
      lineLength = 0;
      continue;
    }
    if (byte === 10) throw new Error("A nested email message must use CRLF line endings.");
    if (++lineLength > 998) {
      throw new Error("A nested email message contains a line longer than 998 bytes.");
    }
    if (byte > 127) {
      if (i < headerEnd) {
        throw new Error(
          "A nested email message with UTF-8 headers cannot be labeled message/rfc822.");
      }
      encoding = "8bit";
    }
  }
  return encoding;
}

function mimeHeaderValue(bytes: Uint8Array, name: string): string | undefined {
  const lines = new TextDecoder().decode(bytes).split(/\r\n|\n|\r/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  const prefix = `${name.toLowerCase()}:`;
  const header = unfolded.find(line => line.toLowerCase().startsWith(prefix));
  return header?.slice(prefix.length).trim();
}

function mimeParameter(
    value: string | undefined, name: string,
    headerKind: "content-type" | "content-disposition"): string | undefined {
  if (!value) return undefined;
  const parsed = parseParameterizedMimeHeader(value, headerKind === "content-type");
  const extended = parameterValue(parsed, `${name.toLowerCase()}*`);
  if (extended !== undefined) {
    const encoded = extended;
    const payload = /^[^']*'[^']*'(.*)$/.exec(encoded)?.[1] ?? encoded;
    try {
      return decodeURIComponent(payload);
    } catch {
      throw new Error(`Invalid MIME ${name} parameter encoding.`);
    }
  }
  return parameterValue(parsed, name.toLowerCase());
}

function mimeTransferEncoding(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseParameterizedMimeHeader(value);
    if (parsed.parameters.length > 0 || ![
      "7bit", "8bit", "binary", "base64", "quoted-printable",
    ].includes(parsed.value)) {
      throw new UnsafeMimeReconstructionError(
        "Cannot safely edit a draft with an unsupported MIME transfer encoding.");
    }
    return parsed.value;
  } catch (error) {
    if (error instanceof UnsafeMimeReconstructionError) throw error;
    throw new UnsafeMimeReconstructionError(
      "Cannot safely edit a draft with an unsupported MIME transfer encoding.");
  }
}

type MimeMetadataEntity = {
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  children: MimeMetadataEntity[];
  depth: number;
  body: Uint8Array;
  rfc822Body?: Uint8Array;
  transferEncoding?: string;
};

type MimeAttachmentMetadata = {
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  exactBytes?: Uint8Array;
};

type MimeMetadataBudget = {remainingWork: number; entities: number};

const MAX_MIME_METADATA_ENTITIES = 2048;
const MAX_MIME_METADATA_DEPTH = 256;
const MIME_METADATA_WORK_FACTOR = 8;

const parsedAttachmentMetadata = new WeakMap<
  import("postal-mime").Email, readonly MimeAttachmentMetadata[]>();

function mimeHeaderSeparator(bytes: Uint8Array): {index: number; length: number} | undefined {
  if (bytes[0] === 13 && bytes[1] === 10) return {index: 0, length: 2};
  if (bytes[0] === 10 || bytes[0] === 13) return {index: 0, length: 1};
  const crlf = byteSequenceIndex(bytes, new Uint8Array([13, 10, 13, 10]));
  const lf = byteSequenceIndex(bytes, new Uint8Array([10, 10]));
  if (crlf < 0) return lf >= 0 ? {index: lf, length: 2} : undefined;
  if (lf < 0 || crlf < lf) return {index: crlf, length: 4};
  return {index: lf, length: 2};
}

function parameterValue(header: ParameterizedMimeHeader, name: string): string | undefined {
  return header.parameters.find(parameter => parameter.name === name)?.value;
}

function validateMimeBoundary(boundary: string | undefined): string {
  if (!boundary || boundary.length > 70 || /[^\x20-\x7e]/.test(boundary)) {
    throw new Error("Invalid MIME multipart boundary.");
  }
  return boundary;
}

function mimeLine(bytes: Uint8Array, start: number): {end: number; next: number} {
  let end = start;
  while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
  let next = end;
  if (bytes[next] === 13) next++;
  if (bytes[next] === 10) next++;
  return {end, next};
}

function splitMultipartBody(bytes: Uint8Array, boundary: string): Uint8Array[] {
  boundary = validateMimeBoundary(boundary);
  const marker = `--${boundary}`;
  const parts: Uint8Array[] = [];
  let partStart: number | undefined;
  for (let offset = 0; offset < bytes.length;) {
    const {end, next} = mimeLine(bytes, offset);
    const line = new TextDecoder().decode(bytes.subarray(offset, end));
    if (line.startsWith(marker)) {
      const suffix = line.slice(marker.length);
      const closing = suffix.startsWith("--");
      const padding = closing ? suffix.slice(2) : suffix;
      if (/^[ \t]*$/.test(padding)) {
        if (partStart !== undefined) {
          let partEnd = offset;
          // The line break immediately before a boundary belongs to the delimiter, not the part.
          if (bytes[partEnd - 2] === 13 && bytes[partEnd - 1] === 10) partEnd -= 2;
          else if (bytes[partEnd - 1] === 10 || bytes[partEnd - 1] === 13) partEnd--;
          parts.push(bytes.subarray(partStart, partEnd));
        }
        if (closing) return parts;
        partStart = next;
      }
    }
    if (next <= offset) break;
    offset = next;
  }
  if (partStart !== undefined && partStart < bytes.length) parts.push(bytes.subarray(partStart));
  return parts;
}

function hexNibble(byte: number | undefined): number {
  return byte !== undefined && byte >= 48 && byte <= 57
    ? byte - 48
    : byte !== undefined && byte >= 65 && byte <= 70
      ? byte - 55
      : byte !== undefined && byte >= 97 && byte <= 102 ? byte - 87 : -1;
}

function decodeQuotedPrintableBytes(bytes: Uint8Array, budget: MimeMetadataBudget): Uint8Array {
  if (bytes.byteLength > budget.remainingWork) {
    throw new Error("Gmail MIME metadata exceeds safe parsing limits.");
  }
  const result = new Uint8Array(bytes.length);
  let outputOffset = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 61) {
      result[outputOffset++] = bytes[i];
      continue;
    }
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) {
      i += 2;
      continue;
    }
    if (bytes[i + 1] === 10) {
      i++;
      continue;
    }
    const high = hexNibble(bytes[i + 1]);
    const low = hexNibble(bytes[i + 2]);
    if (high >= 0 && low >= 0) {
      result[outputOffset++] = high * 16 + low;
      i += 2;
    } else {
      result[outputOffset++] = bytes[i];
    }
  }
  return result.subarray(0, outputOffset);
}

function decodeMimeBase64Bytes(bytes: Uint8Array, budget: MimeMetadataBudget): Uint8Array {
  if (bytes.byteLength > budget.remainingWork) {
    throw new Error("Gmail MIME metadata exceeds safe parsing limits.");
  }
  const result = new Uint8Array(bytes.length);
  let outputOffset = 0;
  let buffer = 0;
  let bits = 0;
  let sextets = 0;
  let padding = 0;
  let sawPadding = false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32) continue;
    if (byte === 61) {
      sawPadding = true;
      padding++;
      if (padding > 2) throw new Error("Invalid attachment base64 data.");
      continue;
    }
    if (sawPadding) throw new Error("Invalid attachment base64 data.");
    const value = alphabet.indexOf(String.fromCharCode(byte));
    if (value < 0) throw new Error("Invalid attachment base64 data.");
    buffer = buffer << 6 | value;
    bits += 6;
    sextets++;
    if (bits >= 8) {
      bits -= 8;
      result[outputOffset++] = buffer >> bits & 0xff;
      buffer = bits === 0 ? 0 : buffer & ((1 << bits) - 1);
    }
  }
  if (sextets % 4 === 1 || (padding > 0 && (sextets + padding) % 4 !== 0) ||
      (padding > 0 && padding !== (4 - sextets % 4) % 4)) {
    throw new Error("Invalid attachment base64 data.");
  }
  return result.subarray(0, outputOffset);
}

function normalizeMimeContentId(value: string | undefined): string | null {
  if (!value) return null;
  return value.trim().replace(/^<|>$/g, "");
}

function parseMimeMetadataEntity(
    bytes: Uint8Array, budget: MimeMetadataBudget, depth = 0,
    defaultContentType = "text/plain", messageRoot = true): MimeMetadataEntity {
  if (depth > MAX_MIME_METADATA_DEPTH || ++budget.entities > MAX_MIME_METADATA_ENTITIES ||
      bytes.byteLength > budget.remainingWork) {
    throw new Error("Gmail MIME metadata exceeds safe parsing limits.");
  }
  budget.remainingWork -= bytes.byteLength;
  const separator = mimeHeaderSeparator(bytes);
  if (!separator) throw new Error("Invalid MIME entity headers.");
  const headers = bytes.subarray(0, separator.index);
  if (!messageRoot) {
    for (const line of new TextDecoder().decode(headers).split(/\r\n|\n|\r/)) {
      if (!line || /^[ \t]/.test(line)) continue;
      const colon = line.indexOf(":");
      const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
      if (name.startsWith("content-") && ![
        "content-type", "content-transfer-encoding", "content-disposition", "content-id",
      ].includes(name)) {
        throw new UnsafeMimeReconstructionError(
          `Cannot safely edit a draft with unsupported MIME part header ${name}.`);
      }
    }
  }
  const rawContentType = mimeHeaderValue(headers, "Content-Type") ?? defaultContentType;
  const contentType = validateAttachmentContentType(rawContentType);
  const parsedContentType = parseParameterizedMimeHeader(contentType, true);
  const rawDisposition = mimeHeaderValue(headers, "Content-Disposition");
  const disposition = rawDisposition
    ? parseParameterizedMimeHeader(rawDisposition).value
    : null;
  const contentId = normalizeMimeContentId(mimeHeaderValue(headers, "Content-ID"));
  const body = bytes.subarray(separator.index + separator.length);
  const transferEncoding = mimeTransferEncoding(
    mimeHeaderValue(headers, "Content-Transfer-Encoding"));
  const boundary = parameterValue(parsedContentType, "boundary");
  const childDefault = parsedContentType.value === "multipart/digest"
    ? "message/rfc822"
    : "text/plain";
  const children = parsedContentType.value.startsWith("multipart/")
    ? splitMultipartBody(body, boundary ?? "").map(part =>
        parseMimeMetadataEntity(part, budget, depth + 1, childDefault, false))
    : [];
  const isInlineRfc822 = parsedContentType.value === "message/rfc822" &&
    (disposition === null || disposition === "inline");
  return {
    contentType,
    disposition,
    contentId,
    children,
    depth,
    body,
    ...(transferEncoding ? {transferEncoding} : {}),
    ...(isInlineRfc822 ? {
      rfc822Body: body,
    } : {}),
  };
}

function forcesRfc822Attachments(entity: MimeMetadataEntity): boolean {
  const mediaType = baseMimeType(entity.contentType);
  if (mediaType === "message/delivery-status" || mediaType === "message/feedback-report") {
    return true;
  }
  return entity.children.some(forcesRfc822Attachments);
}

function extractMimeAttachmentMetadata(bytes: Uint8Array): MimeAttachmentMetadata[] {
  const budget = {
    remainingWork: Math.max(bytes.byteLength, 1) * MIME_METADATA_WORK_FACTOR,
    entities: 0,
  };
  const root = parseMimeMetadataEntity(bytes, budget);
  const result: MimeMetadataEntity[] = [];
  const collectMessage = (entity: MimeMetadataEntity, rfc822Depth: number) => {
    const forceRfc822 = forcesRfc822Attachments(entity);
    const visit = (part: MimeMetadataEntity) => {
      const mediaType = baseMimeType(part.contentType);
      if (mediaType.startsWith("multipart/")) {
        for (const child of part.children) visit(child);
      } else if (mediaType === "message/rfc822" &&
          (part.disposition === null || part.disposition === "inline") && !forceRfc822) {
        if (rfc822Depth >= 10 || !part.rfc822Body) {
          result.push(part);
        } else {
          const decoded = part.transferEncoding === "base64"
            ? decodeMimeBase64Bytes(part.rfc822Body, budget)
            : part.transferEncoding === "quoted-printable"
              ? decodeQuotedPrintableBytes(part.rfc822Body, budget)
              : part.rfc822Body;
          collectMessage(
            parseMimeMetadataEntity(decoded, budget, part.depth + 1), rfc822Depth + 1);
        }
      } else if ((mediaType !== "text/plain" && mediaType !== "text/html") ||
          part.disposition === "attachment") {
        result.push(part);
      }
    };
    visit(entity);
  };
  collectMessage(root, 0);
  return result.map(({contentType, disposition, contentId, transferEncoding, body}) => ({
    contentType,
    disposition,
    contentId,
    ...(!transferEncoding || transferEncoding === "7bit" || transferEncoding === "8bit" ||
        transferEncoding === "binary" ? {exactBytes: body} : {}),
  }));
}

function requireAttachmentMetadata(
    parsed: import("postal-mime").Email): readonly MimeAttachmentMetadata[] {
  if (parsed.attachments.length === 0) return [];
  const metadata = parsedAttachmentMetadata.get(parsed);
  if (!metadata) {
    throw new Error("Unable to preserve Gmail attachment metadata safely.");
  }
  return metadata;
}

/** One exact, unencoded top-level message/rfc822 MIME attachment. */
export type ExtractedRfc822Attachment = {
  bytes: Uint8Array;
  filename?: string;
  disposition?: string;
  contentId?: string;
};

/** Extract unencoded top-level message/rfc822 attachment bodies without normalizing their bytes. */
export function extractRfc822Attachments(raw: string): ExtractedRfc822Attachment[] {
  const bytes = decodeBase64UrlToBytes(raw);
  const encoder = new TextEncoder();
  const headerSeparator = encoder.encode("\r\n\r\n");
  const topHeaderEnd = byteSequenceIndex(bytes, headerSeparator);
  if (topHeaderEnd < 0) throw new Error("Unable to parse Gmail draft MIME headers.");
  const contentType = mimeHeaderValue(bytes.subarray(0, topHeaderEnd), "Content-Type");
  if (!contentType) return [];
  const parsedContentType = parseParameterizedMimeHeader(contentType, true);
  if (!parsedContentType.value.startsWith("multipart/")) return [];
  const boundary = validateMimeBoundary(parameterValue(parsedContentType, "boundary"));

  const delimiter = encoder.encode(`--${boundary}`);
  const nextDelimiter = encoder.encode(`\r\n--${boundary}`);
  let cursor = byteSequenceIndex(bytes, delimiter, topHeaderEnd + headerSeparator.length);
  if (cursor < 0) throw new Error("Unable to find Gmail draft MIME boundary.");
  const attachments: ExtractedRfc822Attachment[] = [];
  for (;;) {
    cursor += delimiter.length;
    const closing = bytes[cursor] === 45 && bytes[cursor + 1] === 45;
    if (closing) cursor += 2;
    while (bytes[cursor] === 32 || bytes[cursor] === 9) cursor++;
    if (closing) {
      if (cursor !== bytes.length && (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10)) {
        throw new Error("Invalid Gmail draft MIME boundary line.");
      }
      break;
    }
    if (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10) {
      throw new Error("Invalid Gmail draft MIME boundary line.");
    }
    const partStart = cursor + 2;
    const partEnd = byteSequenceIndex(bytes, nextDelimiter, partStart);
    if (partEnd < 0) throw new Error("Unterminated Gmail draft MIME part.");
    const partHeaderEnd = byteSequenceIndex(bytes, headerSeparator, partStart);
    if (partHeaderEnd < 0 || partHeaderEnd > partEnd) {
      throw new Error("Invalid Gmail draft MIME part headers.");
    }
    const partHeaders = bytes.subarray(partStart, partHeaderEnd);
    const rawContentType = mimeHeaderValue(partHeaders, "Content-Type");
    const partContentType = rawContentType?.toLowerCase();
    if (partContentType?.startsWith("message/rfc822")) {
      const transferEncoding = mimeTransferEncoding(
        mimeHeaderValue(partHeaders, "Content-Transfer-Encoding")) ?? "7bit";
      if (transferEncoding === "base64" || transferEncoding === "quoted-printable") {
        cursor = partEnd + 2;
        continue;
      }
      if (transferEncoding !== "7bit" && transferEncoding !== "8bit" &&
          transferEncoding !== "binary") {
        throw new Error("A message/rfc822 draft attachment uses an unsupported transfer encoding.");
      }
      const rawDisposition = mimeHeaderValue(partHeaders, "Content-Disposition");
      const contentId = mimeHeaderValue(partHeaders, "Content-ID")?.replace(/^<|>$/g, "");
      const filename = mimeParameter(rawDisposition, "filename", "content-disposition") ??
        mimeParameter(rawContentType, "name", "content-type");
      const disposition = rawDisposition
        ? parseParameterizedMimeHeader(rawDisposition).value
        : undefined;
      attachments.push({
        bytes: bytes.slice(partHeaderEnd + headerSeparator.length, partEnd),
        ...(filename ? {filename} : {}),
        ...(disposition ? {disposition} : {}),
        ...(contentId ? {contentId} : {}),
      });
    }
    cursor = partEnd + 2;
  }
  return attachments;
}

/**
 * Build a Gmail API base64url RFC 5322 payload. The subject is replaced after MIMEText
 * serialization because its single encoded-word form can exceed the header-line limit.
 */
export function buildEncodedEmail(options: GmailOutboundSpec): string {
  const msg = createMimeMessage();

  // oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (header-injection guard)
  if (/[\x00-\x1f\x7f]/.test(options.subject) ||
      new TextEncoder().encode(options.subject).byteLength > MAX_SUBJECT_BYTES) {
    throw new Error(`Email subject must be at most ${MAX_SUBJECT_BYTES} UTF-8 bytes and contain no control characters.`);
  }

  const from = parseEmailRecipient(normalizeEmailRecipients([options.from])[0]);
  const to = normalizeEmailRecipients(options.to);
  const cc = normalizeEmailRecipients(options.cc);
  const bcc = normalizeEmailRecipients(options.bcc);
  const mimeAddress = (value: string) => {
    const parsed = parseEmailRecipient(value);
    return {addr: parsed.address, ...(parsed.name ? {name: parsed.name} : {})};
  };
  msg.setSender({addr: from.address, ...(from.name ? {name: from.name} : {})});
  if (to.length > 0) msg.setTo(to.map(mimeAddress));
  if (cc.length > 0) msg.setCc(cc.map(mimeAddress));
  if (bcc.length > 0) msg.setBcc(bcc.map(mimeAddress));
  msg.setSubject(options.subject);
  msg.setHeader("Message-ID", validateMessageId(options.messageId, "Message-ID"));
  if (options.date !== undefined) msg.setHeader("Date", validateDateHeader(options.date));

  if (options.inReplyTo) {
    msg.setHeader('In-Reply-To', validateMessageId(options.inReplyTo, 'In-Reply-To'));
  }
  if (options.references) {
    msg.setHeader('References', normalizeReferences(options.references));
  }
  msg.addMessage({
    contentType: 'text/plain',
    data: foldBase64(utf8ToBase64(normalizeTextBody(options.text))),
    encoding: 'base64',
  });

  if (options.html !== undefined) {
    msg.addMessage({
      contentType: 'text/html',
      data: foldBase64(utf8ToBase64(normalizeTextBody(options.html))),
      encoding: 'base64',
    });
  }

  const nestedMessageBytes = new Map<number, {bytes: Uint8Array; encoding: "7bit" | "8bit"}>();
  for (let index = 0; index < options.attachments.length; index++) {
    if (baseMimeType(options.attachments[index].contentType) === "message/rfc822") {
      const bytes = base64ToBytes(options.attachments[index].data);
      nestedMessageBytes.set(index, {bytes, encoding: nestedMessageEncoding(bytes)});
    }
  }
  const nestedSources = [...nestedMessageBytes.values()].map(item => item.bytes);
  const nestedNamespace = nestedSources.length > 0
    ? uniqueMimeToken("gadgets-mime", nestedSources)
    : undefined;
  const nestedReplacements: Array<{
    attachmentIndex: number;
    placeholder: string;
    bytes: Uint8Array;
  }> = [];
  const attachmentFilenames: Array<{token: string; encoded: string}> = [];
  for (let index = 0; index < options.attachments.length; index++) {
    const attachment = options.attachments[index];
    validateAttachmentHeaderValue(attachment.filename, "filename");
    const contentType = validateAttachmentContentType(attachment.contentType);
    const token = `gadgets-attachment-${index}`;
    attachmentFilenames.push({token, encoded: encodeMimeParameter(attachment.filename)});
    const nestedMessage = nestedMessageBytes.get(index);
    const placeholder = nestedMessage
      ? `${nestedNamespace}-nested-${index}`
      : undefined;
    if (placeholder) {
      nestedReplacements.push({attachmentIndex: index, placeholder, bytes: nestedMessage!.bytes});
    }
    const part = msg.addAttachment({
      filename: token,
      contentType,
      data: placeholder ?? attachment.data,
      encoding: nestedMessage?.encoding ?? "base64",
      inline: attachment.disposition === "inline",
      headers: attachment.contentId
        ? {"Content-ID": normalizeContentId(attachment.contentId)}
        : undefined,
    });
    // MIMEText appends its own name parameter. Preserve a source name when present, otherwise keep
    // the established filename-derived parameter that the replacement pass below RFC 2231-encodes.
    const parsedContentType = parseParameterizedMimeHeader(contentType, true);
    const hasName = parsedContentType.parameters.some(parameter =>
      parameter.name === "name" || parameter.name.startsWith("name*"));
    part.setHeader("Content-Type", hasName ? contentType : `${contentType}; name="${token}"`);
  }

  if (nestedSources.length > 0) {
    msg.boundaries = {
      mixed: `${nestedNamespace}-mixed`,
      alt: `${nestedNamespace}-alternative`,
      related: `${nestedNamespace}-related`,
    };
  }

  let raw = msg.asRaw();
  raw = replaceMailboxHeader(raw, "From", [formatEmailAddress(from)]);
  if (to.length > 0) raw = replaceMailboxHeader(raw, "To", to);
  if (cc.length > 0) raw = replaceMailboxHeader(raw, "Cc", cc);
  if (bcc.length > 0) raw = replaceMailboxHeader(raw, "Bcc", bcc);
  if (options.replyTo?.length) {
    const fromHeader = /^From:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/mi;
    if (!fromHeader.test(raw)) throw new Error("Unable to insert the Reply-To header safely.");
    raw = raw.replace(
      fromHeader, value => `${value}\r\nReply-To: ${encodeMailboxHeader(options.replyTo!)}`);
  }
  raw = raw.replace(
    /^Subject:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/m, encodeSubjectHeader(options.subject));
  for (const {token, encoded} of attachmentFilenames) {
    raw = raw.replaceAll(`name="${token}"`, `name*=UTF-8''${encoded}`)
      .replaceAll(`filename="${token}"`, `filename*=UTF-8''${encoded}`);
  }
  if (raw.split("\r\n").some(line =>
    /(?:^|;)\s*(?:name|filename)\*=UTF-8''/i.test(line) &&
    new TextEncoder().encode(line).byteLength > 998)) {
    throw new Error("Attachment filename is too long to encode safely in a MIME header.");
  }
  if (nestedReplacements.length > 0) {
    const encoder = new TextEncoder();
    const rawBytes = encoder.encode(raw);
    const prefix = encoder.encode(`${nestedNamespace}-nested-`);
    const byAttachmentIndex = new Map(
      nestedReplacements.map(replacement => [replacement.attachmentIndex, replacement]));
    const replacements: Array<{index: number; length: number; replacement: Uint8Array}> = [];
    let searchFrom = 0;
    for (;;) {
      const index = byteSequenceIndex(rawBytes, prefix, searchFrom);
      if (index < 0) break;
      let end = index + prefix.length;
      let attachmentIndex = 0;
      let hasDigit = false;
      while (rawBytes[end] >= 48 && rawBytes[end] <= 57) {
        hasDigit = true;
        attachmentIndex = attachmentIndex * 10 + rawBytes[end] - 48;
        end++;
      }
      const replacement = hasDigit ? byAttachmentIndex.get(attachmentIndex) : undefined;
      if (replacement) {
        if (replacements.some(item => item.replacement === replacement.bytes) ||
            end - index !== encoder.encode(replacement.placeholder).length) {
          throw new Error("Unable to assemble nested message attachment.");
        }
        replacements.push({index, length: end - index, replacement: replacement.bytes});
      }
      searchFrom = Math.max(end, index + prefix.length);
    }
    if (replacements.length !== nestedReplacements.length) {
      throw new Error("Unable to assemble nested message attachments.");
    }
    const bytes = replaceByteSequences(rawBytes, replacements);
    return base64UrlEncodeBytes(bytes);
  }
  return base64UrlEncodeUtf8(raw);
}

/** Stable RFC message identity persisted with an approval action. */
export function newGmailMessageId(): string {
  return `<${crypto.randomUUID()}@gadgets.invalid>`;
}

// Gmail IDs are hex strings. Validate before interpolating into API URLs.
const GMAIL_ID_RE = /^[a-zA-Z0-9_-]+$/;
function validateGmailId(id: string, label: string): void {
  if (!GMAIL_ID_RE.test(id)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function parseGmailLabelResponse(
    value: unknown, operation: "create" | "get" | "update"): GmailLabelRaw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Gmail labels.${operation} returned a non-object response.`);
  }
  const label = value as Record<string, unknown>;
  if (typeof label.id !== "string" || !GMAIL_ID_RE.test(label.id)) {
    throw new Error(`Gmail labels.${operation} response is missing a valid label ID.`);
  }
  if (typeof label.name !== "string") {
    throw new Error(`Gmail labels.${operation} response is missing a valid label name.`);
  }
  if (label.type !== undefined && label.type !== "user") {
    throw new Error(`Gmail labels.${operation} returned a non-user label.`);
  }
  return {id: label.id, name: label.name, type: "user"};
}

function parseGmailDraftWriteResult(
    value: unknown, operation: "creation" | "update"):
    {id: string; message: {id: string; threadId?: string}} {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const message = result?.message && typeof result.message === "object"
    ? result.message as Record<string, unknown>
    : undefined;
  if (typeof result?.id !== "string" || !GMAIL_ID_RE.test(result.id) ||
      typeof message?.id !== "string" || !GMAIL_ID_RE.test(message.id) ||
      (message.threadId !== undefined &&
        (typeof message.threadId !== "string" || !GMAIL_ID_RE.test(message.threadId)))) {
    throw new Error(`Gmail accepted the draft ${operation} but returned an invalid response.`);
  }
  return {
    id: result.id,
    message: {
      id: message.id,
      ...(typeof message.threadId === "string" ? {threadId: message.threadId} : {}),
    },
  };
}

async function readGmailDraftWriteResult(
    response: Response, operation: "creation" | "update"):
    Promise<{id: string; message: {id: string; threadId?: string}}> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Gmail accepted the draft ${operation} but returned an invalid response.`);
  }
  return parseGmailDraftWriteResult(value, operation);
}

function shouldIncludeSpamTrash(query?: string, labelIds?: string[]): boolean {
  if (labelIds?.some(id => id === "SPAM" || id === "TRASH")) return true;
  const operators = new Set(["in:anywhere", "in:spam", "in:trash", "label:spam", "label:trash"]);
  let token = "";
  let tokenContainsQuote = false;
  let quoted = false;
  let escaped = false;
  const disabledGroups = [false];
  const flushToken = () => {
    const matched = !disabledGroups.at(-1) && !tokenContainsQuote &&
      operators.has(token.toLowerCase());
    token = "";
    tokenContainsQuote = false;
    return matched;
  };
  for (const char of query ?? "") {
    if (char === '"' && !escaped) {
      quoted = !quoted;
      tokenContainsQuote = true;
    } else if (!quoted && /\s/.test(char)) {
      if (flushToken()) return true;
    } else if (!quoted && (char === "(" || char === "{")) {
      const prefix = token;
      token = "";
      const quotedPrefix = tokenContainsQuote;
      tokenContainsQuote = false;
      disabledGroups.push(
        disabledGroups.at(-1)! || quotedPrefix || prefix.startsWith("-") || prefix.endsWith(":"));
    } else if (!quoted && (char === ")" || char === "}")) {
      if (flushToken()) return true;
      if (disabledGroups.length > 1) disabledGroups.pop();
    } else if (!quoted) {
      token += char;
    }
    escaped = char === "\\" && !escaped;
  }
  return flushToken();
}

// Read a bounded prefix of an error response body for inclusion in thrown errors.
async function readErrorText(response: Response, maxBytes = 4096): Promise<string> {
  if (!response.body) return response.statusText;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const {done, value} = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    const chunk = value.subarray(0, remaining);
    chunks.push(chunk);
    total += chunk.byteLength;
    if (chunk.byteLength < value.byteLength) break;
  }
  await reader.cancel();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A status-only provider error that is safe to use for retry decisions and server logs. */
export class GmailApiError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(`Gmail API ${operation} failed [http=${status}]`);
  }
}

async function gmailApiFailure(operation: string, response: Response): Promise<never> {
  // Gmail error prose can reflect query and header values. Keep thrown errors safe to log.
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; the HTTP status remains authoritative.
  }
  throw new GmailApiError(response.status, operation);
}

function headerValue(
    headers: Array<{name: string; value: string}> | undefined, name: string): string | undefined {
  return headers?.find(header => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseAddressHeader(value: string | undefined): EmailAddress[] {
  return value ? postalAddressListToEmailAddresses(parseAddressList(value)) : [];
}

/** Convert Gmail metadata headers to the public message metadata shape without reading a body. */
export function parseGmailMessageMetadata(message: GmailMessageFull): GmailMessageInfoRaw {
  const headers = message.payload?.headers;
  const from = parseAddressHeader(headerValue(headers, "From"))[0] ?? {address: ""};
  const timestampNumber = Number(message.internalDate);
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to: parseAddressHeader(headerValue(headers, "To")),
    cc: parseAddressHeader(headerValue(headers, "Cc")),
    bcc: parseAddressHeader(headerValue(headers, "Bcc")),
    subject: headerValue(headers, "Subject") ?? "",
    timestamp: new Date(Number.isFinite(timestampNumber) ? timestampNumber : 0),
    labelIds: message.labelIds ?? [],
  };
}

/** Aggregate message metadata into a thread summary without reading message bodies. */
export function summarizeGmailThread(
    id: string, snippet: string | undefined,
    messages: readonly GmailMessageInfoRaw[]): GmailThreadInfoRaw {
  const participants: EmailAddress[] = [];
  const participantAddresses = new Set<string>();
  const labelIds: string[] = [];
  const seenLabels = new Set<string>();
  let timestamp = 0;
  let unread = false;
  for (const message of messages) {
    timestamp = Math.max(timestamp, message.timestamp.getTime());
    unread ||= message.labelIds.includes("UNREAD");
    for (const labelId of message.labelIds) {
      if (!seenLabels.has(labelId)) {
        seenLabels.add(labelId);
        labelIds.push(labelId);
      }
    }
    for (const participant of [message.from, ...message.to, ...message.cc, ...message.bcc]) {
      const key = participant.address.toLowerCase();
      if (key && !participantAddresses.has(key)) {
        participantAddresses.add(key);
        participants.push(participant);
      }
    }
  }
  return {
    id,
    ...(snippet !== undefined ? {snippet} : {}),
    subject: messages[0]?.subject ?? "",
    messageCount: messages.length,
    timestamp: new Date(timestamp),
    participants,
    unread,
    labelIds,
  };
}

function cleanContentId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function assertGmailPayloadTreeIsBounded(payload: GmailPayloadPart | undefined): void {
  if (!payload) return;
  const pending = [{part: payload, depth: 0}];
  let entities = 0;
  while (pending.length > 0) {
    const {part, depth} = pending.pop()!;
    if (depth > MAX_MIME_METADATA_DEPTH || ++entities > MAX_MIME_METADATA_ENTITIES) {
      throw new Error("Gmail payload exceeds safe parsing limits.");
    }
    const children = part.parts ?? [];
    if (children.length > MAX_MIME_METADATA_ENTITIES - entities - pending.length) {
      throw new Error("Gmail payload exceeds safe parsing limits.");
    }
    for (const child of children) pending.push({part: child, depth: depth + 1});
  }
}

function classifyGmailPart(part: GmailPayloadPart, isRelatedRepresentation = false): {
  disposition: "attachment" | "inline" | null;
  contentId?: string;
  filename: string | null;
  isBody: boolean;
  isAttachmentBoundary: boolean;
} {
  const dispositionHeader = headerValue(part.headers, "Content-Disposition")?.toLowerCase();
  const disposition = dispositionHeader?.startsWith("attachment")
    ? "attachment" as const
    : dispositionHeader?.startsWith("inline")
      ? "inline" as const
      : null;
  const contentId = cleanContentId(headerValue(part.headers, "Content-ID"));
  const filename = part.filename?.trim() || null;
  const mimeType = part.mimeType?.toLowerCase();
  const isText = mimeType === "text/plain" || mimeType === "text/html";
  const isBody = isText && !filename && disposition !== "attachment" &&
    (!contentId || isRelatedRepresentation);
  const isRelatedRootContainer = isRelatedRepresentation && mimeType?.startsWith("multipart/") &&
    !filename && disposition !== "attachment";
  return {
    disposition,
    ...(contentId ? {contentId} : {}),
    filename,
    isBody,
    isAttachmentBoundary: !isBody && !isRelatedRootContainer &&
      (!!filename || dispositionHeader !== undefined || contentId !== undefined),
  };
}

function relatedRootPart(part: GmailPayloadPart): GmailPayloadPart | undefined {
  if (part.mimeType?.toLowerCase() !== "multipart/related" || !part.parts?.length) {
    return undefined;
  }
  const contentType = headerValue(part.headers, "Content-Type");
  if (!contentType) return part.parts[0];
  try {
    const start = cleanContentId(mimeParameter(contentType, "start", "content-type"));
    return start
      ? part.parts.find(child =>
          cleanContentId(headerValue(child.headers, "Content-ID")) === start)
      : part.parts[0];
  } catch {
    // An invalid related root must not turn a CID resource into body content.
    return undefined;
  }
}

function isRelatedChildRepresentation(
    parent: GmailPayloadPart, child: GmailPayloadPart,
    inherited: boolean, selectedRoot: GmailPayloadPart | undefined): boolean {
  return parent.mimeType?.toLowerCase() === "multipart/related"
    ? child === selectedRoot
    : inherited;
}

/** Enumerate attachment and inline leaves without downloading attachment bodies. */
export function enumerateGmailAttachments(
    messageId: string, payload: GmailPayloadPart | undefined): GmailAttachmentSnapshot[] {
  assertGmailPayloadTreeIsBounded(payload);
  const result: GmailAttachmentSnapshot[] = [];
  const visit = (part: GmailPayloadPart, path: string, isRelatedRepresentation = false) => {
    const {contentId, disposition, filename, isBody, isAttachmentBoundary} =
      classifyGmailPart(part, isRelatedRepresentation);
    const size = Number.isSafeInteger(part.body?.size) && (part.body?.size ?? -1) >= 0
      ? part.body!.size!
      : part.body?.data !== undefined
        ? base64UrlDecodedByteLength(part.body.data)
        : 0;
    const hasContent = part.body?.attachmentId !== undefined || part.body?.data !== undefined;
    if (!isBody && hasContent) {
      const readable = hasContent && size <= MAX_GMAIL_ATTACHMENT_BYTES;
      result.push({
        key: part.partId ?? path,
        messageId,
        ...(part.body?.attachmentId ? {attachmentId: part.body.attachmentId} : {}),
        ...(part.body?.data !== undefined ? {inlineData: part.body.data} : {}),
        info: {
          filename,
          mimeType: part.mimeType || "application/octet-stream",
          size,
          disposition,
          ...(contentId ? {contentId} : {}),
          readable,
        },
      });
    }
    if (isAttachmentBoundary) return;
    const relatedRoot = relatedRootPart(part);
    for (let i = 0; i < (part.parts?.length ?? 0); i++) {
      const child = part.parts![i];
      visit(child, `${path}.${i}`, isRelatedChildRepresentation(
        part, child, isRelatedRepresentation, relatedRoot));
    }
  };
  if (payload) visit(payload, "0");
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function postalAttachmentBytes(
    content: ArrayBuffer | Uint8Array | string, contentType: string,
    exactBytes?: Uint8Array): Uint8Array {
  const bytes = exactBytes ?? (typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array ? content : new Uint8Array(content));
  const mediaType = baseMimeType(contentType);
  if (mediaType !== "text/calendar" && mediaType !== "application/ics") return bytes;
  if (exactBytes) return normalizeMimeLineEndings(bytes);
  const text = new TextDecoder().decode(bytes).replace(/\r\n|\r|\n/g, "\r\n");
  return new TextEncoder().encode(text);
}

function normalizeMimeLineEndings(bytes: Uint8Array): Uint8Array {
  let size = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) i++;
    else if (bytes[i] === 13 || bytes[i] === 10) size++;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      result[offset++] = 13;
      result[offset++] = 10;
      i++;
    } else if (bytes[i] === 13 || bytes[i] === 10) {
      result[offset++] = 13;
      result[offset++] = 10;
    } else {
      result[offset++] = bytes[i];
    }
  }
  return result;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]!));
}

function forwardedAddress(value: import("postal-mime").Address | undefined): string {
  if (!value) return "(unknown sender)";
  const address = postalAddressToEmailAddress(value);
  return address.address ? formatEmailAddress(address) : address.name || "(unknown sender)";
}

function forwardedAddresses(values: import("postal-mime").Address[] | undefined): string {
  const addresses = postalAddressListToEmailAddresses(values).map(formatEmailAddress);
  return addresses.join(", ") || "(none)";
}

function forwardedHeaderBlock(original: import("postal-mime").Email): string {
  const lines = [
    "---------- Forwarded message ---------",
    `From: ${forwardedAddress(original.from)}`,
    `Date: ${String(original.date ?? "(unknown date)")}`,
    `Subject: ${original.subject ?? ""}`,
    `To: ${forwardedAddresses(original.to)}`,
  ];
  const cc = forwardedAddresses(original.cc);
  if (cc !== "(none)") lines.push(`Cc: ${cc}`);
  return lines.join("\r\n");
}

function htmlForwardedHeaderBlock(original: import("postal-mime").Email): string {
  const lines = [
    `From: ${htmlEscape(forwardedAddress(original.from))}`,
    `Date: ${htmlEscape(String(original.date ?? "(unknown date)"))}`,
    `Subject: ${htmlEscape(original.subject ?? "")}`,
    `To: ${htmlEscape(forwardedAddresses(original.to))}`,
  ];
  const cc = forwardedAddresses(original.cc);
  if (cc !== "(none)") lines.push(`Cc: ${htmlEscape(cc)}`);
  return lines.join("<br>");
}

function attachmentFromPostal(
    attachment: import("postal-mime").Attachment,
    metadata: MimeAttachmentMetadata): GmailOutboundAttachment {
  const contentType = postalAttachmentContentType(
    attachment, metadata.contentType, metadata.exactBytes !== undefined);
  const bytes = postalAttachmentBytes(attachment.content, contentType, metadata.exactBytes);
  const filename = attachment.filename ?? "";
  const disposition = postalAttachmentDisposition(attachment);
  return {
    filename,
    contentType,
    data: foldBase64(bytesToBase64(bytes)),
    ...(disposition ? {disposition} : {}),
    ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
    description: `${filename || "(unnamed)"} (${contentType}, ${bytes.byteLength} bytes)`,
  };
}

function postalAttachmentDisposition(
    attachment: import("postal-mime").Attachment): "inline" | "attachment" | undefined {
  if (attachment.related === true || attachment.disposition === "inline") return "inline";
  return attachment.disposition ? "attachment" : undefined;
}

function postalAttachmentContentType(
    attachment: import("postal-mime").Attachment, original: string,
    preserveCharset = false): string {
  const contentType = parseParameterizedMimeHeader(original, true);
  if (contentType.value !== baseMimeType(attachment.mimeType || "application/octet-stream")) {
    throw new Error("Unable to correlate Gmail attachment Content-Type metadata.");
  }
  // Filename is modeled separately and MIMEText emits an RFC 2231 name matching it. Excluding the
  // redundant source parameter keeps provider-normalized fingerprints stable across reconstruction.
  contentType.parameters = contentType.parameters.filter(parameter =>
    parameter.name !== "name" && !parameter.name.startsWith("name*"));
  if (contentType.value === "text/calendar" || contentType.value === "application/ics") {
    if (!preserveCharset) {
      contentType.parameters = contentType.parameters.filter(parameter =>
        parameter.name !== "charset" && !parameter.name.startsWith("charset*"));
      contentType.parameters.push({name: "charset", value: "utf-8"});
    }
    if (attachment.method !== undefined &&
        !contentType.parameters.some(parameter => parameter.name === "method")) {
      contentType.parameters.push({name: "method", value: attachment.method});
    }
  }
  return validateAttachmentContentType(serializeParameterizedMimeHeader(contentType));
}

export type GmailParsedDraft = GmailNormalizedRecipients & {
  from?: string;
  replyTo: string[];
  date?: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments: GmailOutboundAttachment[];
};

export type GmailParsedDraftSnapshot = Omit<GmailParsedDraft, "attachments"> & {
  attachments: GmailAttachmentSnapshot[];
};

const MODELED_DRAFT_HEADERS = new Set([
  "from", "reply-to", "to", "cc", "bcc", "date", "subject", "message-id", "in-reply-to", "references",
]);
const SAFE_UNMODELED_DRAFT_HEADERS = new Set([
  "mime-version", "content-type", "content-transfer-encoding", "return-path", "received", "delivered-to",
  "authentication-results", "received-spf", "dkim-signature",
]);

function assertDraftHeadersAreModeled(headers: readonly string[]): void {
  const modeled = new Set<string>();
  for (const originalName of headers) {
    const name = originalName.toLowerCase();
    if (MODELED_DRAFT_HEADERS.has(name)) {
      if (modeled.has(name)) {
        throw new Error(`Cannot safely edit a draft with duplicate modeled header ${originalName}.`);
      }
      modeled.add(name);
      continue;
    }
    if (SAFE_UNMODELED_DRAFT_HEADERS.has(name) || name.startsWith("arc-") ||
        name === "x-received" || name.startsWith("x-google-") || name.startsWith("x-gm-")) {
      continue;
    }
    throw new Error(
      `Cannot safely edit a draft with unsupported top-level header ${originalName}.`);
  }
}

function decodeGmailTextBytes(part: GmailPayloadPart, bytes: Uint8Array): string {
  const contentType = headerValue(part.headers, "Content-Type") ?? "";
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function inlineGmailBodyByteLength(payload: GmailPayloadPart | undefined): number {
  assertGmailPayloadTreeIsBounded(payload);
  let totalBytes = 0;
  const visit = (part: GmailPayloadPart, isRelatedRepresentation = false) => {
    const {isBody, isAttachmentBoundary} = classifyGmailPart(part, isRelatedRepresentation);
    if (isAttachmentBoundary) return;
    if (isBody && part.body?.data !== undefined) {
      totalBytes += base64UrlDecodedByteLength(part.body.data);
      if (totalBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
        throw new Error(
          `Gmail message bodies exceed the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe-read limit.`);
      }
    }
    const relatedRoot = relatedRootPart(part);
    for (const child of part.parts ?? []) {
      visit(child, isRelatedChildRepresentation(part, child, isRelatedRepresentation, relatedRoot));
    }
  };
  if (payload) visit(payload);
  return totalBytes;
}

/** Decode inline body alternatives without downloading detached attachment bodies. */
export function parseGmailPayloadContent(payload: GmailPayloadPart | undefined): {
  text?: string;
  html?: string;
} {
  const text: string[] = [];
  const html: string[] = [];
  inlineGmailBodyByteLength(payload);
  const visit = (part: GmailPayloadPart, isRelatedRepresentation = false) => {
    const {isBody, isAttachmentBoundary} = classifyGmailPart(part, isRelatedRepresentation);
    if (isAttachmentBoundary) return;
    if (isBody) {
      let value: string | undefined;
      if (part.body?.data !== undefined) {
        value = decodeGmailTextBytes(part, decodeBase64UrlToBytes(part.body.data));
      }
      if (value !== undefined) {
        (part.mimeType?.toLowerCase() === "text/plain" ? text : html).push(value);
      }
    }
    const relatedRoot = relatedRootPart(part);
    for (const child of part.parts ?? []) {
      visit(child, isRelatedChildRepresentation(part, child, isRelatedRepresentation, relatedRoot));
    }
  };
  if (payload) visit(payload);
  return {
    ...(text.length ? {text: text.join("\n")} : {}),
    ...(html.length ? {html: html.join("\n")} : {}),
  };
}

/** Parse headers and inline body alternatives without downloading detached attachment bodies. */
export function parseGmailDraftSnapshot(message: GmailMessageFull): GmailParsedDraftSnapshot {
  const headers = message.payload?.headers;
  const content = parseGmailPayloadContent(message.payload);
  return {
    ...(parseAddressHeader(headerValue(headers, "From"))[0]
      ? {from: formatEmailAddress(parseAddressHeader(headerValue(headers, "From"))[0])}
      : {}),
    replyTo: parseAddressHeader(headerValue(headers, "Reply-To")).map(formatEmailAddress),
    to: parseAddressHeader(headerValue(headers, "To")).map(formatEmailAddress),
    cc: parseAddressHeader(headerValue(headers, "Cc")).map(formatEmailAddress),
    bcc: parseAddressHeader(headerValue(headers, "Bcc")).map(formatEmailAddress),
    subject: headerValue(headers, "Subject") ?? "",
    text: content.text ?? "",
    ...(content.html !== undefined ? {html: content.html} : {}),
    ...(headerValue(headers, "Message-ID") ? {messageId: headerValue(headers, "Message-ID")} : {}),
    ...(headerValue(headers, "In-Reply-To") ? {inReplyTo: headerValue(headers, "In-Reply-To")} : {}),
    ...(headerValue(headers, "References") ? {references: headerValue(headers, "References")} : {}),
    attachments: enumerateGmailAttachments(message.id, message.payload),
  };
}

/** Parse a draft's editable content and attachment bytes for drift checks and lossless updates. */
export async function parseGmailDraft(message: GmailMessageRaw): Promise<GmailParsedDraft> {
  const parsed = await parseMimeMessage(message.raw);
  assertDraftHeadersAreModeled(parsed.headers.map(header => header.originalKey));
  const reconstructionError = parsedMimeReconstructionErrors.get(parsed);
  if (reconstructionError) throw new Error(reconstructionError);
  const metadata = requireAttachmentMetadata(parsed);
  const date = parsed.headers.find(header => header.key === "date")?.value;
  return {
    ...(parsed.from ? {from: formatEmailAddress(postalAddressToEmailAddress(parsed.from))} : {}),
    replyTo: postalAddressListToEmailAddresses(parsed.replyTo).map(formatEmailAddress),
    to: postalAddressListToEmailAddresses(parsed.to).map(formatEmailAddress),
    cc: postalAddressListToEmailAddresses(parsed.cc).map(formatEmailAddress),
    bcc: postalAddressListToEmailAddresses(parsed.bcc).map(formatEmailAddress),
    ...(date !== undefined ? {date: validateDateHeader(date)} : {}),
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    ...(parsed.html !== undefined ? {html: parsed.html} : {}),
    ...(parsed.messageId ? {messageId: parsed.messageId} : {}),
    ...(parsed.inReplyTo ? {inReplyTo: parsed.inReplyTo} : {}),
    ...(parsed.references ? {references: parsed.references} : {}),
    attachments: parsed.attachments.map((attachment, index) => {
      const contentType = postalAttachmentContentType(
        attachment, metadata[index].contentType, metadata[index].exactBytes !== undefined);
      const bytes = postalAttachmentBytes(
        attachment.content, contentType, metadata[index].exactBytes);
      const disposition = postalAttachmentDisposition(attachment);
      return {
        // MIMEText requires a string; an empty filename round-trips as unnamed.
        filename: attachment.filename ?? "",
        contentType,
        data: foldBase64(bytesToBase64(bytes)),
        ...(disposition ? {disposition} : {}),
        ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
        description: `${attachment.filename ?? "(unnamed)"} (${contentType}, ${bytes.byteLength} bytes)`,
      };
    }),
  };
}

function messageInfoFromParsed(
    message: GmailMessageRaw, parsed: import("postal-mime").Email): GmailMessageInfoRaw {
  const from = parsed.from
    ? postalAddressToEmailAddress(parsed.from)
    : {address: ""};
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to: postalAddressListToEmailAddresses(parsed.to),
    cc: postalAddressListToEmailAddresses(parsed.cc),
    bcc: postalAddressListToEmailAddresses(parsed.bcc),
    subject: parsed.subject ?? "",
    timestamp: new Date(parseInt(message.internalDate)),
    labelIds: message.labelIds || [],
  };
}

export class GmailApi {
  private selfEmail: string;

  constructor(selfEmail: string, private getAccessToken: AccessTokenProvider) {
    this.selfEmail = selfEmail;
  }

  // All Gmail API calls go through this for auth + retry: it injects the Bearer token, retries
  // once on a 401 with a force-refreshed token, and retries transient failures (429 / 5xx) with
  // backoff on GETs only. Callers must not set the Authorization header themselves.
  private authedFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetchWithAuthRetry(url, init ?? {}, this.getAccessToken);
  }

  // ─────────────────────────────────────────────────────────────────
  // Thread operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * List threads. Gmail returns only IDs and snippets here; getThreadInfo()
   * fetches the metadata needed for public thread summaries.
   */
  async listThreads(count: number, query?: string, pageToken?: string, labelIds?: string[]):
      Promise<{ threads: Array<{ id: string; snippet?: string }>; nextPageToken?: string }> {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${count}`;
    if (query) {
      url += `&q=${encodeURIComponent(query)}`;
    }
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }
    for (const labelId of labelIds ?? []) {
      validateGmailId(labelId, "label ID");
      url += `&labelIds=${encodeURIComponent(labelId)}`;
    }
    if (shouldIncludeSpamTrash(query, labelIds)) url += "&includeSpamTrash=true";

    const response = await this.authedFetch(url);

    if (!response.ok) {
      await gmailApiFailure("threads.list", response);
    }

    const data = await response.json() as {
      threads?: Array<{ id: string; snippet?: string }>;
      nextPageToken?: string;
    };
    return {
      threads: data.threads || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Get thread snippet and message IDs. Raw MIME is fetched lazily by each
   * message capability when content is actually needed.
   */
  async getThread(threadId: string): Promise<GmailThreadRaw> {
    validateGmailId(threadId, "thread ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
    );

    if (!response.ok) {
      await gmailApiFailure("threads.get", response);
    }

    const thread = await response.json() as {
      id: string;
      snippet?: string;
      messages?: Array<{ id: string }>;
    };

    const messages = (thread.messages ?? []).map(message => ({
      id: message.id,
      threadId: thread.id,
    }));

    return { id: thread.id, snippet: thread.snippet ?? '', messages };
  }

  /**
   * Get aggregate thread metadata using a metadata-only fetch, without
   * downloading message bodies or attachments.
   */
  async getThreadInfo(threadId: string): Promise<GmailThreadInfoRaw> {
    validateGmailId(threadId, "thread ID");

    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`);
    url.searchParams.set("format", "metadata");
    for (const header of ["From", "To", "Cc", "Bcc", "Subject"]) {
      url.searchParams.append("metadataHeaders", header);
    }
    const response = await this.authedFetch(url.toString());

    if (!response.ok) {
      await gmailApiFailure("threads.get", response);
    }

    const thread = await response.json() as GmailThreadMetadata;
    return summarizeGmailThread(
      threadId, thread.snippet,
      (thread.messages ?? []).map(parseGmailMessageMetadata),
    );
  }

  /** Modify thread labels (for archive, trash, read/unread). */
  async modifyThread(
    threadId: string,
    addLabelIds?: string[],
    removeLabelIds?: string[]
  ): Promise<void> {
    validateGmailId(threadId, "thread ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          addLabelIds: addLabelIds || [],
          removeLabelIds: removeLabelIds || [],
        }),
      }
    );

    if (!response.ok) {
      await gmailApiFailure("threads.modify", response);
    }
    await response.body?.cancel();
  }

  /** Trash a thread. */
  async trashThread(threadId: string): Promise<void> {
    validateGmailId(threadId, "thread ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/trash`,
      { method: 'POST' }
    );

    if (!response.ok) {
      await gmailApiFailure("threads.trash", response);
    }
    await response.body?.cancel();
  }

  /** Restore a thread from trash. */
  async untrashThread(threadId: string): Promise<void> {
    validateGmailId(threadId, "thread ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/untrash`,
      {method: "POST"});
    if (!response.ok) await gmailApiFailure("threads.untrash", response);
    await response.body?.cancel();
  }

  // ─────────────────────────────────────────────────────────────────
  // Message operations
  // ─────────────────────────────────────────────────────────────────

  async listMessages(
      count: number, query?: string, pageToken?: string, labelIds?: string[]): Promise<{
        messages: GmailMessageRef[];
        nextPageToken?: string;
      }> {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", String(count));
    if (query) url.searchParams.set("q", query);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    for (const labelId of labelIds ?? []) {
      validateGmailId(labelId, "label ID");
      url.searchParams.append("labelIds", labelId);
    }
    if (shouldIncludeSpamTrash(query, labelIds)) {
      url.searchParams.set("includeSpamTrash", "true");
    }
    const response = await this.authedFetch(url.toString());
    if (!response.ok) await gmailApiFailure("messages.list", response);
    const data = await response.json() as {
      messages?: GmailMessageRef[];
      nextPageToken?: string;
    };
    return {
      messages: data.messages ?? [],
      ...(data.nextPageToken ? {nextPageToken: data.nextPageToken} : {}),
    };
  }

  /** Find a message by the stable RFC Message-ID assigned before an approved write. */
  async findMessageByRfcMessageId(
      messageId: string, location: "any" | "drafts" | "delivered" = "any"):
      Promise<GmailMessageRef | undefined> {
    const id = gmailMessageIdQueryValue(messageId);
    const normalizedMessageId = `<${id}>`;
    const locationQuery = location === "drafts"
      ? "in:drafts"
      : location === "delivered"
        ? "in:anywhere -in:drafts"
        : undefined;
    const page = await this.listMessages(
      10, [locationQuery, `rfc822msgid:${id}`].filter(Boolean).join(" "));
    // A duplicate Message-ID is not enough to prove that an ambiguous write happened. Treat both
    // multiple results and an unexpectedly paginated result as inconclusive.
    if (page.messages.length !== 1 || page.nextPageToken !== undefined) return undefined;
    const candidate = page.messages[0];
    const metadata = await this.getMessageMetadata(candidate.id);
    if (metadata.id !== candidate.id ||
        headerValue(metadata.payload?.headers, "Message-ID")?.trim() !== normalizedMessageId ||
        (location === "delivered" && !metadata.labelIds?.includes("SENT"))) {
      return undefined;
    }
    return candidate;
  }

  /** Reconcile a draft create whose provider response may have been lost. */
  async findDraftByRfcMessageId(messageId: string): Promise<GmailDraftRef | undefined> {
    const message = await this.findMessageByRfcMessageId(messageId, "drafts");
    if (!message) return undefined;
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    let pages = 0;
    do {
      if (++pages > MAX_GMAIL_DRAFT_LOOKUP_PAGES) {
        throw new Error("Gmail returned too many pages while finding a pending draft.");
      }
      const page = await this.listDrafts(100, pageToken);
      for (const draft of page.drafts) {
        if (draft.message?.id === message.id) return draft;
        if (!draft.message) {
          const full = await this.getDraft(draft.id);
          if (full.message.id === message.id) {
            return {id: draft.id, message: {id: full.message.id, threadId: full.message.threadId}};
          }
        }
      }
      pageToken = page.nextPageToken;
      if (pageToken) {
        if (seenTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
        seenTokens.add(pageToken);
      }
    } while (pageToken);
    return undefined;
  }

  /** Fetch message headers and labels without downloading bodies or attachments. */
  async getMessageMetadata(messageId: string): Promise<GmailMessageFull> {
    validateGmailId(messageId, "message ID");
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
    url.searchParams.set("format", "metadata");
    for (const header of [
      "From", "Reply-To", "Delivered-To", "To", "Cc", "Bcc", "Subject", "Message-ID",
      "References",
    ]) {
      url.searchParams.append("metadataHeaders", header);
    }
    const response = await this.authedFetch(url.toString());
    if (!response.ok) await gmailApiFailure("messages.get", response);
    return await response.json() as GmailMessageFull;
  }

  /** Fetch the MIME tree while leaving detached attachment data lazy. */
  async getMessageFull(messageId: string): Promise<GmailMessageFull> {
    validateGmailId(messageId, "message ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`);
    if (!response.ok) await gmailApiFailure("messages.get", response);
    return await response.json() as GmailMessageFull;
  }

  async getAttachmentContent(snapshot: GmailAttachmentSnapshot): Promise<ArrayBuffer> {
    if (!snapshot.info.readable || snapshot.info.size > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment content is unavailable or exceeds the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe limit.`);
    }
    let encoded = snapshot.inlineData;
    if (snapshot.attachmentId) {
      validateGmailId(snapshot.messageId, "message ID");
      validateGmailId(snapshot.attachmentId, "attachment ID");
      const response = await this.authedFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${snapshot.messageId}/attachments/${snapshot.attachmentId}`);
      if (!response.ok) await gmailApiFailure("attachments.get", response);
      encoded = (await response.json() as {data?: string}).data;
    }
    if (encoded === undefined) throw new Error("Attachment content is no longer available.");
    const bytes = decodeBase64UrlToBytes(encoded);
    if (bytes.byteLength > MAX_GMAIL_ATTACHMENT_BYTES || bytes.byteLength !== snapshot.info.size) {
      throw new Error("Attachment content no longer matches the authorized snapshot.");
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /** Decode body alternatives, fetching detached text parts within the attachment safety limit. */
  async getMessageContent(message: GmailMessageFull): Promise<{text?: string; html?: string}> {
    const text: string[] = [];
    const html: string[] = [];
    let totalBytes = inlineGmailBodyByteLength(message.payload);
    const visit = async (
        part: GmailPayloadPart, path: string, isRelatedRepresentation = false): Promise<void> => {
      const {isBody, isAttachmentBoundary} = classifyGmailPart(part, isRelatedRepresentation);
      if (isAttachmentBoundary) return;
      if (isBody) {
        let value: string | undefined;
        if (part.body?.data !== undefined) {
          value = decodeGmailTextBytes(part, decodeBase64UrlToBytes(part.body.data));
        }
        if (value === undefined && part.body?.attachmentId) {
          const size = part.body.size ?? 0;
          if (size > MAX_GMAIL_ATTACHMENT_BYTES || totalBytes + size > MAX_GMAIL_ATTACHMENT_BYTES) {
            throw new Error(
              `Gmail message bodies exceed the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe-read limit.`);
          }
          const content = await this.getAttachmentContent({
            key: part.partId ?? path,
            messageId: message.id,
            attachmentId: part.body.attachmentId,
            info: {
              filename: null,
              mimeType: part.mimeType ?? "text/plain",
              size,
              disposition: null,
              readable: true,
            },
          });
          totalBytes += content.byteLength;
          value = decodeGmailTextBytes(part, new Uint8Array(content));
        }
        if (value !== undefined) {
          (part.mimeType?.toLowerCase() === "text/plain" ? text : html).push(value);
        }
      }
      const relatedRoot = relatedRootPart(part);
      for (let i = 0; i < (part.parts?.length ?? 0); i++) {
        const child = part.parts![i];
        await visit(child, `${path}.${i}`, isRelatedChildRepresentation(
          part, child, isRelatedRepresentation, relatedRoot));
      }
    };
    if (message.payload) await visit(message.payload, "0");
    return {
      ...(text.length ? {text: text.join("\n")} : {}),
      ...(html.length ? {html: html.join("\n")} : {}),
    };
  }

  /** Parse a draft snapshot while resolving detached text body parts. */
  async parseDraftSnapshot(message: GmailMessageFull): Promise<GmailParsedDraftSnapshot> {
    const snapshot = parseGmailDraftSnapshot(message);
    const content = await this.getMessageContent(message);
    return {
      ...snapshot,
      text: content.text ?? "",
      ...(content.html !== undefined ? {html: content.html} : {html: undefined}),
    };
  }

  /**
   * Fetch only participant headers for visibility checks, avoiding message
   * bodies and attachments.
   */
  async getMessageParticipants(messageId: string): Promise<Set<string>> {
    validateGmailId(messageId, "message ID");
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
    url.searchParams.set("format", "metadata");
    for (const header of ["From", "To", "Cc", "Bcc"]) {
      url.searchParams.append("metadataHeaders", header);
    }

    const response = await this.authedFetch(url.toString());
    if (!response.ok) {
      await gmailApiFailure("messages.get", response);
    }

    const data = await response.json() as {
      payload?: { headers?: Array<{name: string; value: string}> };
    };
    const participants = new Set<string>();
    for (const header of data.payload?.headers ?? []) {
      if (!["from", "to", "cc", "bcc"].includes(header.name.toLowerCase())) continue;
      for (const address of postalAddressListToEmailAddresses(parseAddressList(header.value))) {
        if (address.address) participants.add(address.address.toLowerCase());
      }
    }
    return participants;
  }

  /** Get a single message with raw MIME content. */
  async getMessage(messageId: string): Promise<GmailMessageRaw> {
    validateGmailId(messageId, "message ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=raw`,
    );

    if (!response.ok) {
      await gmailApiFailure("messages.get", response);
    }

    return await response.json() as GmailMessageRaw;
  }

  async modifyMessage(
      messageId: string, addLabelIds: string[] = [], removeLabelIds: string[] = []): Promise<void> {
    validateGmailId(messageId, "message ID");
    for (const id of [...addLabelIds, ...removeLabelIds]) validateGmailId(id, "label ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({addLabelIds, removeLabelIds}),
      });
    if (!response.ok) await gmailApiFailure("messages.modify", response);
    await response.body?.cancel();
  }

  async trashMessage(messageId: string): Promise<void> {
    validateGmailId(messageId, "message ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`, {method: "POST"});
    if (!response.ok) await gmailApiFailure("messages.trash", response);
    await response.body?.cancel();
  }

  /** Restore one message from trash. */
  async untrashMessage(messageId: string): Promise<void> {
    validateGmailId(messageId, "message ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/untrash`,
      {method: "POST"});
    if (!response.ok) await gmailApiFailure("messages.untrash", response);
    await response.body?.cancel();
  }

  /**
   * Parse message info from raw MIME data via postal-mime. Returns raw label
   * IDs — the caller resolves them to GmailLabel objects via the label map.
   */
  async parseMessageInfo(message: GmailMessageRaw): Promise<GmailMessageInfoRaw> {
    return messageInfoFromParsed(message, await parseMimeMessage(message.raw));
  }

  /** Parse both info and content from a single postal-mime pass. */
  async parseMessage(message: GmailMessageRaw): Promise<{
    info: GmailMessageInfoRaw;
    content: { text?: string; html?: string };
  }> {
    const parsed = await parseMimeMessage(message.raw);

    return {
      info: messageInfoFromParsed(message, parsed),
      content: {
        ...(parsed.text != null ? { text: parsed.text } : {}),
        ...(parsed.html != null ? { html: parsed.html } : {}),
      },
    };
  }

  async parseMessageHeaders(message: GmailMessageRaw): Promise<GmailHeader[]> {
    const parsed = await parseMimeMessage(message.raw);
    return boundedGmailHeaders(parsed.headers, header => ({
      name: header.originalKey,
      value: header.value,
    }));
  }

  collectMessageHeaders(headers: Iterable<GmailHeader>): GmailHeader[] {
    return boundedGmailHeaders(headers, header => ({name: header.name, value: header.value}));
  }

  // ─────────────────────────────────────────────────────────────────
  // Outbound message construction + send
  //
  // Outbound mail is represented by an exact structured snapshot at submit
  // time and encoded for delivery only after approval. Nothing is written to
  // the user's mailbox before the gatekeeper's applyAction() runs.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build a raw new outbound email and return the exact structured payload
   * used to generate it, for approval display.
   */
  buildSendRaw(
      to: string[], subject: string, body: string, options: GmailComposeOptions = {},
      messageId = newGmailMessageId()): GmailOutboundMessage {
    const recipients = normalizeAggregateRecipients(to, options.cc, options.bcc);
    const message = this.buildOutbound({
      from: this.selfEmail,
      ...recipients,
      subject,
      text: body,
      ...(options.html !== undefined ? {html: options.html} : {}),
      messageId,
      attachments: [],
    });
    return message;
  }

  /** Build exactly the structured message persisted in an approval action. */
  buildOutbound(spec: GmailOutboundSpec): GmailOutboundMessage {
    const recipients = {
      to: normalizeEmailRecipients(spec.to),
      cc: normalizeEmailRecipients(spec.cc),
      bcc: normalizeEmailRecipients(spec.bcc),
    };
    const replyTo = normalizeEmailRecipients(spec.replyTo ?? []);
    const normalized: GmailOutboundSpec = {...spec, ...recipients, replyTo};
    return {
      raw: buildEncodedEmail(normalized),
      from: normalized.from,
      replyTo,
      ...recipients,
      subject: normalized.subject,
      body: normalized.text,
      ...(normalized.html !== undefined ? {html: normalized.html} : {}),
      messageId: normalized.messageId,
      ...(normalized.inReplyTo ? {inReplyTo: normalized.inReplyTo} : {}),
      ...(normalized.references ? {references: normalized.references} : {}),
      attachments: normalized.attachments,
    };
  }

  /**
   * Build a raw reply to an existing message. `originalMessage` is the cached
   * raw message being replied to (no extra fetch). When replyAll is true, this
   * mailbox's own address is filtered out of the CC list. Returns the encoded
   * raw message along with the resolved recipients and subject so the caller
   * can describe exactly what will be sent in the approval prompt.
   */
  async buildReplyFromMetadata(
      originalMessage: GmailMessageFull, body: string, replyAll: boolean,
      options: GmailReplyOptions = {}, messageId = newGmailMessageId()): Promise<GmailOutboundMessage> {
    const headers = originalMessage.payload?.headers ?? [];
    const raw = base64UrlEncodeUtf8(
      headers.map(header => `${header.name}: ${header.value}`).join("\r\n") + "\r\n\r\n");
    return this.buildReplyRaw({
      id: originalMessage.id,
      threadId: originalMessage.threadId,
      labelIds: originalMessage.labelIds,
      internalDate: originalMessage.internalDate,
      raw,
    }, body, replyAll, options, messageId);
  }

  async buildReplyRaw(
      originalMessage: GmailMessageRaw,
      body: string,
      replyAll: boolean,
      options: GmailReplyOptions = {},
      messageId = newGmailMessageId(),
  ): Promise<GmailOutboundMessage> {
    const original = await parseMimeMessage(originalMessage.raw);

    const originalFrom = original.from ? postalAddressToEmailAddress(original.from) : undefined;
    const originalFromAddr = originalFrom?.address ?? '';
    const originalSubject = original.subject ?? '';
    const self = this.selfEmail.toLowerCase();
    const ownAddresses = new Set([self]);
    for (const header of original.headers) {
      if (header.originalKey.toLowerCase() !== "delivered-to") continue;
      for (const address of postalAddressListToEmailAddresses(parseAddressList(header.value))) {
        if (address.address) ownAddresses.add(address.address.toLowerCase());
      }
    }
    const sentBySelf = originalMessage.labelIds?.includes('SENT') === true;
    if (sentBySelf && originalFromAddr) ownAddresses.add(originalFromAddr.toLowerCase());
    const withoutSelf = (values: EmailAddress[]) => values
      .filter(value => value.address && !ownAddresses.has(value.address.toLowerCase()))
      .map(formatEmailAddress);
    const originalTo = withoutSelf(postalAddressListToEmailAddresses(original.to));
    const originalCc = withoutSelf(postalAddressListToEmailAddresses(original.cc));
    // For an incoming message, Reply-To overrides From per normal email
    // semantics. For a message authored by this mailbox (e.g. from Sent), reply
    // to its original recipients rather than sending back to ourselves.
    const sourceReplyTo = postalAddressListToEmailAddresses(original.replyTo);
    const replyTo = withoutSelf(sourceReplyTo);
    let to = sentBySelf
      ? (replyAll ? originalTo : originalTo.slice(0, 1))
      : (sourceReplyTo.length > 0
          ? replyTo
          : originalFrom && !ownAddresses.has(originalFromAddr.toLowerCase())
            ? [formatEmailAddress(originalFrom)]
            : []);
    let cc: string[] = [];

    if (replyAll) {
      const seen = new Set(to.map(value => parseEmailRecipient(value).address.toLowerCase()));
      const candidates = sentBySelf ? originalCc : [...originalTo, ...originalCc];
      cc = candidates.filter(addr => {
        const lower = parseEmailRecipient(addr).address.toLowerCase();
        if (lower === self || seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    }

    const hasRecipientOverride = options.to !== undefined || options.cc !== undefined ||
      options.bcc !== undefined;
    const recipients = hasRecipientOverride
      ? normalizeAggregateRecipients(options.to, options.cc, options.bcc)
      : normalizeAggregateRecipients(to, cc, []);
    if (recipients.to.length + recipients.cc.length + recipients.bcc.length === 0) {
      throw new Error("Cannot construct a reply: source message has no usable recipient.");
    }

    // Build subject (add Re: if not already present)
    const subject = originalSubject.toLowerCase().startsWith('re:')
      ? originalSubject
      : `Re: ${originalSubject}`;

    // Build References header
    const originalMsgId = original.messageId?.trim();
    if (!originalMsgId) {
      throw new Error("Cannot construct a threaded reply: source message has no Message-ID header.");
    }
    const parentId = validateMessageId(originalMsgId, 'source Message-ID');
    const references = foldReferences(original.references, parentId);

    const message = this.buildOutbound({
      from: this.selfEmail,
      ...recipients,
      subject,
      text: body,
      ...(options.html !== undefined ? {html: options.html} : {}),
      messageId,
      inReplyTo: parentId,
      references,
      attachments: [],
    });

    return message;
  }

  /**
   * Build a Gmail-style inline forward. The source body is quoted below the
   * standard forwarded-message header block, and source attachments are copied
   * as ordinary attachments so inline Content-IDs continue to work.
   */
  async buildForwardRaw(
    originalMessage: GmailMessageRaw,
    to: string[],
    body?: string,
    options: GmailComposeOptions = {},
    messageId = newGmailMessageId(),
    subjectOverride?: string,
    date?: string,
  ): Promise<GmailOutboundMessage> {
    const sourceBytes = base64UrlDecodedByteLength(originalMessage.raw);
    if (sourceBytes > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot forward this message: the original is ${sourceBytes} bytes, exceeding the ` +
        `${MAX_GMAIL_FORWARD_SOURCE_BYTES}-byte safe forwarding limit.`);
    }

    const recipients = normalizeAggregateRecipients(to, options.cc, options.bcc);
    const original = await parseMimeMessage(originalMessage.raw);
    const originalSubject = original.subject ?? '';
    const subject = originalSubject.toLowerCase().startsWith('fwd:')
      ? originalSubject
      : `Fwd: ${originalSubject}`;
    const headerBlock = forwardedHeaderBlock(original);
    const sourceHtml = original.html;
    const sourceText = original.text ?? "";
    const forwardBody = body ? `${body}\r\n\r\n${headerBlock}\r\n\r\n${sourceText}`
      : `${headerBlock}\r\n\r\n${sourceText}`;
    const htmlQuoteSource = sourceHtml ??
      `<pre>${htmlEscape(sourceText)}</pre>`;
    const htmlQuote = `<div class="gmail_quote gmail_quote_container">` +
      `---------- Forwarded message ---------<br>${htmlForwardedHeaderBlock(original)}` +
      `<br><br>${htmlQuoteSource}</div>`;
    const htmlIntro = options.html !== undefined
      ? options.html
      : body
        ? htmlEscape(body).replace(/\r\n|\r|\n/g, "<br>")
        : undefined;
    const forwardHtml = htmlIntro !== undefined
      ? `${htmlIntro}<br><br>${htmlQuote}`
      : original.html !== undefined ? htmlQuote : undefined;
    const metadata = requireAttachmentMetadata(original);
    const attachments = original.attachments.map((attachment, index) =>
      attachmentFromPostal(attachment, metadata[index]));

    const message = this.buildOutbound({
      from: this.selfEmail,
      ...recipients,
      subject: subjectOverride ?? subject,
      text: forwardBody,
      ...(forwardHtml !== undefined ? {html: forwardHtml} : {}),
      messageId,
      ...(date !== undefined ? {date} : {}),
      attachments,
    });
    if (base64UrlDecodedByteLength(message.raw) > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot forward this message: the generated message exceeds the ` +
        `${MAX_GMAIL_FORWARD_SOURCE_BYTES}-byte safe forwarding limit.`);
    }
    return message;
  }

  /** Build an inline forward from an exact source snapshot held by the gatekeeper. */
  async buildForwardFromBytes(
      sourceBytes: Uint8Array, to: string[], body?: string,
      options: GmailComposeOptions = {}, messageId = newGmailMessageId(), subjectOverride?: string,
      date?: string):
      Promise<GmailOutboundMessage> {
    return this.buildForwardRaw({
      id: "forward-snapshot", threadId: "forward-snapshot", internalDate: "0",
      raw: base64UrlEncodeBytes(sourceBytes),
    }, to, body, options, messageId, subjectOverride, date);
  }

  /**
   * Send a pre-built raw RFC 2822 message. Optionally attach to an existing
   * thread. Called only from applyAction(), i.e. after approval. An approved send
   * lands at most once: a POST is never replayed for a transient failure, and the
   * one case that is replayed — a 401 — is rejected before the message is accepted
   * for delivery.
   */
  async sendRawMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    if (threadId !== undefined) validateGmailId(threadId, "thread ID");

    const message: { raw: string; threadId?: string } =
      threadId !== undefined ? { raw, threadId } : { raw };

    const response = await this.authedFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      }
    );

    if (!response.ok) {
      await gmailApiFailure("messages.send", response);
    }

    const result = await response.json() as { id?: string; threadId?: string };
    if (!result.id || !result.threadId) {
      throw new Error("Gmail accepted the send request but returned an invalid response.");
    }
    return {id: result.id, threadId: result.threadId};
  }

  // ─────────────────────────────────────────────────────────────────
  // Drafts
  // ─────────────────────────────────────────────────────────────────

  async listDrafts(count: number, pageToken?: string): Promise<{
    drafts: GmailDraftRef[];
    nextPageToken?: string;
  }> {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    url.searchParams.set("maxResults", String(count));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await this.authedFetch(url.toString());
    if (!response.ok) await gmailApiFailure("drafts.list", response);
    const data = await response.json() as {drafts?: GmailDraftRef[]; nextPageToken?: string};
    return {
      drafts: data.drafts ?? [],
      ...(data.nextPageToken ? {nextPageToken: data.nextPageToken} : {}),
    };
  }

  async getDraft(draftId: string): Promise<GmailDraftRaw> {
    validateGmailId(draftId, "draft ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}?format=raw`);
    if (!response.ok) await gmailApiFailure("drafts.get", response);
    const draft = await response.json() as GmailDraftRaw;
    if (!draft.id || !draft.message?.id || !draft.message.raw) {
      throw new Error("Gmail returned an invalid draft resource.");
    }
    return draft;
  }

  /** Fetch a draft MIME tree while retaining detached attachment bodies as lazy IDs. */
  async getDraftFull(draftId: string): Promise<GmailDraftFull> {
    validateGmailId(draftId, "draft ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}?format=full`);
    if (!response.ok) await gmailApiFailure("drafts.get", response);
    const draft = await response.json() as GmailDraftFull;
    if (!draft.id || !draft.message?.id) throw new Error("Gmail returned an invalid draft resource.");
    return draft;
  }

  async createDraft(
      raw: string, threadId?: string): Promise<{id: string; message: {id: string; threadId?: string}}> {
    if (threadId) validateGmailId(threadId, "thread ID");
    const response = await this.authedFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message: {raw, ...(threadId ? {threadId} : {})}}),
    });
    if (!response.ok) await gmailApiFailure("drafts.create", response);
    return readGmailDraftWriteResult(response, "creation");
  }

  async updateDraft(
      draftId: string, raw: string, threadId?: string):
      Promise<{id: string; message: {id: string; threadId?: string}}> {
    validateGmailId(draftId, "draft ID");
    if (threadId) validateGmailId(threadId, "thread ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message: {raw, ...(threadId ? {threadId} : {})}}),
    });
    if (!response.ok) await gmailApiFailure("drafts.update", response);
    return readGmailDraftWriteResult(response, "update");
  }

  async deleteDraft(draftId: string): Promise<void> {
    validateGmailId(draftId, "draft ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`, {method: "DELETE"});
    if (!response.ok) await gmailApiFailure("drafts.delete", response);
    await response.body?.cancel();
  }

  async sendDraft(
      draftId: string, raw: string, threadId?: string): Promise<{id: string; threadId: string}> {
    validateGmailId(draftId, "draft ID");
    if (threadId) validateGmailId(threadId, "thread ID");
    const response = await this.authedFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          id: draftId,
          message: {raw, ...(threadId ? {threadId} : {})},
        }),
      });
    if (!response.ok) await gmailApiFailure("drafts.send", response);
    const sent = await response.json() as {id?: string; threadId?: string};
    if (!sent.id || !sent.threadId) throw new Error("Gmail returned an invalid sent draft resource.");
    return {id: sent.id, threadId: sent.threadId};
  }

  // ─────────────────────────────────────────────────────────────────
  // Labels
  // ─────────────────────────────────────────────────────────────────

  async listLabelRecords(): Promise<GmailLabelRaw[]> {
    const response = await this.authedFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    );

    if (!response.ok) {
      await gmailApiFailure("labels.list", response);
    }

    const data = await response.json() as {
      labels?: GmailLabelRaw[];
    };
    return (data.labels ?? []).filter(label =>
      typeof label.id === "string" && typeof label.name === "string" &&
      (label.type === "system" || label.type === "user"));
  }

  async getLabel(labelId: string): Promise<GmailLabelRaw> {
    validateGmailId(labelId, "label ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`);
    if (!response.ok) await gmailApiFailure("labels.get", response);
    const label = parseGmailLabelResponse(await response.json(), "get");
    if (label.id !== labelId) throw new Error("Gmail labels.get returned a different label ID.");
    return label;
  }

  async createLabel(name: string): Promise<GmailLabelRaw> {
    const response = await this.authedFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name}),
    });
    if (!response.ok) await gmailApiFailure("labels.create", response);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Gmail labels.create returned invalid JSON.");
    }
    return parseGmailLabelResponse(value, "create");
  }

  async renameLabel(labelId: string, name: string): Promise<GmailLabelRaw> {
    validateGmailId(labelId, "label ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`, {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name}),
    });
    if (!response.ok) await gmailApiFailure("labels.update", response);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Gmail labels.update returned invalid JSON.");
    }
    const label = parseGmailLabelResponse(value, "update");
    if (label.id !== labelId) {
      throw new Error("Gmail labels.update returned a different label ID.");
    }
    return label;
  }

  async deleteLabel(labelId: string): Promise<void> {
    validateGmailId(labelId, "label ID");
    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`, {method: "DELETE"});
    if (!response.ok) await gmailApiFailure("labels.delete", response);
    await response.body?.cancel();
  }
}
