---
name: write-gatekeeper
description: Guides implementation of Gatekeeper Workers that bridge Gadgets to external services. Covers auth, capability-based API design, approval queue integration, action kinds and auto-approval verdicts, caching, and action simulation. Load when creating, modifying, or reviewing the implementation of a gatekeeper.
---

# Writing a Gatekeeper

A Gatekeeper is a Cloudflare Worker that mediates all access between a Gadget and an external service. It implements a three-tier hierarchy:

- **Vendor** (`GatekeeperVendor`, a `WorkerEntrypoint`) — top-level entry for the service. One per service.
- **User** (`GatekeeperUser`, a `WorkerEntrypoint` with `ctx.props`) — a human user's authenticated connection.
- **Instance** (`Gatekeeper<Session>`, a DO facet of the Overseer) — per-resource, per-Gadget binding that provides the Session API.

Read `packages/workshop-shared/src/gatekeeper.ts` for the canonical interfaces and detailed JSDoc.

## New-gatekeeper observer contract

Write new gatekeepers to this observer contract:

- Every read that returns information to its caller (provider data, anything derived from it, or simulated state) explicitly reports `subresources`: every resource whose access rules govern that information. A [simulated](#simulation) read reports every real resource its data came from. All observer authorization goes through `verifyObserverAccess()`; no requirement may live only in a binding-wide admission check.
- `subresources: []` adds **no requirement**. It does not clear requirements already recorded, and it never means "the binding already checked it." Private-only provider data reports a real resource ID and denies collaborators through `verifyObserverAccess()`. Report and verify any required workspace or tenant membership explicitly.
- Implement `getHistoricalSubresources(): Promise<string[]>` as a read-only method returning `[]`, with no legacy tracker. It is required even though the current `Gatekeeper` interface does not declare it, so type-checking will not catch its absence. Do not omit or remove it.
- Implement `addObserver(id, verifier)` and `removeObserver(id)`, which the current interface requires, as **compatibility-only no-ops**. Do not introduce observer rosters, observed-set logs, stored observer verifiers, `excludeObservers`, or new legacy trackers.
- Require `subresources` in your read helper's type; the shared type still makes it optional. Type-checking does not enforce the whole contract; use the [review checklist](#reviewing-a-gatekeeper).

The current `gatekeeper.ts` JSDoc still describes the legacy protocol, in which `addObserver()` must verify and throw and a binding-wide requirement such as tenant membership belongs there. For new gatekeepers this section overrides it. The current kernel already supports that: it checks every reported requirement itself through `verifyObserverAccess()`.

This is a **new-authoring** rule, not a shortcut for migrating existing gatekeepers. Existing migrations must preserve old checks and export their historical requirements through `getHistoricalSubresources()`; they cannot export a blind `[]` or turn their admission methods into no-ops. See [Existing-code migration and legacy history](#existing-code-migration-and-legacy-history).

## Seven responsibilities

1. **Auth management** — Manage authorization to the external service via OAuth (or similar), on behalf of the human end user. This means managing "connected accounts" — token storage, refresh, and revocation in a `UserAccount` Durable Object.

2. **API design** — Provide a TypeScript API wrapper around the service's API, compatible with Cap'n Web RPC. The interface should be designed around capability-based security: object-oriented, with separate interfaces representing logical resources. For example, the Google Docs gatekeeper provides an interface to a *specific* document, rather than a coarse-grained interface where you pass the doc ID to every method. **IMPORTANT:** When writing a new gatekeeper, design a proposed API and then STOP to let the operator review and make changes before proceeding with the rest of the implementation. Getting the API right is the most important and delicate part of creating a new gatekeeper.

3. **Fine-grained resource granting** — Enable the end user to grant access to agents at fine granularities, in addition to coarse-grained access. For example, a user may want to give an agent access to a specific Google Doc or GitHub repo, rather than granting broad access to everything they can do. This should be straightforward given a capability-based API. That said, broad access should also be allowed when it makes sense. Consider carefully which granularities are meaningful — a Jira gatekeeper might support "whole service", "project", and "issue" granularities, but it would be silly to support granting access to a single field of an issue separately.

4. **Logging & approvals** — Every action the agent or gadget performs must be logged via the `ApprovalQueue` API. Every action with an externally-visible side effect must be submitted via `submitAction()`, and must not actually be performed until `applyAction()` has been called. Every action declares an `autoApprovable` verdict, `true` unless the [opt-out policy](#action-kinds-and-auto-approval) applies. Read-only observations must call `authorizeObservation()` before returning data to the caller. Reads the gatekeeper makes for its own purposes, returning nothing to the caller, are not observations (see [What counts as an observation](#what-counts-as-an-observation)).

5. **Caching** — When it makes sense, cache remote content in the gatekeeper's DO storage to improve performance when agents or gadgets repeatedly read the same data. Caching also enables a better TypeScript API when the service's underlying API has an inconvenient data shape. For example, Gmail's API for listing threads returns only thread IDs without metadata, requiring a callback for each thread; with caching, the gatekeeper can provide an API that returns rich thread summaries directly, reading from local content synchronized with Gmail as needed. See Phase 2 for implementation guidance.

6. **Simulation** — Actions submitted but not yet applied should be simulated as if they already occurred, to the maximum extent reasonable. If the caller reads back data, it should observe the data as if pending actions had been applied, even though they haven't yet. This allows the agent to continue working without waiting for each approval, and allows the end user to batch-approve a lot of work at once. Simulation may leverage caching (updating the cache on submit, clearing or repopulating it on reject), or it may work by storing pending actions separately and adjusting read results at query time — the latter is arguably cleaner but trickier to implement correctly. See Phase 2 for implementation guidance.

7. **Observer verification** — When a Gadget is shared, collaborators may see data it previously read. Every observation reports the resources that restrict its audience, and `verifyObserverAccess()` checks whether each collaborator could read all of them. Design this model with the Session API and implement it before any restricted provider data is returned; it is not a deferred Phase 2 concern. See [Observer verification](#observer-verification).

## Phase 1: Core implementation

In the first phase, focus on responsibilities 1 - 3, the observation half of responsibility 4, and the access model in responsibility 7. Every read must already authorize its observation with complete `subresources`; returning restricted data with `subresources: []` while planning to implement security later is not acceptable. Actions, caching, and simulation follow in Phase 2.

### Step 1: Understand the external service

Study the service's API docs. Identify:
- Auth model (OAuth 2.0, API keys, etc.)
- Resources to expose and what access granularities make sense
- Which operations are observations (read-only) vs. actions (side effects)
- For each action, its kind (the group a user would enable together, labelled like "Edit labels") and its auto-approval verdict (see the [opt-out policy](#action-kinds-and-auto-approval))

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
- Design the subresource/access model alongside these types: which canonical resource IDs each read reports (including parent membership requirements), what each kind means, and how the observer's account is checked. Include cursor pages, cache hits, empty results, nested capabilities, and hook deliveries.

#### Documenting the API (`types.d.ts`)

This JSDoc is the agent's sole documentation for the API, so keep it **narrowly focused on what the agent needs to use each method**: what it does, its parameters, the returned data shape, and any errors the caller must handle.

Do NOT leak details the caller doesn't need to use the API — the approval queue (never mention `submitAction`/`applyAction`/approvals; correct simulation keeps this invisible), or gatekeeper internals (caching, DO storage, OAuth, syncing). Document those in the `.ts` implementation or PR, never in the agent-facing `.d.ts`.

The agent receives the `.d.ts` text **verbatim** (via the `types.txt` symlink), and nothing resolves its imports — so it must be **self-contained**. Don't import types from other packages or files (e.g. `Cursor` from `@gadgets/workshop-shared/gatekeeper`); copy the definition into the `.d.ts` instead. TypeScript's structural typing means the implementation can still return the shared type. The only exception is `cloudflare:workers` (e.g. `import type { RpcTarget } from "cloudflare:workers"`), which the agent's environment provides. `pnpm lint` enforces this with the `gadgets/self-contained-agent-types` rule on every `packages/gatekeeper-*/src/*types.d.ts`. Also keep the file free of comments aimed at maintainers (such as "keep in sync with X"), since the agent reads those too.

### Step 3: STOP — Present API for review

**Do not proceed without operator approval.**

Present the proposed `types.d.ts` and explain the design: what resource granularities are supported, what Session methods do, and what trade-offs were made. The API is the most important and delicate part of a gatekeeper — getting it wrong means rebuilding. Wait for the operator to review and approve (or request changes) before continuing.

Present the subresource/access model too: map every data-revealing method and hook to its reported resource kinds and verifier checks, including private-only data and empty/cached pages. Review it before implementation; observer authorization cannot be postponed until Phase 2.

Also confirm the JSDoc follows [Documenting the API](#documenting-the-api-typesdts) — no approval-queue or implementation details leaked in, and run the [API review](#reviewing-a-gatekeeper) on your own design first.

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
├── cloudflare.config.ts      # wrangler.jsonc is generated from it
├── package.json
└── tsconfig.json
```

#### Authorizing observations

Any operation that returns information to its caller must await `authorizeObservation()` with explicit `subresources` before returning, including cached data, simulated reads, cursor pages, and hook deliveries. Study the `ApprovalQueue` API in `gatekeeper.ts` for details.

##### What counts as an observation

The observation log records what the **caller** (agent or gadget) learned, not what the gatekeeper read. Deciding this correctly keeps the log readable for the user. Ask: *what information did this call hand back to the caller?* If the answer is "nothing", don't log an observation, however much the gatekeeper fetched internally.

Do **not** call `authorizeObservation()` for:

- **Reads that only prepare an action.** A mutation that fetches current state to build the action description, bind an expected old value, capture revert information, or validate the request, and then calls `submitAction()`, returns `void` (or a provisional stub or a freshly generated ID). The action description the user approves already shows what was read. Don't log "Read X before mutation".
- **Session setup.** `startSession()` resolving the account, a bound label, and so on returns only a session stub.
- **Creating a cursor or stub that returns no data itself**, provided its later reads (cursor pages, `getDetails()`, …) log their own observations. Log wherever the data actually crosses to the caller; if a cursor logs once up front and not per page, that up-front log is the real one and must stay.
- **Information that leaks only through a validation error** ("label already exists", "branch is not a fast-forward").

**Existence checks are a judgment call, but usually not an observation.** A method like `getIssue(id)` that confirms an item exists and returns a stub tells the caller one bit. When the ID is an unguessable, high-entropy value (a Gmail message ID, a commit SHA, a UUID), that bit is no information at all: a caller that already holds the ID knows the item exists, and the ID itself encodes nothing. Sequential numbers and human-readable names are more ambiguous, but an agent leaking information by probing whether titles exist is far-fetched, so the default is not to log. Log the stub's real reads instead. Don't put fetched details (such as the item's title) into a log entry for data the caller never received.

Returning a boolean or count *is* data when that is the answer the caller asked for (`isFollowing()`, `areTracksSaved()`, a `null` from `getArea()` meaning "no area"). Log those.

**Exception: access enforcement.** Some observation fields do more than log. `subresources` is what collaborators are verified against, and `containsRestrictedData` / `ownerInvitesOnly` change workspace state. Removing a call that carries these controls (for `subresources`, a non-empty list) is a security decision, not a logging cleanup (see the Drive session's "Check Google Drive folder" fences). Existing legacy code may also enforce security through `excludeObservers` and tracking side effects; preserve those until its migration covers them.

### Step 5: Register

There is no binding to add. `run-dev-server.ts` binds every `packages/gatekeeper-*` that has a `wrangler.jsonc` to the backend as `GATEKEEPER_<NAME>`, and the deploy service does the same for installed gatekeepers. The backend auto-discovers vendors from `GATEKEEPER_`-prefixed bindings (see `packages/workshop-backend/src/user.ts`).

### Step 6: Add resource selection UI

Add a resource selection UI for each connect card. A card is one resource type returned in `getSupportedResources()`, together with any types whose `groupedWith` names it. This will be used by users to select the specific resource.

- Workshop calls `GatekeeperUser.startResourceConfigurator(resourceUrlPattern)` with the `urlPattern` of a type on the card: the card's own type from the connect dialog, or a binding's own type from a blueprint. Return the card's configurator for every type on it.
- Return `iframeHtml` of the selection UI and `ui` for any RPCs that UI needs.
- When the user selects "Add connection", Workshop asks the iframe for the selected resource URL.
- Group types (`SupportedResource.groupedWith`) when they are one choice found in one place, such as a whole drive, a folder, a file, or a document in it. Each type is still granted separately, and a grouped card asks for the missing ones in one consent request, so a user connecting any type on the card is asked for every type on it; group types that need different authorization only when that is acceptable. The gatekeeper's `getGatekeeperClassFor` decides which type a returned URL is, while Workshop's grant check takes the first type in declaration order whose pattern matches it, so declare a narrower type before a broader one whose pattern also matches its URLs. A whole-instance `https://*` type is the exception: the check skips it and uses it only for a URL no other type on the card matches, so it can be declared anywhere.

Keep the iframe-facing capability narrow, only what's necessary to provide desired interface to help user find and select the resource.

#### Optional helper: `@gadgets/configurator-ui`

For configuration UIs, use `@gadgets/configurator-ui`. It provides form components built on Kumo (rendered with Preact standing in for React inside the frame) that look and behave like the rest of the Workshop, and a build that turns `src/configurator/*-ui.tsx` into `iframeHtml`. Gatekeepers whose needs the components cannot meet can produce their own `iframeHtml`.

Components: `Section`, `Field`, `TextInput`, `RadioCards`, `CheckboxList` (multi-select; refuses more than 200 options rather than truncating), `Autocomplete` (search-as-you-type, one result), `HierarchyPicker` (choose the whole hierarchy from a card above the list, or an open container or a leaf from its own row; as in a file dialog, a choice lasts while it is in view; a container's `choice` says what connecting it grants, since only the gatekeeper knows whether that is its whole subtree, and a node's `unselectableReason` says why it cannot be connected; breadcrumbs with a back button, optional search, paging and `loadItem`, which pre-filling anything but the root needs; optional `tabs` split what lies below the root into top-level containers or views, each listed with its id as `parentId` and heading the `path` of every node under it, and offered as a choice only with `selectable: true`; nodes name icons the configurator supplies in `icons`, and may carry a `badge`, at the end of the title's line, and a `meta`, at the end of the subtitle's; a location that cannot be listed yet, such as one waiting on a grant, returns a page with `unavailable` set to why, shown with Retry like a failed load but not reported as an error, while a page's `notice` tells the user something about a listing it can show, such as that it is partial or why it is empty), `Button` (an action in the form; call the render context's `ensureResources` from its click to ask for access the next step needs) and `Notice` (an inline info or error message, announced to screen readers; its `action` puts the one step the message leads to, such as allowing access, in the same row, so prefer it to a Notice followed by a Button, and keep Buttons for a choice between steps). The runtime strips control and bidi-formatting characters from titles, subtitles and meta it shows, since those come from third parties.

If you use this:

- UI modules live in `src/configurator/*-ui.tsx`.
- `resourceUrl()` returns the selected resource URL.
- A module that can return several types reads `acceptedResourceUrlPatterns` from the context every callback receives (`render`, `isReady`, `resourceUrl`, `initialValuesFromResourceUrl`): the types Workshop will take, which leave out a grouped type the account hasn't granted and anything a blueprint binding doesn't want. Show other types if that helps the user find their way, but don't let them be chosen, and keep `isReady` false while one is. It is `undefined` from an older Workshop, which takes any type. The list is read when the frame starts, and Workshop restarts the frame when it changes.
- `src/configurator/*-types.d.ts` describes the iframe-facing `ui` API.
- Each module is compiled on its own: it may import only `@gadgets/configurator-ui` and types. URL grammar it shares with the server is copied, and a test keeps the copies in step.
- The frame's content security policy allows exactly the scripts the build wrote (by hash) and no network access; anything the UI needs goes through `ui`.
- `scripts/build-gatekeeper-configurator.ts` generates `src/generated/*.txt`, using the runtime and build in `packages/configurator-ui` (`src/runtime/`, `build/`).
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

  The runtime seeds these values before first render and reflects them in `Autocomplete`/`TextInput`/`RadioCards`/`HierarchyPicker` inputs. Make sure your `resourceUrl(values)` and `initialValuesFromResourceUrl(url)` are inverses so a prefilled form round-trips to the same URL. **Every gatekeeper with selectable resources should support this** so agents can fully pre-configure a connection.

  A creation configurator (`startCreationConfigurator`) is pre-filled from the configuration the agent suggested (`createExternalResource`'s `configuration`), paired with the pattern of the type being created. Set `creationConfigurationDescription` on the type to let the agent suggest one, naming what your configurator's `resourceUrl()` returns (Google: "the URL of the Google Drive folder to create it in"); without it the kernel refuses a suggestion. That URL is not one of the type's, so map it with `initialValuesFromResourceUrl`: the automatic mapping would read it as the resource being created. An agent picked it, so tell the approver while the choice is still the agent's.

### Step 7: STOP — Ask operator whether to proceed to phase 2

The operator may prefer to implement phase 2 later, perhaps in a new context. Stop here and ask the operator whether to proceed.

## Phase 2: Actions, caching, and simulation

Complete the action half of responsibility 4 and responsibilities 5-6 in this phase, building on the observation authorization and observer checks already protecting the core implementation. These refinements may be implemented in a separate session; access enforcement is not optional in between.

### Actions and approvals

Go through all the API methods and decide where to insert `submitAction()` calls, and confirm every read still authorizes its observation as in [Authorizing observations](#authorizing-observations).

- Any operation which has visible side effects on the world must call submitAction(), and must not actually apply the action until approved.

Study the `ApprovalQueue` API in `gatekeeper.ts` for details.

#### Action kinds and auto-approval

Every action declares an `autoApprovable` verdict, and a kind (`{tag, label}`) whenever the verdict can be `true`; kit definitions always declare both. Nothing auto-applies until the user enables a rule for the kind; the verdict says whether honoring it is safe for *this* action.

**The default is `true`.** Use `false` only when the action:

1. deletes or removes content (its restore counterpart is true);
2. sends content as the user to people outside the bound resource;
3. spends money or billed credits;
4. runs arbitrary code, queries or service calls where one kind covers both benign and destructive effects;
5. passes a governance gate (merge, approving review, push to a default or protected branch, deploy, publish);
6. is barred from automation by provider policy;
7. changes permissions, sharing or membership.

Exceptions, kept `true` by decision although a rule covers them; add one only with the maintainers' agreement:

- Gmail's trash, spam, draft delete and label delete (rule 1): routine mailbox upkeep, and trash and spam are undone in Gmail.
- GitHub's force push to a branch that is neither the default nor protected (rule 1): it has its own `forcePush` kind, which a user enables apart from other pushes.
- X's bookmark, mute and hide (rule 3): one billed write each, and the only X writes its developer policy lets software automate (see `packages/gatekeeper-x/AGENTS.md`).
- Google Drive's comments and replies that mention an address after `@` or `+` (rule 2): Google emails the mentioned person the text, even one who cannot open the file; the comment itself goes on the bound file, and the gatekeeper looks for no mention, so the one "Drive comments" kind covers them (see `packages/gatekeeper-google/README.md`).

Every `false` carries a one-line comment naming its rule. Posting into the resource the user bound (its channel, thread or issue) is not rule 2. A package's `AGENTS.md` or README may be stricter (e.g. `gatekeeper-x`); follow it.

Where the verdict depends on the payload, compute it instead of a blanket `false`: per payload in a hand-built `ActionDescription` (`autoApprovalOf` in `packages/gatekeeper-github/src/github.ts`), or in the kit as sibling definitions, one `true` and one `false`, that the session picks between at submit (`editSheetValues` and `updateSpreadsheet` in `packages/gatekeeper-google/src/sheets-actions.ts`). The existing definition keeps its name, since stored records resolve by it. When the facts behind a `true` can change before apply (an event gaining attendees), re-check at apply time.

A newly `true` action gets a new tag, never one that already has a `true` action: users' stored rules would silently start covering it.

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

**Simulation doesn't change what a read reports.** Provider data is anything that came from the
provider's API, whether fetched by this read or earlier and cached.

- A simulated read reports every real resource its data came from, in the provider's current
  (unapplied) state, plus every container the simulated view places it in.
- Content the gatekeeper itself fetched for an action (previous values or a server-side copy source)
  keeps its source's IDs when stored in pending-action state and replayed.
- Pending permission changes never relax what a read reports, and `verifyObserverAccess()` checks
  live provider state only.
- Caller-supplied content and generated provisional IDs add no source IDs by themselves. The kernel
  does not propagate source requirements with text an agent quotes into an action argument. A read
  returning only such content still authorizes, reporting `[]` plus any container or account
  requirement.
- Do not invent IDs for pending actions or simulated resources.

Keep simulation and cached state in the connection's facet storage, never in the account Durable
Object. Every chat and gadget on the connection reads it, so authorize each read through the reading
session's own queue, never one captured at submission, and never assume the reader already received
what it replays. Content one chat writes into a pending action reaches other chats and gadgets before
approval, with no requirement, and stays disclosed if the action is rejected; the kernel accepts this
as indirect disclosure (`docs/observers.md` §10). See the kit's
[simulation rules](../../../packages/gatekeeper-kit/USAGE.md#simulation-and-subresources).

Keep in mind that the agent calling the API (or the agent writing a gadget to call it) is generally not aware that actions do not take place immediately. If the simulation is correct, the agent doesn't need to be aware. If the simulation has gaps, you may want to mention it in your API's doc comments, so that the calling agent knows to work around them — but ideally there are no gaps and the calling agent does not need to think about it.

For concrete examples, see the Google gatekeeper's Google Docs simulation/cache handling and BigQuery dry-run scope enforcement.

### Observer verification

This is responsibility 7. The gatekeeper reports what each disclosure depends on; the Workshop tracks those dependencies and asks, through `verifyObserverAccess()`, which observers can access them. Which collaborators it asks about, and when, is the Workshop's policy (`docs/observers.md` §10), not part of the gatekeeper's contract: answer correctly for whichever observers a call names.

For **new gatekeepers**, there is one authoring protocol: explicit `subresources` on every observation, with no binding-wide admission dependency. Omitting the optional field selects legacy behavior; it does not fail type-checking. Prevent that omission with a typed helper, not a legacy tracker.

The members involved:

- `GatekeeperUser.getVerifier()` mints a persistent `GatekeeperUserVerifier` representing this account. The Workshop only passes it back to the same vendor, so its non-standard methods can be trusted as that vendor's access oracle.
- `ObservationDescription.subresources` is explicit on every observation. `[]` adds no requirement; requirements already recorded stay in force.
- `Gatekeeper.verifyObserverAccess(observers, subresources)` returns the IDs of observers whose accounts can read **every** reported resource now. Implement it for every reported resource kind, including any historical IDs an existing connection exports; throw if access is indeterminate.
- `getHistoricalSubresources(): Promise<string[]>` exports observer history recorded under the legacy protocol. Every gatekeeper implements it, although the current interface does not declare it. New gatekeepers return `[]` from a read-only method; existing ones export what they actually observed (see [Existing-code migration and legacy history](#existing-code-migration-and-legacy-history)).
- `addObserver(id, verifier)` and `removeObserver(id)` are required by the current interface. New gatekeepers implement them as no-ops, without authorization or bookkeeping.

#### The verifier "non-standard method" pattern

`GatekeeperUserVerifier` is opaque. Define a vendor-specific interface extending it with access-check methods, implement it on a `WorkerEntrypoint` using the **observer's own credentials**, and cast the `Fetcher` back to that interface inside `verifyObserverAccess()`. The same-vendor guarantee makes that cast safe.

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
      // Only a definite permission denial or inaccessible resource means false (e.g. 403/404
      // under this provider's documented semantics). Expired credentials, timeouts, rate limits,
      // and provider failures are indeterminate: rethrow so the authorization fails visibly.
      if (isDefiniteNoAccess(error)) return false;
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

Choose a **reporting and verification strategy**, not a legacy observer-admission implementation.
Start per resource type / binding, then refine **per disclosure**: a single session can combine
private account discovery, shareable item reads, and unrestricted local results. All strategies
use the same explicit-`subresources` protocol:

- **A — Private-only / account identity.** Report the private resource's real ID (for example, `gmail/user/<sub>`), never a synthetic "private" marker. The verifier denies collaborators or permits only the same provider identity, according to the intended policy. Labels, searches, and other capability filters do not create separate sharing ACLs. For sensitive data also set `containsRestrictedData: true`; it restricts actions and web fetches, but does not replace reporting or verification.
- **B — One access-controlled unit.** Report the resource on each read of its data. Its verifier must cover the actual disclosure: access to public metadata, ordinary event details, private details, and free/busy can differ even for one provider object. Use distinct resource kinds when those information classes need different checks. A repo/document/page binding must not report `[]` because its old implementation checked access at admission.
- **C — Multiple access-controlled units.** Report the union of the disclosure's requirements, including independently required container/tenant membership. Variants include a list spanning ACLs, a query derived from several data sets, and a hierarchical read requiring both a folder and independently protected children. Choose dependencies from the information actually disclosed, not every source consulted. The Workshop, not the gatekeeper, records what was observed; do not create a data-set log or store observer verifiers.
- **D — Unrestricted disclosure.** Report `[]` only when no provider-side access requirement restricts the answer. This can be a public read, a local echo of supplied configuration, or a source-free computation inside an otherwise restricted binding. "Low-stakes", "no results", and "no newly observed resources" do not establish D. A trivial verifier still needs a public method (e.g. `verify(): void {}`), since an empty `WorkerEntrypoint` is not registered in `ctx.exports`.

**Connection-only access is B, not D.** When the deployed Worker's configuration fixes the one
service instance every account connects to, and any account connected to it may read everything
disclosed, report `[GLOBAL_SUBRESOURCE_ID]` from `@gadgets/gatekeeper-kit/subresource-ids`, not `[]`.
When accounts choose their instance, report a structured instance ID and compare it with the
observer's instance instead. Check a fixed, deployment-defined read entitlement covering every
disclosure reported as `global`, not the owner's role or scopes; use distinct resource kinds when
reads need different entitlements. Check that the grant is live and document how long a removal
from the instance goes unnoticed. Per-resource ACLs, role differences affecting read visibility,
or private account data need stronger checks. See the kit's
[connection-only recipe](../../../packages/gatekeeper-kit/USAGE.md#connection-only-access-global).

Keep three decisions separate: **what the binding grants**, **what this answer discloses**, and
**what the observer oracle proves**. A table grant may report its dataset; a label-scoped mailbox
can remain private to the account; a folder grant need not make its descendants one ACL. Account-wide
discovery may reveal private membership or metadata beyond the individually shareable items it lists.
Mix A with B/C where necessary rather than declaring the whole package private or unrestricted.

Choose IDs and checks together. Resolve account-relative aliases (`me`, `primary`, a personal `root`)
to stable provider identities before recording them, or refuse them. Encoding does not make an alias
stable. The same recorded ID must name the same resource across accounts and reconnects.

If there is no reliable oracle for the **disclosed information**, choose private-only, not
unrestricted sharing. A successful metadata probe is not proof of content, table-row, or private-field
access; conversely, do not require mutation rights unless they are needed to see everything disclosed.
A parent ACL may stand in for children only when the provider guarantees equivalent access.
See the kit's [strategy guide and worked Google patterns](../../../packages/gatekeeper-kit/USAGE.md#choosing-reporting-and-verification-strategies)
for scope-specific examples and implementation caveats.

#### Reporting subresources

Use the `ObservationDescription.subresources` and `Gatekeeper.verifyObserverAccess()` JSDoc for ID limits and answer shape, and this skill for the access model: no restriction may depend on admission.

1. **Report every dependency on every read that returns information to its caller**, not just resources new to the binding. Include cursor pages (even buffered pages), cached data, simulated reads, nested capability reads, and hook deliveries. There is no blanket requirement to retain every consulted source for an empty result; report requirements for information actually disclosed.
2. **Build canonical IDs** with `formatSubresourceId()` from `@gadgets/gatekeeper-kit/subresource-ids`; compare the connection-only `GLOBAL_SUBRESOURCE_ID` directly before parsing. Fragments name real resources, never predicates. Cloud IDs, workspace URLs, and similar provider-instance identifiers are tenant identities: qualify resources with their tenant unless the deployed Worker's configuration permanently fixes it. A tenant chosen by an account, binding, or URL is not fixed, and one OAuth app does not establish a single tenant. Omit the namespace for a single-product provider. IDs must be stable and non-secret, since they are checked on later opens. See the kit's [ID guidance](../../../packages/gatekeeper-kit/USAGE.md#subresource-ids-name-resources).
3. **Make omissions a type error locally.** Route reads through a helper taking `ObservationDescription & { subresources: string[] }` (see [SKELETON.md](SKELETON.md)). New code needs no `ObservationGate`, whose constructor demands a legacy strategy; existing gate code converts reads with the kit's `subresources` scope instead. Thread the authorizer and this contract through child sessions, cursors, and hook-delivery code.
4. **Check each observer against every ID** in `verifyObserverAccess()`. Reuse `observerAccessVerifier` from `@gadgets/gatekeeper-kit/observers` over a batched vendor oracle, or implement the canonical method directly. Decode/validate resource kinds and identities; refuse unknown IDs. Return only observers allowed for the whole set. Definite denial is `false`; expired credentials, outages, and other indeterminate results must throw, not become an allow or a silent denial.
5. **Keep verification independent of read authorization.** Do not store supplied verifiers, cache verdicts by observer ID (the same observer can return with another account), or wait on a lock held by a read awaiting authorization. Account-side caches must be partitioned by credential authority.
6. **Implement the remaining required members**: `getHistoricalSubresources()` returning `[]`, and no-op `addObserver` / `removeObserver`, for new gatekeepers. No observer roster, observed-set log, `excludeObservers`, or new legacy tracker is needed.

The Workshop attributes requirements to the trusted authorizer's original chat/gadget, including child capabilities using that authorizer; passing capabilities or data between contexts does not transfer requirements. Persistent hooks must determine dependencies from current binding state: registrations minted before an upgrade may lack newer props.

#### Existing-code migration and legacy history

This section is **only for existing gatekeepers**, not an alternative new-authoring recipe. Legacy reads and history may still rely on `addObserver()`, `removeObserver()`, observed-set logs, stored verifiers, and `excludeObservers`. Preserve their enforcement while converting every session/cursor/hook path to complete subresource reporting. Do not neutralize old checks merely because new reads now report IDs.

Implement a complete, deduplicated `getHistoricalSubresources()` export of historical access requirements. Do not omit a legacy requirement merely because a later observation reported the same resource ID: reports are context-specific, so a read in one chat or gadget does not cover historical disclosures in another. `verifyObserverAccess()` must accept and enforce every exported resource kind. Do not seed a binding requirement merely because a connection exists when the legacy state proves that no restricted data was observed. Keep the legacy records the export reads, make the export read-only and repeatable, and never truncate or discard history.

The exporter must return a valid, complete, conservative `string[]` for every supported legacy state.
Do not intentionally throw because granular historical resource IDs are unavailable; return broader
real resource IDs whose verifier checks preserve all historical access restrictions. A container or
tenant ID is sufficient only if its verifier also covers every possible historical disclosure from
its children; otherwise use an account-private resource whose verifier denies collaborators.
Return `[]` only when no historical access requirement applies, never merely because history is
unknown. Unexpected storage or runtime failures must propagate, not become an empty or incomplete
export.

The current kernel does not call this export; its importer is still deferred in
[`plans/kernel-observer-tracking.md`](../../../plans/kernel-observer-tracking.md#deferred). Retain
legacy enforcement until every affected read reports complete requirements and a shipped kernel
importer has committed the complete historical requirements to the observer ledger. Implementing
the exporter alone does not replace enforcement of past disclosures.

Existing migrations must preserve/export historical access requirements, including membership requirements that governed past disclosures. If existing resource kinds cannot express a safe conservative fallback, define the appropriate real resource kind and its verifier as part of the migration; an empty export or a no-op admission method is not a safe substitute. `docs/observers.md` documents the deployed protocol.

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
3. **Deliver.** When the event occurs, call `initiator.startHook()`. This returns `{callback, approvalQueue}` bound to a fresh session. Await observation authorization with explicit `subresources` for the event's complete access dependencies (register actions too if the callback's return value triggers side effects), then invoke the `callback`. Use the same typed read helper as ordinary reads; a hook is not exempt from observer checks.
4. **Disable / delete.** The overseer calls `controller.disable()`. Forget the stored `initiator` and clean up all related state — `disable()` may never be called again, though the overseer may later call `enable()` afresh.

Because the callback is a persistent stub tied to a session, the gatekeeper never stores it directly; the overseer hands it back (re-bound to a new session) each time you call `startHook()`. See the SKELETON for the full code shape.

### Documentation

When defining a session interface with hooks, it's important to include comments that clearly state when a method expects to be passed a *persistent* stub created with `ctx.restore()`, as opposed to a regular RpcStub. The caller needs to do extra work to make sure the stub they provide you is persistent.

## Reviewing a gatekeeper

Reviews tend to stop at general correctness. The most important review is of the agent-facing API, so pressure-test it:

- **Shape.** Read `types.d.ts` as the agent does, as its only documentation. Does the shape make sense? What would you do differently?
- **User stories.** List the most common things a user would ask an agent to do with this service and walk each through the API. Flag any that are impossible, need sequential round trips that promise pipelining can't remove, or need knowledge the JSDoc doesn't give. Flag dead ends too: anything the grant includes that the agent can't navigate to, such as child pages it can list but not open.
- **Seams.** Check that resource types, bindings and sessions partition authority along the lines users actually grant:
  - Each `getSupportedResources()` granularity is a grant a user would make, and together they cover the common ones (broad and narrow).
  - A narrow binding's session reaches nothing outside its resource: sub-resources come from stubs on their parent, and no method or option field (`parentId`, `projectId`) takes an ID that escapes the binding.
  - Each method sits on the object whose authority it needs. A cross-resource operation (move, copy, link) must not quietly require, or grant, a broader binding than the user picked.
  - Each binding's types expose only what that binding can do and stay small, and its reported resources and verifier checks fit that partition (see [Choosing a strategy](#choosing-a-strategy-per-resource-type--binding)).

- **Observer protocol.** For new gatekeepers, reject any of the following omissions even if the code type-checks:
  - Every read that returns information to its caller explicitly reports its dependencies, including any applicable bound-resource ACL, parent enumeration, and workspace/tenant membership. [Simulated](#simulation) reads report every real resource their data came from plus the containers the simulated view places it in; only caller-written values and provisional IDs add none, pending permission changes relax nothing, and each read authorizes through the reading session's own queue.
  - No access requirement exists only in `addObserver()`; `verifyObserverAccess()` handles every reported kind, checks all IDs per observer, denies unauthorized accounts, and propagates indeterminate failures.
  - Grant scope, disclosure dependencies, and oracle strength are reviewed separately. Account discovery, item/member reads, derived results, and descendant capabilities may need different strategies within one binding; metadata visibility must not stand in for content access.
  - `getHistoricalSubresources()` exists and returns `[]` without reading or keeping any observer state; `addObserver(id, verifier)` and `removeObserver(id)` are no-ops.
  - No new observer rosters, stored verifier tracking, observed-set logs, `excludeObservers`, or legacy trackers.
  - A typed helper requires `subresources`; child capabilities, cursor pages, cache hits, empty results, and hook deliveries cannot bypass it.
  - Runtime coverage exercises denied observers, distinct permission classes, derived/empty results, cached/buffered pages, account-relative aliases and reconnect identity, and hooks where applicable; a successful build alone is not evidence of this contract.
  - Existing migrations instead preserve old checks until replaced and export complete historical requirements; do not apply the new-gatekeeper empty-history/no-op shortcut to them.
- **Auto-approval.** Check every action's verdict against [the opt-out policy](#action-kinds-and-auto-approval) in both directions: a `false` names its rule, and nothing a rule covers is `true` unless it is a listed exception. Ask whether a blanket `false` could be computed from the payload. Flag a renamed tag or definition name, a newly `true` action added to a tag that already had a `true` one, and a `getAutoApprovableActions()` that lists a kind the binding cannot submit as `true`.

## Tips

- `types.txt` must be a **symlink** to `types.d.ts`, never a copy. Because it is delivered verbatim, `types.d.ts` must not import from other modules — inline any shared types (see [Documenting the API](#documenting-the-api-typesdts)).
- Call `.dup()` on `approvalQueue` stubs before storing in a session, since Cap'n Web automatically disposes all stubs in parameters to an RPC call when the call returns.
- `suggestedBindingName` in `describe()` reflects the resource **type** (e.g. `"GMAIL_INBOX"`), not the specific instance.
- For read-only or push-only gatekeepers, `applyAction()` / `rejectAction()` / `revertAction()` can simply throw (they'll never be called since the gatekeeper never submits actions), and `getAutoApprovableActions()` returns `[]`.
- For `WorkerEntrypoint` and `DurableObject` subclasses, pass credentials and resource IDs via `ctx.props`, not constructor arguments. RPC stubs pointing to these types can be stored in long-term storage and restored later, creating a new instance based on the same `props`.
- If the gatekeeper implements multiple unrelated resource types with disjoint APIs, each may have its own `.d.ts` file, so that the `getTypeScriptTypes()` method of the specific `Gatekeeper` implementation only returns the types that matter for it. The `getTypeScriptTypes()` method on the top-level `GatekeeperVendor` should return the concatenation of all of these.
- All DO classes must appear in `cloudflare.config.ts`'s `migrations` export under `new_sqlite_classes`.
- Set a self-destruct alarm in `UserAccount.setCallback()` in case the OAuth flow is never completed.
- `authorizeObservation()` may be called *after* fetching data (so the description can include details about what was fetched) but must be awaited *before* returning anything to the caller.
- Sharing is independent of actions: read-only and push-only gatekeepers follow the full [new-gatekeeper observer contract](#new-gatekeeper-observer-contract). Do not infer security from satisfying only the current interface's required members.

## Reference implementations

Start with [SKELETON.md](SKELETON.md) and the [new-gatekeeper observer contract](#new-gatekeeper-observer-contract), including the empty `getHistoricalSubresources()` and no-op `addObserver` / `removeObserver`. Existing implementations can illustrate reporting and access oracles, but their legacy admission checks are **not** a new-authoring pattern:

- `packages/gatekeeper-google/` — the kit's [worked Google migration patterns](../../../packages/gatekeeper-kit/USAGE.md#worked-patterns-from-the-google-migrations) cover Calendar's event/free-busy permission split, BigQuery source-dataset reporting, Gmail's mailbox identity across filters, Chat's account/conversation split, and Drive/Docs/Sheets/Slides file and folder reporting. These combine A–D per disclosure; the guide notes incomplete oracles and missing history exports. Copy the reporting/helper patterns, not retained legacy admission or tracking.
- `packages/gatekeeper-github/` — every read, each page of a listing and each hook delivery included, authorizes through `GitHubGatekeeperImpl.authorizeRead`, which reports the bound repository as `repo/<repoId>`, GitHub's numeric id, pinned on first use (nothing is read before it is, and REST reads are addressed by it, so a name a deleted or renamed repository freed can't retarget them). `verifyObserverAccess()` refuses any other ID; for the pinned repository it allows every observer when the binding owner's token finds it public (`#reportsPublicRepo`, reused for 15 minutes, an unanswered check counting as not public), and otherwise asks `observerAccessVerifier` over `GitHubVerifier.checkSubresourceAccess`, which the observer's `UserAccount` answers from a `KvTtlCache` partitioned by its connection; `addObserver()` asks, live and with the observer's token alone, for reads made before conversion, `hasRepoNameAccess` of the binding's name, which is what those reads followed, and `GitHubVerifier.hasRepoAccess` of the stored id once there is one, never pinning it, so a lapsed owner grant can't lock collaborators out; caches filled before conversion are discarded on upgrade. Its admission checks are legacy migration protection, not a new-authoring pattern.
- `packages/gatekeeper-slack/` — every read authorizes through `observe()`, which requires what it disclosed and refuses to report none: `workspace/<teamId>/conversation/<conversationId>` for each conversation it listed, matched or read from (a thread, message or member as its conversation, empty pages included), and `workspace/<teamId>` for workspace metadata, the member directory, and a listing or search page naming no conversation. `verifyObserverAccess()` refuses any other ID, then asks `SlackVerifier.checkSubresourceAccess`, which the observer's `UserAccount` answers from a `KvTtlCache` partitioned by its credentials: a workspace by its membership, a conversation by that and `conversations.info` there. Only Slack's denial codes (`SlackApiError.isDenial`) mean no access. `getHistoricalSubresources()` exports a legacy workspace binding's stored workspace and recorded conversations without provider calls or writes; it throws if the workspace or observation history is unprovable, and returns `[]` for a binding whose props carry `reportsSubresources`. Its retained `addObserver()` checks protect legacy reads, not new-authoring patterns.
- `packages/gatekeeper-gitlab/` — A **mirror** of gatekeeper-github for a provider with instance configuration (self-hosted URLs, an optional Cloudflare Access service token on upstream requests) and **rotating credentials** (expiring access tokens, single-use refresh tokens refreshed under a mutex). Reads the same `plans/worktrees.md` §3 git contract through `gatekeeper-kit`'s `git-transport`/`git-objects`/`git-diff`. Its `plans/gitlab-gatekeeper.md` divergence table is a worked example of porting one gatekeeper's API to another provider's vocabulary. **Observers:** strategy B reporting subresources, with a role-aware probe (`hasProjectMembership`): Reporter membership whatever the visibility, since a public project can still hold confidential issues and internal notes, read from `members/all?user_ids[]=` because the project's `permissions` object omits group-inherited access. Every read, each page of a listing included, authorizes through `GitLabGatekeeperImpl.authorizeRead`, which reports `project/<projectId>`, GitLab's numeric id, pinned on first use (nothing is read before it is, and REST reads are addressed by it, so a path a deleted or moved project freed can't retarget them). CI job logs report `project/<projectId>/role/developer`; a test report reports `role/developer` when read through an account confirmed below Maintainer and not an administrator, else `role/maintainer`, since `artifacts:access: maintainer` reports reach only Maintainers — chosen with the role probe under one connection-generation fence as the report is fetched, and never recomputed. `verifyObserverAccess()` refuses any other ID, then asks `observerAccessVerifier` over `GitLabVerifier.checkSubresourceAccess`, which the observer's `UserAccount` answers from a `KvTtlCache` partitioned by its connection; `addObserver()` keeps the `ObserverTracker` for the CI-data sets reads marked before conversion (`CI_DATA_ACCESS_LEVELS`), and asks each level, live and with the observer's token alone, of the binding's path, which is what those reads followed, and of the stored id once there is one, never pinning it, so a lapsed owner grant can't lock collaborators out; caches filled before conversion are discarded on upgrade.
  New GitLab bindings carry immutable `reportsSubresources: true` props and make `addObserver()` /
  `removeObserver()` no-ops. GitLab exports no legacy history (no `getHistoricalSubresources()`), so
  older bindings keep their legacy admission, which, like GitHub's, follows a moved project's
  redirect from its original path; never waive it merely because new reads report IDs.
- `packages/gatekeeper-context/` — kit `subresources` scopes and `observerAccessVerifier`; its tracker and admission baseline serve existing-code migration only. New code must report membership requirements explicitly too.
- `packages/integration-tests/fixtures/gatekeeper-test/` — subresource-reporting mode covers reads and hooks and asks the same-vendor verifier. Its unchanged binding-wide admission method is legacy-only.
- `packages/gatekeeper-scheduler/` and `packages/gatekeeper-websearch/` — explicit `[]` on unrestricted reads/hooks. Do not copy `[]` for restricted provider data.
- `packages/gatekeeper-confluence/`, `packages/gatekeeper-linear/`, `packages/gatekeeper-notion/` and `packages/gatekeeper-supabase/` — tenant-qualified IDs (`site/<cloudId>/…`, `workspace/<…>/…`, `organization/<slug>/…`, since one deployed Worker serves many tenants) reporting the binding's baseline resource plus each narrower resource a read reveals, checked by the observer's `UserAccount` through a credential-partitioned `KvTtlCache`. `getHistoricalSubresources()` exports the baseline legacy admission checked plus each tracker record, from storage only. Their retained admission checks, observed-set trackers and stored verifiers protect legacy history only and must not be introduced in new gatekeepers.
- `packages/gatekeeper-mcp/` — private-only `server/<serverId>` on every read; `verifyObserverAccess()` validates the ID and admits nobody. `packages/gatekeeper-email/`, `packages/gatekeeper-homeassistant/` and `packages/gatekeeper-spotify/` — explicit `[]` everywhere, like Scheduled Tasks.
- `packages/workshop-shared/src/gatekeeper.ts` — current canonical interfaces and ID constraints. Its observer JSDoc still describes the legacy protocol; for new gatekeepers, the contract above overrides it.
- `packages/gatekeeper-x/` — public reads report `[]`; private-account and unknown-author-privacy reads report `user/<id>`, the binding's pinned numeric X identity, per page. Its typed helper requires subresources, and verification compares stored identities without billed resource probes (credential refresh may still contact X). Public `[]` does not remove the Workshop's account/verifier-choice requirement. Requirements follow data read from X, never actions or drafts the workspace wrote. New bindings carry immutable `redactsActionPreviews: true` and redact private provider context from unguarded action previews; older Post/List bindings, whose kernel-held descriptions and action previews may hold private post/List details, keep same-pinned-user admission and export `user/<id>`, failing closed without identity. The read-only history export also preserves `owner` records as `user/<id>`. This legacy protection is not a new-authoring pattern.
