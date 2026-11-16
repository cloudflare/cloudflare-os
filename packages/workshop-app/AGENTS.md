# Workshop App

The reworked Workshop frontend, built beside `workshop-frontend` (which stays the shipped app until
cutover). Scope is deliberately small: chat, chat settings, the Library and Workspaces pages, sharing, and
a gadget's own pages.
Follow `../../AGENTS.md` and the `frontend-conventions` skill in addition to this file.

Dev server: `pnpm --filter @gadgets/workshop-app dev` (port 3001; the old frontend uses 3000).
`src/routeTree.gen.ts` is generated and committed, like the old app's; do not edit it.

The gallery (`/gallery`) and the scripted chats (`/mock/*`) are for development only, and a build
leaves them out: `vite.config.ts` has the router plugin skip their route files for the tree a build
uses, which it generates outside `src/` so the committed one stays whole. Nothing they import is
bundled, so keep anything only they need (fakes, previews) out of what ships. The dev auto-login is
likewise behind an inline `import.meta.env.DEV` check around its dynamic import. After touching
either, build (`pnpm --filter @gadgets/workshop-app exec vite build`) and grep `dist/` for
`devpassword`, `MockOverseer` and `gallery`: none should be there.

What a deployment serves is `workshop-frontend/dist`, whose build (a vp task that depends on this
package's `build`) ends by copying this app's `dist` over it and keeping the old app's page as
`admin.html`, which Workers assets serves at `/admin` (`workshop-frontend/compose-dist.mjs`). So
the old app survives only for its admin page, reached from the account menu by admins, and for its
sign-in form, which a signed-out visitor is sent to outside Cloudflare Access. Behind Access
(`VITE_CF_ACCESS_MODE=true`, as a gadgets-internal preview builds) `RpcGate` signs in with the
user's Access credential instead.

## Layers

```text
src/
  components/   Kumo wrappers and primitives; no product knowledge, no data
  hooks/        Hooks any UI layer may use, at the level of components (the tab's title, an
                object URL); no product knowledge, no data
  blocks/       Compositions of components for one purpose (a message, a composer, a list row)
  layouts/      Page structure: shell, sidebar, aside, toolbar pages. Arrange slots, know no content
  routes/       Route declarations; they connect the data folders below to the UI layers above

  rpc/          The backend connection and sign-in; `useApi()` beneath `RpcGate`
  workspaces/   The user's workspace list, and one workspace's page (`WorkspacePane`)
  chat/         One chat: `ChatSession` (plain class, no React), the mapping from server
                messages to what is rendered, and `ChatPane`, which wires them to the UI blocks
  chat/mock/    A scripted fake backend for chats, played at `/mock/<scenario>`. Development only
  aside/        What is open beside the page (a file, an output), and the ways to open it
  library/      Everything the user's workspaces have made (`useLibrary`), and the Library page
  sharing/      Who a workspace or a gadget is shared with, and the dialogs that change it
  gadgets/      One gadget's own pages: its settings, what it is connected to
  connections/  The user's connected services, and connecting another
  skills/       The user's skills, in Context Library collections
  automations/  What runs by itself: hooks, joined with the scheduler's schedules
  blueprints/   Blueprints: the Library's tab, a blueprint's page, and making a gadget from one
  profile/      The signed-in user's profile: name, picture, password, usage

  files/        What a file is, from its name and type; plain functions any layer may use
  prefs/        What is kept on this device between visits (layout); plain, any layer may use
  gallery/      The component gallery's previews, at `/gallery`. Development only
```

UI imports point down only: components and hooks, then blocks, then layouts, then routes. The data
folders (`rpc/`, `workspaces/`, `chat/`, `aside/`, `library/`, `sharing/`, `gadgets/`,
`connections/`, `skills/`, `automations/`, `blueprints/`, `profile/`) are the only code that talks to the backend: UI layers cannot import them, and they cannot import routes. `files/` and `prefs/` are
beneath everything and import neither UI nor data, and nothing that ships imports `gallery/`. Lint
enforces all of it (`vite.config.ts` at the repo root), by alias and by relative path alike. Blocks
and layouts take plain typed props and callbacks.

Put protocol logic in plain classes and functions with no React (like `ChatSession`), so it can be
tested without rendering. `pnpm --filter @gadgets/workshop-app test:run` runs the tests.

A lost connection leaves the app as it is. Only the first connection has the page to itself;
after that `RpcGate` keeps rendering what it did, with `ApiSession.reconnecting` set, and signs in
again on the new connection, whose `api` replaces the old. Whatever holds stubs starts over on the
new `api` without dropping what it shows: the chats (`ChatSessions.reconnect`) and the gadget
beside the page read again over what is shown, and the lists load again with the old ones up
meanwhile. Nothing loads over the lost connection, which could only fail: what opens meanwhile
says it is loading until the new `api` is there.

What the user is told is `RpcGate`'s `ConnectionNotice` (plain, tested), shown by
`ConnectionIsland` at the top of the window, centred over the content beside the
sidebar, the page and the aside together (`SplitLayout`'s `status`): only once a drop has lasted a moment, opening out of
the window's top edge the way a menu opens (its CSS keeps to `DropdownMenu.css`'s formulas), with
the mascot thinking from the start while it reconnects, or sad once it is offline or cannot reach
the server, shaken (and the island with it) by each thing that could not be done, and happy once it is back. A swipe up puts it away. What the user asks for
meanwhile (send, stop, approve, rename, start a chat) is not tried and fails nothing: ask the
notice first (`useConnectionNotice().blocked()`), which brings the island back with a shake, and
leave everything as it was, a draft included. Do the same for anything new the user can ask for.
The `connection-lost` scenario plays a drop (a script's `disconnect` step).

A workspace can also restart under a connection that stays up, which breaks only the stubs made from it: `ChatSession` and
`GadgetConnection` hear of it through `onRpcBroken` and connect again the same way, trying again
with growing waits until the history (or the UI) is in. Register `onRpcBroken` on every stub held
for longer than a call, or what it feeds goes silently still. The `workspace-restart` scenario
plays one (a script's `restart` step).

Build UI by looking at the component gallery (`/gallery`) first: add each new component or block
there so its states can be reviewed in isolation.

## The chat feed

`chat/chatItems.ts` maps a chat's messages to rows, and `chat/ChatItemView.tsx` gives each row kind
its block. The mapping is pure and returns the same objects for messages that did not change, so
only changed rows render.

The conversation is what was said, so it reads like chatting with someone. How a reply came about
(the tools the agent called, what it read, what it thought) is never a row. While the agent works,
the mascot shows at the end of the conversation with what it is doing ("Running code…"); that
status opens to the steps taken since the last message, with the one under way shown open,
including the reply as it is drafted. A reply becomes a message only once it is written. Its
steps then go with it (`AssistantItem.trace`), out of the conversation but there for whoever asks:
a message's details (`messageInfo`) show in a separate outlined panel under it. In width it is a
bubble of its own: as wide as what is in it, up to the limit a message has. The model/other
sender and time have their own icon rows, with a divider before the trace when present. The
viewer's own messages only show the time. Everything in the panel is one text size (`text-sm/5`)
and its row icons are all `size-4`, centred on their line; every chevron, here and on anything
else that opens, is `size-3` and bold. The panel arrives whole, the way a message does.
Putting it away takes two steps (`useDetailsStage`): it folds to its first line the way a step
closes, and the line then leaves. Its heights are grid
rows, never measured, so closing cannot make the scroll position jump. It joins the message's
bubble run with the same 2px spacing and meeting corners. A chevron in its top right corner
puts it away again, and so does a click anywhere outside the panel.
The mascot's room is always kept, so its coming and going moves nothing.

Steps are said in plain words, about the user's things rather than how the agent works
(`chat/toolCalls.ts`): a code run by the agent's own few words for it (executeCode's `summary`,
streamed as `toolCallSummary`), and a file step by the gadget it touched ("Updating Tip Jar…",
"Built Tip Jar", "Looked over Tip Jar"), whose file moves into the step's detail. A gadget the chat
made is being built until its changes are kept. Live calls learn the gadget from `toolCallTarget`,
finished ones from `AiToolCall.workpieceId`; `gadgetNamer` names it by the workspace's title
(`ChatSession` keeps the list through `subscribeToWorkpieces`), else the title the chat gave it.
Calls recorded before `workpieceId` existed, and failed ones, still name their file.

A turn is everything from one prompt to the next. What a turn produced (an output, a hook) or is
waiting on the user for (a pending approval or connection request) is shown at the end of the turn,
never where it happened, so it cannot be left behind by what the agent wrote afterwards. The last
turn's are kept apart (`pinned`) and rendered under the conversation. Once the user has answered a
request it is history and stays where it was answered: below what had been written by then, above
what came after, never moved back up among earlier messages. An action a standing rule approved
was decided as it was made, and is shown there the same way. What a person then did to the chat's
changes (saved edits, accepted, discarded) follows the artefacts, as a divider. Keep these rules
when adding a kind.

A chat's changes are accepted on their own once its turn ends (`ChatSession`, rules in
`chat/autoAccept.ts`), so the agent's code takes effect as it is written, but only while nobody
else is in the workspace, whose work in progress it could overtake. Chats are worktrees, kept as
they finish: another chat with changes waiting to the same gadgets does not hold one back, and a
chat kept after another brings in what that one kept (`updateChatFromMainline`) and is kept on top
of it when that merges cleanly, else asks, naming the files that conflict. Only code is kept: a
binding the chat proposes is the user's to grant, and a blueprint's update or the latest accepted
changes the user brought into the chat were asked for to be looked at first. Those stay proposed. The viewer's own accepts are not marked in the
conversation, as they are what is expected; someone else's are.

What cannot be kept on its own is asked about once the turn has ended (`ChatSnapshot.keep`,
`KeepChangesCard`), under the turn's artefacts: what the changes do, a line each
(`chat/keepChanges.ts`), and why they wait. The question waits 1.5s past the turn's end, so the
accept that the server makes itself as a turn ends (merge messages marked `automatic`) never
flashes it. Discarding asks again first. Keeping brings in what was accepted elsewhere when that
has moved on, and stops at conflicts.

Kept changes can be gone back on (`chat/changePoints.ts`, `Overseer.restoreChanges`): the newest
undone, an undo redone, an older point returned to. Each restore is a new version on top, so it can
itself be gone back on. The viewer's own accepts are not marked, so the way back is offered on the
answer that ended their turn, as a message action; someone else's, and every restore, on its
divider, as a word after it. Undoing what made a gadget deletes it, which is asked about first.

An action whose gatekeeper allows it can be approved for good (`ActionItem.rule`), once the user
has been told that it reaches every chat in the workspace, whichever gadget asks.

Approvals waiting are not cards in the conversation: they are the tray over the composer
(`PendingTray`), however many there are and whichever turn asked, so none is ever scrolled away.
It groups them by what they change (`ActionItem.target`, `chat/pendingGroups.ts`): one row for the
five appends to a Google Doc, not five cards. Approve all and Deny all (asked once) decide every
one; a row unfolds its requests to decide each, except a Google file, whose row opens it beside
the chat with "Review". One not created yet is shown as what it will be (its gatekeeper's creation
spec, `useCreationKinds`), opened as `connected-<connection>-` with no id, drawn by the connection
as made with its changes, and decided whole: Create, which makes it in the user's account as its
card would (asking which, when there is a choice, and approving the rest once it is made) and
then approves its changes, or Discard. There the file is drawn as it will be, and `ReviewBar` over its
foot steps through its changes in the order they are drawn, the file outlining and scrolling to
each (clicking one on the file steps to it), and decides that one or all of the file's
(`aside/useFileReview`, through the chat's own session, so the tray and the file agree). Both
decide through `usePendingDecisions` (`decideInOrder`): approving oldest first, so an edit never
lands before the one it builds on, denying newest first, stopping at a creation that asks where,
or at the first failure, which it names. In a workspace that has read sensitive data there is no
Approve all, and each request is read in full before it is approved. Decided, they are history
where they were decided, and a run of decisions on one thing settles as one card (`ActionItem.runOf`,
"Append to Google Doc, 5 times"), unfolding to each. A connected file beside a chat is drawn again
whenever what the chat asks of it changes, approved or waiting.

A call that wakes the agent (`agentCallback`, such as a scheduled task's `onSchedule`) is not a row:
it starts a turn, as a person's message does, and the reply it prompts says what woke it in a quiet
line at its top, by the automation's title from the call's arguments (`AssistantItem.prompt`,
`callPrompt`), once over a run of replies the same automation woke. The call and its arguments are
in that reply's details.

What another agent reported into the chat (`agentReport`) is said as that agent, with the way to
the run it came from, and starts no turn. A run of code is named by what the agent said it does
(`toolCallSummary`) while it runs.

A message sent while the agent works ends the conversation, dimmed, until the agent reads it. It
is the same row before and after, so being read only brings it to full strength. Its key is its
place among its turn's steers rather than its sequence, which it has only once read, and
`ChatSession` keeps it between leaving the queue and arriving as a message.

A message can be replied to. The protocol has no replies, so a reply carries a line of what it
answers at the front of its own text, as a Markdown blockquote (`chat/replyQuote.ts`): the agent
reads it as anyone would, and a client that knows nothing of replies shows a quote. The composer
shows that line above the draft while it is a reply, over any attachments, and the feed sets it
apart from what was written when it draws the message. Either line goes to the message it quotes
when clicked (`MessageList`'s `scrollToMessage`): by scrolling when the message's row is mounted,
and by fading the conversation over to it when the way there runs over a page that is only a
spacer. A sent reply finds its message by the line, since that is all it carries, fetching earlier
history until it turns up (`ChatSession.findQuoted`). A reply that named its message would need
neither, which is for the backend to support.

What the agent writes can say anything, so `Markdown` renders no HTML, links only web and mail
addresses, and links an image from elsewhere instead of loading it, which would tell whoever is
there what was read (one carried in the text, `data:` or `blob:`, is shown). Every link the app
draws passes `components/webUrl.ts`, so none can be `javascript:`.

Points in the conversation that nobody said are lines across it (`FeedDivider`): what people did
to the changes, and a compaction. A compaction asked for with `/compact` is announced under the
command; one that ran on its own, at the cut. Another model taking over is not one: each message's
details say which model wrote it.

Nothing in the conversation jumps. A row that arrives while the chat is open opens to its height
as the bubble or card in it grows in (`Arrival.css`; the message list marks the row), and a row of
the live output that leaves closes (`LiveRows`). Give a new block that can arrive the `arrives`
class, and put what can come and go in the live output in a `LiveRows.Row`.

The view follows the end of the conversation only for a reader who is at it; one reading further
up is left where they are, with a button to the latest. Sending a message is the exception: it
takes whoever sent it to the end, and follows from there. Where the reader is, the view keeps by the
row they were reading, as far down the conversation as it is, never as where it is on screen:
WebKit moves the view before the scroll event that says so, so a correction made in between from
a position on screen undoes the reader's own scrolling, and on iOS stops its momentum dead
(`useMessageScroll`). Set the scroll position only for a change to the conversation, never while
the reader moves it.

A draft is only let go of once its message has gone: `Composer`'s `onSend` resolves to whether it
did, and until then the draft, its files and what it replies to stay, dimmed and unsendable. One
that did not go stays as it was, under why.

Which model answers is a row of the composer's + menu, Model with the current one's name, which
shows the models in the menu's place (`ComposerAddMenu`), and only when there is more than one.
`chat/models.ts` decides it (`modelFor`): the one chosen for the next message, else the chat's own
(the one at work, or the last that spoke: `ChatSnapshot.model`), else the user's preferred, else
the first offered, each only while still offered. Choosing in a chat changes that chat only;
choosing for a new chat also makes it the preferred one (`useModels().prefer`), which every new
chat then starts with, in every browser. "No agent" is not offered.

What can be done with a message (reply, copy, details) shows beside it while it is pointed at, or
reached by keyboard. A touch screen has nothing to point with, so there a tap on the message shows
it, until the message or anything else is tapped again; a tap that is for something in the
message, such as a link, is left to that. Until shown it cannot be tapped either.

Consecutive messages from one sender are drawn as a run (closer together, with smaller corners
where they meet). `MessageBubble` does that itself between sibling bubbles; the message list wraps
each row, so `ChatPane` tells the rows about their neighbours (`continuesRun`). A message that
arrives into a run settles into it as it grows in.

What is open in a row lives in `DisclosureStore`, not in the block: the list unmounts rows far off
screen.

To add or change a kind: map it in `chatItems.ts` with a test for its rule, give it a block with a
gallery entry for every state, and add it to a scenario in `chat/mock/scenarios.ts` so it can be
seen in a conversation without a backend. Scenario scripts deliver messages in the order the server
commits a step (see `chat/mock/scenario.ts`). `scripts/record-chat-fixture.ts` saves a real chat as
a test fixture.

## Page headers

A page's header is made of bubbles (`HeaderBubble`), and belongs to its page: each pane mounts its
own. A bubble pops in when it appears and out when it goes, on a copy left behind once React has
removed it. A bubble that takes the place of one of the same `name` carries on from it instead.
That is how the workspace's crumb (`WorkspaceCrumb`) stays between a workspace and its chats,
growing its title out of the icon or drawing it back in, while going to another workspace swaps
it. Render a pane's header in the commit that mounts the pane, or what it follows is gone by then.

A workspace's page has a New chat button at the end of its header. It opens an empty chat in
the workspace (`/workspace/<id>/new`, `NewChatPane`, which the home page shares) that is
created by its first message; the chat then takes the empty one's place in the history. Until
then it greets the user as the home page does, under its header (`StartLayout`). The home
page (`/`, which the sidebar's logo goes to) starts one in a new workspace: until its first message
is sent it greets the user over the composer in the middle of the page (`ChatStart`), and is then
drawn as the conversation it becomes.

## The Workspaces page

`/workspaces` (the sidebar's folder button) lists every named workspace: the starred ones first, then the
rest by when they were last active, grouped as the chat settings page groups its files. Starring is
the server's `pinned`; the starred ones' order is this device's (`prefs/starOrder.ts`), the latest
starred first until they are dragged, or moved with Alt and an arrow key.

The groups are drawn by `GroupedList`: one flat list of rows, so a row that changes group is the
same row and keeps its focus, with each group's padding and the gap before it as margins. Its
motion (`groupedListMotion.ts`) lays the rows out again as they move and draws the surface under
them, both from pure, tested functions. `groupedPlan.ts` says what a change does: rows that keep
their order stay where they are, and the room between two opens or closes as the groups fold
differently, so groups split and merge around them with their corners rounding and squaring. A
row that moves past others into another group (starred, unstarred) does not travel: it shrinks
out of its old group, as a copy left there, and grows into its new one. A row reordered within its
group slides over a surface that stays still. `groupedLayout.ts` draws the surface: rows whose
padding meets share one rounded run, so groups never notch where they meet.

A workspace's page (`/workspace/<id>`) is laid out as a chat's settings page is: its icon and its
title, renamed where it is (`EditableTitle`) by whoever may build in it, then tabs (`?tab=`, kept
in place in the history): its chats, what it has made (the library's, as beside a chat, opening
as their own pages), its members, the owner first, and its settings: its notifications, what it has
cost, and, for its owner alone, deleting it. Each tab loads what it lists once chosen.

A chat started from Home goes, unless the picker under its composer (`WorkspacePicker`) names one
of the user's workspaces, into a workspace of its own that is never named (no
`WorkspaceMetadata.kind`; `workspaces/workspaceKind.ts`): it is a chat on its own. The sidebar
draws it with a chat's mark (`ChatMark`) and when it was last active, its header and settings
have no workspace crumb, the Workspaces page leaves it out, and its sharing speaks of the chat.
Its settings can make it a workspace (`useMakeWorkspace`, `Overseer.makeWorkspace`), named in a
dialog that starts from the chat's title; it is then listed, crumbed and drawn as one. A
workspace made before kinds were kept is a chat on its own until made one. A workspace is made on
purpose from the Workspaces page (`/workspaces/new`, `NewWorkspacePane`) or the picker's New
workspace: its title is typed where it will be shown, on a folder that takes its initials as they
are typed. A named workspace is listed at once.

Pages other than a chat (`PageLayout`) float their header over the content, unfilled, with the
content fading under it as a conversation's does (`.chat-fade`).

## Settings and questions

A settings page is rows in rounded groups (`SettingsGroup`, `SettingsRow`), a control at the end of
each; one that cannot be undone is in red and asks first (`ConfirmDialog`), holding its buttons
while it works and staying open under why if it fails. A dialog (`Dialog`) grows in as a card
arrives in the conversation and dims and makes inert the window beneath. A chat's settings page
(`?tab=settings`) has its workspace's notifications, which cannot be muted one chat at a time and
say so, what it has used (`chat/usage.ts`), and deleting it.
A gadget's settings page starts with what it is (`GadgetKindDialog`): a kind such as "Dashboard"
and one of the format icons, which the agent can also give it (createGadget's `format`,
`setGadgetFormat`) and which a blueprint published from it keeps. With no kind it is a plain app.

## Search and the account

Search (`SearchDialog`, from the sidebar or ⌘K/Ctrl+K anywhere, `routes/-AppSearch.tsx`) finds the
app's pages (Gatekeepers among them) and every workspace from the list the sidebar already has, so
opening it reads nothing. What fits is ranked by `blocks/searchMatches.ts`: a title that starts with
what was typed, then a word in it that does, then anywhere; a single letter only at a word's start.
The arrow keys move through it and Enter goes. The sidebar's avatar opens the account menu: its first
row opens the profile, and Sign out signs out of this browser.

The profile is `profile/Profile`, a plain class provided once by `_app` (`ProfileProvider`, read
with `useProfile`), started from the signed-in `whoami`. The sidebar's avatar and name and Home's
greeting read it, so a change shows everywhere at once. Each change goes to the server first, then
shows: the name (`setOwnDisplayName`), the picture (`setAvatar`, cropped and compressed by
`compressPicture`), and the password (`changePassword`, hashed by `passwordHash`, which loads
hash-wasm only when it is needed). There is no commit email: nothing in the app shows a commit. `/profile` (`ProfilePane`) lays these out as settings rows, together with the default
model (`useModels`, through `MenuChooser`) and usage (`usage.ts`: what the user's workspaces cost,
and today's allowance where the deployment limits use).

## Sharing

Who a workspace or one of its gadgets is shared with is read by a `SharingSession` (`sharing/`),
one per dialog or page, made with `useSharing` and keyed by what it shares. It opens the workspace
when started and lets it go when stopped, and over a lost connection it starts again on the new
one, keeping what is shown. Every change goes through the session, which reads the people again
afterwards, because one change can narrow what others have and the server says only whose.
Nothing is taken away without asking the server what it would do first (`previewRemoval`), so
`RemovalDialog` can name who has access only through that person; they are kept unless ticked.
What would change nothing is said without asking, by the rules in `sharingRules.ts`, which are
plain and tested. A link's key travels only in a fragment (`#share=`), which `ShareLinkGate`
redeems before anything beneath it opens the workspace, and then removes from the address. The
dialogs say what came of an invite under the field, not in a toast.

A gadget is shared to use (live, with the owner's data, once each person confirms with their own
account on each service that they can see what it reads) or, where the deployment serves owner's
views (`sharedViewsAvailable`), only to view: a snapshot of the owner's data, which reaches
nothing. Wherever someone can be given a snapshot, or must confirm accounts to use it live, a card under who has it
(`ShareAudienceCard`, read by `useGadgetView`) says who sees a snapshot and from when, and opens
the dialog's second page, "What people see" (`ShareAudiencePage`): the owner's view itself,
running (`useViewPreview`, a `GadgetConnection` with `view`, over `GadgetClient.openView()`, which
takes it again first), drawn at 0.6 scale, then each way of holding it with the connections a live
user confirms access to. A gadget's screen is code over its storage, so only the running copy shows
whether a snapshot holds the data or an empty state. The workspace's dialog names the services
whose accounts joining asks to confirm (`RequirementsNote`, `signInServices`), leaving out those
that set themselves up.

## The Library

The Library (`/library`) is everything the user's workspaces made, were sent and worked on, and
what others shared with them, in tabs: Favorites, Gadgets, Files, Automations and Skills (`?tab=`).
`library/libraryEntries.ts` makes one list from all of these, starred first and what was taken out
left out; a Google file that was taken out comes back once it is worked on again. Rows are grouped
by when, or by name, and searched by name. The list or grid and the order are this device's
(`prefs/`). Everything opens as its own page, a file shown from the chat it was sent in. A
workspace's Library tab and a chat's settings show the same rows. A Google file is starred by its subject, and shows starred while its workspace lists it. A star or a removal shows at once
and is undone, with why, if it does not hold; deleting a gadget asks first and is only offered to
whoever builds where it was made.

A tile shows what it is: an image file fills it; otherwise, once the tile nears the screen,
`library/useLibraryPicture.ts` fetches a glimpse, drawn as a sheet standing up out of the tile's
foot under the name, which heads the tile; the sheet has an edge and a shadow so a white page shows
against the tile in light, and the name fades under More and the star while they are out, which
sit on the tile, never on the picture. A
gadget's is the server's picture of it (`GadgetClient.getThumbnail()`, asked again only when the
gadget was worked on, two at a time; one the server could not draw yet is asked for twice more
while shown, and is not kept); a file's is the chat's thumbnail (`useFileThumbnail`); a
Google file's is the top of its real page, read with `previewResource` and drawn by
`blocks/resource-preview/ConnectedFileThumbnail`. What was fetched is kept for 80 entries, so
switching tabs or views does not fetch again. Nothing arrives means the glyph stays. Rows keep
their glyphs. A Google Doc, Sheet or Slides deck's glyph is Drive's own (`GoogleFileIcon`),
wherever it is listed or open.

A Google file a chat's agent created is drawn in the chat as the file (`ActionItem.made`, an
`OutputCard` in Drive's icon) once its creation is approved, rather than as the approval, and opens
beside the chat as `connected-<connection>-<id>`, among what the chat can switch to.

A Google Doc is drawn on its own paper (`DocumentPage`: the tab's size and margins, else Letter
with one-inch margins), zoomed to fit the pane, and broken into pages where Docs would break it
(`blocks/resource-preview/usePages`): a block that would run past the foot of a page's text starts
the next, a heading goes with the block after it, and a manual page break starts a page. Breaks
fall between blocks and list items, never within a paragraph, and a table moves whole. A pageless
tab, or a pane too narrow for a readable page (under half size), is one continuous page. A Slides
deck in a pane under 640px wide has its filmstrip across the top and the slide at full width.

## Skills

A skill is a `SKILL.md` in a Context Library collection (gatekeeper-context). `skills/SkillsLibrary`
is a plain class over the gatekeeper's management API (`getGatekeeperApp('context').ui`, a
`ContextApi`; the one cast is in `#open()`), provided once by `_app` (`SkillsProvider`) and read
only once something shows skills (`useSkills` retains it). `skillManifest.ts` reads and writes the
manifest, keeping frontmatter keys it does not know. The Library's Skills tab groups skills by
collection ("Yours" for the one made for their first skill while it is their only one, otherwise each
by name, with who has it), and New collection is under them from the start, before any skill;
sharing is per collection (`ShareSkillsDialog`), the org's collections are for everyone and only
admins change them. A skill's page is `/skills/<collection>/<path>` (URL-encoded), renamed in
place, which moves it.

The composer takes `commands` (`ComposerCommand`): `/` at the start of a word opens
`ComposerCommandPicker` above it, which the field drives (`slashCommands.ts` finds the slash and
ranks what fits); a chosen command is `ComposerCommandLine` at the top, and `onSend` gets it.
A chat lists its workspace's commands (`useChatCommands`, again whenever the skills change) and
sends a `SlashCommandRequest` (`chat/slashCommands.ts` maps both ways, keyed by the command id,
which for a skill is its document id). A new chat offers the Library's skills and resolves them in
the workspace it makes (`startConversation`). "Use in a chat" goes home with `useSkill` in the
history state. A skill the agent read itself is its step and a line on the reply
(`ObservationDescription.skill`, `AssistantItem.skills`).

## Automations

An automation is a hook (`listHooks`), which a scheduled task is too. `automations/AutomationsList`
reads the hooks of some workspaces, four at a time, and joins each schedule to its hook from the
scheduler's management app (`getGatekeeperApp('scheduler').ui`, pipelined so the frame's HTML never
comes; its one cast is there): by `hookId`, or by title for one enabled before that was kept. A
paused schedule has no schedule (the scheduler forgets it while off) and is known by
`BoundHookInfo.vendorId`. `cadence.ts` says when it runs and when next, on the schedule's clock
when its cadence names another time zone. `AutomationsTab` lists them, grouped Scheduled and When
something happens, on the Library (every workspace the user builds in), a workspace's page, a
chat's settings (what runs in it, and what its cards set up) and a gadget's settings (what runs its
code). A switch shows at once and is undone with why if refused; Delete asks first. Routes give the
tab `useAutomationLink` (`routes/-automationLink.ts`), so a row opens where it reports. The chat's
header has a clock while its cards show an automation, which opens the chat's tab.

An agent (an agent spawner, never called that in the UI) is listed under Agents in the same tab
(`useAgents`, `agents.ts`): `listAgentSpawners`, with each one's runs from `listChats` by
`spawnerId` (or name, for runs recorded before that), its model named from `listModels`. A gadget's
tab shows those it calls on, a chat's those its agent started. A row opens the agent's page
(`/workspace/$workspaceId/agent/$agentId`, `AgentPane`, drawn by `AgentView`): renamed and its model
changed through `updateAgentSpawner`, what calls on it, what it can use, and its conversations by
when, those waiting on a person marked. It is not a connection, so it is not on the Gatekeepers
page; a chat that asks for one sets it up from its card (`SetUpAgentDialog`), reporting each run back
to that chat unless told not to.

## Connections

`connections/` holds the user's connected accounts (`ConnectedAccounts`, a plain class provided
once by `_app`), the services they can connect (`useServices`) and the Gatekeepers page
(`/gatekeepers`, from the sidebar's pill, which stacks the connected services' logos).
`connectionGroups` sorts services into Connected, Built in and Available; blocks get logos and
accounts as props. A connection finishes in a popup that ends on the app's own `/connect/handoff`,
which redeems the ticket with the nonce the opener left in the popup's sessionStorage. In dev, start
the backend with `PUBLIC_BASE_URL=http://localhost:<app port>` so the gatekeeper hands off to this
app rather than workshop-frontend. What an agent asks to be connected to is set up from its card in
the chat (`SetUpConnection`), with an account of the service and the gatekeeper's own form.
Approving a card that creates something, such as a Google Doc (`ActionItem.creation`), makes it in
one of the user's accounts (`useApproveCreation`): with only one that can, there at once, where the
service puts new things (My Drive); otherwise, or when the agent suggested where, `ConnectResource`
asks which account and where, in the service's creation form (`startCreationConfigurator`).

An account opens its own page (`/gatekeepers/$accountId`, `ConnectionPane`, drawn by
`ConnectionAccountView`); a service not connected yet opens `ConnectionDialog` to connect it. The
page leads with what the service may change without asking: every kind of change its gatekeeper
declares (`SupportedResource.actionKinds`), grouped by what it changes (`changeGroups`, a kind
listed once, under the first), each "Ask first" or "Automatic" (`Segmented`), or "Always requires
approval" where the gatekeeper never lets it through (`ChangeDefaultsList`). The choice is the
user's default for the service in every workspace they own (`useChangeDefaults`, over
`setDefaultAutoApprovedActionKind`): a workspace does not record which of the user's accounts it
connected through, so it is by service, not account. A workspace rule ("Always approve" on a
request, `setAutoApprovedActionKind`) that goes further shows under its kind, "Automatic in Trip
planner", with the way to clear it (`useWorkspaceRules`, over each owned workspace's
`listPreApprovableActions`). A kind's label splits at ", in " into what it is and how far it
reaches (`kindLabel`). Then what the account can reach, five until "Show all", with more to grant,
and Disconnect, asked first. "Always approve" on a request says this is where to change it.

The user adds one themselves with `AddConnection`: `AddConnectionDialog` lists every connectable
kind of resource of the services that are not built in, those with an account first, then
`ConnectResource` (the account, grant and form half of `SetUpConnection`, with Back) makes it in
the workspace (`newGatekeeper`). From a chat's + menu (an existing chat, for whoever builds in it)
the connection becomes a line above the draft (`ComposerConnectionLines`) and goes with the message
as a capsule (`chat/capsules.ts`), so the chat has it from then on; a skill goes alone, so the two
refuse each other, and none go while the agent works. From a gadget's Connections tab Add binds it
to the gadget (`GadgetSettings.bind`, with the name the gatekeeper suggests). A chat's settings
have a Connections tab (`ChatConnectionList`, from `listChatConnections`): what is in the chat,
what the workspace's gadgets hold, and what every chat has.

## Blueprints

`blueprints/` holds them. The Library's Blueprints tab (`BlueprintsTab`, `?tab=blueprints`) lists
what the deployment features, then the user's own, published or saved, not already featured
(`blueprintEntries` dedupes `listFeaturedBlueprints`, `listLibraryBlueprints` and
`listOwnBlueprints`, the last read through `getBlueprint` for its picture), as `BlueprintTile`s,
searched and ordered as the Library is; Upload in the header takes in a `.gadget` file
(`importBlueprint`) and opens it. A blueprint's page is `/blueprints/<id>` (`BlueprintPane`): its
picture, who published it, what it is for and what it needs (`needsOf` turns its bindings into
connections, models and agents), with Save, Use, and More (Copy link, Download file through
`files/saveFile`, and the workspace it was published from). Use (`UseBlueprint`, drawn by
`UseBlueprintDialog`) meets each need: a connection in its service's own form (`ConnectResource`,
which comes back to the dialog), a model from a menu that starts with the author's suggestion where
the user has it (`initialAnswers`). It then makes the gadget in a new workspace
(`newWorkspaceFromBlueprint`, then `Overseer.makeWorkspace` so it is named and listed as a
workspace) or, for one that needs nothing, in a workspace the user builds in
(`createGadgetFromBlueprint`), and opens the gadget. Home shows two featured blueprints under
its composer, in the tiles' sheet style, and a third card to all of them, a fan of their pictures
(`FeaturedBlueprints`, in `ChatStart`'s `after`, which leaves the composer where it is). Publishing from a gadget's settings sends the gadget's picture (`GadgetClient.getThumbnail`,
drawn as the dialog opens, by `usePublishPicture`) and then offers to open the blueprint's page.
The dev server proxies `/blueprint-screenshot` to the backend, as the router does.

## A gadget's own pages

A gadget's page (`/app/<id>`, the side pane as the page) says where it lives and leads to a chat
with it, because using it with the agent (a slides gadget whose agent builds the slides with you)
and carrying on building it both happen in a chat. Its header starts with its workspace's
`WorkspaceCrumb`, title shown, as a chat's header starts with it, when the workspace is a named
one. Its far end has Chat (`GadgetChatMenu`): New chat starts one in the workspace with the gadget
beside it (`/workspace/$id/new?open=`, greeted "what should we do with Slides?" through the
`gadgetTitle` history state), and below it up to four chats there to carry on in
(`aside/itemChats.ts`), those that last had it beside them in this browser (`lastShown`) first and
saying so. Opening one remembers it there. With no chats yet Chat starts a new one at once; made in
a chat on its own, it has no crumb and Chat goes back to that chat. Chat is for whoever owns the
workspace or builds in it, never for someone given the gadget alone to use or a snapshot of it
(`role === 'use'`). It is left out where Collapse already goes back beside the chat the page came
from, and in full screen. The backend does not record which chat made a gadget, so nothing claims
to know it. The design record is `plans/gadget-to-chat.md`.

`/app/<id>/settings` is a gadget's settings, from its More and from full screen. `GadgetSettings`
watches one gadget's workpiece, bindings and hooks, and reports `denied` when the workspace refuses
the viewer. Who has it (`ShareGadgetDialog`), publishing it as a blueprint and deleting it are on
the Settings tab, for whoever builds in its workspace; what it is connected to and the automations
that run it are on Connections. A gadget the viewer cannot open shows `GadgetNoAccess`, beside the
page and on its settings, rather than an error: Request access writes a message with the link, and
a blueprint card appears only when its blueprint is known.

Its code is the Code tab (`?tab=code&file=`), for whoever builds in its workspace, and the side
pane's More has View code to go there. It is the code as last kept, its head commit, read with
`listTree` and `readFilesAtCommit` (`useGadgetCode`, which keeps what it read of the last few
commits, as commits never change), and only read: changes are asked for in a chat. `gadgetCode.ts`
lists the files (plain, tested): its screen and server side first, each saying in a few words what
it is to the gadget ("What it shows", "What it keeps and does"), then its README, the rest of its
root, and folders. `CodeBrowser` lays them down the side of the file shown, by its own width
(container queries, not the window's): where it is narrow, as beside a chat, the list is a drawer
the file's header opens. The arrow keys step through them. `CodeView` shows it with line numbers
that stay put as it scrolls across, never wrapped, plain at once and coloured once `highlightCode`
(Lezer's parsers, imported only then) has read it, in the `--color-code-*` tokens of `theme.css`.
Selecting it copies the code alone. Each switch of file is in place in the history.

A gadget is saved as a file with `gadgets/GadgetExports` (`GadgetClient.export`, as the chat it is
shown from proposes it): from the pane's More, Export shows the formats in the menu's place, read
each time it opens (`components/useMenuPages`, as the composer's Model does), and a pill at the
foot of the pane says it is under way, then why if it failed; on its settings, an Export row names
the formats and appears only when it has some. `files/saveFile` asks where to save while the click
still counts, where the browser can, and streams to it; elsewhere it downloads.

## Beside the page

Files and outputs open in a second card beside the page (`SplitLayout`, which `AppShell` lays the
page out with). Several can be open, one of them shown; the rules for that are plain functions
(`aside/asideTabs.ts`). A chat does not open anything itself: it says what was asked for
(`ChatPane`'s `onOpenAttachment` and `onOpenOutput`), and whoever lays the page out keeps what is
open (`useAsideState`) and hands the ways to open it down (`useAside`). It stays open from one
page to the next.

The pane can be put away with things still open in it: by the arrow at the end of its header, or by
dragging the gap far past the pane's narrowest, where the pane dims to say that letting go closes
it. It goes at the width it has then, with what is in it keeping that width and sliding out under
the edge, and opens again as wide as before it was dragged. The sidebar's Library button brings it
back; with nothing open it shows the pane empty, with no surface and no bar, which there is nothing
to make room for. Opening something shows the pane too. Closing the last thing open puts the pane
away with it.

A pane that was put away can also be had back from the page's far edge, empty or not. As it goes,
the page stops a little short of the edge and the handle stays out there for a moment, to show
where the pane went, then both slide away. A pointer that reaches the edge brings them out again:
clicking the handle shows the pane, and so does pulling it out, which opens room as far as it is
pulled. Only reaching the edge does it, not being near, because the page's scrollbar is there.
Beside a chat it shows what was last shown there, or what was made last. Until the library has
been read, it opens empty, then shows the first thing found, or that there is nothing.

What is listed beside a chat, and on its settings page, is everything its workspace has made
(`useChatLibrary`): the library (`listOutputs()`), read again for each chat, and what the chat has
made that the library does not have yet (a gadget still to be accepted, a worktree), from what is
loaded of the conversation. The backend says nothing of which chat made what, so it is not just
the chat's own. Files sent in the chat are not listed for now, though one opened from its message
is shown as before.

The card (`SidePane`) is a header, then what is shown on a tinted surface that fills the rest of the
card out to its sides and bottom, with rounded top corners and a line along its top only. With more
than one thing open the header starts with their count, which opens to the list of them and the way
to close them all. Then the name of the one shown, which grows a button when pointed at that closes
it (`SidePaneTitle`). At its far end: who else has the workspace open, more (reload, close), a link
to copy, full screen, and the arrow. The bar at the top of the surface, in the middle, pushes the
header up out of the way and pulls it back down (`Grabber`); clicking it does the same. Its bar is
the divider's pill, always out and staying put: it grows, darkens and springs as the pill does when
taken hold of (`pill.ts` holds what the two share).

A gadget runs live in the pane (`GadgetConnection`, plain and tested like `ChatSession`): its UI
code is loaded into a page for a sandboxed frame with no origin (`gadgetSandbox.ts`, ported from
`workshop-frontend`'s `GadgetUI`), and the page is connected to the gadget's server side once it
asks, with a port it posts. Only messages from the pane's own frame are listened to. Opened from a
chat, a gadget shows that chat's proposed changes. It is loaded again when its code changes: a
change to its files in that chat, the chat's changes being accepted or thrown away, or its head
moving. A burst of edits loads it once, and the page shown stays until the new one replaces it. Only
the one shown is connected: going to another tab and back starts it over.

A worktree (a repository an agent checked out, `WorktreeSummary`) is called that, and shown as its
code (`WorktreeView` over `CodeBrowser`, read by `aside/useWorktree`): as kept (`pinBase`), the
files changed since it was made (`listChangedPaths` from `baseCommit`) marked with a brand dot and
listed first, and above them a line of how many changed and its agent's commits (`getCommitLog`
from `headCommit`, back to `baseCommit`), which open into a list. A gadget's file roles are left
off, as a repository's `client.ts` is not a gadget's screen. A chat's Scratch space, the worktree
its uploads go into, is not listed: what was sent there is under Files.

A file is shown as what it is (`aside/filePreview.ts`, tested; `FileView` draws each kind): an
image, a PDF in the browser's own viewer, audio, video, Markdown, and text or code as written.
Anything else offers its download, which the pane's more menu has for every file. The bytes come
inline with the message or are fetched through the chat it was sent in, so a file's own page
needs `?chat=`. What the browser is given to show is never typed by the file's word alone: only
the kinds a browser displays without running anything are, a PDF must start like one, a page is
shown as its text, and a file that says nothing is told by its first bytes. Images, here, in a
message and in the composer, are raster images (`files/rasterImage.ts`) from object URLs, and SVGs
(`files/svgImage.ts`), only ever in an `<img>`, which runs no script and loads nothing from
elsewhere. An SVG is still a page, which from a `blob:` URL of the app's origin opened in a tab of
its own would run as the app, so it is given from a `data:` URL, which has no origin
(`hooks/useImageUrl.ts`). Downloads are typed as plain bytes, so they are saved rather than opened.

Full screen has the pane fill the window to its very edges, with no frame or corners, over the
sidebar and the page, which are made inert. The card leaves its place beside the page (which is
kept, to go back to) and grows to the window's edges by animating the edges themselves, not a scale,
so the gadget is laid out at each size rather than stretched, and its frame is never moved in the
document, which would reload it. Escape leaves full screen, also from inside the gadget, whose page
passes the key on.

The header then has the app's mark, the name (which closes nothing there), who else is there, more
(only reload), the link, and the way back. The mark, a button as in the sidebar, leaves full screen
for the output's workspace's latest chat, with the output beside it (`latestChat`). The header is
out until it is put away, and is put away and had back by the bar as beside the page; doing so
squares off the surface's top corners as it goes, so they are square at the window's top.

The sidebar is expanded, collapsed to a rail one button wide, or hidden, and `AppShell` owns
which (it hands `collapsed` to whatever draws the sidebar). Its gap dragged well past the
sidebar's narrowest collapses it to the rail, and dragged back out expands it. Between the two,
the width springs across the jump, and what was in the sidebar fades out, keeping its width,
before the other fades in and comes into focus; never both at once. Dragged narrower than itself,
the rail does not resist or squeeze: it keeps its width and follows the pointer out under the
edge. Well past, it dims and is hidden when let go, the way the aside is put away, and is had back from the
window's near edge the way the aside is from the far one: clicking the handle shows it as it was,
and pulling it out brings the rail out first, then the sidebar past the rail. The arrow keys on
the handle step through the same: narrower than its narrowest collapses, and the rail hides.

The gaps after the sidebar and between the two cards are dragged to resize (`ResizeHandle`). The
handle only reports what is asked of it; whoever places it owns the size and its limits, as a
motion value so that dragging renders nothing again. Past a limit a size resists and springs back
when let go (`resizing.ts`).

Scrollbars have no track (`styles.css`): left to the system, pointing at one widens it into a
rail down the side of what is scrolled. And they are kept out of sight while the panes move, and
while the pointer is in a gap between them (`useScrollbarsAway`): as a pane is resized or slides
away, what is in it scrolls to keep its place, and the system would show the scrollbar for that,
as it does for a pointer that is only beside one.

A Google Doc, Sheet or Slides deck is shown as it is (`Overseer.previewResource`), with the changes
waiting on someone drawn in, and is read only: it is edited in its own editor, through "Open in
Docs", "Open in Sheets" or "Open in Slides" in the pane's More menu. While it loads, a blank page of
its kind stands where it will be. Its ref is `connected-<gatekeeper>-<subject>`. Pictures inside it
are never fetched from elsewhere.

## On a narrow screen

Narrower than `md` (`hooks/useNarrowScreen.ts`), such as a phone, there is room for one thing at
a time, and `_app` lays the frame out with `NarrowShell` instead of `AppShell`: edge to edge, with
no cards, clear of the system's safe areas. The pages are the same, home included. The sidebar is
beneath the page, on the backdrop. On the pages it goes to (home, a workspace, Library and
Workspaces), a button at the start of the header (which leaves it the room, `--header-lead`)
moves the page aside to the far edge, where what stays in sight of it is tapped to put the sidebar
away again, as is Escape. It is not swiped. Going anywhere puts it away: like full screen, it is
left behind with the page. A page further in goes up to one of those by its header: a chat, one
about to be and a chat's settings by the workspace's crumb, and an item's own page by its own way
up, to the chat it was shown from, the Library page it was opened from (`fromLibrary`), or else
its workspace's library. The workspace page's New chat is its icon alone. A field's text is 16px
at least there (`max-md:text-[16px]`, Kumo's `text-base` being 14px), or iOS zooms the page in
when it is focused: the composer and its measuring copies, and the sign-in form. Keep to it for
a new field.
The composer's return key is labelled for sending (`enterkeyhint`), as Enter sends; the ✓ iOS
puts over its keyboard only puts the keyboard away, and nothing a page does makes it send. An
on-screen keyboard makes the page shorter on Android (`interactive-widget` in `index.html`), so
the composer sits above it. A phone reaching the dev server by its address has a page that is not
served securely, which has no `crypto.randomUUID()` and no clipboard: make ids some other way.
A named header bubble that carries on from one elsewhere along the header slides over from there.

What is beside a chat on a wider screen comes over all of it from the far edge, as the page moves
a little aside beneath it, and is had back from that edge as on a wider screen: pulled out, which
brings it as far as it is pulled, or tapped, where a pill shows. It goes by a back button at the
start of its header, or swiped back off the edge from its near one. Going to a chat does not bring
back what was last shown beside it, which would cover the chat. `SidePane` (`narrow`) is then as
big as it gets: no Expand, Collapse or full screen, and the step down is that back button. It
fills the window, so the bar squares off its surface's corners as in full screen. The scripted
chats (`/mock/*`) are laid out the same way on a narrow screen.

## Theming

This app restyles Kumo at the token level, in `src/theme.css` only. That is a deliberate departure
from `workshop-frontend`'s ban on token theming, which predates this rework. Components and blocks
use Kumo semantic tokens (`bg-kumo-canvas`, `bg-kumo-base`, `ring-kumo-line`) and never colour
literals. Wrap a Kumo component only for what tokens cannot change, such as sizes and hit targets.

- Page backdrop: `kumo-canvas`. Content card: `kumo-base`. The composer: `kumo-elevated`.
- Dark follows the system: `index.html` sets `data-mode` on the root before anything is drawn, and
  keeps it in step. Each token in `theme.css` is a `light-dark()` pair, and the rules that derive
  dark from light are written at the top of that file. Keep to them, so that what matches in light
  matches in dark.

## Promoting to `@gadgets/ui`

Components start here. Move one to `packages/ui` once a second frontend (e.g. a gatekeeper app) needs
it, as `packages/ui/AGENTS.md` describes. Shell and layout code is expected to stay here.

## The sidebar

The sidebar lists recents (`workspaces/sidebarEntries.ts`): each chat as a row of its own, from the
account's `getChatThreads()`, kept live by the `"all"` unread-state subscription
(`WorkspacesProvider`), and each workspace with no chat to list as one row.
