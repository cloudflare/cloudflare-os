# Outlook: the Microsoft 365 gatekeeper's mail resource

Outlook mail for agents: read, search, triage, draft, and send with approval, in the user's own
mailbox or a shared one they can open. It is a resource of `gatekeeper-microsoft` beside SharePoint
and Calendar, so one Microsoft connection, one app registration, and the same tenant pinning,
credential handling and Graph client serve all three.

## Verified Graph behaviour

Each of these was checked against a live tenant, and the code depends on it.

- **Immutable IDs.** With `Prefer: IdType="ImmutableId"`, a message keeps its ID across moves, and a
  draft's ID survives sending (the Sent Items copy has the same ID). Default IDs change whenever a
  message moves, so every request sends the header.
- **Message-IDs.** A draft may carry an `internetMessageId` chosen by the caller; it survives
  sending, the recipient's copy has the same Message-ID, and `$filter=internetMessageId eq '…'`
  finds it.
- **Replies.** `createReply`/`createReplyAll`/`createForward` keep the conversation and write the
  threading headers and quoted original. `uniqueBody` returns just what a message added to its
  conversation.
- **Filter and sort.** Exchange refuses `$filter` with `$orderby` ("The restriction or sort order is
  too complex for this operation") unless the sorted property leads the filter. Every filtered
  listing therefore leads with `receivedDateTime ge <cutoff>` (the start of time when there is no
  cutoff) and sorts on `receivedDateTime`.
- **The window after `/send`.** For about half a second after Graph accepts `/send` (202), the
  message still reads as a draft in Drafts, and a second `/send` gets 403 `ErrorAccessDenied`
  ("Cannot submit message"). The message then passes through Outbox into Sent Items under the same
  immutable ID.
- **Sent Items' `from` is a legacy DN.** The mailbox's own sent copies and drafts carry `from` as an
  X.500 DN (`/O=EXCHANGELABS/…`), not an address.
- **Four requests per mailbox.** Exchange runs at most four concurrent requests per mailbox; `$batch`
  entries beyond that come back 429 individually.
- **Malformed IDs.** Graph answers a malformed ID with 400 `ErrorInvalidIdMalformed`, and an ID from
  another mailbox with 403 or 404.
- **IDs are confined to the mailbox they're addressed through.** A user with read access to another
  user's calendar gets 404 for that user's message and event IDs through their own `/me` ("The store
  ID provided isn't an ID of an item"), so the mailbox path is a boundary.
- **Links use EWS IDs.** Outlook on the web names messages by EWS ID, whose `/` and `+` Graph reads as
  a path separator and a space; the REST ID uses `-` and `_`.
- **Shared mailboxes.** `/users/{address}` is 403 with `User.Read` alone; `User.ReadBasic.All` is
  needed to find a shared mailbox's object ID. A shared mailbox's master category list can't be read
  with delegated permissions.
- **Push.** Graph validates a notification URL by asking for a token back, then posts `created`
  notifications carrying the subscription's `clientState` within seconds. Mail subscriptions last a
  little under seven days.

## The binding

A binding is one mailbox, optionally narrowed. Every narrowing is a predicate on a message's own
metadata, so one Graph read of a message decides whether the binding covers it.

```ts
type OutlookScope = {
  mailbox: { kind: "me" } | { kind: "shared"; id: string; address: string }; // id: the mailbox user's object ID
  folder?: { id: string; name: string; subfolders: boolean };                 // immutable folder ID
  conversation?: { id: string; subject: string };
  senders?: string[];        // "ada@contoso.com" or "@contoso.com", any of
  access: "read" | "draft" | "send";
};
```

`access` is chosen per binding and capped by the deployment's `MICROSOFT_OUTLOOK_ACCESS` and by the
grant's scopes, the lowest winning. The levels follow Microsoft's permissions: `Mail.Read`,
`Mail.ReadWrite` (drafts and organizing both) and `Mail.Send`. A `read` binding's session is an `OutlookReader`, with no write
methods at all, and a `draft` binding's an `OutlookDrafter`, without the send methods.

A shared mailbox is keyed by its owner's object ID, so a reassigned address can't redirect the
binding, and it is bound only after its Inbox opens as the user: a directory entry alone isn't
access. Every Outlook level therefore requests `User.ReadBasic.All`, and `grantsSharedMailboxes`
requires it.

### Resource URLs

Binding URLs are Outlook on the web's own URLs (`https://outlook.office.com/mail/…`), with the
narrowings in the query string. `parseOutlookUrl` reads them, `outlookUrl` writes them.

- `…/mail/` is the whole mailbox; `…/mail/inbox`, `…/mail/inbox/Vendors` or `…/mail/folder/<id>` a
  folder; `…/mail/inbox/id/<id>` the conversation of that message; `…/mail/<address>/…` the same in a
  shared mailbox.
- Query: `conversation=<id>`, `senders=a@x.com,@y.com`, `subfolders=0`, `access=draft`.
- Links copied from Outlook are accepted too: EWS IDs are converted to REST IDs, and "Open in
  Outlook" links (`/owa/?ItemID=…`, which Graph's `webLink` gives) are read.

Folder names and message links resolve once, at binding time (`outlook-resolve.ts`): names become
immutable folder IDs and a message becomes its conversation, so renaming or moving a folder later
can neither break nor widen the binding.

### The scope guard (`outlook-scope.ts`)

`admits` is the one decision. It checks a message's `parentFolderId` (against the folder, or its
subtree by walking folder ancestry), `conversationId`, and `from` address or domain; the mailbox is fixed by the path every request goes through.
`OutlookContext.guarded` reads every message ID an agent passes with that metadata first, and only
then is anything else read or changed. 400, 403 and 404 all mean "not in this binding", and a
message outside the binding is refused with the same words as one that doesn't exist.

A listing is narrowed in its Graph query where Exchange allows (`outlook-query.ts`), and every
result still passes through `admits`: the query is an optimization. Drafts a binding made are
covered by that binding whatever its narrowing, so a sender-narrowed binding can see the reply it
wrote.

A narrowed binding never covers Drafts, Junk Email, Deleted Items, Outbox, Conversation History,
Sync Issues or Recoverable Items, unless it is narrowed to that folder itself.

## The agent's API (`src/outlook-types.d.ts`)

Methods take IDs, and every ID is checked by the guard. Entries carry enough metadata to decide
without a second read.

- Read: `getMailbox()` (address, name, own or shared, time zone, the binding in words, the access
  level), `listFolders()`, `listMessages({ folderId, unread, flagged, from, category, since,
  focused })`, `search(query)` (Outlook's KQL syntax), `getMessage(id)`, `readMessage(id)` (safe
  Markdown, links listed, removals named), `readConversation(id)` (each covered message's new text,
  oldest first, up to 50), `listAttachments(id)`, `readAttachment(id, attachmentId)` (converted as
  SharePoint files are, except HTML, which is read as a body is), `readAttachmentBytes` (up to 25 MB), `listCategories()`,
  `findPeople(query)` (the People API, for addressing mail without guessing).
- Organize (access `draft`): `move`, `archive`, `delete` (to Deleted Items), `markRead`, `flag`, `categorize`,
  `createFolder`. Each takes up to 50 messages and is one approval naming them by sender and
  subject.
- Draft: `createDraft`, `createReplyDraft`, `createForwardDraft`, `updateDraft`, `deleteDraft`.
  Bodies are Markdown, written as Outlook HTML. Drafts land in the user's Drafts folder, where they
  can finish and send them themselves. `updateDraft` and `deleteDraft` take only drafts the binding
  wrote (`ownDraft:` in the gatekeeper's storage): their actions can be auto-approved, and a change to
  a draft the user is about to send from Outlook would go out unseen. The user's own drafts can be
  read, and sent with `send`, which is never auto-approved and shows the draft whole.
- Send: `send(draftId)`, `sendMail`, `reply`, `forward`. A reply's `to`, `cc` and `bcc` add to the
  reply's own recipients, never replace them.
- Automatic replies, whole-mailbox bindings only: `getAutomaticReplies()` (draft) and
  `setAutomaticReplies()` (send, since an automatic reply sends agent-written text to whoever
  writes, outside the organization too).
- Hooks: `subscribeNewMessages(hook)`.

Not offered at any level: inbox rules (a forwarding rule is a standing exfiltration channel),
permanent deletion, mailbox or folder permissions, delegates, send-as.

Move destinations and new folders' parents must be folders the user sees in Outlook: under the
mailbox root, not the root itself, not hidden, and not Recoverable Items (which is purged), Outbox,
Drafts, Sync Issues or Deleted Items (`delete` is the way there, so the approver sees a deletion).

Write bounds: 100,000 characters of body, 20 attachments of at most 3 MB each (Graph's inline limit)
and 20 MB together, 100 recipients per field.

## Actions (`outlook-actions.ts`)

Kit `defineActions`: journaled, simulated by `outlook-overlay.ts` while pending, and revertible where
Exchange allows. Every action is fenced on the connection's `(tenantId, objectId)`.

| Tag | Actions | Auto-approvable | Revert |
|---|---|---|---|
| `outlook.organize` | move, archive, delete (to Deleted Items), mark read, flag, categorize, create folder | Yes | moves back; restores read state, flag and categories; deletes the folder if still empty |
| `outlook.drafts` | create a draft; update or delete one the binding wrote | Yes | create: moves the draft to Deleted Items (refused once sent); update: restores text and recipients (fenced on the key the update left), not removed attachments; delete: moves it back to Drafts |
| `outlook.send` | send a draft, a new message, a reply, a forward | **Never** | can't be unsent |
| `outlook.settings` | automatic replies | **Never** | restores the previous setting |

**Idempotent sends.** Each send fixes its own Message-ID at submit. Apply looks for that ID across
the whole mailbox (a sent copy wins over a draft; Outbox counts, so a replay during the send can't
send twice), reuses a draft it finds only if its change key is the one the earlier attempt recorded
when it finished building it, and otherwise moves that leftover to Deleted Items (where the search
no longer counts it) and builds the message again, then calls `/send`. So a draft cut short before
its attachments, or touched in Outlook between attempts, is never what goes. A replay after a crash
finishes or finds the send and never repeats it, without `claimBeforeApply`'s terminal "outcome
unknown". `submit` treats a 403 on `/send` as the earlier submit only once polling `isDraft` shows
the message left Drafts (up to six half-second polls); otherwise the 403 stands.

**A draft is sent only as approved.** Sending an existing draft is fenced on its change key: the one
it had when proposed (read in the same request as the recipients and body the approver is shown), or for a draft still being created, the one its creation left (stored under
`draftVersion:`). Anything that touches the draft in between (an edit in Outlook, another action,
even marking it read) fails the send. A send isn't accepted while an edit of the draft is pending,
nor an edit or deletion while a send is; those checks race with concurrent proposals, so an edit of
ours is also recorded as such (`byEdit`) when it applies, and a send of a created draft is refused
when the version it finds was left by an edit applied after the send was proposed. An edit of a
created draft is fenced the same way, with `If-Match`, and refused once the draft has been sent.

**What the approver sees for a send:** every recipient, each noted when outside the organization,
when the user hasn't written to them before (a search of Sent Items), and for a reply, when not
already in the conversation or when the message's Reply-To isn't its sender; the subject; the body
verbatim; each attachment with name, media type and size, and SHA-256 for one the agent added; the
message it replies to; and for a forward, the forwarded message's text (bounded, as safe Markdown)
and attachments, since Outlook sends those along whole.

**Approval prose can't be argued with.** Subjects, sender names and folder names, chosen by senders
and agents, go through `plainInline` in description prose (with `<` dropped), and addresses through
`codeSpan`. Fields show them verbatim.

## Reading mail safely (`outlook-content.ts`)

Mail is written by its sender, not the user. `readMessage` builds a small tree from the body's HTML,
removes what a person couldn't see or an agent shouldn't follow, and converts the rest with
`html-markdown.ts`:

- scripts, styles, forms, embeds and comments, with their content;
- hidden text: `display:none` and kin, `mso-hide`, near-zero opacity, zero boxes and clipped boxes of
  a pixel or two, off-screen positioning, margins, translation or `text-indent`, `clip`/`clip-path`,
  `scale(0)`, collapsed letter-spacing, text of 3px or less, and text coloured like its background
  (transparent and alpha colours, `hsl()`, every CSS named colour). The message's own `<style>`
  counts: hiding rules by a selector's last compound (which hides more, never less), and colours and
  sizes from single-compound selectors (`.x`, `td.x`, `body`), merged under the element's own style;
- Unicode's default-ignorable characters, tag characters included, from bodies and from subjects,
  names, previews and attachment names;
- tracking images (2px or smaller, or known tracker hosts) and `data:` images, counted; other images
  become their alt text.

Links are listed separately with their real targets, unwrapped from Microsoft Defender Safe Links and
Proofpoint URL Defense, and flagged when their text names a different registrable domain. Layout
tables flatten to text; data tables stay tables. Each message says who wrote it relative to the user
(`senderKind`: you, a colleague by verified domain, or external). A message protected with Purview or
S/MIME (a `message.rpmsg` or `smime.p7m` attachment) is reported as encrypted rather than shown
empty. Messages are read with the mailbox owner's address in place of the X.500 DN, so `senderKind`
and the approver's view are right.

## Observers (`outlook-observers.ts`)

An observer is shown a read only if their own Microsoft 365 account, in the owner's tenant, can open
everything it revealed. Access units: `mailbox` (probed by listing the whole mailbox's messages),
`mailFolder`, and `mail` (the message itself), each probed by immutable ID with the observer's token.
Someone shared a single folder opens that folder and its messages but gets 404 listing the mailbox
(verified live with an Inbox-only Reviewer), so they observe reads of that folder and nothing that
stands for the whole mailbox. For the user's
own mailbox almost no one passes, so mail reads are kept from observers while the workspace stays
shareable; for a shared mailbox, its members pass. `findPeople` reveals the signed-in user's own
mailbox unit, and a narrowed binding's description is observed as mail, since it names folders,
subjects or people.

## New-message hooks (`outlook-hooks.ts`)

`subscribeNewMessages(hook)` binds a hook that starts disabled until the user enables it. Once
enabled, it receives `{ message, mail }` for each new message the binding covers in Inbox (or the
binding's folder), where `mail` is a session for the same binding. Drafts and the mailbox's own mail
are never delivered.

One `OutlookHookDriver` Durable Object per connection and mailbox:

- keeps one Graph subscription (`created`) per watched folder, posting to
  `{BASE_URL}/outlook/notifications/<driver>`, each with a three-day expiry renewed halfway, and
  lifecycle notifications to the same URL;
- on a notification, and hourly regardless (every two minutes when `BASE_URL` isn't public https, so
  no subscription can be made), reads each folder from its cursor (`receivedDateTime ge cursor`,
  ascending, with a two-minute overlap), so a lost notification is caught up and a forged one costs
  at most a read;
- checks each notification's `clientState` against its secret before acting;
- queues each message for each hook on that folder in the kit's `HookDeliveryQueue`, keyed by
  message ID.

Each delivery goes through the binding's own `[restore]` stub, which re-reads the message and checks
it with the binding's guard, so the driver's own filtering is only a prefilter. The notification
endpoint echoes a validation token only to a POST naming a well-formed driver (with `nosniff`), and
passes on at most two client states per post.

## The configurator

`outlook-configurator.ts` with `configurator/outlook-configurator-ui.tsx`: choose the mailbox; what
to connect (the whole mailbox, a folder, people, or a conversation found by subject or pasted link);
and the permission, offering only what the deployment and grant allow. There is no preview of the mail itself: the choices say what is covered. Nothing past the first step
shows until a shared mailbox has opened, so the user's own folders never appear under someone else's
mailbox. Mailbox reads are batched in
fours, and `GraphApi.batch` resends entries Exchange throttled. `resourceUrlFor` re-resolves and
re-checks the choice on the server rather than trusting the frame.

## Tests

Node: scope guard and URL grammar, listing queries, content sanitizer, approval descriptions,
overlay, sends, the notification endpoint, and hook delivery. Workerd, against a fake Graph: the
session through the gatekeeper, actions applied and reverted, the hook driver. Contract, against a
live tenant: users mailing one another; reads, search, conversations, drafts, replies, sends,
organize and revert, observers, and a notification through a tunnel. The live tenant has no shared
mailbox, so that path is covered by the configurator's fake Graph only.

## Not built

An admin policy for sensitivity-labelled mail: a labelled message Graph can open is read like any
other, and one it can't is reported as encrypted.
