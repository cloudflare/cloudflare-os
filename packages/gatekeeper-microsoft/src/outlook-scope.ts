// What an Outlook binding covers, and the one place that decides whether it covers a message. A
// binding is one mailbox, optionally narrowed to a folder (and its subfolders), a conversation, or
// some senders. Every narrowing is a predicate on the message's own
// metadata, so one read of a message decides; listings are narrowed in their Graph queries too,
// but only as an optimization: every result still passes through `admits`.
//
// The binding's resource URL is Outlook on the web's own URL for what it covers, with the
// narrowings in its query string; `parseOutlookUrl` reads it and `outlookUrl` writes it.

/** What an Outlook binding covers. Stored in the facet's props; every ID in it is immutable. */
export type OutlookScope = {
  mailbox: OutlookMailboxRef;
  folder?: { id: string; name: string; subfolders: boolean };
  conversation?: { id: string; subject: string };
  /** Addresses ("ada@contoso.com") or domains ("@contoso.com"), lowercase, any of. */
  senders?: string[];
  access: OutlookAccessLevel;
};

/** The binding's mailbox: the user's own, or a shared one keyed by its owner's object ID. */
export type OutlookMailboxRef = { kind: "me" } | { kind: "shared"; id: string; address: string };
/** What a binding may do; each level includes the ones before it. */
export type OutlookAccessLevel = "read" | "draft" | "send";

/** The access levels, lowest first. */
export const ACCESS_LEVELS: readonly OutlookAccessLevel[] = ["read", "draft", "send"];

/** Whether `access` allows what `needed` names. */
export function allows(access: OutlookAccessLevel, needed: OutlookAccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(access) >= ACCESS_LEVELS.indexOf(needed);
}

/** The lower of two access levels. */
export function lowerAccess(a: OutlookAccessLevel, b: OutlookAccessLevel): OutlookAccessLevel {
  return ACCESS_LEVELS[Math.min(ACCESS_LEVELS.indexOf(a), ACCESS_LEVELS.indexOf(b))]!;
}

/** A message's metadata, as far as the guard needs it. */
export type GuardedMessage = {
  id: string;
  parentFolderId: string;
  conversationId: string;
  from?: string;
  isDraft: boolean;
};

/** Folders a narrowed binding never covers unless it is narrowed to that folder itself. */
export const PRIVATE_WELL_KNOWN = ["drafts", "junkemail", "deleteditems", "outbox", "conversationhistory", "syncissues", "recoverableitemsdeletions"] as const;

/** How the guard learns about folders: their parents, and which are Outlook's private ones. */
export interface FolderTree {
  /** The folder's parent, or null at the top of the mailbox. */
  parentOf(folderId: string): Promise<string | null>;
  /** The IDs of Outlook's own folders in `PRIVATE_WELL_KNOWN`. */
  privateFolders(): Promise<ReadonlySet<string>>;
}

/** How deep a folder tree is walked before a message is refused as out of reach. */
const MAX_FOLDER_DEPTH = 32;

/**
 * Whether the binding covers `message`. `ownDrafts` holds the IDs of drafts this binding made, which
 * it covers whatever its narrowing, so a narrowed binding can see what it wrote.
 */
export async function admits(
  scope: OutlookScope, message: GuardedMessage, folders: FolderTree,
  options: { ownDrafts?: ReadonlySet<string> } = {},
): Promise<boolean> {
  if (message.isDraft && options.ownDrafts?.has(message.id)) return true;
  if (scope.conversation && message.conversationId !== scope.conversation.id) return false;
  if (scope.senders?.length && !senderMatches(scope.senders, message.from)) return false;
  if (scope.folder) {
    if (message.parentFolderId === scope.folder.id) return true;
    if (!scope.folder.subfolders) return false;
    return await descendsFrom(message.parentFolderId, scope.folder.id, folders);
  }
  // A narrowed binding sees neither Drafts, Junk nor Deleted Items, unless narrowed to one of them.
  return !isNarrowed(scope) || !(await underPrivateFolder(message.parentFolderId, folders));
}

/**
 * Whether a folder is in scope: the binding's folder or (when it includes them) its subfolders; for
 * a binding without a folder, any folder, except the private ones when it is narrowed.
 */
export async function admitsFolder(scope: OutlookScope, folderId: string, folders: FolderTree): Promise<boolean> {
  if (!scope.folder) {
    if (!isNarrowed(scope)) return true;
    return !(await underPrivateFolder(folderId, folders));
  }
  if (folderId === scope.folder.id) return true;
  return scope.folder.subfolders && await descendsFrom(folderId, scope.folder.id, folders);
}

/** Whether anything narrows the binding below the whole mailbox. */
export function isNarrowed(scope: OutlookScope): boolean {
  return scope.folder !== undefined || scope.conversation !== undefined || (scope.senders?.length ?? 0) > 0;
}

/** Whether `from` matches one of `senders`: an address exactly, or any address at a domain. */
function senderMatches(senders: readonly string[], from: string | undefined): boolean {
  if (!from) return false;
  const address = from.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@"));
  return senders.some(sender => sender.startsWith("@") ? domain === sender : address === sender);
}

async function descendsFrom(folderId: string, ancestorId: string, folders: FolderTree): Promise<boolean> {
  let current: string | null = folderId;
  for (let depth = 0; current !== null && depth < MAX_FOLDER_DEPTH; depth++) {
    current = await folders.parentOf(current);
    if (current === ancestorId) return true;
  }
  return false;
}

/**
 * Whether `folderId` is one of Outlook's private folders or inside one: deleting a folder in Outlook
 * moves it under Deleted Items, so a narrowed binding must look up the whole ancestry, not just the
 * message's own folder. A tree deeper than is walked counts as private, as `descendsFrom` refuses it.
 */
async function underPrivateFolder(folderId: string, folders: FolderTree): Promise<boolean> {
  const privateFolders = await folders.privateFolders();
  let current: string | null = folderId;
  for (let depth = 0; current !== null; depth++) {
    if (privateFolders.has(current)) return true;
    if (depth >= MAX_FOLDER_DEPTH) return true;
    current = await folders.parentOf(current);
  }
  return false;
}

// -- resource URLs ------------------------------------------------------------------------------

/** The origin binding URLs are written with. */
export const OUTLOOK_ORIGIN = "https://outlook.office.com";

/** What a URL names before it is resolved against the mailbox: folder names become IDs at binding. */
export type OutlookUrlTarget = {
  /** A shared mailbox's address, when the URL names one. */
  mailbox?: string;
  /**
   * A well-known folder ("inbox"), a path of display names under it ("inbox/Vendors"), or an
   * immutable folder ID (`id:<id>`).
   */
  folder?: string;
  /** A message whose conversation the URL names. */
  messageId?: string;
  /** A conversation, by its ID, as `outlookUrl` writes it. */
  conversationId?: string;
  subfolders: boolean;
  senders?: string[];
  access?: OutlookAccessLevel;
};

/** Outlook on the web's names for its own folders in URLs, which are Graph's well-known names too. */
const WEB_FOLDERS = new Set(["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"]);

/** A binding URL that can't be read or resolved; its message says why, for the user. */
export class OutlookUrlError extends Error {}

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DOMAIN = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_SENDERS = 50;

/**
 * An Outlook link as the binding grammar reads it. Outlook names messages in links by their EWS ID,
 * whose `/` and `+` Graph reads as a path separator and a space, so they become the REST ID Graph
 * expects (`-` and `_`, verified live). Outlook's "Open in Outlook" links (`/owa/?ItemID=…`, which
 * Graph's `webLink` gives) also name the message by query parameter instead of path.
 */
export function bindingLink(link: string): string {
  try {
    const url = new URL(link.trim());
    if (!/^outlook\.(office|office365)\.com$|^outlook\.cloud\.microsoft$/.test(url.hostname)) return link;
    const itemId = url.searchParams.get("ItemID");
    if (itemId !== null) return `${OUTLOOK_ORIGIN}/mail/id/${encodeURIComponent(restId(itemId))}`;
    const segments = url.pathname.split("/");
    const at = segments.indexOf("id");
    if (at < 0 || !segments[at + 1]) return link;
    segments[at + 1] = encodeURIComponent(restId(decodeURIComponent(segments[at + 1]!)));
    url.pathname = segments.join("/");
    return url.toString();
  } catch {
    return link;
  }
}

const restId = (id: string) => id.replace(/\//g, "-").replace(/\+/g, "_");

/**
 * Reads a binding URL, or a link copied from Outlook (see `bindingLink`). Throws `OutlookUrlError`,
 * saying what is wrong, for anything else.
 */
export function parseOutlookUrl(url: string): OutlookUrlTarget {
  let parsed: URL;
  try {
    parsed = new URL(bindingLink(url));
  } catch {
    throw new OutlookUrlError("That isn't a URL.");
  }
  if (parsed.origin !== OUTLOOK_ORIGIN && parsed.origin !== "https://outlook.office365.com" && parsed.origin !== "https://outlook.cloud.microsoft") {
    throw new OutlookUrlError("Outlook links start with https://outlook.office.com/mail/.");
  }
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    throw new OutlookUrlError("That Outlook link is garbled. Copy it again from Outlook's address bar.");
  }
  if (segments[0] !== "mail") throw new OutlookUrlError("Only Outlook mail links can be connected: https://outlook.office.com/mail/…");
  segments.shift();
  const target: OutlookUrlTarget = { subfolders: parsed.searchParams.get("subfolders") !== "0" };
  if (segments[0] !== undefined && ADDRESS.test(segments[0])) target.mailbox = segments.shift()!.toLowerCase();
  // Outlook on the web: /mail/{folder}/id/{itemId}, or /mail/id/{itemId}, or /mail/{folder}.
  const idAt = segments.indexOf("id");
  if (idAt >= 0) {
    target.messageId = segments[idAt + 1];
    if (!target.messageId || segments.length > idAt + 2) throw new OutlookUrlError("That Outlook link names a message in a way that can't be read.");
    segments.splice(idAt);
  }
  if (segments.length > 0) {
    const first: string = segments[0]!;
    const rest = segments.slice(1);
    if (first === "folder" && rest.length === 1) target.folder = `id:${rest[0]}`;
    else if (WEB_FOLDERS.has(first.toLowerCase())) target.folder = [first.toLowerCase(), ...rest].join("/");
    else throw new OutlookUrlError(`"${first}" isn't an Outlook folder in a link. Links name folders like /mail/inbox or /mail/folder/<id>.`);
  }
  const conversation = parsed.searchParams.get("conversation");
  if (conversation !== null) {
    if (!/^[A-Za-z0-9+/=_-]{8,512}$/.test(conversation)) throw new OutlookUrlError("That conversation ID can't be read.");
    target.conversationId = conversation;
  }
  const senders = list(parsed.searchParams.get("senders"));
  if (senders) {
    if (senders.length > MAX_SENDERS) throw new OutlookUrlError(`A binding can name at most ${MAX_SENDERS} senders.`);
    const lowered = senders.map(sender => sender.toLowerCase());
    for (const sender of lowered) {
      if (!ADDRESS.test(sender) && !DOMAIN.test(sender)) throw new OutlookUrlError(`"${sender}" isn't an address or an @domain.`);
    }
    target.senders = [...new Set(lowered)];
  }
  const access = parsed.searchParams.get("access");
  if (access !== null) {
    if (!(ACCESS_LEVELS as readonly string[]).includes(access)) throw new OutlookUrlError(`"access" is one of ${ACCESS_LEVELS.join(", ")}.`);
    target.access = access as OutlookAccessLevel;
  }
  return target;
}

/** The binding URL for a resolved scope: what the configurator writes and the binding shows. */
export function outlookUrl(scope: OutlookScope): string {
  const path = ["mail"];
  if (scope.mailbox.kind === "shared") path.push(scope.mailbox.address);
  if (scope.folder) path.push("folder", scope.folder.id);
  const url = new URL(`${OUTLOOK_ORIGIN}/${path.map(encodeURIComponent).join("/")}/`);
  if (scope.conversation) url.searchParams.set("conversation", scope.conversation.id);
  if (scope.folder && !scope.folder.subfolders) url.searchParams.set("subfolders", "0");
  if (scope.senders?.length) url.searchParams.set("senders", scope.senders.join(","));
  url.searchParams.set("access", scope.access);
  return url.toString();
}

function list(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  const items = value.split(",").map(item => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** The binding in words, for the user and the agent: "Mail from @contoso.com in Inbox in Ada's mailbox". */
export function describeScope(scope: OutlookScope, mailboxName: string): string {
  const parts: string[] = [];
  if (scope.conversation) parts.push(`The conversation "${scope.conversation.subject}"`);
  else if (scope.senders?.length) parts.push(`Mail from ${joinOr(scope.senders)}`);
  else parts.push(scope.folder || isNarrowed(scope) ? "Mail" : "All mail");
  if (scope.folder) parts.push(`in ${scope.folder.name}${scope.folder.subfolders ? " and its subfolders" : ""}`);
  parts.push(scope.mailbox.kind === "shared" ? `in the ${mailboxName} mailbox` : `in ${mailboxName}'s mailbox`);
  return parts.join(" ");
}

function joinOr(items: readonly string[]): string {
  return items.length <= 2 ? items.join(" or ") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}
