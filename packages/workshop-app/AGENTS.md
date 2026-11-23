# Workshop App

The reworked Workshop frontend, built beside `workshop-frontend` (which stays the shipped app until
cutover). Scope is deliberately small: chat, chat settings, the Library, Workspaces, Automations
and Connections pages, the Settings page, and the pages of the user's gatekeepers' management apps.
Follow `../../AGENTS.md` and the `frontend-conventions` skill in addition to this file.

Dev server: `pnpm --filter @gadgets/workshop-app dev` (port 3001; the old frontend uses 3000).
`src/routeTree.gen.ts` is generated and committed, like the old app's; do not edit it.

The gallery (`/gallery`, and its whole pages at `/gallery/*`) and the scripted chats (`/mock/*`) are for development only, and a build
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
  chat/code/    A chat's code, live: its stream of changes and the edits made here (`ChatCode`)
  chat/mock/    A scripted fake backend for chats, played at `/mock/<scenario>`. Development only
  aside/        What is open beside the page (a file, an output), and the ways to open it
  library/      Everything the user's workspaces have made (`useLibrary`), and the Library page
  connections/  The services the user has connected and could connect (`useConnections`), the
                Connections page, and the window a service is signed in to in
  settings/     The Settings page (`SettingsPane`), a file for each of its parts, and what they
                read and write of the user's account
  gatekeeperApps/ The management apps of the user's gatekeepers (`useGatekeeperApps()`), the page
                one is shown on (`GatekeeperAppPane`) and what it may ask of the Workshop
  automations/  What runs by itself in a workspace (`useAutomations`), the tab that lists it
                (`AutomationsTab`) and the page of every workspace's (`AutomationsPane`); its agents (`WorkspaceAgents`), their tab (`AgentsTab`) and
                one agent's page (`AgentPane`)
  gadgets/      One gadget's settings page (`GadgetSettingsPane`): what it is bound to, its code,
                and what can be done to it
  notifications/ What is unread (`UnreadSummary`), the notices of the viewer's tasks
                (`TaskNotices`), and this browser's notifications (`browserPush.ts`)

  files/        What a file is, from its name and type; plain functions any layer may use
  prefs/        What is kept between visits: on this device (layout), and what follows the user
                from their account (`UserPreferences`); plain, any layer may use
  gallery/      The component gallery's previews, at `/gallery`. Development only
```

UI imports point down only: components and hooks, then blocks, then layouts, then routes. The data
folders (`rpc/`, `workspaces/`, `chat/`, `aside/`, `library/`, `connections/`, `settings/`, `gatekeeperApps/`, `automations/`, `gadgets/`, `notifications/`) are the only code that talks to the
backend: UI layers cannot import them, and they cannot import routes. `files/` and `prefs/` are
beneath everything and import neither UI nor data, and nothing that ships imports `gallery/`. Lint
enforces all of it (`vite.config.ts` at the repo root), by alias and by relative path alike. Blocks
and layouts take plain typed props and callbacks.

What the user last chose that should follow them (recent commands, what was last beside each page,
the file each export save made, their Library stars and what they opened last, the order of their
starred workspaces and each workspace's icon) is kept in their User DO, whose `UserPreferences` is
a map of strings the app owns: each field JSON under its own key, with the app's own bounds, read
defensively (`prefs/preferenceFields.ts`). It is live through
`rpc/UserPreferencesProvider.tsx` (the store is `prefs/UserPreferences.ts`, tested; the provider
talks to the backend, so it is in `rpc/`): `usePreferences()` to change it or read it in handlers,
`usePreferencesSnapshot()` for render. One store lasts across connections: what the account last
said stays shown until a new connection's subscription says again, a change still on its way over
the old one is dropped, and none is made while there is no connection. A field that names
workspaces or outputs keeps no more than its bound and passes over what is no longer listed when
read; the whole map stays well under the account's `MAX_PREFERENCES_SIZE`. Layout, list views,
theme and dismissed notices stay in `localStorage` as this device's.

Put protocol logic in plain classes and functions with no React (like `ChatSession`), so it can be
tested without rendering. `pnpm --filter @gadgets/workshop-app test:run` runs the tests. What only a
real browser runs (a frame's page and the port it hands over, for one) is in `*.browser.test.tsx`,
run in headless Chromium by `test:run:browser` (`vitest.browser.config.ts`) and left out of
`test:run`; the package's `test` task runs both.

Signing in is `RpcGate`'s. A signed-out user is shown the sign-in page (`SignInPane`, drawn by
`SignInForm`) in place of the page, at the address they were going to, so that signing in shows
them what they were going to. It offers what the deployment allows (`rpc/signInMethods.ts`, plain
and tested, from `getServerConfig()`), and nothing until that has been read: a password, a new
account where it takes them (in place, or at `/signup`, where the old app had it, which goes home
once signed in), and a button for each service that can be signed in with. A service is signed in
with in a window of its own (`GatekeeperSignIn`, plain and tested, ported from the old app's
`OAuthButtons`), which ends on `/connect/handoff` as a connect does, but confirms its ticket over
the public API, as it has no session (`SignInHandoffPane`); the page meanwhile asks its attempt for
the token. The token is kept under the old app's key (`token.ts`), so the two share a sign-in on one
origin. Where the server says the deployment is behind Cloudflare Access (`ServerConfig.authMode`),
it signs in as whoever Access says, never shows the page, and signs out of Access (`rpc/signOut.ts`).
The gallery has the page in each of its states
(`SignInPreview`).

A lost connection leaves the app as it is. Only the first connection has the page to itself;
after that `RpcGate` keeps rendering what it did, with `ApiSession.reconnecting` set, and signs in
again on the new connection, whose `api` replaces the old. Whatever holds stubs starts over on the
new `api` without dropping what it shows: the chats (`ChatSessions.reconnect`) and the gadget
beside the page read again over what is shown, and the lists load again with the old ones up
meanwhile. Nothing loads over the lost connection, which could only fail: what opens meanwhile
says it is loading until the new `api` is there.

`OutputsFeedProvider` and `WorkspaceSummariesProvider` keep one store across connections. They
stop the old subscription and start it on the new API, showing the last account snapshot until the
new snapshot arrives. `UserPreferencesProvider` does the same (see above).

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

Motion has three levels (`@gadgets/ui`'s `motion`): `full` (springs with some bounce), `calm` (the
same springs without the overshoot) and `off` (nothing moves). The person's choice in Settings wins
(`prefs/motion.ts`' `chosenMotionLevel`, given to `provideMotionLevel` in `main.tsx`); until they
choose, the system's reduce-motion setting gives `off`, else `full`. Never ask the
browser for `prefers-reduced-motion` or use `motion/react`'s `useReducedMotion`, which hear only of
the system: use `useReducedMotion()` (true when `off`), `isMotionOff()` outside React, and CSS under
`:root[data-motion='off']`. Springs go through `useMotionTransition(t)` or `motionTransition(t)` (a
`calm` spring has its bounce taken out, an `off` one takes no time); a curve by `motionCurve`; and a
bouncy flourish with no calm form (a shake, a recoil) is skipped unless `readMotionLevel() === 'full'`.
`MotionProvider` (in `main.tsx`) has `motion` elements without a transition of their own follow it too.
Tailwind's `motion-reduce:` and `motion-safe:` follow the level too (`styles.css`): `off` and not `off`.
Below `full` a `DropdownMenu` does not morph out of its trigger at all: the trigger stays as it is
and the menu fades in with a nudge of a few pixels (`DropdownMenu.css`), instantly at `off`.

Build UI by looking at the component gallery (`/gallery`) first: add each new component or block
there so its states can be reviewed in isolation. The gallery is a page at a time (`?page=`), listed
down its side by group (`PAGES` in `routes/gallery.tsx`, drawn by `gallery/GalleryShell`): put a new
`Section` on the page it belongs with, or give a new preview a page of its own there.

## First run, and what the deployment says

A new user is set up before anything else is read for them (`settings/OnboardingGate`, beneath
`RpcGate`, asked `isOnboardingCompleted()` once a user, and saying so with Try again where it cannot
ask, asking again on a new connection): in place of the app, laid out as the sign-in page is
(`OnboardingFrame`: one centred column, the way on in the middle of its foot on the first step,
then at its end with Back at its start; its top and foot stay put and only what is asked between
them scrolls, fading under each; a dot for each step, which goes to it, swelling on a spring when
pointed at; the mascot happy as a step opens, then idle, and happy again for as long as it cheers
each time it is clicked), who they are (as the profile settings start: the picture, kept as it is
chosen, over their name, renamed where it is), then what the app can use on their behalf
(`OnboardingServices`: each service to sign in to in a window of its own, a row as the Connections
page has, the ones most people use first, in the order `onboardingChoicesOf` gives, which a
connection does not change, in a surface that scrolls; and the tools the deployment adds as they
are, such as Web Search and Scheduled Tasks, each on unless switched off). Finishing keeps the name
if it changed (`setOwnDisplayName`), turns each tool on (`provisionAmbientAccount`) and then marks
it finished (`completeOnboarding`), and can be done again after a failure
(`settings/onboardingSteps.ts`, plain and tested); a tool that could not be turned on is said and
keeps nobody from going on. The connections step is left out once there is
nothing to offer. There is no model step, as the old wizard had: the model is chosen in the
settings, and until then the first of the user's models answers (`useDefaultModel`).

What the deployment puts around the app, signed in or not, is `rpc/SiteFrame`'s, outside
`RpcGate` on `_app` and `/signup`: its accent colour (`applyAccentColor`, shared with the old app)
and its logo in the tab (`rpc/siteLook.ts`), its banner across the top of the window
(`SiteBanner`, put away on this device until it says something else, `prefs/dismissedBanner.ts`),
and, over the foot of the window, that a newer version of the app is there (`UpdateNotice`),
which only the user reloads for: the build id the page was built with
(`import.meta.env.ASSETS_BUILD_ID`, `scripts/assets-build-id.ts`) against the one `VERSION_PATH`
answers as `assets` (`usePageUpdate`). The announcement is said under the sidebar's logo, which is
the deployment's own where it has one. A socket that outlived a deploy is made again
(`useStaleBackendReconnect`, `Connection.reconnect`): each socket is asked its backend's version
(`ServerConfig.backendVersion`), compared on each session check (shown again, back online, every
five minutes) with what `VERSION_PATH` answers, and a version is left behind once at most
(`rpc/staleSession.ts`, plain and tested), so that a rollout cannot loop it.

What goes wrong is reported as the old app reports it (`rpc/errorReporting.ts`, ported, with its
throttle tested), only in a build with `VITE_FRONTEND_ERROR_REPORTING=true`, which also gives the
build hidden source maps: installed in `main.tsx` before the connection opens, with the root's
uncaught errors and `ErrorBoundary` (`CrashNotice`), and the signed-in user as an unchecked label
(`setReportedUserId` in `RpcGate`). Follow `packages/error-reporting/AGENTS.md`: nothing secret in
an error, and nothing from a gadget's own code.

UI feature flags are `FeatureFlagsProvider`'s (`getUiFeatureFlags()`, read again on a new
connection): gate a part of the UI with `useUiFeatureFlag(name)`, which says `loading` and gives
the defaults until they are read.

## The chat feed

`chat/chatItems.ts` maps a chat's messages to rows, and `chat/ChatItemView.tsx` gives each row kind
its block. The mapping is pure and returns the same objects for messages that did not change, so
only changed rows render.

The conversation is what was said, so it reads like chatting with someone. How a reply came about
(the tools the agent called, what it read, what it thought) is never a row. While the agent works, the
mascot shows at the end of the conversation with what it is doing ("Floating ideas", "Running code":
words with no files or tools in them but for the code it runs, from `chat/statusWords.ts`, and no closing
"…"). The words are settled on rather than followed (`hooks/settler.ts`: shown once they have held still
for 600ms, and never held at one thing for longer than 1.8s while they keep changing). They shimmer, and
when they change the old fade out and, a moment after, the new fade in, with nothing moving
(`ShimmerSwitchText`). The mascot turns to typing dots while the reply is being written
(`AssistantPresence`'s `writing`, from `chat.activity === WRITING`). It is played with: a click spins its
sparkle, which does not swell brighter than white on an HDR screen here (`Mascot`'s `hdr`, on by default
elsewhere, off for this one, which is clicked to open the steps), and opens what is behind the status as the
status does, and puts it away.

What is behind the status is the steps taken since the last message (`WorkLog`), each a row (`ToolStep`) in
13px with no outline and no fill, run the width of the column, 40px tall and padded 6px. A row is one element
from its first moment to its last, so nothing in it is made again as it goes on. Its mark is in a 28px column
(the middle of it 20px in): Kumo's spinner while it is under way, the icon of what it did once it is done
(Hugeicons, from `components/HugeIcon.tsx`), which grows out (`mark-grows`, a little overshoot) only once the
mascot has moved on from the row (`LeavingSlot` watches how far it is, 24px being clear), until when its
place is bare. The words are in the full colour while it is under way and go to the quiet one when it is
done, as an animation (`row-quiets`) rather than a transition, so that what a row takes when it is pointed at
is at once: its icon, words and caret go to the full colour, the same for all of them. A failed step has an
"Error" badge. When the words change the old fade out and the new in (`ShimmerSwitchText`), even after the
step is done, as the server words it afresh then. A new row (not one there when the log was shown) opens to
its height as it fades in (`row-enter`, which clears `min-height` too, and which a row that takes the place of
the bare row between steps does not do, or the height would dip), and its words wait for the mascot to be
there (`MascotSlot`'s `holdUntilArrived`). A row that opens gains its caret by fading it in, and what it did
shows in the words' column with a line of 1px down the middle of the marks' column; what streams in has its
room ease to it (`SmoothHeight`). The reply as it is drafted (the "Writing…" step) is not drawn as the message
will be: quiet grey 13px text behind a rule at its side, with no bubble. Nothing opens by itself; opening the
step under way means to follow it (`WorkLog`'s `follow`, held by `ChatPane` until the agent is done):
whichever step is under way is open, and the next opens in its place, until that one is closed by hand.

The mascot is the last row of the steps while they are open: the mark of the step under way, or a row of its
own when none is (`WorkLog` finds the place through `PresenceSlotContext`). It is one element, carried to each
place by `useFlight` on a critically damped spring, eased into so that a long way is not a kick, that carries
on from its speed when sent elsewhere. What the spring settles is how far the mascot is from the row, so that
what moves the row while it is there, such as a step above it opening, moves it too, in the same frame. Where
it goes is what the slot has settled on (`SLOT_SETTLE`): steps that come faster are not each gone to, and the
step it left is where it was last seen. The mascot is 32px, shrinks to 80% among the steps (the `scale`
property), and is carried with `translate`, not `transform`, so that the scale is not multiplied into how far
it is moved. Out to the steps and home again it is on a quicker spring (`brisk`, until it is there), as the
steps open and close in 420ms (`.presence-panel`, the status line's room shutting and opening as they do), so
it is where it is going as they have. The words beside it, on the line it is on while the steps are closed, are
gone the moment they open and, as they close, wait for the mascot to be there before they fade in
(`.presence-label`, told by `useFlight`'s `onArrive`); they are 10px from it. The steps are put away by the
mascot (there is no button), and focus that was on the words goes to it.

A reply becomes a message only once it is written. Its steps then go with it (`AssistantItem.trace`), out of the
conversation but there for whoever asks. How it came about is shown above the message, as the history that led
up to it, the steps as the indicator draws them (`thinkingOf`, `MessageBubble`'s `trace`, as wide as the
conversation), shown by a brain button among the message's actions (`thinking`; it opens as set by Always show
thinking, below). What there is to know about the message (`messageInfo`: the model, the time, in developer
mode how long it took) is a bubble of its own under it, shown by a click on the message, as in other messaging
apps, and in more as Show details (a link, a button, a view or a selection in the message is not a click for
that, and a click anywhere else puts it away). The two are independent, each with its own open state
(`DisclosureStore` keys `item.key` and `item.key:thinking`), and neither opens by itself when a reply arrives.
The panel is `text-sm/5` lines with `size-4` icons, only the time for the viewer's own messages; every chevron,
here and on anything else that opens, is `size-3` and bold. It arrives whole, the way a message does, and
putting it away takes two steps (`useDetailsStage`): it folds to its first line the way a step closes, and the
line then leaves. Its heights are grid rows, never measured, so closing cannot make the scroll position jump. It
joins the message's bubble run with the same 2px spacing and meeting corners, and the message does not tuck into
the one above while its trace is between them. The trace opens and closes on the same stages, with its padding
inside what is clipped, so that nothing is there that goes at the end, and keeps the reader's place as it does
(`MessageScroll.keepPlace`): at the end of the conversation that follows it, and elsewhere, if what it moves is
what the reader can see or is beyond, the view goes with it, so that the message stays where it was looked at.
The mascot's room is always kept, so its coming and going moves nothing.

A turn is everything from one prompt to the next. What a turn produced (an output, a hook) or is
waiting on the user for (a pending approval or connection request) is shown at the end of the turn,
never where it happened, so it cannot be left behind by what the agent wrote afterwards. The last
turn's are kept apart (`pinned`) and rendered under the conversation. Once the user has answered a
request it is history and stays where it was answered: below what had been written by then, above
what came after, never moved back up among earlier messages. An action a standing rule approved
was decided as it was made, and is shown there the same way. What a person then did to the chat's
changes (kept, discarded, brought in) follows the artefacts, as a divider; edits alone are not
marked, as the server writes them into a message whenever it needs to, and what waits to be kept
says them. Keep these rules
when adding a kind.

Nothing a chat changes is kept until someone keeps it. Until then its changes are only beside
that chat (see Beside the page): a gadget's own page, the library and everyone else have it as it
was kept. Once its turn ends, or when it is opened with changes waiting, the end of the
conversation asks (`KeepChangesCard`, from `ChatSession`'s `keep`, a moment after the turn so that
what it last changed is in), folded to its question ("Keep changes to Tip Jar?", or how many apps)
with Discard and Keep, which are for everything at once, as a chat's changes are only kept or
discarded whole (`mergeChanges`, `revertChanges`), under all it opens to and halving its width
where they have no room beside the question; whoever asked knows what they asked for. The question,
or a click anywhere on the card but its buttons, opens it, as a row does (`DisclosureStore`, each
ask afresh, folded), to what to know first, which describes Keep folded too, where there is something (conflicts, a connection given, an update brought in;
nothing for code alone), each app they change with its format's icon and how many of its files
(`chat/proposedChanges.ts`, read back to the last keep however far that is, and again as more is
written, plain and tested), opened beside the chat from its row, and what else they make, give and
bring in (`chat/keepChanges.ts`, plain and tested), each gadget named and drawn as the workspace
has it (`useGadgetTitles`) where the conversation does not. Keep waits while edits typed beside the
chat are on their way (`KeepAsk.sending`), as it would leave them out, and brings in what was kept
elsewhere first where that has moved on, unless that leaves conflicts. Each keep is marked in the
conversation, as a discard is, naming what it kept where the conversation made it ("You kept
changes to “Tip Jar”", or how many apps).

A message sent while the agent works ends the conversation, dimmed, until the agent reads it. It
is the same row before and after, so being read only brings it to full strength. Its key is its
place among its turn's steers rather than its sequence, which it has only once read, and
`ChatSession` keeps it between leaving the queue and arriving as a message.

A message can be replied to. A reply names its message by sequence (`replyToSequence` on
`sendChatMessage` and the message, kept through steering), and since the agent is not shown what a
reply names, it also carries a line of that message at the front of its own text, as a Markdown
blockquote (`chat/replyQuote.ts`): the agent reads it as anyone would, and a client that knows
nothing of replies shows a quote. The composer shows that line above the draft while it is a
reply, over any attachments, and the feed sets it apart from what was written when it draws a
message that names what it replies to; one that names nothing, such as a reply from before replies
were recorded, is shown as it was written, linked to nothing. A message the agent has not read
has no sequence yet, so it offers no reply. Either line goes to the message it quotes when clicked
(`MessageList`'s `scrollToMessage`): by scrolling when the message's row is mounted, and by fading
the conversation over to it when the way there runs over a page that is only a spacer. A sent
reply's message, when it is further back than has been loaded, is reached by fetching the history
back to its sequence in as few reads as the workspace allows (`ChatSession.findReplied`).

What the agent writes can say anything, so `Markdown` renders no HTML, links only web and mail
addresses, and links an image from elsewhere instead of loading it, which would tell whoever is
there what was read (one carried in the text, `data:` or `blob:`, is shown). Every link the app
draws passes `components/webUrl.ts`, so none can be `javascript:`.

What the agent writes between `<inline-html>` tags is a live view (`plans/live-views.md`), taken
out of its prose by the shared parser (`chat/answerParts.ts`, plain and tested) and drawn in place
as a bubble of its own in the message's run (`MessageBubble`'s `view`, `InlineView`): run in a
frame sandboxed with no origin, under the gadget UI's CSP (`components/sandboxPage.ts`), with the
theme's tokens, as tall as it draws, its module scripts run once written in full
(`blocks/inlineViewFrame.ts`, ported from main's `uiBlockFrame`). What it asks to send
(`agent.send()`) waits under it, and goes through the chat's own send only on Send. While the
reply is drafted its views are only named (`InlineViewDraft`); a block the agent never closed is
shown as code. The `live-view` scenario plays one.

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

What is under way at the end of the conversation (the live output: the thinking indicator's rows coming
in and opening, cards arriving) is followed in step with it: a resize observer on the live output puts
the view at the end in the same frame (`followNow`, for a reader who is at the end), where the
library's eased catching-up would trail the change and the end would sway. So everything that changes
its height has to ease, never jump (a row opening from nothing, `row-enter`, which has to clear `min-height` too,
and the bare row the mascot has between steps opening as the others do), and a row that takes the place
of another is not opened from nothing again, or the conversation's height would dip and the view with it.

A draft is only let go of once its message has gone: `Composer`'s `onSend` resolves to whether it
did, and until then the draft, its files and what it replies to stay, dimmed and unsendable. One
that did not go stays as it was, under why.

A turn the free requests ran out for (an error with the code `usage_limit`) ends on a row that
offers Continue rather than Retry, and the way on opens by itself, once for each time they ran
out, as the old app's did (`OutOfCredits`, drawn by `OutOfCreditsDialog`, which Continue opens
again): connect a Cloudflare account to bill, then choose which of its accounts where it has
several, then add credits to it, in the old app's words, with when the free requests are back
counting down (`settings/credits.ts`, plain and tested). It is mounted only while open, and reads
the usage as it opens and each time the window is come back to (`useUsage`), as each step is
taken in another window. It does not run the turn again: the next message does. The
`out-of-credits` scenario plays every step, its connection made at once.

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

Every new chat starts on the home page (`/`, which the sidebar's logo goes to, `NewChatPane`):
until its first message is sent it greets the user over the composer in the middle of the page
(`ChatStart`, in a `StartLayout`), and is then drawn as the conversation it becomes, which is
created by that first message. Under the composer, in its middle, is where the chat starts
(`WorkspacePicker`): a new workspace until one of the user's is chosen, with its icon, from a menu
that opens in place with a field to find one by. The menu is a `DropdownMenu` that holds an
`OptionPicker` (`picker`) of which one is chosen (`single`), and choosing closes it. It offers the
workspaces the user may chat in, not those they can only use. Once the list is read with none of
those in it, the picker is left out, as a new workspace is all there is; while it is still being
read the picker shows, so that it does not pop in for whoever has some.

The workspace chosen is the address's (`/?workspace=<id>`), so a new chat in a workspace is home
with it chosen: a workspace's page has a New chat button at the end of the Chats tab's controls
that goes there, as do a gadget's Chat menu and search. Choosing another replaces it in place, so
the draft stays and going back does not step through each choice. One that is not listed, or only
used, is not chosen; until the list is read the one named is taken at its word, so that a message
sent meanwhile goes there. With a workspace chosen the page has what one of its chats has: the
workspace's crumb in its header, what is shown beside it (`?open=`, dropped as another is chosen,
since it was the other's), and the workspace marked in the sidebar; the chat then takes the empty
one's place in the history. The old `/workspace/<id>/new` redirects there, for links made before.

The composer's + menu (`ComposerAddMenu`) is Upload and Add a new connection, then the commands,
the ones chosen last first (`recentCommands` in the user's preferences, `prefs/recentCommands.ts`, as a slash's matches are),
under a field to find one by on the edge nearest the composer (`composerAddEntries.ts`, plain and
tested): typing narrows it as a slash does and leaves the two actions out. It opens at the size it
keeps: a workspace's commands are kept for the visit (`useChatCommands`), and until they are known the
room they take says it is loading. On the home page, with no workspace chosen, the first slash or
opening of the + menu, or the first connection added before the chat exists, makes the workspace the
chat will start in (`ensureWorkspace` in `routes/_app/index.tsx`, as main's
`ensureProvisionalGadget`), whose commands are then listed and which is then where it starts unless
another is chosen. Opening the page alone makes none. A connection added keeps how it was made (an
account and resource, or a model: `ConnectionSource`), and one made in another workspace than the
one the chat starts in is made again there as it is sent (`startConversation`), so the chat is given
its own.

A chat's notifications, read state and deletion are in its settings (`ChatOptionsTab`), for whoever
may build in the workspace: someone who can only use it has no chats of it. Its row in the
workspace's Chats tab has no menu of its own, only a dot while it has anything unread. A chat's
notifications are turned on or muted for the viewer as the old app's menu did
(`chat/ChatNotifications.ts`, plain and tested): what the workspace says of each chat comes from the
viewer's read state scoped to it (`subscribeToUnreadState()`), and a chat it says nothing of goes by
the default, which is off only in one that waits for the viewer to take part
(`notificationsRequireParticipation`). A change shows at once and is put back if refused. Deleting a
chat is asked first. One that is open says so when it is deleted (`ChatSession`'s `deleted`, whoever deleted it), and the page
goes to its workspace in its place in the history. The Chats tab's list is live (`useWorkspaceChats`
over `workspaces/WorkspaceChats.ts`, plain and tested): people's chats are read once
(`listChats({ kind: 'chats' })`, after subscribing) and kept up from `subscribeToChat()`, so a new
chat shows, a title or cost changes as it does and one someone else deletes goes; agents' runs
never come in (`isAgentRun()`). When the workspace restarts it is opened and read again a moment
later, as `AgentRunList` does, what was shown staying up meanwhile; stopping, as on a lost
connection, cancels that. The workspace page reads it once for the tab and for what it counts
as waiting there: a chat stopped on a decision, or with an action waiting (`WorkspaceAgents`'
`actionsWaiting`).

## Unread, and being told

What is unread is the account's (`notifications/UnreadSummary.ts`, plain and tested, over
`subscribeToUnreadState('summary')`): a workspace with anything unread has a dot (`UnreadDot`) in
the sidebar and on the Workspaces page, which can be narrowed to them (Unread) and has Mark all
read beside New, and each workspace's ⋯ marks it read. A chat's own count comes with its
notifications row (`ChatNotifications`), as a dot on its row, and its ⋯ marks it read or unread.
Only for whoever may build in the workspace: `markChatRead()` and `viewChat()` are refused to
someone who can only use it. While a chat is on screen `ChatSession.view()` holds `viewChat()`,
and each message that arrives while the tab is in view is marked read (`markRead()`); coming back
to the chat reads it, even if it was marked unread meanwhile.

The account tells an open tab in view of the viewer's tasks (`notifications/TaskNotices.ts`, plain
and tested): the island at the top says a task is done or needs their approval, with Open to its
chat, unless that chat is on screen, and is put away after a while. A tab out of view is not
subscribed, so the account pushes it to the user's devices instead: this browser's, once turned on
in the Notification settings (`notifications/browserPush.ts`, the old app's, sharing its service
worker `public/sw.js` and its subscription). Its links are the old app's
(`/workspace/<id>?chat=<n>`), which the workspace's route sends on to the chat. The workspace's
mute and each chat's setting are the backend's to apply.

The user's workspaces come from their account as they change (`WorkspacesProvider`, over
`subscribeToWorkspaces()`, kept by `workspaces/WorkspacesFeed.ts`, plain and tested): renamed,
starred, muted, removed, or their role changed, by them or by whoever owns a workspace shared with
them. What the list does is shown at once and undone if the account refuses. Each workspace's icon
and the order of the starred are the user's own, kept in their preferences and seen by no one
else. A workspace's sharing rules follow `subscribeToMetadata()` while it or one of its chats is
open (`workspaces/LiveWorkspace.ts`, plain and tested), and the open workspace tells the list only
what it doesn't keep: its data restrictions, who may invite, and its cost (`useLiveWorkspace`,
through `useUpdateWorkspace()`).

## The Workspaces page

A workspace is listed only to whoever is in it (`joinedWorkspaces`, in `workspaceList.ts`): the
server lists one an app of was shared with the viewer to use (`role === 'use'`) from the time they
open it, but they were not let into it, so the sidebar, this page and search leave it out, and the
app is in their Library. Its address shows, in the page's place beside the sidebar, that it is not
theirs (`SharedAppPane`), with the way to the app, or a menu of them, else the Library, reading
nothing of the workspace.

`/workspaces` (the sidebar's folder button) lists every workspace: the pinned ones first, then the
rest by when they were last active, grouped as the chat settings page groups its files. A workspace
is pinned, never starred (a pin, `StarButton`'s `pin`), as pinning is what puts it in the sidebar:
the server's `pinned`. The pinned ones' order is the user's preferences' (`starredWorkspaces`,
kept and read by `workspaces/starredOrder.ts`), which the sidebar follows too: one pinned that the
order does not have comes first, so the latest pinned is first until they are dragged, or moved
with Alt and an arrow key, and pinning one takes it out of the order. A reorder writes the whole
order, which drops what is no longer pinned. The code still says `starred` for them (the filter's
id, `orderStarred`); the words are Pin and Pinned.

Over the list are its controls (see Lists, below): `workspaces/workspaceList.ts` says how it can be
ordered (last active, date created, name), narrowed (starred, whose it is) and
searched. The starred stay first in every order, and are only reordered while nothing narrows
them, as putting some of them in order would lose the others' places. Its New button starts a chat
on the home page, which is what makes a workspace.

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
on a narrow screen the controls are under the list): Recent, All, and one for each type something
has been made as, once there is more than one. Recent is what waits on the user (the "N waiting"
its row and card say), under Needs you, most waiting first, then what they opened last (the
user's `opened` in the outputs feed, recorded through it where `AsidePane` shows a gadget,
whichever page it is opened from; `library/libraryRecent.ts`, plain and tested), the twelve latest.
It starts at Recent for whoever has opened anything, and at All otherwise. Every tab is the same list under the
same controls, of what the tab has, so the types are tabs rather than filters, and the filter menu
has the rest, Starred among them. On every tab but Recent, what waits on the user comes first, then
the starred, in their order, which is dragged on All while nothing narrows them and none of them
waits, then the rest in the order chosen. `LibraryPane` reads what the page shows and
`LibraryView` draws it from plain props, which is what the gallery renders over fake outputs.

Each row and card has a more menu (`LibraryMoreMenu`), slid out beside its star as a workspace's
row has one, and left out on a narrow screen, where the output's own page has the same: Open, Open
in new tab and Copy link, then for whoever builds in its workspace (`library/libraryEdits.ts`'s
`mayChange`, plain and tested: the workspace list's role where it is listed, else the role the
library kept, which a shared one must say) Rename, typed where the title is (`EditableTitle`'s
`autoFocus`), Invite user… (`ShareWorkspaceDialog` for the gadget, as the pane's), App settings,
Create template…, and Delete…, asked first (`DeleteGadgetDialog`). Docs and sheets are gadgets too, and have the same.
A rename and a deletion go through the gadget (`gadgets/gadgetChanges.ts`: `getGadget()` pipelined
on `openWorkspace()`, both let go of after) and show at once, over the library as it was read
(`libraryEdits`): a renamed one under its new title while it still reads as the old, put back if it
was refused, and a deleted one gone, with its star. The gadget pane renames and deletes from its
settings page (see A gadget's settings), only for whoever may. The scripted chats' fake workspace
renames and deletes its gadget, for trying the pane without a backend.

The header ends in Explore templates (Explore, on a narrow screen) and New, whose menu ends in the templates too. The templates
(`/library/templates`, `TemplateStoreView`) are what the backend calls blueprints, the way a store
lists apps, with Create template at the header's end (`CreateTemplateMenu`: whatever the user may
change, `templatable`, under a field to find one by; choosing one goes on as Create template…
does). A template is made from any gadget but a worktree, as the old app's Publish as blueprint…
was, and making one is publishing it: `GadgetClient.createBlueprint()` stores and propagates it in
one step, so there is no draft, and "publish" is not said anywhere. A gadget has one from its
Share menu (Create template, under Invite user), its settings, and its row's More menu, Create
template… (`CreateTemplate` over `CreateTemplateDialog`): a title and what it is for. There is one
template to an app: a gadget that has made one opens the dialog at it instead (account feed for
the owner, `Overseer.listBlueprints()` on demand for other builders), with Release update, which
releases what the gadget has kept since as its next version (`updateBlueprint` with `updateCode`),
or Update connections where only its bindings changed (`updateBindings`, the same version),
and no way to make another. Only the gadget's own templates count (each names its `gadgetId`; an
owner's not yet backfilled one counts once the workspace is next opened); there is no step for a screenshot. And a banner of the organization's
own over everything else (`PromoCarousel`, in the workspace colours, moving on by itself while it
is not pointed at or focused, and not with reduced motion): a tab each (`?tab=`) for its front (Discover: the latest created two
to a line, then some of each kind they make, each a `Shelf` with the way to the rest), for all of
them, and for each kind, then a search and the filters (`library/templateList.ts`, plain and
tested: starred, needing nothing connected, and the services they work with). A search or a
filter lists what it leaves in place of the front. Its entries are `TemplateListing`s, which have
no button of their own: a template is used from its page. Each ends in who it is by (their
picture, or the organization's mark) and the services it needs connected as a stack of their
logos (`TemplateByline`, `ServiceStack`).

A template's own page (`/library/templates/<id>`, `TemplatePageView`) is laid out as a store's
page for an app: what it makes on a tile beside its title, Use template and its star, what there
is to know at a glance (`FactStrip`), a picture of what it makes (`TemplatePreview`, sketched by
kind from Kumo's tokens until its creator gives a screenshot), what it is for, the services it
needs connected in place of an app's privacy (`ConnectionNeeds`), the facts at length, and others
of its kind. A template the user made, from a workspace that is still there (`Template.source`), ends
in Your template, the same rows as its gadget's settings have, and goes back to the templates once
deleted. A section's title is a group of settings' (`text-lg`).

The templates are the deployment's featured blueprints (`listFeaturedBlueprints()`), which are the
organization's own, then the user's saved and uploaded ones (`listLibraryBlueprints()`), then those
they created (`subscribeToOwnBlueprints()`, whole and live from their account, which says as each is created, released, edited or deleted and as its gadget keeps changes), once each
(`templatesOf`, plain and tested), held by `TemplateStore` so that the store and a template's page
show the same. A template's services are named as the deployment's vendors name them. Its stars are
the backend's `pinned` (`setBlueprintPinned()`, which saves one to the library first), shown at once
and put back if refused. Every ranking of them is the latest created first: the banner's, the
organization's own first; the front's and each kind's; and a template's page's others of its kind.
A template whose link was shared, which is not listed, is read on its own (`getBlueprint()`). Use
template (`UseTemplate`, `UseTemplateDialog`) sets up each binding with the user's own (a
connection in its service's form, `ConnectResource`; a model, starting as its creator suggested,
`library/templateSetup.ts`), then makes it in a new workspace named after it
(`newWorkspaceFromBlueprint()`) and shows what it made.
Making one in a workspace the user has is for the backend to offer. Keep `/blueprint/<id>` public
for share links, and do not call starring one "Add to library", which lists outputs.

The types are what the old Outputs page had: apps (an output made as no format), then the formats
the deployment offers (`listOutputFormats()`, `useOutputFormats`), in its order and whether or not
anything has been made as one, then whatever else is in the library, such as a format no longer
offered.

The library (everything the user's workspaces have made) comes from one live subscription,
`OutputsFeedProvider` (`subscribeToOutputs()`, kept by `library/OutputsFeed.ts`, plain and tested);
read it with `useLibrary()`, and never call `listOutputs()` from the app. Stars, their order and
what was opened last are the user's own, kept in their preferences (`starredOutputs`,
`openedOutputs`), with the rules in `library/libraryStars.ts` (`keepStars`) and
`library/libraryRecent.ts` (`recordOpened`, from the aside): shown at once, and given way to if
refused, as any preference is. A star for an output that is not listed is kept: it may only not
have been read yet, as while the index catches up; past the bound the last star goes.

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
the accounts connected, then what could be connected (Available), each a group of its own however
few it has. Services have no categories: a service says nothing of any itself, and the Workshop
names none, so they would have to be the gatekeeper's to say (`VendorDescription`) before they
could be listed by. The filters are where a connection stands. The search finds one by its
service's name, what that says of itself, what it gives access to, and whose account it is.

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

Which one of a service's resources is chosen in the service's own form, a gatekeeper's resource
configurator, in `SetUpConnectionDialog` (a `Dialog` that is `wide`): `ResourceConfiguratorFrame`,
a frame sandboxed with no origin. It is fixed to the window over the room kept for it and cut to
what scrolls it (`connections/framePlacement.ts`, plain and tested), so that a menu in the form
draws past the dialog as a select's would rather than being cut off, or scrolled to. So nothing it
is in may be transformed while it shows: `Dialog` is centred by its margins, not translated. It
never scrolls within itself, says it is opening until its form is drawn, which is kept out of sight
until then in about the room a form takes, and its room then takes the form's height at once, as
the dialog glides to it. The form's fields line up with the dialog's own.

A dialog's height glides to what it holds as that changes (`components/surfaceGlide.ts`, its step
plain and tested): a burst of changes is one glide to the latest, taken over from where the last
had got to, on the clock its pages keep, and at once with reduced motion. While it glides the
surface is given its height, so the part that scrolls is shorter until it is tall enough and the
foot stays at the surface's: give that part `grow` too, so that it is the part that gives up or
takes up room. What is still coming keeps about the room it will take (`SetUpConnectionDialog`'s
accounts, a configurator's form), so that the dialog does not shrink to a line on its way to it.

A dialog that goes on to another, such as adding a connection (`AddConnection`: what kind, then
the service's form, and Back), is one `Dialog` with pages (`page`, a key and how deep it is) rather
than one put away for another, which would flicker the backdrop and fade one surface over the
other. The surface stays and takes the new page's width about its middle, and glides to its
height, while the leaving page fades as it slides a little toward where it goes, the new
one comes from the other side a moment behind it, on one clock that eases out with no overshoot
(`components/dialogPageMotion.ts`, plain and tested), and only fades with reduced motion. Nothing is
transformed, so a configurator's frame goes along, cut to the surface. A `Dialog` within a page is
that page (`AddConnectionDialog`, `SetUpConnectionDialog` unchanged), and its `onOpenChange` puts
the whole away. Focus goes into the new page. Use pages for the next dialog that goes on to another.

`Banner` is the app's own, drawn from Kumo's colours: a rounded surface in the colour of what went
wrong, with its icon and its action on the title's line, the action a button of the app's shape
a shade deeper than the banner. A surface in a dialog, the banner or a list, is a step less round than
the dialog (`--surface-radius`, which `Dialog` sets). `Button`'s `danger`
is `secondary` in that colour, for what cannot be taken back. Switches are the app's own
`Switch`, fully round as the buttons are, in Kumo's blue with a thumb that is white in either
theme: Kumo's is a squircle whose thumb cannot be reshaped from outside. Use it for any new one.

Search has an entry for each connection as this page lists them
(`connections/connectionEntries.tsx`, plain and tested), from the list the sidebar has already
read: "Connections › Google", the accounts first, then the services not yet connected, each saying
at its end Connected, Needs sign-in or Not connected, and doing the one thing in one step. A
service with an account is listed as that account (the accounts of one service are told apart by
whose they are), since its dialog is also where another is added. Each is found by the service's
name, what it is for, whose the account is and the word for what choosing it does ("manage" on an
account, "add" on a service), so "manage" lists what is connected and "add google" finds Google
only while it is not. Choosing one goes to `/connections?open=<connection key>`, which shows that
connection's dialog (Manage for an account, Connect for a service) once the list is complete
(`useConnections`' `complete`, as what is added as it is comes in a request of its own) and forgets
the address, in place. Nothing is connected or changed from search itself, as what is given access
to is chosen in the dialog.

A service is signed in to in a window of its own (`connections/connectHandoff.ts`, plain and
tested, ported from the old app without the native app's path; see `docs/connect-handoff.md`). The
window is opened empty, disowned and given the flow's nonce before it is sent to the service, and
ends on `/connect/handoff` (`ConnectHandoffPane`, outside the app's frame), which redeems its
ticket with the nonce over its own session. Redeeming is what connects the account, which then
shows on the page through `subscribeConnectedAccounts()`. The flow ends on the deployment's public
address, so in development it only finishes when that is this app's.

## The Settings page

`/settings` (Settings in the menu the user's own button in the sidebar opens, which also has Sign
out, done at once) is one route, with `?section=` naming the part
that is showing (`settings/settingsSections.ts` has them, in order, with their names and icons).
The user's own parts are one list with no heading over it (`SETTINGS_GROUP`: Profile, Preferences,
Notifications, Models, Usage & billing), and an admin's come after it under Admin.
Where there is room for a sidebar, the parts are listed there in place of the app's own
(`SettingsSidebar`, which `_app.tsx` swaps in for as long as the page is a settings one), and
choosing one replaces the address, so that going back leaves the settings rather than going
through their parts. On a narrow screen the list of the parts is the page (`SettingsMenu`), and a
part is gone into from it. The settings' own sidebar leaves them again: back to where they were
opened from (`settingsOpenedHere`), or home.

A part is a file in `settings/` (`ProfileSettings`, `ModelSettings`, …) made of the same blocks:

- `SettingsGroup` is settings that belong together under a title, on one surface (`SettingsCard`)
  or, `plain`, on the few it gives itself. A group's title is said once in all of the settings:
  do not give two groups the same one. A description under the title is for a group whose rows
  are not settings, such as a list.
- `SettingRow` is one setting: what it is, and what it is set by, in a column of one width down
  the group. `SettingField` and `SettingPresets` are rows that are a line of text, kept on Enter or
  on leaving the field (`useEditedField`).
- Only what works is shown. A setting the backend cannot keep yet has no row, placeholder or
  "Coming soon": add it once it is there, to the part it belongs to.
- A `ghost` button does not show being pointed at on a `SettingsCard`, which is the colour it
  turns: give a text one `ON_SETTINGS_CARD` and an icon alone `LIST_ACTION`. A row's buttons that
  show only while it is pointed at are in `CardAction`, which keeps their room, so that nothing
  beside them moves.

### Settings from search

⌘K (`routes/-AppSearch.tsx`, over the `SearchDialog` block) is a control panel as well as a way to
go to places: the settings that are there can be changed from it. A setting that is a switch, a
choice or a line of text is defined once (`settings/settingDefinition.ts`: its title, description,
part of the page, current value and `set`), by a hook or a plain function in `settings/`
(`usePreferenceSettings`, `useProfileSettings`, `modelChoiceSettings`). The page draws its own row
for it (`SettingDefinitionRow`, or `SettingField` for text) and search its own entry
(`settings/search/settingEntry.tsx`), so the two cannot differ. Anything that is not one of those three kinds (a form, a dialog, a list, an
action) is an entry of its own in `settings/search/`, or a way into its part of the page
(`sectionEntries`). Search offers none of the admin parts, which hold a capability that audits
what is done with it. One that is refused says why under the field. An on/off setting shows as a
switch at the end of its row (`SearchEntry.on`, drawn by `components/SwitchIndicator`, which shares
its look with `Switch` through `switchStyle.ts`), which choosing the row flips; the switch has
nothing to press of its own, as a listbox option holds no control, and the state is said in words to
whatever reads it.

Nothing is read from the server for search until it is opened (`useModelSettings(enabled)`,
`useUsage(enabled)`, and the library below), and what was read is kept while it is shut. A choice
whose options are still being read (`ChoiceSetting.unavailable`: the models) is listed all the
same, so the default model is there from the first frame with its value filled in a moment later,
and says so if it is chosen before then. What is typed carries on into a page it still narrows
(`carriedInto`: found by "dark", the theme goes on to Dark alone), and starts over where it would
leave nothing.

Before anything is typed it offers, in this order, with no heading over the first: a new chat, and
what else is done where the user is (`routes/-appSearchSuggestions.ts`, plain and tested); three
recent workspaces; Workspaces, Library and Automations, which the sidebar also has, and each of the
user's gatekeeper apps (`useGatekeeperApps()`, under Go to, as the sidebar has them too); and a few
settings reached for under one Settings heading: the default model, the theme, the animations, and
the way to Settings itself. The first is a new chat of its own, which starts a workspace, and is not
offered on the page that starts one (home, in a workspace or not). In a workspace's chat it is a
new chat in that workspace with the default model, and on the workspace's page a new chat in it and
inviting people (`workspaces/workspaceActionEntries.tsx`, plain and tested, each saying the
workspace at its end): the model leaves the settings for the chat, and each only where the viewer
may (`shareStanding`). Inviting asks the page for its own dialog (`?invite`, which
`WorkspacePane` answers once the workspace is listed and the address then forgets), as the
Connections page is asked for a dialog (`?open`). The settings come from
`useSettingsSearchEntries`' `suggested`, built from the same definitions, and are listed under that
one heading in place of their part of the settings, the Settings page with them though it is found
under Go to. The other pages are found by typing. The results scroll within a height of their own
(`SearchDialog`: 30rem, or 60% of the window if less), the marked row kept in sight by the arrow
keys.

Everything the user has made is found by typing, under Library (`library/libraryEntries.tsx`, plain
and tested): one entry for each output of every workspace, with its workspace at its end, found by
its title and its kind, opening its own page. None is offered before anything is typed. It is the
app's one library feed (`useLibrary()`), so a search before it has first been read that finds
nothing says "Looking…" (`SearchDialog`'s `reading`).

Where the user is only adds to what is found everywhere and never takes anything away: what a chat
or a workspace's page adds is found by typing too, and comes first among equals, so that what is
searched for is there on any page. The default model answers each message sent, in a new chat and in
one already open (`sendChatMessage` takes it with every message), so choosing another from search
tells the open page (`chat/preferredModelChanges.ts`, which `useDefaultModel` listens to) rather than
leaving it to the next page.

The `add-workshop-setting` skill is the checklist for adding one.

There is no Approvals part: nothing the user sets for every workspace is kept yet.
`useStandingApprovals` is kept, unused, for when a workspace has settings of its own.

The user's own models are added, edited and duplicated in `settings/ModelDialog` (Edit and
Duplicate from a row's more menu, Remove beside it), its rules plain and tested in
`settings/modelForm.ts`: what is asked for follows the provider, and nothing of keys with AI
Gateway. A saved key or header is never had by the client: it reads as Saved, is sent as `null`
to keep it only while the provider and address are unchanged, and a duplicate copies the
original's (`copySecretsFrom`). Where the admin turned the user's models off, a line says so in
place of Add model.

### Admin

The deployment's own settings, main's Admin page, a tab to a part: an Admin group after the
user's own (`ADMIN_GROUP` in `settingsSections.ts`, ids `admin-*`), listed only once the server
says the user is an admin (`useIsAdmin`, `amIAdmin()` asked once a connection). Anyone else named
one is shown their first part instead. The parts are in `settings/admin/`, one file each, with
their pieces in a folder of the part's (`models/`, `formats/`, `audit/`, `updates/`).

`AdminProvider`, round the settings page, holds the admin capability for the visit, so what an
admin does there is one session in the audit log: the promise of `getAdminApi()`, never awaited,
which calls are pipelined on (`AdminCapability`), disposed as the page goes or the connection is
made again. A part reads the settings as it opens (`useAdminSettings`, `AdminSettingsStatus` for
while they load or could not be read): a change is shown at once and made (`change`), and on a
refusal they are read again, why being said over the part (`useAttempt`). What is written at
length is saved or discarded by hand (`SettingText`), as Enter is a new line there.

- General: the site name, the logo (`SiteLogoPicker`, made a PNG by `siteLogo.ts`, ported and
  tested), the accent (`AccentColorMenu`; it is not applied to this app yet, which has its own
  theme), the banner and its colour, the top-bar notice, agent instructions, and what an agent may
  fetch once it has read restricted data (`RestrictedWebFetch`). This app shows none of the
  notices or the branding yet, but for the site name on the sign-in page.
- Services: a surface to a service, its kinds switched on and off under it; one made for each
  person without connecting it is Off, Optional or On for everyone.
- Formats: the blueprints promoted to be started by name (`FormatCard`), in order, each opening
  to how it is presented; a field left empty or saying what the blueprint does follows it
  (`formats/formatChanges.ts`, plain and tested).
- Gateway models: main's Models tab, a line saying so outside AI Gateway mode. Each change is
  made and the settings read again, one at a time; what else is done to a provider or a model
  (Test, Settings…, moving it, Remove…) is in its more menu, so a row stays one line on a phone.
- Access: sign-ups and finding people by name.
- Audit: what admins did this week, the log a page at a time under a filter menu (`ListToolbar`'s
  kind), which lasts for the visit as the address names only the part, and how far an admin may
  inspect and how long records are kept. A backend older than the log says so
  (`auditSettingsOf`).
- Updates: the release, Check now and the way to the deploy flow, after the backend is told the
  router's tag (`updates/probeRouterTag.ts`). A deployment the deploy flow did not install is not
  updated from here, which is all that is said. `UpdateNotice` tells an admin of a newer release
  in the home page's header, with a capability of its own, until it is closed, which hides it in
  that browser for the deployment's snooze, under the old app's key (`updateNoticeDismissal.ts`).

Inspecting a workspace or a user's account (`inspectWorkspace`, `inspectUser`) has no page, as
main has none. The gallery draws every part over a fake capability (`gallery/adminPreview.ts`).

### Always show thinking

Preferences' Always show thinking, under Chat (`prefs/liveWork.ts`, kept on this device and read by
`useLiveWorkOpen`; defined once in `usePreferenceSettings`, so ⌘K flips it too), is the same thing a click on
the assistant's mascot while it works turns on and off, so there is one place it is kept and neither can
disagree with the other. On, the steps are shown while the assistant works, and how a reply came about is
open above each reply, without the brain button: a reply's trace is open when it is on and has not been
put away, or off and has been opened (`ChatItemView`, as a step that is alone starts open in `WorkLog`).
Developer mode turns it on once, when it is switched on (`writeDevMode`).

### Developer mode

Preferences' Developer mode, under Advanced (`prefs/devMode.ts`, kept on this device and read by `useDevMode`; defined
once in `usePreferenceSettings`, so ⌘K flips it too) shows what is for those who build on the app,
and nothing else changes while it is off. A chat has, under its composer, `ChatStatusLine`
(`ComposerStatusLine` block): the model on the left, which is the default model, so choosing another
there is choosing it in the settings (`setPreferred`, which tells `useDefaultModel`), and on the
right what the context holds with its share of the budget in brackets (`83.3K (42%)`), and what the chat has cost, in short figures with
the exact ones in a tooltip. The usage is the chat's metadata (`ChatSnapshot.usage`: `totalTokens`
and `contextBudget`, `totalCost`, the cache counts). The share is the server's: `totalTokens` is the
last step's tokens, and `contextBudget` the prompt budget the agent compacts against on the model
that step ran on, and that model, named in the tooltip with the share it compacts at
(`COMPACTION_TRIGGER_RATIO`); both are absent, and nothing is shown, before a step has measured
them and after a compaction. A model of the user's own
can be held to a smaller window there as in the settings (`useModelConfig`, `contextWindow.ts`,
plain and tested), which applies to every chat on the model from its next step; a deployment's
model has no window to change. A workspace's page shows its total cost in
the header (`LiveWorkspaceFields.totalCost` keeps it live), the chat list has each chat's cost and
a Cost order, and a message's details say how long a reply took (`AssistantItem.workedFor`, from
the message before it), its more menu copies the message's ID and raw JSON, and the chat's, the
workspace's and the gadget's settings pages list their IDs (`DeveloperIds`), each copied by pressing it. Per-message tokens and cost are not on the
wire (the server keeps the step's usage only in the chat's totals), so they are not shown. Turning it
on also opens what the agent is doing while it works (`prefs/liveWork.ts`): that is kept for every
chat and is the viewer's to put away by a click, as it is for anyone.

## Skills

Skills are not the Workshop's. They are the Context Library's (`gatekeeper-context`, see its
`AGENTS.md` and `app/skills/README.md`), kept and shared in its own app, which is opened as any
gatekeeper app is (below): there is no Skills part in the settings and no skill page here.

A new chat's composer offers the commands of the workspace it will start in (`listSlashCommands`,
through `useChatCommands`): the one chosen, or the provisional one made as they are first looked
for. The first message finds the command in that same workspace (`startConversation`), and says so
where it no longer offers it.

## Gatekeeper apps

`gatekeeperApps/` holds the management apps of the user's gatekeepers. The list
(`GatekeeperAppsProvider`, `useGatekeeperApps()`) is read on each connection and again whenever
the user's accounts change, so turning a tool on or off shows without a refresh. Each app gets a
sidebar row under Automations with its own icon (`MaskIcon`, or a window), a ⌘K Go to entry, and a
page at `/apps/$appId` (`GatekeeperAppPane`). Old `/gatekeepers/<id>` links redirect there
(`routes/-legacy.ts`).

The app runs in a frame sandboxed with no origin (`allow-scripts allow-modals`, as the old app had
it). Its handshake and the frame's error reports are handled by `GatekeeperAppSession`; what the
app may ask of the Workshop is `GatekeeperAppHost`. That covers its gatekeeper's `ui`, relayed
through rate limits and never called by the Workshop, plus the theme and its changes, growing over
the window for its own dialogs, going to a workspace, starting a chat with a prompt in the
composer, looking up workspace titles, and the Workshop's person picker. The picker
(`UserPickerDialog`, logic in `UserPicker.ts`, plain and tested) gets a ticket for one person at a
time and gives it to the app's frame, never to the gatekeeper. Done waits for whoever is being
added. No gatekeeper is named anywhere in this code.

## Automations

Automations are the kernel's hooks (`BoundHookInfo`) and nothing more: the workspace tab and agent
page read `Overseer.listHooks()`, and the Automations page reads the workspace summaries' `hooks`.
They are listed on a tab of the workspace's page and of a chat's settings page
(`?tab=automations`), which the chat header's clock opens with how many the chat has
(`AutomationsTab`, `AutomationRow`), grouped On / Paused. A row is two lines, as the Library's and
the Connections page's are: its name over what it does or watches and, on the Automations page,
its workspace; at its end its switch (`enableHook`/`disableHook`) and more (`AutomationMoreMenu`),
which is always there rather than slid out when pointed at, as it is the way to delete. All of the
row opens the rest (`AutomationDialog`): what it does, what it watches, the app it runs and its
workspace, each going there, its switch, and Delete at its foot, asked first by a `ConfirmMenu`,
as Disconnect is. More deletes it too, asking in `DeleteAutomationDialog`. Deleting is
`deleteHook()`, which removes a schedule for good: the row goes once the workspace has done it, and
a refusal is said where it was asked. The switch and Delete are for whoever may build there. No
gatekeeper's private API is read for timing or status, so nothing says when one runs next or why
it stopped.

Every workspace's are on a page of their own too (`/automations`, `AutomationsPane` over
`AutomationsView`), between Library and Connections in the sidebar: under the list's controls
(`automationList.ts`, plain and tested), by status (On, then Paused), by workspace or by name,
narrowed to on or paused and a workspace, each row saying which workspace it is in
(`AutomationRow`'s `workspace`). `useAllAutomations` takes every workspace's hooks from the
summaries the account keeps (`useWorkspaceSummaries`, below), opening none; a switch turned in
another tab or on a workspace's own tab is heard of there. While the account is still asking
workspaces made before it kept summaries, the page says so under what has come in. With none at
all it says what an automation is and offers a few things to ask for (`AutomationsEmpty`), each
going home with it written in the composer (the history state's `draft`).

A hook says which chat set it up (`chatId`): a chat's automations are the hooks bound from it
(`setUpIn`).

On the workspace's page the tab lists first, under "Waiting on you", what was asked outside any
chat (`attentionOf`'s 'elsewhere' group), which it counts: an action says only the connection it
went through, not the hook or gadget that made it, so it is put down to the automation whose
gadget is bound to that connection (`useGadgetConnections`, read only while something waits;
`asksOfAutomations`, plain and tested), where exactly one is. That automation is listed there,
what it asks its second line and a pill at its end (`AutomationRow`'s
`waiting`), decided in its gadget. What none, or several, could have asked is one row
of its own (`OutsideAsksRow`), which goes to the Library tab.

## A workspace's chats and history

A workspace's Chats tab, which its page opens on, is where whoever comes back to it, after being
in other chats or away, finds what to do, as several people each with many chats depend on one
another to decide what an agent asks. It lists people's chats and agents' runs alike
(`ChatListView`, fed by `WorkspaceChatList`), in cards. The menu by the search groups them and
orders each group (`ListToolbar`'s `order.groups`, `useListView`'s `groupings`, kept on this device
as the order is): grouped by Status (the default), Date, Owner or None (`groupChats`,
`workspaces/chatGroups.ts`, plain and tested), and in each group by Last active (the default),
Date started or Name (`chatList.ts`). The filters only say what is listed; "action needed" means
one thing throughout: waiting on an approval or an answer, failed, or ready for review, as the
pill, the status groups and the filter have it.

- Favorites: the chats the viewer starred, on this device (`prefs/chatFavorites.ts`), each still
  saying how it stands, first whatever the grouping, in its order (`favoritesFirst`).
- By Status, most urgent first, in cards with no headings, as each row's pill says what its card
  is (`chatStatesOf`): Needs approval, however many, then Needs action, as for a connection
  to make (`attentionOf`, plain and tested),
  Failed, Ready for review (`reviewsOf`), Unread, and everything else. What is at work is not a
  group: it would move in and out each time its agent starts and stops, so it stays where it is,
  its row saying it works. A row opens its
  chat, where what waits is decided as its cards there have it. The tab has a dot while anything
  waits in a chat or failed (`attentionCount`, read out as how many; `Tabs`' `count.dot`), as the
  Agents and Automations tabs do; what was asked outside any chat is the Automations tab's (see
  Automations).
- By Date, under headings, in stretches of time as the Library's are (`groupByTime`), by when each
  started where that is the order, and otherwise when it was last active.
- By Owner, under headings: the viewer (You), then each person and then each agent by name
  (`ownerOf`), then those whose starter is not read yet (Someone).

The filters show only the viewer's
own (Yours), what needs them, the unread, or their favorites (`chatList.ts`); and which agent runs
(`ListToolbar`'s `choices`): Action needed, the default, lists a run while it needs someone or is
starred (one at work does not), and a search looks through them all; All; or None. Yours is by the starter, so a chat whose first
messages were not read (past the latest 40) is not counted among the viewer's.

Each row (`ChatListItem`) has who it is by: the agent a run is of, in the Workshop's static cloud,
or the person who started the chat, in their picture (`chatByOf`, the first message a person
wrote, `WorkspaceActivity`'s `starters`, as a chat names nobody who started it); its picture is
marked at the corner with what waits, failed or is unread, or with hopping dots while at work.
Under the title, its latest message after who said it: the agent a run is of ("Inbox helper:
…"), or a person, but not a chat's own assistant (`speakerOf`), its Markdown as plain words
(`plainLine`). While it waits, what it last asked, where nothing was said after it
(`WorkspaceActivity`'s `asks`), without saying again that it asks, which the pill does: "Connect
Jira · To read the sprint's tickets", "Share “Q3 plan” with finance", as the text it asked after
may be a person's. Or
"Working…" shimmering. How it stands is a pill before the time, its words in its colour over a
see-through wash of the same (a banner's tint is muddy on the card's grey): Needs approval, Needs
an answer, Run failed, Ready for review. Mark all read is over the list.

The activity log (`HistoryView`, `WorkspaceHistory`) is the record of everything asked for, read
and set up (`listActions()`, a page at a time with Load older, newest first, what changes live
laid over it), there to look something up in rather than to be checked, and so at the bottom of the Settings tab
rather than a tab of its own, its heading on the line of its search and filters (`heading`), its
entries one card that keeps its place, its lines scrolling inside it and older pages read as its
end comes near (`scrolls`), rather than with Load older: a line each as a log has
it (`ActivityRow`, opening in place to what it did or read, when, and the way to its chat), under
a search and the filters (`activityList`, plain and tested): kind, how an approval went, who
decided (Decided by) and the chat, each a menu of those the pages read name, which narrow only
what has been read. The gallery renders both over `gallery/exampleActivity.ts`
(`WorkspaceChatsPreview`, `HistoryPreview`), and the `team` scenario is a busy shared workspace
with all of it.

`WorkspaceActivity` (plain, tested, like `WorkspaceAgents`) holds it, opened by the workspace's
page for the tab's count whichever tab is shown: the chats, every page of what waits, and the
history. What waits on a decision is anyone's who builds in the workspace to decide, since nothing
says whom an action is for, and it is decided in its chat; the backend saying who asked (and whom
it waits on) would replace reading each chat's last messages.

## Agents

An agent is what the backend calls an agent spawner, which is never said to anyone: something a
gadget starts with a task, such as answering each email that arrives, each time in a run of its
own, a chat with no person in it. Runs are not chats people have (`isAgentRun()` from the shared API, by `spawnerId` or `spawnerName`), so they are not
offered to carry on in from a gadget's page. They are listed on the Chats tab while they need someone, or
when looked for, and under their agent, on the workspace's Agents tab, after Chats
(`AgentsTab`), and on the agent's own page (`/workspace/<id>/agent/<key>`, `AgentPane`, drawn by
`AgentView`), each opening its conversation, which is where what it did is seen and where what it
asks for is answered. The design record is `plans/agents.md`.

What matters of a run is how it stands (`automations/agents.ts`, plain and tested): at work,
waiting on a person, failed, done with changes to keep, or done. Waiting on a person is a run
stopped on a decision (`awaitingDecision`) or with an action of its own waiting to be approved,
and failed is a run whose last turn ended on an error other than being stopped (`lastTurnFailed`). What wants a person
(a run waiting on them, or an agent's latest run that failed) is said where it is seen without
looking for it: first on the workspace's Chats tab (in progress), counted on it and on the Agents tab (`Tabs`' `count`),
on the agent's page, on the agent's row on the Agents tab, first and in the colour of it, and
in the sidebar, in place of the workspace's subtitle (`WorkspaceListItem`'s `attention`). A run's
header has its agent's crumb (`AgentCrumb`) after the workspace's, which goes to the agent's page.
An agent is drawn as the mascot (`AgentMark`): thinking while a run works, sad once its latest
failed, greeting whoever points at its row. An agent is the kernel's: it is an agent spawner, its
key is the spawner's id, a run is its agent's by its `spawnerId`, and a run with none (from before
runs recorded their spawner) is no agent's. Nothing is matched by name.
Its page lists its runs under a tab for each way they stand (`RunFilter`, `runsMatching`,
`runFilterCounts`: all, needs you, failed, with changes, counting those read), with what needs
the user first under All, and a row of done runs of one title in a row folded into one that
opens to them (`foldRuns`), so that an agent with hundreds of runs reads at a glance. Its runs are
its own, read a page at a time (`AgentRunList`, plain and tested, over `listChats({ spawnerId,
limit, beforeId })`: twenty-five at first and fifty more on Show more), and kept up from
`subscribeToChat()`, subscribed to first, whose metadata brings its runs that start or change and
says which are deleted. How many runs it has is said only once the last page is read; until then
it is "at least" those read. Nothing says when it runs or which of a gadget's hooks started a run,
so its page says neither.

`WorkspaceAgents` (plain, tested, like `GadgetSettings`) keeps a workspace's agents live: what
each is from `listAgentSpawners()`, one agent each (`setupsOf`: named and given its model as it
was made, with every gadget bound to it, so one bound by two gadgets says both), read again as
the workpieces change; its latest runs from the first page of
`listChats({ kind: 'runs', limit: RUNS_READ })` and `subscribeToChat()`, whose metadata says
whether each one's last turn failed; and the actions waiting from `listActions({ filter:
'pending' })` and `subscribeToActions()`, each run's by the chat the action names, or else by the
run's message that names it (`actionsWaiting`, of people's chats as much as runs). An agent
known only by runs older than that first page is not listed on the tab (its page still finds
it by its id), and what the tab says of an agent's runs is of those read (`allRuns`).

What waits on the user in each workspace they build in comes from the account, which every
workspace keeps up to date (`AuthenticatedApi.subscribeToWorkspaceSummaries()`; `WorkspaceSummaries`,
plain and tested, held by `WorkspaceSummariesProvider` in `_app`, read through
`useWorkspaceSummaries`): its agents' runs and the chats people had that wait (stopped on a
decision, or with an action waiting), the gadgets that ask something and how much, and its hooks.
It opens no workspace and changes as the workspace does. A workspace shared with the user is in it
once they have opened it and confirmed access; one with no summary yet shows nothing waiting. A
workspace's line says all three at once (`waitingWords`), and its page counts each on the tab that
lists it (Chats, Agents, Library), what waits on a decision all of it on Chats, its runs and chats
from its own live reading. The `agents` scenario has a workspace whose gadgets start four agents, and the
gallery has each block in each state (`AgentsPreview`, over `exampleAgents.ts`).

## The sidebar

The sidebar is flat: the pinned workspaces, as tiles in an area of their own over the rest
(`PinnedWorkspaces`: each its icon over its title, up to three to a line, four where it is 20rem wide (a container query), 2px between lines, with
the list's hover and selection gliding and joining along a line, `useWorkspaceUnderlay`'s `x`),
then the viewer's recent chats
across workspaces (`SidebarChatItem`: the workspace's icon, which alone says which it is in, the
chat's title, and its latest message; no time). A row marks its activity alone: dots hopping at the
icon's corner while its agent works (`TypingDots`, which a workspace's chat list has on its
pictures too), and the unread dot, which a muted chat leaves out. In the rail's card, which has no
icons, a working chat's second line is "Typing…", shimmering, and the unread dot ends the row.
A ghost (below) whose conversation is still being read says "Loading…" on its second line,
shimmering; a listed chat's line comes with it. What waits on the
viewer is not said on it. With nothing pinned
and no recent chats, it lists the latest workspaces as rows, as it did before. A row is dragged
with a mouse onto the tiles to pin its workspace, and a tile within them to move it or out of them
to unpin it (`usePinDrag`, one drag for both): a copy of the icon lifts off and floats to the
pointer, jiggling as an app being moved on a phone does (`.jiggle`), then flies into its tile when
let go of, back to where it came from on Escape or elsewhere, or fades once unpinned. Meanwhile
the area is tinted, its height springs to what it holds (from nothing while none is pinned, when
it says Pin workspace), and the tiles make way for the place it would take (`CardGridMotion`,
which also moves them with Alt and an arrow key, and drags nothing itself here). A chat of a workspace pinned already can still be picked up, but the area does not open
for it and it only goes back. A finger does not
drag: a long press is the menu. The order is the preferences' `starredWorkspaces`
(`workspaces/starredOrder.ts`), which the Workspaces page follows too. Which chats are recent is `workspaces/recentChats.ts` (plain and tested): what waits on
the viewer and the chats people had that they take part in, all by when they were last active, the
latest first, so a new message puts its chat at the top, from the past week, thirty at most. Both
come from the account, opening no workspace: its tracked chats, each with its latest message and
who wrote it (`subscribeToUnreadState("recent")`, followed by `RecentChatsProvider` into
`RecentChatsStore`), and what waits on the viewer and which agents work in each workspace (the
summaries' `waitingChats`, with what each asks, and `workingChatIds`), which `useRecentChats`
puts together. The viewer takes part in a chat they wrote in (`participated`), have a read cursor
in, or asked to hear of. An agent's run is listed only while it waits, as the account tracks none
the viewer was not enrolled in.

A chat open that is not among them (older than a week, hidden, or not the viewer's) is listed
first while it is open, faintly until something is said in it (`useGhostChats`, its line from the
open chat's own session, `ghostChat.ts`; `SidebarChat.ghost`). Left with nothing said in it,
it goes; left with something said, it stays first, as it is drawn then, until the recent chats,
which follow the account live, have it. Gone to again from there, it is still drawn whole. Its menu has nothing to mute it by or hide.

The rows keep their order while the list is pointed at, focused from the keyboard or has a menu
open, what is new coming at the end (`heldOrder`), and take the real order once left, sliding to
their new places with the highlight under them, new ones fading in (`useRowSlide`; the underlay
measures rows where they are laid out, not where a slide has them). A row's menu
opens by right-clicking it, or pressing and holding it on a touch screen (`ContextMenu`, one for the
whole list, `SidebarMenus`): a chat's has Open in new tab, Go to workspace, pinning its workspace,
muting the chat or the workspace (until unmuted), and Hide from sidebar; a pinned workspace's has Open in new
tab, New chat here, Mark all as read, Unpin and Mute. A hidden chat is kept out on this device
(`prefs/sidebarHidden.ts`) until it waits on the viewer again after more happened in it, or something is said in it while it is open (`useGhostChats`), and goes at once, with nothing left
in its place. A row keeps its hover while its menu is open (`data-menu-open`). On the rail each workspace is its icon, the pinned first and
apart, then those the chats are in (`railWorkspacesOf`). Clicking one goes to it; pointing at one with
chats opens a small card of them beside it (`HoverCard`), each going to its chat, and one with none
has a tooltip at once. A card opens as soon as its icon is pointed at, only one at a time,
and with one open, the next takes its place with no animation. While one is open the dividers' pills (`ResizeHandle`) do not come out, as the card is over the gap.

## A gadget's own page

A gadget's page (`/app/<id>`, the side pane as the page) shows it as it is kept, which is what
everyone sees: a chat's changes are only beside that chat (`keptVersion`). It leads to a chat
with it, as using it with the agent (a slides gadget whose agent builds the deck with you) and
carrying on building it both happen in a chat. For whoever builds in its workspace (not
`role === 'use'`), its header ends in Chat (`GadgetChatMenu`), the one labelled control, and its one
primary button, last of all after the full-screen button, however the page was come to. It opens
to the chat the page was opened from, first, as the way back (`?chat=`, which More's Open app
beside a chat names: back in the history when it was the step before, else to that chat with it
beside it), then New chat (`/?workspace=<id>&open=`, greeted "what should we do with Slides?"
through the `gadgetTitle` history state), then up to four of the workspace's other chats to carry
on in (`aside/itemChats.ts`, tested, over `useWorkspaceChats`), those that last had it beside them
(`lastShown`, kept in the user's preferences so it follows them to another browser) first and
saying so, agents' runs left out. Opening one remembers it
there. With no chats and none to go back to, Chat starts a new one at once. It is left out in full
screen; on a phone it is its icon alone and the crumb gives way to the back arrow. The backend does not record
which chat made a gadget, so nothing claims to know it. The design record is
`plans/gadget-to-chat.md`; the gallery has it as "SidePane as a gadget's page".

What a gadget asks to do through its connections is answered where the gadget is: beside a chat,
as its page and in full screen, by `aside/GadgetAskDock.tsx` (UI `blocks/GadgetAsk.tsx`) over its
foot, shown once something is asked. An ask is the gadget's when its code or one of its hooks made
it outside any chat (`ActionLogEntry.gadgetId`), or one of the agents it started did
(`AiChatMetadata.spawnedByGadgetId`); shown from a chat out of sight, also what that chat sent
through its connections (`gadgets/askGroups.ts`, tested).
Asks from the chat beside it are left to that chat's feed while it is in sight. The asks are
grouped by kind and resource, named by the resource's title, with Don't allow, Only this time and
Always allow (Undo for eight seconds). `gadgets/GadgetAsks.ts` (tested) keeps them live, holding
arrivals back a second, as a rule may let them through. Asks waiting elsewhere are counted from the
workspace summaries (`gadgetAsks`, `totalGadgetAsks`), each once. The count shows on the sidebar's Library row and as `WaitingBadge` on Library rows and
cards. The mock scenario `gadget-asks` has three waiting, and ticking a task off asks again; the
gallery has it as "GadgetAsk". The design record, with what the backend can't say, is
`plans/gadget-approvals.md`.

## A gadget's settings

A gadget's header, beside a chat or as its own page, starts with a switch for whoever may build in
its workspace between what it looks like and its code (`IconSwitch`: a preview icon and a code icon,
and a thumb that slides under the one that is on). It is first, ahead of the workspace's crumb, so
that it stays where it is whatever follows, and apart from what can be done with the gadget. On a
phone it is not in the header but in more, as Show the code or Show the app, first in it.
Switching to the code shows it in the gadget's place in the pane (`GadgetCodeView`), at once and
with nothing of the gadget showing, which is hidden rather than gone, so that it keeps running. The
title says nothing of it: the switch is the one place that shows which is on. The code opened again
is at the file it was left at. The pull tab only has the header to do with. The menu is, beside the
page, the way to its own page first (Open app, Open in Library for what else was made, Open on its
own for a file), then Reload and Export (a submenu of `ExportItems`, for whoever can use it, as in
the settings), then after a separator, at its foot, App settings for whoever may build there (a
file has Download in place of Export and the settings). That goes to its settings page
(`/app/<id>/settings`, `GadgetSettingsPane`), as does the title's bubble, a button ending in a
chevron as a chat's title is, beside a chat as much as on the gadget's own page. Everything else done to a gadget, such as renaming, exporting (which more has too), making a template of it,
updating and deleting it, is on that page, and copying its link is in Share.
The page is laid out as a header with
what it is drawn as, its title, renamed where it is, and what its template says it is for,
which is the template's and only read here. The way back to the gadget goes back where it was
opened from it (`fromItem`). Under them, a tab each (`?tab=`, kept in place in the history):

- Settings, which is the first (`DEFAULT_GADGET_SETTINGS_TAB`, which an address leaves out):
  updating it from its template, creating a template from it, exporting it, and deleting
  it, as rows on one card with no titles of their own (no row says which workspace or template it is
  from). The template row is Create template until the gadget has made one. Then it is gone, and
  a group of its own after the card, Template (`MadeTemplateSettings`, one for each of the gadget's
  own, by `gadgetId`; older ones may be several). `useMadeTemplates` uses
  `subscribeToOwnBlueprints()` for the owner, so Release update shows once its gadget keeps changes
  in any chat. Other builders read `Overseer.listBlueprints()` on demand. Across from its title is
  View template, which goes to its page; its rows are Edit details (`EditTemplateDialog`: its title
  and what it is for, `updateBlueprint`),
  Release update where its gadget has code to release (`unpublishedChanges.code`, sent with
  `updateCode`, which takes the bindings too), Update connections where only its bindings changed
  (`unpublishedChanges.bindings`: a binding renamed, rebound or given a new note, sent with
  `updateBindings`, no new version; `releaseWords` names both), else Updates with Up to date, and Delete template,
  which asks "Delete template?" without the name, as the name would read as the gadget.
  `useTemplateOwner` does them, one at a time. Export is the More menu's
  (`ExportItems`) in a menu of its own.
- Connections: what it is bound to (`GadgetSettings`, plain and tested,
  `listBindings()`), by the name its code knows each by, with the agents it can start apart. A
  binding says what it reaches (`kind`): an agent, with the model its spawner thinks with
  (`listAgentSpawners()`), a model, which its connection is asked to name (`getCreationSpec()`,
  for a model alone), or a service's resource. One is taken away from the gadget, asked for
  twice, and stays in the workspace. Its name is renamed where it is, as a title is
  (`BindingRow`'s `onRename`, `renameBinding()`): one the code could not reach it by, or that the
  gadget has another by, is refused with why before anything is asked (`bindingNameProblem`, by the
  API's own `validateBindingName()`), and stays in the field under why until it is put right or
  Escape puts it back. One waiting in a chat is that chat's, and is not renamed here. Nothing is
  added here, neither a service nor an AI model: the agent asks for what it needs in a chat, and a
  model is added to a chat (`ChatModelDialog`, from Add a connection) for the agent to give to a
  gadget, as an agent is (`MakeAgent`, named and given a model, with access to nothing). A model's row is titled by its model's name and changes model in place (`changeModel`,
  `ModelBindingDialog`): a connection to the new model, then the binding pointed at it in one step
  (`GadgetClient.rebind`), which keeps its blueprint annotation and is refused if the binding
  changed since it was read. A chat proposing a model says so in plain words when its changes wait to be
  kept ("Lets “Tip jar” use Claude Haiku", `useBindingTitles`).

There is one settings page. As the page itself it is the route; beside the page the same page
(`GadgetSettingsPane`, never a second layout) takes the whole pane's place, header and all, from the
title's bubble or the More menu, with Back to app as its header. The pane stays mounted and
hidden behind it, so that the gadget keeps running.

A gadget that follows a template is updated from it (`UpdateFromTemplate`, over
`UpdateFromTemplateDialog`). Its Settings tab has the way, or says it is up to date, where that can
be told (`templateUpdateStatus`: a template or a gadget that names no release says nothing, and
keeps the way). The update is proposed in a new chat (`applyBlueprint()`, through `proposeTemplateUpdate`, plain and
tested), which is then gone to with the gadget beside it: it is tried and accepted there, and
nothing changes until it is. It is reviewed by the model the user's messages are answered by,
unless another, or No agent, is chosen. Where nothing was proposed the dialog says why: it was up
to date, the two cannot be merged, or it could not be asked, with Try again. A gadget that shares
no history with its template is warned of first, in the dialog's place, and merged over a guess
only on Update anyway. Only a gadget with code of its own takes one: one still waiting in a chat
has none. Settings reads the published record via KV-backed `PublicApi.getBlueprint()` and refreshes
it on reconnect, entering Settings, checking or taking an update, and a relevant local template
change. While mounted, `useBlueprintInfo` also reads it again as the window is focused and every
minute the tab is not hidden, never while a read is still under way, so Update available shows
without a reload: a re-check, not a feed, as nothing says when a template is released. The
`output` scenario serves that read from its scripted public API: its document follows a
template a version behind, whose update is proposed in the scenario's own chat.

Someone it was shared with to use is told its settings are not theirs. What the old app also had
here (who has access, its automations, changing what it is drawn as,
switching it to another template, and updating one whose template is not known) is not here yet.

The settings also have Export, as does the header's more, as the backend lets whoever can use a gadget export it
(`useGadgetExports`, over `GadgetExports`, plain and tested): it opens to what the gadget can be
exported as (`ExportItems`), read each time it opens, with the chat's changes where
it is shown from one, each saved to the device when chosen, one at a time (`files/saveStream.ts`:
into the browser's save window where it has one, or else downloaded as plain bytes). Then, for
whoever may build in its workspace, as in the old app, the kinds of file a connected service makes
from one of those formats (`saveTargetsOf`: a kind with a creation form whose `savableFrom` names
the format). Save to one asks in `ConnectResource`'s `save`: the account, the file's name, then
where, in the service's creation form opened for saving; the export is handed to `saveFile()`
unawaited, so that it goes straight to the service. The file the last save made is kept in the
user's account (`savedExports`, through `prefs/savedExports.ts`), so Update works
from any browser, and Update saves over it after asking (`UpdateFileDialog`). What became of an export floats over the foot of the pane
(`PaneStatus`): under way, saved with the way to open it, or why it failed. The `output`
scenario's gadget exports as Markdown and CSV, and fails as a PDF; the scripted chats offer no
service to save to.

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
  many, or that come and go, such as people. A choice the list keeps itself, one of a few, is given
  to the menu as `choices`, under its name; one off its default counts as a filter, and clearing
  sets it back.
- `hooks/useListView.ts` keeps how one list is looked at. Rows or cards and the order are kept on
  this device (`prefs/listView.ts`), under the list's name. A list is rows until the user chooses,
  unless it says it starts as cards (`startsAs`). The search and the filters last for the
  visit: a list that came back narrowed would seem to have lost things. It gives the controls
  `ListToolbar` draws, ready to spread.
- `GroupedList` draws the groups as rows, `CardGrid` as cards, each group under its label. Both
  take `onReorder` for a group whose order is the user's. The pane gives each a row or a card of
  its own block. Cards laid out along a line, as a row is, are `wide`: two to a line, and one
  where two would be too narrow.

A page, tab, group or pane with nothing in it says so with `EmptyState`, as Linear does: an icon on
a tile, a title for what is missing ("No chats yet"), a sentence on what would be here and how it
comes to be, and what to do about it, one action `primary` at most (start the first one, go where
there is some), which may be a menu. It names what is added ("Add automation"), not how: where
the agent makes it, it starts a chat in the workspace with the start of the request written in the
composer for the user to finish (`automations/startDrafts.ts`), the cursor after it. With nothing in it there is nothing to look through, so its
tabs and list controls (`ListToolbar`, a group's action) are left out, and the empty state has
what they offered to do; a page's header keeps its own. `page` stands in for a page's list,
centred in the room under the header (`PageLayout`'s `fill`, the column `flex-1`). `section`
stands in for a tab or a settings group, `tinted` on the surface its list would be on, so that it
reads as that list's place, or for a pane (`PaneNotice`, which centres it on the pane's own). A
list whose search and filters left nothing keeps its controls and has `NoMatches`, with Show all.
The sidebar is quieter than any of them: with no workspaces it has one row where the first would
be (`NewWorkspaceRow`), which starts a chat. None of them is for loading or failing, which say so
in a line where the list would be.
The gallery has each form (`EmptyStatePreview`).

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
in place in the history): its chats, which it opens on (see A workspace's chats and history), what it has made (the library's, as beside a chat, opening
beside the page), its agents (see Agents), what runs by itself, its members, the owner first until ordered by name, under a search and the Invite button, and its Settings, its activity log among them. The
chats and the library load what they list once chosen; who has access is read with the page, for
its header, and its agents too, for what of theirs waits on the viewer.

A workspace is shared to join it, and a gadget to use, alone (`ShareWorkspaceDialog`, whose
target is a `ShareTarget`). The words are for people who have never shared software: a workspace's
people are Members and its link lets anyone with it join; a gadget's people and link Can use it,
and the line for the workspace's members Can edit it, as changing a gadget is editing it. Whoever
only uses some of its gadgets is not a member, as the old app had it: the workspace's dialog, its
Members tab, its header and the Workspaces page's rows, filters and search leave them out
(`membersOnly`), and they are listed, and taken away, in each gadget's own dialog. Deleting the
workspace still counts them among those it is taken from. A
gadget's Share (a menu in its pane's header, where Copy link is otherwise) has Invite user, which
shares that gadget: its people are those who use it, under one line for everyone who can edit the
workspace, and a template item that says where the app stands: Create template, which lets others
copy the app instead, Release update while the workspace's template has changes, and Copy
template link, to its page, once it is up to date (each says so under its name); the workspace itself is invited to from its own page. Its page's header has who has access,
which goes to the members, and Invite, for whoever may
(`workspaces/sharingRules.ts`, plain and tested): the owner, and whoever can edit until its data
says only the owner may let anyone in (`ownerInvitesOnly`). Someone who can only use it is not
told who else can. `SharingSession` (plain, tested, like `ChatSession`) holds the workspace while
the dialog is open: people are invited one at a time, a name that would change nothing says why
without asking, and access is taken away from a person's row, the server first saying what that
does to whom (`RemovalDialog`); from a gadget, they lose that gadget alone. The viewer's own link
(each sharer has one default link for what they share) lets anyone in the deployment get it from
the page it was copied on, its key in the fragment, which `ShareLinkGate` redeems on its own
(`redeemWorkspaceShareLink`) before anything is shown, then opens the workspace without it, so that
a dead link, a confirmation declined and a dropped connection are each said as what they are. It is
found among `listShareLinks()` (the viewer's `default` link for what is shared), and Copy link mints its key only when chosen
(`SharingSession.linkToCopy`). Turned off, whoever came in by it keeps what it gave them, decided
by the server as it turns it off (`revokeShareLink(linkId, "everyone")`).

What it reads at other services is said at the dialog's foot (Protected resources, and how many),
which goes on to a page of its own listing each once under its service's logo, however many of its
connections read it (`protectedResources`, by its address, else its title): what whoever it is
shared with will be asked about. They are asked as they open it (`connections/ObserverAccessProvider`,
beneath `RpcGate`, which hands every `openWorkspace()` and `getGadget()` the overseer's
`ObserverConfigCallback`), by `ConfirmAccessForm`, never in a dialog: as the page, in the pane of
the gadget being opened, which shows it while it loads (`useAccessQuestion`), or, for a workspace
where no pane is showing one of its gadgets, in the page's place beside the sidebar
(`usePageAccessQuestion`, which `_app` puts where the page or an item's own page would be), with
what it covers kept out of sight under it, the sidebar there to go elsewhere by, and Cancel. Only
before the app's frame is there (a shared link being let in by) is it the whole window. A gadget's
question is asked only in its own pane (`connections/accessQuestions.ts`, plain and tested): what
reads a gadget in the background, such as its agents' bindings, waits unasked until it is shown or
its workspace is left, and what can be asked meanwhile is. Each resource once with the account to show it with,
a choice of theirs, or the way to connect one, what would make the one chosen do, and, asked again,
which were refused; on a phone, a card for each service instead, its account and what is to be done
about it once for the resources it reads, which are chips under it. Only the workspace on screen asks (`viewedWorkspace`): those the sidebar and the
sweeps open in the background are refused as not asked, as is what the user cancelled, until they ask again, and
going to another workspace leaves what it asked unanswered, which is asked again on coming back; a
cancelled question is refused as cancelled (`ACCESS_CONFIRMATION_ERROR_CODES`, which the overseer
refuses the open with, naming the workspace and gadget). A gadget's loading waits on the answer as
long as it takes (`GadgetConnection`'s `waitsOnViewer`). A gadget whose open was refused with one
of those codes is `unconfirmed` (`GadgetConnection`) and says so in its pane, with Confirm access,
which asks again (`useAskAccessAgain`).

Where a gadget can't be opened, as its workspace does not let the viewer in or is gone
(`GadgetUi`'s `reason`, from the open's error code), or they are yet to confirm their access, and a
template was made from it, the top of its pane offers that (`TemplateOffer`), going to its page.
The backend tells only whoever builds in a workspace of its templates (`listBlueprints()`), so
today that is never someone who can't open the app: it is offered wherever it can be read.

What a link to an app shows someone who can't simply open it is at `/gallery/no-access`
(`?case=`, `&template=off`, development only): the real page in the app's frame, over a fake
backend that refuses or asks as the real one does (`gallery/noAccessApi.ts`): not invited, a share
link it no longer takes (`BrokenShareLink`), deleted, and shared to use with a dozen resources to
confirm, first and again after an account was refused, with the real `ObserverAccessProvider`
(given the workspace on screen as `viewing`, which the address does not say there), through to the
app, and the template offered as it would be were the backend to say so.

A workspace goes from the user's list from its page's Settings tab (`WorkspaceOptionsTab`), which
also marks everything in it read, or from the More menu (`WorkspaceMoreMenu`) on its row or card on
the Workspaces page, which have it beside the pin; the sidebar's menus (see The sidebar) do not remove one. Its owner deletes it (`deleteSelf`), with everything in it
and for everyone; someone it was shared with only removes it from their own list
(`dismissSharedWorkspace`), keeping their access, so that opening it again brings it back. Which
is offered is whose it is (`workspaces/workspaceRemoval.ts`, plain and tested: a workspace that
names no `owner` is the viewer's). Either asks first, in place under its button (`ConfirmMenu`, with the words of `RemoveWorkspaceDialog`, which the Workspaces page's menu opens), deleting saying
what goes and for how many besides the viewer, as far as its members are known, and that it
cannot be undone. Once done, the account drops it from the list (`WorkspacesProvider`'s feed), and
its page goes home. The `shared-workspace` scenario's page offers the removal, and
any other's the deletion: its Settings tab opens it there.

A workspace's icon is a folder with its initials until the user gives it a look: one of the shapes
and colours in `prefs/preferenceFields.ts` (`WorkspaceLook`), named and filled by
`components/workspaceLook.ts`. On its page the icon is a button, as its title is a field
(`WorkspaceIconPicker`): it opens a menu of the shapes and, under them, the colours
(`DropdownMenu.SwatchGroup`), which stays open beside the icon so that each choice is seen on it.
Each look is the user's own, kept in their preferences (`workspaceLooks`, `setWorkspaceLook` in
`workspaces/useWorkspaceLooks.ts`) and seen by no one else, so it follows them to another
browser; a shape or colour the app no longer has is read as the first. Whatever draws a
workspace's icon is given its look with its initials (`useWorkspaceLooks`), so that it is the same
in the sidebar, the lists, a header and a filter.

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

Dragged the other way, until the page is all but gone, the page dims to say that letting go expands
the pane (`SplitLayout`'s `onExpandAside`, given where something is open beside a chat or a
workspace's page), and so does a step wider than its widest from the keyboard. That is the only
way there: it is a size, not a place, so the address stays the page's and the pane has the page's
version still, a chat's changes and all, with the page kept under it (`asideAlone`). Left behind
with the page, as full screen is. Expanded, the arrow at the end of the header is Side by side,
which puts the page back first, and only then Hide. It is as wide when it comes back beside the
page as before it was dragged over.

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
(`useChatLibrary`): the library (`useLibrary()`, the app's one outputs feed), and what the chat has
made that the library does not have yet (a gadget still to be accepted, a worktree), from all of
what the chat has (`Overseer.listChatArtifacts()`, read whole by `ChatSession` and again when a
message or decided action can change it), with what it worked on as far as the conversation is
loaded. The chat's context card lists its uploads and the connections it used from the same read,
however little of the conversation is loaded. A file opened from a link alone has its name and type
read with its bytes (`Overseer.getChatAttachment()`). The actions the chat waits on are the
workspace's pending ones (`Overseer.listActions({ filter: 'pending' })`, every page, kept up by the
actions subscription) that name the chat (`ActionLogEntry.chatId`); those whose messages are not
loaded are shown first under the conversation. A connection or web fetch request it waits on is in
its history: where the metadata says it waits (`AiChatMetadata.awaitingDecision`) and neither a
pending action nor a loaded request explains it, `ChatSession` fetches the history back until one
is loaded or there is no more, in as few reads as the workspace allows, once a load. Its own
metadata, on opening, reconnecting and before keeping changes, comes from
`Overseer.getChatMetadata()`: no chat reads every chat in its workspace to find itself.

The card (`SidePane`) is a header, then what is shown on a tinted surface that fills the rest of the
card out to its sides and bottom, with rounded top corners and a line along its top only. The header
starts with the name of the one shown (`SidePaneTitle`). At its far end: who else has the workspace
open, more (its own page, reload, its settings), the Share menu where the one shown can be shared, or else a link
to copy, full screen, and the arrow. Each of the last two is one thing, in the same place wherever
the pane is; going to its own page goes somewhere, so it is in more. Where the header is crammed (narrower than `CRAMPED_BELOW`,
measured, as the menu is drawn outside it) Share is in more instead, first in it as a submenu of Invite user and Create template, and the name is
left the room. The bar at the top of the surface, in the middle, pushes the
header up out of the way and pulls it back down (`Grabber`); clicking it does the same. People
pull down on it whatever it does, so with the header all the way out a tug down stretches the
header a little and rolls it up when let go, however short the tug, or at once at the most it can be
pulled (`TUG_AT`), as a cord is pulled, while pulling up still follows the finger. Its bar is
the divider's pill, always out and staying put: it grows, darkens and springs as the pill does when
taken hold of (`pill.ts` holds what the two share).

A gadget runs live in the pane (`GadgetConnection`, plain and tested like `ChatSession`): its UI
code is loaded into a page for a sandboxed frame with no origin (`gadgetSandbox.ts`, ported from
`workshop-frontend`'s `GadgetUI`; the shared `prepareUiPage` turns its bundle into modules), and
the page is connected once it asks, with a port it posts, to a `GadgetFrameRoot`: the gadget's
server side and the app as its host (`GadgetHost`), and what the page's runtime reports, its
console and Escape. A UI of modules is started by `main(gadget, host)`, and a legacy one gets
`gadget` as a global. Only messages from the pane's own frame are listened to. Beside a chat, a
gadget shows that chat's proposed changes; anywhere else, as it is kept, so that its own page loads
it again. It is loaded again when its code changes: a
change to its files in that chat, the chat's changes being accepted or thrown away, or its head
moving. A burst of edits loads it once, and the page shown stays until the new one replaces it. Only
the one shown is connected: going to another tab and back starts it over.

Code, a gadget's or a worktree's, is shown in CodeMirror (`components/CodeEditor`): found
with the app's own find bar and go to line (`codePanels`), folded, its indentation guided, lines
picked from the gutter for a link to them, and its scroll kept per file. Its colours are the
`--color-code-*` tokens of `theme.css` (`codeEditorTheme`), so it follows the theme with no
script, and a language's parser loads the first time a file in it is shown (`codeLanguages`).
Every `@codemirror/*` package must resolve to the one `@codemirror/view` that `workshop-frontend`
uses too, or the editor's extensions fail its `instanceof` checks: check the lockfile after adding
one. `CodeBrowser` lays it out by its own width (container queries, not the window's): the files
as a tree beside the code (`CodeFileTree`, arrow keys and all) from 56rem wide, and under that a row
of tabs along its top (`CodeFileStrip`, with Go to file before them, New file after and the shown
file's menu inside its tab, which `CodeFileMenu` shares with the tree; a new file is a tab at once,
after the others, with its name typed in it until Enter, and a file is renamed in its own tab; the
tree does the same in a row at the end of its folder, both by `useCodeNaming` and `CodeNameField`).
The code is not a card on the surface it is on: a line (`kumo-contrast` at 12%, stronger than the
hairline, so that the files read as apart from it) sets it off from the files: under the tabs where
they are along its top, and beside it where they are the tree, never both. Its controls are the
app's size (`--control-size`, `--control-text`), and nothing in it is under `text-sm` but a key
cap or a change's letter. Cmd or Ctrl with P to go to a file (`CodeQuickOpen`), and a status line. Its
history (`useCodeHistory`, `getCommitLog()`) lists each time the code was kept; picking one shows
only what changed then, each file as a diff from the commit before (`@codemirror/merge`, unified
first, or side by side for as long as the file is shown), with what was compared over it and the way back. Reads are
kept by commit, which never changes (`gadgets/codeReads`). A gadget's first commit, which it was
made with and is empty, is not listed.

A gadget's code is edited in one of two ways, by where it is shown (`GadgetCodeView`), both with
the same file actions: what is typed, and its files made (a `/` in the name makes folders),
renamed or moved, duplicated, deleted and put back from the tree's ⋯ menus and +. Renaming or
deleting the file the gadget is built from (`client.*`, `server.*`) asks first, in a dialog
(`CodeFileCautionDialog`, held by `CodeFileMenu`, so that the tree and the tabs have it alike) that
says what stops working, and the menu says nothing of it. Undo is per file and outlives switching
files (`historyKey`). Nothing can be edited while a past version is compared, and a worktree's
code stays read only.

Beside a chat it is the chat's code, and there is no Save: what is typed goes straight into the
chat, and keeping the chat's changes is the only step, as in the old app. `chat/code/` holds it,
plain and tested, with no React: `ChatSession.holdCode()` makes a `ChatCode` (`useChatCode`), fed
the history back to the last keep, however far back that is, in pages as large as may be
(`epochCode`), and each row of the chat's change stream as the
server took it (`changeStream`, which waits out gaps and finishes a keep's last rows before the
next generation), with what is edited here on top (`localEdits`): one change sent at a time, as it
was should it fail, and moved past everyone else's with the shared `transformCodeChange`. Its first edit to a gadget declares the commit it is shown over as its pin.
The client never holds the chat's files: the changes compose without them, and a file's text is
read at its commit only as it is shown (`useChatGadgetCode`, `gadgets/chatCodeFiles.ts`), with the
changes on top. What the chat changed, compared with what it last brought in (the pin's
`mergedCommit`), is listed over the tree as Changes, and a file that changed shows as its change,
in one column, as soon as it does, typed in there too: the editor takes the diff on in place
(`CodeEditor`), so typing in a file that this makes a diff keeps the caret, focus and undo, and,
unlike a file opened as its diff, folds nothing away; the status line says it is only in the chat until kept
(`gadgets/useLiveCodeEditing`). The editor reports each edit as CodeMirror's ChangeSet, which is
the wire's `TextChange`, and takes text from outside in as the span that differs, so that the
agent's or someone else's edits never move the caret. An edit is over what was drawn
(`ChatCode.shown`), so what arrived before it was drawn is moved past it; one that cannot be taken,
as when the agent began meanwhile, is undone in the editor. It can't be edited while the chat's agent
works. One not sent while the conversation reconnects is tried again as long as that takes, without
saying so; one refused is tried three more times, waiting longer each time, and then what was
edited is undone and that is said, and the chat read again, as edits lost with the chat's changes are: discarded, or not
matched, where the stream started over from the history, as after waiting too long for the last
rows of a keep. Only what the server cannot have is said to be lost: what was not sent yet, or was
refused and waits to be sent again, and what was on its way only once the server says it did not
take it. A page of the history that could not be had is read again a while later.

On the gadget's own page it is as kept, and is edited as `plans/code-editing.md` designs it: a
draft per gadget (`gadgets/codeDrafts`, tested, kept for the tab's life, a `beforeunload` warning
while any is left) that is saved or discarded by hand, never on its own. Each file of it is dotted
in the tree and quick open, and the status line counts it beside Discard (which asks) and Save.
Saving (`gadgets/saveCode`, tested) reads the head first and stops, naming the files, where someone
changed one the draft changed since it was read, offering to discard the draft's or save it
anyway; otherwise it is one `submitCodeChange` of whole files (`toChange`), pinned at the head,
then `mergeChanges`, through the last chat this device made for it (`prefs/editChats`) while it
can take it, else a chat made with the agent off, saying what was edited, titled "Edits to …". A
stale keep is taken back out of the chat (`revertChanges`) and checked again, once
(`gadgets/useCodeEditing`). The scripted chats' server keeps a chat's code as the real one does
(`chat/mock/MockChatCode`), so the `output` scenario's gadget can be edited beside its chat and on
its page, and its scenario menu has someone else change its client.js, for a conflict; the gallery
has each state.

A worktree (a repository an agent checked out, `WorktreeSummary`) is shown as its code
(`WorktreeView` over `CodeBrowser`, read by `aside/useWorktree`): as kept (`pinBase`), opening on
everything its agent changed since it was made (`baseCommit` to `pinBase`) where there is any,
which leads its history, then its agent's commits (`getCommitLog` from `headCommit`, back to
`baseCommit`). The `worktree` scenario plays one, and the `output` scenario's gadget has a history
of its code to view.

A file is shown as what it is (`aside/filePreview.ts`, tested; `FileView` draws each kind): an
image, audio, video, Markdown, and text or code as written. A PDF is drawn page by page with
pdf.js (`PdfPreview`), white sheets on the pane as a Word document's are, each drawn only while near
the screen and given up again far from it, with its text laid over it to select and find
(`pdfTextLayer.css`, pdf.js's own rules) and its web links followed. A Word document, PowerPoint
deck or Excel workbook (the Open XML formats only) is drawn in its own layout from its bytes, and a
CSV or TSV as a grid (`blocks/file-preview/`, `DrawnPreview`): read
in a worker (`officeReader.ts`) by `@gadgets/office-content`, so a crafted file stalls only the
worker, and each previewer loaded on first use. A file's tile in a message or the composer shows a
glimpse of its first page, slide or sheet, or of a PDF (pdf.js) or text, made once the tile nears
the screen (`useFileThumbnail`); a message's tiles fetch through `ChatSession.attachmentContent`,
which keeps the last few so that opening one fetches nothing again. Google's own files are not
drawn here: they open in Google. Anything else offers its download, which the pane's more menu has for every file. The bytes come
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
sidebar and the page, which are made inert: beside the page, expanded or not, as much as as the
page, with the same button, and left behind with the page. The card leaves its place (which is
kept, to go back to) and grows to the window's edges by animating the edges themselves, not a scale,
so the gadget is laid out at each size rather than stretched, and its frame is never moved in the
document, which would reload it. Escape leaves full screen, also from inside the gadget, whose page
passes the key on.

The header then has what it has out of full screen but for Hide and Chat: the way out is the
button full screen was gone into by. The header is put away and had back by the bar as beside the page; doing so squares off the surface's top corners
as it goes, so they are square at the window's top. Gone into full screen, it goes away by itself
after a second, the once: brought back, it stays, and leaving full screen brings it back if it went
by itself and nobody has taken hold of the bar since. Taking hold of the bar in that second is
choosing for it. While the header is away the bar fades out, and comes back as the pointer nears
the window's top (100px, `usePointerNearTop`) or the keyboard comes to it. A gadget's frame keeps
its pointer from the app, so its page's runtime says where the pointer is over it, at most once a
frame (`pointerAt`), which only shows the bar.

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
beneath the page, on the backdrop. On the pages it goes to (home, a workspace, Library, Automations,
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
big as it gets: it does not expand or go full screen, and the step down is that back button. It
fills the window, so the bar squares off its surface's corners as in full screen. The scripted
chats (`/mock/*`) are laid out the same way on a narrow screen.

## Theming

This app restyles Kumo at the token level, in `src/theme.css` only. That is a deliberate departure
from `workshop-frontend`'s ban on token theming, which predates this rework. Components and blocks
use Kumo semantic tokens (`bg-kumo-canvas`, `bg-kumo-base`, `ring-kumo-line`) and never colour
literals. Wrap a Kumo component only for what tokens cannot change, such as sizes and hit targets.

- Page backdrop: `kumo-canvas`. Content card: `kumo-base`. The composer: `kumo-elevated`.
- Dark follows the system: `index.html` sets `data-mode` on the root before anything is drawn, and
  keeps it in step. The shared tokens are `@gadgets/ui/styles.css`'s, and this app's own are in
  `theme.css` over them; each is a `light-dark()` pair, and the rules that derive dark from light
  are written at the top of the shared file. Keep to them, so that what matches in light matches
  in dark.

## Shared components: `@gadgets/ui`

The components this app shares with the Context Library's app (buttons, lists and their view,
menus, dialogs, the page layout, settings rows, motion) live in `@gadgets/ui`: a change to one goes
there, as `packages/ui/AGENTS.md` describes, and a new one starts here until a second frontend
needs it. Shell and layout code is expected to stay here. The app gives the package what it keeps
for the user, in `main.tsx`: the motion level (`provideMotionLevel(chosenMotionLevel)`, from
`prefs/motion.ts`) and where each list's view is kept (`ListViewPrefsContext` with
`keepListViewOnDevice`, from `prefs/listView.ts`). `styles.css` imports `@gadgets/ui/styles.css`
after Tailwind, with `packages/ui/src` as an `@source`.
