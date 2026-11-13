# Gadget error log

A gadget's uncaught exceptions are shown live to whoever has the Workshop open
(`Overseer.subscribeToConsoleLogs()`), and live delivery keeps nothing. The gadget error log keeps
those exceptions, and only them, so that an error that happened while nobody watched can be read
afterwards. Each workspace has one: a Durable Object of its own that holds the entries for a
bounded time and within byte bounds (see [Bounds](#bounds)), read by the workspace's build members
with `Overseer.readGadgetErrors()`. The API is documented in `packages/workshop-shared/src/api.ts`;
the pieces are:

| Concern | Location |
| --- | --- |
| The entry, report, query and page types, the caps, `Overseer.readGadgetErrors()`, `Overseer.reportGadgetErrors()` | `packages/workshop-shared/src/api.ts` |
| Shaping, redaction, the entry makers and the limiter | `packages/workshop-backend/src/gadget-error-log.ts` |
| The log object (`WorkspaceErrorLogDurableObject`): schema, retention, byte bounds, listing | `packages/workshop-backend/src/workspace-error-log.ts` |
| The Overseer's writes, its read and its deletion, and the tail of a gadget's Worker (`GadgetTailLoopback`) | `packages/workshop-backend/src/overseer.ts` |
| The log object's name (`errorLogId`) | `packages/workshop-backend/src/storage-schema/overseer-storage.ts` |
| The Workshop's reporter | `packages/workshop-frontend/src/features/gadget-errors/` |

## What is kept, and what is not

One rule explains every case of this section: the error of a failed call is kept wherever the
Workshop's own code makes or forwards the call, and where the runtime takes a call to the gadget
with no Workshop code in between, nothing sees the error but the caller.

There are three kinds of entry:

1. **`"server"`, an exception the runtime reports** for the gadget's Worker outside the result of
   any call: a rejected `ctx.waitUntil()` promise, a throw in a timer callback. The Worker's tail
   hands these to the Overseer apart from what it delivers live, and the entry holds the
   exception's name, message and stack, where the live console shows the message alone.
2. **`"server"`, the error of a call to the gadget that failed**, with the method that was called
   on a line of its own (`at method()`), when the call passed the Workshop: on a stub from
   `connectToGadget()`, through a binding to the gadget (another gadget's or an agent's), by the
   gadget's `ExportHandler` on the gadget it is handed, or by a hook's firing on the callback
   stored with the hook, a scheduled task's included. The Workshop's own two calls to a gadget's
   `ExportHandler` are kept the same way, written `at ExportHandler.getExportFormats()` and
   `at ExportHandler.export()`; a gadget whose Worker starts and that has no `ExportHandler` keeps
   nothing for them. All of these are calls on the gadget itself, on the stub the Workshop handed
   out, and not calls on an object such a call returned (see [What is not kept](#what-is-not-kept)).
   When what a call threw is neither an `Error` nor a string, the entry holds its kind and not its
   content: a gadget that throws a plain object is kept as `[object Object]`.
3. **`"client"`**: what a gadget frame's `error` and `unhandledrejection` listeners catch. The
   frame marks the message it posts for one with `uncaught: true`, and the Workshop reports the
   marked messages, and no other, with `Overseer.reportGadgetErrors()`.

A firing's error is kept for the gadget the hook is listed under (`listHooks()`,
`BoundHookInfo.gadgetId`) and the chat whose version of that gadget was running, whether the
callback is that gadget's or an agent's. The Workshop cannot read what a stored callback restores
to, and an agent can store its own (`self`, a `spawnCallable()` stub) with a hook. When a firing's
call on one fails (its chat was deleted), the error is kept for the hook's gadget although none of
that gadget's code ran, and for a hook an agent bound that gadget is a guess: the one gadget the
agent forged a stub for, else the workspace's first.

### A server entry is not always the gadget's fault

The error of a failed call is kept whoever raised it, and nothing filters it, so it can be the
Workshop's own. Among them:

- A call to a method the gadget does not have, and a call in flight when the gadget was restarted
  to run other code, whose error starts "Gadget restarted" ("Gadget restarted to test proposed
  changes.", "Gadget restarted to switch back to main version.", "Gadget restarted because the
  proposed changes changed.", "Gadget restarted due to code update."). Each is kept once.
- A call in flight when the gadget is deleted, a later call on a stub whose gadget is gone ("No
  such gadget: N"), and a call under a chat that was deleted while its version of the gadget was
  loading.
- For an `ExportHandler`: the Workshop's refusal of formats the handler returned (an id that is not
  unique, say), its timeout of either call, and a Worker that did not start. A gadget whose
  `server.js` fails to load fails the Workshop's `getExportFormats()` call whether or not it has an
  `ExportHandler`, so it keeps one entry ending `at ExportHandler.getExportFormats()` for each read
  of its export formats (each opening of its export menu, each export), with no method of it
  called. The Workshop treats a runtime "internal error" on that call as a missing handler
  (`readCustomExportFormats()`), so where the runtime reports a failed start that way the read
  answers the default formats and keeps nothing.
- The failure of an agent's callback at a hook's firing, as described above.

### What is not kept

- A console call at any level, `console.error` included, from the server or the UI. Live delivery
  carries everything.
- A promise rejection that nothing in the gadget's server handles. The runtime reports it neither
  to the tail nor to a caller, so it is shown nowhere live either.
- A call on an object that a gadget method returned (a session, a handle, a subscription), and
  likewise a stream a method returned that fails later. The Workshop catches the calls made on the
  gadget's stub and hands their results back as they are, so the holder's calls on a returned
  object reach the gadget through the runtime alone, and the runtime reports a method's throw to no
  tail.
- A call on an object that the gadget passed as an argument of a call it made (a subscriber or a
  callback handed to a binding's session or to another gadget, and not stored with
  `ctx.restore()`), which reaches the gadget the same way.
- A call made on a stored callback (a stub from the gadget's `ctx.restore()`) by anything but a
  hook's firing, such as an agent that was handed the stub, whose error goes to that caller alone.
  In this case and the two before it the caller still gets the error, and the live console is not
  told either.
- A call on a capability that a hook's callback returned.
- A firing the Workshop refused (a hook deleted or disabled), since no call was made.
- A stream that an `ExportHandler`'s `export()` returned and that fails afterwards: the call
  succeeded, and the read fails for whoever reads the export.
- The errors of a gadget's UI while the Workshop renders it in its own browser for an export, which
  no session's frame runs and nothing reports. The calls that page makes on the gadget are kept
  like any other.
- The Workshop's refusal of an export before it calls the handler (a format the gadget does not
  have).
- A throw of a hook entrypoint connected by the obsolete `setBindingHook` tool, which the runtime
  calls directly.

### Kept twice

Nothing deduplicates, so three failures are kept twice:

- A failure that a gadget's `ExportHandler` lets escape from a call it made on the gadget is kept
  as that call's (`at fail()`) and as the handler's (`at ExportHandler.export()`).
- A throw of the gadget's constructor fails the call and is reported by the runtime for the request
  as well, so a call that starts such a gadget keeps two `"server"` entries: the failed call, with
  the method, and the runtime's report, with the stack. A later call on the same stub fails the
  same way with no constructor run, and keeps one. The two count against different limits (see
  [Limits](#limits)).
- A call the gadget's UI makes to its server that fails, and whose rejection the UI leaves
  unhandled, is kept once as a `"server"` entry (the failed call) and once as a `"client"` entry
  (the frame's unhandled rejection).

A method's own throw is kept once, and so is a `server.js` that fails to load: once for each call
of a method, and once more for each read of the gadget's export formats, which is a call of the
Workshop's and not a second copy of anything.

### What an entry holds

An entry is a `GadgetErrorEntry`:

| Field | Meaning |
| --- | --- |
| `time` | By the Workshop's clock: when the exception happened for a `"server"` entry, when the report arrived for a `"client"` one. |
| `gadgetId` | The gadget the error is kept for. |
| `chatId` | The chat whose draft of the gadget the code ran as, or null for the gadget's mainline. A chat that proposes no change to the gadget runs its mainline, so its errors are kept with null. |
| `source` | `"server"` or `"client"`: where the error was caught, not who chose its text. |
| `userId` | On a `"client"` entry only: the user whose session reported it. |
| `text` | What was thrown, redacted and then cut (see [Shaping and redaction](#shaping-and-redaction)). |

A marker standing for errors that were dropped (see [Limits](#limits)) is an entry too. Nothing but
its text tells it from an error, and a gadget or a browser can write that text.

## Shaping and redaction

`gadgetErrorText()` makes every entry's `text`. It reads at most
`MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH` (4,000) characters, redacts them, and cuts the result to
`MAX_GADGET_ERROR_TEXT_LENGTH` (2,000) characters, the last of them "…" when anything was cut.
Redaction runs on write and before the cut, so a token that straddles the cut is replaced whole,
and the log object stores only redacted text.

`redactGadgetErrorText()` replaces with "[redacted]" the shapes it knows: bearer and basic
credentials, `sk-` keys, JSON Web Tokens, PEM private keys, the password in a URL, and the values
of URL parameters and JSON members named like a secret.

Redaction is a backstop. It catches a credential in a shape it knows and misses others, and it is
not what makes keeping the text acceptable. The entries are workspace content, read only by those
who can already read the gadget's code and chats.

## Limits

At most `GADGET_ERRORS_PER_MINUTE` (30) errors a minute are kept for one gadget, three times over
and counted apart (`GadgetErrorLimiter`): the exceptions the runtime reports for the gadget's
Worker, the calls to the gadget that failed (a hook firing's and an `ExportHandler`'s among them),
and what sessions report.

The two `"server"` kinds are apart because the text of a failed call is its caller's choice and any
session that may call the gadget can make calls fail, a `use` session included: counted together, a
caller could use up the minute of the gadget's own exceptions. The split sets nothing apart in
storage, where both kinds share the `"server"` part of each bound (see [Bounds](#bounds)). It
limits how fast entries arrive, not which entries stay.

A report call records at most `MAX_GADGET_ERRORS_PER_CALL` (10) errors, the first of them.

The limit counts errors as they arrive, not as they happened. The tail hands over a request's
exceptions together when the request ends, so a long-lived request that had more than
`GADGET_ERRORS_PER_MINUTE` keeps that many and a marker, however far apart they were.

The first error of a kind dropped in a minute brings a marker: an entry of the same source whose
text is "1 error dropped" or "N errors dropped". Each kind has its own, and a marker of either
`"server"` kind reads the same. A gadget is marked at most once a minute for a kind, and the drops
after a marker wait for the next one, which is written only if an error of that kind arrives in a
later minute while the Overseer still holds the count in memory. So a marker says that errors were
dropped, and its count can be far fewer than were.

The Workshop's reporter (`useGadgetErrorReporter()`) is on for every mounted gadget view, whatever
chat or tab is selected. It queues at most `MAX_GADGET_ERRORS_PER_CALL` errors, the first of a
burst, and sends them `GADGET_ERROR_FLUSH_MS` (5 seconds) after the first is queued, one send at a
time. A refused send doubles the wait, up to `GADGET_ERROR_MAX_BACKOFF_MS` (5 minutes), unless a
reconnect cures the failure (a lost connection, a Durable Object reset), which leaves the wait as
it is; an accepted send brings it back to `GADGET_ERROR_FLUSH_MS`. A send that has not settled
after `GADGET_ERROR_SEND_TIMEOUT_MS` (30 seconds) is given up. The queue is sent at once when the
page is hidden and when the view goes away. What the reporter drops, or fails to send, is lost
silently: it writes no marker.

## Bounds

| Bound | Value | Constant (`workspace-error-log.ts`) |
| --- | --- | --- |
| Retention | 72 hours, counted from when the entry was kept, not from its own `time` | `GADGET_ERROR_RETENTION_HOURS` |
| A workspace's entries | 5 MB | `GADGET_ERROR_BYTES_PER_WORKSPACE` |
| Its `"client"` entries, of that | 1 MB, a fifth | `GADGET_ERROR_CLIENT_BYTES_PER_WORKSPACE` |
| A gadget's entries | 1 MB | `GADGET_ERROR_BYTES_PER_GADGET` |
| Its `"client"` entries, of that | 200 KB, a fifth | `GADGET_ERROR_CLIENT_BYTES_PER_GADGET` |

`"server"` entries have the rest of each bound, and neither source can push out the other's
entries. The oldest go first: a gadget's own oldest for its bound, and for the workspace's bound
the oldest of the gadget holding the most, so a gadget that throws little does not lose its
entries to those that throw a lot. The bounds and the retention are enforced on write
(`append()`). The alarm enforces the retention as well, so a log nothing is appended to still
empties, and a read never lists an expired entry.

Within the `"server"` part nothing is set apart: the exceptions the runtime reported and the calls
that failed share it, so failed calls push out the gadget's own exceptions once the part is full.
An entry with a full text counts about 4 KB and the limit is `GADGET_ERRORS_PER_MINUTE` failed
calls a minute, so failed calls add about 125 KB a minute and turn over a gadget's whole 800 KB of
`"server"` entries in about seven minutes. Anyone who may call the gadget can do it, a `use`
collaborator included, and the entry names no user. That is accepted: the log is a bounded recent
history, not an audit record, and an error loop of the gadget itself turns it over the same way.
The test "sets nothing apart within a gadget's server part: failed calls push out its own
exceptions" in `workspace-error-log.test.ts` pins it.

An entry counts as an estimate of what it takes in storage (`entryBytes()`): its share of a 4 KB
page (`PAGE_BYTES`) filled with rows like it, plus its index entries, so an entry of
`MAX_GADGET_ERROR_TEXT_LENGTH` characters counts about 4 KB. The bounds are on that count, not on
the database, which can take more.

## Who reads

Build members, the owner and `build` collaborators, read the log through
`Overseer.readGadgetErrors()`: a page of `GADGET_ERROR_PAGE_SIZE` (100) entries, newest first,
filtered by gadget, chat and source, with a cursor for the next-older page. So the log is also read
with `pnpm cf-os api open-workspace <id> read-gadget-errors`. On a local instance any user may run
that command for a workspace they are a build member of. On a deployed instance a `cf-os api`
session acts only as a deployment admin (see
[Deployment admins only](../packages/api-cli/README.md#deployment-admins-only)), and being a
deployment admin grants nothing here: the admin must also be a build member of the workspace, and
there is no admin read of the log.

A `use` collaborator reports, since their frames throw too, and reads nothing:
`readGadgetErrors()` is refused.

There is no other reader. Entries are workspace content, kept in the workspace's own log object,
and nothing of an entry reaches the deployment's error reporting (`packages/error-reporting`), the
server logger or analytics.

## Client entries are unverified

Of a `"client"` entry a browser chooses the text and nothing else. The server stamps the gadget
and the chat it checked, the session's user, the source and the time, and ignores whatever else a
browser sends. The time is when the report arrived, so some seconds after the error: the
Workshop's reporter sends after `GADGET_ERROR_FLUSH_MS`, and later after a refused send.

The text is unverified, and a gadget's own code runs in that frame and can post a marked message
itself. That is why reports have their own fifth of each bound and their own limit.

## Deletion

Deleting a gadget keeps its entries until they expire, listed by its id.

Deleting the workspace destroys the log object before the workspace's own storage, after waiting
for the appends in flight, and the workspace's alarm tries again if that fails.

Three safeguards cover a workspace id that is initialised again:

- The log object's name is random and stored with the workspace (`errorLogId`). The id's next life
  starts with no log, and a write that lands late lands where nobody reads, to expire on its own.
- A gadget Worker's trace carries the name of the log object the Worker was loaded for, and is kept
  only there. The name is also part of the key a Worker is cached under, so the id's next life
  loads Workers of its own, though it repeats the earlier one's code versions and gadget ids.
- The instance that deleted a workspace initialises nothing.

## Tests

| Suite | Pins |
| --- | --- |
| `packages/workshop-backend/__tests__/gadget-error-log.test.ts` | Redaction (adversarial texts included), the cut and the read bound, the entry makers, the marker's wording, the limiter |
| `packages/workshop-backend/__tests__/workspace-error-log.test.ts` | The log object: append, listing and its cursor, the retention on write and by the alarm, both bounds and both shares, the byte count, `destroy()` and a write after it |
| `packages/workshop-backend/__tests__/gadget-error-history.test.ts` | The Overseer: the tail's exceptions, failed calls, the Workshop's own failures, what is kept twice and what is not kept, a hook's firing, a gadget's `ExportHandler`, `readGadgetErrors()` by role, reports, deletion and its safeguards |
| `packages/workshop-backend/__tests__/overseer-hooks.test.ts` | A firing's callback: a failed call is handed to the error log, with its method or with none, and a call that succeeds or a refused firing is not |
| `packages/workshop-backend/__tests__/use-gadget-access.test.ts` | A `use` session's `reportGadgetErrors()`: a held gadget, no chat, the cap and the limit, nobody verified |
| `packages/workshop-frontend/src/features/gadget-errors/gadgetErrorReporter.test.ts` | The reporter: bounded, one send at a time, its wait after a refusal, flush and stop; the text of a posted message |
| `packages/workshop-frontend/src/GadgetUI.integration.test.tsx` | No console call is reported, at any level; an uncaught error and an unhandled rejection are; the reporter is on whatever is selected or visible, and holds its queue while the connection is lost |
| `packages/workshop-frontend/src/GadgetUI.gadgetErrors.browser.test.tsx` | The same against a real gadget frame |
| `packages/workshop-frontend/src/GadgetUseView.test.tsx`, `GadgetEditor.blueprintUpdate.test.tsx`, `GadgetEditor.workspaceMove.test.tsx` | Each mount site gives the view its workspace and gadget, and a queued error goes to the workspace it was caught in |
| `packages/integration-tests/__tests__/workshop-gadget-error-log.test.ts` | End to end against real Workers: each kind of entry is listed and no console call is, the limits, a bound, a `use` session, a hook's firing, an `ExportHandler`, deletion |
| `packages/integration-tests/__tests__/workshop-use-role.test.ts` | A `use` session's surface: `reportGadgetErrors()` allowed, `readGadgetErrors()` refused |
