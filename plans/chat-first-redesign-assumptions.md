# Chat-first redesign: assumptions log

Decisions made while implementing the Figma designs where the frames don't say what to do. Each
entry says what the design shows, what was decided, and why. Newest decisions are appended at the
end of their section.

## Visual system

- **Theme tokens.** The design's palette is mapped onto the existing Kumo semantic tokens in
  `styles.css` rather than written into components: canvas `#fafafa` is `elevated`, content cards
  `#ffffff` are `base`, the black-4% row wash is `tint`, the black-6% agent bubble is `recessed`,
  hairlines are black 6%, secondary text is black 50% and the brand is `#ff5c2e`. The frontend guide
  reserves global theming for application-level decisions; a full redesign requested by the
  product owner is treated as one.
- **Dark mode.** The design has no dark frames. Dark mode is kept and re-derived as neutral greys
  that mirror the light scheme, replacing the previous violet-tinted palette so both modes read as
  the same product.
- **Font.** The design is set in Inter. The previous stack named "FT Kunst Grotesk", which was never
  loaded. Inter is self-hosted from `@fontsource-variable/inter` so no request leaves the deployment.
- **Icons.** The design draws its own line icons, which no installed library matches. They are
  exported from Figma as SVG and shipped as components in `components/icons/designIcons.tsx`, drawn
  in `currentColor`. Icons the design never shows (code, activity and so on) keep using Phosphor at
  the "light" weight, the closest match to the design's 1px strokes.
- **Brand mark.** The orange cloud with a sparkle replaces the hexagon as the default logo. A
  deployment's custom site logo still takes precedence where it did before.

## Chats, agents and workspaces

- **Sidebar glyphs.** The design shows three row glyphs: a black folder with the workspace's
  initials, a black cloud with a sparkle, and a plain black cloud. The folder marks a chat in a named
  workspace. The sparkle cloud marks a chat an agent started, such as a scheduled task. The plain
  cloud marks a chat in no workspace, which the frames never label but which the composer's
  "No workspace" option implies.
- **Landing on a workspace.** Opening a named workspace shows its workspace page (Figma
  "806:2922"), not its first chat. Only legacy single-chat workspaces still open straight into
  their chat, because they have no page of their own to show.
- **Chat details is a view, not a route.** The details frames keep the chat's workspace chrome, so
  they are a `details` search parameter on `/workspace/$id` rendered inside the editor. That keeps
  the workspace's connection, its apps and its share dialog available without opening them twice.
- **Chat row authors.** The rows draw an author avatar, but chats record no author. They show the
  agent mark for agent-started chats and the cloud mark otherwise, and name the spawning agent when
  there is one.
- **Per-chat visibility and participants.** The rows and the details settings show a chat as public
  or private with its participants. Chats have no visibility of their own: access is per workspace.
  The rows leave both out. Settings shows Visibility read-only, Public when the workspace has
  collaborators and Private otherwise, with a tooltip saying it follows the workspace.
- **A chat's app count.** It counts the chat's draft apps plus the apps it is proposing changes to,
  since both open from that chat.
- **Archiving.** Archive is per user, like unread state, so archiving never hides a chat from
  collaborators. Archived chats leave the sidebar's recents, show an "Archived" label on the
  workspace page, and can be filtered there. The chat that is open stays in the sidebar.
- **Starring chats.** The design stars chats as well as apps and files, so the kernel's favorite
  references gained a `chat` kind. Starred chats are grouped first on the workspace page. The
  Library's Favorites tab still lists only apps and files, since the Library frames never show a
  chat.
- **Workspace title menu.** The title pill opens a menu the design doesn't draw. It holds Rename,
  Invite people, notification settings, the workspace's cost, and Delete workspace for the owner.
- **The New menu.** Chat opens Home with the workspace preselected in the composer, From a template
  opens the templates, and Invite opens the share dialog.
- **Members tab.** Roles are labelled Owner, Member, or Uses apps for people who can only open
  shared apps. The Activity tab shows the workspace's whole activity log.
- **Chat Connections and Activity log.** Connections lists the connections of the chat's apps, with
  a tab per app. The Activity log is the workspace's, because action records carry no chat id.
- **Chat Notifications.** The toggle maps to the workspace's notification mute, and its copy says
  so, because notifications can't be muted per chat. Usage shows tokens, and cost only when it is
  above zero.
- **App description.** The app settings page shows the description of the template the app came
  from, and nothing when it didn't come from one.
- **Request access.** There is no request-access API. The button opens a dialog with a ready-made
  message and the app's link to copy and send to its owner. The "same kind of app" card opens the
  templates.
- **Use-only apps.** People who can only use an app now see it in the same full-screen frame. The
  old export menu and user menu are gone from that view, since the frame doesn't draw them.
- **Template wording.** The design says "template" where the product said "blueprint", so menu
  labels read "Publish as template…" and "Update from template…". Code and APIs keep "blueprint".
- **Mobile drawer.** Buttons and rows are 44px touch targets, Search moves to the drawer's footer,
  and a New chat button sits beside it, following "814:5105". On phones a message's actions appear
  on tap, the same as hover on desktop, instead of always showing.
- **Removed code.** The workpiece picker had no caller after the redesign and was deleted.

## The transcript, and changes without accepting

- **No tool calls in the chat.** Reasoning, tool calls, observations and app-use records never
  show, and the Show steps toggle is gone. While the agent works, one status line under the
  person's message says in plain words what it is doing. It opens in place, holds each label for
  at least 1.2s, and cross-fades between them. The agent describes each code run in a few words
  through a new optional `summary` field on executeCode (kernel: `toolCallSummary` stream event).
  Other tools map to fixed phrases ("Reading a web page...", "Building Tip Jar...").
- **"Worked for X".** When a turn ends, its status line settles into "Worked for 12s" under the
  person's message. The line expands into the turn's steps. Figma 763-1007 puts it at the bottom;
  it sits above the answer at the user's direction.
- **Requests.** Connection, approval and web-page requests share one card style (app-card white,
  20px corners, a grey icon circle, pill answers: Deny/Connect, Deny/Approve). Once answered, each
  becomes a quiet one-line receipt.
- **Motion.** New rows open by animating grid rows, and cards ease height changes, so nothing
  above jumps. The chat stays pinned to the bottom as content grows. Every animation stops under
  reduced motion.
- **Pane.** The sheet's drawn grab handle is gone, because nothing drags it. Closing the app pane
  drops `w` from the URL, so a reload keeps it closed. The resize gutter now measures from the
  row's left edge and follows the pointer.
- **Auto-accept.** A turn a person starts accepts its own changes when it ends (kernel: merge
  message `automatic`). A turn a gadget or callback starts doesn't. A change that adds a binding,
  which widens an app's access, waits for the person, and so does one left with conflicts. So do
  blueprint updates and code edited by hand. Only these show a "Keep these changes?" card at the
  end of the chat, with Discard/Keep. It appears at once in an idle chat, or 1.5s after a turn
  ends, so the auto-accept that lands just after a turn never flashes it. The composer's Pending
  changes bar and the "accepted changes" rows are gone, and the chat list chip reads "Waiting for
  you".
- **Going back.** Every accept that changed an app is a point in the chat: a quiet line where it
  landed, "Updated Tip Jar" or "Created Tip Jar".
  - The newest point offers Undo. Older ones offer Restore on hover, always on touch, and Restore
    brings back how the apps were right after that turn.
  - Restoring writes a new commit with the old files, so history is never rewritten. A restore is
    itself a point: "Undid changes to Tip Jar · Redo", "Restored Tip Jar to an earlier version".
  - Kernel: `Overseer.restoreChanges(chatId, sequence, "before" | "after")`, merge commits record
    `previousCommit`, and a new "restore" message tells the agent to re-read.
  - Undoing a turn that created an app deletes the app, after a confirm. A deleted app isn't
    brought back. Restore refuses while the chat has changes to that app not yet kept. Binding
    edges are left as they are.

## Composer, files and the Library

- **+ menu.** A 300px popover anchored to the +, not a sheet as wide as the composer. Rows are
  Add files or photos, Add a connection, Model, and Compact. Compact is a built-in command, not a
  skill, so it sits with the actions and keeps its familiar name. Skills follow under a quiet
  "Skills" label, named in plain words ("Meeting brief"). Where a skill comes from now appears
  only in its tooltip. Search stays at the edge for typing to find. The menu fades and settles in
  over 180ms, and the + rotates to an ×.
- **Drag and drop.** The Figma has no drop state. While a composer is on screen, dropping files
  anywhere in the window attaches them, so a near miss no longer makes the browser open the file
  in place of the app. Files dragged over the window make the composer's hairline darken and lift
  it a touch, and its row fades to "Drop files to attach", all within its own pill. Over the
  composer it settles onto the tint. The cue is monochrome and stays within the pill.
- **Unread page removed.** Each sidebar row marks its own unread state, across every workspace,
  so the `/unread` page, its user-menu item, and the unused sidebar summary were deleted.
- **PDFs.** The page CSP allows only srcdoc frames (it keeps app frames from navigating), so PDFs
  are drawn with pdf.js into canvases rather than a blob: frame. pdf.js is a new dependency,
  loaded only when a PDF is shown. A PDF opens as pages on a recessed backdrop. Its first page is
  its thumbnail in the Library list and grid (the grid keeps the name below the page), in the
  composer's attachment card, and in sent messages. Bytes the message doesn't inline are fetched
  once and shared with the preview.
- **Apps open beside the Library.** Opening an app from the Library, a workspace page or chat
  details shows it live in the side pane, as files open. Full screen is the pane's expand button.
  The More menu has "Open with chat" and "Open on its own". Library thumbnails for apps stay as
  their format glyph, since apps have no screenshots.

## Automations and agents

- **The name.** "Automations" is the umbrella for scheduled tasks and hooks. Home's "Add an
  automation" already uses the word, and it avoids "routines" and "helpers". It now always
  seeds the composer, since a chat sets an automation up from a sentence.
- **On when asked.** A hook bound during a turn the user started is on at once. Hooks bound in a
  scheduled run's turn, a spawned agent's turn, or by a gadget's own code wait for the user. That
  keeps the rule that only a person makes something run; a gatekeeper never turns itself on.
  Scheduler docs and README now say this.
- **Runs come back to the chat.** The agent passes `self` as the callback, so a run wakes the chat
  that set it up, and the chat replies there. No gadget is involved unless the work needs saved
  state. The hook records `chatId` for this. Firings carry the schedule's title and description,
  and the description is the agent's instructions for each run, so its reply doesn't repeat
  them or any IDs. The description leads with when it runs, because the card shows it.
- **The agent knows what the user did.** Each turn ends its history with a note on the state of
  each hook the chat set up: on, paused, or deleted. The note goes on the newest message, so the
  prompt cache isn't disturbed.
- **In the chat.** The bindHook request card became a quiet automation card: clock (schedule) or
  bolt (hook), title, description, a switch, and More → Delete (with a confirm). Paused and
  Deleted show beside the title, and a deleted card stays, muted. A run shows as "◷ Title · 9:00
  AM" and starts its own turn, so "Worked for" covers that run alone. The chat header shows a clock
  once the chat has an automation; it opens the chat's Automations tab.
- **Where they are listed.** Automations tabs on a workspace (every automation, each saying which
  chat it's in, as a link), on a chat's details (its own), and on an app's settings (ones that run
  its code). Agents sit in the same tab, below automations, rather than in a sixth tab.
- **Agents.** `listAgentSpawners` / `updateAgentSpawner` let the user rename an agent or change its
  model. The person who changes it becomes its creator, since the model is one of theirs. Access
  (its bindings) is shown but not yet editable. Each agent lists its conversations, newest first
  (three, then "Show all"). Agent conversations no longer appear in the sidebar or among the
  workspace's chats, except under the "Agents' conversations" filter, or while one is open.
  Spawned chats record `spawnerId` and `parentChatId`, so a chat's tab shows the agents it
  started.
- **Setting up an agent.** A chat's request for an agent spawner opens a focused "Set up an
  agent" dialog in place of the generic connection modal. It shows the chat agent's reason, a
  name taken from the request's binding name, the model, and switches for each connection the
  chat has (all on). The spawner's description tells the chat agent which model its agents run.
- **Apps without a UI.** The side pane opens on its own only when the agent writes something to
  see (client.js or a module beside it). A background-only app leaves the chat as it is.
- **A chat's connections.** The Connections tab lists what the chat can use: connected in this
  chat, from the workspace's apps, and built in. Below that, the per-app management shows when
  the chat has apps.
- **Review-first deployments.** `AUTO_KEEP_CHANGES=off` keeps the old behaviour of each turn's
  changes waiting for Keep. The integration suites about pending changes use it.

## Background apps, agent results and native touches

- **Apps without a screen.** An app the agent builds from scratch opens the pane only when it
  writes a UI (client.js). Opened by hand, an app with no UI shows "Works behind the scenes": its
  automations and agents, and ways into Connections, Code and Settings, in place of "No gadget UI
  yet".
- **A chat keeps what it built.** `GadgetSummary.madeInChatId` records the chat that built an
  app, after its creation is kept too. That chat's Library, Automations (and the clock in its
  header) and Connections include the app's.
- **A chat outside any workspace is only ever a chat.** Its workspace page never shows: the address
  always opens the chat, and an app's own page or settings return to the chat, however many apps
  or agent conversations it has.
- **Fewer Keep prompts.** A turn's changes are kept automatically even when they give an app new
  access, if that access is to a connection the user accepted in the same chat.
- **Agents report back.** Setting up an agent from a chat offers "Post results in this chat" (on).
  When it is on (`AgentSpawnerConfig.reportsToChatId`), each run's final reply appears in the
  chat as an `agentReport` card, with a way into the run. The chat's agent reads reports with
  the user's next message, so a report arriving mid-turn never splits the turn. "Added an agent ·
  Name" replaces "Connected Agent spawner".
- **Replies.** The agent confirms an automation in a sentence or two: what happens and when, a
  few words on any background app it made, where results appear, and at most one follow-up.
- **Connections, restyled.** The app Connections view uses the newer cards: a grouped list with
  each connection's `env.NAME`, actions in a More menu, confirm dialogs, and automations as cards.
- **Right-click menus.** Sidebar chats, a workspace's chats and Library items have right-click (or
  long-press) menus with the same actions as their More menus, plus the link actions the browser's
  own menu would have offered. Kumo has no context menu, so this is Base UI's (Kumo's base),
  dressed as the app's other menus.
- **Motion.** Automation cards scale in and out and the rest slide into place, timed like the
  composer's attachment tray. Menus scale in from where they open, and respect reduced motion.
- **Safari.** No `using` declarations in frontend code: Safari can't parse them and the dev
  server doesn't lower them.
