# Porting the prototype onto workshop-app-scaffold

Branch `pjones/workshop-app-port`, off `origin/workshop-app-scaffold` (294b6464a). The prototype
(`prototype/b-figma-pre`) is layered on one piece at a time, in the scaffold's style, without
changing the kernel (`workshop-backend`, `workshop-shared`). This log records every kernel touch
and every sacrifice made to avoid one.

## Kernel touches

None of ours. Inherited from the scaffold: an optional `limit` on `getChatHistory`.

## Order

1. Accepting a connection request (Set up on the card). **Done.**
2. Approving an action that creates a resource (`ChatSession.approveAction` TODO). **Done.**
3. Keeping or discarding changes that can't be kept automatically. **Done.**
4. Composer slash commands, skills and connection lines. **Done.**
5. Inline views and file previews (Office, worktrees). **Done**, but inline views wait on main.
6. Sharing. **Done**, of a workspace, or of one of its gadgets to use.
7. Gadget settings and the Code tab. **Done.** View code shows the code in the pane, with its history as diffs (CodeMirror).
8. Real blueprints behind Templates, real skills behind `SkillStore`. **Done.**
9. Automations, read only. **Done.**
10. ⌘K search **(done)** and right-click menus (**deferred**, see below).

Deferred, wanted later: right-click menus on library rows and cards, skills and templates, each the same as a ⋯ menu the item would gain (Open, Open in new tab, Copy link, Share…, Remove from Library, Delete gadget…), as the prototype has. Main only has a gadget's right-click Delete; the scaffold's lists have no per-item menu yet, so this is a design addition for Balint to agree, not a port.

Main merged in (Nov 17), the scaffold's base (Oct 27) having predated it. That made sharing a
gadget on its own real, and the gadget runtime main's (`UiBundle` modules, `main(gadget, host)`).
It also makes these possible, still to do: unread state (`subscribeToUnreadState`, `markChatRead`,
`getUnreadThreads`), inline-view agent support, a creation started from what the agent suggested
(`GatekeeperCreationSpec.configuration`), and telling agents' runs apart (`spawnerId`) and waiting
(`awaitingDecision`).

## Sacrifices

| What | Why | Kernel change it would need |
|---|---|---|
| Setting up an agent has no "report back here" | the chat it reports to isn't a field of the spawner | `reportsToChatId` on `newAgentSpawnerGatekeeper` |
| Approving a creation can't start from where the agent suggested, so a kind with a creation form always asks, and one without is made where the service puts things | the scaffold's `GatekeeperCreationSpec` has no `configuration` | `configuration` on `GatekeeperCreationSpec` |
| A creation's card isn't drawn as the file it will make | that needs the live previews, which are cut | none |
| Keeping changes names a gadget given a connection by `env.NAME`, not the connection's title, unless it is another gadget the chat shows | there is no `listChatConnections`, on main either | `listChatConnections` |
| A chat's changes are kept as it finishes even when another chat has changes to the same gadget (the scaffold left them proposed) | ours brings in what the other kept first, asking only on conflicts | none |
| The composer has no model row in its + menu | user decision (model in settings only) | none |
| Skills are titled as the scaffold titles them ("Meeting Brief") | its `humanizeSkillName` | none |
| Add a connection, and a pasted link, offer every kind of resource, not only connectable ones | as above, no `connectable` | `connectable` on `SupportedResource` |
| A chat's automations are the hooks its cards show, as far as its history has loaded | no `chatId` on `BoundHookInfo` | `BoundHookInfo.chatId` |
| A scheduled task is told from an event's hook by its `scheduler:` address, and matched to its schedule by title, description and gadget | no `vendorId` on `BoundHookInfo`, no `hookId` on schedules | `BoundHookInfo.vendorId`, `hookId` on `ManagementSchedule` |
| Agents are listed only once they have run, by `spawnerName`; no agent page, model, callers or waiting runs; no agents menu in a chat's header | no `listAgentSpawners`, no `spawnerId`/`parentChatId`/`awaitingDecision` on chats | those, on `AiChatMetadata` and the Overseer |
| The scheduler's management app is typed by a local `{ list }` | its class is the worker's and the shared API types a frame's `ui` loosely | a shared type for it |
| Automations can't be created, edited or deleted here, only switched on and off | read only, by scope | none |
| No inline views in answers | the agent support came in a later main | none once main is merged |
| An output's card has no gadget colour | the prototype's gadget colours | none |
| Setting up a connection offers every kind of resource, not only connectable ones | the scaffold's `SupportedResource` has no `connectable` | `connectable` on `SupportedResource` |
| A gadget is shared to use, never only to view: no "Can view" and no "what people see" snapshot | main's grants are to edit the workspace or use a gadget | `viewOnly` grants, `sharedViewsAvailable`, `GadgetClient.openView`, `viewTakenAt` |
| Someone with access can only be removed, not moved from Can edit to using a gadget (being let edit is an invite) | there is no call to narrow access | a set-access call on the Overseer |
| Someone who can only use a workspace doesn't see who else has access | `listCollaborators()` refuses them | `listCollaborators` for users |
| Skills aren't shared from here, and no Share in the chat header or on Library cards | skill sharing needs the Context Library's own sharing; the scaffold's header and cards have no menu slot | none |
| Only the viewer's own link is turned on and off; links others made, extra ones and their notes aren't shown | each sharer has one default link for what they share, which is all the dialog offers | none |
| A gadget's settings have no "allow everything" or "ask again" for its permissions | not on the scaffold's `GadgetClient` | `setAutoApprove`, `disallowActionKind` |
| A gadget's agents show among its bindings with their model, but without their runs, and it has no Automations tab | no `listAgentSpawners` | `listAgentSpawners` |
| A gadget's description is its template's, read only | there is no call to set one | a description setter on the gadget |
| Nothing is connected to a gadget from its settings, an account isn't managed from a binding, and it has no access, publishing or exports there | bindings name a gatekeeper, not an account; scope | none |
| Templates have no use counts: "Most used" is the organisation's first, then the newest | `BlueprintPublicInfo` has no count | a use count on `BlueprintPublicInfo` |
| A template is always made in a new workspace | the base has no `createGadgetFromBlueprint` | `createGadgetFromBlueprint` |
| Publishing a template takes the app's title only, no description or screenshot step | scope | none |
| Moving a skill to another tag copies it and deletes the old one, not atomically, and can leave its collection empty | the Context Library can't move between collections | none (gatekeeper-context) |
| A skill's Auto-use and exact casing last only for the visit; only one's own skills can be edited | not stored in the Context Library | none (gatekeeper-context) |
| Template cards name their services without logos | scope | none |
| Live Google Docs/Sheets/Slides previews cut | user decision | previews API |
| Approvals tray cut | user decision; nothing to approve without previews | none |
| Right-edge rail and "In this chat" pane cut | user decision | none |
| Agent prompt changes cut | user decision | prompt text in the backend |
| No model picker in the composer, only in settings | user decision, matches the scaffold's owner | none |
| Templates keeps the scaffold's name, not Blueprints | user decision | none |
| A gadget's kind (app or doc) can't be changed, and it has no icon picker | `setKind` is ours | `setKind` |
| Code is read only: nothing is edited beside a chat yet, and a chat's changes not yet kept don't show in View code | editing goes through `submitCodeChange` and the old app's OT client, still to port | none |
| View code has no link to a file or its lines; the settings page's Code tab has the file only | the item's address has no place for them | none |
