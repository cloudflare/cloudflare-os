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

The session API — a typed method per tool, plus `callTool`, `getActionResult`, and `listTools` — is
the same as [`gatekeeper-mcp`](../gatekeeper-mcp/README.md#what-it-provides).

Scoping to one server also shrinks what the agent reads: a 57-tool portal generates 57 tool
signatures unscoped, and 12 when scoped to one server.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_PORTAL_URL` | The portal's MCP endpoint. Unset means the connector hides itself. |
| `MCP_PORTAL_NAME` | Display name in the connector list and every approval prompt. Defaults to `MCP Server Portal (<host>)`. |
| `MCP_PORTAL_AUTH` | `oauth` (default), `none`, or `token`. |
| `MCP_PORTAL_TOKEN` | Secret bearer token, for `MCP_PORTAL_AUTH: "token"`. |
| `MCP_PORTAL_TRUST_ANNOTATIONS` | `true` to let upstream tool annotations drive auto-approval. Off by default; see below. |
| `MCP_ALLOW_INSECURE` | `"true"` to disable the endpoint checks entirely: permits `http://` **and** private, loopback, link-local, and cloud-metadata hosts, for the portal and every OAuth URL discovered from it. Local dev only. |

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
[ 🔍 GitHub ]                                    12 tools · 8 read-only, 4 need approval

Tools · Choose how much of this server the Gadget may call.
(•) All tools      Every tool this server offers (12 today), including ones it adds later.
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
convention. A *truncated* catalog counts as a portal whether or not the probe tool is in it:
`tools/list` is unordered, so concluding "not a portal" because the evidence fell past the cut would
fail open on the `portal_*` exclusion below. Truncation is reported by `listTools` rather than
inferred from the tool count, because either cap can stop it — `MAX_TOOLS_PER_SERVER` (200) or the
96 KiB UTF-8 catalog budget, and the latter can cut a catalog of verbose tools short while leaving an
array that looks complete. The byte budget leaves 32 KiB below Durable Object's per-value limit for
the cache wrapper and serialization overhead; if storage nevertheless rejects the cache value, the
fresh catalog is still used for that operation rather than turning a cache miss into a failure.

The server list is advisory: it supplies display names and ordering while tool-name prefixes remain
the authority on membership, and a failed call degrades to bare ids. The gatekeeper makes that call
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
pnpm --filter @gadgets/mcp-portal-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/mcp-portal-gatekeeper test    # vitest
```

The Worker is run via the root `pnpm dev-server`, not directly.
