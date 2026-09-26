# Google Chat capabilities

The capability API is implemented in `packages/gatekeeper-google/src/chat.ts`. The authoritative
agent-facing contract is `packages/gatekeeper-google/src/chat-types.d.ts` (also served through
the `chat-types.txt` symlink).

## Resource model

A **thread is a top-level message and its replies**, including a root with zero replies.
Threading is available where Google's API supports it: named spaces with inline or grouped
threading. DMs, group chats, and explicitly unthreaded spaces remain flat message histories.
`ChatSpace.getMetadata().supportsThreads` reports the distinction.

Capabilities lead to narrower resources:

```text
GoogleChatSession -> ChatSpace -> ChatThread -> ChatMessage -> ChatAttachment
                         \------------------> ChatMessage
```

A thread grants access to its root, existing replies, and future replies. A message grants
access to that message and the ability to reply, edit its text where permitted, and manage
the connected user's reactions. Neither can return a containing space capability; a message
cannot return its containing thread capability. Resource IDs in metadata do not grant access.
Messages produced by a thread retain its immutable thread restriction through root lookup,
history, posts, replies, reactions, and attachments; fresh reads recheck membership in that
thread. A write is scoped when it is queued; approval applies what was queued.

Known resources use `getSpace(id)`, `getThread(id)`, and `getMessage(id)`: each returns the
same `{ info, <capability> }` entry the listings use, or throws if the resource is unavailable,
so a lookup never has to be followed by a second read. `list…` enumerates resources; `find…`
performs an optional lookup and returns null when absent. Writes (`post`, `reply`,
`startThread`) return entries too, describing the queued message or thread under its temporary
ID. IDs are opaque strings (normally Google's canonical paths), while `name` is the
human-readable label. Data uses `spaceId`, `threadId`, `createdAt`, `editedAt`, and `isReply`
consistently. Chat assigns a `threadId` to every message, but it only means something where
`supportsThreads` is true; ignore it elsewhere (replies there fail with a clear error).

Google's ACL boundary remains the space. Narrower capabilities restrict delegated authority;
they do not establish separate Google ACLs or make an account-derived capability into an
independently shareable Workshop connection. Account bindings remain private. A single-space
binding is shareable with collaborators whose own account can open the space.

## Names and identities

Message senders, thread previews, members, and reactions use the display names already included
in Google's Chat responses:

```ts
{ id: "users/123", name: "Alice Smith", type: "human" }
```

Prefer `name` for human-facing output and keep `id` for joins, mentions, and API calls. Names are
optional: fall back to the ID when Google omits one. The connected account's identity comes from
the existing sign-in profile lookup. Methods that accept an email address as input still support it.

Call **`space.getMetadata()`** to resolve an unnamed DM's other participant on demand. Account
listings and the connection picker use only Chat's returned metadata, with no membership
lookups. Agents receive this guidance in the API type comments. For example:

```ts
const info = entry.info.type === "directMessage" && !entry.info.name
  ? await entry.space.getMetadata()
  : entry.info;
const label = info.name ?? info.id;
```

The name comes from the DM's own membership list (`members.list`), which Chat populates for
the people the account talks to; there is no second lookup. When Chat omits the name, or the
membership is ambiguous, the DM stays unnamed and the ID is the fallback. Existing space names
and group chats require no lookup. Picker searches scan at most five pages; paste `spaces/ID`
or a Chat room/DM URL to access an exact conversation beyond that scan.

## Discover and operate on threads

```ts
using space = (await env.GOOGLE_CHAT.getSpace("spaces/AAAA")).space;
using threads = await space.listThreads({
  since: new Date("2026-09-23T00:00:00Z"),
  before: new Date("2026-09-24T00:00:00Z"),
});

for (;;) {
  using page = await threads.next();
  if (page === null) break;
  for (const { info, thread } of page) {
    // info includes a preview from the selected window.
    console.log(info.id, info.latestMessage.text);
    using messages = await thread.listMessages();
    // Drain messages to read the full thread, or pass a time window for just recent messages.
  }
}
```

`space.listThreads()` returns each matching thread once, newest matching message first. It
includes both new zero-reply roots and older threads with new replies. A discovery window
selects which threads are returned; the returned capability can read the whole thread.
Edits and reactions do not count as newly posted messages.
Pending sends appear ahead of committed history in newest-first listings; their timestamps are
provisional until Google assigns the final send time.

Google exposes message listing but no thread-list endpoint. Discovery scans message pages and
deduplicates thread IDs in the cursor. Both pagination and deduplication advance only after
the observation is authorized, so a denied page can be retried. A cursor returns at most 5,000
threads, then throws with a request to use a narrower window. As elsewhere in the Google
gatekeeper, `[]` means more work remains; only `null` means exhaustion.

`space.listThreads()`, `getThread()`, and `startThread()` all throw in a conversation whose
`supportsThreads` is false; use `listMessages()` there. Known threads can be retrieved with
`space.getThread(id)`, which returns a `ChatThreadEntry`. The thread exposes:

```ts
interface ChatThread extends RpcTarget {
  getMetadata(): Promise<ChatThreadInfo>;
  getRootMessage(): Promise<ChatMessageEntry | null>;
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;
  post(text: string): Promise<ChatMessageEntry>;
}
```

`getRootMessage()` returns null if the root is unavailable; it never substitutes the oldest
surviving reply. Replies fail rather than silently becoming new top-level messages.
Thread getters use a bounded page scan and throw if it is exhausted before finding visible
messages; a `listMessages()` cursor can continue through longer stretches of omitted messages.

`getMetadata()` returns the current thread ID, space ID, and latest visible message. Both this
snapshot and discovery's `info` include `rootMessage` when the root is already in the page being
read, without additional per-thread lookups. An omitted `rootMessage` means it wasn't cheaply
available, not that it doesn't exist; use `getRootMessage()` to request it explicitly.

## History and search

`space.listMessages({ since, before })` is the flattened history across threads. Use it for a
digester that only needs recent messages. The same options work on a thread. All history is
oldest-first by default; `order: "newestFirst"` reverses it.

Time windows are half-open `[since, before)` at JavaScript `Date`'s millisecond precision.
The REST adapter widens Google's strictly exclusive lower bound, then filters decoded results
to enforce the inclusive public boundary. For polling, overlap windows and deduplicate by
message identity: creation-time history is not an exactly-once change feed.

Account discovery offers `listSpaces`, `searchSpaces`, `findDirectMessage`, `getSpace`, and
`getCurrentUser`. Account-wide `searchMessages` retains its structured filters, including
`unreadOnly`, with the same `since`/`before` names. Google's search index can lag and omits some
message categories; use history for complete recent-message scans. A `ChatSpace` — the only
binding that can be shared — offers `getCurrentUser` and a `searchMessages` limited to that
conversation: Google's search only accepts `spaces/-`, so the gatekeeper adds the `space.name`
filter itself and rejects any result outside the space. Thread capabilities have no search.

## Writing and newly created threads

Writes use `space.post(text)`, `thread.post(text)`, `message.reply(text)`, and
`message.edit(text)`. Memberships, users, and reactions are plain records. A message's
metadata already lists its attachments; `message.getAttachment(id)` returns the capability that
reads one. Event history, explicit message deletion, outgoing uploads, and generic
drafts/patches are absent. Undo-send remains supported internally.

`space.startThread(text)` posts a root and returns its thread entry directly. It fails without
posting in an unthreaded conversation. The new thread is ready for further posts and edits
immediately:

```ts
using thread = (await space.startThread("Deployment investigation")).thread;
using status = (await thread.post("Gathering the relevant logs.")).message;
await status.edit("Resolved: the deployment is healthy.");
```

Each post and edit has its own approval action. Simulated reads reflect pending edits without
altering the text of the original post action. Reply actions require their root post first,
and edit actions require their target post first and apply in submission order, since manual
approval can otherwise run them out of order and an older edit would overwrite a newer one.
Rejection rewinds the corresponding overlay; an edit targeting a rejected post cannot be
applied. Undoing an applied edit restores the previous provider text.

Sends are idempotent through Google's `requestId`, so a retried apply returns the message the
first attempt created rather than posting again; a retry also recovers thread metadata from the
committed message when Google echoes only the request. Reactions re-find their own state on
retry. Replies to rejected roots disappear from the simulation. Authentication and permission
errors during unsend remain retryable rather than being counted as successful deletion.

The same capabilities keep working once writes are committed. Temporary IDs can also be used
with the getters after a worker restart. Reactions to new messages require the post to complete.

## Passing resources to callable agents

These interfaces extend `RpcTarget`, so capabilities can be passed as RPC arguments with the
usual stub lifetime rules. Dispose cursors, result pages, and stubs when finished; duplicate
a capability if it must outlive the result page containing it.

Live RPC transfer and durable agent-call arguments are distinct. `spawnCallable` stores its
arguments and requires persistent stubs. Use the existing gadget restoration mechanism to
reacquire a fixed resource from a fresh binding session:

```ts
// Inside the gadget's DurableObject; restore is imported from cloudflare:workers.
async [restore]({ spaceId, threadId }) {
  using space = (await this.env.GOOGLE_CHAT.getSpace(spaceId)).space;
  return (await space.getThread(threadId)).thread;
}

using source = await this.ctx.restore({ spaceId, threadId });
await agent.summarize(source, sink); // sink must also be persistent
```

Only the chosen thread is passed to the agent; the account capability stays in the gadget.
The receiver cannot change the captured selectors. Raw live thread/cursor stubs do not become
persistent merely by storing them.

## Verification

Workerd behavior tests cover discovery across pages, authorization retries, zero-reply roots,
old roots with new replies, private-message exclusion, parent/sibling authority boundaries,
capability lifetime after discovery disposal, authorized metadata and cheap root enrichment,
thread creation, pending posts/replies/edits, rejection, undo, the apply/reject race, and
retrieving temporary IDs after restart. Attenuation regressions cover every message creation path
and its attachment/reaction descendants. Pure tests cover provider thread support, time
bounds, scope filtering, and overlays. Durable `spawnCallable` handoff uses the existing gadget
restoration mechanism; it is not exercised end-to-end by the Chat gatekeeper suite.
An identity regression checks that Chat-provided names reach message, thread, member, and reaction
results without extra identity lookups. DM tests cover on-demand resolution, lookup-free listings
and picker searches, peer selection, pagination, and observer admission by space access.
