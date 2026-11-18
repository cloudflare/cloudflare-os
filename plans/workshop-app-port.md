# Porting the prototype onto workshop-app-scaffold

Branch `pjones/workshop-app-port`, off `origin/workshop-app-scaffold` (294b6464a), with main merged
in on Nov 17. The prototype (`prototype/b-figma-pre`) is layered on one piece at a time, in the
scaffold's style, without changing the kernel (`workshop-backend`, `workshop-shared`).

**Kernel touches: none of ours.** The scaffold brought an optional `limit` on `getChatHistory`.

What is ported: connection requests and creations set up from their cards, keeping changes,
slash commands and skills, inline views and file previews, sharing a workspace or a gadget and
confirming access to one, gadget settings and View code (with editing), templates, skills and
their collections, automations (read only, on a workspace's tab and on a page of every workspace's), agents and their runs, what waits on the user, unread
and notifications, ⌘K search, and the Library's Recent tab. `packages/workshop-app/AGENTS.md`
says how each works.

That leaves two lists. The first is what works today only because the browser makes up for
something the backend doesn't say or do; each needs a backend change before this design ships.
The second is what was left out, mostly so as not to change the kernel.

## Papered over in the frontend

Most costly first. "(scaffold)" marks what came with Balint's scaffold rather than the port.

| What the browser does | What goes wrong | Backend change |
|---|---|---|
| The sidebar's counts of what waits on the user come from two sweeps that open each recently active workspace every two minutes and read its chats and pending actions; a shared workspace not yet confirmed is refused there, as confirming is only asked on screen | wakes every workspace (17 on a page load on the dev account, 6 of them twice); up to two minutes stale; an action that doesn't name its chat isn't counted | a waiting count (runs, chats, gadget asks) on `listWorkspaces()` or the unread summary; `chatId` on every action |
| Agents are put together from each gadget's bindings (`listBindings()`, then `getCreationSpec()` for each), runs from `listChats()` by `spawnerId`, and failures from the last messages of the latest runs; an agent's page reads all its runs, then pages and folds them | a round trip per binding on every workspace open; a failure is only seen on recent runs; an agent with hundreds of runs reads them all | `listAgentSpawners()` (with what each is for and is bound to), `lastTurnFailed` on `AiChatMetadata`, `listChats()` paged and by spawner |
| A chat's changes are accepted when its turn ends by the browser that has it open, after checking nobody else is in the workspace (scaffold; main always asks) | nothing is accepted while no tab has the chat open; two tabs can both try | accepting at the turn's end on the server, as a policy of the workspace |
| What a gadget asks is tied to the gadget by what it reaches | two gadgets on one resource both show an ask that has no chat; none says who asked | `gadgetId` and an initiator on `ActionLogEntry` |
| What is the user's is kept in one browser: workspace icons (scaffold), Library stars and their order (scaffold), Library's Recent, the skills chosen last, which chats had a gadget beside them (scaffold), the chat a gadget's code edits go through, and the file an export last saved to | none of it follows the user to another browser or device (a workspace's icon chosen in Chrome isn't there in Safari) | a `look` on `WorkspaceMetadata`, a star on outputs as workspaces have, and a small per-user preferences store for the rest |
| The Workspaces page asks each workspace for its members, a few at a time (scaffold) | a round trip, and a wake, per workspace | the first few members and a count on `listWorkspaces()` |
| The Automations page opens every workspace the user builds in, three at a time, to list its hooks, then matches them to the account's schedules; a shared workspace whose access isn't confirmed yet is left out | a wake per workspace each time the page opens, the list filling in as they answer; one not confirmed is missing | hooks listed across the user's workspaces (`listHooks` on the user's API, or the hook on each schedule) |
| Schedules are matched to their hooks by title, description and gadget, a scheduled hook is told from an event's by its `scheduler:` address, and a chat's automations are the hooks its loaded cards show | two alike can be mismatched; a chat's list is only as long as the history loaded | `hookId` on `ManagementSchedule`, `vendorId` and `chatId` on `BoundHookInfo`, and a shared type for the scheduler's management API |
| Code saved from View code is kept through a chat made for it ("Edits to …", agent off), after reading the head to look for conflicts, and taken back out if it was stale | chats nobody wrote in; the conflict check can race | keeping a gadget's code without a chat, checked against the commit it was edited from |
| Two things that should each be one step are two: a skill moved to another collection is copied and deleted, and a model binding's model is changed by unbinding and binding again | a failure halfway leaves a copy, an empty collection, or the old connection in the workspace | a move in `gatekeeper-context`; a rebind on `GadgetClient` |
| Templates: each the user published is read again from its public record; "Most used" is the organization's first, then the newest; publishing a gadget lists every template its workspace published, not only its own | a read per template; a ranking that isn't one; a list that isn't the gadget's | full records from `listOwnBlueprints()`, a use count on `BlueprintPublicInfo`, the gadget's id on `BlueprintGadgetSummary` |
| A reply carries a quote of its message at the front of its text, found again by searching back through the history (scaffold) | loads pages of history to find what was quoted | a reply-to on a message |
| A connection added from the home page's composer, before the chat exists, makes the workspace the chat will start in | left there, with the workspace, if another workspace is then chosen | connections given with the first message, made in the workspace it starts |
| The Library is read once, and the user's renames and deletions are laid over it | changes made elsewhere show only once it is read again | a subscription to the output index |
| Services' categories are a table in the app, by vendor id (scaffold) | a deployment's own services have none | categories on `VendorDescription` |

## Cut or left for later

| What | Why | What it would need |
|---|---|---|
| **By decision** | | |
| Live Google Docs, Sheets and Slides previews, and with them the approvals tray | user decision; nothing to approve without previews | a previews API |
| The right-edge rail and the "In this chat" pane | user decision | none |
| Changes to the agent's prompt | user decision | prompt text in the backend |
| A model picker in the composer; models are chosen in settings | user decision, as the scaffold's owner has it | none |
| **Chats and the sidebar** | | |
| The sidebar lists workspaces, not each chat in them as the prototype did | not ported yet | none (`getUnreadThreads()`) |
| Right-click menus on library rows and cards, skills and templates, opening what the item's ⋯ has; skills and templates have no ⋯ yet | a design addition for Balint to agree | none |
| A Share button in a chat's header | the scaffold's header has no slot for it | none |
| **Agents and automations** | | |
| Setting up an agent to report back to the chat that made it | the chat isn't a field of the spawner | `reportsToChatId` on `newAgentSpawnerGatekeeper` |
| An agent's page listing what it is bound to, and saying what it is for | a spawner's bindings and purpose can't be read | `listBindings` on a spawner's client, a description on `AgentSpawnerConfig` |
| A gadget's own Automations tab, and its agents' runs in its settings | as above | `listAgentSpawners()` |
| The agent asking for an AI model; a person adds one to the chat for the agent to give a gadget | `requestConnection` takes no model | an `ai-model` connection id for `requestConnection` |
| Creating, editing or deleting automations; they are only switched on and off | scope | none |
| **Sharing and access** | | |
| Sharing to view only, with a snapshot of what people see | main's grants are to edit the workspace or use a gadget | `viewOnly` grants, `GadgetClient.openView` |
| Moving someone from member to only using a gadget, short of removing them | no call narrows access | a set-access call on the Overseer |
| Someone who only uses a workspace seeing who else has access, or what their use waits on | `listCollaborators()` refuses them; use sessions get no action log | both for users |
| The access confirmation naming who shared it, and asking them for access | the callback names no sharer, and there is no request | the sharer on `ObserverConfigCallback`, a request-access call |
| Links other people made, extra links and their notes | each sharer has one default link | none |
| Always allow for one gadget rather than its whole workspace | rules are per gatekeeper | per-gadget rules |
| Skills shared with a workspace, and git-backed and organization collections managed here | the Context Library shares with accounts, not workspaces | a workspace grant in `gatekeeper-context` |
| **Gadgets** | | |
| Allow everything, or ask again, for a gadget's permissions | not on `GadgetClient` | `setAutoApprove`, `disallowActionKind` |
| Editing a gadget's description, kind or icon | no setters | a description setter, `setKind` |
| Adding a service or model to a gadget from its settings, or managing a binding's account there | bindings name a gatekeeper, not an account | none |
| Knowing which chat made a gadget, to offer it first | not recorded | an origin chat on the gadget |
| Editing files that aren't text, links and executables; seeing a chat's changes not yet kept in View code; linking to a file's lines; previewing a draft before it is saved | `submitCodeChange` sets whole text files; the old app's OT client isn't ported; the address has no place for them | none |
| Removing an item from the Library without deleting it | the library lists what workspaces made, with no hide | a per-user hide on the output index |
| A creation's card drawn as the file it will make, and a gadget colour on output cards | needs the previews; prototype styling | none |
| **Templates, settings and skills** | | |
| Making a template in an existing workspace; it is always a new one | no such call | `createGadgetFromBlueprint` |
| A screenshot when publishing, and service logos on template cards | scope | none |
| One key per AI provider rather than per model, and the user's own decision models | a key is a field of each model; scope | a per-user provider credential |
| A skill's Auto-use and exact casing kept past the visit | the Context Library doesn't store them | none (`gatekeeper-context`) |
