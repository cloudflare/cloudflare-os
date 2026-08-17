---
name: write-gatekeeper
description: Guides implementation of Gatekeeper Workers that bridge Gadgets to external services. Covers auth, capability-based API design, approval queue integration, caching, and action simulation. Load when creating, modifying, or reviewing the implementation of a gatekeeper.
---

# Writing a Gatekeeper

A Gatekeeper is a Cloudflare Worker that mediates all access between a Gadget and an external service. It implements a three-tier hierarchy:

- **Vendor** (`GatekeeperVendor`, a `WorkerEntrypoint`) — top-level entry for the service. One per service.
- **User** (`GatekeeperUser`, a `WorkerEntrypoint` with `ctx.props`) — a human user's authenticated connection.
- **Instance** (`Gatekeeper<Session>`, a DO facet of the Overseer) — per-resource, per-Gadget binding that provides the Session API.

Read `packages/workshop-shared/src/gatekeeper.ts` for the canonical interfaces and detailed JSDoc.

## Seven responsibilities

1. **Auth management** — Manage authorization to the external service via OAuth (or similar), on behalf of the human end user. This means managing "connected accounts" — token storage, refresh, and revocation in a `UserAccount` Durable Object.

2. **API design** — Provide a TypeScript API wrapper around the service's API, compatible with Cap'n Web RPC. The interface should be designed around capability-based security: object-oriented, with separate interfaces representing logical resources. For example, the Google Docs gatekeeper provides an interface to a *specific* document, rather than a coarse-grained interface where you pass the doc ID to every method. **IMPORTANT:** When writing a new gatekeeper, design a proposed API and then STOP to let the operator review and make changes before proceeding with the rest of the implementation. Getting the API right is the most important and delicate part of creating a new gatekeeper.

3. **Fine-grained resource granting** — Enable the end user to grant access to agents at fine granularities, in addition to coarse-grained access. For example, a user may want to give an agent access to a specific Google Doc or GitHub repo, rather than granting broad access to everything they can do. This should be straightforward given a capability-based API. That said, broad access should also be allowed when it makes sense. Consider carefully which granularities are meaningful — a Jira gatekeeper might support "whole service", "project", and "issue" granularities, but it would be silly to support granting access to a single field of an issue separately.

4. **Logging & approvals** — Every action the agent or gadget performs must be logged via the `ApprovalQueue` API. Every action with an externally-visible side effect must be submitted via `submitAction()`, and must not actually be performed until `applyAction()` has been called. Read-only observations must call `authorizeObservation()` before returning data to the caller.

5. **Caching** — When it makes sense, cache remote content in the gatekeeper's DO storage to improve performance when agents or gadgets repeatedly read the same data. Caching also enables a better TypeScript API when the service's underlying API has an inconvenient data shape. For example, Gmail's API for listing threads returns only thread IDs without metadata, requiring a callback for each thread; with caching, the gatekeeper can provide an API that returns rich thread summaries directly, reading from local content synchronized with Gmail as needed. See Phase 2 for implementation guidance.

6. **Simulation** — Actions submitted but not yet applied should be simulated as if they already occurred, to the maximum extent reasonable. If the caller reads back data, it should observe the data as if pending actions had been applied, even though they haven't yet. This allows the agent to continue working without waiting for each approval, and allows the end user to batch-approve a lot of work at once. Simulation may leverage caching (updating the cache on submit, clearing or repopulating it on reject), or it may work by storing pending actions separately and adjusting read results at query time — the latter is arguably cleaner but trickier to implement correctly. See Phase 2 for implementation guidance.

7. **Observer verification** — When a Gadget is shared, collaborators may "observe" data the Gadget previously read through the gatekeeper. The gatekeeper must ensure each collaborator could access that data themselves, via `getVerifier()` / `addObserver()` / `removeObserver()`. The interface methods are mandatory — a gatekeeper won't type-check without them — so include at least minimal versions in Phase 1; but *choosing and implementing the right strategy* is a Phase 2 security concern, like logging/approvals. See [Observer verification](#observer-verification).

## Phase 1: Core implementation

In the first phase, focus only on responsibilities 1 - 3, though keeping in mind that 4 - 7 will need to be implemented later. Note the observer methods of responsibility 7 (`getVerifier`/`addObserver`/`removeObserver`) are required for the code to type-check, so the skeleton includes minimal versions; you flesh out the actual strategy in Phase 2.

### Step 1: Understand the external service

Study the service's API docs. Identify:
- Auth model (OAuth 2.0, API keys, etc.)
- Resources to expose and what access granularities make sense
- Which operations are observations (read-only) vs. actions (side effects)

### Step 2: Design the Session types

Create `src/types.d.ts` defining the Session interface (and Hook interface if the service pushes events — see [Hooks](#hooks-push-notifications)).

Before designing, read `packages/workshop-shared/node_modules/capnweb/README.md` to understand what Cap'n Web RPC supports — this determines what types and patterns are expressible in the Session interface.

Design principles:
- One interface per logical resource type, not a god-object
- Methods return structured data, not raw API responses
- Use capability-based design principles: make it easy to limit authority in useful ways by simply limiting access to specific objects or allowing/blocking specific methods
- Simplify API complexities that are not likely to matter to agents and gadgets; design for a more novice user and common use cases
- Consider what URL patterns `getGatekeeperClassFor()` should match — each pattern maps to a resource granularity
- Include JSDoc comments; these types serve as the agent's API documentation. See [Documenting the API](#documenting-the-api-typesdts) below.

#### Documenting the API (`types.d.ts`)

This JSDoc is the agent's sole documentation for the API, so keep it **narrowly focused on what the agent needs to use each method**: what it does, its parameters, the returned data shape, and any errors the caller must handle.

Do NOT leak details the caller doesn't need to use the API — the approval queue (never mention `submitAction`/`applyAction`/approvals; correct simulation keeps this invisible), or gatekeeper internals (caching, DO storage, OAuth, syncing). Document those in the `.ts` implementation or PR, never in the agent-facing `.d.ts`.

### Step 3: STOP — Present API for review

**Do not proceed without operator approval.**

Present the proposed `types.d.ts` and explain the design: what resource granularities are supported, what Session methods do, and what trade-offs were made. The API is the most important and delicate part of a gatekeeper — getting it wrong means rebuilding. Wait for the operator to review and approve (or request changes) before continuing.

Also confirm the JSDoc follows [Documenting the API](#documenting-the-api-typesdts) — no approval-queue or implementation details leaked in.

### Step 4: Implement

See [SKELETON.md](SKELETON.md) for a complete implementation template.

Package structure:
```
packages/gatekeeper-<name>/
├── src/
│   ├── configurator/         # Optional resource-picker UI modules and UI-facing types
│   ├── <name>.ts              # Vendor, UserAccount, UserImpl, GatekeeperImpl, SessionImpl
│   ├── types.d.ts             # Session/Hook types (compile-time)
│   ├── types.txt -> types.d.ts  # Symlink (runtime, for getTypeScriptTypes())
│   └── <name>-api.ts          # (optional) Helper wrapping the service's HTTP API
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

### Step 5: Configure and register

Add a service binding to `packages/workshop-backend/wrangler.jsonc`:
```jsonc
{
  "binding": "GATEKEEPER_<NAME>",
  "service": "gatekeeper-<name>",
  "entrypoint": "GatekeeperVendor"
}
```

The backend auto-discovers vendors from `GATEKEEPER_`-prefixed bindings (see `packages/workshop-backend/src/user.ts`).

### Step 6: Add resource selection UI

Add a resource selection UI for each resource type returned in `getSupportedResources()`. This will be used by users to select the specific resource.

- Workshop calls `GatekeeperUser.startResourceConfigurator(resourceUrlPattern)` with the selected resource's `urlPattern`.
- Return `iframeHtml` of the selection UI and `ui` for any RPCs that UI needs.
- When the user selects "Add connection", Workshop asks the iframe for the selected resource URL.

Keep the iframe-facing capability narrow, only what's necessary to provide desired interface to help user find and select the resource.

#### Optional helper: `@gadgets/configurator-ui`

For simple configuration UIs, consider using `@gadgets/configurator-ui`. It provides the basic form components that look consistent to the Gadget Workshop and a build script that turns `src/configurator/*-ui.tsx` into `iframeHtml`. Gatekeepers with more specialized UI needs can produce their own `iframeHtml`.

If you use this:

- UI modules live in `src/configurator/*-ui.tsx`.
- `resourceUrl()` returns the selected resource URL.
- `src/configurator/*-types.d.ts` describes the iframe-facing `ui` API.
- `scripts/build-gatekeeper-configurator.ts` generates `src/generated/*.txt`.
- Nothing invokes `build-gatekeeper-configurator.ts` by hand. `vite.config.ts` re-exports the
  shared `build` and `build:configurator` Vite+ tasks from
  `scripts/gatekeeper-configurator-vite-config.ts`; `build` is just `tsc` and depends on
  `build:configurator`, which carries `VITE_FRONTEND_ERROR_REPORTING` in its fingerprint, and
  `deploy` runs `vp run --no-cache build:configurator && wrangler deploy` — deploys never replay a
  cached artifact. There is no `build` script
  and no direct builder call, because a script running the builder gets vp's stripped environment
  and bakes the wrong flag into the shipped HTML.

##### Pre-filling the form from a known resource URL

When something already knows the exact resource — most importantly an AI agent's `requestConnection` (which passes a concrete `resourceUrl`) — the configurator should open **pre-filled and editable**, not blank. The runtime handles this for you:

- If your value keys already match the `urlPattern`'s named groups (e.g. pattern `.../area/:areaId` with a value key `areaId`), prefill works automatically — no code needed.
- Otherwise, implement the optional `initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern, ui })` on your spec to map a concrete URL back to your form values. Keep it pure where possible (parse the URL); it may use `ui` and may be async. Example (GitHub, whose value is `repoFullName` but pattern is `:owner/:repo`):

  ```ts
  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}` } : {};
  },
  ```

  The runtime seeds these values before first render and reflects them in `Autocomplete`/`TextInput`/`RadioCards` inputs. Make sure your `resourceUrl(values)` and `initialValuesFromResourceUrl(url)` are inverses so a prefilled form round-trips to the same URL. **Every gatekeeper with selectable resources should support this** so agents can fully pre-configure a connection.

### Step 7: STOP — Ask operator whether to proceed to phase 2

The operator may prefer to implement phase 2 later, perhaps in a new context. Stop here and ask the operator whether to proceed.

## Phase 2: Logging, approvals, caching, simulation, and observers

In this phase, we focus on responsibilities 4-7. These are typically added as a second pass, after the core gatekeeper works. They may be implemented in a separate session.

### Logging and approvals

Go through all the API methods and decide where to insert calls to the `ApprovalQueue`.

- Any operation which reads external data (but with no side effects) must call authorizeObservation().
- Any operation which has visible side effects on the world must call submitAction(), and must not actually apply the action until approved.

Study the `ApprovalQueue` API in `gatekeeper.ts` for details.

It's critically important that you add `ApprovalQueue` to all API operations that interact with the outside world, otherwise the gatekeeper security model is broken.

### Caching

Store fetched data in the gatekeeper's DO storage (`this.ctx.storage`) to avoid redundant API calls. The cache also enables a better API shape when the service's native data model is awkward — e.g., Gmail's list API returns thread IDs without metadata, but with caching the Session can return richer summaries directly.

- Use TTLs or revision IDs to keep the cache fresh.
- Cache transformed data (e.g., Markdown) rather than raw API responses when the transformation is expensive.

PROTIP: The relatively new API `this.ctx.storage.kv` provides synchronous versions of the traditional Durable Object storage API, e.g. `get` and `put`. Use these instead of the old asynchronous methods. (Note that the synchronous API does not provide "batch" versions of `get()` and `put()`, but you don't really need them since simply making multiple calls is efficient.)

PROTIP: `this.ctx.storage.sql` gives you access to a full, private SQLite database. Use this when the full power of SQL is useful, but prefer KV for simple things.

The full Durable Objects storage API (including synchronous KV and SQLite) is documented at: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

### Simulation

When `submitAction()` has been called but `applyAction()` hasn't, reads should reflect the pending action. This allows the calling agent or gadget to be unaware of the approvals mechanism, and proceed with follow-on work immediately. The end user is able to approve a whole batch of changes at once, later on.

Two possible implementation approaches include:

1. **Mutate the cache** — Apply the action's effects to cached data on submit. On `rejectAction()`, invalidate or rebuild the cache. Simple; works well when the cache is already a transformed view. Don't forget to re-apply any queued actions when updating the cache.

2. **Overlay at read time** — Store pending actions separately; merge them into read results on demand. Cleaner separation; better when the overlay logic is straightforward.

Choose based on the service's data model and the complexity of simulating each action type.

Keep in mind that the agent calling the API (or the agent writing a gadget to call it) is generally not aware that actions do not take place immediately. If the simulation is correct, the agent doesn't need to be aware. If the simulation has gaps, you may want to mention it in your API's doc comments, so that the calling agent knows to work around them — but ideally there are no gaps and the calling agent does not need to think about it.

For concrete examples, see the Google gatekeeper's Google Docs simulation/cache handling and BigQuery dry-run scope enforcement.

### Observer verification

This is responsibility 7. When a Gadget is shared, each non-owner collaborator becomes an **observer** of every gatekeeper bound to the Gadget, and may see data the Gadget previously read. The gatekeeper's job is to refuse — or forward-restrict — observers who couldn't access that data themselves.

Three methods implement this (full JSDoc in `gatekeeper.ts`):

- `GatekeeperUser.getVerifier()` — mints a `GatekeeperUserVerifier` (a persistent service stub) representing *this* user's account. The overseer mints one per open and **only ever passes it back to a gatekeeper of the same vendor**, so the gatekeeper may trust whatever it learns from it.
- `Gatekeeper.addObserver(id, verifier)` — must **throw** if the user represented by `verifier` is not allowed to observe everything read through this gatekeeper so far. The overseer calls it on **every open by every authorized observer** (re-verification, so revoked access is caught at the next open); cache as needed if the check is expensive. `id` is an opaque, stable per-(user,gadget) string.
- `Gatekeeper.removeObserver(id)` — idempotent; drop a tracked observer.

#### The verifier "non-standard method" pattern

`GatekeeperUserVerifier` has no methods of its own — it's an opaque token. To actually answer "can this observer access X?", define a vendor-specific interface that **extends `GatekeeperUserVerifier`** with your own methods, implement it on a `WorkerEntrypoint` that queries the service using the **observer's own token**, and cast the `Fetcher` back to that interface inside `addObserver`. The overseer's same-vendor guarantee is what makes the cast safe.

```typescript
// In types/impl: a verifier interface with non-standard methods.
export interface MyVerifierApi extends GatekeeperUserVerifier {
  hasResourceAccess(resourceId: string): Promise<boolean>;
}

type MyVerifierProps = { userObjectId: string };

export class MyVerifier extends WorkerEntrypoint<Env, MyVerifierProps>
    implements MyVerifierApi {
  async hasResourceAccess(resourceId: string): Promise<boolean> {
    // Query the service with the OBSERVER's own token (this.ctx.props.userObjectId).
    try {
      await myApiForObserver(this.ctx).getResource(resourceId);
      return true;
    } catch (error) {
      // Distinguish "no access" from "transient failure":
      //   - auth/permission/not-found (401/403/404) → false (they can't see it)
      //   - anything else → rethrow, so the open fails loudly rather than silently denying
      if (isNoAccessStatus(statusOf(error))) return false;
      throw error;
    }
  }
}

// In GatekeeperUser:
async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
  return this.ctx.exports.MyVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
}
```

`MyVerifier` is a `WorkerEntrypoint`, so it needs **no migration entry**, but (like all entrypoints) it must be `export`ed from the worker's main module so `ctx.exports.MyVerifier(...)` resolves.

#### Choosing a strategy (per resource type / binding)

Strategy is chosen **per `Gatekeeper` DO class / binding**, not per package — one package may use several (e.g. Google: Gmail=A, Doc=B, BigQuery=C).

- **A — Private-only.** `addObserver()` always throws; `removeObserver()` is a no-op. `getVerifier()` must still exist (the overseer mints it) but is never consulted. Use when the resource is too sensitive to share and there is no per-observer access oracle (e.g. a personal Gmail mailbox).
- **B — ACL check (single unit).** The binding is one atomic resource; sub-resources inherit its ACL. `addObserver()` calls a verifier method to confirm the observer can access it and throws otherwise; `removeObserver()` is a no-op; nothing is tracked and no `excludeObservers` is ever needed. Use for repo / document / page / team / single-project bindings.
- **C — Data-set tracking.** The binding spans sub-resources with **distinct ACLs**, and there is a **per-observer access oracle** for each. The DO logs the data sets actually observed and the current observers; `addObserver()` verifies the observer against **every** logged set (plus a coarse membership baseline) and **stores their verifier**; each later observation that first touches a **new** set re-checks all stored observers and sets `excludeObservers` for any who fail. Use for workspace / organization / dataset-spanning bindings.
- **D — Low-stakes.** `addObserver()` / `removeObserver()` are no-ops; `getVerifier()` returns a trivial verifier with a no-op public method such as `verify(): void {}` (an empty `WorkerEntrypoint` is not registered in `ctx.exports`). Use when any collaborator may observe (personal, low-stakes services).

The **B-vs-C decision** (the "broad binding" lens): use C only when **both** (1) the binding spans sub-resources with distinct ACLs *and* (2) there's a per-observer oracle to check each against. If one ACL covers everything → B. If there's no oracle → A or D.

#### Implementing strategy C

Route **every data-revealing observation** through a helper that takes the set id(s) the observation reveals, instead of calling `authorizeObservation()` directly:

```typescript
// On the Gatekeeper DO. `setIds` are the data sets this observation reveals.
async authorizeSetObservation(
    queue: RpcStub<ApprovalQueue>, setIds: string[], description: ObservationDescription) {
  const check = setIds.length > 0
      ? await this.#prepareSetObservation(setIds)
      : { pendingSets: [], excludeObservers: undefined };
  await queue.authorizeObservation({ ...description, excludeObservers: check.excludeObservers });
  for (const setId of check.pendingSets) this.#markSetObserved(setId);
}

async #prepareSetObservation(setIds: string[]) {
  const pendingSets = [...new Set(setIds)].filter(id => !this.#isSetObserved(id));
  if (pendingSets.length === 0) return { pendingSets, excludeObservers: undefined };
  // This synchronous state change is visible to addObserver() before verifier RPCs can interleave.
  for (const setId of pendingSets) this.#markSetPendingIfUnknown(setId);
  const excluded = new Set<string>();
  for (const [id, verifier] of this.#listObservers()) {
    for (const setId of pendingSets) {
      if (!(await verifier.hasSetAccess(setId))) { excluded.add(id); break; }
    }
  }
  return {
    pendingSets,
    excludeObservers: excluded.size > 0 ? [...excluded] : undefined,
  };
}
```

Key points for C:

- **Use two durable states: pending and observed.** Mark unknown sets pending before the first await, recheck pending sets on every retry, and promote them only after `authorizeObservation()` succeeds. A failed authorization leaves them pending. `addObserver()` must check both states and loop until no unchecked sets remain before synchronously storing the verifier; this also closes admission races in either request ordering.
- **The session impls must route through this helper**, not `approvalQueue.authorizeObservation()`. If sessions hold the raw queue (not the DO), thread a small prepare hook/callback into each session and any sub-sessions it spawns, and expose a completion step that promotes its pending sets after authorization. For a single broad binding the hook is active; for the narrow (B) sibling binding it is absent (passthrough). See Linear/Notion for the shared-session-impl case and Supabase for the context-object case.
- **One observation may reveal several sets** (e.g. a workspace-wide list whose rows belong to different sub-resources). Pass all of them; union the exclusions over the newly-seen ones. Reads that reveal *no* set (workspace name, member directory, a bare "open") pass an empty list and rely on the membership baseline.
- **`addObserver` baseline:** verify the coarse membership (e.g. same org/workspace) that gates the set-independent reads, then verify each already-observed set, then store the verifier. Fail closed if a needed identity is unknown (e.g. an account connected before you began persisting the workspace id → force a reconnect).

#### `excludeObservers` semantics (why conservative is safe)

When `authorizeObservation()` is given `excludeObservers`, the overseer **blocks the observation** if any named observer is still authorized, and only lets it proceed (tearing down the observer) if they've already lost access. So erring toward listing an observer is never a leak — at worst it blocks an observation that could in principle have been allowed. The leak-relevant gate is always the live sharing graph, so stale observer state self-heals on the next open.

## Hooks (push notifications)

Some services can push events to the Gadget (inbound email, webhooks, chat messages, etc.). A gatekeeper exposes this as a **hook**: the Gadget registers a callback, and the gatekeeper later invokes it when an event arrives. Hooks are persistent — they survive across sessions and server restarts — and are subject to the same observation/action approval model as everything else.

`gatekeeper-email` is the canonical reference implementation. Read it alongside the `HookController`, `HookInitiator`, and `ApprovalQueue.bindHook()` JSDoc in `gatekeeper.ts`.

### The pieces

- **Hook interface** (in `types.d.ts`): the methods the Gadget implements to receive events, e.g. `EmailHook.receiveEmail(email)`. It is implemented by the Gadget as an **`RpcTarget`** (or a plain function), *not* a `WorkerEntrypoint`. Reference it from `describe()` via `hookTsType`.
- **Session method**: a method like `subscribe(callback)` that the Gadget (or, more commonly, an agent in a one-off `executeCode` call) uses to register interest. The `callback` is a **persistent stub** (created by the Gadget with `ctx.restore()`), so it can be stored and re-invoked long after the session ends.
- **`HookController`** (a `WorkerEntrypoint` you implement): lets the overseer `enable()` / `disable()` the hook. All the state it needs must live in its `props`, so it is constructed via `this.ctx.exports.MyHookControllerImpl({props})` **at bind time**, immediately before calling `bindHook()` — see below.
- **`HookInitiator`** (provided to you by the overseer): you call `startHook()` on it when an event arrives.

### Lifecycle

1. **Register.** The Gadget calls your Session method (e.g. `subscribe(callback, filter)`). Inside it, construct a `HookController` whose `props` capture the specifics of *this* registration, then call `approvalQueue.bindHook(controller, callback, description)`. The overseer stores the callback and records the hook (initially **disabled**). Do **not** store the callback yourself — it is bound to the current session and would be revoked when the session ends.
2. **Enable.** When the user approves the hook in the Workshop UI, the overseer calls `controller.enable(initiator, target)`. Store the `initiator` Fetcher somewhere it can be reached when events arrive (e.g. an event-source DO). `target` identifies where the hook delivers (workspace, plus gadget when the hook is pinned to one); persist it alongside the initiator if you display or link to the target — the IDs are fixed when the hook is bound, so there is nothing to refresh. A gatekeeper that doesn't need it still has to declare the parameter, since RPC argument validation rejects arguments the receiver doesn't declare. Avoid storing any other state until enabled; everything else should already be in the controller's `props`.
3. **Deliver.** When the event occurs, call `initiator.startHook()`. This returns `{callback, approvalQueue}` bound to a fresh session. Call `authorizeObservation()` (a hook event is almost always an observation; register actions too if the callback's return value triggers side effects), then invoke the `callback` to deliver the event to the Gadget.
4. **Disable / delete.** The overseer calls `controller.disable()`. Forget the stored `initiator` and clean up all related state — `disable()` may never be called again, though the overseer may later call `enable()` afresh.

Because the callback is a persistent stub tied to a session, the gatekeeper never stores it directly; the overseer hands it back (re-bound to a new session) each time you call `startHook()`. See the SKELETON for the full code shape.

### Documentation

When defining a session interface with hooks, it's important to include comments that clearly state when a method expects to be passed a *persistent* stub created with `ctx.restore()`, as opposed to a regular RpcStub. The caller needs to do extra work to make sure the stub they provide you is persistent.

## Tips

- `types.txt` must be a **symlink** to `types.d.ts`, never a copy.
- Call `.dup()` on `approvalQueue` stubs before storing in a session, since Cap'n Web automatically disposes all stubs in parameters to an RPC call when the call returns.
- `suggestedBindingName` in `describe()` reflects the resource **type** (e.g. `"GMAIL_INBOX"`), not the specific instance.
- For read-only or push-only gatekeepers, `applyAction()` / `rejectAction()` / `revertAction()` can simply throw (they'll never be called since the gatekeeper never submits actions).
- For `WorkerEntrypoint` and `DurableObject` subclasses, pass credentials and resource IDs via `ctx.props`, not constructor arguments. RPC stubs pointing to these types can be stored in long-term storage and restored later, creating a new instance based on the same `props`.
- If the gatekeeper implements multiple unrelated resource types with disjoint APIs, each may have its own `.d.ts` file, so that the `getTypeScriptTypes()` method of the specific `Gatekeeper` implementation only returns the types that matter for it. The `getTypeScriptTypes()` method on the top-level `GatekeeperVendor` should return the concatenation of all of these.
- All DO classes must appear in `wrangler.jsonc` under `migrations[].new_sqlite_classes`.
- Set a self-destruct alarm in `UserAccount.setCallback()` in case the OAuth flow is never completed.
- `authorizeObservation()` may be called *after* fetching data (so the description can include details about what was fetched) but must be awaited *before* returning anything to the caller.
- `getVerifier()` / `addObserver()` / `removeObserver()` are **mandatory** — the gatekeeper won't type-check without them. Even a read-only or push-only gatekeeper needs them (sharing is independent of whether the gatekeeper has actions). Pick a strategy per [Observers](#observer-verification): a low-stakes one can be A or D; otherwise B/C.

## Reference implementations

- `packages/gatekeeper-google/` — OAuth, multiple resource types (Gmail, Google Docs, BigQuery), actions, caching/simulation examples, multiple Session types. **Observers:** all three strategies in one package — Gmail=A (always throw), Doc=B (single-unit ACL via `GoogleVerifier.hasDocAccess`), BigQuery=C (dataset tracking via `hasDatasetAccess`).
- `packages/gatekeeper-email/` — Hook-based push notifications, no actions, email address claiming. **Observers:** strategy D (low-stakes no-ops + trivial verifier).
- `packages/gatekeeper-github/` — **Observers:** clean strategy B example — `GitHubVerifier.hasRepoAccess` plus a one-method `addObserver`.
- `packages/gatekeeper-supabase/` — **Observers:** strategy C with a per-session context object (`authorizeProjectObservation`) — good when sessions already hold a shared context.
- `packages/gatekeeper-linear/` & `packages/gatekeeper-notion/` — **Observers:** strategy C where the page/team session impls are shared between the narrow (B) and broad (C) bindings, threading an `observe` hook through sub-sessions; both also handle one observation revealing multiple sets.
- `packages/workshop-shared/src/gatekeeper.ts` — Canonical interfaces with detailed JSDoc (`getVerifier`, `addObserver`, `removeObserver`, `GatekeeperUserVerifier`, `ObservationDescription.excludeObservers`).
