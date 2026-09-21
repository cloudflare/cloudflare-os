# MCP shared

The protocol client, policy decisions, and stateful machinery common to the two MCP-speaking
gatekeepers. Not a Worker: a library both of them import.

| Package | Endpoint comes from | Grant is scoped to |
| --- | --- | --- |
| [`gatekeeper-mcp`](../gatekeeper-mcp/README.md) | a user pastes a URL | the whole server, or named tools |
| [`gatekeeper-mcp-portal`](../gatekeeper-mcp-portal/README.md) | a deployment var, `MCP_PORTAL_URL` | one upstream server behind the portal, or named tools |

Code lives here when two copies of it would eventually disagree and the disagreement would be a
security bug: tool classification, the scope grammar, the OAuth lifecycle, the approval-queue
wiring. A Worker's own vendor entrypoint, Durable Object classes and migrations, `Env`, connect
form, and configurator UI stay in the connector. Where a connector must vary shared behaviour it
does so through a named hook (`staticToken`, `mintAccount`), not a private copy.

## Modules

| Module | Purpose |
| --- | --- |
| `client` | Bounded Streamable HTTP transport (`initialize`, `tools/list`, `tools/call`) using official MCP wire types |
| `oauth` | Small adapter around the official MCP client's OAuth errors and token revocation gap |
| `tools` | The trust boundary: read/action classification, auto-approval eligibility, approval prompts, catalog fingerprinting |
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery |
| `session-methods` | Installs those methods at runtime, so the generated types are not a fiction |
| `tool-search` | The one query matcher every catalog search uses, so a query cannot mean two things |
| `portal` | Gateway detection, tool-name to upstream-server mapping, server listing |
| `scope` | The resource-URL scope grammar, and the check every call passes through |
| `endpoint` | Validation and host blocklist for a user-supplied endpoint |
| `fetch` | Every outbound request; redirects are followed by hand and each hop re-checked, including SDK OAuth fetches |
| `account` | Durable Object base and persisted SDK OAuth state: connect, refresh, revocation |
| `facet` | Common session, catalog, action, and sharing behavior for connector-owned Durable Object facets |
| `catalog` | One binding's tool list: fetched, cached, scoped to the grant, classified; plus the cache for tools hydrated past that list |
| `connection` | `withClient` — transport sessions, retries, credential-expiry reporting |
| `action-store` | Staged to applied/rejected/failed, with a bound on what is retained and a claim so one approval is never sent twice |
| `session` | The Gadget-facing capability, and the one path every tool call takes |
| `sharing-policy` | The owner-only sharing rule |
| `html` | The connect-flow pages, so both connectors look like one product |
| `http` | Base-path, OAuth callback, and connect-link routing shared by both Workers |
| `log` | The field vocabulary both connectors log against |
| `user` | The common account description, revocation, and reconnect lifecycle |
| `util` | Hex encoding, host extraction, binding-name slugs; no policy |
| `types.d.ts` | Base types prepended to every generated per-server `.d.ts` |

Nothing outside `tools.ts` reads a tool's `annotations`.

## Trust tiers

A tier governs how far a server's own claims about its tools are believed. MCP's own guidance is
that a client must treat tool annotations as untrusted unless they come from a trusted server, and
the tier is where this deployment records which servers those are. It is named by provenance, is
deployment configuration rather than account state, and is read at each point of use so withdrawing
it takes effect at once.

- **`byo`** — a user typed the URL in. `readOnlyHint` classifies reads; nothing the server says can
  auto-apply a write.
- **`vetted`** — a deployment has asserted this endpoint's annotations can be relied on, so
  `destructiveHint: false` plus `idempotentHint: true` may drive auto-approval. Configuring an
  endpoint is not by itself enough to earn this: a portal aggregates upstream servers whose
  annotations the administrator never saw, which is why `gatekeeper-mcp-portal` defaults to `byo`
  and requires `MCP_PORTAL_TRUST_ANNOTATIONS=true`.

Honouring `readOnlyHint` on `byo` is a tradeoff, not a free win: a tool the server mislabels runs
with no approval, where an unlabelled one would have been queued. It is accepted because prompting
on every read makes the connector unusable for its main purpose, and because the owner chose to
connect the server. Auto-applying a write is not accepted on those terms.

Annotations are optional in MCP and most servers publish none. Every hint is compared with
`=== true` or `=== false`, so an unannotated tool is an action, needs approval, and can never
auto-apply, on either tier. That matches the spec's own defaults (`readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false`).

Neither tier can be shared. A Gadget bound to any MCP endpoint is owner-only, for reasons unrelated
to provenance — see [`sharing-policy.ts`](src/sharing-policy.ts).

What an account records instead of a tier is `provenance`, `"user"` or `"deployment"`, settled when
it connects. Provenance decides whether a server may rename itself over an administrator's chosen
label in an approval prompt, which is a question that should not move when an annotation setting
does.

## Applying an approved call

The guarantee is *at most once*, not exactly once. MCP has no idempotency key that would make a
repeated call harmless and no inverse operation that would undo one, so where the two conflict the
store prefers losing a result over repeating a write.

An approval is claimed in storage before the call is sent, which is what stops two concurrent
`applyAction` calls from both reaching the server. Once the call returns, the record is settled in
its own small write *before* the result is attached, so nothing about handling a server-controlled
payload — normalizing it, encoding it, or finding it too large for the Durable Object to store — can
lose the fact that the write already happened.

Failures are split by what the server is known to have done, because that is not something the
caller can work out afterwards. Only a `401` or `403` proves the tool was refused before dispatch.
Generic HTTP and JSON-RPC errors, dropped connections, malformed replies, and oversized bodies all
leave the outcome unknown; those are closed as failed and **not** retryable, since the request may
already have been carried out. The classification (`callMayHaveTakenEffect`) fails safe: anything it
cannot positively identify as declined counts as possibly performed.

The same rule covers an activation dying between sending the call and recording the reply. The claim
is not released for another attempt: after `APPLY_CLAIM_TIMEOUT_MS` the action is closed the same
way, saying it may or may not have taken effect.

So the cost of a network blip is a call someone has to stage again, deliberately. That is the trade
this module makes everywhere: an approval is never spent twice without a person saying so.

## Limits

Fixed rather than configurable.

| Limit | Value | Where | Why |
| --- | --- | --- | --- |
| Described or individually granted tools per server | 200 | `tools.ts` | Bounds the picker and generated `.d.ts`; a server-wide grant can discover additional tools later |
| Catalog size | 96 KiB UTF-8 | `client.ts` | Leaves room below Durable Object's 128 KiB per-value limit for the cache wrapper and serialization overhead |
| Filtered discovery scan | 5,000 tools / 4 MiB | `client.ts` | Bounds work spent skipping unrelated tools while searching a large endpoint |
| Search query / results | 200 chars / 20 tools | `tool-search.ts` | Bounds agent-supplied matching work and the summaries returned to it |
| Hydrated definitions per facet | 200 tools / 1 MiB | `catalog.ts` | Bounds definitions fetched individually beyond the described catalog |
| Tool description | 4 KB | `client.ts` | As above, per tool, before it reaches storage |
| Tool input schema | 20 KB | `client.ts` | Dropped rather than clipped; half a schema is not a schema |
| `tools/list` pages | 50 | `client.ts` | Stops a cursor that never ends; exhaustion truncates catalogs and fails exact/search discovery as a scan limit |
| Response body | 1 MiB | `fetch.ts` | Every response is buffered whole before it can be parsed, and a `tools/call` result is otherwise unbounded |
| Bounded outbound operation | 30 seconds | `fetch.ts` | OAuth and discovery callers opt into one deadline covering redirects, pagination, body streaming, and session retry |
| Retained result | 128 KB | `action-store.ts` | Held until the Gadget collects it; oversized ones are replaced by a note |
| Retained actions | 100 | `action-store.ts` | Records are for collecting a result, not an audit log |
| Actions awaiting a decision | 50 | `action-store.ts` | These cannot be pruned, so uncapped they are an unbounded write |
| Tool description in a prompt | 600 chars | `tools.ts` | Server-controlled text in a security decision |
| Tool arguments in a prompt | 4000 chars | `tools.ts` | Agent-controlled text in the same decision |
| Server name | 60 chars | `account.ts` | As above; also stripped of Markdown |
| Redirect hops | 3 | `fetch.ts` | Each one re-checked; more is a loop, not a deployment |
| Connect link | 10 min | `connect-nonce.ts` | Single-use, and consumed on success |
| Unfinished connect | 1 hour | `connect-nonce.ts` | After which a half-built account deletes itself |

## Build & test

```
pnpm --filter @gadgets/mcp-shared build   # tsc
pnpm --filter @gadgets/mcp-shared test:run    # vitest
```
