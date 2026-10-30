# `@gadgets/api-cli`: `pnpm cf-os api`

`pnpm cf-os api` calls a running instance's [Cap'n Web](https://github.com/cloudflare/capnweb) API,
the one its frontend uses, so an agent can list workspaces, read chats, approve actions and open
Gatekeeper sessions without a browser. Run it from the repository root (`pnpm -w cf-os api ...`
from a package directory). Its commands are not written by hand: they are generated from
`packages/workshop-shared/src/api.ts` through [`packages/api-schema`](../api-schema/README.md)
([cloudflare/cloudflare-os#860](https://github.com/cloudflare/cloudflare-os/pull/860)), so they are
always this checkout's API: `pnpm cf-os` generates them first when api.ts or the generator has
changed since it last did ([Generated files](#generated-files)).

[cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)'s own `cf-os api` is
to run this same CLI from its submodule, in place of the copy it ships today (see
[Running it from another repository](#running-it-from-another-repository)).
In cloudflare-os, `cf-os` has only `api`; its other commands (`init`, `check`, `deploy`, `update`,
...) are the starter's, and here they fail saying so (exit 1).

On a deployment, the CLI is for its deployment admins only; on a local dev server anyone may use it
(see [Deployment admins only](#deployment-admins-only)).

```sh
pnpm cf-os api search "list chats"                         # the commands for a task, whole command lines as JSON (connects to nothing)
pnpm cf-os api --help                                      # the commands there are once signed in (connects to nothing)
pnpm cf-os api whoami                                      # who the session signed in as
pnpm cf-os api list-workspaces                             # the workspaces
pnpm cf-os api new-workspace set-title Notes               # a workspace, titled; its id on stderr
pnpm cf-os api open-workspace <id> get-chat-history <chatId>  # a chain: open-workspace returns the workspace
pnpm cf-os api open-workspace <id> list-actions --options '{"filter": "pending"}'
pnpm cf-os api open-workspace <id> approve-action <actionId>  # acts on the instance, like the button
pnpm cf-os api open-workspace <id> subscribe-to-chat --timeout 60  # events, one JSON line each, for a minute
pnpm cf-os api open-workspace <id> wait-for-agent <chatId>  # waits for the agent's turn, prints its reply
pnpm cf-os api public get-server-config                    # PublicApi, without signing in
pnpm cf-os api get-gatekeeper-app context ui list-enabled-context-collections  # a gatekeeper's app UI, typed
pnpm cf-os api types Overseer                              # a service as TypeScript declarations (connects to nothing)
pnpm cf-os api types context                               # a gatekeeper app UI's declarations, by vendor id
pnpm cf-os api open-workspace <id> get-chat-history <chatId> --dry-run  # the calls, as JSON; connects to nothing
CFOS_API_PASSWORD=... pnpm cf-os api create-account bob    # a user to act as on `pnpm dev-server`, the default instance
CFOS_API_PASSWORD=... pnpm cf-os api --username bob whoami # signed in as bob
pnpm cf-os api --url https://os.example.com whoami         # another instance: behind Access, CF_ACCESS_TOKEN or cloudflared
pnpm cf-os api open-workspace <id> get-metadata --answer 'ObserverConfigCallback.configure=[{"gatekeeperId": 3, "accountId": 7}]'
                                                           # a collaborator's first open, choosing the connected account
```

## Finding and chaining commands

`search "<task>"` is where to start: it ranks the commands by the task's words and prints the best
five as JSON, `[{"command", "summary"}]`, each a whole command line from `cf-os api` with a
placeholder for every argument along the way. A command is found by the words of its name, of its
doc's first sentence (the summary), of its options' names (each only when the task says all its
words but for stop words, and then as one word of the summary: "copy secrets" finds `add-model`
by its `--copy-secrets-from`, "copy" alone does not, and "chat id" finds the chat commands before
the ones with a `--chat-id`), and of the
callback methods the server may ask it to `--answer` (`ObserverConfigCallback.configure` finds
`open-workspace <id>`), and, less, by those of the commands leading to it (and of the value of an
argument that types what follows, `context` in `get-gatekeeper-app context ui ...`), which also
order the copies of one method several capabilities share ("remove a gatekeeper" finds a gatekeeper's
`remove` before a gadget's). Commands are the API's
methods in kebab-case, starting from what a signed-in session gets (`AuthenticatedApi`); a leading
`public` starts from `PublicApi` instead, without signing in.

A command that returns a capability (`→ Overseer` in the listings) goes on to the next command, on
it, and the whole chain is sent at once, pipelined in one session. A chain that ends on a capability
sends nothing: `cf-os api new-workspace` creates no workspace, and fails saying so and naming a way
to finish it (`cf-os api new-workspace get-metadata`). A command that creates what it returns
(`new-workspace`, `new-workspace-from-blueprint`) prints that thing's id on stderr,
`Created workspace <id>.`, whatever follows it on the line, and even when a later command of the
chain fails, so `new-workspace set-title X`, which prints only `null` on stdout, still says which
workspace it made: its method in api.ts has a `@reportsId <noun> <method>().<property>` tag
(`@reportsId workspace getMetadata().id`), which the generator records in the command table, and
the run pipelines that method on the capability, beside the chain, in the same session; its help
says so. Stdout holds only the last command's result. A provisional workspace (one with no chat
or edit yet, which `list-workspaces` leaves out) whose id was lost all the same is listed by
`list-provisional-workspaces`, with when it was created, to open or `delete-self`.

When the command meant next was taken for a positional the line left out (`open-workspace
get-metadata`), it says so instead, and names the line with the positional back in place, the
options typed kept (`cf-os api open-workspace <id> get-metadata`). So does a chain that goes on
after it (`open-workspace list-chats get-chat-history 1`), which fails, exit 2, rather than send
"list-chats" as the id; a positional typed after a `--` is taken as typed (`open-workspace --
list-chats get-chat-history 1`), and the error offers that `--` only where the positional can hold
the word (not a number, say). An unknown command or option fails, exit 2, naming the one most likely
meant, from the table's own names: a near name (`Did you mean --options?`; a name cut short,
`get-chat` for `get-chat-history`, ahead of a typo), or, for a command of another capability, the
line that reaches it (`list-chats is on Overseer: cf-os api open-workspace <id> list-chats`).
`--help` after any command prints the help of what was reached so far (after the line's
forgotten-positional error, if it has one), and a command returning a capability lists that
capability's commands too. After a command returning an untyped capability, `call <method>
[json-args...]` calls a method by name, unchecked. Each argument is read as a typed
`<text|json|@file|->` argument is ([Arguments](#arguments)): JSON, inline, from `@file` or from `-`
(stdin), and text that is not JSON is that string, but text that starts as JSON does (`{`, `[` or
`"`) and does not parse fails, exit 2, inline or from a file alike, since nothing says the method
takes text; quote such text, or a literal `@x` or `-`, as a JSON string (`'"@x"'`). An empty method
name, and a name the local stub answers itself, never sending it (Cap'n Web's `then`, `dup` and
`map`, and `Object.prototype`'s `toString`, `constructor`, `__proto__` and the rest), are no server
method: `call` refuses them, exit 2, nothing sent.

A command whose result is an object holding a capability in a top-level property (`→ ui: call` in
the listings, and a `Then:` block in its help) prints it as a value, but the chain may also go on to
that capability, by naming the property in kebab-case, read on the result in the same pipelined
call.

A gatekeeper's app UI is one, and typed: `get-gatekeeper-app <vendor> ui` goes on with the commands
of the interface the gatekeeper's package.json names (`"cloudflareOs": {"appApi":
"src/context-types.ts#ContextApi"}`), checked, with help, as any command is
([`packages/api-schema`](../api-schema/README.md#gatekeeper-app-uis)). Today that is `context`
(Skills, the Context gatekeeper: `ContextApi`) and `scheduler` (Scheduled Tasks:
`ScheduleManagementApi`). Both are ambient: an account has one once it opts in, and until then
`get-gatekeeper-app <vendor>` is null and the chain fails naming it. So provision first:

```sh
pnpm cf-os api provision-ambient-account context           # once per account; then it does nothing
pnpm cf-os api get-gatekeeper-app context ui --help        # its commands
pnpm cf-os api get-gatekeeper-app context ui list-enabled-context-collections
pnpm cf-os api get-gatekeeper-app context ui create-context-collection "My skills" "" private
pnpm cf-os api get-gatekeeper-app context ui create-context-skill <collectionId> my-skill/SKILL.md @skill.json
pnpm cf-os api get-gatekeeper-app context ui set-context-collection-everyone-can-view <collectionId> true
pnpm cf-os api provision-ambient-account scheduler
pnpm cf-os api get-gatekeeper-app scheduler ui list        # the account's scheduled tasks, every workspace's
```

`create-context-skill --help` gives the SKILL.md rules (YAML frontmatter with a lowercase-hyphen
`name` and a `description`); the `@skill.json` above holds `{"description": ..., "body": ...}`.
The table maps each such vendor id to its interface's node, prefixed with the vendor
(`context:ContextApi`), which is how `get-gatekeeper-app`'s method in api.ts says it (`@appApi ui
id`) and how `search` finds the app UIs' commands ("create a skill" finds `create-context-skill`).
The runtime never names a vendor: with any other vendor id the `ui` stays untyped, continued with
`call <method> [json-args...]`, which calls a method by its own camelCase name, unchecked; `call`
also still works on a typed one (`get-gatekeeper-app context ui call listEnabledContextCollections`).

A configurator's `ui` (`start-resource-configurator <accountId> <resourceUrlPattern>`,
`start-creation-configurator <accountId> <resourceUrlPattern>`) stays untyped, as its interface
differs per vendor and per resource type: its methods are its vendor's `*ConfiguratorUI` class in
`packages/gatekeeper-<vendor>/src/` (for email, `EmailMailboxConfiguratorUI.resourceUrl(emailName)`),
and the untyped help says so. In the Workshop the configurator's iframe hands back a URL
(`collectResourceUrl()`). A resource configurator's is the chosen resource URL, which the Workshop
passes to `open-workspace <id> new-gatekeeper <accountId> <resourceUrl>`. The CLI has no iframe, so
it makes that URL itself, in the form of the resource type's `urlPattern` (from the account's
`supportedResources`, which `subscribe-connected-accounts` lists), using the `ui`'s methods only to
look up what fills it; to answer an agent's connection request, pass the new gatekeeper's id to
`accept-connection-request`. A creation configurator's is no gatekeeper's resource URL but the
`configuration` of the creation's approval: `open-workspace <id> approve-action <actionId>
--creation '{"accountId": <accountId>, "configuration": "<url>"}'`.

A null result partway through a chain (`get-gatekeeper-app nosuch ui ...`, or `get-admin-api ...`
for a user who is no deployment admin) leaves the rest not run, so it fails, exit 1, printing
nothing on stdout and naming on stderr what returned null, when it is null, the command that was
not run and the help of the one that was null (`` `get-admin-api` returned null (the caller is not
a deployment admin; `am-i-admin` says whether it is): `set-signups-enabled` was not run. See `cf-os
api get-admin-api --help`. ``). When it is null is its method's `@nullWhen <text>` tag in api.ts,
which the generator records in the command table, method names written as the commands that call
them, and which the command's help says too (`It is null when ...`); a command without one is named
with its help alone. A chain that ends on a
nullable result prints the `null`, exit 0, and one that ends on a value holding capabilities prints
it and says on stderr how to go on to them. A typed capability is followed by its own commands:
`public start-gatekeeper-login <vendorId> attempt receive`. That sign-in can only be completed in a
browser, which holds the popup that confirms it, so in one CLI run `receive` returns `null`.

Connecting an account is the same: `connect-account`, `reconnect-account` and
`ensure-account-resources` return a `{url, nonce}` flow that only the Workshop can complete: the
ticket arrives only in the URL fragment of the handoff page the flow ends on, and that page redeems
it only with the nonce the Workshop stored in its own popup
([docs/connect-handoff.md](../../docs/connect-handoff.md)). Opened any other way, such as in a
plain browser tab, the URL ends on a handoff page that redeems nothing, so the CLI, though it
prints the nonce, never sees the ticket. Connect the account in the Workshop, signed in as the same
user, and the CLI then sees it in `subscribe-connected-accounts`. An auto-provisioned vendor needs
no flow: one the deployment enables is connected already, and one it offers
(`list-addable-gatekeepers`) is added with `provision-ambient-account <vendorId>`.

## Chatting with an agent

`new-chat` and `send-chat-message` start the agent's turn and return without waiting for it:
`new-chat` prints the chat's id, `send-chat-message` prints `null`. `wait-for-agent` waits for the
turn to end, the chat's `activeAgent` clearing (the turn finished, failed or was stopped, or paused
for the user's decision on an action), and prints the latest message the agent wrote, its reply,
as JSON (`null` if it has written none). `get-chat-history` then has the whole turn, its tool
calls and changes included.

```sh
pnpm cf-os api open-workspace <id> list-models                                 # the model ids
pnpm cf-os api open-workspace <id> new-chat "What is 17 times 23?" <modelId>   # prints the chat id
pnpm cf-os api open-workspace <id> wait-for-agent <chatId>                     # prints the reply
pnpm cf-os api open-workspace <id> send-chat-message <chatId> "And 17 times 24?" <modelId>
pnpm cf-os api open-workspace <id> wait-for-agent <chatId> --timeout-ms 600000
pnpm cf-os api open-workspace <id> get-chat-history <chatId>                   # the whole chat
```

On a chat with no turn running, `wait-for-agent` returns at once, so it can run as its own
command: by the time `send-chat-message` returns, the turn it started is recorded. It waits at most
an hour, or `--timeout-ms`; when that runs out with the agent still running it fails, exit 1
(`The agent was still running when the wait timed out.`), and the turn goes on: wait again, or
`stop-agent <chatId>`. A turn that paused on an action (`list-actions --options '{"filter":
"pending"}'`) goes on once the action is approved or rejected; wait again then. If the workspace
restarts during the wait, the call fails as a lost connection does, exit 1, and the turn resumes
by itself; wait again.

## Arguments

Required parameters are positional, in order; optional ones are flags named after them
(`--before-sequence`), or `--arg-<name>` where that would clash with one of `api`'s own. Booleans and
bigints are typed as they are. A string, ids included, is the token as typed: `@`, `-` and quotes
are part of it (`'"x"'` sends the quotes too), so a Workers AI model id goes as `list-models` gives
it (`retry-agent 1 @cf/zai-org/glm-5.2`), and `set-title @home` sets the title "@home"; the help
of a command that takes one says so. To set one from a file, let
the shell read it (`set-title "$(cat title.txt)"`); `@file` and `-` are read only where the help
says so (`<text|json|@file|->` and the like, below). Where the type admits null (`string | null`),
the bare `null` passes null (`set-preferred-model null`). One of a fixed set of values
(`busy|calm`) is typed as it is. A number is a decimal (`3`, `-2.5`, `1e3`) that a double holds as
typed: hex, `Infinity` and digits a double would drop (`9007199254740993`) fail, exit 2, rather
than be sent changed, and so does a whole number past `Number.MAX_SAFE_INTEGER` (`9007199254740992`,
`1e21`), which the server cannot tell from its neighbours; a number inside JSON (an object
argument, an answer, a `call` argument) is held to the same rule. A date is ISO 8601, a day
(`2026-01-31`, midnight UTC) or a day and time with its zone (`2026-01-31T12:00:00Z`,
`...T12:00+02:00`, `+0200` or `+02`; RFC 3339's `2026-01-31 12:00:00Z` and lowercase `t` and `z`
too): a time without one, which would be read in whatever zone the CLI runs in, and a day that does
not exist (`2026-02-30`) fail. Objects and arrays
are JSON, inline, from `@file` or from `-` (stdin), and may nest at most 128 levels deep. Where a
string is one of the types (a chat message: `<text|json|@file|->` in the help, which explains it),
text that is not JSON is that string, inline or from a file or stdin alike: `new-chat hello null`
sends "hello", and `new-chat @message.txt null` the file's text, less its final line ending. A file
or stdin that is empty, or holds only whitespace, fails, exit 2, rather than send empty text: an
empty stdin or a failed redirect is the likelier cause (an inline `''` is the empty string). Text
that starts as JSON does (`{`, `[` or `"`) but does not parse is text too, inline or from a file:
`new-chat '[WIP] look' null` sends "[WIP] look", so JSON meant for such an argument goes as text if
it is broken. Text that starts with `@`, is `-` or is JSON (`42`, `true`) has to be quoted as a
JSON string (`'"@alice"'`, or a file's through `jq -Rs .`), and JSON that is none of the argument's
types (`new-chat 42 null`) fails saying so and how to send it as text; an `@` token that names no file (nothing,
or a directory, as a lone `@` does) fails saying so and how to type it as that string, rather than
be sent as typed, as a mistyped file name would otherwise go as the text. A file or stdin read as JSON or text
must be UTF-8. Bytes are `@file`, `-` or `{"base64": "..."}`, and a stream is
`@file` too (or a bare path), or `-`. Relative paths (`@file`, `--out`, a stream's file) resolve
against the directory the command was typed in, also through `pnpm -w`. A file that cannot be read,
a stream's included, fails before connecting, dry runs too. JSON that does not parse fails saying
where (`--options is not valid JSON: unexpected character at line 1, column 1.`), and JSON of the
wrong type naming where and what was wanted (`--config.n must be number; got a string.`): neither
quotes what was read, which may be a file's secrets, where an inline value is quoted.

An option's value is the next token unless that reads as an option (`--x`, or `-h`), so
`--note --dry-run` fails saying `--note` needs a value, rather than send a note "--dry-run"; such a
value is written `--note=--dry-run`. A single dash is a value (`--limit -1`). `--` makes the one
token after it an argument or a command, even one that reads as an option, so
`set-title -- --dry-run` sets the title "--dry-run", for real. Each such token takes its own `--`
(`call m -- --a -- --b`; `call m -- call` passes "call"), and the tokens after it are read as
usual, so a later command's options are still its options: `create-gadget -- export export md --chat-id 3` makes a gadget titled
"export", then exports it.

JSON arguments and answers are checked against their declared type before anything is sent. A
value of the wrong type fails with exit 2, naming the type expected and where: a flag by its name
(`connect-account google --resource-url-patterns false` fails with
`--resource-url-patterns must be string[]; got false.`), a positional argument as the usage line
writes it (`open-workspace g1 revoke-share-link L1 false`: `<keepUsers> must be string[]; got false.`),
and a property by its path (`<note>.id must be number; got "x".`). Properties left out are not
checked; the instance judges those.

A command's help gives each argument's declared type, an object or union type spelled out with
its fields, and, on the line under it, the first sentence of the doc of each named type the
argument is declared as (`CollaboratorRole: The level of access a collaborator (or share key)
grants.` under `add-collaborator`'s `<role>`), and, for a JSON argument that may hold secrets, a
line naming where (`Secrets in it: apiToken, extraHeaders.` under `add-model`'s `<config>`; see
[Secrets and `--dry-run`](#secrets-and---dry-run)). The whole docs, the fields' included, are in
[`types`](#types-and-create-account).

## Results, events and streams

The result is printed as JSON on stdout: bigints as decimal strings, bytes as `{"base64": "..."}`,
dates as ISO strings, and a capability inside it as `{"$capability": true}`. A `subscribe-*` command
prints each event as a line `{"event": "<method>", "args": {"<parameter>": ...}}`, its arguments
keyed by parameter name (answering the server's call only once the line is taken, so a slow reader
holds the events back rather than piling them up in memory), until `--timeout <seconds>` (exit 0),
Ctrl-C (exit 130) or its reader going away (`| head -n 1`, exit 0), and then unsubscribes. A reader
that has gone is noticed only when the next event is written to it, as nothing tells a process that
the far end of its stdout closed while it writes nothing: a quiet subscription piped to `head` runs
on until its next event, so pair the pipe with `--timeout`
(`open-workspace <id> subscribe-to-metadata --timeout 10 | head -n 1`). Any other command given
`--timeout` fails when it runs out. `--timeout` is at most 2147483 seconds (about 24 days, what a
timer holds); a larger or non-finite one fails, exit 2, and leaving it out sets no limit. A returned
byte stream goes to `--out <file|->`, or to stdout when that is not a terminal; a parameter that
takes one reads `@file`, a bare path or `-`. A byte
value (`get-avatar`, `get-chat-attachment-content`) is printed as `{"base64": "..."}`, or with
`--out <file|->` written there decoded; a null one writes nothing and prints `null`. Any other
command given `--out` fails before connecting, exit 2, dry runs included, and so does an `--out` that
cannot be written: a directory, a file in a directory that does not exist, a path the file system
cannot resolve (a name too long, a loop of links), or an empty value. A link is checked where it points.
Everything the chain made is released when it ends, however it ends. Every message is on stderr.

The exit codes:

| Code | Means |
| --- | --- |
| 0 | Success, including a subscription ended by `--timeout` or by its reader going away (noticed at its next event). |
| 1 | A failure once the call was sent (`API call failed. <message>`), an instance that could not be reached, a null partway through a chain, which left a later command not run, or a `cf-os` command that is not `api`. |
| 2 | The command must change before it runs again. Either nothing was sent: a usage error, a wrong-typed value, a file or `--out` that cannot be read or written, a credential missing from the environment, or no instance to call. Or the server asked a question the command did not answer, and the CLI refused it ([Answers](#answers---answer)); then the call that asked was sent, so `open-workspace` with `--share-key` may already have redeemed the key. |
| 130 | Ctrl-C. |

pnpm prints its `$ node ...` line on stderr, and adds an `[ELIFECYCLE] Command failed` line on stdout
after a failure, the short `pnpm -s` included (pnpm 11, whose long `--silent` adds neither), so read
stdout as a result only on exit 0. For a stdout that holds the result alone, and a stderr that holds
only the CLI's messages, run the entry directly: `node packages/api-cli/src/main.ts api ...` from
the repository root, once `pnpm cf-os` (or `node packages/api-schema/scripts/generate.ts
--if-stale`) has generated its commands for this checkout's API (in a cloudflare-os-starter,
`pnpm exec cf-os api ...`).

## Answers (`--answer`)

Most callbacks a command passes are events: the server calls them and expects nothing back. A
callback method that returns a value is a question instead: the server waits for the client's
answer before it goes on. `--answer <Callback>.<method>=<json|@file|->` gives that answer, once per
method, anywhere on the command line; a command's help lists the methods it may be asked under
**Answers**, with the type each returns. The answer is checked and revived against that type, as a
JSON argument is, before anything is sent. It answers the method's **first** call, and stderr logs
what that call asked: `Answered <Callback>.<method> from --answer; it asked: <JSON>`.

Without an answer the call is refused: the CLI stops and exits 2, printing what was asked as one
JSON line and the flag to rerun with. A later call of the same method is refused the same way, with
what it asked.

`open-workspace` asks `ObserverConfigCallback.configure` of a collaborator whose bindings lack a
working account choice: one who has not chosen connected accounts for a workspace yet, and one whose
saved choice fails verification, such as an account since disconnected or one the Gatekeeper
refuses. It gets `needs`, one per Gatekeeper binding that still needs an account, each with
`gatekeeperId`, `vendorId`, `resourceTitle`, `resourceUrl` when there is one, and, for a binding
asked about because its choice just failed, `failure`, saying why. That can be the first call: a
returning collaborator's saved choice fails before anything else is asked. An answer whose account
then fails is asked about again the same way, which the CLI refuses. Either way, fix the account
or choose another, and rerun with an answer the first call accepts. It returns
`ObserverAccountChoice[]`,
`{ accountId: number; gatekeeperId: number }` for each. The account ids are the collaborator's
connected accounts': the `id` of each `add` event that
`pnpm cf-os api subscribe-connected-accounts --timeout 5` prints. So the first open fails, saying
what it needs:

```console
$ pnpm cf-os api open-workspace <id> get-metadata
ObserverConfigCallback.configure asked for an answer, and the command gave none (--answer), so cf-os api refused it and stopped. It asked:
{"needs":[{"gatekeeperId":3,"vendorId":"google","resourceTitle":"Inbox"}]}
Run the command again with --answer 'ObserverConfigCallback.configure=<json|@file|->', the JSON of type ObserverAccountChoice[], where ObserverAccountChoice = { accountId: number; gatekeeperId: number }.
```

and the rerun answers it:

```sh
pnpm cf-os api open-workspace <id> get-metadata --answer 'ObserverConfigCallback.configure=[{"gatekeeperId": 3, "accountId": 7}]'
```

A `--dry-run` shows the decoded answers as `answers`, beside the chain.

## `types` and `create-account`

`types [<service>]` prints the API as TypeScript declarations, for an agent writing code against it
rather than walking commands: everything a signed-in session (`AuthenticatedApi`) can call, without
the credential methods, or one service's declarations alone, other services referred to by name
(`types --help` lists the services). They are cloudflare-os's own agent declarations
(`packages/api-schema/generated/workshop-api.agent.d.ts` and its fragments), printed as plain text,
with api.ts's JSDoc on its interfaces, methods, types and fields, and it connects to nothing.
`types <vendor>` (`types context`) prints a gatekeeper app UI's declarations instead
(`packages/api-schema/generated/gatekeeper-apps/<vendor>.d.ts`).

`create-account <username> [--display-name <name>]` makes a password account through
`PublicApi.createAccount`, as the frontend's sign-up page does, for an agent testing against a local
or test instance that needs users to act as ("add bob to the workspace and check what he sees"). A
deployment refuses it from the CLI ([Deployment admins only](#deployment-admins-only)), and so does
an instance with signups or password sign-in off. The password is `CFOS_API_PASSWORD`, hashed as
password sign-in hashes it, so `--username <username>` with the same `CFOS_API_PASSWORD` then signs
in as the new user. The display name defaults to the username. It signs nothing in, prints
`{"username", "displayName"}` (never the session token the call returns), and fails naming the
instance's refusal: signups closed, password sign-in off, the name taken or invalid.
Its default instance is the same as every command's.
`--url`, `--auth` (`access` or `token`; with `token`, for an `https://` instance not behind Access,
it needs no `CFOS_API_TOKEN`, as no one signs in), `--timeout` and `--dry-run` work as for any
command, and the dry run shows `{"$passwordHash": "CFOS_API_PASSWORD"}` where the hash would go.
The other API options do not apply, so each fails, exit 2, saying why: `--username` (it signs in as
no one, and the new account's name is the `<username>` argument), `--answer` (its call asks nothing
back) and `--out` (it prints JSON). `search` finds it,
and the sign-in flags, for tasks such as "create a test user" or "act as another user".

`search`, `types` and `create-account` read their options as a generated command reads its own, so
an unknown option fails, exit 2, saying the nearest (`Unknown option --displayname for
create-account. Did you mean --display-name?`), an option missing its value or followed by another
says so (`write --display-name=--dry-run if that is the value`), and a `--` lets through the one
token after it. `search` and `types` take the API options and ignore them, as they connect to
nothing.

## The instance and signing in

The instance is `--url <origin>`, an `https://` one, or `http://` for a local instance only
(`localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`): anywhere else a sign-in would carry its token
or password hash in plain text, so `http://` fails, exit 2, naming the `https://` origin to use.
Without it, it is `CFOS_API_URL` when that is set. Else, when
`CFOS_API_URL_UNAVAILABLE` is set, there is none: a run that needs one fails with exactly that
variable's text, exit 2. Else it is `http://localhost:8787`, where `pnpm dev-server` listens. Empty
values count as unset. A caller such as cloudflare-os-starter's `cf-os` sets one of the two
variables, so it never falls back to localhost. Only runs that call the instance need it, dry runs
included, as they print its URL; `search`, `types` and every `--help` never do. `--help`'s `--url`
line says which default applies where it runs, showing `CFOS_API_URL` as its origin alone, so
credentials or a query in it are never printed. An instance that cannot be reached fails, exit 1,
with the cause (`connect ECONNREFUSED ::1:8799`) and the next step. When nothing is there (nothing
listening, no such host, or nothing accepting a connection), that is to start a local one
(`pnpm dev-server`), else to check it is up, or to name another with `--url`. When something is
listening but does not answer, a plain-text probe of the port, which sends no credentials, says
what is likely instead: an `https://` origin whose port answers plain HTTP (with a status other than
the 400 or redirect a TLS server may give a plain request) is a server that speaks `http://` (`localhost:8787 answers plain HTTP, not HTTPS. Use --url http://localhost:8787.`), said
as soon as the probe finds it, and anything else is an instance that is slow or hung, or another
server. The same holds in Access mode when `cloudflared access token` cannot reach the origin, or
its TLS handshake with it fails, which it says before a WebSocket is tried: unless cloudflared says
nothing is there, the probe says why, and a certificate cloudflared refuses is said at once, not as
a missing login. Node's WebSocket gives up on connecting, and on a TLS handshake, after 10 seconds, and the
diagnosis then waits up to 10 more for its own request, so a silent `https://` port fails after
about 20 seconds; a server that accepts the WebSocket's request and never answers it is bounded only
by `--timeout`. A port that answers a TLS handshake with something other than TLS fails at once,
saying it does not speak TLS; one whose certificate Node refuses (self-signed, expired, for another
host) says so, and how to trust a local instance's own (`NODE_EXTRA_CA_CERTS`); and any other failed
handshake is named as one, not as a hung instance.

The instance's API is the WebSocket at `wss://<host>/api` (`ws://` for an `http://` origin). The
sign-in is `--auth <mode>`, or, without it, `password` when `--username` is given, `token` when
`CFOS_API_TOKEN` is set or the origin is `http://` (Access fronts only `https://` origins, and
`--auth access` refuses an `http://` one), and `access` otherwise:

| Mode | Credential | For |
| --- | --- | --- |
| `access` | A Cloudflare Access token: `CF_ACCESS_TOKEN`, else what `cloudflared access token -app=<origin>` prints once `cloudflared access login <origin>` has run. It is sent with the instance's own Origin, and the session signs in as the Access identity | An instance behind Access, as the starter deploys it |
| `token` | `CFOS_API_TOKEN`, an auth token, the kind a password sign-in returns and the frontend keeps | A dev server, a test harness |
| `password` | `--username <name>` and `CFOS_API_PASSWORD`, hashed as the frontend hashes it | A dev server, a test harness |

## Deployment admins only

Every request the CLI makes sends `User-Agent: cf-os-api/<version>` (`USER_AGENT` in
`src/session.ts`, this package's version). The Workshop recognises it on `/api`, and unless the
instance is a local dev one it lets that session act only as a deployment admin, a user its `ADMINS`
names: a sign-in, by password, token or Access, as anyone else is refused, and so is every call that
signs no one in (`create-account`, and the `public` commands except the sign-in steps
`start-gatekeeper-login` and `confirm-login`, whose result `authenticate` then refuses). Each refusal
fails, exit 1, with
`On this deployment the cf-os CLI is limited to deployment admins (anything goes on a local dev server).`
The browser and every other client are unaffected. To use the CLI on a deployment, sign in as one of
its admins: behind Access, `cloudflared access login <origin>` as an admin's identity.

A local dev instance is one whose backend has `LOCAL_DEV_INSTANCE` set, which only `pnpm dev-server`
and the integration harness set; a deployment must never set it. There the CLI may sign in as
anyone, but that lifts only this check: a user is a deployment admin, for `am-i-admin` and
`get-admin-api`, only when `ADMINS` names them, and `pnpm dev-server` (`scripts/run-dev-server.ts`)
sets it to `["admin"]`. So to act as an admin there, make that account and sign in as it:

```sh
CFOS_API_PASSWORD=... pnpm cf-os api create-account admin
CFOS_API_PASSWORD=... pnpm cf-os api --username admin am-i-admin   # true
```

Signing in through a gatekeeper (`public start-gatekeeper-login <vendorId>`) is off unless the
backend's `AUTH_GATEKEEPERS` lists the vendor, which `pnpm dev-server` passes through from its shell,
with the gatekeeper's OAuth app credentials (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, ...):
`AUTH_GATEKEEPERS=google pnpm dev-server`. See [docs/oauth-signin.md](../../docs/oauth-signin.md).
It completes only in a browser ([Finding and chaining commands](#finding-and-chaining-commands)).

This is a speed bump against casual use, not a boundary: any client can send any User-Agent, or
none, and an admin signed in through the CLI may do no more than in a browser. What a session may do
is decided by the API's own checks, as for every client.

## Secrets and `--dry-run`

Secrets come from the environment or `cloudflared`, never from the command line, and the methods
that take credentials (`PublicApi`'s sign-in methods, `change-password`) are not commands: a
generated command would take the secret from argv. The one exception is `create-account`, written
by hand rather than generated, which reads its password from `CFOS_API_PASSWORD` as password
sign-in does, because testing against a local instance needs accounts to act as. When the
connection does not open, a plain request to the same URL says why: an Access refusal or redirect
names `cloudflared access login <origin>`. A credential the sign-in needs and the environment lacks
(`CFOS_API_TOKEN`, `CFOS_API_PASSWORD`, an Access token) fails, exit 2, before anything is sent;
but when `cloudflared` could not reach the origin to look its token up, the instance could not be
reached, exit 1, as in the other modes.
`--dry-run` prints `{"url", "auth", "on", "chain"}`, and `answers` when any are given: the calls
with their decoded arguments, and runs nothing. A call that reports the id of what it creates
carries `reportsId`, `{"method", "property"}`: the method also called on its result, beside the
chain, and the property of that call's result printed (`new-workspace`'s `{"method": "getMetadata",
"property": "id"}`). It connects to nothing, runs no `cloudflared` and hashes no password, and
`auth` is only the mode and any username. The arguments, and the `--answer`s, are printed as
decoded, but for the secrets in them: api.ts marks an object property (or a named type) that holds
one with a `@secret` JSDoc tag, the generator records each path to one in the command table, and the
dry run prints `{"$secret": true}` in place of each leaf of the value there, keeping its shape. So
`add-model`'s config prints its `apiToken` as `{"$secret": true}` and its `extraHeaders` with their
names and each value `{"$secret": true}` (a `null`, which keeps a stored value, stays `null`); where
a type nests in itself, a nested value of it whose type holds a secret is redacted whole. The call
itself sends the values as given. The command's help names the secrets an argument may hold. Pass
such an argument from `@file` or `-`, which keeps the secrets out of the command line and shell
history. A method's own parameter cannot be marked, a parameter's JSDoc being its `@param` text, so
a dry run prints one as typed (`open-workspace`'s `--share-key`), as the command line already holds
it.

## Generated files

`generated/commands.ts` (the command table, the gatekeeper app UIs' nodes included) and
`generated/agent-types.ts` (a copy of the agent declarations and the app UIs', for `types`) are
not committed, and never edited. `packages/api-schema/scripts/generate.ts` writes them in the same
step as `packages/api-schema/generated/`, rendered by `generator/emit.ts`, which is pure: every
per-method decision is made there. Everything that runs the CLI or reads them generates them first
with `--if-stale`, which does so only when api.ts, a gatekeeper app UI or the generator has changed
since the last generation ([api-schema's Generating](../api-schema/README.md#generating)): the root
`pnpm cf-os`, this package's `build` and `test` tasks (through `@gadgets/api-schema#generate`) and
its `test:run`. An API change the CLI cannot represent fails the generation, naming the method: an
untyped capability parameter, a `WritableStream`, a callback method returning a capability or a
stream, or a required function returning a value. `pnpm build` and `pnpm lint` run the generation,
so CI fails on one.

## Tests

The suites run on `node:test`, as `scripts/`' do:

```sh
pnpm exec vp run -F @gadgets/api-cli test   # cached, under the test watchdog
pnpm --filter @gadgets/api-cli test:run     # direct
node --test packages/api-cli/src/<file>.test.ts
```

After an intentional change to the emitter, refresh the fixture table with
`API_CLI_UPDATE_FIXTURES=1 node --test packages/api-cli/generator/emit.test.ts` and review the
diff. `src/test-server.ts` serves the fixture API, and a sliver of the real one, in process.

## Running it from another repository

cloudflare-os-starter's `cf-os api` is to run this CLI from its `cloudflare-os` submodule, replacing
its own copy. Any caller follows the same contract:

- **Entry.** `node <checkout>/packages/api-cli/src/main.ts api <tokens>`, in the starter
  `cloudflare-os/packages/api-cli/src/main.ts`, run with the caller's Node and stdio inherited. It
  is spawned, never imported, and needs no build step: Node runs the TypeScript sources. Its
  commands are generated, though, and not committed: before every run the caller spawns
  `node <checkout>/packages/api-schema/scripts/generate.ts --if-stale` the same way, which writes
  them when the checkout has none or they are stale, prints nothing on stdout, and returns at once
  otherwise. On a nonzero exit the caller stops with that exit code, the generator having said why
  on stderr.
- **Before spawning**, the caller checks that the entry exists. A pin from before this package has
  none: say that the pin predates `cf-os api` upstream, and name `cf-os update`. It also checks
  that the checkout's workspace is installed for this pin, as the starter's `cf-os install --check`
  does, failing with its ``Run `pnpm cf-os install`.`` message. Otherwise Node cannot load
  capnweb, and every run, `--help` included, dies with `ERR_MODULE_NOT_FOUND`.
- **Tokens.** Everything after `api`, minus the caller's own global options (the starter's
  `--config`, `--account` and `--profile`, which no generated flag may take).
- **Environment.** Exactly one of two variables, the other deleted from the child's environment.
  Either `CFOS_API_URL=<origin>`, the default instance (in the starter, its deployment's public
  origin), or `CFOS_API_URL_UNAVAILABLE=<reason>`, why there is none. This CLI holds
  `CFOS_API_URL` only to what it holds `--url` to: `http://` is accepted for a local instance (a dev
  server on another port), refused for any other host, and a path is dropped. A caller that names a deployment checks that its origin is
  `https://` and exactly an origin before setting `CFOS_API_URL`, as the starter's deploy checks
  `publicBaseUrl`, and otherwise sets the reason instead, such as
  `deployment.jsonc's public origin, http://os.example.com, is not an https:// origin: fix publicBaseUrl, or pass --url.`:
  `ws://` and a plain-text token are for an explicit `--url`. The reason is a complete
  message that names `--url`, such as
  `deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.`. Any run
  that needs an instance and has no `--url` prints it alone and verbatim, exit 2, and `--help` shows
  it on its `--url` line. Deleting the other variable matters: a `CFOS_API_URL` inherited from the
  shell would otherwise win over the reason. In a starter, `--url` is how to name another instance.
  Inherited as usual: `CFOS_API_TOKEN`, `CFOS_API_PASSWORD`, `CF_ACCESS_TOKEN`, and `PATH` (for
  `cloudflared`).
- **cwd.** Where relative paths (`@file`, `--out`, stream files) resolve.
- **Exit codes.** 0, 1, 2 and 130, passed through.
- **Help.** The caller's `cf-os api --help` is this CLI's. Its `--url` line reflects the environment
  above, and the caller documents its own options (the starter's `--config`) in its own help.
  Messages say `cf-os api ...`.
- **Requirements.** Node >= 24.19 and the checkout's workspace install, nothing else. The runtime
  imports only node builtins, capnweb and hash-wasm (`src/main.test.ts` checks), so a caller's
  published package never reaches `@gadgets/*`; the generator also needs the workspace's
  `typescript6`, which that install holds.
- **Commands.** Always the checkout's: the generator writes `generated/` from the checkout's API
  before the run.
