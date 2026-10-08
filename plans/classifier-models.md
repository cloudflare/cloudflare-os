# Plan: Classifier model bindings (Cloudflare Clef)

## Summary

Clef and Clef Flash are Workers AI decision models. Given a JSON state and a set of typed
questions, they return a probability for every allowed answer. They don't chat, call tools or
write text, so they can't run a chat or a spawned agent. The existing `LanguageModelBinding`
(prompt in, string out) doesn't fit them either.

This plan adds a second AI model binding, `ClassifierModelBinding.classify()`, next to
`LanguageModelBinding.run()`. A user connects a classifier through the existing AI Model
connection. Chats, agent spawners, the quick model and new-conversation defaults never offer one.

"Classifier" is pi's term (`type: "classifier"`, `classify()`). The team may rename it "decision
model" later; the names that would change are listed under Open questions.

One PR, three commits: the pi bump, the kernel (shared and backend, with their tests and docs),
and the frontend.

## Background

### pi's classifier support

- pi-ai 0.99 added classifier models: `ClassifierModel` (`type: "classifier"`) and
  `classify(model, {state, questions}) → ClassifierResult`. `classify` never rejects. A failure
  comes back as `stopReason: "error"` with an `errorMessage`.
- The Workers AI transport (`api/cloudflare-workers-ai-system-one`) POSTs
  `{model, input: {state, questions}}` to `${model.baseUrl}/run`. It maps the public `bool`
  question type to Workers AI's wire type `noul` and back, and validates every answer. It takes
  `fetch`, `apiKey` (sent as `authorization: Bearer`) and `headers`, where a `null` value deletes
  a header case-insensitively.
- pi 0.99.1 lists only Jev, and rejects Clef's responses. It requires Jev's run record
  (`result.state === "Completed"`), but Clef answers `{success, result: {model, answers, usage}}`.
  pi v1.0.1 (#10316) fixes both. It adds `@cf/cloudflare/clef` (27B, $0.24/M input) and
  `@cf/cloudflare/clef-flash` (9B, $0.09/M input), both with a 65,536-token context, to
  `CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS`, and accepts Clef's response shape.
- Clef also reads up to 4 images, but pi's `ClassifierContext` can't carry them, so this plan is
  text/JSON only.

### Workshop's LLM binding today

- `Overseer.newAiModelGatekeeper(modelId)` (overseer.ts:10007) resolves the model through
  `getChatContext()` and always mints `LanguageModelGatekeeper` (ai-models.ts:685). Its props are
  `{displayName, config, initiator, metadata: {source: "model-binding", gadgetId}}` and its
  creation spec is `{type: "aiModel", modelId, provider, modelName}`.
- Its session is `LanguageModelBindingImpl.run()`, which calls `completeText(getModel(...))`.
  There is no quota, no BYOK routing and no cost accounting (TODO at ai-models.ts:751). Observers
  are no-ops, because an AI model is not a restricted resource.
- `getModel()` routes in one of three ways: through the user's own gateway (BYOK, agent turns
  only), through the platform gateway (over the `WORKERS_AI` binding or HTTPS), or directly with
  the config's credentials.
- Facet classes reached through `ctx.exports` need no Durable Object migration;
  `LanguageModelGatekeeper` has none.
- One list feeds every model picker: `UserDurableObject.#listModels()`, which holds the gateway
  models the admin offers (`GatewayModels.list()`) plus stored models. Its consumers are:
  - the chat composer (`ChatInterface` via `Overseer.listModels()`, and Home);
  - the onboarding default;
  - `GatekeeperModal` (AI Model and spawner);
  - the blueprint landing page (AI model and spawner pickers);
  - the providers page (management and quick model);
  - `getExternalMessageChatContext()`'s default model.
- In AI Gateway mode an admin sets each gateway model's mode in `/admin`'s Models tab (#616):
  enabled, hidden or disabled. `LanguageModelGatekeeper.startSession()` re-checks it on every
  binding call, so the bindings of a model the admin disables stop working. The same check refuses
  a binding to a user's own model once the admin stops users from adding their own.

### Live evidence

Except for the last three rows (see below), all requests went to the Cloudflare Gadgets account's
`default` gateway. HTTPS requests came from a workstation and binding requests from a deployed cron
probe.

| Transport | Request | Auth | Result |
| --- | --- | --- | --- |
| HTTPS | chat `/workers-ai/v1/chat/completions` | `cf-aig-authorization` only | 200 |
| HTTPS | classifier `/workers-ai/run`, pi's body | `cf-aig-authorization` only | 401, 10000 |
| HTTPS | classifier `/workers-ai/run`, pi's body | plus a Workers AI token as `Authorization` | 200, answers and usage |
| Binding | chat passthrough `/v1/chat/completions` | sentinel | 200 |
| Binding | classifier passthrough `/run`, pi's body | sentinel, or no header | 401, 10000 |
| Binding | classifier passthrough, model path with Clef's body | sentinel | 401, 10000 |
| Binding | `env.WORKERS_AI.run("@cf/cloudflare/clef", {state, questions})` | binding identity | answers, 152 tokens; `aiGatewayLogId` null |
| Binding | the same with `{gateway: {id, metadata}}` | binding identity | answers, 152 tokens; `aiGatewayLogId` set |
| Binding (local) | Workshop's `classify` under `pnpm dev-server -- --use-workers-ai-binding`, gateway built-ins | Wrangler's remote binding | answers from both models (personal account; the Gadgets account refuses every remote AI binding call from `wrangler dev` with 1050) |
| HTTPS | classifier `/workers-ai/run`, pi's body | one token with AI Gateway Run and Workers AI, in both headers or in `Authorization` alone | 401, 10000 |
| HTTPS | classifier `/workers-ai/run`, pi's body | that token as `cf-aig-authorization`, a wrangler OAuth token as `Authorization` | 200, answers |
| Direct | classifier `/ai/run` | that token | 200, answers |

Every passthrough 401 carried a `cf-aig-log-id`, so the gateway accepted the request and Workers
AI behind it refused it. The gateway supplies its own Workers AI credential only for its
OpenAI-compatible chat route, not for `/run` or the model path. It also ignores
`cf-aig-authorization` on binding requests. On both transports, then, the classifier needs a
Workers AI credential that the chat path never sends. Over HTTPS that is an `Authorization` token.
The gateway passes a separate one through, but the gateway token can't be it: a request that
reuses it there is refused, even when the token also grants Workers AI and works against Workers
AI directly. Over the binding the classifier uses the binding's own `run()` instead, which still
goes through the gateway. Clef's `model: "clef"` input selector is optional on the binding.

The last three rows were run on 2026-10-05 against the `default` gateways of the Gadgets, Gadgets
Staging and Cloudflare OS Previews accounts, with a token holding AI Gateway Run and Workers AI
Read and Edit and no IP restriction, both with curl and through pi's own `classify()` as
`getClassifier()` calls it.

## Design

### Principles

1. **A classifier is an AI model, not a new connection type.** It reuses model storage, the AI
   Model connection, the `aiModel` creation spec and blueprint binding, and the sharing rules.
2. **Kind is a catalog property.** A `SUGGESTED_MODELS` entry marked `classifier: true` is a
   classifier, and `isClassifierModel(provider, model)` is the only test. It applies to gateway
   built-ins and to hand-added models with the same model ID.
3. **Model lists stay chat-only by default.** `listModels()` leaves classifiers out, and a new
   `AuthenticatedApi.listClassifierModels()` lists them. Only the three surfaces that can bind a
   classifier ask for it. Every other picker, and the backend's choice of default model, stays
   correct without changes.
4. **Mirror the LLM binding.** It has the same props, metadata and observer rules, and likewise
   no quota, BYOK or cost accounting.

### Catalog and kind (`workshop-shared/src/api.ts`)

- `SuggestedModel` gains `classifier?: true`, documented: "Marks a classifier (decision) model,
  which answers `ClassifierModelBinding.classify()` questions instead of chatting. Gadgets can
  bind it, but it is never offered for chats or agents."
- `SUGGESTED_MODEL_CATALOG.cloudflare` gains two entries, after the existing chat models:
  - `"@cf/cloudflare/clef": {name: "Clef (Workers AI)", contextWindow: 65536, classifier: true}`
  - `"@cf/cloudflare/clef-flash": {name: "Clef Flash (Workers AI)", contextWindow: 65536,
    classifier: true}`

  They go last because `AddModelModal`'s custom-model placeholder is the first entry
  (AddModelModal.tsx:64-66). In gateway mode they appear as built-ins once `cloudflare` is
  enabled. In direct mode `AddModelModal` offers them as suggested Workers AI models, except where
  onboarding opens it (see Frontend).
- `isClassifierModel(provider: string, model: string): boolean` returns
  `SUGGESTED_MODELS[provider as AiModelProvider]?.[model]?.classifier === true`. Its doc reads
  "Whether a model is a classifier (see `SuggestedModel.classifier`), which only a
  `ClassifierModelBinding` can run." It takes `(provider, model)` rather than a config because
  creation specs call the model `modelName`.

Why the Workshop's catalog rather than pi's classifier catalog:
- The gateway built-ins and `AddModelModal` need `SUGGESTED_MODELS` entries anyway.
- pi's catalog would also turn a hand-added `typesafe/jev` into a classifier, which is out of
  scope.

The direct routing test runs over every flagged entry, which ties the flags to pi's catalog.

### Listing (`user.ts`, `ai-gateway.ts`, `server.ts`, `api.ts`)

- `#listModels(models, kind: "chat" | "classifier")` keeps entries of that kind.
  `GatewayModels.list(kind)` applies the same test to the gateway models it offers. A kind literal
  reads better at the call sites than a bare boolean.
- The callers become:
  - `listModels()` → `#listModels(models, "chat")`;
  - the new `listClassifierModels()` → `#listModels(models, "classifier")`;
  - `getExternalMessageChatContext()` → `#listModels(models, "chat")`.
- `AuthenticatedApi.listClassifierModels()` is documented as "List the user's classifier models
  (see `isClassifierModel()`). Gadgets bind them through `Overseer.newAiModelGatekeeper()`; they
  can't chat." `AuthenticatedApiImpl` forwards it the same way it forwards `listModels()`.
- `AuthenticatedApi.listModels()` and `Overseer.listModels()` keep their code but now return chat
  models only, and their docs say so. `Overseer.newAiModelGatekeeper()`'s doc names both lists and
  both binding types.
- Unchanged: `#resolveModel`, `getChatContext`, add/update/delete. A classifier is a stored or
  built-in model like any other.

### Gatekeeper and binding (`ai-models.ts`, `classifier-model-binding.d.ts` + `.txt`)

- Rename `LanguageModelGatekeeperProps` → `AiModelGatekeeperProps`, since both classes take it.
  There are two references outside the definition, both in `overseer.ts`.
- Add `ClassifierModelGatekeeper`, a sibling of `LanguageModelGatekeeper`:
  - `describe()` returns `{url: http://models.local/…, title: displayName, snippet: "An AI
    classifier model.", suggestedBindingName: "CLASSIFIER", tsType: "ClassifierModelBinding"}`.
  - `getTypeScriptTypes()` returns the new `.txt`.
  - `startSession()` runs the admin check described in Background, then returns
    `new ClassifierModelBindingImpl(getClassifier(env, config, initiator, metadata))`. The check
    moves out of `LanguageModelGatekeeper.startSession()` into a module function,
    `refuseRevokedModel(env, props)`, which both sessions call. Without it, a disabled Clef would
    keep answering existing gadgets, against the Models tab's own description of "Disabled".
  - The no-op action and observer methods are copied, as `AgentSpawnerGatekeeper`
    (overseer.ts:12052) already does.
- Why not a shared base class: `startSession`'s return type differs, so the base would have to be
  generic, and the existing class's lines would move for no change in behavior.
- Why not a kind switch inside `LanguageModelGatekeeper`: `describe`, the types and the session
  all differ. Persisted records also pin the existing class's name, so it can't be renamed to
  something generic.
- `classifier-model-binding.d.ts` (with a `.txt` symlink, as `ai-model-binding` has):

  ```ts
  /**
   * Binding to an AI classifier (decision) model. Rather than writing text, it answers typed
   * questions about a state, with a probability for each allowed answer.
   */
  export interface ClassifierModelBinding {
    /**
     * Answer every question about the state. The result holds one answer per question, under the
     * question's key. Throws if the model request fails.
     */
    classify(request: ClassifierRequest): Promise<Record<string, ClassifierAnswer>>;
  }

  export type ClassifierRequest = {
    /**
     * A JSON object describing what the questions are about, such as a record or application
     * state. Wrap plain text, e.g. `{message: text}`.
     */
    state: JsonObject;
    /** The questions, keyed by ids made of letters, digits, `_`, `.` and `-`. */
    questions: Record<string, ClassifierQuestion>;
  };

  export type ClassifierQuestion =
    /** Pick one key of `criteria`; each value says when its key applies. */
    | {type: "choice", instructions: string, criteria: Record<string, string>}
    /** Rate on the ordered scale `criteria`, lowest level first. */
    | {type: "score", instructions: string, criteria: string[]}
    /** A yes/no question; `criteria` describes each outcome. */
    | {type: "bool", instructions: string, criteria: {true: string, false: string}};

  export type ClassifierAnswer =
    /** The likeliest key of `criteria`, with every key's probability. */
    | {type: "choice", choice: string, probabilities: Record<string, number>, confidence: number}
    /** The probability-weighted level, where 0 is the first level of `criteria`. */
    | {type: "score", score: number, confidence: number}
    /** The probability that the answer is true. */
    | {type: "bool", probability: number};

  export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
  export type JsonObject = {[key: string]: JsonValue};
  ```

  These types match pi's `ClassifierContext` and `ClassifierAnswer` structurally, so the request
  goes to pi and the answers come back without conversion. capnweb-validate supports recursive
  types, so `@validateRpc()` checks the request's shape before pi sees it.
- `ClassifierModelBindingImpl.classify(request)` calls the classifier. It throws
  `new Error(result.errorMessage)` unless `stopReason === "stop"`, and otherwise returns
  `result.answers`. This mirrors `completeText()`, which turns pi's error result back into an
  exception. It throws a plain `Error` because `AgentTurnError`'s status only feeds agent-turn
  triage.

### Routing (`ai-models.ts`)

```ts
/** Classifies with one resolved classifier model; see getClassifier(). */
export type Classifier = (context: ClassifierContext) => Promise<ClassifierResult>;

/**
 * Resolve a classifier model config (see isClassifierModel()) to a Classifier. It routes through
 * the platform's AI Gateway when one is configured, as getModel() routes chat models, and
 * otherwise goes directly to Workers AI with the config's own Cloudflare credentials.
 */
export function getClassifier(env, config, initiator, metadata?): Classifier
```

- **Model:** `CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS[config.model]`, with `baseUrl` overridden
  where the request goes to a different address. pi's entry supplies the API, provider, cost and
  window, as `catalogModel()` does for chat.
- **HTTPS platform gateway** (`gwConfig` set, `gwConfig.bindingFor("cloudflare")` unset):
  - `baseUrl = https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/workers-ai`;
  - options `{apiKey: gwConfig.apiToken, headers: {"cf-aig-authorization": Bearer token,
    "cf-aig-metadata": JSON(buildMetadata(initiator, metadata))}}`.

  pi sends `apiKey` as `Authorization`. Chat nulls that header and doesn't need it, but `/run`
  does (the 401 above), and the gateway token can't fill it (Live evidence). So this route fails
  until AI Gateway authenticates `/run` as it does chat. It stays as written until the AI Gateway
  team answers (see Open questions), and the docs tell deployments without the binding transport
  to disable classifiers.
- **Binding platform gateway:** the gateway's passthrough refuses `/run` even with the binding's
  identity, so binding requests use the binding's own `run()`, which goes through the same gateway
  (verified above). pi's `fetch` option becomes a small adapter:

  ```ts
  // pi's System One transport POSTs {model, input} as Workers AI's REST API takes them and reads
  // back the REST envelope; the binding's run() takes and returns the bare values.
  fetch: async (_url, init) => {
    const {model, input} = JSON.parse(init!.body as string);
    const result = await binding.run(model, input, {gateway: {id: gwConfig.gateway, metadata}});
    return Response.json({success: true, result});
  }
  ```

  `apiKey` is the binding sentinel, because pi requires a key; the adapter sends no headers. pi
  still owns the request shape (`bool` sent as `noul`), answer validation and usage. A `run()`
  error is thrown through `fetch`, and pi reports it as `stopReason: "error"` with the error's
  message.
- **Direct:** `baseUrl = workersAiAccountUrl(config)`, with options `{apiKey: config.apiToken,
  headers: config.extraHeaders}`.
- No BYOK and no quota, like `LanguageModelGatekeeper`, whose `getModel()` call passes neither.
  pi's default retries (2) apply to HTTP failures.

`workersAiAccountUrl(config)` is the one extraction, so the direct address is defined in one
place. It throws the existing "no Cloudflare credentials" error and otherwise returns
`https://api.cloudflare.com/client/v4/accounts/{accountId}/ai`. `getModelDirect()`'s `cloudflare`
branch uses `${workersAiAccountUrl(config)}/v1`. Classifiers reach the guard the same way chat
does: a model added in gateway mode is stored without credentials, and the deployment later
leaves gateway mode. The HTTPS gateway root is a single template, so it is duplicated rather than
extracted, and `getModelViaGateway()` doesn't change.

### Gatekeeper selection (`overseer.ts`)

`newAiModelGatekeeper()` mints
`isClassifierModel(config.provider, config.model) ? ctx.exports.ClassifierModelGatekeeper({props})
: ctx.exports.LanguageModelGatekeeper({props})`. Everything else stays the same: the creation
spec, the analytics `connection_type: "ai_model"` and the minted capability kind. `server.ts`
exports the new class.

### Blueprints

- `BlueprintBinding`'s `aiModel` arm gains `classifier?: true`, documented as "Set when the source
  binding is a classifier model, so installers pick among classifier models."
- `collectBindingMetadata()` sets it at both `aiModel` sites, from
  `isClassifierModel(spec.provider, spec.modelName)`: the edge binding (overseer.ts:7078) and the
  spawner-only synthesized binding (overseer.ts:7137).
- The agent's views of a blueprint name the kind: `describeBindingKind()` (overseer.ts:345)
  returns `AI classifier model`, and `fetchBlueprint()` (overseer.ts:8040) says
  `an AI classifier model binding`. Without this, an agent building from a classifier blueprint
  asks the user for "an AI model", and the user may connect an LLM where the code calls
  `classify()`.
- Blueprint metadata goes through archive export/import without per-field sanitizing
  (`reviveBlueprintMetadata` only revives dates), so the flag survives a round trip. Blueprints
  published before this have no flag and keep meaning "LLM".
- Server-side install (`server.ts:521`) is unchanged: `newAiModelGatekeeper` picks the class from
  the model the installer chose. A mismatched assignment is only possible through a hand-written
  API call against one's own gadget, and only breaks that gadget, so there is no server check.
- `docs/blueprints.md` describes the flag.

### Frontend

- `GatekeeperModal`: load `listModels()` and `listClassifierModels()`. The AI Model picker
  (`AiModelConnectionConfig`) offers both lists under "Chat models" and "Classifier models"
  headings (Kumo `Select.Group`), and its description says what each kind does. The spawner form
  keeps the chat list. The default AI Model selection is the first chat model, or the first
  classifier when there are none.
- `BlueprintLandingPage`: load both lists.
  - An `aiModel` binding with `classifier` picks from, and auto-suggests against, classifier
    models. Any other `aiModel` binding uses chat models, as do spawner pickers.
  - When a `classifier` binding has no candidates, the empty state says no classifier models are
    available yet and to add one (e.g. Clef) from AI Providers. This is the expected first run in
    direct mode, where Clef has to be added by hand, and the generic "No AI models" message would
    be false.
- `routes/providers.tsx`: list chat and classifier models together, and keep the classifier IDs
  from `listClassifierModels()` in a set. Classifier rows have no quick-model affordance: no row
  click, no Enter/Space and no menu item. Clicking a row, its primary action, sets the quick
  model. A classifier quick model would then feed `completeText` for chat titles, gadget titles
  and binding names (overseer.ts:3620, 5671, 6659), all of which would fail.
- `AddModelModal` gains `chatModelsOnly`, which leaves classifier entries out of its suggested
  models. Onboarding passes it: its model step picks the user's default chat model, and a Clef
  added there would vanish from the list, since `listModels()` leaves classifiers out. The
  Providers page doesn't, so it remains where Clef is added in direct mode.
- `features/ai-models/GatewayModelRow`: a classifier row (by `isClassifierModel`) keeps its three
  modes and gains a "Classifier" badge. It has no Test, which sends a chat request
  (`AdminApi.testGatewayModel()` → `completeText`) that a classifier can't answer. It has no
  Settings either, since a reasoning level and a compaction budget only shape chats.
  `isClassifierModel` is already shared, so the admin API doesn't change.
- Unchanged: the Home and chat composers, `AgentSpawnerConfigForm`.

### Not in scope

- Images and `temperature`.
- Jev and other classifiers.
- Quota, BYOK and cost accounting for model bindings (an existing TODO shared with the LLM
  binding).
- Trace spans for binding calls and a separate analytics type.
- A classifier test in the admin Models tab (see Frontend).
- Chat or agent support for classifiers.
- Eval support: `workshop-evals` takes its models from an explicit `WORKSHOP_EVAL_MODELS`, and
  naming Clef there fails loudly at the first chat request.

## Implementation

### Commit 0: bump pi to 1.0.2

- `packages/workshop-backend/package.json`: move `@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core` from 0.99.1 to 1.0.2, and update the lockfile.
- 1.0.2 (published 2026-10-04) is the newest release past `minimumReleaseAge` (1440 min), so it
  needs no `minimumReleaseAgeExclude` entry. 1.0.3 adds nothing Workshop needs; its only breaking
  change renames the Azure provider, which Workshop doesn't use.
- The other change on Workshop's request paths: Anthropic models whose pi compat enables
  mid-conversation tool changes now send the `inline-tools-2026-09-15` beta in place of
  `mid-conversation-tool-changes-2026-07-01`. Workshop declares its tools only in the initial
  system message, so the request is otherwise unchanged. pi-agent-core drops its `harness`,
  `node` and `search` modules, which Workshop doesn't import.

### Commit 1: kernel

1. `workshop-shared/src/api.ts`:
   - add `SuggestedModel.classifier`, the two catalog entries, `isClassifierModel`,
     `AuthenticatedApi.listClassifierModels` and `BlueprintBinding.classifier`, each with its doc
     comment;
   - update the docs of `AuthenticatedApi.listModels`, `Overseer.listModels` and
     `Overseer.newAiModelGatekeeper`.
2. `workshop-backend/src/classifier-model-binding.d.ts` and its `.txt` symlink.
3. `ai-models.ts`: rename the props type; add `workersAiAccountUrl`, `getClassifier` (with the
   binding `run()` adapter), `refuseRevokedModel`, `ClassifierModelGatekeeper` and
   `ClassifierModelBindingImpl`.
4. `ai-gateway.ts`: `GatewayModels.list(kind)`.
5. `user.ts`: `#listModels(models, kind)`, `listClassifierModels()`, and the external-message call.
6. `server.ts`: export the new class and forward `listClassifierModels`.
7. `overseer.ts`: the props rename, class selection, both `collectBindingMetadata` sites, and the
   two agent-facing kind labels.
8. Tests (below). Existing tests to update: the `GatewayModels.list()` calls in
   `ai-gateway.test.ts` become `list("chat")`; `ai-models.test.ts`'s built-in reasoning table,
   which must cover every catalog model, gains the two Clef entries (`null`); and
   `integration-tests/__tests__/ai-gateway-cost.test.ts`'s `listModels()` expectations leave out
   the classifiers, beside a new `listClassifierModels()` assertion.
9. Docs:
   - `docs/blueprints.md`: the `classifier` flag;
   - `docs/public-server.md` and `docs/ai-gateway-billing.md`: classifiers need the binding
     transport, and a deployment without it disables them on the admin Models tab.

### Commit 2: frontend

`GatekeeperModal.tsx`, `gatekeeper-modal/AiModelConnectionConfig.tsx`, `BlueprintLandingPage.tsx`,
`routes/providers.tsx`, `AddModelModal.tsx` (with `OnboardingWizard.tsx` passing
`chatModelsOnly`) and `features/ai-models/GatewayModelRow.tsx`, with their tests and the new
`providersRoute.test.tsx`. The `GatekeeperModal.test.tsx` and `BlueprintLandingPage.test.tsx` API
mocks gain `listClassifierModels`. `docs/public-server.md` says a classifier has only a mode on
the admin Models tab.

## Tests

Backend unit tests, in a new `describe("getClassifier routing")` in `__tests__/ai-models.test.ts`:
- **Direct**, for each classifier entry in `SUGGESTED_MODELS`. The request goes to
  `https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run` with
  `authorization: Bearer {token}` and no `cf-aig-*` headers. The body is
  `{model: id, input: {state, questions}}`, with `bool` sent as `noul`. A Clef-shaped
  `{success, result: {model, answers, usage}}` response yields typed answers. This ties the
  catalog flag to pi's catalog and pins the Clef envelope fix the bump brings.
- **Platform HTTPS.** The request goes to `…/v1/{acct}/{gw}/workers-ai/run`.
  `cf-aig-authorization` and `authorization` are both `Bearer {gateway token}`, and
  `cf-aig-metadata` carries the gadget attribution.
- **Platform binding.** A fake binding's `run()` receives `("@cf/cloudflare/clef", {state,
  questions with noul}, {gateway: {id: gw, metadata: {user, source: "model-binding", gadgetId,
  automated: true}}})`, and its bare Clef result comes back as typed answers. When `run()`
  throws, the result is `stopReason: "error"` with the thrown message.

Backend unit test, `describe("ClassifierModelGatekeeper.startSession")` in the same file: a session
for Clef is refused once the admin disables it. The language model's session tests already cover
the shared check's cases; this one pins that the classifier's session runs it.

HTTPS and direct requests are captured by stubbing `globalThis.fetch`. pi's classifier falls back
to it when no `fetch` option is given, so `getClassifier` takes no test-only parameter.

Backend unit test, `__tests__/user-models.test.ts`: in gateway mode with `cloudflare` added by the
admin and a hand-added classifier, `listClassifierModels()` lists the built-in and hand-added
classifiers, and `listModels()` lists none of them. This is the invariant that keeps classifiers
out of chat, spawners and the external-message default.

Integration test, `integration-tests/__tests__/workshop-blueprints.test.ts`: a user adds a direct
Clef model, creates its gatekeeper with `newAiModelGatekeeper` and binds it.
- The gadget's `env.CLASSIFIER.classify()` returns the answers that a network handler for
  `/accounts/{id}/ai/run` serves. This exercises class selection, the session, capnweb validation
  and pi's parsing end to end.
- When the handler then serves a Workers AI error, `classify()` rejects with its message, which
  is the contract gadget code relies on.
- The gadget's blueprint binding carries `classifier: true`.

Frontend:
- `BlueprintLandingPage.test.tsx`: a `classifier` binding's picker offers only classifier models.
- `GatekeeperModal.test.tsx`: the AI Model picker offers a classifier under its heading; the agent
  picker doesn't offer it.
- A new providers route test: a classifier row has no row action and no "Set as quick model"
  item, while chat rows keep both.
- `AddModelModal.test.tsx`: Clef is offered without `chatModelsOnly` and not with it.
- `GatewayModelRow.test.tsx`: a classifier row has its modes and the badge, and no Test or
  Settings.

Smoke test: run the dev server in direct mode with a real Workers AI token. Add Clef, bind it and
call `classify` from a gadget. Check the providers page and the pickers in the browser.

## Rollout and compatibility

- **No storage or DO migration.** Kind is computed from the stored config. Existing gatekeepers,
  chats and blueprints are untouched.
- **Cost.** In gateway mode, classifier calls from gadgets are platform-funded and uncapped,
  exactly as LLM binding calls are today.
- **HTTPS-gateway deployments** (a Gateway in another account, or no `WORKERS_AI` binding) can't
  run classifiers yet. Their admins disable Clef and Clef Flash on the Models tab, which turns a
  gadget's 401 into a clear refusal. Chat is unaffected. Binding deployments need nothing new.

## Open questions

Settled before merge:
- **One token for both headers** doesn't work (Live evidence). Log IDs of the refused requests:
  `01M4668BD6TSNNZ3C3Z3H6J2YC`, `01M4668CXRN0NS2ATMFHX2V6AD`.

Pending with the AI Gateway team: whether `/run` can authenticate as chat does, with
`cf-aig-authorization` alone, or pass on a token the gateway also accepted. If it can, the HTTPS
route should work as written. If not, the choices are calling Workers AI directly over HTTPS with
the gateway token (those calls then skip the gateway's logs), refusing classifiers over HTTPS, or
a second token setting.

Optional: check that the binding path's `metadata` shows up on the gateway's log entries (AI
Gateway › Read, or the dashboard) for log IDs `01M3Z9A89284H1RT2C7T40T4AB` and
`01M3Z9A8KMHS3WNXQRP0C029DV`.

Naming: "decision model" may replace "classifier". The code names that would change are
`ClassifierModelBinding`, `ClassifierModelGatekeeper`, `listClassifierModels`,
`isClassifierModel`, the `classifier` flags and the `CLASSIFIER` binding name.

## Future work

- Images, once pi's `ClassifierContext` carries them.
- Quota and cost accounting for model bindings, shared with the LLM binding's TODO.
