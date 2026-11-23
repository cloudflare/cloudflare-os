// The contract between the Outlook configurator frame and `OutlookConfiguratorUI`. The frame is
// transpiled on its own and cannot import runtime code, so the shapes it trades are declared here.
// The frame never builds a resource URL itself: it sends a draft, and the gatekeeper resolves it
// and writes the URL with `outlookUrl`.

/** What a binding lets agents do, lowest first. Matches `OutlookAccessLevel` in outlook-scope.ts. */
export type OutlookConfiguratorAccess = "read" | "draft" | "send";

/** What the connection allows, read when the frame opens and again after a consent pop-up. */
export type OutlookConfiguratorStatus =
  | {
    state: "ready";
    /** The signed-in user, whose mailbox is the default. */
    me: { address: string; name: string };
    /** The levels a binding of the user's own mailbox may have, lowest first. */
    levels: OutlookConfiguratorAccess[];
    /** The levels a binding of a shared mailbox may have, lowest first; empty when the grant can't open one. */
    sharedLevels: OutlookConfiguratorAccess[];
    /** Whether the deployment, rather than the connection's grant, is what stops `levels` short of `send`. */
    limitedByDeployment: boolean;
  }
  /** The connection's grant does not cover Outlook; `ensureResources` asks for it. */
  | { state: "needsAccess" }
  /** The account has no mailbox, such as one with no Exchange Online license. */
  | { state: "unavailable"; message: string };

/** A binding being configured, before the gatekeeper has resolved it. */
export type OutlookDraft = {
  /** A shared mailbox's address; absent for the user's own mailbox. */
  mailbox?: string;
  folder?: { id: string; subfolders: boolean };
  conversationId?: string;
  /** Addresses or `@domain`s, any of. */
  senders?: string[];
  access: OutlookConfiguratorAccess;
};

export type OutlookFolderKind = "inbox" | "drafts" | "sent" | "deleted" | "junk" | "archive" | "outbox" | "history" | "folder";

/** One folder, in the order Outlook shows them: a parent before its subfolders. */
export type OutlookFolderRow = {
  /** The folder's immutable ID. */
  id: string;
  name: string;
  /** "Inbox/Vendors". */
  path: string;
  /** 0 at the top of the mailbox. */
  depth: number;
  kind: OutlookFolderKind;
  /** How many folders are below it, at any depth, in this listing. */
  descendants: number;
};

export type OutlookFolderList = {
  folders: OutlookFolderRow[];
  /** Set when the listing is incomplete, saying why. */
  notice?: string;
};

export type OutlookPerson = { address: string; name?: string };

export type OutlookSharedMailbox = { address: string; name: string };

/** A conversation, as its latest message shows it. */
export type OutlookConversation = {
  id: string;
  subject: string;
  /** The latest message's sender, by name where known. */
  from?: string;
  receivedAt?: string;
};

export type OutlookConversationList = { items: OutlookConversation[]; notice?: string };

/** A binding URL, read back into what the frame shows, for editing a binding. */
export type OutlookLocated = {
  mailbox?: { address: string; name: string };
  folder?: { id: string; path: string; subfolders: boolean };
  conversation?: { id: string; subject: string };
  senders?: string[];
  access: OutlookConfiguratorAccess;
};

export interface OutlookConfiguratorRpc {
  getStatus(): Promise<OutlookConfiguratorStatus>;
  /** Opens a shared mailbox's Inbox, proving the user can. Rejections carry a message written for the user. */
  openSharedMailbox(address: string): Promise<OutlookSharedMailbox>;
  /** The mailbox's folders; `mailbox` is a shared mailbox's address, or null for the user's own. */
  listFolders(mailbox: string | null): Promise<OutlookFolderList>;
  /** People the user works with whose name or address matches. */
  searchPeople(query: string): Promise<OutlookPerson[]>;
  /** Recent conversations, those whose subject matches `query`, or the one an Outlook link names. */
  findConversations(mailbox: string | null, query: string): Promise<OutlookConversationList>;
  /** The resource URL a draft binds, once the gatekeeper has resolved and checked it. */
  resourceUrlFor(draft: OutlookDraft): Promise<string>;
  /** What a resource URL binds, or null when it names nothing the user can open. */
  locate(resourceUrl: string): Promise<OutlookLocated | null>;
}
