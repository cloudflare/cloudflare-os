# Team PI Codex Production Handoff

Last verified: 2026-08-06

GPT-6 Astra is the code default. Production uses the first entry in the
`TEAM_PI_CODEX_MODELS` Worker secret. The production workflow prepends Astra to the GitHub
configuration and synchronizes the resulting list only after the updated Worker code is deployed.

Internal operational document. It contains deployment identifiers and secret locations, but no
secret values.

## Purpose

This deployment is intended to provide an SSO-protected internal Odie workspace at
`https://odie-os.odie-os.workers.dev/`. Verified Totango users can use the managed
`Team PI Codex gpt-5.6-sol` model without receiving or persisting Codex credentials when the
upstream route is healthy. A fresh workspace succeeded after an older smoke workspace developed
stale account-continuity state; see Verification.

The production request path is:

```text
Odie -> Team PI relay -> Jarvis bridge -> codex-lb
```

## Production State

- Public Worker: `odie-os`
- Private service Worker: `odie-os-backend`
- Current backend version: `9535ec1a-1ce5-423d-9908-598264fd4c50`
- Current public router version: `1d585db9-1bfc-491e-8ae8-5c2b37e3c4cc`
- Public URL: `https://odie-os.odie-os.workers.dev/`
- Team PI relay: `https://team-pi-proxy.unison.totango.com/api/odie`
- Managed model: `gpt-5.6-sol`
- Cloudflare account: `286469790a4362a2e194b32045c5eca7`
- Upstream Odie release: `dev-tjd58j` / `0b25cd3c`
- Totango Odie merge: `3c91d8219f1a550b4fe8137f443eb8e25183778f`
- Team PI image digest: `sha256:8cf88df485b4f63cdd45a73ccca796560225204001eb6b9da49ac024ca86508b`
- Jarvis image digest: `sha256:973357ada1bda0b7218c41cb373781ba4b4eb7a755676390974bd2132f1da127`
- codex-lb chart and app version: `1.22.0`, Helm revision 13 at verification time
- JARVIS gatekeeper: `odie-os-gk-jarvis`, version `2c39d4ef-7ed7-44c2-9bb4-7efd94cade38`

The backend has no public route. `workers_dev` and preview URLs are disabled. The router reaches
the backend through a Worker service binding.

## Access Policy

Cloudflare Access protects the public Worker. The exact allowlist at handoff is:

- `jacob.beck@totango.com`
- `cameron.curry@totango.com`
- `jason.zopf@totango.com`

Managed Codex additionally requires a verified `@totango.com` identity and password login must be
disabled. The model cannot be used through persistent model bindings, callbacks, automated gadget
execution, or stale user-configured model markers.

## Request Security

Odie signs each relay request with HMAC-SHA256. The canonical input binds:

1. Key ID
2. Audience
3. HTTP method
4. Logical relay route
5. Timestamp
6. Verified user email
7. Stable chat session ID
8. Per-model-invocation request ID
9. SHA-256 of the exact forwarded body

The logical route is intentionally fixed as `/api/odie/codex/responses`; it is part of the shared
Odie/Team PI protocol rather than derived from a configurable URL.

Team PI verifies the signature and durably claims the request ID in PostgreSQL before forwarding.
Odie preserves the stable `session-id` for model affinity but replaces pi-ai's duplicated
`x-client-request-id` with one UUID per stream invocation. Internal HTTP retries reuse that UUID;
the next model invocation receives a new UUID.

Odie strips provider credentials before forwarding. The synthetic Codex credential only satisfies
the local pi-ai API shape and is not accepted as upstream authority.

## Body Encoding

pi-ai `0.83.0` zstd-compresses Codex SSE request bodies. Team PI uses `express.raw()`, which rejects
zstd request content encoding. Odie therefore:

- accepts `zstd` or `identity` only;
- rejects non-POST requests;
- caps compressed input at 4 MiB;
- caps decoded input at 8 MiB through zlib `maxOutputLength`;
- hashes and signs the decoded bytes;
- forwards those exact bytes with `Content-Encoding: identity`;
- removes stale `Content-Length` and provider authorization headers.

The `node:zlib` zstd decode path in the Cloudflare Workers production runtime was verified during
earlier live model requests; this does not establish the current health of the complete model route.

## Configuration

Required backend environment values:

```text
TEAM_PI_CODEX_BASE_URL=https://team-pi-proxy.unison.totango.com/api/odie
TEAM_PI_CODEX_MODELS=gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini
TEAM_PI_CODEX_HMAC_SECRET=<secret>
TEAM_PI_CODEX_ONLY=true
CF_AI_GATEWAY_API_TOKEN=<secret>
```

The Odie production configuration enables `TEAM_PI_CODEX_ONLY` and does not enable any
`CF_AI_GATEWAY_PROVIDERS`. For eligible Totango accounts, model listing, preferred and quick model
selection, and chat resolution then fail closed to the configured Team PI model IDs. The Workers AI
binding remains deployed but is not an available LLM route for those accounts.

The production workflow requires a nonempty `TEAM_PI_CODEX_MODELS` GitHub secret, prepends Astra,
deduplicates the list, and writes it to `odie-os-backend`. Older configured IDs remain available
for persisted selections. Updating the GitHub secret alone does not update the running Worker;
the synchronization happens during deployment.

On 2026-09-05, the production pool served `gpt-6-astra` successfully through both the Jarvis
Responses/Chat Completions paths and Odie's Codex Responses path. Odie's existing gateway key
had a Sol-only allowlist and forced model; its model policy was updated to allow Astra and the
legacy profiles listed above without forcing a model. The credential, account assignments, and
codex-lb 1.23.0 deployment were unchanged. Future model rollouts must verify the response's
actual model, not just HTTP success, because a gateway key can override the requested model.

Secret locations:

- Odie/Jarvis: Kubernetes secret `odie-codex-bridge` in `leviosa-prod-use1/odi-control-plane`
- Team PI: Kubernetes secret `odie-codex-relay` in `leviosa-prod-eu/team-pi-proxy`
- Local deployment copy: macOS Keychain service `team-pi-odie-codex-hmac`, account `odie-os`

Do not put secret values, Codex API keys, prompts, authorization headers, request bodies, or
codex-lb dashboard bootstrap tokens in logs or documentation.

Preserved backend resources:

- KV `BLUEPRINTS`: `882e6c6dfdf9466f999b8084ed3cd637`
- KV `AVATARS`: `7147e3e3dc964b03b85f00f62952c92e`
- R2 `BLUEPRINT_CONTENT`: `odie-os-blueprint-content`
- Browser binding: `BROWSER`
- Workers AI binding: `WORKERS_AI`
- Worker loader binding: `LOADER`
- Context service: `odie-os-gk-context#GatekeeperVendor`
- JARVIS service: `odie-os-gk-jarvis#GatekeeperVendor`
- Scheduler service: `odie-os-gk-scheduler#GatekeeperVendor`
- Durable Object migration tags through `v2`

## Gatekeeper Capabilities

JARVIS is auto-provisioned as an ambient singleton and exposes a fixed local allowlist. Knowledge,
repository, incident, integration-health, and status tools are reads. Support-question and customer
investigation tools always require manual approval; upstream MCP annotations cannot weaken that
policy. The deployment bearer is stored only as the `JARVIS_MCP_TOKEN` Worker secret.

Five tools reach live production rather than recorded knowledge: `jarvis_list_prod_tools`,
`jarvis_describe_prod_tool`, `jarvis_call_prod_tool`, `jarvis_describe_wren_tool`, and
`jarvis_call_wren_tool`. Listing and describing are reads. The Wren-specific describe/call pair is
available in Chat and Code, resolves tools only from `prod-wren`, and should be preferred for
structured production-data questions because Wren provides semantic model and relationship context.
**Calling is an action and waits for approval**, even though JARVIS declares the tool read-only —
the agent chooses the tool name and the arguments, and the reachable surface includes ad-hoc SQL
against the production databases, so the gatekeeper does not delegate that decision upstream. If the
approval prompts prove too frequent in practice, removing `jarvis_call_prod_tool` from
`MANUAL_ACTION_TOOL_SET` in `packages/gatekeeper-jarvis/src/config.ts` reverts it to a read.

JARVIS refuses the tools those servers host that write — Grafana's `create_incident`,
`update_dashboard`, `alerting_manage_rules` and four more, plus k8sgpt's `config`, `add-filters`
and `remove-filters`. That policy lives in `odi-control-plane`, not here; this deployment does not
depend on it being correct, which is why calling is approval-gated on this side.

The database reads behind those tools are read-only by enforcement rather than by convention,
verified 2026-08-07 rather than taken from the tool descriptions:

- **postgres** connects as `mcp_readonly` with `transaction_read_only` on, against a read replica
  (`pg_is_in_recovery()` true) — writes are impossible regardless of what a tool claims.
- **clickhouse** connects as `mcp_readonly`, whose role holds exactly one grant:
  `GRANT SELECT ON leviosa.* TO mcp_readonly_role`. SELECT only, and scoped to one database.
- **redis** exposes only `get`, `ttl`, `type`, `hgetall` and `dbsize`; there is no
  arbitrary-command tool.

JARVIS tool helpers are generated with camel-case names. Call
`JARVIS.jarvisInvestigateCustomerIssue(...)`, not the MCP wire name; snake_case names remain
reachable only through `callTool("jarvis_investigate_customer_issue", ...)`.

A connected account's persisted gatekeeper capability is pinned to the Worker version present when
the account was connected (the gatekeeper Workers set `allow_irrevocable_stub_storage`, so a stored
stub keeps calling the version it was stored against). After deploying a gatekeeper change that
alters catalog or observation behaviour, existing accounts must be disconnected and reconnected
before they exercise the new code.

Observed behaviour when that step is skipped, verified against the JARVIS gatekeeper on
2026-08-07 after adding three tools:

- Workspaces **created after** the deploy pick up the change with no action at all.
- Workspaces **created before** it do not, and starting a new chat inside one does **not** help —
  the stale record is per workspace, not per chat.
- The failure is not a missing tool but an RPC error, e.g.
  `TypeError: The RPC receiver does not implement the method "jarvisListProdTools"`, which reads
  like a code bug rather than a stale capability.

Reconnecting the account fixes the existing workspaces. For a gatekeeper the deployment has set to
**enabled**, there is no Disconnect control — a forced ambient account is hidden from the Connectors
page and from a workspace's "Create New Connection" dialog. The sequence is:

1. Admin → Gatekeepers → set the vendor to **optional**. It then appears under Connected.
2. Connectors → open it → Disconnect → confirm.
3. Reconnect it from Available.
4. Admin → Gatekeepers → set the vendor back to **enabled**.

Do not use **disabled** for this: an existing account goes dormant rather than being replaced, so
re-enabling reuses the same pinned capability and changes nothing, while the gatekeeper is
unavailable to everyone in the meantime.

The cost is real and worth stating: disconnecting makes the bindings frozen into pre-existing chats
inert (`prepareChatBindings` freezes the ambient set per chat, and a since-disconnected gatekeeper
stays in the frozen list but stops working). Those transcripts lose the gatekeeper entirely. New
chats in every workspace get the current one.

## Source Locations

- `packages/workshop-backend/src/ai-models.ts`: zstd normalization, HMAC, request IDs, and model transport
- `packages/workshop-backend/__tests__/ai-models.test.ts`: transport and routing regression tests
- `packages/workshop-backend/src/team-pi-codex-models.ts`: managed model definitions and eligibility
- `packages/workshop-backend/src/user.ts`: model visibility and stale-state filtering
- `packages/workshop-backend/src/overseer.ts`: persistent capability and callback restrictions
- `packages/workshop-backend/src/agent.ts`: direct-chat rendering instructions after tool results
- `packages/workshop-backend/src/auto-approval.ts`: joinable single-flight approval draining
- `packages/workshop-shared/src/api.ts`: model context and output-limit configuration
- `packages/gatekeeper-jarvis/`: fixed-policy JARVIS MCP gatekeeper
- `packages/workshop-frontend/src/routes/getting-started.tsx`: live deployment readiness guide
- Team PI `src/platform/odie-codex-proxy.ts`: HMAC verification, replay claim, and forwarding contract
- Jarvis `dashboard/server/internal/api/team_pi_codex_bridge.go`: streaming bridge
- Jarvis `helm/codex-lb/values-prod.yaml`: codex-lb production values
- Jarvis `helm/codex-lb/README.md`: backup, migration, and rollback procedure

The Team PI working copy used during rollout was
`/var/folders/5q/r1rw9tjx4pl2phchr2rhc_lm0000gp/T/opencode/team-pi-odie`.

## Verification

Source verification completed:

```text
pnpm exec vitest run __tests__/ai-models.test.ts  # 27 passed
pnpm exec tsc --noEmit                            # passed
pnpm exec oxlint src/ai-models.ts __tests__/ai-models.test.ts  # passed
pnpm run build:worker                             # passed
pnpm lint:check                                   # passed with existing warnings
```

Additional focused verification completed:

```text
JARVIS gatekeeper tests                           # 21 passed
Getting Started route tests                       # 5 passed
Auto-approval and managed Codex focused tests     # 31 passed
Release-manifest golden test                      # passed
```

The full backend `pnpm test` command passed 25 unit suites and 286 tests after the local
`@gadgets/typed-storage` package was built. The environment-dependent integration suite was skipped
(one suite, four tests).

Production verification completed:

- Unauthenticated public request returned HTTP 302 to Cloudflare Access.
- Direct backend hostname returned HTTP 404.
- Fresh signed relay request returned HTTP 200 SSE.
- Fresh UI conversation returned `10 plus 6 equals 16.`.
- A second invocation in the same conversation returned `11 plus 7 equals 18.`, verifying replay
  IDs are unique per invocation while chat affinity remains stable.
- `/getting-started` loaded through Cloudflare Access and detected the JARVIS singleton.
- JARVIS knowledge reads, a manually approved investigation, and investigation-result observation
  reached production.
- After two transient HTTP 502 responses and a stale-workspace continuity-owner error, a new
  workspace returned `MODEL ROUTE HEALTHY`, confirming the managed model route itself was healthy.
- In that fresh workspace, one JARVIS investigation was approved, the resumed agent polled
  `JARVIS.getActionResult`, and the full terminal payload appeared as a normal assistant message
  without opening activity details.

This completes the planned production end-to-end verification.

Production verification still outstanding:

- Delete smoke workspaces `fd640e6de6334db7feadffd37612d156bb22ddc829acdfc10025d8643e97f941`,
  `a1a2691b23b2c02d1ecf17340b9f40706fd0a0d16682f873bb223643121a255e`,
  `3e0ff780c8089cab4a37618301f64e32ac56e1a54a34faae82fe9a7939a71c87`,
  `5c4c28ae2ec8b67a01973555267c50c6b4a9fb044e63c8e9cc7a65701f620051`,
  `49ce210b2aa9c77aaffc56ca3c0a900390108ffbb884621aefb4be52b22b9670`,
  `a975232c9d55d7a8971a00f4ab721d86e074be04c242849956ead2fa7c2d5816`,
  `228817008075d7ff5656d44842c8880444dfa4e9e007e5f842f1c1d16752558a`,
  `9f00798ea27f03ee66ed56d520e93a5639dcc247523d2607c63c5ae77dae45e9`,
  `ee31bd76e81992632af800616956a9202bd44119c2f802c28071675b1f8a1c2b`,
  `d5c6fcd17a3e8030228557cdfd6d26562a562e9664b81aa16ccac3ebaf3e8093`,
  `91770586bcde0c4bafba9a2f0eeb13f50c0f0d61a68ebe36b12c6930888939c8`,
  `0ee0060b45d117d72042f9ffe498dcc457505ba7fddf159fde423d2f75b2a207`, and
  `04f4c4844271890f878be50dad803bd6a9d93a4f9bb3f2dc22387da2111ed62a` once E2E is complete.

Unresolved defect worth investigating before wider rollout:

- Workspace `0ee0060b45d117d72042f9ffe498dcc457505ba7fddf159fde423d2f75b2a207` accumulated three
  duplicate `Start Team PI connection gmail` requests, staged roughly sixteen minutes apart while
  its browser WebSocket was broken. Every subsequent decision on that workspace fails: both approve
  and deny return `internal error` from the backend, so the requests cannot be cleared from the UI.
  A workspace created afterwards staged exactly one request and approved normally, so this is not a
  general regression. Root cause is unconfirmed because reading production Worker logs needs
  interactive AWS MFA. Two candidate causes: the workspace holds a Team PI facet capability that was
  orphaned when the account was disconnected and reconnected mid-session, or the duplicate stagings
  left the facet's action records inconsistent with the ids the Overseer recorded. Keep this
  workspace until the cause is understood; deleting it destroys the only reproduction.

Known upstream issues observed during verification, outside this deployment's control:

- `TEAM_PI.chorusSearch` returns `Unauthorized`. Team PI holds Chorus as a token-scoped connection,
  so this is a provider credential problem on the Team PI side, not a gatekeeper defect.
- The managed model route intermittently returned HTTP 502/504 and
  `codex-lb is temporarily overloaded`. Retry is safe only when the failure happened before an
  action was staged; after a staged or approved action, ask the agent to render the existing result
  instead of retrying, so the write is not duplicated.
- Odie now bounds each Team PI model request to five minutes and fails a response stream after two
  minutes without bytes. These failures produce a durable, user-visible transient error instead of
  leaving the turn active indefinitely. Automatic replay remains disabled because a timeout after
  upstream dispatch has an ambiguous outcome; the existing Retry action starts a new model turn.
- A long-lived workspace returned `Required continuity owner is outside the eligible account policy`
  while fresh workspaces succeeded. Treat this as stale per-conversation affinity and start a new
  workspace rather than changing account policy.

## Deployment Notes

The hosted deployment wizard owns the normal Odie release installation. The Totango backend patch
was deployed separately because it is not part of upstream release `dev-tjd58j`.

For any manual backend deployment, first reconstruct a Wrangler config from the current Worker's
live settings and verify every binding listed above. Keep existing environment values and secrets.
Do not deploy the repository's generic `packages/workshop-backend/wrangler.jsonc` directly to
production because it does not describe the instance-specific resource IDs.

The production Wrangler configs used for this rollout are deliberately not in the repository, so the
worktree carries no instance-specific deployment state. They were moved to
`~/.config/odie-os/wrangler/` on the deploying machine, one file per package, named after the path
they came from. They are kept rather than deleted because rebuilding them by hand risks omitting a
binding — a backend deploy that silently drops KV, R2, Durable Object, browser, Workers AI, loader,
or gatekeeper service bindings is far more damaging than a stale file. Copy the relevant file back
into its package before deploying, verify every binding listed above against the live Worker, and
remove it again afterwards.

At handoff, the transport hardening, gatekeepers, Getting Started route, and approval-result changes
are deployed but uncommitted. Commit or open a PR before treating the Git repository as the durable
source of the live Workers.

The prepared JARVIS MCP annotation changes in the ODI control-plane repository pass
`go test -count=1 ./internal/jarvismcp` and `gofmt`, but are not deployed. That repository deploys
production from `main`, so rollout requires an explicit commit/push. Independent review found no
annotation regression, but noted pre-existing hardening opportunities in the knowledge handlers:
defensive rejection when no store is wired, hard repository filtering, fixed incident-kind
filtering, and consistent invalid-argument responses.

## Rollback

For an Odie backend regression, use Cloudflare Workers version rollback to the last known working
version. Version `70aaebc0-e93c-4136-a3ae-c355cdce3270` contains the original working zstd adapter
but lacks size limits and the per-invocation replay-ID fix, so it is emergency-only. Prefer rolling
forward from reviewed source.

For codex-lb database or chart rollback, follow `helm/codex-lb/README.md`. The validated pre-1.22.0
PostgreSQL backup is:

```text
/var/folders/5q/r1rw9tjx4pl2phchr2rhc_lm0000gp/T/opencode/codex-lb-pre-1.22.0-20260806.dump
SHA-256: aefd342e57e74cd966f58dabfe6a7ccbd93ebc259e466148b0236806b324ddcc
```

The file was mode `0600` and approximately 18 MiB at verification time.

## Troubleshooting

### `unsupported content encoding "zstd"`

Odie forwarded pi-ai's compressed request directly. Confirm the deployed `ai-models.ts` decodes
zstd, forwards identity encoding, and hashes the decoded body.

### `Request already processed`

The same `x-client-request-id` reached Team PI twice. Confirm Odie generates the ID once inside
`makeTeamPiCodexFetch()`, not from the stable `session-id`. A retry may intentionally reuse the ID;
a new model invocation must not.

### `Upstream stream idle timeout`

The signed Odie request passed Team PI authentication but no SSE data arrived before the relay idle
deadline. Run a fresh signed relay smoke with a new request ID, then inspect Team PI, Jarvis, and
codex-lb health. Odie applies the same two-minute no-byte bound to the response body and displays a
retryable transient error when it fires. Do not retry with a previously claimed request ID when
isolating the failure.

### Managed model is missing

Check `TEAM_PI_CODEX_BASE_URL`, `TEAM_PI_CODEX_HMAC_SECRET`, and `TEAM_PI_CODEX_MODELS`. Also verify
the user is a verified `@totango.com` identity and password login is disabled.

### Browser reports Durable Object reset

A Worker deployment resets active Durable Object connections. Reload the Odie page after deploy
before running an authenticated UI smoke.
