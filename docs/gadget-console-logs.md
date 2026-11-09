# Gadget console logs

A workspace keeps what its gadgets print to their consoles: the console calls and uncaught
exceptions of each gadget's server code, and the console output that every open gadget view
reports from its browser. The entries are kept for 72 hours, within byte bounds, in a Durable
Object of the workspace's own. `build` sessions read them with `Overseer.listConsoleLogs()`, and a
deployment admin reads them as a recorded content read. Live delivery through
`Overseer.subscribeToConsoleLogs()` delivers only what is logged while subscribed and keeps nothing
itself. This document is the design record. The API is documented in
`packages/workshop-shared/src/api.ts`; the pieces are:

| Concern | Location |
| --- | --- |
| The entry, report, query and page types, the caps, the marker wording, `Overseer.listConsoleLogs()`, `Overseer.reportGadgetConsoleLogs()`, `AdminWorkspaceView.listConsoleLogs()` | `packages/workshop-shared/src/api.ts` |
| Shaping, redaction, the entry makers and the limiter | `packages/workshop-backend/src/gadget-console-log.ts` |
| The log object (`WorkspaceLogDurableObject`): schema, retention, byte bounds, listing | `packages/workshop-backend/src/workspace-log.ts` |
| The Overseer's writer (`#appendConsoleLogs()`, `deliverGadgetLogs()`, `#recordGadgetException()`, `reportGadgetConsoleLogs()`), its listing, its deletion (`#deleteConsoleLogs()`), the sessions' methods and the admin read (`AdminWorkspaceViewImpl.listConsoleLogs()`) | `packages/workshop-backend/src/overseer.ts` |
| The log object's name (`consoleLogId`) | `packages/workshop-backend/src/storage-schema/overseer-storage.ts` |
| The admin read as content (`ADMIN_CONTENT_METHODS`, `gadgetConsoleLogPageHoldsContent()`) | `packages/workshop-backend/src/admin-access.ts` |
| The Workshop's reporter | `packages/workshop-frontend/src/features/gadget-console/` |

## What an entry holds

An entry is a `GadgetConsoleLogEntry`:

| Field | Meaning |
| --- | --- |
| `time` | When the call was made: by the Workshop's clock for a `"server"` entry, by the reporting browser's for a `"client"` one. |
| `gadgetId` | The gadget whose code made the call. |
| `chatId` | The chat whose draft of the gadget the code ran as, or null for the gadget's mainline (see [The chat of an entry](#the-chat-of-an-entry)). |
| `source` | `"server"` for the gadget's Worker, `"client"` for a browser showing its UI: where the entry was produced, not who chose its text. |
| `userId` | On a `"client"` entry only: the profile id (`AiChatAuthorInfo.id`) of the user whose session reported it. That user's browser ran the gadget's code; they did not necessarily write the text. |
| `level` | The console method called (`debug`, `info`, `log`, `warn` or `error`), or `error` for an exception the code did not catch. |
| `text` | The call's arguments as one string, redacted and then cut (see [Shaping](#shaping)). |

To its reader the text is untrusted on both sides. A gadget's code chooses what its server prints,
but not all of it: the error of a failed call names the method that was called, which is the
caller's choice, and a gadget's errors and console calls can repeat the arguments they were given.
A `"client"` entry is whatever a browser sent, so nothing verifies its `time`, `level` or `text`.

## The paths in

Every entry is written by the workspace's Overseer, through `#appendConsoleLogs()`. Nothing else
holds the log object's name.

### A gadget's server

- **The trace of a gadget Worker.** Every gadget Worker is loaded with `GadgetTailLoopback` as its
  tail, so its trace covers a facet's console calls and the export handler's alike.
  `GadgetTailLoopback.tail()` makes one batch of a trace's console calls and of the exceptions the
  runtime reports for it, and hands it to `OverseerImpl.deliverGadgetLogs()`, which sends the batch
  to live subscribers and then keeps it as `"server"` entries. A trace is delivered when the
  gadget's request ends, so an entry's `time` is the call's own and the entry is kept later.
  Nothing is kept of a trace that holds a log from before the workspace was initialised: it is a
  request of an earlier workspace under the same id (see [Deletion](#deletion)).
- **An exception caught on a facet call.** `getGadgetFacet()` wraps the facet so that a method that
  throws is delivered live as an `"error"` naming the method called, and
  `#recordGadgetException()` keeps the same event. Most of these exceptions never reach the tail.
  One that does, because the runtime reports it for the gadget's request as well (a constructor's
  throw), is kept by both, as live subscribers are sent both. A gadget is held to 30 of these a
  minute (see [The limit on caught exceptions](#the-limit-on-caught-exceptions)).

`deliverGadgetLogs()` takes the gadget last, after the chat and the logs, and as an optional
argument. The tail loopback and the Overseer can run different versions of the Worker while a
deployment is under way, so a call may name no gadget: its logs are then delivered live as any
other's, and are not kept.

A trace the runtime hands over with anything but one request in it is dropped by
`GadgetTailLoopback.tail()` before it is delivered or kept, with an error in the server log (event
`gadget.trace.size.unexpected`) in its place.

Keeping an entry never fails the gadget: `deliverGadgetLogs()` and `#recordGadgetException()` never
throw, so a gadget's tail and a gadget's caller see nothing of a failed append (see
[What the server logger gets](#what-the-server-logger-gets)).

### A gadget's UI

Every mounted gadget view has a reporter (see [The Workshop's reporter](#the-workshops-reporter)),
which sends what the gadget's frame logs through
`Overseer.reportGadgetConsoleLogs(gadgetId, chatId, entries)`. Build and use sessions report alike:

- A **build** session reports for any gadget of the workspace, under a chat or under none. A
  gadget or a chat that does not exist is refused.
- A **use** session reports for a gadget its access includes, with `chatId` null. The access is
  read again at each call, so a gadget granted since the session opened is accepted and one whose
  grant is gone is refused, exactly like a gadget that does not exist. Reporting verifies nobody
  as an observer, since it reads nothing.

Each reported call is kept as a `"client"` entry under the session's user. The entry is built from
the fields a report is declared with, by name, so a browser chooses neither its `source` nor its
`userId`. Everything else in it is unverified: it is what that browser sent, and proves nothing
about the gadget. Reported entries are not delivered to live subscribers.

### The chat of an entry

An entry's `chatId` is the chat whose draft of the gadget the code ran as, and null for the
gadget's mainline. A chat that proposes no change to the gadget runs its mainline, so what it
causes is kept with null:

- **A facet's trace** carries the chat its Worker was loaded for, which is already that chat.
- **A caught exception's** chat is resolved when the call fails, so a stub whose draft was merged
  since keeps its exception under no chat.
- **A report's** chat is narrowed when it arrives: a chat that proposes no change to the gadget is
  kept as null, and a chat that does not exist is refused.

The export handler is the exception, as `GadgetConsoleLogEntry.chatId` says: it runs for the chat
the export was asked under (`GadgetClient.export()`), and its calls carry that chat whether or not
it proposes a change.

Keeping changes nothing of live delivery: a subscriber is told the chat each batch is delivered
under, so a caught exception is told live under the calling chat even where it is kept under none.

## Shaping

`gadgetConsoleLogText()` makes an entry's `text` from a console call's arguments, in four steps.
It never throws, whatever it is given.

1. **The join.** Strings as they are and other values as JSON, separated by spaces. A value JSON
   has no form for is named instead: `undefined`, a symbol and a BigInt as `String()` writes them,
   an object (one that holds itself, say) by its kind, as `[object Object]`.
2. **The read bound.** At most `MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH` (4,000) characters
   are read, twice what is kept, so that redaction sees the whole of a token that straddles the
   cut. A value's JSON is written only as far as it is read, never whole. Text that reaches the
   bound may stop inside a credential, so it loses its last unbroken run of letters, digits and
   token punctuation, with what is left of a URL password before it, and is marked as cut.
3. **The redaction** (below).
4. **The cut.** To `MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH` (2,000) characters by
   `cutAdminAuditText()`, the last of them "…" when anything was cut, never splitting a surrogate
   pair.

A browser sends no more than the read bound for an entry, and the Overseer reads no more of what a
browser sent.

### Redaction

Before a text is cut, `redactGadgetConsoleLogText()` replaces these shapes in it with
"[redacted]":

- bearer and basic credentials;
- `sk-` keys;
- JSON Web Tokens;
- PEM private keys, between their BEGIN and END lines;
- the password in a URL;
- the values of URL parameters named like a secret;
- the values of JSON members named like a secret.

The secret names are `token`, `secret`, `password` or `passwd`, `signature`, `credential`, and
`key` after `api`, `private`, `secret` or `access`, with or without a `_` or `-` between
(`apikey`, `api_key`). A parameter or a member is named like a secret when its name is made of
ASCII letters, digits, `_`, `.` and `-` (a URL parameter's also of `~` and `%`) and ends in one
of the secret names, in any letter case: a member called `Client Secret` is not, because of the
space, and its value is left in the text, while `access_token`, `clientSecret` and `X-Api-Key`
are. A JSON member is too when its whole name is `authorization`, `proxy-authorization`,
`cookie` or `set-cookie`, and a URL parameter when it has one of the short names listed under
[What it replaces though it is no credential](#what-it-replaces-though-it-is-no-credential).

The redaction is a backstop against a credential printed by accident, and nothing more. It errs
towards redacting, so some ordinary text that has one of these shapes goes too, and every other
shape of secret passes. Each of the two lists below matches a table of
`packages/workshop-backend/__tests__/gadget-console-log.test.ts`, `NOT_CAUGHT` and `ACCEPTED`
(what depends on how a call's arguments are joined has a test of its own there), and a change to
the patterns updates both. The work is linear in the length of the text.

Keeping the text is acceptable because a gadget's logs are its workspace's content and are read as
such (see [Who reads](#who-reads)), not because of the redaction.

#### What it does not catch

- A secret written as `name=value` or `name: value` outside a URL's query and outside JSON:
  `api_key=...`, `token: ...`, `curl -u user:password`, an `X-Api-Key:` or `Set-Cookie:` header
  line.
- A header, or any other name and value, printed as a pair of array elements, which is what
  spreading a `Headers` object, a `Map` or `URLSearchParams` gives:
  `console.log([...request.headers])` prints `["x-api-key","..."]` with its value. The same header
  printed as a member of an object is replaced, and so is a pair whose value has a shape of its
  own, a bearer credential say.
- A bearer or basic credential shorter than 16 characters, or made only of lower-case letters, or
  whose space is encoded, as `%20` or as the `+` of a submitted form (`Bearer%20...`,
  `Bearer+...`), or that an escaped line break or tab separates from its scheme word, as when a
  gadget prints an object whose string holds the scheme word, a line break and the credential.
  The same string printed as an argument of its own is caught.
- The rest of a bearer or basic credential after a character in it that is no letter, digit, `_`,
  `.`, `~`, `+`, `/`, `=` or `-`: only the part before is replaced, and nothing where that part is
  shorter than 16 characters. So a token made of an id, a `|` or a `:`, and a secret
  (`Bearer 17|...`) is kept whole. The same credential as the value of an `authorization` member
  of JSON is replaced.
- A bearer or basic credential, an `sk-` key or a JSON Web Token that directly follows a letter
  or a digit, as after an ANSI colour code, which ends in a letter, or after a separator that was
  percent-encoded twice (`%253D`). One after a single percent-escape or a JSON escape is still
  caught.
- A token split over two console arguments or two console calls.
- A token broken across lines, of which only the part before the break is replaced, so that a
  wrapped JSON Web Token keeps the rest of its payload and its whole signature.
- A URL password that holds a raw `/`, `?`, `#` or double quote.
- The rest of a URL parameter's value after a raw double quote or angle bracket in it: only the
  part before is replaced. A URL that was encoded holds neither.
- A secret in a URL's path (a webhook address, a reset link).
- A token used as a URL's user name with no password.
- Provider-prefixed tokens on their own (`ghp_`, `AKIA`, `xoxb-` and the like).
- A secret under a name the patterns do not know (a JSON member called `key`, say), or in a JSON
  member whose value is not a string, or in JSON held in a string three times over or more.
- Text in which another format has escaped a URL: JSON from a serializer that escapes more than
  JavaScript's does, where the `&` before a parameter is written `\u0026` or each slash of a URL
  with a password `\/`, and HTML where that `&` is the numeric entity `&#38;` (the named `&amp;`
  is caught).
- A private key printed without its BEGIN line.
- A parameter named like a secret inside a percent-encoded nested URL (`%3Ftoken%3D...`).

#### What it replaces though it is no credential

- The value of any URL parameter named, or ending after a separator in, `key`, `code`, `sig`,
  `auth`, `jwt`, `pwd` or `session` (or `sessionid`), or ending in one of the secret names:
  `?error_code=404`, `&zip_code=90210`, `&sort_key=name`, `?session=abc`, any `?code=`.
- The apostrophe that closes a URL ending in such a parameter, with what is glued to it:
  `fetch('/cb?code=abc').catch(report)` loses its `').catch(report)`. An apostrophe does not end a
  value, because `encodeURIComponent()` leaves one in a value as it is.
- The full stop directly after a JSON Web Token, read as an empty segment of it.
- A word of 16 or more characters holding a capital or a digit that follows "basic" or "bearer"
  (a class name after the word Basic, say), also where the "basic" itself follows an underscore or
  an escape, or that is glued to `sk-`: a path such as `C:\tools\nsk-toolkit-V2-installer-x64`
  among them, whose backslash and "n" read as the escape of a line break.
- A URL's port, or what follows a colon after a URL, up to an `@`, when no space, `/`, `?`, `#` or
  double quote comes between.
- Any base64 of a JSON object.
- The values of JSON members whose names end like a secret's (page tokens, `accessKey`).
- Everything after a private key's BEGIN line that no END line follows.

## The limits on a report

| Limit | Constant | Value |
| --- | --- | --- |
| Characters of `text` kept | `MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH` | 2,000 |
| Characters of a call's arguments read | `MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH` | 4,000 |
| Entries one report records | `MAX_GADGET_CONSOLE_LOGS_PER_CALL` | 50: the entries after them are dropped, and the call does not throw |
| Reported entries per gadget per minute | `GADGET_CONSOLE_LOGS_PER_MINUTE` | 300 |

The per-gadget minute is one budget for every session reporting for the gadget, so a single viewer
whose copy logs heavily, a `use` collaborator included, can use it up for the others until the
minute ends. A gadget's minute starts at its first reported entry after its last minute ended.

What either limit drops is said by a **marker**: one `"client"` entry of level `warn`, worded by
`droppedGadgetConsoleLogsText()` ("37 entries dropped") and kept before the entries of the call
that brought it. A gadget gets at most one marker a minute. The marker is kept under the user and
the chat of the call that brought it, while its count covers every call's drops for the gadget
since the gadget's last marker, whoever sent them. Drops after a gadget's marker of a minute are
counted by its next one, which is kept only if the gadget is reported for again.

The counts live in the Overseer's memory (`GadgetConsoleLogLimiter`), so a restart forgets at most
one window: what it admitted, and the drops no marker has counted. The limit bounds a flood. It is
not an exact quota.

## The limit on caught exceptions

A trace's entries pass no rate limit. One gadget request's console output is one trace, which the
platform ends at 256 KB with a warning of its own (kept like any other entry), and the byte bounds
of the log object hold whatever arrives.

The exceptions caught on facet calls are limited, to 30 a minute for one gadget
(`GADGET_EXCEPTIONS_KEPT_PER_MINUTE` in `overseer.ts`). The reason is who chooses them. A failed
call's error names the method that was called, every session that may call the gadget can make a
call fail (a call for a method the gadget does not have is enough), a `use` collaborator's
included, and a `"server"` entry names no user. With no limit, such a session could fill a
gadget's `"server"` entries with lines of its own in seconds, and push out what the gadget's
server logged.

The limit works as the one on reports does, with a `GadgetConsoleLogLimiter` of its own, so
caught exceptions and reports take nothing from each other's minute. The minute is one budget for
the gadget, whoever calls it: a caller whose calls keep failing uses it up for the others until
the minute ends. What the limit drops is said by a marker: one `"server"` entry of level `warn`,
with the same wording, at most one a minute for a gadget, kept before the exception that brought
it and under that exception's chat. Live subscribers are sent every exception, kept or not.

A marker's count is not the count of a flood. Exceptions are offered to the limiter one at a time,
so the first one dropped in a minute brings the marker, which counts what was dropped since the
gadget's last marker: "1 entry dropped", unless an earlier minute left drops uncounted. The
exceptions dropped after it in that minute are counted by the gadget's next marker, which is kept
only if a call fails again in a later minute, while the Overseer still holds the count. A gadget
whose calls fail 100 times in one minute and then stop is listed with 30 errors and "1 entry
dropped", and the other 69 are never said.

The limit slows a flood, and no more than that:

- At 30 a minute, each cut to 2,000 characters, failing calls take about an hour to turn over a
  gadget's 8,000,000 bytes of `"server"` entries.
- A gadget whose own code logs what it is called with is not covered. Its console calls arrive
  by its trace, and whoever may call it can have it log as often as they call.

## The Workshop's reporter

`GadgetUI` gives every mounted gadget view a reporter (`useGadgetConsoleLogReporter()`), in the
editor and in the use-only view alike, whether or not a chat is selected. The gadget's frame posts
its console calls and uncaught errors to the Workshop; `consoleLogFromFrame()` reads each message,
and the reporter (`createGadgetConsoleLogReporter()`) batches them:

- **One batch, five seconds after the first queued call** (`GADGET_CONSOLE_LOG_FLUSH_MS`), and one
  send at a time. A send still unsettled after 30 seconds
  (`GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS`) is given up.
- **A queue of 49 calls** (`MAX_GADGET_CONSOLE_LOGS_PER_CALL - 1`) **and 100,000 characters**
  (`GADGET_CONSOLE_LOG_BATCH_CHARS`). Past either, the oldest queued calls are dropped and
  counted, because the error that ends a burst is the entry most worth keeping. The next batch
  starts with the reporter's own marker, a `warn` entry with the server's wording, which is why
  the queue holds one call fewer than a report records. A batch that was refused or given up is
  not sent again: what it stood for is added to that count.
- **A posted argument is never printed unless it is a string, a number, a boolean, null or
  undefined.** Anything else is named by its kind (`[object Array]`), since the frame's code is the
  gadget's and printing its value would cost what the frame chose. No more arguments are read than
  can add to the text a report reads.
- **Nothing is sent while the connection is lost.** The queue keeps its newest calls and counts
  the older ones, and goes out, with a marker for that count, once the connection is back.
- **A flush when the page is hidden, and a last send when the view goes away.** Both are best
  effort. A closed tab sends only what it got out as the page was hidden, and a view that goes
  away while the connection is lost, or as its user moves straight to another workspace, loses
  what it had queued with nothing to mark it.
- **A wait that doubles, up to five minutes** (`GADGET_CONSOLE_LOG_MAX_BACKOFF_MS`), each time a
  report is refused for a reason a reconnect would not cure. A report that succeeds sets the wait
  back to five seconds. A reporter slows down only when its report is refused, which is why a
  report whose entries could not be kept rejects.

A view that floods meets both limits, the reporter's and the server's. Its reporter offers up to
50 entries every five seconds, 600 a minute, against the 300 the server records for a gadget in a
minute. So the server drops some of what the reporter sent, a reporter's own marker possibly among
them, and the server's marker then counts what the server dropped: a dropped marker counts there
as one entry, whatever count it carried. Every count is therefore an estimate of what a flooding
view lost, and can be far short of it.

## The log object

A workspace's entries are kept in one `WorkspaceLogDurableObject` (SQLite), one per life of the
workspace. The Overseer names it with a random string when the first entry is kept, stores that
name in its own storage (`consoleLogId`), and is the only caller that knows it. A workspace that
has kept nothing has no log object at all, and a read never makes one.

### Schema

The schema is created by the first `append()`, never by a read or the constructor, since deleting
everything the object holds deletes the tables too.

```
console_logs(seq INTEGER PRIMARY KEY AUTOINCREMENT, kept_at INTEGER NOT NULL,
  at INTEGER NOT NULL, gadget_id INTEGER NOT NULL, chat_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('server', 'client')), user_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'log', 'warn', 'error')),
  text TEXT NOT NULL, bytes INTEGER NOT NULL,
  CHECK ((source = 'client') = (user_id IS NOT NULL))) STRICT
console_log_usage(gadget_id INTEGER NOT NULL, source TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (gadget_id, source)) STRICT, WITHOUT ROWID
```

Three indexes, each for one job: `(gadget_id, seq)` pages one gadget's entries,
`(gadget_id, source, seq)` reads and deletes the oldest entries of one gadget and source, and
`(kept_at)` finds expired entries. `bytes` is what the entry counts toward the bounds, and
`console_log_usage` holds the sum of `bytes` for each gadget and source that has entries, kept
exact by two triggers on `console_logs`, so that a bound is checked without reading the entries.

A row has two times, both in epoch milliseconds:

- `kept_at` is when the object kept the entry, by its own clock. The retention counts from it.
- `at` is the entry's own `time`, which for a `"client"` entry is whatever a browser said. Only
  the `since` and `until` filters of a listing read it.

### Retention

An entry is kept for 72 hours (`GADGET_CONSOLE_LOG_RETENTION_HOURS`), counted from when it was
kept and never from its own time, because a browser chooses that time. An entry timed in the
future is gone after 72 hours like any other, and one timed long ago is kept its 72 hours and
found by that time.

### The byte bounds

| Bound | Constant | Bytes | Of which `"client"` entries | Of which `"server"` entries |
| --- | --- | --- | --- | --- |
| One gadget | `GADGET_CONSOLE_LOG_BYTES_PER_GADGET` | 10,000,000 | 2,000,000 (`GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET`) | 8,000,000 |
| The workspace | `GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE` | 50,000,000 | 10,000,000 (`GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE`) | 40,000,000 |

Each source has its part of each bound to itself and loses only its own entries. Nothing verifies
what a browser reports, so if the two shared a bound, anyone who may report could push a gadget's
server entries out. As it is, what browsers report can push out only what browsers reported.

The split covers reports only. A session that may call a gadget can cause `"server"` entries as
well, and those push out the gadget's older `"server"` entries like any other: through the
gadget's own code, when it logs what it is called with, and through calls that fail, which are
rate-limited for that reason (see
[The limit on caught exceptions](#the-limit-on-caught-exceptions)).

Past a gadget's bound, that gadget's oldest entries of that source go. Past the workspace's bound,
the entries go from the gadget holding the most of that source, its oldest first, and not from the
oldest rows of the workspace: that keeps a gadget that logs little from losing its entries to
others that log a lot.

**How an entry is counted.** An entry counts as an estimate of the database bytes it takes when it
is written (`entryBytes()`): its row's share of a 4 KB page filled with rows like it, plus its
entries in the three indexes. A row is its text and user id in UTF-8 and 56 bytes beside them, and
the index entries count 55. Rows share a page only whole, so three rows of about 1,000 characters
take a page between them, a row over half a page has one to itself, and a row longer than a page
counts as whole pages. The text's bytes alone would not do: a line cut to 2,000 characters takes a
page of its own, so counting it as its 2,002 bytes would let such entries take twice the bound in
storage. The count is computed inside the object and never taken from its caller.

Measured against the database's own size:

- A freshly filled database takes at most about 1.02 times the counted bytes, for entries with no
  text up to cut ones (`workspace-log.test.ts` pins this).
- A line cut to 2,000 characters counts a whole page, 4,151 bytes, so a gadget's 2,000,000 bytes
  of reported entries hold 481 of them. A server entry of 300 characters counts 428 bytes, and one
  with no text 112.

The bounds are on the counted bytes, not on the file. Once entries are pruned the database can
take more than the count: new rows go to the end of the table, and a page that lost one gadget's
old rows stays part-empty while it still holds newer rows of other gadgets. In the worst mix
measured (one gadget logging four times as much as each of four others, all at their bound) the
database settled at about 1.4 times the count, and between 0.94 and 1.05 times in the other mixes
tried.

### Writing and pruning

`append()` keeps a batch whole or not at all: its inserts and its pruning are one transaction, so
an insert that fails leaves nothing of the batch, and on a first append no schema either. The
object trusts its caller for nothing it bounds: a text is cut again, a level it does not know is
kept as `log`, an invalid time is kept as the time of keeping, and an entry's own time decides
neither how long it is kept nor the alarm.

Entries are pruned on write and by alarm:

- **On write.** Each `append()` deletes expired entries, of any gadget, and then holds the bounds
  of the gadgets and sources it wrote to, which are the only ones that can have passed one.
  Expired entries go first, so none within its retention goes in their place. An append deletes
  up to 10,000 expired rows before it looks at a bound. A gadget's bound then takes that gadget's
  oldest entries, its expired ones first. While the workspace's bound is still passed, the append
  goes on deleting expired rows, 10,000 at a time, and takes an entry within its retention only
  once none is left.
- **By alarm.** A log nothing is appended to still empties: the alarm deletes expired entries and
  sets itself again for when the oldest remaining entry expires, no sooner than an hour away.
  An append sets the alarm only when none is set.
- **An expired entry is never listed**, whether or not it has been deleted yet. It is deleted with
  the next write or by the alarm, within about an hour of expiring. An alarm deletes at most
  10,000 expired rows, and one that leaves some runs again at once. An append deletes as many,
  and more only to hold a bound.
- **An alarm that fails** is logged and tried again in an hour, not thrown: the platform retries
  an alarm that throws only a few times and then leaves none set.
- **An alarm that finds no entry left** deletes the object's storage, schema and alarm included.

A read changes nothing: `list()` creates no table, deletes nothing and sets no alarm.

## Who reads

| Reader | Through | Gets |
| --- | --- | --- |
| A `build` session (the owner or a `build` collaborator) | `Overseer.listConsoleLogs()` | The workspace's entries, paged and filtered. |
| A `use` session | `Overseer.listConsoleLogs()` | An empty page, whatever the query. No log object is asked. |
| A deployment admin | `AdminWorkspaceView.listConsoleLogs()` | The same pages at `"full"` only, each call recorded, as a content read when its page holds an entry. |

A listing is paged, 100 entries a page (`GADGET_CONSOLE_LOG_PAGE_SIZE`), newest first by the order
the entries were kept in. Every page but the last is full, and a page without `nextCursor` is the
last. A cursor names the last entry of its page, by its sequence number and by when it was kept
(`<seq>@<kept_at>`), and is taken only in the one spelling it was handed out in. A cursor held until
every entry has expired lists nothing: the object's storage is deleted then, the sequence starts
again with the next entry, and the listing takes nothing kept later than the cursor's entry for an
older one. It is filtered as `GadgetConsoleLogQuery` says, and the filters combine: by gadget, by
chat (null for the entries of a gadget's mainline only, absent for any chat), by source, by level,
and by the entry's own time (`since`, `until`). An id that names no gadget or no chat, or a deleted
one, is not an error. A `since` or `until` that is not a valid time, or a malformed `cursor`, throws
a `TypeError`, whether or not the workspace has kept anything.

The admin read is one of the view's content methods (`ADMIN_CONTENT_METHODS`), described in
[admin-access.md](admin-access.md#each-call). Below `"full"` it is refused with `contentWithheld`
and recorded, and the log object is not asked. At `"full"` its record holds the fields of its
query among the call's arguments (`since` and `until` as ISO 8601, a null chat as `"mainline"`,
since a recorded argument is a string or a number), and `exposed` is `"content"` when the page
holds an entry. An invalid time or cursor is rejected before the call starts, unrecorded. A cursor
has one spelling, so the `cursor` in a record names the page that was read. The read leaves the
log object as it was.

### Why these readers

Kept entries are workspace content and can hold restricted data, because a gadget may log what it
read through a connection. So among a workspace's members they are read only by the sessions that
observer verification covers in full (see [observers.md](observers.md)). The owner holds every
connection. A `build` collaborator is verified against every account-requiring connection of the
workspace when their session opens, and a scope that widens restarts the sessions. A `use` session
is verified only against the connections that a gadget it opened reaches, so it reads none of the
history, for the same reason it gets no live logs, no chat history and no action log. What its own
browser reports is kept, and it cannot read even that back. What a gadget's UI logs in a `use`
collaborator's browser is therefore visible to builders, labelled with that collaborator's id.

An admin is verified against no connection, and reads the entries under the
[admin exception](observers.md#admin-access-a-deliberate-exception): at `"full"` only, with a
reason, and recorded.

Entries outlive the connection their data came through. Removing a connection removes no kept
entry, so what a gadget logged of it stays readable by `build` sessions until it expires, at most
72 hours later. Chat history and storage keep such data with no limit (see
[observers.md](observers.md#6-edge-cases), the edge case on removing a connection that read
restricted data).

Live delivery through `subscribeToConsoleLogs()` delivers only what is logged while subscribed,
never a reported entry, and keeps nothing itself.

### Through the API

The Workshop does not show the kept entries: they are read through the API. The `cf-os api` CLI is
one way in, though not every member's:

- **On a local instance** any user reads a workspace they may build with
  `pnpm cf-os api open-workspace <id> list-console-logs`, filtered with `--query`, for example
  `--query '{"gadgetId":1,"chatId":null,"source":"server"}'`.
- **On a deployment** the CLI signs in deployment admins only (see
  [Deployment admins only](../packages/api-cli/README.md#deployment-admins-only)). An admin reads
  a workspace they may build with the command above, and any other through
  `pnpm cf-os api get-admin-api inspect-workspace <id> "<reason>" --options '{"access":"full"}' list-console-logs`,
  which is recorded, and refused where the deployment's level is below `"full"`.
- **A member who is no admin** reads `Overseer.listConsoleLogs()` from an API session of their
  own.

`pnpm cf-os api search "read gadget logs"` finds `list-console-logs`. The search scores a command
by its name and the first sentence of its doc, and its ranks are pinned in
`packages/api-cli/src/run.test.ts` against the real `api.ts`, which is why the first sentences of
the docs of `Overseer.listConsoleLogs()`, `Overseer.reportGadgetConsoleLogs()` and
`AdminWorkspaceView.listConsoleLogs()` are worded as they are.

## Deletion

**The workspace.** Deleting the workspace deletes its log object. `deliverUserUpdates()`, the
drain that finishes a deletion, calls `#deleteConsoleLogs()` once every member's listing of the
workspace is removed and directly before it wipes the workspace's own storage, because the wipe
takes the log object's name with it. `#deleteConsoleLogs()` waits for the appends still in flight,
since one landing after `destroy()` would bring entries back, and then destroys the log object.
The two together are bounded at two seconds, and a `destroy()` that met a reset of the log object
is replayed once inside that bound (`retryOnDoReset()`; `destroy()` is idempotent). No append
joins the ones in flight meanwhile: a workspace that is being deleted keeps nothing.

A log object that fails, or does not answer in time, never fails the owner's deletion:

- the failure is one warning in the server log (event `gadget.console.delete.failed`);
- the wipe of the workspace's storage is deferred with it, so the deletion tombstone and the log
  object's name remain;
- `deleteSelf()` closes and restarts the workspace's sessions all the same;
- the workspace's alarm runs the drain again 30 seconds later, and again until the log object and
  the wipe are both done, as it does for a user's listing that could not be removed.

One thing the wait cannot cover: an append sent by an Overseer instance that was aborted before
the append settled can land after the deletion. It lands in an object whose name went with the
workspace's storage, so nothing reads it again, and the object deletes itself when those entries
expire. That holds for the next life of a workspace named by key too. An external message can
initialise a deleted workspace's id again, for whoever posts next, with gadget ids that start
again at the same numbers; that life makes a name of its own with its first entry, and starts
with no log.

A trace of the earlier life can reach the next one as well. A gadget call still open at the
deletion ends when the workspace's instance restarts, a moment later, and its trace is delivered
to whatever holds the id by then. `deliverGadgetLogs()` keeps nothing of a batch that holds a log
from before the workspace was initialised (its `createdAt`), so what such a call logged is not
kept in the next life's log. What is not told apart is a request of the earlier life that logged
nothing until the id was initialised again, in the tenth of a second before that restart. Live
subscribers are sent a late trace as they are sent any other.

**A gadget.** Deleting a gadget keeps its entries. They stay listable by its id, through
`listConsoleLogs()` and the admin view, until they expire. A report for a deleted gadget is
refused.

**A chat.** Deleting a chat keeps the entries labelled with it as well, and a report under a
deleted chat is refused.

Neither a chat's id nor a gadget's is given out again in the life of a workspace, so no later chat
or gadget is taken for the deleted one.

## What the server logger gets

Never anything of an entry. The server logger gets three warnings, each with the caught error and
nothing else of what was being written:

| Event | Logged by | When |
| --- | --- | --- |
| `gadget.console.record.failed` | the Overseer (`workshop.overseer`) | A batch could not be kept: a trace's, a caught exception's or a report's. |
| `gadget.console.delete.failed` | the Overseer (`workshop.overseer`) | The log object's deletion was deferred. |
| `gadget.console.expire.failed` | the log object (`workshop.workspace-log`) | An alarm failed. |

A report that could not be kept is also refused to its caller, and whatever marker it was to
bring is counted by the gadget's next. A gadget's tail and a gadget's caller are never failed by
a batch that could not be kept: its entries are lost.

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `gadget-console-log.test.ts`: the redaction (what is caught, what is left alone, what is
  replaced though it is no credential, what is not caught, and its time on adversarial text), the
  text (the join, the read bound, the cut), the two entry makers, the marker's wording and the
  limiter.
- `workspace-log.test.ts`: the log object. Appending, the listing with its filters and cursors (a
  cursor's one spelling, and one that outlived its entries), what an entry counts and what a freshly
  filled database takes, the 72 hours counted from keeping, the per-gadget and per-workspace bounds
  for each source, oldest first, pruning on write and by alarm, the alarm's failures, and
  `destroy()`.
- `gadget-console-history.test.ts`: the Overseer's side. A trace, a caught exception and a report
  kept under the right chat; a trace's entries passing no rate limit, and caught exceptions held
  to theirs with a marker; a batch that names no gadget; a trace from before the workspace was
  initialised;
  failed appends logged with nothing of an entry; the report's cap, rate limit and markers; the
  listing for a build and a use session; a deleted gadget and a deleted chat; and the workspace's
  deletion, with an append in flight, a reset, a failing log object and an id initialised again.
- `use-gadget-access.test.ts`: what a `use` session may report, and for which gadgets.
- `admin-workspace-view.test.ts` and `admin-access.test.ts`: the admin read, refused below `"full"`
  and recorded, its query in the record, a malformed query or another spelling of a cursor
  unrecorded, and whether a page holds content.

Frontend suites, in `packages/workshop-frontend/src/`:

- `features/gadget-console/gadgetConsoleLogReporter.test.ts`: the reporter's batching, queue,
  markers, backoff and last send, and how a frame's message is read.
- `GadgetUI.integration.test.tsx`, `GadgetUseView.test.tsx` and
  `GadgetEditor.blueprintUpdate.test.tsx`: every mounted view reporting, with and without a chat,
  through an outage and as it goes away.
- `GadgetUI.consoleLogs.browser.test.tsx`: a real frame's console calls and uncaught error
  reaching the report.

Integration suite, `packages/integration-tests/__tests__/workshop-console-log-history.test.ts`: a
gadget's server console call and a reported client batch both kept and read back by a build
session; a use session reading nothing while what it reports is kept; the admin read refused at
`"metadata"` and recorded as a content read at `"full"`; a report over the cap of a call; a use
session's failing calls held to 30 kept errors a minute; a deleted gadget's entries listed by its
id; and the workspace's deletion deleting its log.
`workshop-use-role.test.ts` holds the methods a use session may call, the report among them, and
`packages/api-cli/src/run.test.ts` the search ranks.
