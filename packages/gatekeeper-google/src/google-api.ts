// Basic helpers talking to Google API
//
// This file was largely vibe-coded based on an interface spec.

import { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import { GmailThreadInfo, EmailAddress } from "./types";
import { createMimeMessage } from "mimetext/browser";
import PostalMime, { addressParser } from "postal-mime";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

/**
 * Internal type for parsed message info with raw label IDs (not yet resolved
 * to GmailLabel objects). The stub layer resolves labels via the label map.
 */
export type GmailMessageInfoRaw = {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  timestamp: Date;
  labelIds: string[];
};

export type GmailOutboundMessage = {
  raw: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    description: string;
  }>;
};

export type GmailReplyMessage = GmailOutboundMessage & {
  sourceWasSent: boolean;
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

export async function getGoogleAccountDescription(accessToken: string)
    : Promise<AccountDescription> {
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

  // Mapping the response to our specific interface
  return {
    displayName: data.name,
    uniqueName: data.email,
    avatar: {url: data.picture},
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

// Minimal thread data. Message MIME is fetched lazily by message capabilities
// only when content, reply, or forward operations actually need it.
type GmailThread = {
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

// Metadata-only thread response (format=metadata). Used by getThreadInfo()
// to avoid downloading full message payloads.
type GmailThreadMetadata = {
  id: string;
  snippet?: string;
  historyId: string;
  messages?: Array<{
    payload: { headers: Array<{ name: string; value: string }> };
  }>;
};

// Decode a base64url-encoded string to raw bytes.
const MAX_FORWARD_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_FORWARD_ATTACHMENT_DESCRIPTIONS = 50;

function base64UrlDecodedByteLength(data: string): number {
  return Math.floor(data.length * 3 / 4);
}

function base64UrlToBase64(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
}

function decodeBase64UrlToBytes(data: string): Uint8Array {
  const binary = atob(base64UrlToBase64(data));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// Parse a format=raw Gmail message into structured email data via postal-mime.
// Passes raw bytes (not a UTF-8 string) so postal-mime can apply per-part
// charset decoding without data loss on non-UTF-8 messages.
async function parseMimeMessage(raw: string): Promise<import("postal-mime").Email> {
  return PostalMime.parse(decodeBase64UrlToBytes(raw));
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

export function normalizeEmailRecipients(inputs: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    // oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (header-injection guard)
    if (/[\x00-\x1f\x7f]/.test(input)) {
      throw new Error("Email addresses must not contain control characters.");
    }
    const parsed = addressParser(input, { flatten: true });
    if (parsed.length !== 1 || !parsed[0].address || parsed[0].group) {
      throw new Error(`Expected exactly one email address, got: ${input}`);
    }
    const address = parsed[0].address.trim();
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1 || address.length > 320 || /[<>\s,;]/.test(address)) {
      throw new Error(`Invalid email address: ${input}`);
    }
    const key = address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(address);
    }
  }
  return result;
}

const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
const MAX_SUBJECT_BYTES = 998;

function validateMessageId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!MESSAGE_ID_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return trimmed;
}

function foldReferences(references: string | undefined, parentId: string): string {
  const tokens = references?.match(/<[^<>\s@]+@[^<>\s@]+>/g) ?? [];
  const valid = tokens.filter(token => MESSAGE_ID_RE.test(token));
  const bounded = valid.length > 20
    ? [valid[0], ...valid.slice(-18)]
    : valid;
  if (bounded[bounded.length - 1] !== parentId) bounded.push(parentId);

  let lines: string[] = [];
  let current = '';
  for (const token of bounded) {
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

function encodeSubjectHeader(subject: string): string {
  // Keep each encoded-word comfortably under RFC 2047's 75-character limit,
  // splitting only between Unicode code points.
  const chunks: string[] = [];
  let chunk = '';
  for (const char of subject) {
    if (chunk && new TextEncoder().encode(chunk + char).byteLength > 36) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk += char;
    }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  const words = chunks.map(value => `=?utf-8?B?${utf8ToBase64(value)}?=`);
  return `Subject: ${words[0]}${words.slice(1).map(word => `\r\n ${word}`).join('')}`;
}

function base64UrlEncodeUtf8(value: string): string {
  return utf8ToBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Build an RFC 2822 email and return it as a base64url-encoded string
// ready for the Gmail API `raw` field.
//
// MIMEText handles the multipart structure and default headers. Its RFC 2047
// Subject encoder emits one encoded-word without folding, which can exceed the
// header-line limit for long Unicode subjects. After serialization we replace
// only that header with the folded output from encodeSubjectHeader().
function buildEncodedEmail(options: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    data: string;
  }>;
}): string {
  const msg = createMimeMessage();

  // oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (header-injection guard)
  if (/[\x00-\x1f\x7f]/.test(options.subject) ||
      new TextEncoder().encode(options.subject).byteLength > MAX_SUBJECT_BYTES) {
    throw new Error(`Email subject must be at most ${MAX_SUBJECT_BYTES} UTF-8 bytes and contain no control characters.`);
  }

  const from = normalizeEmailRecipients([options.from])[0];
  const to = normalizeEmailRecipients(options.to);
  const cc = normalizeEmailRecipients(options.cc ?? [])
    .filter(address => !to.some(item => item.toLowerCase() === address.toLowerCase()));
  msg.setSender({addr: from});
  msg.setTo(to.map(address => ({addr: address})));
  if (cc.length > 0) {
    msg.setCc(cc.map(address => ({addr: address})));
  }
  msg.setSubject(options.subject);

  if (options.inReplyTo) {
    msg.setHeader('In-Reply-To', validateMessageId(options.inReplyTo, 'In-Reply-To'));
  }
  if (options.references) {
    msg.setHeader('References', options.references);
  }
  msg.addMessage({
    contentType: 'text/plain',
    data: foldBase64(utf8ToBase64(normalizeTextBody(options.body))),
    encoding: 'base64',
  });

  for (const attachment of options.attachments ?? []) {
    msg.addAttachment({
      filename: attachment.filename,
      contentType: attachment.contentType,
      data: attachment.data,
      encoding: 'base64',
    });
  }

  const raw = msg.asRaw().replace(/^Subject:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/m, encodeSubjectHeader(options.subject));
  return base64UrlEncodeUtf8(raw);
}

// Gmail IDs are hex strings. Validate before interpolating into API URLs.
const GMAIL_ID_RE = /^[a-zA-Z0-9_-]+$/;
function validateGmailId(id: string, label: string): void {
  if (!GMAIL_ID_RE.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`);
  }
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
   * List threads. Gmail returns Thread resources with id/snippet, omitting only
   * the messages array. Subject/count are enriched separately by getThreadInfo().
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

    const response = await this.authedFetch(url);

    if (!response.ok) {
      const errorText = await readErrorText(response);
      throw new Error(`Failed to list threads: ${response.status} ${errorText}`);
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
  async getThread(threadId: string): Promise<GmailThread> {
    validateGmailId(threadId, "thread ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
    );

    if (!response.ok) {
      const errorText = await readErrorText(response);
      throw new Error(`Failed to get thread: ${response.status} ${errorText}`);
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
   * Get thread info (id, snippet, subject) using a metadata-only fetch to
   * avoid downloading full message payloads.
   */
  async getThreadInfo(threadId: string): Promise<GmailThreadInfo> {
    validateGmailId(threadId, "thread ID");

    const response = await this.authedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject`,
    );

    if (!response.ok) {
      const errorText = await readErrorText(response);
      throw new Error(`Failed to get thread info: ${response.status} ${errorText}`);
    }

    const thread = await response.json() as GmailThreadMetadata;
    const firstMsg = thread.messages?.[0];
    const subject = firstMsg?.payload.headers.find(
      h => h.name.toLowerCase() === 'subject'
    )?.value ?? '';

    return {
      id: threadId,
      ...(thread.snippet !== undefined ? {snippet: thread.snippet} : {}),
      subject,
      messageCount: thread.messages?.length ?? 0,
    };
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
      const errorText = await readErrorText(response);
      throw new Error(`Failed to modify thread: ${response.status} ${errorText}`);
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
      const errorText = await readErrorText(response);
      throw new Error(`Failed to trash thread: ${response.status} ${errorText}`);
    }
    await response.body?.cancel();
  }

  // ─────────────────────────────────────────────────────────────────
  // Message operations
  // ─────────────────────────────────────────────────────────────────

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
      const errorText = await readErrorText(response);
      throw new Error(`Failed to get message participants: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      payload?: { headers?: Array<{name: string; value: string}> };
    };
    const participants = new Set<string>();
    for (const header of data.payload?.headers ?? []) {
      if (!["from", "to", "cc", "bcc"].includes(header.name.toLowerCase())) continue;
      for (const address of postalAddressListToEmailAddresses(addressParser(header.value))) {
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
      const errorText = await readErrorText(response);
      throw new Error(`Failed to get message: ${response.status} ${errorText}`);
    }

    return await response.json() as GmailMessageRaw;
  }

  /**
   * Parse message info from raw MIME data via postal-mime. Returns raw label
   * IDs — the caller resolves them to GmailLabel objects via the label map.
   */
  async parseMessageInfo(message: GmailMessageRaw): Promise<GmailMessageInfoRaw> {
    const parsed = await parseMimeMessage(message.raw);

    const from = parsed.from
      ? postalAddressToEmailAddress(parsed.from)
      : { address: '' };

    return {
      from,
      to: postalAddressListToEmailAddresses(parsed.to),
      cc: postalAddressListToEmailAddresses(parsed.cc),
      subject: parsed.subject ?? '',
      timestamp: new Date(parseInt(message.internalDate)),
      labelIds: message.labelIds || [],
    };
  }

  /** Parse both info and content from a single postal-mime pass. */
  async parseMessage(message: GmailMessageRaw): Promise<{
    info: GmailMessageInfoRaw;
    content: { text?: string; html?: string };
  }> {
    const parsed = await parseMimeMessage(message.raw);

    const from = parsed.from
      ? postalAddressToEmailAddress(parsed.from)
      : { address: '' };

    return {
      info: {
        from,
        to: postalAddressListToEmailAddresses(parsed.to),
        cc: postalAddressListToEmailAddresses(parsed.cc),
        subject: parsed.subject ?? '',
        timestamp: new Date(parseInt(message.internalDate)),
        labelIds: message.labelIds || [],
      },
      content: {
        ...(parsed.text != null ? { text: parsed.text.trim() } : {}),
        ...(parsed.html != null ? { html: parsed.html.trim() } : {}),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Outbound message construction + send
  //
  // Outbound mail is built into a raw RFC 2822 message at submit time and is
  // only delivered (via messages.send) after the action is approved — see the
  // approval-model comment in google.ts. Nothing is written to the user's
  // mailbox (no draft) before approval.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build a raw new outbound email and return the exact structured payload
   * used to generate it, for approval display.
   */
  buildSendRaw(to: string[], subject: string, body: string): GmailOutboundMessage {
    const normalizedTo = normalizeEmailRecipients(to);
    return {
      raw: buildEncodedEmail({ from: this.selfEmail, to: normalizedTo, subject, body }),
      from: this.selfEmail,
      to: normalizedTo,
      cc: [],
      subject,
      body,
      attachments: [],
    };
  }

  /**
   * Build a raw reply to an existing message. `originalMessage` is the cached
   * raw message being replied to (no extra fetch). When replyAll is true, this
   * mailbox's own address is filtered out of the CC list. Returns the encoded
   * raw message along with the resolved recipients and subject so the caller
   * can describe exactly what will be sent in the approval prompt.
   */
  async buildReplyRaw(
    originalMessage: GmailMessageRaw,
    body: string,
    replyAll: boolean,
    sourceWasSent?: boolean,
  ): Promise<GmailReplyMessage> {
    const original = await parseMimeMessage(originalMessage.raw);

    const originalFromAddr = original.from?.address ?? '';
    const originalSubject = original.subject ?? '';
    const self = this.selfEmail.toLowerCase();
    const originalTo = postalAddressListToEmailAddresses(original.to)
      .map(a => a.address)
      .filter(address => address && address.toLowerCase() !== self);
    const originalCc = postalAddressListToEmailAddresses(original.cc)
      .map(a => a.address)
      .filter(address => address && address.toLowerCase() !== self);
    // Gmail's SENT label is authoritative even when the message used a send-as
    // alias that differs from the primary account address.
    const sentBySelf = sourceWasSent ??
      (originalMessage.labelIds?.includes('SENT') === true ||
        originalFromAddr.toLowerCase() === self);

    // For an incoming message, Reply-To overrides From per normal email
    // semantics. For a message authored by this mailbox (e.g. from Sent), reply
    // to its original recipients rather than sending back to ourselves.
    const replyTo = postalAddressListToEmailAddresses(original.replyTo)
      .map(a => a.address)
      .filter(Boolean);
    let to = sentBySelf
      ? (replyAll ? originalTo : originalTo.slice(0, 1))
      : (replyTo.length > 0 ? replyTo : [originalFromAddr].filter(Boolean));
    let cc: string[] = [];

    if (replyAll) {
      const seen = new Set(to.map(a => a.toLowerCase()));
      const candidates = sentBySelf ? originalCc : [...originalTo, ...originalCc];
      cc = candidates.filter(addr => {
        const lower = addr.toLowerCase();
        if (lower === self || seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    }

    to = normalizeEmailRecipients(to);
    cc = normalizeEmailRecipients(cc)
      .filter(address => !to.some(item => item.toLowerCase() === address.toLowerCase()));
    if (to.length === 0) {
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

    const raw = buildEncodedEmail({
      from: this.selfEmail,
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      body,
      inReplyTo: parentId,
      references,
    });

    return {
      raw,
      from: this.selfEmail,
      to,
      cc,
      subject,
      body,
      attachments: [],
      sourceWasSent: sentBySelf,
    };
  }

  /**
   * Build a lossless forward by attaching the complete original raw message as
   * message/rfc822. This preserves the original HTML, MIME structure, headers,
   * inline resources, and attachments without reconstructing any of them.
   */
  async buildForwardRaw(
    originalMessage: GmailMessageRaw,
    to: string[],
    body?: string,
  ): Promise<GmailOutboundMessage> {
    const sourceBytes = base64UrlDecodedByteLength(originalMessage.raw);
    if (sourceBytes > MAX_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot forward this message: the original is ${sourceBytes} bytes, exceeding the ` +
        `${MAX_FORWARD_SOURCE_BYTES}-byte safe forwarding limit.`);
    }

    const normalizedTo = normalizeEmailRecipients(to);
    const original = await parseMimeMessage(originalMessage.raw);
    const originalSubject = original.subject ?? '';
    const subject = originalSubject.toLowerCase().startsWith('fwd:')
      ? originalSubject
      : `Fwd: ${originalSubject}`;
    const forwardBody = body ?? 'Forwarded message attached.';
    const attachment = {
      filename: 'forwarded-message.eml',
      // RFC 2045 forbids base64 transfer encoding for message/* composite
      // types. Use octet-stream with an .eml filename so clients still open it
      // as an attached email while preserving the bytes exactly.
      contentType: 'application/octet-stream',
      data: foldBase64(base64UrlToBase64(originalMessage.raw)),
    };
    const originalFrom = original.from
      ? (original.from.address
          ? `${original.from.name ? `${original.from.name} ` : ''}<${original.from.address}>`
          : original.from.name)
      : '(unknown sender)';
    const originalPreview = (original.text ?? original.html ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    const originalAttachments = original.attachments
      .slice(0, MAX_FORWARD_ATTACHMENT_DESCRIPTIONS)
      .map(item => {
        const size = typeof item.content === 'string'
          ? new TextEncoder().encode(item.content).byteLength
          : item.content.byteLength;
        const filename = (item.filename ?? '(unnamed)').replace(/[\r\n]+/g, ' ').slice(0, 200);
        return `${filename} (${item.mimeType}, ${size} bytes)`;
      });
    if (original.attachments.length > originalAttachments.length) {
      originalAttachments.push(
        `... ${original.attachments.length - originalAttachments.length} additional attachments omitted`);
    }
    const attachmentDescription = [
      `Complete original message from ${originalFrom}`,
      `Date: ${original.date ?? '(unknown)'}`,
      `Subject: ${originalSubject || '(no subject)'}`,
      `Preview: ${originalPreview || '(no text preview)'}`,
      `Embedded attachments: ${originalAttachments.length > 0 ? originalAttachments.join(', ') : 'none'}`,
    ].join('\n');

    return {
      raw: buildEncodedEmail({
        from: this.selfEmail,
        to: normalizedTo,
        subject,
        body: forwardBody,
        attachments: [attachment],
      }),
      from: this.selfEmail,
      to: normalizedTo,
      cc: [],
      subject,
      body: forwardBody,
      attachments: [{
        filename: attachment.filename,
        contentType: attachment.contentType,
        description: attachmentDescription,
      }],
    };
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
      const errorText = await readErrorText(response);
      throw new Error(`Failed to send message: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { id?: string; threadId?: string };
    if (!result.id || !result.threadId) {
      throw new Error("Gmail accepted the send request but returned an invalid response.");
    }
    return {id: result.id, threadId: result.threadId};
  }

  // ─────────────────────────────────────────────────────────────────
  // Labels
  // ─────────────────────────────────────────────────────────────────

  /** Fetch all labels for this account. Returns a map of label ID → label name. */
  async listLabels(): Promise<Map<string, string>> {
    const response = await this.authedFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    );

    if (!response.ok) {
      const errorText = await readErrorText(response);
      throw new Error(`Failed to list labels: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      labels: Array<{ id: string; name: string; type: string }>;
    };

    let map = new Map<string, string>();
    for (let label of data.labels || []) {
      map.set(label.id, label.name);
    }
    return map;
  }
}
