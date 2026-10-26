# Workshop backend

The Gadgets Workshop server on Cloudflare Workers: the **kernel**, held to the bar in the root
`AGENTS.md` (The kernel).

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
  `/gatekeepers/context`) via `startAppUi({ isAdmin })`.

## Admin settings

Deployment admin settings (the `/admin` panel) follow a few conventions worth knowing when extending
them:

- `src/storage-schema/admin-settings-storage.ts` defines `AdminConfig` (its helpers live in
  `src/admin-config.ts`) — the deployment's "soft" customizations: agent instructions,
  banners/theme, and which gatekeeper connectors/resources are offered (plus the three-state mode for
  auto-provisioning gatekeepers above). Connectors/resources default to enabled and the admin UI
  opts them *out*; auto-provisioning gatekeepers default to *optional*.
- **Authentication/authorization config (sign-in providers via `AUTH_GATEKEEPERS`, password login
  via `DISABLE_PASSWORD_AUTH`) is deliberately NOT in `AdminConfig`** — it stays env-var driven
  (`auth/config.ts`) so it can't be changed by a compromised admin session.
- The `AdminSettings` durable object owns the authoritative `AdminConfig` and mirrors it to a single
  reserved KV key (`.adminConfig`, see `isReservedBlueprintKey()`), so hot-path code (connect/agent)
  reads it with one cheap KV get via `readAdminConfig(env)`. The DO is the only writer
  (`updateAdminConfig(patch)`).
- Admin operations are exposed as an `AdminApi` capability obtained via
  `AuthenticatedApi.getAdminApi()` (returns null for non-admins). The `#isAdmin()` check happens once
  when the capability is minted, so the individual methods don't re-check.
- `user.ts:#assertResourceEnabled()` is the single core chokepoint where disabled
  gatekeepers/resources are enforced before a capability is minted. Both mints call it:
  `getGatekeeperClassFor()` (gadget/agent code can't reach it directly) and
  `createResourceGatekeeper()` (reached only through the agent's `createExternalResource` tool).
- In AI Gateway mode the deployment's models are admin settings too (`AdminConfig.modelModes`,
  `addedModels`, `modelSettings`, `addedProviders`, `userModelsEnabled`). `GatewayModels` in
  `ai-gateway.ts` is the only place that merges them with `SUGGESTED_MODELS`, and *disabled* is
  enforced where a model is about to run: `user.ts:getChatContext()` and
  `LanguageModelGatekeeper.startSession()`.
