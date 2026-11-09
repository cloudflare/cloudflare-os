# `@gadgets/api-cli`: `pnpm cf-os api`

`pnpm cf-os api` calls a running instance's [Cap'n Web](https://github.com/cloudflare/capnweb) API,
the one the Workshop frontend uses, so an agent can drive workspaces, chats, actions and gatekeepers
from the command line. Its commands are generated from `packages/workshop-shared/src/api.ts` by
[`packages/api-schema`](../api-schema/README.md), so they always match this checkout. It is the workspace's
`cf-os` bin, so `pnpm cf-os api ...` works from any directory of the repository, and regenerates the
commands first when the API has changed. On a deployment only deployment
admins may use it ([Deployment admins only](#deployment-admins-only)); on a local dev server anyone
may.

The CLI documents itself, so this README covers only what `search`, `--help` and `types` cannot:

```sh
pnpm cf-os api search "list chats"      # the best five command lines for a task, as JSON
pnpm cf-os api open-workspace --help    # a command's arguments, docs and the commands after it
pnpm cf-os api types Overseer           # one service's TypeScript declarations, with api.ts's docs
```

None of these connect to an instance. Bare `types` prints the whole API, which is too long to read at
once; name a service instead (`types --help` lists them).

## Getting started

```sh
pnpm dev-server                                               # in another terminal: the default instance
export CFOS_API_PASSWORD=...
pnpm cf-os api create-account bob                             # a password account to act as
pnpm cf-os api --username bob whoami
pnpm cf-os api --username bob new-workspace set-title Notes   # the new workspace's id on stderr
pnpm cf-os api --username bob open-workspace <id> list-chats
```

## Finding and chaining commands

Commands are the API's methods in kebab-case, starting from a signed-in session (`AuthenticatedApi`).
A leading `public` starts from `PublicApi` instead, without signing in.

A command that returns a capability (`→ Overseer` in the listings) continues with the next command
on that capability, and the whole chain is pipelined in one session. A command whose result holds a
capability in a property continues by naming the property (`get-gatekeeper-app context ui ...`). A
chain must end on a value, and stdout holds only the last command's result. A command that creates
something (`new-workspace`) prints the new id on stderr, even when a later command fails. On an
untyped capability, `call <method> [json-args...]` calls a method by its camelCase name, unchecked.

When a usage error occurs (a near-miss name, a forgotten positional, a command that lives on another
capability), the CLI exits 2 and names the line it most likely meant.

## Chatting with an agent

`new-chat` (which prints the chat id) and `send-chat-message` start the agent's turn and return at
once. `wait-for-agent` waits for the turn to end (finished, failed, stopped, or paused on an action)
and prints the agent's reply. `get-chat-history` then has the whole turn, its tool calls and changes
included.

```sh
pnpm cf-os api open-workspace <id> list-models                                 # the model ids
pnpm cf-os api open-workspace <id> new-chat "Make a Counter gadget" <modelId>  # prints the chat id
pnpm cf-os api open-workspace <id> wait-for-agent <chatId> --timeout 300       # prints the reply
pnpm cf-os api open-workspace <id> get-chat-history <chatId>
pnpm cf-os api open-workspace <id> list-actions --options '{"filter": "pending"}'
pnpm cf-os api open-workspace <id> approve-action <actionId>                   # a paused turn goes on
pnpm cf-os api open-workspace <id> merge-changes <chatId>
```

If `--timeout` runs out, the turn keeps going: wait again, or `stop-agent <chatId>`.

## Gatekeeper app UIs, and what needs a browser

`get-gatekeeper-app <vendor> ui` continues with the typed commands of the interface the gatekeeper
exports as `AppApi` from its `src/app-api.ts` (today `context`, for Skills, and `scheduler`, for
Scheduled Tasks). Both are ambient, so provision the account once first:

```sh
pnpm cf-os api provision-ambient-account context
pnpm cf-os api get-gatekeeper-app context ui list-enabled-context-collections
```

Configurator UIs (`start-resource-configurator`, `start-creation-configurator`) are untyped: their
methods are the vendor's `*ConfiguratorUI` class in `packages/gatekeeper-<vendor>/src/`. With no
iframe to hand back a resource URL, build it from the resource type's `urlPattern` and pass it to
`open-workspace <id> new-gatekeeper <accountId> <resourceUrl>`.

Three things only a browser can finish. Connecting an account (`connect-account`,
`reconnect-account`, `ensure-account-resources`) ends on the Workshop's handoff page
([docs/connect-handoff.md](../../docs/connect-handoff.md)). Signing in through a gatekeeper confirms
in a popup. Connect the account in the Workshop as the same user, and the CLI then sees it in
`subscribe-connected-accounts`.

The third is approving an admin's write to a workspace:
`get-admin-api request-workspace-write <workspaceId> <action> <args> <reason>` prints the request
with its `approvalUrl`, an admin opens that page and confirms with a passkey, and
`get-admin-api get-workspace-write <requestId>` then shows whether it was applied. Passkeys are
enrolled and removed in the admin panel ([docs/admin-access.md](../../docs/admin-access.md)).

## Arguments, results and exit codes

Required parameters are positional; optional ones are flags (`--before-sequence`, or `--arg-<name>`
where that would clash with one of the CLI's own). Strings are taken as typed, `null` passes null
where the type allows it, and objects and arrays are JSON. Where the help shows
`<text|json|@file|->`, the value may come from a file or stdin. Every value is checked against its
declared type before anything is sent. Put `--` before a value that reads as an option.

Results are JSON on stdout: bigints as strings, bytes as `{"base64": "..."}`, dates as ISO strings.
Messages go to stderr. A `subscribe-*` command prints one JSON line per event until `--timeout`,
Ctrl-C or its reader closes; pair a pipe to `head` with `--timeout`. Byte streams go to
`--out <file|->`.

| Code | Means |
| --- | --- |
| 0 | Success, including a subscription ended by `--timeout` or its reader. |
| 1 | The call failed, the instance could not be reached, or a null partway through a chain left the rest not run. |
| 2 | Fix the command and rerun: a usage or type error, a missing credential, or a server question left unanswered ([`--answer`](#answers---answer)). |
| 130 | Ctrl-C. |

## Answers (`--answer`)

Some callbacks are questions the server waits on. `--answer <Callback>.<method>=<json|@file|->`
answers the first call, and a command's help lists them under **Answers**. Without one, the CLI
exits 2, printing what was asked and the flag to rerun with. The usual case is a collaborator's first
`open-workspace`, which asks which connected account to use for each gatekeeper binding (account
ids are the `id`s that `subscribe-connected-accounts --timeout 5` prints):

```sh
pnpm cf-os api open-workspace <id> get-metadata --answer 'ObserverConfigCallback.configure=[{"gatekeeperId": 3, "accountId": 7}]'
```

## The instance and signing in

The instance is `--url <origin>`, else `CFOS_API_URL`, else `http://localhost:8787`, where
`pnpm dev-server` listens. `http://` is accepted for local hosts only. The sign-in mode is
`--auth <mode>`, or else inferred: `password` when `--username` is given, `token` when
`CFOS_API_TOKEN` is set or the origin is `http://`, and `access` otherwise.

| Mode | Credential | For |
| --- | --- | --- |
| `access` | `CF_ACCESS_TOKEN`, else `cloudflared access token -app=<origin>` after `cloudflared access login <origin>` | An instance behind Access |
| `token` | `CFOS_API_TOKEN`, the auth token a password sign-in returns | A dev server, a test harness |
| `password` | `--username <name>` and `CFOS_API_PASSWORD` | A dev server, a test harness |

`create-account <username> [--display-name <name>]` signs up a password account with
`CFOS_API_PASSWORD`, so `--username <username>` can then sign in as it. Deployments refuse it, as do
instances with signups or password sign-in off.

Secrets come only from the environment or `cloudflared`, never from argv, which is why the API's
credential methods are not commands. `AdminApi`'s six passkey ceremony methods are not commands
either, for another reason: only a browser finishes them (see
[what needs a browser](#gatekeeper-app-uis-and-what-needs-a-browser)). `--dry-run` prints the
instance, sign-in mode and decoded calls without connecting, with every `@secret`-tagged value shown
as `{"$secret": true}`. Pass arguments that hold secrets (the help names them) from `@file` or `-`.

## Deployment admins only

The CLI sends `User-Agent: cf-os-api/<version>`. Unless the backend's `WORKSHOP_ENVIRONMENT` is
`development` (`pnpm dev-server`) or `test` (the integration harness), the Workshop lets such a
session act only as a deployment admin named in `ADMINS`. It refuses any other sign-in, and calls
that sign no one in, with exit 1. This is a speed bump against casual use, not a security boundary:
the API's own checks decide what any session may do. `pnpm dev-server` sets `ADMINS` to
`["admin"]`, so to call `get-admin-api` there:

```sh
pnpm cf-os api create-account admin
pnpm cf-os api --username admin am-i-admin   # true
```

## Generated files and tests

`generated/commands.ts` and `generated/agent-types.ts` are written by
`packages/api-schema/scripts/generate.ts`, rendered by `generator/emit.ts`, and not committed.
Everything that runs the CLI or reads them regenerates first with `--if-stale`
([api-schema's Generating](../api-schema/README.md#generating)). An API change the CLI cannot
represent fails generation, naming the method, so `pnpm build` and `pnpm lint` catch it.

```sh
pnpm exec vp run -F @gadgets/api-cli test   # cached, under the test watchdog
pnpm --filter @gadgets/api-cli test:run     # direct
```

After an intentional change to the emitter, refresh the fixture table with
`API_CLI_UPDATE_FIXTURES=1 node --test packages/api-cli/generator/emit.test.ts` and review the diff.

## Running it from another repository

[cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)'s `cf-os api` is to
run this CLI from its `cloudflare-os` submodule. Any caller follows this contract:

- **Entry.** Spawn, never import, `node <checkout>/packages/api-cli/src/main.ts api <tokens>` with
  stdio inherited. Before each run, spawn `node <checkout>/packages/api-schema/scripts/generate.ts
  --if-stale` the same way, and stop with its exit code if it fails.
- **Before spawning**, check that the entry exists (an older pin predates `cf-os api`: name
  `cf-os update`) and that the checkout's workspace is installed, or Node cannot load capnweb.
- **Tokens.** Everything after `api`, minus the caller's own global options.
- **Environment.** Set exactly one of `CFOS_API_URL=<https origin>`, the default instance, or
  `CFOS_API_URL_UNAVAILABLE=<message naming --url>`, printed verbatim when a run needs an instance,
  and delete the other from the child's environment. `CFOS_API_TOKEN`, `CFOS_API_PASSWORD`,
  `CF_ACCESS_TOKEN` and `PATH` (for `cloudflared`) are inherited.
- **cwd** is where `@file`, `--out` and stream paths resolve. **Exit codes** pass through.
- **Requirements.** Node >= 24.19 and the checkout's workspace install. The runtime imports only Node
  builtins, capnweb and hash-wasm (`src/main.test.ts` checks), never `@gadgets/*`.
