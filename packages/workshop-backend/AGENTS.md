# Workshop backend

The Gadgets Workshop server on Cloudflare Workers: the **kernel**, held to the bar in the root
`AGENTS.md` (The kernel).

## Worktree replicas

See [`../../docs/worktree-replicas.md`](../../docs/worktree-replicas.md) before changing
worktree Git transport or replica synchronization. A replica's sync must keep step
transactionality (see `plans/tree-sync-replicas.md`): the kernel only knows snapshots and
submissions bound to an `executeCode` call. Guest paths, mount names, command approvals and
process lifetimes belong to the gatekeeper.

## Bundled blueprints

The backend installs the **bundled blueprints** from `@gadgets/bundled-blueprints` on a deployment's
first `/api` request, and offers them as the deployment's standard output formats.
`scripts/build-bundled-blueprints.ts` generates the gitignored `src/generated/bundled-blueprints.ts`
they are installed from, which holds each blueprint's manifest and built files
(`BUNDLED_BLUEPRINTS_DIR` overrides the source directory), so `build` and `test` both run the
generator first; `pnpm import:bundled-blueprint` updates or adds a blueprint from a Workshop export,
of either `.gadget` version.

Installing one (`src/bundled-blueprints.ts`) stores it as any published blueprint is stored: a git
commit of its files, as a packfile at `<blueprintId>/<commitId>` in R2, named by `metadata.commitId`
in KV (see `docs/blueprints.md`). The commit is a *snapshot release* (`buildSnapshotRelease` in
`src/blueprint-release.ts`): parentless, with a fixed author, date and message, so it depends on the
files alone. Every deployment therefore derives the same commit from the same files, and the
installer never reads what was installed before. The cost is that a bundled blueprint's versions are
not chained to one another as a published blueprint's releases are. A gadget made from one still
takes its updates, merged against the release the gadget last took.

## Agent tracing

Agent turns emit the Workers trace spans Cloudflare's Agents dashboard reads (`src/agent-tracing.ts`):
`invoke_agent` per turn, `chat` per model request, `execute_tool` per tool call, and `tool_approval`
when an agent's action waits for a manual decision and when it is approved or denied. They carry
token counts, including cache reads and writes, but never prompts, responses or tool data. A span
belongs to the invocation that opened it, and once a Durable Object invocation has returned, the next
event the object receives ends its trace. So a turn keeps all its spans only while the request that
started it (usually the browser session) stays open.

## Built-in web search

An admin chooses where web searches run with the Web Search gatekeeper's **Search provider**
setting (see Admin settings below). Under **The model's provider** (`WEB_SEARCH_IN_MODEL`),
`GatewayModels.runConfig()` sets `AiModelConfig.webSearch` on every Anthropic and OpenAI gateway
model, and an agent's turn on such a model uses the provider's own web search tool. No model has
a search setting. The provider runs each search inside the model request, so the agent has no
tool for it: `ai-models.ts` adds the provider's tool to a request that asks for it
(`ModelStreamOptions.webSearch`), and `src/built-in-search.ts` wraps the turn's stream.
`plans/built-in-web-search.md` is the design record. Five rules are easy to undo by accident:

- Web Search is the capability, for each chat. A request declares the tool only while
  `AgentHooks.chatMaySearchInModel(bindings)` says so. The agent asks before each request, with
  the bindings the chat holds then, the ones `executeCode` gets. The answer is yes only while
  the workspace holds no restricted data, one binding is to the Web Search gatekeeper's ambient
  record, that record is usable, and the Web Search Worker is installed. A workspace's record is
  not enough: a gadget-spawned chat holds only the bindings its spawner gave it and those it
  gained in its log, such as a resource a user pasted.
- A turn on a user's own gateway does not declare the tool. Nor does a request that the provider
  refuses with the tool: for OpenAI, one whose `reasoning.effort` is `minimal`.
  `withWebSearchTool()` reads the effort from the request as sent, because a reasoning level can
  be sent as another effort. Outside an agent's turn, two things send the tool. The admin's two
  model Tests send it, of a model in the list and of a model before it is added. The cache-warm
  resend repeats a turn's last request after the turn ends, with the tool that request declared,
  and `cappedForResend()` keeps it from searching.
- Each thing the provider's tool did is recorded as an observation when it arrives in the stream
  (`recordProviderObservation()`). The provider ran it before the Workshop saw the query, so the
  record cannot come first, as a gatekeeper's does.
- pi drops Anthropic's search blocks, and Anthropic refuses the next request without them. So the
  wrapper keeps the response's content whole (`StoredAssistantMessage.providerContent`) and sends
  it back in place of pi's form, for the model that produced it. It never keeps a search that has
  no result: Anthropic refuses one unless tool results and nothing else follow it. The wrapper
  fails a response only for content it would send back wrong. So nothing the stream holds of a
  search with no result fails the response, such as a query that the response cap cut off.
- A response that searched reports more input tokens than the chat holds: Anthropic sums them
  over the response's internal steps, and OpenAI counts the results it read. That is what the
  provider bills, so `usage` keeps it, but it is not the chat's size: such a response counts as
  unmeasured for compaction.

## Auto-provisioned gatekeepers

A gatekeeper may declare `VendorDescription.autoProvisionsAccount`: it can mint a connected account
with no OAuth flow (via `GatekeeperVendor.createAccount()`, which takes no user identity). For such
gatekeepers the deployment admin picks a per-vendor mode in the admin Gatekeepers panel —
**disabled** / **optional** / **enabled** (default **optional**) — resolved in
`provisioning-policy.ts`: `enabled` auto-provisions the account for every user (forced, and hidden
from the Connectors list), `optional` lets each user opt in from the Connectors page or during
onboarding (where each starts switched on and is provisioned when the user finishes), and `disabled`
offers it to no one (existing accounts go dormant). The Workshop persists the account in the user DO
like any connected account (the account capability — not an asserted identity — is the authority
thereafter).

The **account** (a `GatekeeperUser`) declares in its `AccountDescription` whether it provides an
agent **singleton** (`singleton: { tsType }`) and/or a **management UI** (`providesUi`). The two are
orthogonal — an account can declare either, both, or neither.

- The Workshop auto-provides the singleton to the owner's workspaces as an
  **ambient gatekeeper record**, folded into each chat's env as a **named chat binding** (named by
  the gatekeeper's `suggestedBindingName`; see `prepareChatBindings` in overseer.ts) that the agent reads in
  `executeCode` (`getSession`/`getAgentCatalog`), each read recorded as an observation. It is not
  bound to any gadget by default — most gadgets never call it programmatically — but the agent may
  wire it into a gadget's binding list with `setGadgetBinding` when the gadget's persistent code
  needs it.
- The UI is hosted at `/gatekeepers/$appId` (the gatekeeper's vendor id, e.g.
  `/gatekeepers/context`) via `startAppUi({ isAdmin })`. Anything after that prefix is the app's
  own path, so apps can be deep-linked: the Workshop owns the URL and syncs it with the iframe over
  `GatekeeperAppNavigation` (`@gadgets/workshop-shared/gatekeeper-app`); the Context Library uses
  `/collections/<id>` and `/collections/<id>/files/<path>`.

## Admin settings

Deployment admin settings (the `/admin` panel) follow a few conventions worth knowing when extending
them:

- `src/storage-schema/admin-settings-storage.ts` defines `AdminConfig` (its helpers live in
  `src/admin-config.ts`) — the deployment's "soft" customizations: agent instructions,
  banners/theme, and which gatekeeper connectors/resources are offered (plus the three-state mode for
  auto-provisioning gatekeepers above). Connectors/resources default to enabled and the admin UI
  opts them *out*; auto-provisioning gatekeepers default to *optional*.
- A gatekeeper may declare settings of its own for the Gatekeepers panel
  (`VendorDescription.adminSettings`), each one choice from a list.
  `AdminSettings.setGatekeeperSetting()` checks a choice against the options the vendor
  declares. It then stores the choice in `AdminConfig.gatekeeperSettings`. A default is never
  stored: choosing it removes the stored choice. A stored choice that the vendor no longer
  declares is kept and shown as stored, never replaced by the default. A gatekeeper session
  reads its own vendor's stored choices with `ApprovalQueue.getAdminSettings()`, from the KV
  mirror, and applies its own defaults. The Workshop reads one of these choices itself: Web
  Search's Search provider, by the names in `@gadgets/workshop-shared/web-search-gatekeeper`.
- **Authentication/authorization config (sign-in providers via `AUTH_GATEKEEPERS`, password login
  via `DISABLE_PASSWORD_AUTH`) is deliberately NOT in `AdminConfig`** — it stays env-var driven
  (`auth/config.ts`) so it can't be changed by a compromised admin session.
- The `AdminSettings` durable object owns the authoritative `AdminConfig` and mirrors it to a single
  reserved KV key (`.adminConfig`, see `isReservedBlueprintKey()`), so hot-path code (connect/agent)
  reads it with one cheap KV get via `readAdminConfig(env)`. The DO is the only writer
  (`updateAdminConfig(patch, actor)` and the other mutators, all through `#mutateAdminConfig()`).
- Admin operations are exposed as an `AdminApi` capability obtained via
  `AuthenticatedApi.getAdminApi()` (returns null for non-admins). The admin check
  (`isDeploymentAdmin()` in `src/auth/config.ts`) runs once when the capability is minted, so the
  individual methods don't re-check, except for inspection: `inspectWorkspace()`, `inspectUser()`,
  the `openForAdmin()` of the Overseer and of the user object, and every `AdminWorkspaceView` and
  `AdminUserView` call re-check `isDeploymentAdmin()` and the view's expiry, and record each call
  before anything it read leaves the server (`src/admin-view.ts`).
- Every `AdminApi` setter is recorded in the deployment-wide audit log before it takes effect: each
  `AdminSettings` mutator takes a trailing `AdminSettingActor` and writes through
  `#mutateAdminConfig()`, which records the diff before storing it (the site logo and featured
  blueprints, which live outside `AdminConfig`, record explicitly first). A change whose record
  cannot be written is refused.
- The admin access bounds, `ADMIN_WORKSPACE_ACCESS_MAX` and `ADMIN_AUDIT_RETENTION_MIN_DAYS`, are
  env vars beside `ADMINS`, parsed in `src/admin-access.ts`, so that a compromised admin session
  cannot widen them. The cap fails closed (any value that is not a level is `off`), and an invalid
  floor falls back to 90 days. Admins choose a level and a retention within them;
  `adminAccessPolicy()` holds the choice inside them wherever it is enforced.
- Admin investigation rests on the `AdminAuditDurableObject` (`src/admin-audit.ts`, the
  deployment-wide audit log) and the `UserDirectoryDurableObject` (`src/user-directory.ts`), which
  lists users and workspaces for admins as well as serving user search, fed lazily by user DOs and
  Overseers. See [docs/admin-access.md](../../docs/admin-access.md).
- `user.ts:#assertResourceEnabled()` is the single core chokepoint where disabled
  gatekeepers/resources are enforced before a capability is minted. Both mints call it:
  `getGatekeeperClassFor()` (gadget/agent code can't reach it directly) and
  `createResourceGatekeeper()` (reached only through the agent's `createExternalResource` tool).
  `saveFile()` mints nothing but writes to the vendor directly, so it calls it too.
- In AI Gateway mode the deployment's models are admin settings too (`AdminConfig.modelModes`,
  `addedModels`, `modelSettings`, `addedProviders`, `providerOrder`, `modelOrder`,
  `userModelsEnabled`). `GatewayModels` in
  `ai-gateway.ts` is the only place that merges them with `SUGGESTED_MODELS`, and *disabled* is
  enforced where a model is about to run: `user.ts:getChatContext()` and
  `LanguageModelGatekeeper.startSession()`. The Auto Router model's pool (`modelSettings[id]
  .allowedModels`, or else the enabled providers) is built there too; a model binding takes the
  current pool at each session start, not the one it was minted with.

For private read horizons, source-to-user fanout and notification recovery, read
[the unread-state design](../../docs/user-unread-state.md). All unread-related data flows from
Workspace DO to User DO: individual read commands use an authorized open workspace session;
bulk read actions and unread queries use only local User DO state. Never add a User DO callback
to the workspace for unread state or metadata. The workspace checks existing observer admission
locally before fanout, without re-enrolling observers or calling gatekeeper verifiers per message.
