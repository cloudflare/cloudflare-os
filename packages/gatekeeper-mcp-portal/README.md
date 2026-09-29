# MCP Server Portals gatekeeper

Connects the deployment's own MCP portal as a Gadgets capability. An administrator configures one
URL; everyone in the organization then reaches every MCP server the organization has approved
through it, and no user ever types an endpoint. Runs as its own Cloudflare Worker and is
auto-discovered by the backend from its `GATEKEEPER_MCP_PORTAL` binding.

The intended deployment is a
[Cloudflare MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/):
Access decides who may connect, Cloudflare Gateway logs and inspects what crosses, and this
connector turns what is behind it into typed capabilities that Gadgets can grant one server at a
time.

For endpoints a user supplies themselves, use [`gatekeeper-mcp`](../gatekeeper-mcp/README.md).

## What it provides

One resource type, **MCP portal server**, at two grant breadths. A grant always names one upstream
server; "everything the portal offers" is not offered, since it would hand a Gadget every tool of
every system the organization has connected in one click.

| Granularity | Resource URL | Session type |
| --- | --- | --- |
| **Server** — every tool of one upstream server, including ones it adds later | `<endpoint>#server=github` | `Mcp<Name><tag>Session` |
| **Named tools** — only the listed tools of that server | `<endpoint>#server=github&tool=github_a&tool=github_b` | `Mcp<Name><tag>Session` |

`<tag>` is four hex characters derived from the resource URL. It matters most here: two grants
pinning different tools of one upstream server share both the name and the endpoint, so the scope is
the only thing that distinguishes them.

The session API — a typed method per described tool, plus `callTool`, `getActionResult`, and
`listTools` with progressive search/name options — is the same as
[`gatekeeper-mcp`](../gatekeeper-mcp/README.md#what-it-provides).

A server-wide grant can cover more tools than one catalog describes, so its authority is not limited
to the ones with generated signatures. `listTools({ search })` searches beyond the bounded preview
and returns up to 20 compact matches within the shared 5,000-tool / 4 MiB discovery scan;
`listTools({ name })` loads one exact bounded definition, and `callTool` resolves that name under the
same bound before dispatch. Every path rejects names outside the
binding's scope before loading the catalog or contacting the endpoint. Discovery and read results are
recorded as observations; writes retain the ordinary approval flow.

Scoping to one server also shrinks what the agent reads: only that server's tools are rendered as
signatures, and only as many as the budget describes. Additional tools are discovered on demand
within the explicit scan limits above; exceeding a limit fails rather than pretending a tool is absent.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_PORTAL_URL` | The portal's MCP endpoint. Unset means the connector hides itself. |
| `MCP_PORTAL_NAME` | Display name in the connector list and every approval prompt. Defaults to `MCP Server Portal (<host>)`. |
| `MCP_PORTAL_AUTH` | `oauth` (default), `none`, or `token`. |
| `MCP_PORTAL_TOKEN` | Secret bearer token, for `MCP_PORTAL_AUTH: "token"`. |
| `MCP_PORTAL_TRUST_ANNOTATIONS` | `true` to let upstream tool annotations drive auto-approval. Off by default; see below. |
| `MCP_PORTAL_HIDDEN_SERVER_IDS` | Comma-separated upstream server IDs to hide from the configurator and refuse at the grant boundary. |
| `MCP_ALLOW_INSECURE` | `"true"` to disable the endpoint checks entirely: permits `http://` **and** private, loopback, link-local, and cloud-metadata hosts, for the portal and every OAuth URL discovered from it. Local dev only. |

The portal must expose upstream tools directly. Use a portal where Code Mode is off or opt-in, or
append `?codemode=off` when its policy is default-on. Enforced Code Mode is unsupported. Do not add
an `optimize_context` parameter or opt in to Code Mode on `MCP_PORTAL_URL`.

Only `MCP_ALLOW_INSECURE` is set in the repo's `wrangler.jsonc`, pinned to `"false"` so the default
is explicit rather than merely absent. None of the others is, and a portal URL committed there would
become the default for every deployment of this repo and would send their users' OAuth flows to
whichever host it named, so it belongs in the deployment's own configuration — for Cloudflare's
internal deployment, the per-package overrides in `gadgets-internal`.

Unconfigured, `getSupportedResources()` returns nothing and the Workshop drops the vendor. A
`MCP_PORTAL_URL` that cannot be used — a non-`https` typo or a URL containing `username:password`,
say — is treated the same way, so a misconfiguration hides the connector rather than producing one
that fails on first use or copying URL credentials into account state and configurator fields.

Changing `MCP_PORTAL_URL` on a deployment that already has connected accounts is a **repoint**.
Existing bindings fail closed at once: the minting path checks facet props against current
configuration, and an already-minted facet must name its endpoint when asking the account for
credentials, which the account refuses after it has moved. The user recovers by reconnecting, which
is the one endpoint change an account will accept. It is accepted only because the new endpoint
comes from this Worker's configuration rather than from a form. Nothing held for the old portal
survives the move: tokens, the transport session, and any in-progress authorization are dropped, so
the user re-authorizes against the new host. The account advances a persisted generation before
probing; refreshes, expiry notifications, and session writes that started under the old generation
are ignored when they eventually return. Always-approve action kinds also include the exact endpoint,
so consent for the old portal does not carry over to the new one.

`MCP_PORTAL_TRUST_ANNOTATIONS` is read at each point of use (`portalTrust(env)`) and never
persisted on an account or a binding's props, so clearing it de-escalates every existing connection
on the next call. Setting it does not retroactively auto-apply anything; the user must still enable
a rule for each action kind.

## Local development

`pnpm dev-server` — and therefore `pnpm run-local`, which drives it — passes `MCP_PORTAL_*` through
from the shell and the repo-root `.dev.vars`, and `--mcp-portal-url URL` sets `MCP_PORTAL_URL` for one
run without editing a file:

```
pnpm run-local --mcp-portal-url http://localhost:9000/mcp
```

That URL is written only into the generated, gitignored `wrangler.dev.jsonc`, and it beats a
`.dev.vars` entry. When the URL is `http://` the dev server also sets `MCP_ALLOW_INSECURE=true` for
this connector, since a portal on this machine is unreachable otherwise; set the variable explicitly
in the shell or `.dev.vars` to keep the production checks. `MCP_PORTAL_AUTH`, `MCP_PORTAL_TOKEN`,
`MCP_PORTAL_NAME`, `MCP_PORTAL_TRUST_ANNOTATIONS`, and `MCP_PORTAL_HIDDEN_SERVER_IDS` travel the same
way. None of this changes what a deployment ships: the committed `wrangler.jsonc` still names no
portal, and a deployment without `MCP_PORTAL_URL` still hides this connector.

## How the connect flow works

There is no connect form: the endpoint is a deployment setting, so pressing "connect" goes straight
to the portal's own sign-in. Under `MCP_PORTAL_AUTH: "oauth"` the gatekeeper runs the same
discovery chain as [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#how-the-connect-flow-works)
against the portal; under `"token"` it presents `MCP_PORTAL_TOKEN` and no user interaction is
needed; under `"none"` it connects unauthenticated.

The account records `provenance: "deployment"`, which is what keeps an upstream server from renaming
itself over `MCP_PORTAL_NAME` in every approval prompt.

## Granting

The configurator asks which server behind the portal, how broad the grant is, and — if it is
pinned — which tools:

```
Server · Which server behind this portal to grant. Its tools appear next.
[ 🔍 GitHub ]

Tools · Choose how much of this server the Gadget may call.
(•) All tools      Every tool this server offers, including ones it adds later.
( ) Choose tools   Only the tools you tick. Anything else is refused, including tools added later.

Allowed tools · Read-only tools return data straight away. The rest queue for your approval.
[ 🔍 Filter tools... ]
12 of 12 selected                                                                     Clear
☑ List issues                                                                     read-only
☑ Create issue                                                               needs approval
```

**All tools** is the default. The breadth is asked outright rather than inferred from whether every
box is ticked, since the two look identical and diverge as soon as the server publishes another
tool. A portal with one server behind it collapses to the tool questions alone, because the choice
is made for the user rather than skipped — the grant still records that server.

Every grant here names exactly one upstream server. There is no breadth that spans the portal, so a
configured endpoint with no upstream servers — a plain MCP server, or a portal that currently fronts
nothing — is **not grantable through this connector**: the configurator has no server to offer and
the form stays unsubmittable. That is deliberate. The alternative is a grant recorded against the
bare endpoint, which would silently include every server added to it later. Point a plain MCP
endpoint at the **MCP** connector (`gatekeeper-mcp`) instead, which is built for exactly that and
offers endpoint-wide and per-tool grants.

## How upstream servers are recovered

A portal flattens every upstream server's tools into one `tools/list`, so the seam has to be
recovered from two facts in the portal's documented contract:

1. Every tool is named `{server_id}_{original_name}`, split on the first underscore only, and an
   alias replaces the tool name but never the server-id prefix. Membership is therefore a pure
   string test needing no network call, so a server scope cannot fail open on a transient error.
2. `portal_list_servers` is available in every portal session and returns each upstream server's id,
   name, and enabled state.

Detection is a capability probe — does the endpoint offer `portal_list_servers`? — not a hostname
match, so it works for a custom portal hostname and for any other aggregator adopting the
convention. A *truncated* listing counts as a portal whether or not the probe tool is in it:
`tools/list` is unordered, so concluding "not a portal" because the evidence fell past the cut would
fail open on the `portal_*` exclusion below. Truncation is reported by the client rather than
inferred from the tool count, because either cap can stop a listing — the count the caller asked for,
or the 96 KiB UTF-8 budget, and the latter can cut a listing of verbose tools short while leaving an
array that looks complete. The byte budget leaves 32 KiB below Durable Object's per-value limit for
the cache wrapper and serialization overhead; if storage nevertheless rejects the cache value, the
fresh catalog is still used for that operation rather than turning a cache miss into a failure.

### Surveying a portal too large for one catalog

The configurator normally gets server names directly from `portal_list_servers`, without surveying
every upstream tool. If that response is unavailable or only partly understood, it falls back to a
**name-only tool index** of up to 1,000 entries. The index detects the portal and recovers server
membership from tool-name prefixes; it carries no descriptions, schemas, or policy claims, so the
96 KiB result budget covers as many names as possible. A truncated fallback cannot establish the
complete server list and blocks the form rather than presenting a partial list as complete.

After a server is selected, a separate filtered scan returns up to 200 compact summaries from that
server. Each summary carries its bounded title, description, and annotations, and is classified
through the shared `tools.ts` trust boundary before it becomes a read-versus-approval label. The
filter is applied before result budgets, so unrelated servers cannot crowd the selected one out.
Only the returned prefix is offered for an individual-tool grant; additional tools require the
server-wide grant, and a call resolves the full definition before approval or dispatch.

Index entries are typed separately (`IndexedTool`) to distinguish name-only survey results from tool
definitions rendered into approval prompts or handed to an agent.

The server list is advisory: it supplies display names and ordering while tool-name prefixes remain
the authority on membership, and a failed call degrades to bare ids recovered from tool prefixes.
The gatekeeper makes that call
while building a form, so it does not pass through the approval queue. Failing to reach the portal
at all is different, and blocks the grant rather than falling back to the bare endpoint — the
configurator reports it and stays unsubmittable.

`portal_*` tools are excluded from every grant at every scope. `portal_toggle_servers` and friends
change which upstream servers the session can reach, so granting one would let a Gadget widen its
own authority. This is a capability-boundary rule, not a policy preference, and is not configurable.

## Approvals and sharing

Identical to [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#approvals-and-sharing), except for the
trust tier. A portal is an aggregator: `destructiveHint` and `idempotentHint` are written by
whichever upstream server it fronts, servers the administrator who chose the portal never reviewed,
and any one of them could self-declare both and get writes that skip the approval prompt. So the
tier is `byo` unless a deployment sets `MCP_PORTAL_TRUST_ANNOTATIONS=true`. That flag is the
"trusted server" assertion MCP's guidance asks for, and it has to be about the upstreams themselves,
not just the portal in front of them.

`addObserver` refuses everyone, as it does for user-supplied endpoints. Reaching the portal is not
the same as being allowed to see a particular tool result, and the Gadget runs on the owner's
credentials regardless. A sharper check is available here than for a bare endpoint —
`portal_list_servers` is per-user and Access-filtered, so it could confirm a collaborator may reach
the same server — but that is still server-granular, not record-granular. See
[`sharing-policy.ts`](../mcp-shared/src/sharing-policy.ts).

## Sidecar apps

Identical to [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#sidecar-apps), with the grant in force
being this binding's: a `ui://` result from an upstream server opens with that server's scope and
through the portal's own session, so nothing else behind the portal becomes reachable by opening a
link. Hidden upstream servers are refused at the grant boundary, so no app link can reach past
`MCP_PORTAL_HIDDEN_SERVER_IDS` either. The read-only rule is enforced in `@gadgets/mcp-shared`, so
the two connectors cannot serve two different policies for the same link.

The portal **renames the resources it fronts**, exactly as it namespaces tools and prompts: it lists
and reads an upstream's `ui://demo/dashboard` as `mcp-app-server_ui://demo/dashboard`, and answers a
read of the upstream's own URI with `-32602 Resource not found`. A link therefore keeps the URI its
server declared — that is the app's identity and the name its window asks for — and this connector
supplies `resourceUriPrefix` so the read goes out under the portal's name
([`portal.ts`](../mcp-shared/src/portal.ts) states the rule; `appResourceUri` applies it). The minted
link logs both names (`appUri`, `resourceUri`), which is the pair to read when one fails to open.

Links minted before that prefix existed name a resource the portal will not serve, so a mint replaces
one rather than reusing it when the binding's resource naming has changed; an untouched link still
expires after its 24 hours.

## Notes and current limitations

The limitations in
[`gatekeeper-mcp`](../gatekeeper-mcp/README.md#notes-and-current-limitations) apply here too: no
simulation, no revert, no hooks, no scoping below tool names, and `tools/*` only. SSRF is enforced
the same way, by `global_fetch_strictly_public` rather than by hostname patterns. In addition:

- **One portal per deployment.** `MCP_PORTAL_URL` is a single value; a second portal needs a
  second Worker.
- **Server ids come from tool-name prefixes.** An aggregator that flattens tools without prefixing
  them exposes no upstream seam, so this connector finds no server to scope a grant to and the form
  stays unsubmittable. It is not granted as a whole endpoint — that grant does not exist here. Use
  the **MCP** connector (`gatekeeper-mcp`) for such an endpoint, where endpoint-wide breadth is an
  explicit, reviewable choice.

## Layout

| File | Purpose |
| --- | --- |
| `src/portal.ts` | Vendor, account DO, user, gatekeeper facet, session, configurator RPC |
| `src/config.ts` | Reading and validating the deployment's portal configuration |
| `src/configurator/` | The grant UI (compiled into `src/generated/`) |

Everything else comes from [`@gadgets/mcp-shared`](../mcp-shared/README.md).

## Build & test

```
pnpm exec vp run -F @gadgets/mcp-portal-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/mcp-portal-gatekeeper test:run    # vitest
```

The Worker is run via the root `pnpm dev-server`, not directly.
