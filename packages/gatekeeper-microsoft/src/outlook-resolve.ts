// Resolves an Outlook binding URL into a scope, as the user, at binding time: a shared mailbox's
// address becomes its owner's object ID, folder names and paths become immutable folder IDs, and a
// message link becomes its conversation. So renaming or moving a folder later can neither break nor
// widen the binding.

import { GraphApiError, type GraphApi } from "./graph-api";
import { MailApi, isMailId, type GraphFolder } from "./outlook-graph";
import { odataString } from "./outlook-query";
import {
  OutlookUrlError, lowerAccess, parseOutlookUrl, type OutlookAccessLevel, type OutlookMailboxRef, type OutlookScope,
} from "./outlook-scope";

/** Outlook folder names in URLs, by Graph's well-known names. */
const WELL_KNOWN_NAMES: Record<string, string> = {
  inbox: "Inbox", sentitems: "Sent Items", drafts: "Drafts", deleteditems: "Deleted Items", archive: "Archive", junkemail: "Junk Email",
};

/**
 * Resolves a binding URL as the signed-in user.
 * @param ceiling The most the binding may do: the deployment's ceiling, narrowed by the grant.
 * @param me The signed-in user's own address, so a link naming their own mailbox isn't taken as shared.
 * @param meObjectId Their object ID, so a link naming them by an alias or UPN isn't either.
 * @throws OutlookUrlError, saying what is wrong, for a URL that names nothing the user can open.
 */
export async function resolveOutlookUrl(api: GraphApi, url: string, ceiling: OutlookAccessLevel, me: string, meObjectId?: string): Promise<OutlookScope> {
  const target = parseOutlookUrl(url);
  const mailbox = await resolveMailbox(api, target.mailbox, me, meObjectId);
  const mail = new MailApi(api, mailbox);
  const scope: OutlookScope = { mailbox, access: lowerAccess(target.access ?? ceiling, ceiling) };
  if (target.folder !== undefined) {
    const folder = await resolveFolder(mail, target.folder);
    scope.folder = { id: folder.id, name: folder.name, subfolders: target.subfolders };
  }
  const conversationOf = target.messageId;
  if (conversationOf !== undefined) {
    if (!isMailId(conversationOf)) throw new OutlookUrlError("That Outlook link names a message in a way that can't be read.");
    const message = await mail.message(conversationOf);
    if (message === null || message.conversationId === "") throw new OutlookUrlError("That message isn't in the mailbox, or you can't open it.");
    scope.conversation = { id: message.conversationId, subject: message.subject || "(no subject)" };
    // A message link names its conversation, wherever its messages are filed.
    delete scope.folder;
  } else if (target.conversationId !== undefined) {
    const page = await mail.get<{ value?: { subject?: unknown }[] }>("/messages", {
      $filter: `conversationId eq ${odataString(target.conversationId)}`, $select: "subject", $top: 1,
    });
    const first = page.value?.[0];
    if (first === undefined) throw new OutlookUrlError("That conversation isn't in the mailbox, or you can't open it.");
    scope.conversation = { id: target.conversationId, subject: typeof first.subject === "string" && first.subject !== "" ? first.subject : "(no subject)" };
  }
  if (target.senders) scope.senders = target.senders;
  return scope;
}

/** The mailbox a URL names: the user's own, or a shared one they can open, by its object ID. */
async function resolveMailbox(api: GraphApi, address: string | undefined, me: string, meObjectId: string | undefined): Promise<OutlookMailboxRef> {
  if (address === undefined || address === me.toLowerCase()) return { kind: "me" };
  const user = await api.find<{ id?: unknown; mail?: unknown }>(`/users/${encodeURIComponent(address)}`, { query: { $select: "id,mail" } });
  if (user === null || typeof user.id !== "string") throw new OutlookUrlError(`There's no mailbox ${address} in your organization that you can open.`);
  // An alias or UPN of the user's own: as "shared", it would need the .Shared scopes for nothing.
  if (user.id === meObjectId) return { kind: "me" };
  const mailbox: OutlookMailboxRef = { kind: "shared", id: user.id, address: typeof user.mail === "string" ? user.mail.toLowerCase() : address };
  // Opening its Inbox proves the user has been given access to it: a directory entry alone isn't.
  const inbox = await new MailApi(api, mailbox).folder("inbox").catch(error => {
    if (error instanceof GraphApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  });
  if (inbox === null) throw new OutlookUrlError(`You haven't been given access to the ${address} mailbox. Ask its owner or your administrator.`);
  return mailbox;
}

/** A folder by `id:<id>`, a well-known name, or a path of display names under a well-known folder. */
async function resolveFolder(mail: MailApi, folder: string): Promise<GraphFolder> {
  if (folder.startsWith("id:")) {
    const id = folder.slice(3);
    if (!isMailId(id)) throw new OutlookUrlError("That folder ID can't be read.");
    const found = await mail.folder(id);
    if (found === null) throw new OutlookUrlError("That folder isn't in the mailbox anymore, or you can't open it.");
    return found;
  }
  const [root, ...names] = folder.split("/");
  let current = await mail.folder(root!);
  if (current === null) throw new OutlookUrlError(`The mailbox has no ${WELL_KNOWN_NAMES[root!] ?? root} folder.`);
  if (names.length === 0 && WELL_KNOWN_NAMES[root!]) current = { ...current, name: current.name || WELL_KNOWN_NAMES[root!]! };
  for (const name of names) {
    const children: GraphFolder[] = await mail.childFolders(current.id);
    const next: GraphFolder | undefined = children.find(child => child.name.toLowerCase() === name.toLowerCase());
    if (next === undefined) throw new OutlookUrlError(`${current.name} has no folder named "${name}".`);
    current = next;
  }
  return current;
}

/**
 * A folder's path from the top of the mailbox, "Inbox/Vendors". Walks `folder` up to the mailbox's
 * root folder (`msgfolderroot`), which isn't part of the path; a nameless folder adds nothing.
 */
export async function folderPath(folder: (id: string) => Promise<GraphFolder | null>, rootId: string | undefined, id: string, limit = 32): Promise<string> {
  const names: string[] = [];
  let current: string | undefined = id;
  for (let depth = 0; current !== undefined && current !== rootId && depth < limit; depth++) {
    const found: GraphFolder | null = await folder(current);
    if (found === null) break;
    if (found.name !== "") names.unshift(found.name);
    current = found.parentId;
  }
  return names.join("/");
}
