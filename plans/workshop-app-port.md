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
3. Keeping or discarding changes that can't be kept automatically.
4. Composer slash commands, skills and connection lines.
5. Inline views and file previews (Office, worktrees).
6. Sharing.
7. Gadget settings and the Code tab.
8. Real blueprints behind Templates, real skills behind `SkillStore`.
9. Automations, read only.
10. ⌘K search and right-click menus.

Waiting on a merge of main into the scaffold (its base, Oct 27, predates them): inline-view
agent support, unread state (`subscribeToUnreadState`, `markChatRead`, `getUnreadThreads`).

## Sacrifices

| What | Why | Kernel change it would need |
|---|---|---|
| Setting up an agent has no "report back here" | the chat it reports to isn't a field of the spawner | `reportsToChatId` on `newAgentSpawnerGatekeeper` |
| Approving a creation can't start from where the agent suggested, so a kind with a creation form always asks, and one without is made where the service puts things | the scaffold's `GatekeeperCreationSpec` has no `configuration` | `configuration` on `GatekeeperCreationSpec` |
| A creation's card isn't drawn as the file it will make | that needs the live previews, which are cut | none |
| Setting up a connection offers every kind of resource, not only connectable ones | the scaffold's `SupportedResource` has no `connectable` | `connectable` on `SupportedResource` |
| Live Google Docs/Sheets/Slides previews cut | user decision | previews API |
| Approvals tray cut | user decision; nothing to approve without previews | none |
| Right-edge rail and "In this chat" pane cut | user decision | none |
| Agent prompt changes cut | user decision | prompt text in the backend |
| No model picker in the composer, only in settings | user decision, matches the scaffold's owner | none |
| Templates keeps the scaffold's name, not Blueprints | user decision | none |
| Removing a share shows no preview of what goes with it | `previewRemoval` is ours | `previewRemoval` |
| A gadget's kind (app or doc) can't be changed, and it has no icon picker | `setKind` is ours | `setKind` |
