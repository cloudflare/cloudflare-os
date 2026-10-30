# `@gadgets/api-cli`: `pnpm cf-os api`

`pnpm cf-os api` calls a running instance's [Cap'n Web](https://github.com/cloudflare/capnweb) API,
the one its frontend uses, so an agent can list workspaces, read chats, approve actions and open
Gatekeeper sessions without a browser. Run it from the repository root (`pnpm -w cf-os api ...`
from a package directory). Its commands are not written by hand: they are generated from
`packages/workshop-shared/src/api.ts` through [`packages/api-schema`](../api-schema/README.md)
([cloudflare/cloudflare-os#860](https://github.com/cloudflare/cloudflare-os/pull/860)), so they are
always this commit's API.

[cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)'s own `cf-os api` is
to run this same CLI from its submodule, in place of the copy it ships today (see
[Running it from another repository](#running-it-from-another-repository)).
In cloudflare-os, `cf-os` has only `api`; its other commands (`init`, `check`, `deploy`, `update`,
...) are the starter's, and here they fail saying so (exit 1).

```sh
pnpm cf-os api search "list chats"                         # the commands for a task, whole command lines as JSON (connects to nothing)
pnpm cf-os api --help                                      # the commands there are once signed in (connects to nothing)
pnpm cf-os api whoami                                      # who the session signed in as
pnpm cf-os api list-gadgets                                # the workspaces
pnpm cf-os api open-gadget <id> get-chat-history <chatId>  # a chain: open-gadget returns the workspace
pnpm cf-os api open-gadget <id> list-actions --options '{"filter": "pending"}'
pnpm cf-os api open-gadget <id> approve-action <actionId>  # acts on the instance, like the button
pnpm cf-os api open-gadget <id> subscribe-to-chat --timeout 60  # events, one JSON line each, for a minute
pnpm cf-os api public get-server-config                    # PublicApi, without signing in
pnpm cf-os api types Overseer                              # a service as TypeScript declarations (connects to nothing)
pnpm cf-os api open-gadget <id> get-chat-history <chatId> --dry-run  # the calls, as JSON; connects to nothing
CFOS_API_PASSWORD=... pnpm cf-os api create-account bob    # a user to act as on `pnpm dev-server`, the default instance
CFOS_API_PASSWORD=... pnpm cf-os api --username bob whoami # signed in as bob
pnpm cf-os api --url https://os.example.com whoami         # another instance: behind Access, CF_ACCESS_TOKEN or cloudflared
pnpm cf-os api open-gadget <id> get-metadata --answer 'ObserverConfigCallback.configure=[{"gatekeeperId": 3, "accountId": 7}]'
                                                           # a collaborator's first open, choosing the connected account
```

## Finding and chaining commands

`search "<task>"` is where to start: it ranks the commands by the task's words and prints the best
five as JSON, `[{"command", "summary"}]`, each a whole command line from `cf-os api` with a
placeholder for every argument along the way. Commands are the API's methods in kebab-case,
starting from what a signed-in session gets (`AuthenticatedApi`); a leading `public` starts from
`PublicApi` instead, without signing in.

A command that returns a capability (`→ Overseer` in the listings) goes on to the next command, on
it, and the whole chain is sent at once, pipelined in one session. A chain that ends on a
capability sends nothing: `cf-os api new-gadget` creates no workspace, and fails saying so and
naming a way to finish it (`cf-os api new-gadget get-metadata`). `--help` after any command prints
the help of what was reached so far, and a command returning a capability lists that capability's
commands too. After a command returning an untyped capability, `call <method> [json-args...]` calls
a method by name, unchecked.

## Arguments

Required parameters are positional, in order; optional ones are flags named after them
(`--before-sequence`), or `--arg-<name>` where that would clash with one of `api`'s own. Numbers,
booleans, bigints and ISO 8601 dates are typed as they are; objects and arrays as JSON, inline, from
`@file` or from `-` (stdin); where a string is one of the types (a chat message: `<text|json|@file|->`
in the help), a word that is not JSON is that string, so `new-chat hello null` sends "hello", but
text that starts with `@`, is `-` or is JSON (`42`, `true`) has to be quoted as a JSON string
(`'"@alice, look"'`); bytes as `@file`, `-` or `{"base64": "..."}`. Relative paths (`@file`, `--out`,
a stream's file) resolve against the directory the command was typed in, also through
`pnpm -w`.

JSON arguments and answers are checked against their declared type before anything is sent. A
value of the wrong type fails with exit 2, naming the type expected and where: a flag by its name
(`connect-account google --resource-url-patterns false` fails with
`--resource-url-patterns must be string[]; got false.`), a positional argument as the usage line
writes it (`open-gadget g1 revoke-share-link L1 false`: `<keepUsers> must be string[]; got false.`),
and a property by its path (`<note>.id must be number; got "x".`). Properties left out are not
checked; the instance judges those.

## Results, events and streams

The result is printed as JSON on stdout: bigints as decimal strings, bytes as `{"base64": "..."}`,
dates as ISO strings, and a capability inside it as `{"$capability": true}`. A `subscribe-*` command
prints each event as a line `{"event": "<method>", "args": {"<parameter>": ...}}`, its arguments
keyed by parameter name (answering the server's call only once the line is taken, so a slow reader
holds the events back rather than piling them up in memory), until `--timeout <seconds>` (exit 0),
Ctrl-C (exit 130) or its reader going away (`| head -n 1`, exit 0), and then unsubscribes; any other
command given `--timeout` fails when it runs out. A returned byte stream goes to `--out <file|->`,
or to stdout when that is not a terminal; a parameter that takes one reads a file or `-`.
Everything the chain made is released when it ends, however it ends. Every message is on stderr.

The exit codes:

| Code | Means |
| --- | --- |
| 0 | Success, including a subscription ended by `--timeout` or by its reader going away. |
| 1 | A failure of the call (`API call failed. <message>`), or a `cf-os` command that is not `api`. |
| 2 | The command must change before it runs again. Either nothing was sent: a usage error, a wrong-typed value, or no instance to call. Or the server asked a question the command did not answer, and the CLI refused it ([Answers](#answers---answer)); then the call that asked was sent, so `open-gadget` with `--share-key` may already have redeemed the key. |
| 130 | Ctrl-C. |

pnpm prints its `$ node ...` line on stderr, and may add an `ELIFECYCLE` line on stdout after a
failure, so read stdout as a result only on exit 0 (`pnpm --silent cf-os api ...` leaves both out).

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

`open-gadget` asks `ObserverConfigCallback.configure` of a collaborator whose bindings lack a
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
$ pnpm cf-os api open-gadget <id> get-metadata
ObserverConfigCallback.configure asked for an answer, and the command gave none (--answer), so cf-os api refused it and stopped. It asked:
{"needs":[{"gatekeeperId":3,"vendorId":"google","resourceTitle":"Inbox"}]}
Run the command again with --answer 'ObserverConfigCallback.configure=<json|@file|->', the JSON of type ObserverAccountChoice[], where ObserverAccountChoice = { accountId: number; gatekeeperId: number }.
```

and the rerun answers it:

```sh
pnpm cf-os api open-gadget <id> get-metadata --answer 'ObserverConfigCallback.configure=[{"gatekeeperId": 3, "accountId": 7}]'
```

A `--dry-run` shows the decoded answers as `answers`, beside the chain.

## `types` and `create-account`

`types [<service>]` prints the API as TypeScript declarations, for an agent writing code against it
rather than walking commands: everything a signed-in session (`AuthenticatedApi`) can call, without
the credential methods, or one service's declarations alone, other services referred to by name
(`types --help` lists the services). They are cloudflare-os's own agent declarations
(`packages/api-schema/generated/workshop-api.agent.d.ts` and its fragments), printed as plain text,
and it connects to nothing.

`create-account <username> [--display-name <name>]` makes a password account through
`PublicApi.createAccount`, as the frontend's sign-up page does, for an agent testing against a local
or test instance that needs users to act as ("add bob to the workspace and check what he sees"); a
deployment usually signs users in through Access, and refuses it then, or with signups or password
sign-in off. The password is `CFOS_API_PASSWORD`, hashed as password sign-in hashes it, so
`--username <username>` with the same `CFOS_API_PASSWORD` then signs in as the new user. The display
name defaults to the username. It signs nothing in, prints `{"username", "displayName"}` (never the
session token the call returns), and fails naming the instance's refusal: signups closed, password
sign-in off, the name taken or invalid. Its default instance is the same as every command's.
`--url`, `--auth` (`access` or `token`; with `token`, for an `https://` instance not behind Access,
it needs no `CFOS_API_TOKEN`, as no one signs in) and `--dry-run` work as for any command, and the
dry run shows `{"$passwordHash": "CFOS_API_PASSWORD"}` where the hash would go. `search` finds it,
and the sign-in flags, for tasks such as "create a test user" or "act as another user".

## The instance and signing in

The instance is `--url <origin>`. Without it, it is `CFOS_API_URL` when that is set. Else, when
`CFOS_API_URL_UNAVAILABLE` is set, there is none: a run that needs one fails with exactly that
variable's text, exit 2. Else it is `http://localhost:8787`, where `pnpm dev-server` listens. Empty
values count as unset. A caller such as cloudflare-os-starter's `cf-os` sets one of the two
variables, so it never falls back to localhost. Only runs that call the instance need it, dry runs
included, as they print its URL; `search`, `types` and every `--help` never do. `--help`'s `--url`
line says which default applies where it runs.

The instance's API is the WebSocket at `wss://<host>/api` (`ws://` for an `http://` origin). The
sign-in is `--auth <mode>`, or, without it, `password` when `--username` is given, `token` when
`CFOS_API_TOKEN` is set or the origin is `http://` (Access fronts only `https://` origins, and
`--auth access` refuses an `http://` one), and `access` otherwise:

| Mode | Credential | For |
| --- | --- | --- |
| `access` | A Cloudflare Access token: `CF_ACCESS_TOKEN`, else what `cloudflared access token -app=<origin>` prints once `cloudflared access login <origin>` has run. It is sent with the instance's own Origin, and the session signs in as the Access identity | An instance behind Access, as the starter deploys it |
| `token` | `CFOS_API_TOKEN`, an auth token, the kind a password sign-in returns and the frontend keeps | A dev server, a test harness |
| `password` | `--username <name>` and `CFOS_API_PASSWORD`, hashed as the frontend hashes it | A dev server, a test harness |

## Secrets and `--dry-run`

Secrets come from the environment or `cloudflared`, never from the command line, and the methods
that take credentials (`PublicApi`'s sign-in methods, `change-password`) are not commands: a
generated command would take the secret from argv. The one exception is `create-account`, written
by hand rather than generated, which reads its password from `CFOS_API_PASSWORD` as password
sign-in does, because testing against a local instance needs accounts to act as. When the
connection does not open, a plain request to the same URL says why: an Access refusal or redirect
names `cloudflared access login <origin>`. `--dry-run` prints `{"url", "auth", "on", "chain"}`, and
`answers` when any are given: the calls with their decoded arguments, and runs nothing. It connects
to nothing, runs no `cloudflared` and hashes no password, and `auth` is only the mode and any
username.

## Generated files

`generated/commands.ts` (the command table) and `generated/agent-types.ts` (a copy of the agent
declarations, for `types`) are committed and never edited. `pnpm api-schema:generate` writes them
in the same step as `packages/api-schema/generated/`, rendered by `generator/emit.ts`, which is pure:
every per-method decision is made there. `pnpm api-schema:check` (part of `pnpm lint`, and CI) fails
while they are stale. An API change the CLI cannot represent fails the generation, naming the
method: an untyped capability parameter, a `WritableStream`, a callback method returning a
capability or a stream, or a required function returning a value.

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
  is spawned, never imported, and needs no build step: Node runs the TypeScript sources.
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
  `CFOS_API_URL` only to what it holds `--url` to: `http://` is accepted (a dev server on another
  port) and a path is dropped. A caller that names a deployment checks that its origin is
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
  published package never reaches `@gadgets/*`.
- **Commands.** Always the checkout's: `generated/` is committed with the API it describes.
