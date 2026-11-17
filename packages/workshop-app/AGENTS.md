# Workshop App

The reworked Workshop frontend, built beside `workshop-frontend` (which stays the shipped app until
cutover). Scope is deliberately small: chat, chat settings, the Library, Workspaces and
Connections pages, and the Settings page with the skills listed in it.
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
  connections/  The services the user has connected and could connect (`useConnections`), the
                Connections page, and the window a service is signed in to in
  settings/     The Settings page (`SettingsPane`), a file for each of its parts, and what they
                read and write of the user's account
  skills/       The user's skills (`SkillStore`, in memory for now), the list of them in the
                settings (`SkillLibrary`) and one skill's page (`SkillPane`)
  automations/  What runs by itself in a workspace (`useAutomations`), and the tab that lists it
                (`AutomationsTab`)

  files/        What a file is, from its name and type; plain functions any layer may use
  prefs/        What is kept on this device between visits (layout); plain, any layer may use
  gallery/      The component gallery's previews, at `/gallery`. Development only
```

UI imports point down only: components and hooks, then blocks, then layouts, then routes. The data
folders (`rpc/`, `workspaces/`, `chat/`, `aside/`, `library/`, `connections/`, `settings/`, `skills/`, `automations/`) are the only code that talks to the
backend: UI layers cannot import them, and they cannot import routes. `files/` and `prefs/` are
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
`chat/autoAccept.ts`), so the agent's code takes effect as it is written, but only while the
viewer is the only one working on them: nobody else is in the workspace, and no other chat has
changes waiting to the same gadgets. Only code is: a binding the chat proposes is the user's to
grant, and a blueprint's update or the latest accepted changes brought into the chat were asked
for to be looked at first. Those stay proposed. The viewer's own accepts are not marked in the
conversation, as they are what is expected; someone else's are.

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
drawn as the conversation it becomes. Under the composer, in its middle, is where the chat starts
(`WorkspacePicker`): a new workspace until one of the user's is chosen, with its icon, from a menu
that opens in place with a field to find one by. The menu is a `DropdownMenu` that holds an
`OptionPicker` (`picker`) of which one is chosen (`single`), and choosing closes it. It offers the
workspaces the user may chat in, not those they can only use, and the choice lasts for the visit
to the page.

## The Workspaces page

`/workspaces` (the sidebar's folder button) lists every workspace: the starred ones first, then the
rest by when they were last active, grouped as the chat settings page groups its files. Starring is
the server's `pinned`; the starred ones' order is this device's (`prefs/starOrder.ts`), the latest
starred first until they are dragged, or moved with Alt and an arrow key.

Over the list are its controls (see Lists, below): `workspaces/workspaceList.ts` says how it can be
ordered (last active, date created, name), narrowed (starred, whose it is, who has access) and
searched. The starred stay first in every order, and are only reordered while nothing narrows
them, as putting some of them in order would lose the others' places. Its New button starts a chat
on the home page, which is what makes a workspace.

A workspace shows the first three of those with access to it on its row (`MemberAvatars`), the
viewer alone when nobody else has, each saying how many there are and whose it is when pointed at;
a card shows them, smaller, at the end of the line its time is on. `listWorkspaces()` says nothing of members, so each workspace is asked for
its own (`WorkspaceMemberships`, plain and tested): a few at a time, in the order listed, and kept
for a while by `WorkspacesProvider`, so that going back to the page does not ask them all again.
That is a round trip to every workspace, each of which it wakes: the list should carry its members
instead, once the backend can say so. Until a workspace has answered it shows no one, and passes
none of the filters for members.

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

## The Library page

`/library` (the sidebar's Library button) lists everything the user's workspaces, and those shared
with them, have made (`useLibrary`), the way the Workspaces page lists workspaces: the starred
first, then the rest in the order chosen, as rows (`LibraryRow`) or cards (`LibraryCard`, laid
out as a template's `TemplateCard`: a sketch of what it is with the icon of its workspace in the
corner, which goes to the workspace, and its type's beside that, its title, and at the end whose it
is as their picture, the user's own included, with when it was; `CardGrid`'s `large`). `library/libraryList.ts` (plain, tested) says
how it can be ordered (last active, which is its workspace's; date created; name; type, each type
a group of its own however few it has), narrowed (starred, whose it is, and its type and its
workspace, each a menu of its own) and searched.

It has a tab each (`?tab=`, kept in place in the history, at the start of the line, with the
list's controls at its end (`Tabs`' `end`, `ListToolbar`'s `inline`, whose search is a button
until it is opened into the room between), and scrolled along it where it is too short for both;
on a narrow screen the controls are under the list): Starred, All, and one for each
type something has been made as, once there is more than one. It starts at Starred for whoever has
anything starred, and at All otherwise. Every tab is the same list under the same controls, of what
the tab has, so the starred and the types are tabs rather than filters, and the filter menu has
the rest, with Hide starred, which leaves the starred to their own tab rather than first in every
other. They are reordered on their tab and on All. `LibraryPane` reads what the page shows and
`LibraryView` draws it from plain props, which is what the gallery renders over fake outputs.

The header ends in Explore templates (Explore, on a narrow screen) and New, whose menu ends in the templates too. The templates
(`/library/templates`, `TemplateStoreView`) are what the backend calls blueprints, the way a store
lists apps, with Publish at the header's end (`PublishMenu`: the user's own apps, `ownApps`,
under a field to find one by; choosing one does nothing yet, as a blueprint is made from its app,
`GadgetClient.createBlueprint()`, with a step this app lacks), and a banner of the organization's
own over everything else (`PromoCarousel`, in the workspace colours, moving on by itself while it
is not pointed at or focused, and not with reduced motion): a tab each (`?tab=`) for its front (Discover: the most used on one line that is
scrolled along (`ScrollRow`), the latest published two to a line, then some of each kind they
make, each a `Shelf` with the way to the rest), for all of them, and for each kind, then a search
and the filters (`library/templateList.ts`, plain and tested: starred, needing nothing connected,
and the services they work with). A search or a filter lists what it leaves in place of the front.
The front's large cards are `TemplateCard`s and the rest are `TemplateListing`s, which have no
button of their own: a template is used from its page. Both end in who it is by (their picture,
or the organization's mark) and the services it needs connected as a stack of their logos
(`TemplateByline`, `ServiceStack`).

A template's own page (`/library/templates/<id>`, `TemplatePageView`) is laid out as a store's
page for an app: what it makes on a tile beside its title, Use template and its star, what there
is to know at a glance (`FactStrip`), a picture of what it makes (`TemplatePreview`, sketched by
kind from Kumo's tokens until its publisher gives a screenshot), what it is for, the services it
needs connected in place of an app's privacy (`ConnectionNeeds`), the facts at length, and others
of its kind. A section's title is a group of settings' (`text-lg`).

None of the templates is read yet: they are examples (`exampleTemplates.ts`) of the backend's
`BlueprintPublicInfo` with how much each is used and whether it is the organization's own, which
it does not say. Their stars last for the visit (`useTemplates`), Use template is out of use until
there is a way to start something from one (which, for one that needs connections, is
`newWorkspaceFromBlueprint()` with a setup step this app lacks), and which of its services the
user has connected is not asked. Read `listFeaturedBlueprints()` and the user's saved ones in their
place, keep `/blueprint/<id>` public for share links, and do not call starring one "Add to
library", which lists outputs.

The types are what the old Outputs page had: apps (an output made as no format), then the formats
the deployment offers (`listOutputFormats()`, `useOutputFormats`), in its order and whether or not
anything has been made as one, then whatever else is in the library, such as a format no longer
offered.

The backend keeps no star for an output, so the stars and their order are this device's
(`prefs/libraryStars.ts`, with the rules in `library/libraryStars.ts`): they do not follow the
user to another browser. They should be the server's, as a workspace's `pinned` is, once the
backend can say so. A star for an output that is not listed is kept: it may only not have been
read yet, as while the index catches up.

Its New button is a menu of the formats that can be started by asking for one (not those whose
blueprint has something to set up first), and a plain button until there are any. Choosing one goes
to the home page with `?format=<id>`, whose composer then starts with the format
(`ComposerFormat`, a line over the draft, as a reply's is), and can be sent with no words. The
first message names the format ahead of what was written and says where the name is
(`chat/startWithFormat.ts`), which is what the old composer's Start with menu sent: the agent
reads the name and makes one from the deployment's blueprint, and the feed draws it as a chip.

## The Connections page

`/connections` (the sidebar's Connections button) lists the services the app can use on the
user's behalf, the way a store lists apps (`useConnections`): one entry for each account
connected, and one for each service on offer that could be connected, which is every one but those
added as they are that have their one account: a service that is signed in to takes another
account, so it is offered beside the accounts it has. It is the old app's Gatekeepers page,
without a service's own page.

`connections/connectionList.ts` (plain, tested) says what is listed and how. It has the one order,
so no control to choose it by: what needs attention first (an account whose sign-in ran out), then
the accounts connected, each a group of its own however few it has, then what could be connected,
by category. A service can be of several categories, the first the one it is most, which is the
one it is listed under (Google is for mail and data too, but is listed under Productivity). A
category with enough services for the view is a group of its own, and the rest, with those that
have no category, are gathered after them under More; while no category has enough, they are all
under Available. A service says nothing of its categories itself, so
`connections/serviceCategories.ts` says them for the services this repository has a gatekeeper
for, by their id. A deployment's own services have none: they should be the gatekeeper's to say
(`VendorDescription`), once the backend can. The filters are where a connection stands and, in a
menu of their own, the categories that something listed is of, which a service passes by any of
its own. The search also finds one by what it is for, its categories, what it gives access to,
and whose account it is.

It starts as cards (`startsAs`), two to a line (`CardGrid`'s `wide`), each laid out along its line
(`ConnectionCard`): the logo, the name over what the service is for, and at the end a mark of
what the card does, with the logo and that staying at the top as what is said grows down. A
connected account has a dot on its logo (`ConnectionStatus`): green (`--color-live`) while it can
be used, red once it has to be signed in to again. Under its name is whose account it is instead
of what the service is for, which whoever connected it knows, unless that is only the service's
name again, as it is for one added as it is.

All of the card or the row is a button. That of a service that could be connected has a plus at
its end, and opens `ConnectDialog` (a `Dialog`): what the service is for
and what it gives access to, with a switch for each kind that is given on its own, all on to start
with, and the way on to the service to sign in, or to add it where there is nothing to sign in to.
What it gives access to is one surface, no taller than a few of its lines and scrolled within,
by a scrollbar that is always there to say so (`.scrollbar-shown` in `styles.css`, which only
WebKit and Chromium can draw). Anything said at length, of the service or of one of those, is cut
short with "more" right after it (`ClampedText`): by how many characters it has
(`clampText.ts`, plain and tested), not by how many lines it takes, so that nothing is measured.
The dialog stays until the service's window is open, with why under it when it could not be, and
`ConnectionsPane` puts it away then.

That of a connected account has a chevron at its end, and opens `ManageConnectionDialog`, which
is laid out as the other is (`ServiceDialogHeader`, `ServiceDialogBody`): whose account it is, in
an outline, over what it has access to, where a kind it does not have is switched on and given by
going on to the service; what it has is only taken back by disconnecting, which its switch, which
cannot be changed, says when pointed at. At its foot are Disconnect, which is
asked for twice (as is the sign-out button at the end of the account's outline, which asks the
same) by a `ConfirmMenu`: the question grows out of the button in place, as a menu does
(`DropdownMenu`'s `raised`, with a faint shadow, as it covers a surface like its own), with
Cancel beside the button that does it, and Tab going between the two, which in a menu would close it. Ask that way for anything else that cannot be taken back. Then come the way to add another account, and Done. An account that has to be signed in to
again says so first, in a `Banner` with Reconnect in it, which is the one place it is signed in to
again from: its card or row only has a badge before the chevron. What was asked for
in either dialog and could not be done is said in a `Banner` over its buttons. A dialog is given
the connection as it is listed now, so that what an account is given shows while it is up.

`Banner` is the app's own, drawn from Kumo's colours: a rounded surface in the colour of what went
wrong, with its icon and its action on the title's line, the action a button of the app's shape
a shade deeper than the banner. A surface in a dialog, the banner or a list, is a step less round than
the dialog (`--surface-radius`, which `Dialog` sets). `Button`'s `danger`
is `secondary` in that colour, for what cannot be taken back. Switches are the app's own
`Switch`, fully round as the buttons are, in Kumo's blue with a thumb that is white in either
theme: Kumo's is a squircle whose thumb cannot be reshaped from outside. Use it for any new one.

A service is signed in to in a window of its own (`connections/connectHandoff.ts`, plain and
tested, ported from the old app without the native app's path; see `docs/connect-handoff.md`). The
window is opened empty, disowned and given the flow's nonce before it is sent to the service, and
ends on `/connect/handoff` (`ConnectHandoffPane`, outside the app's frame), which redeems its
ticket with the nonce over its own session. Redeeming is what connects the account, which then
shows on the page through `subscribeConnectedAccounts()`. The flow ends on the deployment's public
address, so in development it only finishes when that is this app's.

## The Settings page

`/settings` (the user's own button in the sidebar) is one route, with `?section=` naming the part
that is showing (`settings/settingsSections.ts` has them, in order, with their names and icons).
Where there is room for a sidebar, the parts are listed there in place of the app's own
(`SettingsSidebar`, which `_app.tsx` swaps in for as long as the page is a settings one), and
choosing one replaces the address, so that going back leaves the settings rather than going
through their parts. On a narrow screen the list of the parts is the page (`SettingsMenu`), and a
part is gone into from it. The user's button leaves the settings again: back to where they were
opened from (`settingsOpenedHere`), or home.

A part is a file in `settings/` (`ProfileSettings`, `ModelSettings`, …) made of the same blocks:

- `SettingsGroup` is settings that belong together under a title, on one surface (`SettingsCard`)
  or, `plain`, on the few it gives itself. A group's title is said once in all of the settings:
  do not give two groups the same one. A description under the title is for a group whose rows
  are not settings, such as a list.
- `SettingRow` is one setting: what it is, and what it is set by, in a column of one width down
  the group. `SettingField` and `SettingPresets` are rows that are a line of text, kept on Enter or
  on leaving the field (`useEditedField`).
- What is not there yet is marked `soon` ("Coming soon"), on the group where all of it is, or else
  on the row. It is drawn fainter, and what it is set by is shown as it will be and is out of use
  (`inert`): `SettingRow` sees to its own, and to those of a `soon` group it is in
  (`SoonContext`); what a group holds that is not a row sees to itself, as `SettingsCard`'s field
  and `ApprovalRules` do. `settings/SoonControls.tsx` has controls to show; replace one with the
  real control once its setting is there.
- A `ghost` button does not show being pointed at on a `SettingsCard`, which is the colour it
  turns: give a text one `ON_SETTINGS_CARD` and an icon alone `LIST_ACTION`. A row's buttons that
  show only while it is pointed at are in `CardAction`, which keeps their room, so that nothing
  beside them moves.

Approvals are the user's own, for every workspace: the defaults ("Permission defaults"), then
rules that always ask and rules that allow without asking (`ApprovalRules`), in that order of
precedence, which the groups' descriptions say. `useStandingApprovals` is kept, unused, for when a
workspace has settings of its own.

## Skills

A skill is instructions the assistant loads when a task calls for them, with the files they refer
to. The Workshop's API has none of the user's to read or write yet (they are the Context
Library's, `gatekeeper-context`, which has its own app), so `skills/SkillStore.ts` (plain, tested)
keeps them in memory for the visit, starting from examples (`exampleSkills.ts`). Its methods are the operations a backend would have: put it over one once there is
one, and take the examples out.

A skill's name and what it is for are kept twice: on the skill, as they are read, and in the
frontmatter of its `SKILL.md`, as the Agent Skills format has them (`name` in lowercase with
hyphens). A change to either is made to the other, whichever was changed. How uploaded files
become skills (`skillUpload.ts`, `skillName.ts`, `skillFiles.ts`) is ported from the Context
Library's app, tests and all, so that what is uploaded here reads as it does there: keep the two
alike. Text is kept as written and anything else as base64; hidden files (`.DS_Store`) are left
out.

The skills are listed in the settings' Skills part (`SkillLibrary`): one flat list on one
surface, whatever the order, in a `ScrollArea` once there are more than fit, with rows only and no
icon on them. What a skill is collected in is a tag on it, and whose it is is a picture, as a
workspace's members are where it is listed: the owner's, or the organization's mark. The organization's are left out until
the filter for them is on (`startsNarrowedTo`), and the filters are kept on this device
(`keepsFilters`). One is added by writing it or by uploading Markdown files or a folder.

A skill's page (`/skills/<id>`, `SkillPane`) keeps the settings' sidebar, and its header is the
way back to the list and then the skill. Its name and what it is for are edited where they are
(`EditableTitle`, `multiline` for the latter), by whoever's it is; the rest only read it. Under
them, a tab each (`?tab=`):

- Preview, which is the first: the start of each file as it reads, `SKILL.md` before the rest
  (`FilePreviewCard`), so that the skill can be read without opening anything.
- Files: the list of them by path, folders and all, under the list controls, with the way to
  upload more, or a folder, which goes in under its own name.
- A file that is opened (`?file=<path>`, from either) has a tab of its own after those
  (`Tabs`' `onClose`), with all of it as it reads (`SkillFileView`). Only Markdown is edited, in a
  plain editor (`FileEditor`) in place of how it reads, and kept on Save. The tab is put away by
  going to another, unless something typed in it has not been saved: it then stays, with a dot,
  and the way back to the list asks first.
- Settings: its tag, whether the assistant may use it on its own (coming soon), and deleting it.

## Automations

What runs by itself is a workspace's hooks (`listHooks()`): a scheduled task, which the scheduler
gatekeeper delivers, or something an event a service delivers sets off. They are listed, read only
but for each one's switch (`enableHook`/`disableHook`, for whoever may build there), on a tab of
the workspace's page and of a chat's settings page (`?tab=automations`), which the chat header's
clock opens with how many the chat has (`AutomationsTab`, `AutomationRow`): the scheduled first,
then the rest, each with when it runs and when next or why it stopped, what it does, what it
watches and the gadget it runs, which opens beside the page.

When a schedule runs is the scheduler's to say, from its management app
(`getGatekeeperApp('scheduler')`, whose `ui` lists the account's schedules), and it is matched to
its hook by the title, description and gadget it was enabled with (`automations/automations.ts`,
plain and tested): neither says which the other is. A hook does not say who delivers it either, so
one is a schedule by having one, or by the scheduler's resource (`scheduler://tasks`), which keeps
a paused one, which has no schedule, among the scheduled. Nor does it say which chat set it up: a
chat's are those its cards show, as far as its conversation has been loaded.

After the automations, the workspace's page lists the agents its gadgets call on, by their runs
among its chats (`spawnerName`), each opening its latest run. An agent that has not run is not
known, and nothing says what calls on it or what it thinks with, until the backend lists them.

## Lists

A list that is more than a few rows has the same controls over it (`ListToolbar`), on one line: a
search at the start, a round button that opens out over the room when clicked or tabbed to
(`SearchField`); then rows or cards, the order, the filters, and what the list offers to do, such
as New. Each is drawn only if given, so a list has the ones it has a use for. The Workspaces,
Library and Connections pages have them; use the same pieces for the next rather than building beside them, down
to a row's and a card's buttons (`RowAction`, `CardAction`, `StarButton`):

- A list that leaves something out until it is asked for says which filters are on to start
  with (`startsNarrowedTo`), and may keep the filters on this device as the order is kept
  (`keepsFilters`); otherwise filters are for the visit. A short bar with room to spare has its
  search open all along (`ListToolbar`'s `searchExpanded`).
- `components/listView.ts` (plain, tested) has what a list says of itself: its orders
  (`ListOrder`), its filters (`ListFilter`) and how a search and the filters narrow it. An order is
  also how the list is grouped: `arrange` gives the items in groups, by when (`groupByTime`), by
  name under letters (`groupByName`), or by anything else. It is told how few make a group in the
  view shown, as cards need fuller groups than rows. Filters of one `facet` are alternatives, and
  an item has to pass in every facet. A facet named in `facetMenus` has a menu of its own
  (`DropdownMenu.Submenu`) with a field to find one by (`OptionPicker`): for alternatives that are
  many, or that come and go, such as people.
- `hooks/useListView.ts` keeps how one list is looked at. Rows or cards and the order are kept on
  this device (`prefs/listView.ts`), under the list's name. A list is rows until the user chooses,
  unless it says it starts as cards (`startsAs`). The search and the filters last for the
  visit: a list that came back narrowed would seem to have lost things. It gives the controls
  `ListToolbar` draws, ready to spread.
- `GroupedList` draws the groups as rows, `CardGrid` as cards, each group under its label. Both
  take `onReorder` for a group whose order is the user's. The pane gives each a row or a card of
  its own block. Cards laid out along a line, as a row is, are `wide`: two to a line, and one
  where two would be too narrow.

On a narrow screen the controls are under the list, in reach of a thumb: the pane gives them to
`PageLayout` as its `footer`, which floats over the end of the content as a chat's composer does
(and, while it has one, keeps the window from being pulled along by a drag with nothing left to
scroll, which would take the footer with it; a chat is left its rubber band), and tells the toolbar (`at`), which gathers them in the middle, draws them `large` (44px, for a
thumb) and opens its menus upwards.

Another order or view is another list, faded to (`key` it by both) rather than moved to row by
row. The menus open in place, over their buttons. A primary button that opens a menu, such as a
New with several things to make, takes `caret`, and its surface starts in the button's colour.

`CardGrid`'s motion (`cardGridMotion.ts`, with its places from the pure, tested
`cardGridLayout.ts`) slides a card that has another place after a change, and fades one in that
arrives. A card of a group that can be reordered is dragged to any of the group's places, the
others making way, or moved with Alt and an arrow key: along its line, or to the line above or
below.

A workspace's page (`/workspace/<id>`) is laid out as a chat's settings page is: its icon and its
title, renamed where it is (`EditableTitle`) by whoever may build in it, then tabs (`?tab=`, kept
in place in the history): its chats, what it has made (the library's, as beside a chat, opening
beside the page), and its members, the owner first. Each tab loads what it lists once chosen.

A workspace's icon is a folder with its initials until the user gives it a look: one of the shapes
and colours in `components/workspaceLook.ts`. On its page the icon is a button, as its title is a
field (`WorkspaceIconPicker`): it opens a menu of the shapes and, under them, the colours
(`DropdownMenu.SwatchGroup`), which stays open beside the icon so that each choice is seen on it.
The backend keeps no look, so they are this device's (`workspaces/WorkspaceLooks.ts`, plain and
tested, held by `WorkspacesProvider`), for anyone who can open the workspace: they do not follow
the user to another browser, and should be the server's once the backend can say so. Whatever
draws a workspace's icon is given its look with its initials (`useWorkspaceLooks`), so that it is
the same in the sidebar, the lists, a header and a filter.

`WorkspaceIcon` draws a shape as layers, each rounded, with the letters on what looks like the
middle of the layer they are on: say where that is for a new shape (`label`), and size it to weigh
what the others do. The letters are on its lightest layer and what is behind that is darker, in
both themes and in every colour. `workspace-icons/` has each as an SVG, beside the folder's
`workspace.svg`.

Pages other than a chat (`PageLayout`) float their header over the content, unfilled, with the
content fading under it as a conversation's does (`.chat-fade`).

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

A workspace's page (`/workspace/<id>`) has the aside as a chat does (`?open=`): what its Library
tab lists opens beside it, as the workspace has it, with no chat's changes, and it is had back
from the edge the same way (not on a narrow screen, where the strip tapped for it would be over
the ends of the rows). What the workspace has made stays beside the page from one of its pages to
another (`carryAside`): from its own page to a chat or a new one, and back by the workspace's
crumb or the sidebar, so that the same output is in sight from one chat to the next. A file is its
chat's, and is left there.

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
the one shown is connected: going to another tab and back starts it over. Worktrees only say what
they are, for now.

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

## On a narrow screen

Narrower than `md` (`hooks/useNarrowScreen.ts`), such as a phone, there is room for one thing at
a time, and `_app` lays the frame out with `NarrowShell` instead of `AppShell`: edge to edge, with
no cards, clear of the system's safe areas. The pages are the same, home included. The sidebar is
beneath the page, on the backdrop. On the pages it goes to (home, a workspace, Library,
Workspaces and Connections), a button at the start of the header (which leaves it the room, `--header-lead`)
moves the page aside to the far edge, where what stays in sight of it is tapped to put the sidebar
away again, as is Escape. It is not swiped. Going anywhere puts it away: like full screen, it is
left behind with the page. A page further in goes up to one of those by its header: a chat, one
about to be and a chat's settings by the workspace's crumb, and an item's own page by its own way
up, to the chat it was shown from, the Library page it was opened from (`fromLibrary`), or else
its workspace's library. The workspace page's New chat is its icon alone. A field's text is 16px
at least there (`max-md:text-[16px]`, Kumo's `text-base` being 14px), or iOS zooms the page in
when it is focused: the composer and its measuring copies, and the sign-in form. Keep to it for
a new field.
Everything fully rounded is 44px there rather than 36px, for a thumb, from the `--control-*` sizes
in `styles.css`, and what a menu opened from one holds grows with it from the `--menu-*` sizes
(`DropdownMenu`, `OptionPicker`): 48px lines of 16px text, their icons, labels and the room at
their ends. Size anything new in a menu by them, not by Kumo's text sizes.
The composer's return key is labelled for sending (`enterkeyhint`), as Enter sends; the ✓ iOS
puts over its keyboard only puts the keyboard away, and nothing a page does makes it send. An
on-screen keyboard makes the page shorter on Android (`interactive-widget` in `index.html`), and
the app's frame is held to the page's height (`max-h-full` in `routes/__root.tsx`), which viewport
units alone take no account of, so
the composer sits above it. A phone reaching the dev server by its address has a page that is not
served securely, which has no `crypto.randomUUID()` and no clipboard: make ids some other way.
A named header bubble that carries on from one elsewhere along the header slides over from there.

What is beside a chat on a wider screen comes over all of it from the far edge, as the page moves
a little aside beneath it, and is had back by a tap at that edge, where a pill shows. It goes by a
back button at the start of its header. Neither is swiped: the system's own gestures at the
window's edges, such as Android's back, would take the swipe. Everything here that moves on its
own after a tap (the sidebar, the page, the aside) is the browser's own animation of `translate`
(`NarrowShell`'s `useSlide`), never a value moved from script each frame, which Chrome on Android
plays at 60 Hz once the finger has lifted, whatever the display's rate. Going to a chat does not bring
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
