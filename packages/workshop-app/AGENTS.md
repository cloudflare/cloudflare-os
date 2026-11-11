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
```

UI imports point down only: components, then blocks, then layouts, then routes. The data folders
(`rpc/`, `workspaces/`, `chat/`) are the only code that talks to the backend: UI layers cannot import
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

Points in the conversation that nobody said are lines across it (`FeedDivider`): another model
taking over, what people did to the changes, and a compaction. A compaction asked for with
`/compact` is announced under the command; one that ran on its own, at the cut.

Nothing in the conversation jumps. A row that arrives while the chat is open opens to its height
as the bubble or card in it grows in (`Arrival.css`; the message list marks the row), and a row of
the live output that leaves closes (`LiveRows`). Give a new block that can arrive the `arrives`
class, and put what can come and go in the live output in a `LiveRows.Row`.

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

## Theming

This app restyles Kumo at the token level, in `src/theme.css` only. That is a deliberate departure
from `workshop-frontend`'s ban on token theming, which predates this rework. Components and blocks
use Kumo semantic tokens (`bg-kumo-canvas`, `bg-kumo-base`, `ring-kumo-line`) and never colour
literals. Wrap a Kumo component only for what tokens cannot change, such as sizes and hit targets.

- Page backdrop: `kumo-canvas`. Content card: `kumo-base`.

## Promoting to `@gadgets/ui`

Components start here. Move one to `packages/ui` once a second frontend (e.g. a gatekeeper app) needs
it, as `packages/ui/AGENTS.md` describes. Shell and layout code is expected to stay here.
