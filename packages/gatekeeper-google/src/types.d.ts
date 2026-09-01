import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export type { Cursor };

// ── Plain data types ────────────────────────────────────────────────

/** An email address with an optional display name. */
export type EmailAddress = {
  /** The mailbox address, such as `person@example.com`. */
  address: string;
  /** The sender- or recipient-provided display name. */
  name?: string;
}

/**
 * One recipient mailbox, either a bare address or a display-name form such as
 * `Person <person@example.com>`. Line breaks and recipient groups are rejected.
 */
export type EmailRecipient = string;

/**
 * A stable RFC 5322 Message-ID reserved for an outgoing message.
 * Once the message has been sent, this value can be passed to {@link GmailScopedSession.getMessage}.
 */
export type GmailMessageId = string;

/** Metadata describing a Gmail thread. */
export type GmailThreadInfo = {
  /** Gmail's stable identifier for the thread. */
  id: string;
  /** Preview text when Gmail includes one for this response. */
  snippet?: string;
  /** The thread subject. */
  subject: string;
  /** The number of messages represented by this thread capability. */
  messageCount: number;
  /** The timestamp of the newest represented message. */
  timestamp: Date;
  /** Unique senders and recipients across the represented messages. */
  participants: EmailAddress[];
  /** Whether any represented message is unread. */
  unread: boolean;
  /** Labels applied to at least one represented message. */
  labels: GmailLabel[];
}

/** Metadata describing a Gmail message. */
export type GmailMessageInfo = {
  /** Gmail's stable identifier for the message. */
  id: string;
  /** Gmail's stable identifier for the containing thread. */
  threadId?: string;
  /** The sender. */
  from: EmailAddress;
  /** The visible primary recipients. */
  to: EmailAddress[];
  /** The visible carbon-copy recipients. */
  cc: EmailAddress[];
  /** Blind-carbon-copy recipients retained in this mailbox's copy, if any. */
  bcc?: EmailAddress[];
  /** The message subject. */
  subject: string;
  /** Gmail's timestamp for the message. */
  timestamp: Date;
  /** Labels currently applied to the message. */
  labels: GmailLabel[];
}

/** One RFC 5322 header from a message. Header names are case-insensitive. */
export type GmailHeader = {
  /** Header name, such as `Message-ID` or `Reply-To`. */
  name: string;
  /** Unfolded header value. */
  value: string;
}

/** Email content in its available representations. */
export type EmailContent = {
  /** Plain-text content, when the message contains it. */
  text?: string;
  /** HTML content, when the message contains it. */
  html?: string;
}

/** Optional fields for a new message or forward. */
export type GmailComposeOptions = {
  /** Carbon-copy recipients. */
  cc?: EmailRecipient[];
  /** Blind-carbon-copy recipients. */
  bcc?: EmailRecipient[];
  /** HTML alternative for the plain-text body, which may be empty. */
  html?: string;
}

/**
 * Optional fields for a reply or reply-all. When every recipient field is
 * omitted, Gmail calculates the recipients from the source message. Providing
 * any recipient field replaces that complete calculated set; omitted recipient
 * fields are then treated as empty. At least one recipient is required.
 */
export type GmailReplyOptions = {
  /** HTML alternative for the plain-text body, which may be empty. */
  html?: string;
  /** Replacement primary recipients. */
  to?: EmailRecipient[];
  /** Replacement carbon-copy recipients. */
  cc?: EmailRecipient[];
  /** Replacement blind-carbon-copy recipients. */
  bcc?: EmailRecipient[];
}

/** Initial content for a Gmail draft. Every field may be filled in later. */
export type GmailDraftInput = {
  /** Primary recipients. */
  to?: EmailRecipient[];
  /** Carbon-copy recipients. */
  cc?: EmailRecipient[];
  /** Blind-carbon-copy recipients. */
  bcc?: EmailRecipient[];
  /** Subject line. */
  subject?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML alternative to the plain-text body. */
  html?: string;
}

/** Fields to replace on an existing Gmail draft. Omitted fields remain unchanged. */
export type GmailDraftPatch = {
  /** Replacement primary recipients. */
  to?: EmailRecipient[];
  /** Replacement carbon-copy recipients. */
  cc?: EmailRecipient[];
  /** Replacement blind-carbon-copy recipients. */
  bcc?: EmailRecipient[];
  /** Replacement subject line. */
  subject?: string;
  /** Replacement plain-text body. */
  text?: string;
  /** Replacement HTML body, or `null` to remove the HTML alternative. */
  html?: string | null;
}

/** Metadata describing a Gmail draft. */
export type GmailDraftInfo = {
  /** Stable identifier for the draft. */
  id: string;
  /** Gmail's identifier for the message stored in the draft, when available. */
  messageId?: string;
  /** Gmail's identifier for the conversation containing the draft, when available. */
  threadId?: string;
  /** Primary recipients currently stored in the draft. */
  to: EmailAddress[];
  /** Carbon-copy recipients currently stored in the draft. */
  cc: EmailAddress[];
  /** Blind-carbon-copy recipients currently stored in the draft. */
  bcc: EmailAddress[];
  /** The current subject line. */
  subject: string;
  /** Gmail's timestamp for the draft message. */
  timestamp: Date;
  /** Source information when this draft was created as a reply or forward. */
  source?: {
    /** How the source message is being used. */
    kind: "reply" | "forward";
    /** Gmail's stable identifier for the source message. */
    messageId: string;
  };
}

/** Metadata describing an attachment or inline MIME part. */
export type GmailAttachmentInfo = {
  /** Filename supplied by the message, if present. */
  filename: string | null;
  /** MIME media type, such as `application/pdf` or `image/png`. */
  mimeType: string;
  /** Content size in bytes. */
  size: number;
  /** Whether this part is a regular attachment, inline content, or unspecified. */
  disposition: "attachment" | "inline" | null;
  /** Content ID referenced by a `cid:` URL in the HTML body, if present. */
  contentId?: string;
  /** Whether `GmailAttachment.getContent()` can read this part. */
  readable: boolean;
}

// ── Capability interfaces ───────────────────────────────────────────
// These are RPC stubs — all methods are async. Capabilities can be
// passed across Worker boundaries and retain their access rights.

/** A thread cursor entry containing metadata and a thread capability. */
export type GmailThreadEntry = {
  /** Metadata for this result. */
  info: GmailThreadInfo;
  /** Capability for reading or changing this thread. */
  thread: GmailThread;
}

/** A message cursor entry containing metadata and a message capability. */
export type GmailMessageEntry = {
  /** Metadata for this result. */
  info: GmailMessageInfo;
  /** Capability for reading or changing this message. */
  message: GmailMessage;
}

/** A draft cursor entry containing metadata and a draft capability. */
export type GmailDraftEntry = {
  /** Metadata for this result. */
  info: GmailDraftInfo;
  /** Capability for reading or changing this draft. */
  draft: GmailDraft;
}

/** An attachment entry containing metadata and a content capability. */
export type GmailAttachmentEntry = {
  /** Metadata for this MIME part. */
  info: GmailAttachmentInfo;
  /** Capability for reading this MIME part's content. */
  attachment: GmailAttachment;
}

/** Access to the messages and drafts admitted by any Gmail binding. */
export interface GmailScopedSession {
  /** Return the connected mailbox address so it can be distinguished from other thread participants. */
  getMailboxAddress(): Promise<EmailAddress>;

  /**
   * List the most recent inbox threads available to a whole-mailbox binding.
   * Search- and label-scoped bindings retain their configured restriction.
   * Use {@link searchThreads} to include mail outside the inbox.
   */
  listThreads(): Promise<Cursor<GmailThreadEntry>>;

  /**
   * Search for threads with Gmail's native query syntax. Useful operators
   * include `from:`, `to:`, `after:`, `before:`, `is:unread`, and `label:`.
   * Any search or label restriction on the binding is also applied.
   */
  searchThreads(query: string): Promise<Cursor<GmailThreadEntry>>;

  /** @deprecated Use {@link searchThreads} instead. */
  search(query: string): Promise<Cursor<GmailThreadEntry>>;

  /**
   * List the most recent inbox messages available to a whole-mailbox binding.
   * Search- and label-scoped bindings retain their configured restriction.
   * Use {@link searchMessages} to include mail outside the inbox.
   */
  listMessages(): Promise<Cursor<GmailMessageEntry>>;

  /**
   * Search for individual messages with Gmail's native query syntax. Any
   * search or label restriction on the binding is also applied. Gmail may
   * briefly omit newly-sent mail from search results; retry a query such as
   * `in:sent ...` instead of treating the first empty result as a send failure.
   */
  searchMessages(query: string): Promise<Cursor<GmailMessageEntry>>;

  /**
   * Open a message by Gmail's stable provider ID or a {@link GmailMessageId}
   * returned by an outbound method. A whole-mailbox binding can open any
   * message available to the connected account; a restricted binding can open
   * messages matching its restriction and messages sent through that binding.
   */
  getMessage(id: string): Promise<GmailMessage>;

  /**
   * Open a thread by Gmail's stable thread ID. A whole-mailbox binding can
   * open any thread available to the connected account; a restricted binding
   * exposes only messages currently admitted by its restriction.
   */
  getThread(id: string): Promise<GmailThread>;

  /**
   * List drafts available to this binding. A whole-mailbox binding can list all
   * drafts; a restricted binding lists only drafts created through that same
   * binding whose immutable source message remains available to it.
   */
  listDrafts(): Promise<Cursor<GmailDraftEntry>>;

  /**
   * Reopen a draft by a stable {@link GmailDraftInfo.id} previously returned
   * by this binding. Pending updates are reflected by the returned capability.
   */
  getDraft(id: string): Promise<GmailDraft>;
}

/** Full-mailbox Gmail access, including composing messages and managing labels. */
export interface GmailSession extends GmailScopedSession {
  /**
   * Compose and send a new email. `body` is the plain-text representation;
   * `options.html`, when provided, is sent as its HTML alternative. At least
   * one To, CC, or BCC recipient is required. Returns an identifier that can
   * be passed to {@link GmailScopedSession.getMessage} once the message has been sent.
   */
  send(
    to: EmailRecipient[],
    subject: string,
    body: string,
    options?: GmailComposeOptions,
  ): Promise<GmailMessageId>;

  /**
   * Create a draft in the connected mailbox and return a capability for it.
   * Only available for a whole-mailbox binding.
   */
  createDraft(draft: GmailDraftInput): Promise<GmailDraft>;

  /** List the system and custom labels. Only available for a whole-mailbox binding. */
  listLabels(): Promise<GmailLabel[]>;

  /** Create a custom label. Only available for a whole-mailbox binding. */
  createLabel(name: string): Promise<GmailCustomLabel>;

  /** Rename a custom label. Only available for a whole-mailbox binding. */
  renameLabel(label: GmailCustomLabel, name: string): Promise<GmailCustomLabel>;

  /**
   * Delete a custom label. Messages keep their other labels. Only available
   * for a whole-mailbox binding.
   */
  deleteLabel(label: GmailCustomLabel): Promise<void>;
}

/** Access to one Gmail thread admitted by the binding's scope. */
export interface GmailThread {
  /**
   * Get the subject, snippet, and count for the messages this thread
   * capability is allowed to expose.
   */
  getMetadata(): Promise<GmailThreadInfo>;

  /**
   * Get the messages in the thread that are available to this binding. A
   * whole-mailbox binding can expose the complete thread; a search- or
   * label-scoped binding exposes only messages that individually match its restriction.
   */
  messages(): Promise<GmailMessage[]>;

  /**
   * Get the subset of messages in the thread that `address` sent or received
   * through To, CC, or BCC.
   *
   * Use this when composing a reply addressed to `address` so the history the
   * agent reads matches the history that recipient can see.
   *
   * Caveats:
   * - BCC recipients are detectable only in copies that retain the BCC header.
   * - Distribution-list membership is not expanded. Pass the list address when relevant.
   * - Matching is case-insensitive and exact; aliases are not resolved.
   */
  messagesVisibleTo(address: string): Promise<GmailMessage[]>;

  /** Remove the messages available through this capability from the inbox. */
  archive(): Promise<void>;

  /** Move the messages available through this capability to trash. */
  trash(): Promise<void>;

  /** Mark the messages available through this capability as read. */
  markRead(): Promise<void>;

  /** Mark the messages available through this capability as unread. */
  markUnread(): Promise<void>;

  /** Star the messages available through this capability. */
  star(): Promise<void>;

  /** Remove the star from the messages available through this capability. */
  unstar(): Promise<void>;

  /**
   * Apply a mutable label returned by this binding to the available messages.
   * Use {@link trash}, {@link markUnread}, or {@link star} instead of applying
   * the equivalent built-in label.
   */
  applyLabel(label: GmailMutableLabel): Promise<void>;

  /**
   * Remove a mutable label returned by this binding from the available messages.
   * Use {@link archive}, {@link markRead}, or {@link unstar} instead of removing
   * the equivalent built-in label.
   */
  removeLabel(label: GmailMutableLabel): Promise<void>;
}

/** Access to one Gmail message admitted by the binding's scope. */
export interface GmailMessage {
  /** Get sender, recipients, subject, timestamp, and labels. */
  getMetadata(): Promise<GmailMessageInfo>;

  /**
   * Get the ordered RFC 5322 headers retained in this mailbox's copy.
   * Throws when the header set exceeds the safe read limit.
   */
  getHeaders(): Promise<GmailHeader[]>;

  /** Get the thread containing this message. */
  thread(): Promise<GmailThread>;

  /** Get the message's plain-text and HTML body representations. */
  getContent(): Promise<EmailContent>;

  /** List regular attachments and inline MIME parts in the message. */
  attachments(): Promise<GmailAttachmentEntry[]>;

  /**
   * Reply to the sender. `body` is plain text and may be empty; `options.html`,
   * when provided, is its HTML alternative. Supplying any recipient option replaces
   * the complete recipient set calculated from the source message. For received mail,
   * reply uses Reply-To when present and otherwise From. For mail sent by the
   * connected mailbox, it uses the first original To recipient. Calculated
   * lists remove the connected mailbox, omit original BCC recipients, and
   * remove duplicates. Returns an identifier that can be passed to
   * {@link GmailScopedSession.getMessage} once the reply has been sent.
   */
  reply(body: string, options?: GmailReplyOptions): Promise<GmailMessageId>;

  /**
   * Reply to the sender plus the original To and CC recipients. Supplying any
   * recipient option replaces that complete calculated set. The connected
   * mailbox and duplicates are removed from calculated recipients. Returns an
   * identifier that can be passed to {@link GmailScopedSession.getMessage}
   * once the reply has been sent.
   */
  replyAll(body: string, options?: GmailReplyOptions): Promise<GmailMessageId>;

  /**
   * Forward this message inline using Gmail's standard forwarded-message
   * header block and quoted source content. `body` is an optional plain-text
   * preface and `options.html`, when provided, is its HTML alternative. The
   * original attachments are included as regular attachments. At least one
   * To, CC, or BCC recipient is required. Returns an identifier that can be
   * passed to {@link GmailScopedSession.getMessage} once the forward has been sent.
   */
  forward(
    to: EmailRecipient[],
    body?: string,
    options?: GmailComposeOptions,
  ): Promise<GmailMessageId>;

  /** Create a draft reply to the sender. */
  createReplyDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft>;

  /** Create a draft reply to all calculated recipients. */
  createReplyAllDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft>;

  /**
   * Create an inline draft forward using Gmail's standard forwarded-message
   * header block and quoted source content. `body` is an optional plain-text
   * preface and the original attachments are included as regular attachments.
   */
  createForwardDraft(
    to: EmailRecipient[],
    body?: string,
    options?: GmailComposeOptions,
  ): Promise<GmailDraft>;

  /** Remove this message from the inbox. */
  archive(): Promise<void>;

  /** Move this message to trash. */
  trash(): Promise<void>;

  /** Mark this message as read. */
  markRead(): Promise<void>;

  /** Mark this message as unread. */
  markUnread(): Promise<void>;

  /** Star this message. */
  star(): Promise<void>;

  /** Remove the star from this message. */
  unstar(): Promise<void>;

  /**
   * Apply a mutable label returned by this binding to this message. Use
   * {@link trash}, {@link markUnread}, or {@link star} instead of applying the
   * equivalent built-in label.
   */
  applyLabel(label: GmailMutableLabel): Promise<void>;

  /**
   * Remove a mutable label returned by this binding from this message. Use
   * {@link archive}, {@link markRead}, or {@link unstar} instead of removing the
   * equivalent built-in label.
   */
  removeLabel(label: GmailMutableLabel): Promise<void>;
}

/** Access to a draft in the connected Gmail mailbox. */
export interface GmailDraft {
  /** Get the draft's current identifiers, recipients, subject, and timestamp. */
  getMetadata(): Promise<GmailDraftInfo>;

  /** Get the draft's plain-text and HTML body representations. */
  getContent(): Promise<EmailContent>;

  /** List regular attachments and inline MIME parts currently stored in the draft. */
  attachments(): Promise<GmailAttachmentEntry[]>;

  /**
   * Replace selected fields while preserving omitted fields. A reply draft's
   * subject cannot be changed, so it remains in its source thread. A forward
   * draft's source message and quoted content cannot be changed or removed by
   * this method.
   */
  update(patch: GmailDraftPatch): Promise<void>;

  /** Delete the draft without sending it. */
  delete(): Promise<void>;

  /**
   * Send the draft, preserving its thread placement when it is a reply.
   * Sending requires at least one recipient. New drafts require a plain-text body;
   * reply drafts may have an empty body. Returns an identifier that can be passed
   * to {@link GmailScopedSession.getMessage} once the draft has been sent.
   */
  send(): Promise<GmailMessageId>;
}

/** Read access to one regular attachment or inline MIME part. */
export interface GmailAttachment {
  /** Get filename, MIME type, size, disposition, content ID, and readability. */
  getMetadata(): Promise<GmailAttachmentInfo>;

  /**
   * Read the binary content. Check `GmailAttachmentInfo.readable` first; this
   * throws when that field is false, the content becomes unavailable, or the
   * part exceeds the 10 MiB safe-read limit.
   */
  getContent(): Promise<ArrayBuffer>;
}

// ── Gmail labels ────────────────────────────────────────────────────

/** Well-known Gmail system label names. */
export type GmailSystemLabel =
  | "INBOX" | "TRASH" | "SPAM" | "UNREAD" | "STARRED"
  | "IMPORTANT" | "SENT" | "DRAFT" | "CHAT"
  | "CATEGORY_PRIMARY" | "CATEGORY_PERSONAL" | "CATEGORY_SOCIAL"
  | "CATEGORY_PROMOTIONS" | "CATEGORY_UPDATES" | "CATEGORY_FORUMS";

/** System labels that callers can add or remove from messages. */
export type GmailMutableSystemLabel =
  | "INBOX" | "TRASH" | "SPAM" | "UNREAD" | "STARRED" | "IMPORTANT"
  | "CATEGORY_PERSONAL" | "CATEGORY_SOCIAL" | "CATEGORY_PROMOTIONS"
  | "CATEGORY_UPDATES" | "CATEGORY_FORUMS";

/** A mutable Gmail system label. */
export type GmailMutableSystemLabelInfo = {
  id: string;
  name: GmailMutableSystemLabel;
  type: "system";
}

/** A custom label owned by the connected mailbox. */
export type GmailCustomLabel = {
  id: string;
  name: string;
  type: "custom";
}

/** A system or custom label that can be added to or removed from messages. */
export type GmailMutableLabel = GmailMutableSystemLabelInfo | GmailCustomLabel;

/** A Gmail label, identified by the stable ID used for label operations. */
export type GmailLabel =
  | { id: string; name: GmailSystemLabel; type: "system" }
  | GmailCustomLabel;
