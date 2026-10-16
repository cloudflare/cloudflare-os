# Migrating from the Vercel AI SDK to pi-ai + pi-agent-core: implementation playbook

Attachment follow-up: the original provider-input restrictions below no longer govern upload
acceptance. [All uploaded files enter the chat's scratch worktree](../docs/chat-scratch-worktree.md)
byte-for-byte, subject to the 4 MiB/file limit; source images are no longer resized to fit.
Model requests inline only inputs supported by their adapter (including supported images with
recognized dimensions no larger than 8000 pixels per edge) and valid text. Other uploads are
identified by workspace path on both the initial request and subsequent replay, not rejected
or decoded lossily. Binary worktree changes use ordinary Git blobs and whole-file OTs.

*Companion to `plans/pi.md` (feasibility). This is a direct implementation guide for a coding
agent: all design decisions are made; implement the whole thing in one pass. The project is in
early alpha — minor behavioral regressions are acceptable and will be fixed as discovered. Do
not build parallel/intermediate implementations, compatibility shims for the old path, or
elaborate test harnesses.*

**Reference materials:** `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`
(0.83.0, exact-pinned) are already installed in `packages/workshop-backend`. The installed
packages are the API reference: complete `.d.ts` declarations for signatures, plus
unbundled, unminified per-module dist JS (doc comments preserved) for behavior — read
`node_modules/@earendil-works/pi-ai/dist/**` and
`node_modules/@earendil-works/pi-agent-core/dist/**` directly. (Source maps embed
`sourcesContent` if the original TypeScript is ever needed.) The appendix (§9) summarizes
what was verified at plan-writing time; the installed source is authoritative.

## 1. Fixed decisions

These are settled; do not re-litigate during implementation.

1. **Scope:** Phase 1 only — full replacement of the AI SDK layer, chat log format and
   frontend untouched. Phase 2 items (steering, immediate cost display, custom message
   types, PDF bridge) are follow-ups (§8).
2. **Loop:** pi-agent-core's low-level `runAgentLoopContinue` (awaited event sink), not the
   stateful `Agent` class. `toolExecution: "sequential"`. `convertToLlm` = identity.
   No steering/follow-up queues. Turn cap 30 via `shouldStopAfterTurn`.
3. **Anthropic caching:** pi's automatic behavior, default `cacheRetention` (`"short"`).
   No custom breakpoint logic of any kind; delete today's `prepareStep` strategy. Assume
   pi does it right.
4. **System prompt:** the two slots concatenate into pi's single `Context.systemPrompt`
   string, static slot first (preserves prefix stability). Keep the two-part construction
   in code.
5. **Errors:** pi never throws for provider failures; `runAgent` converts an
   error/aborted-stop into a thrown error for the overseer (§4.5). Match today's behavior
   in spirit, not in detail — do the most reasonable thing. Partial content from a failed
   turn is not persisted. If the abort signal fired, rethrow the abort so cancellation
   looks like today.
6. **Attachments:** first commit supports text + image only, for every provider
   (pi has no file/document part). Replayed history containing other attachment types
   degrades to a text marker instead of failing (§4.4). PDF bridge is a follow-up (§8).
7. **Cloudflare routing:** pi is verified fetch-only (no Workers-binding support), so all
   inference moves to HTTPS with tokens — including same-account AI Gateway and Workers AI,
   which today use the `WORKERS_AI` binding (§4.2). Structure the code so a binding-backed
   path can return later via pi's injected `fetch` (upstream ask filed; see §8). The
   `WORKERS_AI` binding itself **stays** — it's still used by webFetch's
   document-to-Markdown conversion, and by the binding arm of `getAiGatewayLogCost`
   (which becomes normally-unreachable under pi but is kept for the binding's return).
   Cost fetching itself is already dual-route since the `AiGatewayLogRoute` change:
   `getAiGatewayLogCost` in ai-gateway.ts supports the REST API with a Bearer token —
   under pi, all produced log routes are the token variant, so cost accounting keeps
   working (including for BYOK).
8. **OpenAI** uses pi's `openai-responses` API (matches today's Responses-API +
   `store: false` + encrypted-reasoning behavior — preserve statelessness; see §9 compat
   flags). **Ollama** uses `openai-completions` against the server's OpenAI-compat
   endpoint: interpret `AiModelConfig.apiUrl` as the Ollama server base and append `/v1`.
9. **Model metadata:** `SUGGESTED_MODELS` (workshop-shared) remains authoritative for
   `contextWindow`/`outputLimit` (compaction budgets must not change). pi's generated
   catalog may be consulted for cost/compat of known models; unknown models get a
   synthesized `Model` with zero cost.
10. **BYOK unified billing:** the user's default gateway `/compat` endpoint with compound
    `{provider}/{model}` ids over `openai-completions` — functionally what
    `createUnified()` does today.
11. **Testing:** `pnpm build` + `pnpm lint` + `pnpm test` must pass; verification beyond
    that is a manual smoke checklist (§7). No parity harness, no new automated test
    suites. However, `workshop-backend/__tests__/` now has real unit tests:
    `ai-models.test.ts` mocks `ai-gateway-provider`/`workers-ai-provider` (packages this
    migration deletes) and must be **rewritten against the pi implementation**, preserving
    the behavioral contract it encodes (routing precedence incl. BYOK-over-platform,
    metadata content, log-route selection, `CF_AI_GATEWAY_WAI`/`WAI_DIRECT` conflict
    rules). Tip: with pi, no module mocks are needed — assert on the returned handle's
    `model` (baseUrl/id/api) and drive `handle.stream` with an injected `options.fetch`
    stub to assert URLs/headers. `ai-gateway.test.ts` / `ai-gateway-cost.test.ts` /
    `web-fetch.test.ts` test AI-SDK-free code and should pass unchanged or nearly so.
12. **`nodejs_compat`:** pre-authorized — if pi or the SDKs it wraps need it, add
    `nodejs_compat` to both `wrangler.jsonc` and `wrangler.dev.jsonc` (replacing
    `nodejs_als`, which it subsumes).
13. **Keep `streaming-json-parser.ts`.** pi's `toolcall_delta` provides the same raw JSON
    fragments the parser already consumes; pi's own partial-JSON helper reparses from
    scratch per delta (O(n²) on big file writes). Preview managers stay as-is.
14. **One commit** (or one small stack if `git add -p` hygiene demands), plus the follow-up
    commits in §8. No requirement that intermediate states build.

## 2. Invariants — do not change

- `AiChatMessage` / `AiToolCall` / `AiChatStreamEvent` and everything else in
  `workshop-shared/src/api.ts` (except nothing — this package should have **zero diff**).
- The Overseer turn lifecycle: `startAgent`, `#runAgentTurnWithContext`'s loop/nudge/
  callback logic, `activeAgents` resume, compaction commit/rollback, `awaitDecision`
  suspension. Only its error-classification `catch` and the `getModel` call change.
- Replay **logic** in `runAgent`: merge/revert status pass, version locks,
  `pendingReplayEdits`, crashed-turn re-adoption (creations/binding additions), binding
  accumulation, `PARAMS_n` allocation, revert elision, `changeIdMap`. Only the *shapes
  pushed into the model context* change.
- Compaction policy (`agent-compaction.ts` boundary/checkpoint logic) — only projection
  types and the summarization call change.
- `CodePreviewManager`, `ExecuteCodeStreamManager`, `streaming-json-parser.ts`.
- Frontend: zero changes.

## 3. Dependencies and configuration

`packages/workshop-backend/package.json`:

- Remove: `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`,
  `ai-gateway-provider`, `workers-ai-provider`, `ollama-ai-provider-v2`, and `zod`
  (verify zod has no remaining uses after the tool rewrite).
- Already added (exact pins, 0.83.0): `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`. (Note: pnpm reported ignored build scripts for
  `@google/genai`/`protobufjs` — expected; do not `pnpm approve-builds` unless something
  actually breaks at runtime.)
- Import only from: `@earendil-works/pi-ai` (core), specific
  `@earendil-works/pi-ai/providers/*` modules if used, `@earendil-works/pi-ai/api/*`
  modules, and `@earendil-works/pi-agent-core`. Never `providers/all` (~30 providers in
  the bundle), never `/compat` (side effects), never `pi-agent-core/node`.

Environment variables. The recent AI Gateway auth-token work (see `AiGatewayConfig`,
env.d.ts) already established `CF_AI_GATEWAY_ACCOUNT_ID` / `CF_AI_GATEWAY_API_TOKEN`
(a Run + Read token — it also drives cost-log reads), enforced as a pair, and added
`CF_AI_GATEWAY_WAI_DIRECT` (mutually exclusive with `CF_AI_GATEWAY_WAI`). The pi migration
tightens this (update env.d.ts comments, README/docs, and
`run-dev-server.js`/`generate-wrangler-prod.js` if they template these):

- `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_API_TOKEN` become **required** whenever
  `CF_AI_GATEWAY` is set — the token-less same-account mode existed only because of the
  Workers binding, which pi can't use. Make `AiGatewayConfig`'s constructor throw (or
  `getAiGatewayConfig` return null with a loud log) when they're absent.
- `CF_AI_GATEWAY_WAI` / `CF_AI_GATEWAY_WAI_DIRECT` keep their merged semantics, mapped to
  pi endpoints: `workersAiGateway` set → Workers AI through the gateway's `/compat`
  endpoint (compound `workers-ai/{model}` id; log route + gateway metadata apply);
  `WAI_DIRECT` (i.e. `workersAiGateway === undefined`) → the plain Workers AI REST
  endpoint `api.cloudflare.com/client/v4/accounts/{acct}/ai/v1` — no gateway, no log
  route, no gateway metadata (mirroring the merged behavior where the direct-binding path
  returns a model with no `aiGatewayLogRoute`). The direct path reuses the
  `CF_AI_GATEWAY_*` account/token pair.
- Direct Workers AI with **no** gateway mode at all (provider `"cloudflare"` outside
  gateway mode): needs REST credentials — new `CLOUDFLARE_ACCOUNT_ID` /
  `CLOUDFLARE_API_TOKEN` env vars, falling back to the `CF_AI_GATEWAY_*` pair. If neither
  is available, `getModel` throws a clear "Workers AI now requires API credentials" error.

Bundling check: after `pnpm install`, confirm the worker bundles without pulling pi's
Bedrock module (its Node-only deps sit behind a variable-specifier dynamic import that
bundlers can't follow — expect at most a warning). If esbuild chokes on the dynamic import,
mark it external or alias it out.

## 4. Implementation guide

(`file.ts:NNN` references are approximate — the AI Gateway auth-token change shifted some
line numbers; locate by symbol name.)

### 4.1 `ai-invoke.ts` (new, small)

pi streams never reject; adapt to throwing callers once:

```ts
export type ModelHandle = { /* §4.2 */ };
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  prompt?: string;               // convenience: wraps into a single user message
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string>;
```

Implementation: `handle.stream(handle.model, context, options).result()`; if
`stopReason` is `"error"`/`"aborted"`, throw (include `errorMessage`); else return
concatenated text content. Used by title generation, binding naming, compaction summary,
and `LanguageModelBindingImpl.run`.

### 4.2 `ai-models.ts` — rewritten

Replace the AI SDK provider stack with pi. Export:

The current code (after the AI Gateway auth-token change) exposes
`getModel(env, config, initiator, options: ModelRoutingOptions)` and
`getModelWithLogRoute(...)` returning `{model, aiGatewayLogRoute?}`, where
`ModelRoutingOptions = {sessionAffinity?, userGateway?, metadata?: GatewayMetadataContext}`.
Keep that outer shape; the handle absorbs the log route:

```ts
export type ModelHandle = {
  model: Model<Api>;     // pi model descriptor
  stream: StreamFn;      // (model, context, options) => AssistantMessageEventStream
                         // closes over routing/auth; merges per-API options; never throws
  aiGatewayLogRoute?: AiGatewayLogRoute;  // for cost accounting; replaces
                                          // getModelWithLogRoute's second return + the
                                          // aiGatewayLogRoute parameter of runAgent
  // plus whatever mechanism surfaces the last response's cf-aig-log-id and HTTP status
};
export function getModel(env, config: AiModelConfig, initiator: AiChatAuthorInfo,
                         options: ModelRoutingOptions = {}): ModelHandle;
```

Keep `buildMetadata` / `GatewayMetadataContext` / the structured `GatewayMetadata`
attribution schema exactly as they are — every call site already passes a context
(`chat` / `thread-title` / `gadget-title` / `model-binding`).

Key implementation facts (verified; see §9):

- **Don't use pi's `Models` collection or credential store.** Build `Model` objects
  ourselves and call the API implementations (or a locally constructed
  `createProvider({... api: {...}})`) directly, passing auth per call via `options.apiKey`
  / `options.headers` / `options.env`. pi dispatches `provider.stream()` on `model.api`
  with no catalog-membership check, so caller-constructed models are fully supported.
- **Model synthesis:** map our provider → pi api:
  `anthropic → "anthropic-messages"`, `openai → "openai-responses"`,
  `google → "google-generative-ai"`, `cloudflare → "openai-completions"`,
  `ollama → "openai-completions"`. Fill `contextWindow`/`maxTokens` from
  `getModelTokenLimits`-compatible data (`SUGGESTED_MODELS`), `cost` from pi's builtin
  catalog entry when the model id is known (import per-provider, not `providers/all`),
  else zeros. Set compat flags: Anthropic models get adaptive thinking (see below);
  OpenAI keeps stateless ZDR behavior (`store: false` semantics — check how
  `openai-responses` handles `supportsStore`/store in `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`
  and set whatever keeps requests stateless with encrypted reasoning); Workers AI models
  get `sendSessionAffinityHeaders: true` and honor `WORKERS_AI_OUTPUT_LIMIT`.
- **Routing modes** (same three as today, § markers refer to current code):
  - *Direct* (`getModelDirect`): baseUrl = provider default or `config.apiUrl`;
    `apiKey = config.apiToken`. Ollama: baseUrl = `config.apiUrl` + `/v1`, bearer header
    only when `apiToken` non-empty (as today).
  - *Platform AI Gateway* (`getModelViaGateway`): baseUrl per upstream —
    `https://gateway.ai.cloudflare.com/v1/{accountId}/{gateway}/anthropic` (api
    anthropic-messages), `.../openai` (openai-responses), `.../google-ai-studio`
    (google-generative-ai; pi's own gateway catalog skips google but the passthrough path +
    google API impl works — construct it ourselves), and Workers AI per the
    `workersAiGateway` / `WAI_DIRECT` mapping in §3 (gateway `/compat` with compound
    `workers-ai/{model}` id, or the direct REST endpoint). Auth: headers
    `{"cf-aig-authorization": "Bearer <token>", Authorization: null, "x-api-key": null}` —
    pi's API impls explicitly recognize `cf-aig-authorization` and skip SDK auth
    (`getClientApiKey` returns a dummy); the direct Workers AI REST endpoint uses plain
    `Authorization: Bearer` (pi's `apiKey`). Metadata: pi does **not** forward
    `options.metadata` as `cf-aig-metadata`; set the `cf-aig-metadata` header ourselves —
    JSON of `buildMetadata(initiator, context)` (the structured schema), on gateway-routed
    requests only. `aiGatewayLogRoute`: always the token variant
    `{gateway, accountId, apiToken}` (the binding variant is never produced under pi);
    none for the direct-REST Workers AI path.
  - *BYOK* (`getModelViaUserGateway`): baseUrl
    `https://gateway.ai.cloudflare.com/v1/{userAccountId}/default/compat`, compound
    `{UNIFIED_BILLING_PROVIDER_PATH[provider]}/{model}` id, openai-completions api,
    `cf-aig-authorization: Bearer <user token>`, same metadata header;
    `aiGatewayLogRoute = {gateway: "default", accountId, apiToken}` as in the current
    code.
- **`handle.stream`** merges per-call options before delegating: `signal`, `maxTokens`,
  session affinity (`sessionId: sessionAffinity` — pi only sends it when caching isn't
  `"none"`, which is fine), `onResponse` to capture `cf-aig-log-id` from response headers
  (stash it on the handle or via callback for the persister), and per-API extras:
  Anthropic adaptive thinking (check `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` for
  the current adaptive mechanism — an `AnthropicOptions` field and/or
  `compat.forceAdaptiveThinking`; enable it, matching today's
  `thinking: {type: "adaptive"}`). Other providers keep default reasoning behavior.
- **Binding-shim future:** leave a clearly marked seam — the place where a custom
  `fetch` would be injected into options (pi passes `options.fetch` into the SDK clients on
  all paths) — with a comment referencing the upstream ask, so binding support can return
  without restructuring. Don't implement the shim.
- `captureAiGatewayLogId` middleware and all `ai-gateway-provider`/`workers-ai-provider`
  imports are deleted. `LanguageModelGatekeeper` / `LanguageModelBindingImpl` stay,
  switching to `completeText`.

`ai-gateway.ts`: config class gains the required-credentials rule from §3; unchanged
otherwise.

### 4.3 `agent.ts` — the core rewrite

**Imports:** drop everything from `"ai"` and `"zod"`; add pi-ai types (`Message`,
`UserMessage`, `AssistantMessage`, `ToolResultMessage`, `ToolCall`, content types,
`AssistantMessageEvent`), TypeBox (`Type`, re-exported from pi-ai), and pi-agent-core
(`runAgentLoopContinue`, `AgentContext`, `AgentLoopConfig`, `AgentTool`,
`AgentToolResult`, `AgentEvent`).

**Replay (agent.ts:1159–1844):** keep all logic; change pushed shapes:

| Today | pi |
|---|---|
| two `{role:"system"}` slots | none in the array — build `Context.systemPrompt` from the two strings at the end (keep `modelMessageSources`' slot entries or drop them; adjust compaction projection accordingly) |
| `{role:"user", content}` | `{role:"user", content, timestamp}` (`UserMessage`; timestamp from the chat record) |
| user parts array (text/image/file) | `(TextContent \| ImageContent)[]`; images become `{type:"image", data: base64, mimeType}` (pi wants base64 strings — encode); text-like attachments stay inlined text as today; **any other type → text marker** `[Attached file <name> (<mime>) omitted — this file type is no longer supported]` |
| `{role:"assistant", content}` + `ToolCallPart`s | `AssistantMessage` with `content: [{type:"text",text}, ...{type:"toolCall", id, name, arguments}]` — use a helper `makeReplayAssistantMessage(content, timestamp)` filling required bookkeeping fields (`api`/`provider`/`model` from the handle, zero `usage`, `stopReason:"stop"`) |
| `{role:"tool", content:[tool-result]}` | `ToolResultMessage {role:"toolResult", toolCallId, toolName, content:[{type:"text",text}], isError, timestamp}` |
| output `{type:"text"\|"json", value}` | text content; JSON via `JSON.stringify(value)` — define one helper used by replay so live results (§ tools below) and replayed results produce identical text |
| output `{type:"error-text"}` | text content + `isError: true` |
| checkpoint summary user message | same, as `UserMessage` |

The empty-message skip (Anthropic rejects empties, agent.ts:1294) stays.

**System prompt assembly (agent.ts:1949–2043):** unchanged content; the two strings are
joined `slot0 + "\n\n" + slot1` into `systemPrompt` instead of occupying array slots.

**Tools (agent.ts:2137–2648):** each `tool()` becomes an `AgentTool`:

- `parameters`: TypeBox `Type.Object({...})` with the exact same descriptions
  (`Type.Optional(Type.String({description}))` etc.). Drop `outputSchema` (advisory only;
  its useful text is already in descriptions).
- `label`: short human string (new required field; pick sensible ones).
- `execute(toolCallId, params, signal)`: same bodies. Return
  `{content: [{type:"text", text}], details}` where `text` is exactly what the model
  should see (for JSON results, the same helper as replay) and `details` replaces
  `toolCallNotes` — carry `observedCodeVersion`, recorded `output`
  (webFetch/setGadgetBinding/createGadget/listBlueprints/etc.), and on failure set
  `details` via the existing try/catch pattern *before* rethrowing. Since a thrown error
  loses `details` in pi's conversion, keep notes for the error path in a local
  `toolCallNotes`-like map (only for errors; success data rides `details`). Alternatively
  return an explicit error result — but pi marks `isError` only for thrown errors, so
  keep throw + side map for errors. Choose one approach and apply it uniformly.
- `executeCode` keeps streaming output through `emitStreamEvent({type:"toolOutputDelta"...})`
  directly (don't route through pi's `onUpdate`).
- `giveUp` conditional tool and the spawner-restricted subset: same construction, now as
  arrays/objects of `AgentTool`.

**The loop (replacing agent.ts:2722–2882):**

```ts
let context: AgentContext = { systemPrompt, messages, tools };
let turnCount = 0;
let newMessages = await runAgentLoopContinue(context, {
  model: handle.model,
  convertToLlm: (msgs) => msgs as Message[],
  toolExecution: "sequential",
  maxTokens: maxOutputTokens,
  shouldStopAfterTurn: () =>
      ++turnCount >= 30 || connectionRequested || awaitingActionDecision ||
      (callbackInitiated && hooks.activeAgentCallbackCount(chatId) === 0),
}, emit, abortSignal, handle.stream);
```

(Exact signature/order per pi source — verify. If `runAgentLoopContinue` rejects our
context shape — it requires the last message to be user/toolResult, which replay
guarantees — fall back to `agentLoop` with the tail split out.)

`emit` (the awaited `AgentEventSink`) handles:

- `message_update` → client stream fan-out (below).
- `turn_end {message, toolResults}` → **the persistence barrier**, replacing
  `onStepFinish`:
  - If `message.stopReason` is `"error"` or `"aborted"`: record it (for the throw after
    the loop) and persist nothing.
  - Else build the `AiChatMessageBody`: `message` = concatenated text blocks;
    `reasoning` = concatenated thinking blocks (skip `redacted`); `toolCalls` = toolCall
    blocks mapped to `AiToolCall{toolCallId, toolName, input: arguments}` merged with the
    matching tool result's `details` and error info (`isError` → `error` from the result
    text or the error side map).
  - Run `consumeCapturedActions` (latching `awaitingActionDecision`) and
    `consumeCapturedConnectionRequests` exactly as today (agent.ts:2846–2863).
  - `hooks.addChatMessages(chatId, author, msgs, usage.totalTokens,
    capturedAiGatewayLogId, handle.aiGatewayLogRoute)` — the hook already takes the route
    (see `AgentHooks.addChatMessages`); the log id comes from the handle's `onResponse`
    capture instead of `response.headers`.
  - Reset per-step streaming state (`executeCodeStreamManager.clear()` etc.).
- `tool_execution_end` → emit `toolCallFinished` for executeCode (which today defers
  completion until execution ends).

After the loop: `flushCapturedYdocChanges()` in a `finally` (unchanged); if an
error/aborted stop was recorded, throw — `abortSignal.throwIfAborted()` first so
cancellation surfaces as an abort, then `throw new AgentTurnError(errorMessage,
lastResponseStatus)` (§4.5).

**Client stream fan-out** (replacing the `onChunk` switch, agent.ts:2745–2794), driven by
`message_update.assistantMessageEvent`:

| pi event | action |
|---|---|
| `text_delta` | `emitStreamEvent({type:"textDelta", delta})` |
| `thinking_delta` | `reasoningDelta` |
| `toolcall_start` | read id/name from `partial.content[contentIndex]`; emit `toolCallStarted`; `codePreviewManager.startToolCall`; `executeCodeStreamManager.startToolCall`; `clearActiveFile` for non-file tools (as today) |
| `toolcall_delta` | `appendInput(id, delta)` on both managers (raw JSON fragment — same feed as today) |
| `toolcall_end` | `finishToolCall`; emit `toolCallFinished` — except executeCode, which waits for `tool_execution_end` (as today) |

This replaces the old "mark previous tool finished when the next starts" workaround; if
Workers AI via pi turns out to delay `toolcall_end` events, live with it (alpha) and note
it.

**Compaction call** (agent.ts:2086–2092): `generateText` → `completeText(handle,
{systemPrompt: COMPACTION_SYSTEM_PROMPT, messages: summaryMessages, maxTokens, signal})`.

**Signature change:** `runAgent(hooks, chosenModel: LanguageModel, ...,
aiGatewayLogRoute?)` → `runAgent(hooks, handle: ModelHandle, ...)` — the recently added
trailing `aiGatewayLogRoute` parameter is absorbed into the handle
(`AgentHooks.addChatMessages` keeps its route parameter). The old
`chosenModel.provider.startsWith("anthropic")` check and the whole `prepareStep` block
(agent.ts:2660–2720) are deleted.

### 4.4 `agent-compaction.ts` — types only

- `CompactionProjectionMessage.message: ModelMessage` → pi `Message`.
- `flattenModelMessage` / `projectionMessageWeight` / `buildSummaryPrompt`: adapt to pi
  content blocks (`toolCall` blocks on assistant messages; `toolResult` messages;
  `thinking` vs `reasoning`; image parts → marker). Same merge/estimate logic; no
  recalibration of the char-weight heuristics.
- `getModelTokenLimits` unchanged.

### 4.5 `overseer.ts`

- Replace `import { generateText, RetryError, APICallError } from "ai"` (line 11).
- Define `AgentTurnError` (in agent.ts or ai-invoke.ts):
  `{ message: string; statusCode?: number }`. `statusCode` comes from the last
  `onResponse` seen by the handle for the failing request, when available.
- The catch in `#runAgentTurnWithContext` (overseer.ts:3741–3789): replace the
  `APICallError`/`RetryError` extraction with `err instanceof AgentTurnError`; keep the
  triage policy (reportIssue unless a known status < 500) and keep
  `postAgentErrorMessage` with the error text. Don't chase exact message-format parity.
- The `getModelWithLogRoute` call site in `#runAgentTurnWithContext` becomes a single
  `getModel(...)` returning a `ModelHandle` (same `ModelRoutingOptions` including the
  `{source: "chat", gadgetId, chatId}` metadata context) passed to `runAgent`; the
  destructured `aiGatewayLogRoute` local and the extra `runAgent` argument go away.
- One-shot call sites → `completeText`, each keeping its existing metadata context in the
  `getModel` options: `generateBindingName` (10s timeout via `signal`),
  `generateThreadTitle` (`thread-title`), `generateGadgetTitle` (`gadget-title`);
  `LanguageModelGatekeeper.startSession` keeps passing `ctx.props.metadata`
  (`model-binding`).
- Cost accounting is untouched: `#getCostFromAiGateway`'s retry loop and
  `getAiGatewayLogCost` (both route arms — keep the binding arm even though pi-produced
  routes are always the token variant; it's tested and supports the future binding
  re-enable), `addChatMessages`, compaction plumbing all stay as they are.

### 4.6 `chat-attachment-validation.ts`

Narrow `ATTACHMENT_SUPPORT_BY_PROVIDER` to `isTextOrImageMime` for **all** providers;
update the comments to explain pi-ai currently encodes only text and image content parts
(and reference the follow-up plan for PDFs). Upload validation thus rejects PDFs at the
door; replay degradation (§4.3) covers pre-existing logs.

### 4.7 Cleanup sweep

- Remove now-unused imports/files; `pnpm lint` treats unused imports as errors.
- `pnpm build` (tsc across packages) must pass; `packages/workshop-shared` and the
  frontend must have zero diff.
- Confirm the bundle excludes Bedrock/Node-only modules (§3).

## 5. What "reasonable" means for the judgment calls

Guidance for spots where behavior can't match exactly:

- Error message text shown to users: include pi's `errorMessage`; don't reconstruct the
  AI SDK's `summary — responseBody` format.
- Retry behavior: accept pi's defaults (`maxRetries` etc.) unless something is obviously
  pathological.
- Usage accounting: keep passing `usage.totalTokens` to `addChatMessages` (it feeds
  compaction's `measuredTokens`); pi's `Usage.totalTokens` is the analogue. Cost stays on
  the async gateway-log path for now.
- Reasoning persistence: concatenate thinking blocks into `msg.reasoning` as today;
  redacted blocks skipped. Cross-turn thinking is not replayed (same as today).
- If pi's event/callback ordering differs subtly from this plan's description, trust the
  pi source and preserve our latching semantics (latch in tool execute / `turn_end`, read
  in `shouldStopAfterTurn`).

## 6. Things that look tempting but are out of scope

- Steering/follow-up queues, immediate cost display, custom `CustomAgentMessages` types,
  catalog-driven `SUGGESTED_MODELS`, deleting `streaming-json-parser.ts`, the PDF bridge,
  the fetch-to-binding shim, any Anthropic cache tuning, any refactor of `AgentHooks`.

## 7. Verification

1. `pnpm build && pnpm lint && pnpm test` clean — including the rewritten
   `__tests__/ai-models.test.ts` (see decision 11) and the untouched
   `ai-gateway`/`ai-gateway-cost`/`web-fetch` suites.
2. Manual smoke, dev server, at least one Anthropic model plus one other provider:
   - fresh chat: create gadget from blueprint, edit files, watch live diff preview +
     executeCode code/output streaming;
   - readFile/editFile round trip; merge; revert; confirm the agent acknowledges the
     revert (synthetic observation) on the next turn;
   - executeCode with an agent callback (`self.foo()`), resolve it; nudge loop sanity;
   - requestConnection flow: request ends the turn; accept resumes;
   - abort mid-stream (cancel button); restart dev server mid-turn and confirm resume;
   - `/compact`, then continue the conversation across the checkpoint;
   - a chat from an existing dev database (pre-migration log) replays without errors.
3. Confirm cache hits happen at all for Anthropic (usage `cacheRead > 0` on a second
   turn) — a sanity check, not a tuning exercise.

## 8. Follow-up work (separate commits/PRs, after Phase 1 lands)

1. **PDF bridge:** re-enable PDF uploads for Anthropic/OpenAI by injecting provider
   `document`/`input_file` blocks via `onPayload` (payload replacement is supported), with
   replay markers upgraded back to real parts. In parallel: upstream ask for a first-class
   document content type; drop the bridge when it lands.
2. **Binding-backed Cloudflare transport:** upstream ask for Workers-binding support (or
   ship our own fetch-to-binding shim through `options.fetch` at the seam left in
   ai-models.ts), then relax the token requirements from §3.
3. **Upstream asks to file now:** workerd in pi's CI support matrix; document content
   parts; binding transport; `cf-aig-metadata` forwarding from `options.metadata`;
   (nice-to-have) runtime-agnostic compaction helpers.
4. **Phase 2 dividends** (from the feasibility report): steering/follow-up UI; immediate
   per-message cost display from `usage.cost`; custom message types for synthetic replay
   entries; catalog consolidation.

## 9. Appendix: verified pi API reference (0.83.x)

Verified against the pi source; re-verify signatures in `pi/` before relying on them.

**pi-ai core types** (`node_modules/@earendil-works/pi-ai/dist/types.d.ts`):

- `Context {systemPrompt?: string; messages: Message[]; tools?: Tool[]}`.
- `Message = UserMessage | AssistantMessage | ToolResultMessage`.
- `UserMessage {role:"user", content: string | (TextContent|ImageContent)[], timestamp}`.
- `AssistantMessage {role:"assistant", content: (TextContent|ThinkingContent|ToolCall)[],
  api, provider, model, usage: Usage, stopReason: StopReason, errorMessage?, timestamp, ...}`.
- `ToolResultMessage {role:"toolResult", toolCallId, toolName,
  content:(TextContent|ImageContent)[], details?, isError, timestamp}`.
- `TextContent {type:"text", text}`; `ThinkingContent {type:"thinking", thinking, redacted?}`;
  `ImageContent {type:"image", data /*base64*/, mimeType}`;
  `ToolCall {type:"toolCall", id, name, arguments}`.
- `Usage {input, output, cacheRead, cacheWrite, totalTokens, cost:{...,total}}`.
- `StopReason = "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"`; errors/aborts are
  events + final messages, never thrown/rejected.
- `Tool {name, description, parameters: TSchema}` (TypeBox; `Type`, `Static` re-exported).
- `StreamOptions {temperature?, maxTokens?, signal?, apiKey?, fetch?, headers?
  (null value suppresses a default header), env? (placeholder substitution, e.g.
  CLOUDFLARE_ACCOUNT_ID), sessionId?, cacheRetention? ("none"|"short"|"long", default
  short), onPayload? (may return replacement payload), onResponse? ({status, headers},
  model), maxRetries?, metadata?, timeoutMs?}`; `SimpleStreamOptions` adds
  `reasoning?: "minimal"|...|"max"`.
- Streaming events: `start`, `text_start/delta/end`, `thinking_start/delta/end`,
  `toolcall_start/delta/end` (delta = raw JSON fragment; `partial: AssistantMessage` on
  every event), `done {reason, message}`, `error {reason, error: AssistantMessage}`.
  Streams: `for await` + `.result(): Promise<AssistantMessage>`.
- `Model<TApi> {id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow,
  maxTokens, compat?}` — plain data; caller-constructed models work; api dispatch only.

**Cloudflare specifics** (`node_modules/@earendil-works/pi-ai/dist/providers/cloudflare-*.js`, `api/cloudflare.js`):

- Pure HTTPS; zero binding awareness; `options.fetch` honored on all paths (passed into
  the wrapped official SDK clients).
- baseUrl placeholders `{CLOUDFLARE_ACCOUNT_ID}`/`{CLOUDFLARE_GATEWAY_ID}` substituted from
  `options.env` by the `cloudflareStreams` wrapper; endpoints:
  Workers AI REST `https://api.cloudflare.com/client/v4/accounts/{acct}/ai/v1`
  (openai-completions, `Authorization: Bearer`);
  gateway passthroughs `https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/anthropic|openai`
  (native ids) and unified `/compat` (openai-completions, compound `provider/model` ids).
- Gateway auth: `cf-aig-authorization: Bearer <token>` header with
  `Authorization: null, "x-api-key": null` suppressions; API impls recognize this and use a
  dummy SDK key. `options.metadata` is **not** sent as `cf-aig-metadata` (only Anthropic
  body `metadata.user_id`).
- Session affinity: gated on `options.sessionId` + `compat.sendSessionAffinityHeaders`.

**Anthropic caching** (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`): automatic
breakpoints on the system prompt block, last immediate tool definition, and the last block
of the final user-role message (includes tool_result); recomputed per request;
`cacheRetention: "short"` → ephemeral 5m. Trust it; configure nothing.

**pi-agent-core** (`node_modules/@earendil-works/pi-agent-core/dist/`):

- `runAgentLoopContinue(context: AgentContext, config: AgentLoopConfig,
  emit: AgentEventSink, signal: AbortSignal|undefined, streamFn: StreamFn):
  Promise<AgentMessage[]>` — context's last message must be user/toolResult; `emit` is
  awaited at every emission (a durable-persistence barrier).
- `AgentContext {systemPrompt, messages: AgentMessage[], tools?: AgentTool[]}`;
  `AgentLoopConfig extends SimpleStreamOptions {model, convertToLlm (required),
  transformContext?, shouldStopAfterTurn?, getSteeringMessages?, getFollowUpMessages?,
  toolExecution?: "sequential"|"parallel", beforeToolCall?, afterToolCall?, prepareNextTurn?}`.
- `AgentTool {name, label, description, parameters: TSchema,
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult>, executionMode?}`;
  `AgentToolResult {content, details, terminate?}`; thrown errors become
  `isError: true` results with the message as text (details lost — hence the error side
  map in §4.3).
- Events: `agent_start/end`, `turn_start/end {message, toolResults}`,
  `message_start/update/end` (`message_update` carries `assistantMessageEvent`),
  `tool_execution_start/update/end`.
- Per-turn ordering: `turn_end` (awaited) → `prepareNextTurn` → `shouldStopAfterTurn` →
  steering/follow-up polls. Error/aborted stop: `turn_end` then `agent_end`, loop returns.
- `StreamFn = (model, context, options?: SimpleStreamOptions) => AssistantMessageEventStream
  | Promise<...>` — must never throw.
