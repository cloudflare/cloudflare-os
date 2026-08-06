# Seat proxy: subscription-seat auth for Cloudflare OS

**Date:** 2026-08-06
**Status:** Approved. Relay core and error shapes shipped (`errors.py`, `relay.py`); store and
refresh being reshaped for the CLI-piggyback pivot; enrollment and app wiring not yet built.

## Problem

Cloudflare OS authenticates AI providers with API keys only. `getModelDirect`
(`packages/workshop-backend/src/ai-models.ts:483-503`) builds the Anthropic handle with
`apiKey: config.apiToken`, which the official `@anthropic-ai/sdk` (via
`@earendil-works/pi-ai@0.83.0`) sends as `x-api-key`. Subscription seats — Claude Max/Pro and
ChatGPT/Codex — authenticate with OAuth bearer tokens that expire and must be refreshed, and
Anthropic additionally requires the `anthropic-beta: oauth-2025-04-20` header.

We want both seat types usable from Cloudflare OS, at two sites (a private home instance and a
self-hosted work instance) with identical mechanics, and with per-user credentials.

## Goals

- Per-user seats for both Anthropic and OpenAI. Each user connects their own.
- Real OAuth tokens never stored in Cloudflare OS.
- Enrollment happens inside the Cloudflare OS UI ("Sign in with…" buttons), not on a side page.
- One artifact, deployed once per instance, identical at home and at work.
- Seats work everywhere models work: chat, agents, and gadget LLM bindings.

## Non-goals

- Production deployment of Cloudflare OS itself. Upstream has not shipped workerd self-hosting
  (README, "Deploy to your own server using `workerd`" — COMING SOON). Until it does, both
  instances run under `wrangler`. This gates rollout, not this design.
- Replacing API-key auth. Users who paste a Console key keep working unchanged.
- Retrieval, RAG, or company-data integration. Tracked separately.

## Decisions

| Decision | Rationale |
|---|---|
| Standalone Python/FastAPI service, not a Worker or Odysseus routes | Survives Odysseus being retired; a Worker egress is a poor place to discover the Codex backend cares about client headers. |
| Relay handles, not stored tokens | Cloudflare OS stores an opaque handle in `AiModelConfig.apiToken`. Real tokens stay outside it. Revocation is deleting one mapping. |
| Reuse `apiUrl` rather than a new provider type | `AiModelConfig.apiUrl` is documented for "an alternative provider that provides a compatible API" (`packages/workshop-shared/src/api.ts:945-948`). Adding to the `AiModelProvider` union would fork the type most likely to churn upstream. |
| Enrollment routed browser → OS backend → proxy | Keeps the proxy off the public internet, binds each handle to an authenticated OS user, and keeps the handle out of the browser. |
| **Piggyback the provider CLIs; no OAuth flow of our own** | Established by `C:\Developer\OpenWhisperer`, which authenticates by reading the Claude Code CLI's credentials rather than running a login. Removes the entire device-flow problem, including the unknown client_id that previously gated the project. |
| **Per-user seats via per-user CLI config directories** | The CLIs already support it: `CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex (`OpenWhisperer/src-tauri/src/config/accounts.rs:4-7, 49-84`). One enrollment story covers both providers. |
| **The CLI credentials file is authoritative** | The CLI rotates tokens on its own schedule. A second copy in the proxy would drift, go stale, or fight the CLI. The proxy reads on demand and mirrors rotations back, as OpenWhisperer does (`sdk_cmds.rs:634-660`). |
| **One process now, per-user worker processes later** | Per-user isolation is the better end state — a single process holding N employees' refresh tokens means one bug exposes every seat, and refresh tokens are durable credentials whose rotation costs every user a re-login. But isolation only becomes real when workers run as distinct OS users with `0700` directories, which is a deployment change, not a code rewrite. The `handle → user` indirection is the seam; splitting later is a dispatch change. |

Rejected: a native seat provider inside the fork (puts refresh tokens in Cloudflare OS storage and
forks the provider union); enrollment on a proxy-hosted page (rejected in favour of in-product
sign-in); the proxy owning its own token copy (drifts against the CLI); users pasting credentials
JSON by hand (clunky, and asks people to hand over a durable refresh token by copy-paste).

### Known-good Anthropic values

Verified against working code in `OpenWhisperer/src-tauri/src/commands/sdk_cmds.rs:482-489, 580-660`:

- client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public OAuth client)
- token endpoint `https://console.anthropic.com/v1/oauth/token`
- refresh is a JSON POST of `{grant_type: "refresh_token", refresh_token, client_id}` — public
  client, no secret
- request headers `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/2.0.32`
- credentials live at `<CLAUDE_CONFIG_DIR>/.credentials.json` under a `claudeAiOauth` key holding
  `accessToken`, `refreshToken`, `expiresAt` (epoch ms)

## Architecture

Two deployable units per instance.

### 1. `seat-proxy` (new, Python/FastAPI)

**Enrollment surface**

| Endpoint | Purpose |
|---|---|
| `POST /enroll/{provider}/start` | Allocate the user's config directory and return the exact CLI command they must run (`CLAUDE_CONFIG_DIR=<dir> claude login`, or `CODEX_HOME=<dir> codex login`) plus a `poll_id`. |
| `POST /enroll/{provider}/poll` | Check whether the credentials file has appeared and parses. On success mints a handle and returns `{handle, models[]}`. |
| `GET /enroll/{provider}/models` | Models available to that seat. |
| `DELETE /enroll/{handle}` | Revoke: drop the mapping and delete the user's config directory. |

The user authenticates entirely inside the provider's own CLI. The proxy never sees a password
and never runs an OAuth flow — it waits for a credentials file to appear in a directory it owns.

**Relay surface**

| Path | Reads handle from | Forwards to |
|---|---|---|
| `/anthropic/*` | `x-api-key` | `https://api.anthropic.com` |
| `/openai/*` | `Authorization: Bearer` | `https://chatgpt.com/backend-api/codex` |

**Store:** `handle → {owner, provider, config_dir, needs_reauth}`. No tokens: the CLI credentials
file inside `config_dir` is authoritative. The store is a routing map, and `config_dir` is what
makes the later split into per-user workers a dispatch change rather than a rewrite.

### 2. Cloudflare OS fork

Structured so the feature's code lives in **new files**, and the files upstream is actively
rewriting take only one-line touchpoints. Git never conflicts on a file upstream does not have,
so this keeps rebase cost proportional to the touchpoints rather than to the feature's size.

**New files (no merge cost, any size):**

- `packages/workshop-shared/src/seat-types.ts` — `SeatProvider` and the enrollment DTOs.
- `packages/workshop-backend/src/seat-auth.ts` — all proxy communication, polling, and handle
  lifecycle.
- `packages/workshop-frontend/src/SeatSignInButtons.tsx` — the two buttons and the device-code
  UI, self-contained.

**Touchpoints in existing files (keep minimal):**

| File | Edit |
|---|---|
| `packages/workshop-shared/src/api.ts` | Three method signatures on `AuthenticatedApi`; type imported from `seat-types.ts`. |
| `packages/workshop-backend/src/server.ts` | Three one-line delegates into `seat-auth.ts`. |
| `packages/workshop-frontend/src/AddModelModal.tsx` | One line mounting `<SeatSignInButtons/>`. |
| `packages/workshop-frontend/src/OnboardingWizard.tsx` | One line mounting the same. |
| `run-dev-server.js` | Add `SEAT_PROXY_URL` to `OPTIONAL_FEATURE_VARS` (`run-dev-server.js:241-254`). |

`api.ts` and `server.ts` are core and churning upstream; the discipline matters most there. This
constraint exists only while the fork tracks upstream — if that stops, it can be dropped.

`revokeSeat` is called from the existing model-deletion path: when a user deletes a seat-backed
model, the backend revokes the handle before removing the config, so no orphaned tokens are left
in the proxy.

Changes must stay strictly additive. Upstream is under heavy development and does not accept
contributions, so every edited line is permanent merge friction.

On success the backend writes an ordinary config through the existing `addModel`:

```
{provider: "anthropic", model, apiToken: <handle>, apiUrl: "<SEAT_PROXY_URL>/anthropic"}
```

Below `AiModelConfig` nothing changes. `ai-models.ts`, the chat loop, and
`LanguageModelGatekeeper` (`ai-models.ts:606`) are untouched, and all three resolve through the
same config — which is why seats reach chat, agents, and gadget bindings for free.

## Data flow

### Enrollment (once per user, per provider)

1. User clicks "Sign in with Anthropic".
2. `startSeatAuth("anthropic")` → backend → proxy `POST /enroll/anthropic/start`. The proxy
   allocates `<state>/users/<owner>/anthropic/` (mode `0700`) and returns the CLI command to run.
3. UI shows the command. The user runs it and authenticates inside the provider's own CLI. No
   credential is entered into Cloudflare OS or the proxy.
4. Frontend polls `pollSeatAuth(poll_id)`. Once `.credentials.json` appears and parses, the proxy
   mints a handle bound to that directory and returns it with the seat's model list.
5. User picks a model; backend calls the existing `addModel`.

### Inference (every request)

1. `getModel(config)` → `getModelDirect` → `baseUrl = <proxy>/anthropic`, `apiKey = <handle>`.
2. SDK POSTs `/v1/messages` with `x-api-key: <handle>`, `anthropic-version`, `stream: true`.
3. Proxy resolves handle → owner + `config_dir`, reads `.credentials.json`, and refreshes if
   inside the expiry skew, under a **per-handle** lock. Rotated tokens are written back to the
   same file so the user's CLI stays in sync.
4. Proxy strips `x-api-key`, sets `Authorization: Bearer <access>` and
   `anthropic-beta: oauth-2025-04-20`, forwards upstream.
5. SSE streams back **unbuffered** via `httpx.stream` into a `StreamingResponse`. Buffering would
   destroy token-by-token output; this is a correctness requirement.

The OpenAI leg is the same shape with `chatgpt_headers()`'s `Origin`/`Referer`/`User-Agent` set.
It is the riskier leg: Cloudflare OS emits stock Responses payloads, and `build_responses_input`
exists in Odysseus precisely because the Codex backend does not accept them verbatim. Expect real
translation work here.

## Error handling

| Condition | Behavior |
|---|---|
| Refresh token dead/revoked | Mark handle `needs_reauth`, return 401. UI shows "reconnect your seat". |
| Unknown/revoked handle | 401. This is the revocation enforcement point. |
| Upstream 429 / quota | Pass through untouched — status and headers intact — so existing backoff sees the truth. |
| Upstream 5xx | Pass through unchanged. |
| Proxy unreachable | Only seat-backed models fail. API-key users unaffected. |
| Concurrent refresh | Per-handle lock; other requests await the winner's token. |

The proxy's own errors must use the upstream provider's error shape —
`{"type":"error","error":{...}}` for Anthropic, the OpenAI shape for the other leg. FastAPI's
default `{"detail": ...}` is parsed by the Anthropic SDK as a malformed response, surfacing an
unintelligible error instead of "reconnect your seat".

Never log handles or tokens. Owner, provider, status, and latency only.

## Testing

- **Unit** — handle resolution; refresh-on-expiry against a frozen clock; per-handle locking under
  concurrency; error-shape mapping.
- **Contract** — mock upstream (`httpx.MockTransport`) asserting exact outbound headers:
  `x-api-key` stripped, bearer and `anthropic-beta` present, `Origin`/`Referer` set on the Codex
  leg. This test protects the whole design.
- **Streaming** — assert chunks arrive incrementally, guarding against a later "simplification"
  into a buffered read.
- **End-to-end** — `run-local` plus the proxy: enroll, send a message, watch tokens stream. Manual
  initially, as it needs a live seat.

## Risks

**~~The Anthropic device-flow client_id is unknown.~~ RESOLVED** — superseded by the CLI-piggyback
decision. No device flow is needed, so no client_id has to be discovered. The spike is cancelled.

**Coupling to CLI internals.** The credentials file path, its `claudeAiOauth` JSON shape, and the
`CLAUDE_CONFIG_DIR`/`CODEX_HOME` env vars are not public API. A CLI update can change any of them
and break enrollment or refresh.

*Mitigation:* parse defensively and fail with "reconnect your seat" rather than a stack trace when
the shape is unexpected. Pin the observed shape in a test fixture so a change surfaces as a test
failure. Accept that CLI upgrades are a maintenance event.

**Enrollment requires shell access to the proxy host.** Each user must run a CLI command in a
directory the proxy owns. Fine for the home instance and for a technical team; a real constraint
for non-technical users at work, who will need someone to run it for them.

**Terms of service.** Subscription seats are sold for use with the provider's own clients. Reading
the CLI's own credentials on a machine where the user has legitimately logged in is closer to the
line than driving a login flow ourselves, but relaying those tokens to a separate multi-user
workspace still sits outside what the seat is sold for. Raised and accepted by the user; a Console
API key remains the sanctioned path and continues to work unchanged.

**Per-user isolation is deferred.** Until workers run as distinct OS users, one process reads every
user's credential directory, so a single relay bug exposes all seats. Accepted deliberately; see
the decisions table.

## Sequencing

1. ~~Spike the Anthropic device flow.~~ Cancelled — no device flow needed.
2. ✅ `seat-proxy` skeleton: store, error shapes, per-handle refresh lock, relay core.
   Built and reviewed; `errors.py` and `relay.py` stand unchanged after the pivot.
3. Reshape `store.py` to a `handle → {owner, provider, config_dir}` map, and repoint
   `refresh.py` at the CLI credentials file with write-back.
4. Anthropic credential reader + refresh against the known-good values above.
5. OpenAI/Codex reader + refresh via `CODEX_HOME`, same shape.
6. Enrollment endpoints and app wiring.
7. Runnable service, then end-to-end against the home instance.
8. Cloudflare OS fork (Plan 2): RPC methods, then the two UI entry points.
9. Later, when scale justifies it: split into per-user workers running as distinct OS users.
