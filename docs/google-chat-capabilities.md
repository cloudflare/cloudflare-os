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

Known resources use `getSpace(id)`, `getThread(id)`, and `getMessage(id)`: each returns a
capability or throws if the resource is unavailable. `list…` enumerates resources; `find…`
performs an optional lookup and returns null when absent. IDs are opaque strings (normally
Google's canonical paths), while `name` is the human-readable label. Data uses `spaceId`,
`threadId`, `createdAt`, `editedAt`, and `isReply` consistently.

Google's ACL boundary remains the space. Narrower capabilities restrict delegated authority;
they do not establish separate Google ACLs or make an account-derived capability into an
independently shareable Workshop connection. Account-private and single-space observer checks
still apply.

## Discover and operate on threads

```ts
using space = await env.GOOGLE_CHAT.getSpace("spaces/AAAA");
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

Known threads can be retrieved with `space.getThread(id)`. The thread itself has just:

```ts
interface ChatThread extends RpcTarget {
  getRootMessage(): Promise<ChatMessage | null>;
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;
  post(text: string): Promise<ChatMessage>;
}
```

`getRootMessage()` returns null if the root is unavailable; it never substitutes the oldest
surviving reply. Replies fail rather than silently becoming new top-level messages.

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
message categories; use history for complete recent-message scans.

## Writing and newly created threads

Writes use `space.post(text)`, `thread.post(text)`, `message.reply(text)`, and
`message.edit(text)`. Memberships, users, and reactions are plain records. Attachments
can be listed with `message.listAttachments()` and read through their content capabilities.
Event history, explicit message deletion, outgoing uploads, and generic drafts/patches are
absent. Undo-send remains supported internally.

`space.startThread(text)` posts a root and returns a thread directly. It fails without posting
in an unthreaded conversation. The new thread is ready for further posts and edits immediately:

```ts
using thread = await space.startThread("Deployment investigation");
using status = await thread.post("Gathering the relevant logs.");
await status.edit("Resolved: the deployment is healthy.");
```

Each post and edit has its own approval action. Simulated reads reflect pending edits without
altering the text of the original post action. Reply actions require their root post first,
and edit actions require their target post first. Rejection rewinds the corresponding overlay;
an edit targeting a rejected post cannot be applied. Undoing an applied edit restores the
previous provider text.

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
  using space = await this.env.GOOGLE_CHAT.getSpace(spaceId);
  return await space.getThread(threadId);
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
capability lifetime after discovery disposal, thread creation, pending posts/replies/edits,
rejection, undo, and retrieving temporary IDs after restart. Pure tests cover provider thread
support, time bounds, scope filtering, and overlays. Durable `spawnCallable` handoff uses the existing gadget
restoration mechanism; it is not exercised end-to-end by the Chat gatekeeper suite.
