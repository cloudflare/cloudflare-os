# Workshop App

The reworked Workshop frontend, built beside `workshop-frontend` (which stays the shipped app until
cutover). Scope is deliberately small: chat, chat settings, and the Library and Workspaces pages.
Follow `../../AGENTS.md` and the `frontend-conventions` skill in addition to this file.

Dev server: `pnpm --filter @gadgets/workshop-app dev` (port 3001; the old frontend uses 3000).
`src/routeTree.gen.ts` is generated and committed, like the old app's; do not edit it.

## Layers

```text
src/
  components/   Kumo wrappers and primitives; no product knowledge, no data
  blocks/       Compositions of components for one purpose (a message, a composer, a list row)
  layouts/      Page structure: shell, sidebar, aside, toolbar pages. Arrange slots, know no content
  routes/       Route declarations; they connect the data folders below to the UI layers above

  rpc/          The backend connection and sign-in; `useApi()` beneath `RpcGate`
  workspaces/   The user's workspace list, and one workspace's chats (`WorkspacePane`)
  chat/         One chat: `ChatSession` (plain class, no React), the mapping from server
                messages to what is rendered, and `ChatPane`, which wires them to the UI blocks
  chat/mock/    A scripted fake backend for chats, played at `/mock/<scenario>`. Development only
  aside/        What is open beside the page (a file, an output), and the ways to open it
```

UI imports point down only: components, then blocks, then layouts, then routes. The data folders
(`rpc/`, `workspaces/`, `chat/`, `aside/`) are the only code that talks to the backend: UI layers cannot import
them, and they cannot import routes. Lint enforces both (`vite.config.ts` at the repo root). Blocks
and layouts take plain typed props and callbacks.

Put protocol logic in plain classes and functions with no React (like `ChatSession`), so it can be
tested without rendering. `pnpm --filter @gadgets/workshop-app test:run` runs the tests.

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

A turn is everything from one prompt to the next. What a turn produced (an output, a hook) or is
waiting on the user for (a pending approval or connection request) is shown at the end of the turn,
never where it happened, so it cannot be left behind by what the agent wrote afterwards. The last
turn's are kept apart (`pinned`) and rendered under the conversation. Once the user has answered a
request it is history and stays where it was answered: below what had been written by then, above
what came after, never moved back up among earlier messages. An action a standing rule approved
was decided as it was made, and is shown there the same way. What a person then did to the chat's
changes (saved edits, accepted, discarded) follows the artefacts, as a divider. Keep these rules
when adding a kind.

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

Points in the conversation that nobody said are lines across it (`FeedDivider`): another model
taking over, what people did to the changes, and a compaction. A compaction asked for with
`/compact` is announced under the command; one that ran on its own, at the cut.

Nothing in the conversation jumps. A row that arrives while the chat is open opens to its height
as the bubble or card in it grows in (`Arrival.css`; the message list marks the row), and a row of
the live output that leaves closes (`LiveRows`). Give a new block that can arrive the `arrives`
class, and put what can come and go in the live output in a `LiveRows.Row`.

The view follows the end of the conversation only for a reader who is at it; one reading further
up is left where they are, with a button to the latest. Sending a message is the exception: it
takes whoever sent it to the end, and follows from there.

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
created by its first message; the chat then takes the empty one's place in the history.

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
the one shown is connected: going to another tab and back starts it over. Files and worktrees only
say what they are, for now.

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

## Theming

This app restyles Kumo at the token level, in `src/theme.css` only. That is a deliberate departure
from `workshop-frontend`'s ban on token theming, which predates this rework. Components and blocks
use Kumo semantic tokens (`bg-kumo-canvas`, `bg-kumo-base`, `ring-kumo-line`) and never colour
literals. Wrap a Kumo component only for what tokens cannot change, such as sizes and hit targets.

- Page backdrop: `kumo-canvas`. Content card: `kumo-base`.

## Promoting to `@gadgets/ui`

Components start here. Move one to `packages/ui` once a second frontend (e.g. a gatekeeper app) needs
it, as `packages/ui/AGENTS.md` describes. Shell and layout code is expected to stay here.
