# Porting the prototype onto workshop-app-scaffold

Branch `pjones/workshop-app-port`, off `origin/workshop-app-scaffold` (294b6464a), with main merged
in on Nov 17. The prototype (`prototype/b-figma-pre`) is layered on one piece at a time, in the
scaffold's style, at first without changing the kernel (`workshop-backend`, `workshop-shared`).

**Kernel touches.** The scaffold brought an optional `limit` on `getChatHistory`. Since, rows 1, 2,
5, 6, 7, 11, 12 (but the Agents tab's older runs), 13 (but the edit chat), 14, 16, 17, 18, 20, 21,
22, 23, 25, 26, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37 and 38 below are done in the kernel (row 4 in the app alone), with all of row 10 but
the hook that woke a run and the publisher's half of row 15 (whose other half is the app's). The pattern for what a workspace knows: its
Overseer pushes into its users' User DOs, and the app subscribes there, opening no workspace
(the User DO may still open one to catch up). Each Overseer pushes a `WorkspaceSummary` (what
waits, its hooks, and the first ten it is shared with and how many) to its owner and admitted
builders (`subscribeToWorkspaceSummaries()`); the workspace list (`subscribeToWorkspaces()`, with
the owner's renames mirrored to collaborators), the outputs (`subscribeToOutputs()`) and the user's
own templates with `unpublishedChanges` (`subscribeToOwnBlueprints()`) come live from the User DO.
What is the user's own is kept in the User DO itself as a small `UserPreferences` map the app owns
(`subscribeToPreferences()`): each workspace's look and the starred workspaces' order, stars and
what was opened, recent commands and the like, each the app's to encode and bound. A template's public record is read
from KV by `PublicApi.getBlueprint()`. `ActionLogEntry` says who asked (`from`, `gadgetId`); a run
records the gadget that started it (`spawnedByGadgetId`) and whether its last turn failed
(`lastTurnFailed`); and `BoundHookInfo` carries `vendorId` and `chatId`. The home page's composer
lists the commands of the workspace the chat will start in, making a provisional one as they are
first looked for, as main's `ensureProvisionalGadget` does. Row 19's `hookId` on a schedule (passed
in `HookTargetMetadata`) was reverted: the
gatekeeper interface is as on main, and the Scheduler has no management app any more.

What is ported: connection requests and creations set up from their cards, keeping changes,
slash commands, inline views and file previews, sharing a workspace or a gadget and
confirming access to one, gadget settings and View code (with editing), templates,
automations (listed on a workspace's tab, a chat's settings and a page of every workspace's, and
switched on and off, not made or edited), agents and their runs, what waits on the user, unread
and notifications, ⌘K search, the Library's Recent tab, and gatekeepers' management apps.
`packages/workshop-app/AGENTS.md` says how each works. Skills and their collections moved out of
the Workshop into the Context Library's own app (`packages/gatekeeper-context/app/skills/README.md`).

That leaves two lists. The first is what works today only because the browser makes up for
something the backend doesn't say or do; each needs a backend change before this design ships.
The second is what was left out, mostly so as not to change the kernel.

## Papered over in the frontend

Largest kernel change first, as audited against the branch on Nov 19: first new state kept in
step across Durable Objects, under access rules; last a field the backend already holds, put on a
type it already returns. "(scaffold)" marks what came with Balint's scaffold rather than the port.
Rows keep their numbers, which other rows refer to: done rows stay where they were, and rows found
since (37 on) are put in at their rank. Rows 3 and 24 are the Context Library's, not the kernel's,
and are listed after the table.

| # | What the browser does | What goes wrong | Backend change |
|---|---|---|---|
| 1 | ~~The sidebar's counts of what waits on the user come from two sweeps~~ that opened workspaces in the background | — | done: `WorkspaceSummary.waiting` (runs, other chats, each gadget's asks), pushed by each Overseer to the User DO on change and on open, through `subscribeToWorkspaceSummaries()`; no summary is unknown, not none |
| 2 | ~~The Automations page opens every workspace the user builds in to list its hooks~~ | — | done: `WorkspaceSummary.hooks`, from the same subscription; dropped when the listing goes or narrows to "use" |
| 4 | ~~Adding a service or model in the home page's composer, before the chat exists, makes the connection in the workspace chosen, or first makes a hidden provisional workspace for it; the draft keeps the connection's id in that workspace~~ | the provisional workspace, hidden, is never deleted (out of scope) | done in the app, no kernel change: each draft connection keeps how it was made (`ConnectionSource`), and one made in another workspace than the one the chat starts in is made again there at send (`newGatekeeper(accountId, resourceUrl)` / `newAiModelGatekeeper(modelId)`, in `startConversation`), its new id given as `newChat`'s capsules |
| 5 | ~~The Workspaces page asks each workspace for its members~~ | — | done: `WorkspaceSummary.collaborators` (the first ten) and `collaboratorCount`, pushed as sharing changes to the owner and builders alone; names kept current would need a profile lookup by id scoped to co-members |
| 6 | ~~The list of workspaces is read once and kept up by the browser's own changes~~ | — | done: `subscribeToWorkspaces()` from the User DO, a snapshot then each row as it changes; the owner's renames are mirrored into collaborators' rows, best-effort, corrected on their next open |
| 7 | ~~The Library, ⌘K and the template store each read the output index~~ | — | done: `subscribeToOutputs()` from the User DO: a snapshot (with `catchingUp`, the subscription driving the backfill), then each workspace's outputs as it pushes them, and as it leaves the list or access is revoked; one subscription for the app (`OutputsFeedProvider`) |
| 8 | ~~Code saved from View code is kept through the chat beside it, or one made for it on a gadget's page~~ | — | deferred (cut, below) |
| 9 | ~~Templates' "Most used" is the organization's first, then the newest~~ | — | dropped: the store has no Most used, and every ranking of templates is the latest created first (the banner's with the organization's own first); the kernel counts no uses |
| 10 | ~~An agent's page says it runs when the gadget that starts it has an automation on~~, but for the hook | — | the gadget (`spawnedByGadgetId`) and the chat (`AiChatMetadata.spawnedByChatId`: the chat whose agent's code started it, or whose changes to the starting gadget were running) are recorded, and the agent's page no longer guesses; still to record the hook that woke a run: a firing calls the gadget's stored callback, whose spawner calls reach the Overseer as the gadget's, like its UI's, so naming the hook needs the runtime to carry the firing into the gadget's calls |
| 37 | ~~Runs with no spawner id (older ones) or whose spawner is no longer listed are given to an agent of the same name, and old agent addresses lead to that match~~ | — | done: an agent is its spawner, keyed by the spawner's id, and a run is its `spawnerId`'s; a spawner set up again is a new agent; runs with only `spawnerName` stay unmatched; name matching and `name:` addresses are gone |
| 11 | ~~What a chat has (what it made, what was uploaded to it, the connections it used) is counted from its history as loaded~~, but for outputs it only worked on | — | done: `Overseer.listChatArtifacts(chatId, afterSequence?)`, paged 50 messages at a time over an index of the messages that record a creation or a file, with the connections the chat's action-log entries went through (`ChatConnectionUse`) on the first page; `Overseer.getChatAttachment(chatId, id)`, an upload's name, type and size; migration 8 backfills the indexes; denied to use-only sessions. Outputs a chat only edited still come from what is loaded: the kernel records no such list |
| 12 | ~~Runs come from `listChats()`, all of a workspace's; a workspace's Chats tab reads every chat once and takes runs out in the browser~~, but for the Agents tab | — | done: `listChats({kind, spawnerId, beforeId, limit})`, newest first, from the chatMeta `byListing` index (migration 9); an agent's page pages its runs and follows `subscribeToChat()`; the Chats tab reads `kind: "chats"` and follows the stream. Left: the Agents tab reads the latest 100 runs, so an agent no longer set up whose runs are all older isn't listed there |
| 13 | ~~What is the user's is kept in one browser~~, but for the chat a gadget's code edits go through | — | done: `UserPreferences` through `getPreferences`/`updatePreferences`/`subscribeToPreferences`, a string map the app encodes and bounds (`prefs/preferenceFields.ts`): recent commands, what was last beside a page, where an export last saved, each workspace's look, the starred workspaces' order (starring itself is `pinned`), the starred outputs in order and the last 50 opened |
| 14 | ~~A model binding's model is changed by making a connection, unbinding the old one, binding the new one and putting the template's note back~~ | — | done: `GadgetClient.rebind(name, expectedTarget, target)` points an accepted binding at another gatekeeper in one step, refusing a binding that changed since it was read, keeping its blueprint annotation, and restarting only where the gadget's reach widened; making the new model's connection stays `newAiModelGatekeeper()` |
| 15 | ~~The publisher's template list is live; a gadget's settings read its template's published release when opened, on reconnect, and when checking for or taking an update (`PublicApi.getBlueprint()`)~~ | — | done by re-checking, not a live feed: the publisher's half in the kernel (`subscribeToOwnBlueprints()`, `unpublishedChanges` pushed as the gadget's head or bindings change and as it is released); a gadget's settings, in the app alone, also read the release again as the window regains focus and every 60s while the tab is not hidden, one read at a time (`useBlueprintInfo`), so a release shows within a minute with no RPC, subscription or backend state for it |
| 38 | ~~Release update is offered only when a gadget's files have changed; a binding renamed, rebound or given a new note goes out only with the next code release~~ | — | done: `unpublishedChanges` is `{code?, bindings?}`; `bindings` is set while `collectBindingMetadata()` differs from the published `metadata.bindings` (canonical JSON; uncollectable bindings count as none, logged), pushed as a gadget's binding edges change and as a connection they name changes or goes (its title, spec, or an agent spawner's own bindings); the app offers Update connections (`updateBlueprint({updateBindings: true})`) where only bindings changed |
| 16 | ~~The workspace's agents are found by reading each gadget's bindings (`listBindings()`, then `getCreationSpec()` for each target with no vendor)~~ | — | done: `Overseer.listAgentSpawners(chatId?)`, each spawner's config, model, `agentId` and every gadget bound to it, and `GadgetBindingInfo.kind` (its target's creation-spec type); `getCreationSpec()` is read only for AI-model bindings, for their model id |
| 17 | ~~A run's failure is found in the last ten messages of the latest thirty runs~~ | — | done: `AiChatMetadata.lastTurnFailed`, set when a turn ends in an error other than the user's Stop and cleared when one starts |
| 18 | ~~What a gadget asks is tied to the gadget by what it reaches~~, but for asks in its chat | — | done: `from` and `gadgetId` on `ActionLogEntry`, and `spawnedByGadgetId` on a run; an ask in a chat seen from a gadget's page is still the gadget's if it binds what the ask reaches |
| 19 | ~~Schedules were matched to their hooks to say when each runs~~ | — | dropped: the Workshop reads no gatekeeper's schedules, and the `hookId` work was reverted; when a hook runs is not shown (cut, below) |
| 20 | ~~A chat's connection requests and creations waiting on the user are found in the history as loaded~~ | — | done without a chat-specific read: the chat's pending actions are the workspace's (`listActions({filter: "pending"})`) that name it (`ActionLogEntry.chatId`); a pending connection or web-fetch request is in its history, which the app fetches back to while `AiChatMetadata.awaitingDecision` says it waits and nothing loaded explains it |
| 21 | ~~Developer mode's share of the context used is the last step's tokens over the window of the model the next message will use~~ | — | done: `AiChatMetadata.contextUsage` (`ChatContextUsage`: the last step's `tokens`, the `budget` it compacts against on that model, from `getModelTokenLimits`, and the step's `model`), replacing `totalTokens`, recorded with the step and cleared by compaction; absent on old chats until their next step |
| 22 | ~~First run asks whether onboarding was done, takes a failure to mean yes, and finishing is a name saved, the chosen tools set up all at once, then a done flag set even if some failed~~ | — | done: `AuthenticatedApi.getOnboardingState()` (`OnboardingState`: name saved, each chosen tool's outcome, finished) and `finishOnboarding(choices)`, retry-safe, which saves the name, provisions each tool through `provisionAmbientAccount`, records failures, and marks it finished; a stored `onboardingCompleted: true` reads as finished; the app's gate says when it cannot ask, with Try again |
| 23 | ~~A share link is redeemed by opening its workspace and reading its metadata; any failure forgets the key and says the link no longer works~~ | — | done: `AuthenticatedApi.redeemWorkspaceShareLink(id, key)`, routed to the Overseer and opening no session, says `ShareLinkRedemption` (`unknown`, `revoked`, `granted`, `alreadyHadAccess`; the first two, and a missing workspace, reveal nothing of it); `ShareLinkGate` then opens without the key, telling a declined confirmation (`ACCESS_CONFIRMATION_ERROR_CODES`) from a dead link |
| 25 | ~~A reply carries a quote of its message at the front of its text, found again by searching back through the history, up to 20 pages~~ (scaffold) | — | done: `replyToSequence` on a `message`, sent in `SendChatMessageOptions` (`sendChatMessage(chatId, message, modelId, options?)`), checked to name a `message` or `slashCommand` in the chat, kept by `queuedSteers` and by the message a steer is logged as; display only, so the app still sends the quote in the text for the model; the app fetches history back to that sequence; an old reply shows as written, unlinked |
| 26 | ~~Turning a link off while keeping who used it asks who would lose access, then turns it off keeping them~~ | — | done: `Overseer.revokeShareLink(linkId, "everyone")` keeps everyone whose access narrows, computed in the revocation's own synchronous step; `SharingSession` no longer calls `previewRevokeShareLink` first |
| 27 | ~~A new version is noticed by reading `getServerConfig()` on each connection for the version it serves, against `/api/version`, and by reading the home page's HTML for a new script~~ | — | done: `PublicApi.getBackendVersion()`, and `/api/version` answers `assets`, the build id the router reads from the served `assets-build-id` (`scripts/assets-build-id.ts`); `ServerConfig.backendVersion` is gone |
| 28 | ~~Templates: each the user published is read again from its public record~~ | — | done: `BlueprintUserSummary` carries `metadata` and `screenshotUrl` |
| 29 | ~~Services' categories are a table in the app, by vendor id~~ (scaffold) | — | dropped: the Connections page lists by whether each is connected, not by kind; categories would need one the gatekeeper declares (`VendorDescription`) |
| 30 | ~~Confirming access is asked once per set of connection ids, and a cancelled confirmation is known by its error's text~~ | — | done: `ACCESS_CONFIRMATION_ERROR_CODES` (cancelled, not asked, disconnected), carrying `workspaceId` and `gadgetId`; the app keys its prompt by workspace |
| 31 | ~~Approving a creation reads the connection's creation spec to choose the account and form, matching by URL pattern~~ | — | done: `ActionLogEntry.creation` is an `ActionCreation` (`vendorId`, `resourceTypeId`, `configuration`); old records name the type by its URL pattern |
| 32 | ~~Publishing a gadget, its settings and its header's Share choose from every template the workspace published, not only the gadget's~~ | — | done: `BlueprintGadgetSummary.gadgetId` (old records: the default gadget) and `gadgetId` on `BlueprintUserSummary`'s workspace source, filled for old records on the owner's next open |
| 33 | ~~A chat's automations are the hooks its loaded cards show~~ | — | done: `BoundHookInfo.chatId`, from the bindHook action's caller |
| 34 | ~~An open chat reads every chat in its workspace to find its own metadata~~ | — | done: `Overseer.getChatMetadata(chatId)`, prepared as `listChats()` prepares each, `undefined` for no such chat, denied to use-only sessions; the chat session and saving code read it |
| 35 | ~~Opening Share reads every link to find the user's own, and makes a new key before Copy is chosen~~ | — | done: `Overseer.getDefaultShareLink(grant)`; the app mints the key on Copy |
| 36 | ~~Whether the deployment is behind Cloudflare Access is a build flag (`VITE_CF_ACCESS_MODE`)~~ | — | done for workshop-app: `ServerConfig.authMode` (`"cfAccess"` \| `"token"`); workshop-frontend still reads the flag |

In the Context Library (`gatekeeper-context`), not the kernel:

| # | What the browser does | What goes wrong | Backend change |
|---|---|---|---|
| 3 | ~~The Skills app moves a skill to another collection by making the collection if need be, writing the skill's files into it one at a time, then deleting it~~ | a collection made for the move stays if the move fails (making it stays a separate step) | done: `ContextApi.moveContextSkillToCollection(fromCollectionId, manifestPath, toCollectionId, directoryPath)`, checking edit rights on both, exports the skill's records as stored (`exportContextSkill`), imports them into the destination in one transaction (`importContextSkill`, refusing an occupied directory, one inside another skill, or a Git-backed collection), then `deleteContextSkill`s the source; an import finding identical records succeeds, so repeating a move that failed before the delete completes it with one copy; within one collection it is still `moveContextSkill` |
| 24 | ~~The Skills app lists collections, then reads each one's documents and permissions, and sharing for private ones it doesn't own, all at once~~ | — | done: `ContextApi.listSkillCollections()` (`ContextSkillCollection`: the library entry with its `documents`, `permissions` and `owner`), the library as `listEnabledContextCollections()` lists it, then one `getSkillListing(accountId, isAdmin)` per collection, at most `MAX_COLLECTION_FANOUT` at a time; one that can't be reached or read is left out |

Checked and needing no kernel change: developer mode's model picker (`listModels()`,
`setPreferredModel()`, and the model sent with a message); paging a chat's history (the
scaffold's `limit`); unread, marking a chat unread from a message, and notifications; costs, which
are the server's `totalCost`; retrying a template's failed publish (`retryBlueprintPublish()`
exists, the app doesn't use it yet); the connections list, which each page subscribes to for
itself but could share in the app; the home composer offering the user's own skills when a
workspace is chosen, where `Overseer.listSlashCommands()` would give that workspace's; and
gatekeeper apps' workspace titles (`resolveWorkspaceTitles`), which read the whole workspace list
where the app's `WorkspacesProvider` already has it.

## Cut or left for later

| What | Why | What it would need |
|---|---|---|
| **By decision** | | |
| Live Google Docs, Sheets and Slides previews, and with them the approvals tray | user decision; nothing to approve without previews | a previews API |
| The right-edge rail and the "In this chat" pane; what a chat has is a column beside it instead | user decision | none (`listChatArtifacts()`, row 11 above) |
| Changes to the agent's prompt | user decision | prompt text in the backend |
| A model picker in the composer outside developer mode; models are chosen in settings | user decision, as the scaffold's owner has it | none |
| **Chats and the sidebar** | | |
| Keeping a chat's changes at the end of its turn on the server, as a policy of the workspace, under the chat lock and safe over a restart | left for later; meanwhile the browser that has the chat open keeps them when its agent goes idle, or when it opens on changes left idle, and the workspace has no collaborators, updating from mainline and retrying once on a stale head (scaffold; main always asks), so nothing is kept by itself while no tab has it open and two tabs can both try | a turn-end keep policy in the Overseer that says why it leaves changes to be kept by hand |
| The sidebar lists workspaces, not each chat in them as the prototype did | not ported yet | none (`getUnreadThreads()` for unread chats; `listChats({kind: "chats", limit})` for all, paged) |
| Right-click menus on library rows and cards and templates, opening what the item's ⋯ has; templates have no ⋯ yet | a design addition for Balint to agree | none |
| A Share button in a chat's header | `ChatHeader` has no place for it (`ChatLayout`'s `headerEnd` could take one) | none |
| **Agents and automations** | | |
| Setting up an agent to report back to the chat that made it | the chat isn't a field of the spawner | `reportsToChatId` on `newAgentSpawnerGatekeeper`, and a way for a run's report to reach that chat |
| An agent's page listing what it is bound to, and saying what it is for | a spawner's bindings and purpose can't be read (`getCreationSpec()` leaves out its env) | `listBindings` on a spawner's client, a description on `AgentSpawnerConfig` |
| A gadget's own Automations tab, and its agents' runs in its settings | not built | none (`BoundHookInfo.gadgetId`, and `AutomationsTab` takes a filter; `listAgentSpawners()` names a gadget's agents and `listChats({agentId})` pages their runs) |
| The agent asking for an AI model; a person adds one to the chat for the agent to give a gadget | `requestConnection` takes no model | an `ai-model` connection id for `requestConnection`, with its approval and picker |
| When an automation runs next, and whether it stopped or needs attention | the Workshop reads no gatekeeper's private API, and a hook says only whether it is on | a vendor-neutral hook state on `BoundHookInfo` (next run, last delivery, stopped), unknown where a gatekeeper doesn't say |
| Creating, editing or deleting automations; they are only switched on and off | scope | none for Delete (`deleteHook()`); Create and Edit need a way to set a hook up other than the gatekeeper's own flow |
| **Sharing and access** | | |
| Sharing to view only, with a snapshot of what people see | this branch's grants are to edit the workspace or use a gadget | merging main (#1173: `getGadgetSnapshot()`, `isViewOnly()`, `mode: "view"` grants), then the grant, snapshot preview and viewer's page here (#1173's are in `workshop-frontend`) |
| Moving someone from member to only using a gadget, short of removing them | no call narrows access (#1173's `keepView` narrows using to viewing) | a set-access call on the Overseer |
| Someone who only uses a workspace seeing who else has access, or what their use waits on | `listCollaborators()` refuses them; use sessions get an empty action log (presence is there) | a roster scoped to what they use, and what waits on it |
| The access confirmation naming who shared it, and asking them for access | the callback names no sharer (the workspace's owner may not be them), and there is no request | who shared it on `ObserverConfigCallback`, choosing among several, and a request-access call |
| Links other people made, extra links and their notes | the port shows only the user's own default link for what is shared | none (`listShareLinks()` and notes are there) |
| Always allow for one gadget rather than its whole workspace | rules are per gatekeeper | per-gadget rules |
| Skills shared with a workspace | the Context Library shares with accounts and with everyone, not with workspaces | a workspace grant in `gatekeeper-context`, checked when skills are found, used and observed, and the workspace vouched for by the Workshop, not by the browser |
| **Gadgets** | | |
| Keeping a gadget's code without a chat | deferred: View code's Save keeps through the chat beside it, or an "Edits to …" chat made for it on a gadget's page (agent off), reading the head first and taking the change back out if the keep is stale; that makes chats nobody wrote in, refuses while the chat beside it is busy, and can leave a submitted change behind if the tab dies between submitting and keeping. Nothing is overwritten: `mergeChanges` refuses a stale head | `GadgetClient.commitCode`, checked against the commit it was edited from in one step: a second writer of a gadget's head beside `mergeChanges`, publishing what a merge does |
| Allow everything for a gadget's permissions | not on `GadgetClient`; asking again for a workspace's rule already works (`listAutoApprovedActionKinds()`, `listPreApprovableActions()`) | `setAutoApprove` per gadget, with per-gadget rules, for actions that can be auto-approved |
| Editing a gadget's description, kind or icon | no setters; the description and icon are its template's | a description setter, `setKind`, and an icon of its own |
| Adding a service or model to a gadget from its settings, or managing a binding's account there | not built; a binding names a gatekeeper, not an account | none to add one (`newGatekeeper()`, `bind()`); seeing and changing the account behind a binding needs it on the binding |
| Knowing which chat made a gadget, to offer it first | not recorded (`GadgetSummary.chatId` is only while it is provisional) | an origin chat on the gadget |
| Editing files that aren't text, links and executables; seeing a chat's changes not yet kept in View code; linking to a file's lines; previewing a draft before it is saved | the app sets whole text files; the old app's OT client isn't ported; the address has no place for lines | for links, modes and binary files, a code change that keeps a file's mode and sets bytes outside a worktree; none for the rest (`getUiBundle(chatId)` previews what a chat submitted, not a draft) |
| Removing an item from the Library without deleting it | the library lists what workspaces made, with no hide | none: a hide kept in the app's preferences, as stars are |
| A creation's card drawn as the file it will make, and a gadget colour on output cards | needs the previews; prototype styling | none for the kind of file (row 31) or a colour drawn from it; a preview of what will be made needs a previews API |
| **Templates, settings and skills** | | |
| Making a template in an existing workspace; it is always a new one | no call from the app (the agent's `createGadget` takes a blueprint) | `createGadgetFromBlueprint` on the Overseer, with the bindings chosen |
| A screenshot when publishing, and service logos on template cards | scope | none (`createBlueprint()` and `updateBlueprint()` take a screenshot; the logos are on each vendor) |
| One key per AI provider rather than per model | a key is a field of each model (`addModel(copySecretsFrom)` copies it); scope | a per-user provider credential |
| The user's own decision models | the model form turns them away; scope | none (`addModel()` and `listModels("decision")` take them) |
| A skill's Auto-use and exact casing kept past the visit, in the Context Library's app | the Context Library doesn't store them; Auto-use does nothing yet | none in the kernel; `gatekeeper-context` keeps a title apart from the skill's name, and Auto-use, used when skills are found |
