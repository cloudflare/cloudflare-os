# Google Chat capabilities

The capability API is implemented in `packages/gatekeeper-google/src/chat.ts`. The authoritative
agent-facing contract is `packages/gatekeeper-google/src/chat-types.d.ts` (also served through
the `chat-types.txt` symlink).

## Resource model

A **thread is a top-level message and its replies**, including a root with zero replies.
Threading follows Google's `spaceThreadingState`: spaces, group chats, and direct messages with
inline or grouped threading support it; explicitly unthreaded conversations (continuous meeting
chat, some pre-2022 group chats) remain flat message histories.
`ChatSpace.getMetadata().supportsThreads` reports the distinction.

Capabilities lead to narrower resources:

```text
ChatSession -> ChatSpace -> ChatThread <-> ChatMessage -> ChatAttachment
```

A thread grants access to its root, existing replies, and future replies. A message grants
access to that message, its thread (`message.getThread()`), and the ability to reply, edit its
text if it is the connected user's own, and manage the connected user's reactions. Neither can
return a containing space capability. Resource IDs in metadata do not grant access.
Messages produced by a thread retain its immutable thread restriction through root lookup,
history, posts, replies, reactions, attachments, and `getThread()`; fresh reads recheck
membership in that thread. A write is scoped when it is queued; approval applies what was queued.

Known resources use `getSpace(idOrUrl)`, `getThread(id)`, and `getMessage(id)`: each returns the
same `{ info, <capability> }` entry the listings use, or throws if the resource is unavailable,
so a lookup never has to be followed by a second read. `getSpace` accepts `spaces/ID`, a bare ID,
or a chat.google.com room/DM link, including a message's Copy link. `list…` enumerates resources;
`find…` performs an optional lookup and returns null when absent. Writes (`post`, `reply`)
return entries too, describing the queued message under its temporary ID. IDs are opaque strings
(normally Google's canonical paths), while `name` is the human-readable label. Data uses
`spaceId`, `threadId`, `createdAt`, `editedAt`, and `isReply` consistently. Chat assigns a
`threadId` to every message, but it only means something where `supportsThreads` is true;
ignore it elsewhere (thread operations there fail with a clear error). Deleted messages are never
returned: listings omit them and lookups throw.

Google's ACL boundary remains the space. Narrower capabilities restrict delegated authority;
they do not establish separate Google ACLs or make an account-derived capability into an
independently shareable Workshop connection. Account bindings remain private. Single-space and
single-thread bindings are shareable with collaborators whose own account can open the space; a
single-space binding also lists members, so the collaborator must be able to list them too, since a
space can restrict its member list to managers.
A thread binding (`https://chat.google.com/room/{space}/{thread}`) starts its session as a
`ChatThread`; its configurator accepts a pasted Copy link to the thread or any message in it.

## Names and identities

Message senders, thread previews, members, and reactions use the display names already included
in Google's Chat responses:

```ts
{ id: "users/123", name: "Alice Smith", type: "human" }
```

Prefer `name` for human-facing output and keep `id` for joins, mentions, and API calls. Names are
optional: fall back to the ID when Google omits one. The connected account's identity comes from
the existing sign-in profile lookup. Methods that accept an email address as input still support it.

Call **`space.getMetadata()`** to name a DM or unnamed group chat after its other participants,
and to identify a DM's other participant (`peer`). Account listings and the connection picker use
only Chat's returned metadata, with no membership lookups. Agents receive this guidance in the
API type comments. For example:

```ts
const info = entry.info.name ? entry.info : await entry.space.getMetadata();
const label = info.name ?? info.id;
```

Participants come from the conversation's own membership list (`members.list`, at most three
pages). An unnamed group chat is labelled with its first three other participants:
`Alice, Bob, Carol, and 2 more`. Chat may omit display names in user-authenticated
responses, so the nameless people among those are looked up in one People API `people:batchGet`
call; those names need no observer check, since anyone who can open the conversation is a
participant. When a DM's membership is ambiguous, it has no `peer`; when no source names anyone,
the conversation stays unnamed and the ID is the fallback. A failed lookup never fails the read.
Send approvals and connection titles name conversations the same way. Spaces and named group
chats require no lookup. Memberships are a `kind: "user" | "group"` union. Messages list the
users they @mention in `mentions`.

The connection picker lists only named conversations, matched by name, and scans at most five
pages. DMs and unnamed group chats are left out, since naming each would cost a `members.list`
read against the OAuth project's shared quota; enter a person's email to find the DM with them
(`spaces.findDirectMessage`), or paste `spaces/ID`, a Chat room/DM URL, or a Chat-in-Gmail
`#chat/` URL to access an exact conversation. Google reports a never-set last activity as the
epoch, which is treated as absent.

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

`space.listThreads()`, `space.getThread()`, `message.getThread()`, and `message.reply()` all
throw in a conversation whose `supportsThreads` is false; use `listMessages()` there. Known
threads can be retrieved with `space.getThread(id)` or `message.getThread()`, which return a
`ChatThreadEntry`. The thread exposes:

```ts
interface ChatThread extends RpcTarget {
  getMetadata(): Promise<ChatThreadInfo>;
  getCurrentUser(): Promise<ChatUser>;
  getRootMessage(): Promise<ChatMessageEntry | null>;
  listMessages(options?: ChatListMessagesOptions): Promise<Cursor<ChatMessageEntry>>;
  post(text: string): Promise<ChatMessageEntry>;
}
```

`getRootMessage()` returns null if the root is unavailable; it never substitutes the oldest
surviving reply. Replies fail rather than silently becoming new top-level messages.
Thread getters use a bounded page scan and throw if it is exhausted before finding visible
messages; a `listMessages()` cursor can continue through longer stretches of omitted messages.

`getMetadata()` returns the current thread ID, space ID, latest visible message, and root.
Both this snapshot and discovery's `info` always include `rootMessage` unless the root was
deleted or is hidden: when it is not in the page already read, one extra oldest-first lookup
per thread fetches it, unbounded by the discovery window.

## History and search

`space.listMessages({ since, before })` is the flattened history across threads, newest first by
default. Use it for a digester that only needs recent messages. The same options work on a
thread, where history is oldest first by default. `order` overrides either.

Time windows are half-open `[since, before)` at JavaScript `Date`'s millisecond precision.
The REST adapter widens Google's strictly exclusive lower bound, then filters decoded results
to enforce the inclusive public boundary. For polling, overlap windows and deduplicate by
message identity: creation-time history is not an exactly-once change feed.

Account discovery offers `listSpaces`, `searchSpaces`, `findDirectMessage`, `getSpace`, and
`getCurrentUser`. Account-wide `searchMessages` retains its structured filters, including
`unreadOnly` and `mentionsMe`, with the same `since`/`before` names. Search `text` is split into
words and "quoted phrases", each of which must match. Google's search index can lag and omits some
message categories; use history for complete recent-message scans. A `ChatSpace` offers
`getCurrentUser` and a `searchMessages` limited to that
conversation: Google's search only accepts `spaces/-`, so the gatekeeper adds the `space.name`
filter itself and rejects any result outside the space. It has no `unreadOnly`, because read
state is the owner's and a space binding can be shared; the gatekeeper passes on only the
declared filters, so the field is dropped even if an agent sends it. Thread capabilities have no search.

## Writing and newly created threads

Writes use `space.post(text)`, `thread.post(text)`, `message.reply(text)`, and
`message.edit(text)`. Memberships, users, and reactions are plain records. A message's
metadata already lists its attachments; `message.getAttachment(id)` returns the capability that
reads one. Event history, explicit message deletion, outgoing uploads, and generic
drafts/patches are absent. Undo-send remains supported internally.

`space.post(text)` posts a top-level message, which in a threaded conversation starts a new
thread; `message.getThread()` continues it. The new thread is ready for further posts and edits
immediately:

```ts
using root = (await space.post("Deployment investigation")).message;
using thread = (await root.getThread()).thread;
using status = (await thread.post("Gathering the relevant logs.")).message;
await status.edit("Resolved: the deployment is healthy.");
```

Each post and edit has its own approval action. Simulated reads reflect pending edits without
altering the text of the original post action. Reply actions require their root post first,
and edit actions require their target post first and apply in submission order, since manual
approval can otherwise run them out of order and an older edit would overwrite a newer one.
Rejection rewinds the corresponding overlay; an edit targeting a rejected post cannot be
applied. An edit refuses to overwrite text changed in Google Chat since it was queued, and later
queued edits follow the form Chat stored earlier ones in, such as a mention rendered as `@Name`.
Undoing an applied edit restores the previous provider text.

Sends are idempotent through Google's `requestId`, so a transient failure is retried and a
retried apply returns the message the first attempt created rather than posting again. Google
may then echo only the request, so every send re-reads the created message for its stored text
and thread. A retried edit rewrites its
text rather than checking for conflicts, since it cannot tell Chat's rendering of its own lost
write from an outside edit. Reactions re-find their own state on retry, and a retried one keeps
its undo, since the state it finds may be its own lost write. Undoing an edit is likewise safe to
retry. An action whose write may have landed cannot be rejected, except once its target message
is deleted, which leaves nothing it could have changed. A reply Google posts outside its thread,
from any binding, is deleted again, so that action stays rejectable; if removing it fails, the
error says so, and once it is deleted by hand, the next apply reports the deletion and the action
can be rejected. Replies to rejected roots disappear from the simulation. Undoing any change
whose message was since deleted counts as done, since nothing is left to restore. Authentication
and permission errors during undo remain retryable rather than being counted as successful
deletion.

The same capabilities keep working once writes are committed. Temporary IDs can also be used
with the getters after a worker restart. Reactions to new messages require the post to complete;
until then `listReactions()` returns none.

## New-message hooks

`space.subscribeNewMessages(hook)` and `thread.subscribeNewMessages(hook)` ask to have a gadget's
`ChatMessageHook` called with each new message anyone else posts, in the whole conversation or in
that thread. The hook takes effect once the user enables it in the Workshop, and `hook` must be a
persistent stub from the gadget's `ctx.restore()`:

```ts
// In the gadget's DurableObject; RpcTarget and restore come from cloudflare:workers.
async [restore](params) {
  if (params.type === "chat-hook") return new StatusHook();
}

await space.subscribeNewMessages(await this.ctx.restore({ type: "chat-hook" }));

class StatusHook extends RpcTarget {
  async receiveMessage({ info, message }) {
    if (info.text?.includes("status?")) await message.reply("All systems normal.");
  }
}
```

Each delivery is recorded as an observation on the hook's approval queue. `message` is the ordinary
message capability, and `conversation` the `ChatSpace` or `ChatThread` the hook subscribed through,
which can read around the message or post where a conversation has no threads and `reply()` throws.
A write through either queues an approval action as any other write does, and both are released
when `receiveMessage()` returns. Messages the connected account posts are never delivered, which
keeps a hook from answering itself, but hooks of two connected accounts can still answer each other;
approval is the only guard there.

Delivery is at least once and unordered: Pub/Sub pushes are collapsed for 24 hours, but a failure
after the hook ran redelivers the message. A firing that fails, whether the hook throws or the
Workshop refuses to start it, is retried with backoff from one minute up to an hour, eight attempts
in all, before the message is dropped; disabling or deleting the hook ends its retries.
Actions a hook queued stay approvable after it is disabled.

Underneath, each Google account has one Workspace Events subscription per conversation, shared by
all of its hooks there, created with the account's own token when the first hook is enabled and
renewed every three hours while any hook uses it, a failed renewal being retried every 15 minutes
so one failure doesn't let it lapse; unused subscriptions lapse within four hours.
If Google attributes a new subscription to a different account than the one the connection pinned,
as after reconnecting another account, enabling deletes it and fails, so events are never attributed
across accounts. Deployments that have not configured Pub/Sub (see the gatekeeper README) refuse to
subscribe, and everything else works as before.

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
old roots with new replies and root lookups outside the window, private and deleted message
exclusion, parent/sibling authority boundaries, capability lifetime after discovery disposal,
authorized metadata, threaded DMs and group chats, thread creation from a posted message,
single-thread bindings, pending posts/replies/edits, edit ownership, rejection, undo (including
already-deleted sends), the apply/reject race, and retrieving temporary IDs after restart.
Attenuation regressions cover every message creation path and its thread, attachment, and
reaction descendants. Pure tests cover provider thread support, search keywords and mentions,
conversation references, time bounds, scope filtering, and overlays. Durable `spawnCallable`
handoff uses the existing gadget restoration mechanism; it is not exercised end-to-end by the
Chat gatekeeper suite. Hook tests drive signed Pub/Sub pushes through the worker: push
authentication, per-account and per-thread delivery, self-authored and duplicate messages,
delivery and renewal retries, disable, the authority check, and a hook's reply applying as an
action. An identity regression checks that Chat-provided names reach message,
thread, member, and reaction results without extra identity lookups. DM tests cover on-demand
peer resolution, lookup-free listings and picker searches, peer selection, pagination, and
observer admission by space access.
