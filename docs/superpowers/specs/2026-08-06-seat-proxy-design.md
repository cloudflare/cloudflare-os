# Seat proxy: subscription-seat auth for Cloudflare OS

**Date:** 2026-08-06
**Status:** Approved, not yet implemented

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
| Standalone Python/FastAPI service, not a Worker or Odysseus routes | Reuses `chatgpt_subscription.py` and `device_flow.py` almost verbatim; survives Odysseus being retired; a Worker egress is a poor place to discover the Codex backend cares about client headers. |
| Relay handles, not stored tokens | Cloudflare OS stores an opaque handle in `AiModelConfig.apiToken`. Real tokens stay in the proxy. Revocation is deleting one row. |
| Reuse `apiUrl` rather than a new provider type | `AiModelConfig.apiUrl` is documented for "an alternative provider that provides a compatible API" (`packages/workshop-shared/src/api.ts:945-948`). Adding to the `AiModelProvider` union would fork the type most likely to churn upstream. |
| Enrollment routed browser → OS backend → proxy | Keeps the proxy off the public internet, binds each handle to an authenticated OS user, and keeps the handle out of the browser. |

Rejected: a native seat provider inside the fork (puts refresh tokens in Cloudflare OS storage and
forks the provider union); enrollment on a proxy-hosted page (rejected by the user in favour of
in-product sign-in).

## Architecture

Two deployable units per instance.

### 1. `seat-proxy` (new, Python/FastAPI)

**Enrollment surface**

| Endpoint | Purpose |
|---|---|
| `POST /enroll/{provider}/start` | Begin device flow. Returns `{verification_uri, user_code, poll_id}`. |
| `POST /enroll/{provider}/poll` | Poll for completion. On success stores tokens, mints a handle, returns `{handle, models[]}`. |
| `GET /enroll/{provider}/models` | Models available to that seat. |
| `DELETE /enroll/{handle}` | Revoke. |

**Relay surface**

| Path | Reads handle from | Forwards to |
|---|---|---|
| `/anthropic/*` | `x-api-key` | `https://api.anthropic.com` |
| `/openai/*` | `Authorization: Bearer` | `https://chatgpt.com/backend-api/codex` |

**Store:** `handle → {provider, owner, access_token, refresh_token, expires_at, needs_reauth}`,
encrypted at rest via Odysseus's `secret_storage.py` approach.

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
2. `startSeatAuth("anthropic")` → backend → proxy `POST /enroll/anthropic/start`.
3. UI shows the device code and link. The user authenticates on the provider's own page;
   no credential is entered into Cloudflare OS or the proxy.
4. Frontend polls `pollSeatAuth(poll_id)`. On success the proxy stores the token pair and returns
   a handle plus the seat's model list.
5. User picks a model; backend calls the existing `addModel`.

### Inference (every request)

1. `getModel(config)` → `getModelDirect` → `baseUrl = <proxy>/anthropic`, `apiKey = <handle>`.
2. SDK POSTs `/v1/messages` with `x-api-key: <handle>`, `anthropic-version`, `stream: true`.
3. Proxy resolves handle → owner + tokens; refreshes if inside the expiry skew, under a
   **per-handle** lock. (`_refresh_lock_for` is already shaped for this; it must key on handle
   rather than a single auth id now that it is multi-user.)
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

**The Anthropic device-flow client_id is unknown.** OpenAI's is known from Odysseus
(`app_EMoamEEZ73f0CkXaXp7hrann`); there is no published Anthropic equivalent, and no Claude seat
implementation exists in either repo. Everything else depends on it.

*Mitigation:* spike it first — a throwaway script that completes the device flow and makes one
authenticated `/v1/messages` call. If it cannot be made to work, approach C is dead for Anthropic
and only the OpenAI leg proceeds. Build nothing else until this resolves.

**Terms of service.** Subscription seats are sold for use with the provider's own clients. Routing
a third-party workspace through seat OAuth sits outside that. Raised and accepted by the user; a
Console API key remains the sanctioned path and continues to work unchanged.

## Sequencing

1. Spike the Anthropic device flow. Gate on the result.
2. `seat-proxy` skeleton: store, handle minting, per-handle refresh lock.
3. Anthropic relay leg + contract tests.
4. OpenAI relay leg (port `chatgpt_subscription.py`) + contract tests.
5. Cloudflare OS fork: RPC methods, then the two UI entry points.
6. End-to-end against the home instance, then work deployment.
