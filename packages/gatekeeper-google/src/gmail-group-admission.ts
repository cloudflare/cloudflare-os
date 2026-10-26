/**
 * Which messages in the owner's mailbox a Google Group's members may read.
 *
 * Decided one message at a time, from headers Gmail itself writes. A message is admitted when it
 * reached the owner through the group, or when it names the group as a recipient and its sender is
 * authenticated. Everything else in a thread, such as a reply sent to the owner alone, stays the
 * owner's. See `plans/gmail-group-sharing.md`.
 *
 * Only the topmost `Authentication-Results` is read, and only when Gmail wrote it (authserv-id
 * `mx.google.com`): Gmail adds its own above everything a message arrives with, so a sender can
 * place their own copies only below it. The same goes for `Return-Path`, which Gmail writes on
 * delivery.
 */

import { parseGmailMessageMetadata, type GmailMessageFull } from "./google-api";

/** A Google Group as Cloud Identity names it, every address lowercase. */
export type GmailGroupIdentity = {
  address: string;
  /** Other addresses the group receives mail at. */
  aliases: readonly string[];
};

/** Mail in these is not the group's: unsent, or set aside by Gmail or the owner. */
const UNADMITTED_LABELS = ["DRAFT", "SPAM", "TRASH"];

/** The headers {@link admitsGroupMessage} reads, for a metadata-only fetch. */
export const GMAIL_GROUP_ADMISSION_HEADERS = [
  "Authentication-Results", "DKIM-Signature", "Return-Path", "List-ID",
  "From", "To", "Cc", "Bcc", "Subject",
];

/**
 * A Gmail search for the mail that might be the group's: anything naming one of its addresses as
 * a list or a recipient, and no drafts. It only narrows; {@link admitsGroupMessage} decides.
 */
export function gmailGroupCandidates(group: GmailGroupIdentity): string {
  const terms = [group.address, ...group.aliases]
    .flatMap(address => [`list:${address}`, `to:${address}`, `cc:${address}`, `bcc:${address}`]);
  return `{${terms.join(" ")}} -in:drafts`;
}

/** Whether the group's members may read `message`. One whose headers don't parse is not theirs. */
export function admitsGroupMessage(group: GmailGroupIdentity, message: GmailMessageFull): boolean {
  try {
    return admits(group, message);
  } catch {
    return false;
  }
}

function admits(group: GmailGroupIdentity, message: GmailMessageFull): boolean {
  const labels = message.labelIds ?? [];
  if (labels.some(label => UNADMITTED_LABELS.includes(label))) return false;
  const headers = message.payload?.headers ?? [];
  const info = parseGmailMessageMetadata(message);
  const addresses = new Set([group.address, ...group.aliases]);
  const names = (list: readonly {address: string}[]) =>
    list.some(recipient => addresses.has(recipient.address.toLowerCase()));

  // The owner's own mail has no authentication results, and a Bcc to the group is the owner's to
  // make.
  if (labels.includes("SENT")) return names(info.to) || names(info.cc) || names(info.bcc);

  const results = gmailAuthenticationResults(headers);
  if (!results) return false;
  if (deliveredThroughGroup(group.address, headers, results)) return true;
  return (names(info.to) || names(info.cc)) && senderAuthenticated(info.from.address, headers, results);
}

// -- delivered through the group ---------------------------------------------------------------

/**
 * Google Groups sends each copy from a bounce address on the group's own domain, signs it with the
 * domain's DKIM key over its `List-ID`, and names itself there. SPF alone would not do: a Google
 * domain's SPF record covers every sender on Google's shared infrastructure.
 */
function deliveredThroughGroup(
    address: string, headers: readonly Header[], results: AuthResult[]): boolean {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const bounce = new RegExp(`^${escapeRegExp(local)}\\+bnc[a-z0-9]+@${escapeRegExp(domain)}$`);

  const spf = results.find(result => result.method === "spf" && result.result === "pass");
  const mailFrom = spf?.props.get("smtp.mailfrom")?.toLowerCase();
  if (!mailFrom || !bounce.test(mailFrom)) return false;
  if (angleAddress(topmost(headers, "Return-Path"))?.toLowerCase() !== mailFrom) return false;
  if (angleAddress(topmost(headers, "List-ID"))?.toLowerCase() !== `${local}.${domain}`) return false;
  return results.some(result =>
    result.method === "dkim" && result.result === "pass" && dkimDomain(result) === domain &&
    signatureCovers(headers, domain, result.props.get("header.b"), "list-id"));
}

// -- addressed to the group --------------------------------------------------------------------

/**
 * Gmail keeps one copy of a message that reaches the owner twice, and when the owner is addressed
 * directly that copy often lacks the group's headers. So a message naming the group is admitted
 * too, once its `From` is authenticated: by DMARC, or by a DKIM signature from the `From` domain,
 * which is the test DMARC applies and which Gmail may not report behind an inbound gateway.
 */
function senderAuthenticated(from: string, headers: readonly Header[], results: AuthResult[]): boolean {
  const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  if (!domain || !from.includes("@")) return false;
  if (results.some(result => result.method === "dmarc" && result.result === "pass" &&
      result.props.get("header.from")?.toLowerCase() === domain)) {
    return true;
  }
  return results.some(result => {
    if (result.method !== "dkim" || result.result !== "pass") return false;
    const signer = dkimDomain(result);
    return signer !== undefined && (domain === signer || domain.endsWith(`.${signer}`)) &&
      signatureCovers(headers, signer, result.props.get("header.b"), "from");
  });
}

// -- headers -----------------------------------------------------------------------------------

type Header = {name: string; value: string};

function topmost(headers: readonly Header[], name: string): string | undefined {
  return headers.find(header => header.name.toLowerCase() === name.toLowerCase())?.value;
}

/** The text inside the last `<…>` of a header such as `"Agent" <agent.example.com>`. */
function angleAddress(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /<([^<>]*)>\s*$/.exec(value);
  return match?.[1].trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type AuthResult = {method: string; result: string; props: Map<string, string>};

/** The results in the topmost `Authentication-Results`, when Gmail wrote it. */
function gmailAuthenticationResults(headers: readonly Header[]): AuthResult[] | undefined {
  const value = topmost(headers, "Authentication-Results");
  if (value === undefined) return undefined;
  const [authserv, ...entries] = splitOutsideQuotes(stripComments(value), ";");
  if (authserv.trim().split(/\s+/)[0]?.toLowerCase() !== "mx.google.com") return undefined;
  const results: AuthResult[] = [];
  for (const entry of entries) {
    const [head, ...props] = splitOutsideQuotes(entry.trim(), " ").filter(Boolean);
    const methodResult = head && /^([a-z0-9-]+)(?:\/\d+)?=([a-z0-9-]+)$/i.exec(head);
    if (!methodResult) continue;
    const parsed = new Map<string, string>();
    for (const prop of props) {
      const eq = prop.indexOf("=");
      if (eq > 0) parsed.set(prop.slice(0, eq).toLowerCase(), unquote(prop.slice(eq + 1)));
    }
    results.push({method: methodResult[1].toLowerCase(), result: methodResult[2].toLowerCase(), props: parsed});
  }
  return results;
}

/** The signing domain of a DKIM result: `header.d`, or the domain of `header.i`. */
function dkimDomain(result: AuthResult): string | undefined {
  const d = result.props.get("header.d");
  if (d) return d.toLowerCase();
  const i = result.props.get("header.i");
  return i?.includes("@") ? i.slice(i.lastIndexOf("@") + 1).toLowerCase() : undefined;
}

/**
 * Whether the DKIM signature a result names (by `header.b`, the start of its `b=` tag) is from
 * `domain` and signs `header`. A result that names no signature covers nothing.
 */
function signatureCovers(
    headers: readonly Header[], domain: string, prefix: string | undefined, header: string): boolean {
  if (!prefix || prefix.length < 8) return false;
  return headers.some(item => {
    if (item.name.toLowerCase() !== "dkim-signature") return false;
    const tags = dkimTags(item.value);
    return tags.get("d")?.toLowerCase() === domain && tags.get("b")?.startsWith(prefix) === true &&
      (tags.get("h") ?? "").toLowerCase().split(":").includes(header);
  });
}

function dkimTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const tag of value.split(";")) {
    const eq = tag.indexOf("=");
    if (eq > 0) tags.set(tag.slice(0, eq).trim().toLowerCase(), tag.slice(eq + 1).replace(/\s+/g, ""));
  }
  return tags;
}

/** Removes RFC 5322 comments, which may nest and may quote parentheses. */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += char + (value[i + 1] ?? "");
      i++;
    } else if (depth === 0 && char === '"') {
      quoted = !quoted;
      out += char;
    } else if (!quoted && char === "(") {
      depth++;
    } else if (!quoted && depth > 0 && char === ")") {
      depth--;
      if (depth === 0) out += " ";
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && quoted) {
      current += char + (value[i + 1] ?? "");
      i++;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (!quoted && (separator === " " ? /\s/.test(char) : char === separator)) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}
