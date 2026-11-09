# Gadget console logs

A deployment can record what its gadgets print to their consoles in its backend Worker's logs,
which Workers Observability keeps. Recording is off unless the deployment turns it on. Live
delivery through `Overseer.subscribeToConsoleLogs()` is the same either way, and no API returns
past logs: the record is read in the Cloudflare account's Workers logs. This document says what is
recorded, who can read it and what bounds it. The pieces are:

| Concern | Location |
| --- | --- |
| The entry types, the caps, the marker wording, `Overseer.reportGadgetConsoleLogs()`, `ServerConfig.gadgetConsoleLogsRecorded` | `packages/workshop-shared/src/api.ts` |
| Shaping, redaction, the limiter, the switch, the writer and its entrypoint | `packages/workshop-backend/src/gadget-console-log.ts` |
| `GadgetTailLoopback` and the Overseer's `reportGadgetConsoleLogs()` | `packages/workshop-backend/src/overseer.ts` |
| The Workshop's capture of what a gadget view's frame logs | `packages/workshop-frontend/src/features/gadget-console/` |
| The end-to-end tests | `packages/integration-tests/__tests__/workshop-console-logs.test.ts` |

## What the switch decides

With the switch off the Workshop writes none of these lines, and that is all the switch decides.
It does not govern what the platform's own logging keeps of a Worker's console output, and a
gadget's console call is also output of a Worker the backend loaded: a local instance prints each
one to its terminal as the gadget wrote it, with the switch on or off and with nothing redacted.
Whether a deployment's Workers logs keep that raw output for the backend Worker is the platform's
behaviour, which this code neither turns on nor off. So before reading "off" as "absent from the
logs", look at what the account's logs already hold for the backend Worker.

The same holds for what a line proves, wherever raw gadget output is kept. A gadget can print an
object shaped like any log line, a `gadget.console` entry with any `gadgetId`, `userId` or
`consoleSource` among them, and the Workshop writes its own lines as plain objects too
(`packages/observability/src/logger-core.ts`), so in a local instance's output the two cannot be
told apart. Where a deployment's logs keep a gadget's raw output, take a line's fields as proving
nothing by themselves: not which workspace or user it belongs to, and not that the Workshop wrote
it.

## Turning it on

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `RECORD_GADGET_CONSOLE_LOGS` | the string `true` | off (unset, blank, `false` or anything else, a JSON boolean or object included) | The Workshop writes what gadgets print to their consoles as `gadget.console` lines in the backend Worker's logs. |

A value that is none of `true`, `false` or blank is logged: an error line of component
`gadget.console` with event `gadget.console.config.invalid`, once per isolate for each such value.
The line names the variable and does not hold the value.

It is a variable of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set it in the shell or in the root `.dev.vars`;
  `scripts/run-dev-server.ts` passes it through to the backend.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so such a tool must carry the variable, or
  its deployments record nothing.
- **Pull request previews** (`scripts/preview/staging-config.ts`): on, so that a change to recording
  can be tried there.

`cf-os api public get-server-config` shows whether it took (`gadgetConsoleLogsRecorded`). That
answer is also what tells the Workshop whether to send anything: where it is false, a browser
queues and sends no console output.

## Who reads it

The text is whatever a gadget prints, data read through its connections included, and it is
recorded for every workspace, those holding restricted data too: the restricted-data flag
(`containsRestrictedData`) does not withhold console output. So recording puts that text in front
of everyone who can read the Cloudflare account's Workers logs:

- account members with access to Workers logs, and API tokens that have it;
- Logpush destinations and `wrangler tail`;
- a workspace connected to the account through the Cloudflare gatekeeper's Workers Observability
  resource, with its agent and its collaborators.

The workspace's gatekeepers verify none of them, and they are not the Workshop's `ADMINS` list,
which gives no access to these logs. Recording is acceptable only where Workers Observability is
treated as sensitive and limited to the people who administer the account. Do not turn it on where
that does not hold, and remember that a Workers Observability resource shared into a workspace
carries these lines with it. [observers.md](observers.md) says what restricted data otherwise
guarantees.

The lines live in the account's logs, not in the workspace: they are not deleted with it, they
follow the account's log retention, sampling and billing, and reading them is not in the admin
audit log.

To its reader the text is untrusted input, on both sides. A gadget's code chooses what its server
prints, but not all of it: whoever calls a gadget's server chooses the name of the method they
call, which the error of a failed call repeats, and a gadget's own errors and console calls can
repeat the arguments they were given. A call to a method the gadget does not have is recorded as a
server line that holds the name the caller chose, with no user on it and outside the per-gadget
rate limit, and anyone who can open the gadget can make one, a `use` collaborator and the gadget's
own client code included. So `consoleSource` says where a line was produced, `server` or `client`,
never who chose its text. And anyone whose browser shows the gadget's UI can report any text at
all as its client's. A person, and above all an agent that queries these lines through a Workers
Observability resource, must take `text` as data and never as instructions.

## What is recorded

- **A gadget server's console calls**, every one, and every exception the runtime reports for it
  uncaught: a timer callback that throws, for one. An unhandled promise rejection is not reported.
- **An exception a gadget method throws at its caller**, when that caller holds a stub the
  Workshop wraps to catch it: a session's `connectToGadget()` stub, another gadget's binding and an
  export. A hook, and a stub the gadget restored for itself, are not wrapped. Live delivery
  carries exactly the same exceptions. One failure can be both kinds: an exception thrown by a
  gadget's constructor is reported by the runtime and thrown at the caller, so it is recorded
  twice, once with the error's message and once with the method that was called, as live
  delivery sends it twice.
- **What each open gadget view's browser sends**, every few seconds
  (`GADGET_CONSOLE_LOG_FLUSH_MS`, 5 seconds): what the gadget's client code passed to `console.*`,
  and the errors it did not catch. These entries are unverified and labelled with the session's
  user, who ran the gadget's code in their browser and did not necessarily write the text. A `use`
  collaborator's browser sends too, for the gadgets they hold (see [sharing.md](sharing.md)).
  Client entries are never delivered to live subscribers.

The agent's inline views in chat answers are not gadget UIs and are not captured.

One case reaches neither the record nor live delivery: a trace the runtime hands the Workshop with
anything but exactly one request in it is dropped by `GadgetTailLoopback.tail()` before it delivers
or records, with an error line of event `gadget.trace.size.unexpected` (component
`workshop.overseer`) in its place.

### When a server line is written

A server line is written when the gadget's request ends, not as the gadget prints, so the entry's
`time` is the call's own and the log line's timestamp is later. A call that keeps a stub or a
subscription open is one request until that is let go (live delivery waits the same way), so
everything the gadget prints for it is written then, together, and all of it shares one request's
bound.

The runtime's own log size limit applies to that request first. What one gadget request prints
past about 256 KB (the runtime counts each console call's arguments and some bookkeeping of its
own, so less text than that) is not passed on by the runtime, so it is neither delivered live nor
recorded, and no marker counts it. The runtime does mark the place: it ends that request's console
output with a warning of its own, which begins "Log size limit exceeded" and is delivered live and
recorded like any other console call, at `consoleLevel` `warn`; it does not say how much was lost,
and the exceptions the request leaves uncaught still follow it.

### Not error reports

Recorded console output is log lines and nothing else. It is never dispatched to the issue
Reporter (`reportIssue()`): automatic error capture stays out of gadget code, as
`packages/error-reporting/AGENTS.md` requires.

## The lines

Every line has component `gadget.console` and these fields:

| Field | Meaning |
| --- | --- |
| `event` | `gadget.console.entry` for a console call or an exception, `gadget.console.dropped` for a marker (see [Markers](#markers)). |
| `gadgetId` | The workspace id, as on the Workshop's other log lines. |
| `workpieceId` | The gadget. |
| `chatId` | The chat whose draft of the gadget was running. Absent for the mainline and for a chat that proposes no change to the gadget. One exception: an export handler's output carries the chat the export was asked under even when that chat proposes no change. |
| `consoleSource` | `server` or `client`: where the line was produced, not who chose its text. |
| `userId` | On the lines of a browser's report only, its marker included: the reporting session's profile id. That is the user's email address for every account created by signing in through Cloudflare Access or through an authentication gatekeeper, Google or GitHub for example (see [oauth-signin.md](oauth-signin.md)), and the username only for an account created with a password. So on those deployments these lines hold that address beside the text. |
| `consoleLevel` | Entries only: the console method called (`debug`, `info`, `log`, `warn` or `error`), or `error` for an exception the code did not catch. |
| `time` | The call's own time, in ISO 8601: by the Workshop's clock for a server entry, by the reporting browser's for a client one. On a marker, when it was written. The line's own timestamp is always when it was written. |
| `text` | The call's arguments as one string, redacted and then cut (see [Redaction](#redaction) and [Limits](#limits)). On a marker, the count as a sentence ("37 entries dropped"). |
| `droppedCount` | Markers only: how many entries were dropped. |

Two names differ from the entry type's (`GadgetConsoleLogEntry`) `level` and `source`: Workers Logs
has a `level` of its own and returns a line's own fields inside an object named `source`, so the
line says `consoleLevel` and `consoleSource`. To find a workspace's lines, filter on `component`
and `gadgetId`. Every entry is written at level info and every marker at warn, so a gadget's
`console.error` never counts as an error of the Workshop.

### Where each line is written

| Output | Written by | In which request | Bounds |
| --- | --- | --- | --- |
| A gadget server's console calls and uncaught exceptions | `GadgetTailLoopback.tail()` | the gadget's own tail | bytes per request |
| An exception a gadget method throws at a caller that holds a wrapped stub (a session's `connectToGadget()`, another gadget's binding, an export) | `GadgetConsoleLogLoopback.server()`, handed by the Overseer | its own | bytes per request |
| A browser's reported batch | `GadgetConsoleLogLoopback.client()`, handed by the Overseer | its own | entries per call, entries per gadget per minute, bytes per request |

The runtime stops recording a request's logs after 256 KB, leaving only a warning of its own that
counts nothing, and a browser's session with a workspace is one long request. So nothing is
written there: server output is written by the gadget's tail, and client batches and caught
exceptions by an entrypoint of their own.

## Limits

| Limit | Constant | Value |
| --- | --- | --- |
| Characters of `text` kept | `MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH` | 2,000; a longer text is cut, the cut marked by "…" |
| Entries one report records | `MAX_GADGET_CONSOLE_LOGS_PER_CALL` | 50 |
| Client entries per gadget per minute | `GADGET_CONSOLE_LOGS_PER_MINUTE` | 300 |
| Bytes of lines one request writes | `GADGET_CONSOLE_LOG_BYTES_PER_REQUEST` | 192 KB, of which the newest lines are kept, so that the error ending a chatty request survives |

The per-gadget minute is one budget for everyone viewing the gadget. A single viewer whose copy
logs heavily, a `use` collaborator included, can use it up and leave the others' client entries
unrecorded until the next minute, with a marker saying how many. The count lives in the memory of
the workspace's object, so it starts again when the object restarts, which happens once nobody has
been connected to the workspace for a while.

Server output has no rate limit: its only bound is the bytes of one request. Anyone who can open
the gadget, a `use` collaborator included, makes its server print by calling a gadget method that
logs, or any method name at all, since a failed call is recorded with the name that was called, as
often as they call it. The per-gadget minute covers none of that.

### Markers

What the Workshop's server drops is marked by a `gadget.console.dropped` line with `droppedCount`,
written before the entries of its request: at most once a minute per gadget for what the per-call
cap and the rate limit drop (one count per gadget holds both), and in the same request for what
the bytes bound drops. A marker carries the labels of the request that wrote it. For a browser's
report those are the `userId` and `chatId` of the report that brought the marker, while that
per-gadget count covers every report's drops for the gadget since the gadget's last marker,
whoever sent them and under whichever chat. So the labels do not say whose entries were dropped.

What a browser drops before sending it reports itself: its queue keeps the newest entries of each
few seconds, and a batch that failed to send counts as dropped. That marker is an ordinary client
entry of level `warn` with the same wording ("37 entries dropped"), not a `gadget.console.dropped`
line.

Every count is an estimate, never a bound. It can be short in two ways. Drops after a gadget's
last marker of a minute are counted only by its next marker, which is written only if the gadget is
reported for again. And a browser's marker is itself an entry, the first of its batch, so the
server's limits drop it like any other: with a report the rate limit refuses whole, and before
every other entry, as the oldest, when the bytes bound cuts a report. The count it carried is then
lost, and the server's marker counts it as one entry. A view that keeps logging faster than the
per-gadget minute allows loses the marker of every report refused in that minute, so the drops
recorded for it can be far below what it dropped.

A count can be over as well. A browser counts a batch as dropped when its send fails, or is given
up after `GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS` (30 seconds), though the server may have recorded it.
A gadget's marker can be over too, after a report that could not be written: it counts what that
report's marker held, which can include entries of the report itself, and the browser has counted
those as well.

### When recording fails

A client batch or a caught exception that cannot be handed to the writer is logged by the
workspace's own logger, component `workshop.overseer`, as a warn with event
`gadget.console.record.failed` and the error. That line holds none of the output. The browser's
report is rejected, and it counts that batch as dropped. A marker that report was to bring is not
lost with it: the gadget's next marker counts what it held.

Neither the length of an error's text nor the size of a value a gadget throws that is not an Error
causes this. The writer is handed the text that is read of either, which is at most
`MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH` characters, and writing a value as JSON stops at that
length too: an array's holes and a typed array's bytes would otherwise be written as many times
the memory they take.

### What the capture loses without a marker

Three things a gadget view holds are lost with nothing to mark them. A closed tab sends only what
it got out as the page was hidden. When the user moves from one workspace straight to another, the
view's last few seconds of entries are refused, because the old workspace's connection is let go
before the view is. And a view that goes away while the Workshop's connection to its server is
lost loses what it had queued (at most the newest `MAX_GADGET_CONSOLE_LOGS_PER_CALL - 1` entries,
and whatever count of earlier drops they carried), since it has nothing to send them through.
Leaving a workspace any other way (to another page, another gadget or another draft) sends the
last batch first.

An outage that a view outlives loses nothing unmarked: while the connection is lost an open view
sends nothing, keeps its newest entries and counts the older ones, and sends them, with a marker
for the count, once the connection is back.

## Redaction

Before a text is cut, these shapes in it are replaced with "[redacted]":

- bearer and basic credentials;
- `sk-` keys;
- JSON Web Tokens;
- PEM private keys, between their BEGIN and END lines;
- the password in a URL;
- the values of URL parameters named like a secret;
- the values of JSON members named like a secret, `set-cookie` and `proxy-authorization` among
  them.

The secret names are `token`, `secret`, `password` or `passwd`, `signature`, `credential`, and
`key` after `api`, `private`, `secret` or `access`, with or without a `_` or `-` between
(`apikey`, `api_key`). A parameter or a member is named like a secret when its name is made of
ASCII letters, digits, `_`, `.` and `-` (a URL parameter's also of `~` and `%`) and ends in one
of the secret names, in any letter case: a member called `Client Secret` is not, because of the
space, and its value is left in the text, while `access_token`, `clientSecret` and `X-Api-Key`
are. A JSON member is too when its whole name is `authorization`, `proxy-authorization`,
`cookie` or `set-cookie`, and a URL parameter when it has one of the short names listed under
[What it replaces though it is no credential](#what-it-replaces-though-it-is-no-credential).

A member is found in JSON a gadget prints and in JSON held in a string of it, once or twice over,
such as a request body the gadget serialized itself. Its value is replaced to its closing quote,
whatever escaped characters it holds, and whole where it holds a URL with a parameter named like
a secret: a member is replaced before a parameter is. A URL parameter's value is replaced up to
the next `&`, `#`, space, double quote or angle bracket, and a JSON Web Token with its empty
segments, which a directly encrypted one has.

Redaction happens before the cut, and a browser sends up to twice the kept length
(`MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH`, 4,000 characters) for that reason: a token that
straddles the cut is replaced whole.

A bearer or basic credential, an `sk-` key and a JSON Web Token are recognised wherever one can
start, which is anywhere but directly after a letter or a digit, unless that letter or digit ends
a percent-escape (`%20`) or a JSON escape (`\n`). An object a gadget prints is recorded as JSON,
where a token on a line of its own follows such an escape, so printing a value inside an object
does not hide a token that is caught in the value itself.

No more than `MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH` characters of a call are read, and a
text that long loses its last unbroken run of letters, digits and token punctuation, since it may
be the start of a token (with what is left of a URL password the bound cut). So one very long
unbroken string (a base64 payload, say) is recorded as what precedes it and "…".

Redaction is a backstop against a credential printed by accident, and it errs towards redacting.
It is not what makes keeping the text acceptable: that rests on who can read the logs (see
[Who reads it](#who-reads-it)). It covers the `gadget.console` lines the Workshop writes, and
nothing else the logs may hold of a gadget's output (see
[What the switch decides](#what-the-switch-decides)). Each of the two lists below matches a table
of `packages/workshop-backend/__tests__/gadget-console-log.test.ts`, and a change to the patterns
updates both.

### What it does not catch

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
  (`Bearer 17|...`) is recorded whole. The same credential as the value of an `authorization`
  member of JSON is replaced.
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

### What it replaces though it is no credential

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

## Local development and tests

An instance started by `pnpm dev-server` or `pnpm run-local` writes none of these lines unless its
shell or `.dev.vars` sets the variable. The integration suite
(`packages/integration-tests/__tests__/workshop-console-logs.test.ts`) starts one harness with it
and one without.
