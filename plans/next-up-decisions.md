# Next up: what the new app does about what the design has not drawn yet

`next-up.md` lists what the product has that Balint's `workshop-app` and his Figma do not yet
answer. For each, this says how he would most likely fold it in, judged from his code and its rules
(`packages/workshop-app/AGENTS.md`), what the kernel needed, and what was cut. The Figma API was
rate limited for this work, so the Figma-derived prototype (`backup/b-figma-balint-pre-rebase`) and
`plans/chat-first-redesign-assumptions.md` stood in for it.

His idiom, as it bears on all of them:

- The conversation is what was said. How the agent got there is never a row: it is the status
  while it works, and the message's details after.
- Few places, each with one job: the sidebar (recents, Workspaces, Library, Search), a page per
  thing, settings as rows in rounded groups, dialogs that grow in. New places are tabs of the pages
  that already exist before they are new pages.
- Plain words about the user's things ("Updated Tip Jar"), never the machinery ("Wrote client.js").
- Everything that can fail says why where it happened, and nothing is tried over a lost connection.
- Protocol in plain, tested classes; blocks take plain props; every block in the gallery.

Each feature is one commit. Kernel changes are kept small and listed under each.

## 1. Skills

**What exists.** Skills are `SKILL.md` documents in Context Library collections (gatekeeper-context).
A collection is private (its creator's, shareable as viewer, editor or owner) or public (made by a
deployment admin, read by everyone: the org's). The management API (`ContextApi`) is reached as the
`ui` of `getGatekeeperApp("context")`. A user invokes a skill as a slash command
(`listSlashCommands`, a `SlashCommandRequest` in `sendChatMessage`), and the agent reads one by
itself through code (`env.CONTEXT.read`), which records an observation titled `Context read: name`
and nothing a person would recognise.

**Decision.**

- Skills are a tab of the Library, beside what the user's chats made: they are the user's own
  things too, and a fifth sidebar button would be the first one not about where work happens.
  Collections are the tab's groups, named as people think of them: "Yours", one group per
  collection shared with you, and the org's under "For everyone". A user with one collection never
  sees the word: their first skill makes "My skills".
- A skill has its own page (`/skills/<id>`), laid out as a gadget's settings are: its name in plain
  words (`meeting-brief` reads "Meeting brief"), renamed in place; when the agent should use it;
  and what it says, rendered as Markdown and edited in place. Use in a chat starts one with it.
- New skill is a dialog: name, when to use it, what it says, and which collection when there is
  more than one to put it in. Sharing is per collection, from its group's More, in the sharing
  dialogs' idiom.
- In the composer, `/` at the start of a word opens the skills (and Compact, in a chat) above the
  composer, filtered as typed; arrows, Enter or Tab, Escape. The + menu names the first few and
  offers "All skills", which types the slash. A chosen skill sits above the draft as a line of its
  own, as a reply does, and what is typed under it is what the skill is given; Backspace at the
  start, Escape or its × takes it off. Files cannot go with a command, and a command cannot steer a
  running agent: the line says so in its place. A command typed out in full (`/meeting-brief for
  Tuesday`) goes as one too. A new chat offers the Library's skills before it has a workspace,
  and the workspace the first message makes resolves the same id (`collection/path`).
- The agent's use of a skill, asked for or not, is said. A skill asked for is the `/meeting-brief`
  chip in the user's message. One the agent picks up itself is its step, "Used Meeting brief" with
  the skill's scroll, and a quiet "Used Meeting brief" line at the top of the reply it shaped;
  the steps stay in the reply's details.

**Kernel.** `ObservationDescription.skill` (the skill's name, from the context gatekeeper's read),
so the client can say a skill was used without parsing titles.

**Cut.** Supporting files beyond `SKILL.md` are not shown or edited. Git-backed collections and git
tokens stay in the gatekeeper's own app. A slash invocation's own read records no observation (the
server reads it before the turn), so its reply has no "Used" line; the chip above it says the same.
A live "Reading the … skill" status was dropped: the read is instant, and the step appears at once.

## 2. Library previews

**What exists.** Library rows and tiles show a picture only for image files; everything else is a
glyph. The chat already draws real thumbnails for PDFs, Office files and text (`file-preview`), and
the kernel can render a gadget in a browser (exports). Nothing makes a picture of a gadget.

**Decision.** Everything shows what it is. Files use the chat's thumbnails. Gadgets show a picture
of their UI, rendered by the server and kept until their code changes; one with no UI, or a
deployment without browser rendering, shows its format's glyph on its tile as now. Google files
show the top of their real first page, read through the connection the workspace reaches them by
and drawn the way the page beside a chat draws them. A preview is asked for only once its tile
nears the screen, and gadgets two at a time, since each may take a browser of the server's. A
preview sits under the tile's name on a frosted foot; an image file still fills its tile. Rows keep
their glyphs: a preview at row size says nothing a glyph doesn't.

**Kernel.** `GadgetClient.getThumbnail()`: a JPEG of the top 1280x800 of the gadget's UI, rendered
by Browser Run and kept in the overseer's `thumbnails` table for the commit it was taken of. A
failure is kept too and tried again after an hour, so a gadget that can't be drawn isn't drawn on
every look; two looks at once share one drawing, and drawings run one at a time per workspace.
Refused wherever `export()` is (a view-only client). Built.

## 3. Automations

**What exists.** Hooks are listed per workspace (`listHooks`), scheduled tasks across the account
by the scheduler's read-only management API, with no way to join the two. The new app shows hooks
only on a gadget's Connections tab, toggle only.

**Decision.** "Automations" for both, as the prototype names them. A Library tab lists every
automation across the user's workspaces; a workspace's page, a chat's settings and a gadget's
settings each have an Automations tab with theirs. A card says what it does, when it runs next in
words ("Every weekday at 9:00 · next tomorrow"), where it reports, and has its switch and Delete.
The chat's header shows a clock while it has one.

As built, an automation is a settings row rather than a card (`AutomationRow`, in a `ListGroup`
under "Scheduled" or "When something happens"), since a tab of them is a list to scan: a clock or a
bolt, the name, "Every weekday at 9:00 AM · next tomorrow at 9:00 AM" (on the schedule's own clock
when it is kept in another time zone, which the cadence names), what it does, and where it reports
as a link. A retry and a stop are said in the warning colour; a paused one dims and says Paused.
The Library's tab reads every workspace the user builds in (one only looked at keeps its hooks to
itself), four at a time, and is searched and ordered with the Library's toolbar. A chat's tab has
what runs in it and what its cards set up for a gadget; a gadget's, what runs its code, moved off
its Connections tab. The chat's own card now says a schedule with a clock and drops "Hook:".
There is no "New automation" button: one is set up by asking a chat, which already knows how.

**Kernel.** `HookTargetMetadata.hookId`, which the scheduler keeps and its management list returns,
so a schedule is matched to its hook exactly; and `BoundHookInfo.vendorId`, so a paused schedule,
which the scheduler forgets while it is off, is still known as one. Built.

## 4. Adding connections to a chat or a gadget

**Decision.** The + menu's Add a connection opens the connect dialog the agent's requests use, and
the chosen resource sits above the draft as a line, sent with the message as a capsule: the chat
then has it. A chat's settings gain a Connections tab listing what it can use. A gadget's
Connections tab gains Add, binding straight to the gadget.

As built, Add a connection opens a chooser first (`AddConnectionDialog`): each kind of resource the
services offer, a row with the service's logo, "Your services" before "More services", searched by
service or kind. Choosing goes on to the agent's dialog, its line saying "Choose which repository
this chat can use." and with Back. The draft's line has the logo, which one and "GitHub
repository", and an X; a skill chosen with connections says on its line that the two cannot go
together, as files already did. The chat's Connections tab has no Add of its own, since the + menu
is where a chat gets more, and says so when it has none; it groups "In this chat", "From the
workspace's gadgets" and "Always there". Home's and a new chat's composer do not offer it: there is
no workspace to make the connection in until the first message goes. Built-in services are left
out of the chooser, as every chat has them.

**Kernel.** None. Built.

## 5. Model selection

**Decision.** The design's composer has no room for a picker, so it is a row of the + menu, as the
prototype had it: Model, with the current one's name, opening the list. A chat keeps answering with
the model it last used; a new chat starts with the user's default, and choosing one there makes it
the default. The profile page has the default too.

As built, the row is Model, the current model's name and a caret, after Add a connection; it
swaps the menu's rows for the models in place (the morph follows the new size), with a Back row
named Model and a tick in the icons' column. The keyboard lands on the chosen model, and Back on
Model. With one model there is nothing to choose and no row. "No agent" (a chat no model answers)
is cut: the new app is a conversation with the assistant, and the classic Workshop keeps it.
Choosing in an existing chat lasts until it answers, after which it is the chat's own model; a
retry goes to the same model. A new chat whose choice cannot be saved as the default still starts
with it, and says why under the composer. The profile's default (§9) uses the same `useModels`.

**Kernel.** None (`getPreferredModel`, `setPreferredModel`, `activeAgent`). Built.

## 6. Gadget exports

**Decision.** Export is in the gadget's More beside the page and in full screen, and on its
settings. Formats are read when the menu opens; the download says it is under way in the pane's
header and says why if it fails.

As built, Export is a row of the pane's More that shows the formats in the menu's place, the way
Model does in the + menu ("Reading its formats…", then "HTML .html", "PDF .pdf"; "It can't be
saved as a file" or why it could not be read, with Try again). The progress moved from the header
to a pill at the foot of the pane, "Exporting PDF…" in the shimmer the assistant's status uses: a
narrow pane's header has no room beside the title, and the pill stays while the header is pushed
away. A failure stays in the pill with why until dismissed. The browser asks where to save while
the click still counts, where it can, and the file streams there; elsewhere it downloads, named
for the gadget. The settings row ("Save it as a file: HTML or PDF") is for anyone who can open the
gadget, and appears once its formats are read. A gadget shown from a chat exports as that chat
proposes it.

**Kernel.** None. Built.

## 7. A chat in a workspace, and a chat on its own

**Decision.** A chat started from Home is a chat on its own; its workspace is never shown, as in
the prototype. A workspace is made on purpose and named. Home's composer says where the chat goes
("No workspace" or a workspace), the way the prototype's picker did. A chat on its own is drawn
in the sidebar with a chat glyph and no workspace name, its crumb is the chat alone, and its
settings can make it a workspace once it outgrows being one chat.

As built, the kernel already kept a kind (`WorkspaceMetadata.kind`, set by `newWorkspace({kind})`),
which only a named workspace has; the old Workshop's prototype read it the same way
(`isNamedWorkspace`), so a workspace made before kinds were kept is a chat on its own, and its
settings make it one again. The picker sits under Home's composer rather than in it: the design's
composer is one line with no room for a chip, and a quiet pill under it ("No workspace", a caret)
says where the chat goes without competing with what is typed. Its menu has No workspace ("A chat
on its own"), the user's named workspaces (not those they were only given an app from), starred
first, and New workspace. A chat on its own is drawn with the cloud mark of the Figma (node
762:426), a little smaller than the folder so the two weigh the same; its row says only when it
was active. Its settings' Settings tab has "Make it a workspace", which asks for a name starting
from the chat's own and may keep it; its sharing says "chat" where a workspace's says
"workspace". A blueprint used from its page still makes a workspace for itself, as before.

**Kernel.** `Overseer.makeWorkspace(title)`: names an unnamed workspace and marks it as one, in the
workspace, the owner's list, and its metadata subscribers. Built.

## 8. Blueprints

**Decision.** One Blueprints page: featured ones, then yours (published and saved), searched by
name, each a tile with its picture. A blueprint has its own page: its picture, what it is, what it
needs, and Use, which sets up what it needs and makes it in a new workspace or adds it to one.
Home offers a few featured ones under the composer. Publishing takes the gadget's picture.

As built, the page is a tab of the Library rather than a page of its own in the sidebar. A new
place in the design is first a tab of a page that is already there, and the kernel already calls a
saved blueprint "in the library" (`addBlueprintToLibrary`), so Blueprints sits beside Skills and
Automations. The tab shows Featured, then Yours (published or saved, not already featured), as
tiles with their pictures. A tile with no picture shows the glyph and noun of what it makes. A
blueprint's page leads with its picture at full width, then its name, who published it and when,
what it is for, and a list of what it needs, each with its service's logo. Its header has Save
(not for one's own), Use, and a More menu with Copy link, Download file and Open its workspace.
Use is one dialog with a row for each need: a connection opens its service's own form and comes
back with a tick; a model or an agent's model is a menu, starting with the author's suggestion
where the user has that model, else their default ("No agent" is a choice only for an agent). A
blueprint with needs is made in a new workspace named after it, and marked as a workspace so it is
listed with them. One with no needs can instead go into a workspace the user builds in. Either way
the gadget opens at once. Home shows three featured blueprints under the composer, those with
pictures first, in the space below it so the composer does not move when they arrive. Publishing
draws the gadget's picture as the dialog opens, shows it, sends it (if under the server's 1 MB
limit), and afterwards offers Open blueprint. Upload in the tab's header takes in a `.gadget`
file. The no-access screen's blueprint card stays unwired: a gadget the viewer cannot open does not
say which blueprint it came from.

**Kernel.** None. The gadget picture is `getThumbnail()` from §2, sent with `createBlueprint()`'s
existing `screenshot` argument.

## 9. The user's profile

**Decision.** The account menu's first row opens the profile: picture, name, default model, usage,
and password, as settings rows.

As built, the account menu's first row is the user's picture, name and "Your profile", and opens
`/profile`. The page is laid out the way a gadget's settings are. At the top is the picture, large,
with a camera at its foot that offers Choose a picture (cropped square and compressed to the
server's 50 KB) and Remove picture. Under it is the name, renamed in place, and "Signed in as"
with the id. Then come three groups. Chats: the default model (a menu; the same preference a new
chat's + menu sets).
Usage: AI spend, the sum of `totalCost` across the workspaces the user builds in, saying where most
of it went; and, only where the deployment limits use, today's free allowance as a meter, with the
balance of a Cloudflare account that pays for more. Signing in: Change password (only for an
account with one; the current password, then the new one twice, at least 8 characters, hashed as
sign-in hashes it) and Sign out. The profile is one store for the whole app (`ProfileProvider`), so
a new name or picture shows at once in the sidebar and in Home's greeting. The commit email is
cut: the classic Workshop doesn't offer it either, and nothing in the new app shows a commit.

**Kernel.** None.

## 10. Not in the design yet

What the classic Workshop has that the new app leaves out, and what to do about each. None of it
is needed for the chat-first flows built above, and nothing here was dropped by accident.

- **Signing in and signing up.** The app uses the session the classic Workshop left, or the dev
  account. It needs its own sign-in page before the router serves it. *Later, required.*
- **AI providers and models of one's own** (`addModel`, keys, the gateway's providers). The profile
  picks among the models there are. Adding one belongs on the profile as a Models group. *Later.*
- **Code**: a gadget's files, its commits and diffs, and going back to a commit. The agent changes
  code and a chat's cards show what it did. A read-only Code tab on a gadget's page fits the design
  when it is wanted. *Later.*
- **Keeping a gadget up to date with its blueprint** (`applyBlueprint`, the update offer), and
  managing a published blueprint (update it, retry a failed publish, delete it). Publishing is
  built. These belong on a gadget's Settings tab. *Later.*
- **Activity and agent runs**: the workspace's action history and the runs of agents a gadget
  starts. A chat's cards and the Automations tabs cover what most people look for. *Later, as a
  workspace tab.*
- **Standing approval rules** (always allow this action), set from a card and managed in a list.
  Cards offer it already; there is no list of the rules yet. *Later, on the Connections page.*
- **Gatekeeper management apps** other than Skills and Scheduled Tasks (`/gatekeepers/<app>`), and
  observer configuration. *Classic Workshop for now.*
- **A gadget's console log.** A developer tool. *Cut from the new app.*
- **Choosing which Cloudflare account pays, and topping up.** The profile shows the allowance and
  the balance. *Classic Workshop for now.*
- **Pinning blueprints to Home** (`setBlueprintPinned`). Home shows featured blueprints, and saving
  keeps one in the Library. *Cut.*
- **Dismissing a workspace shared with you** from the list (`dismissSharedWorkspace`). *Later, in a
  workspace row's menu.*
- **The unread page** (`/unread`). The sidebar's unread marks cover it. *Cut.*
- **Onboarding.** Home's greeting and its featured blueprints are the start. *Cut.*
- **Admin settings, deployment updates and the admin audit.** *Classic Workshop.*
- **Browser push and the native app's device handoff.** *Later.*
- **The blueprint card on "You don't have access".** The kernel does not say which blueprint a
  gadget the viewer cannot open came from. *Needs the kernel, so it waits.*

## 11. Approvals: one tray, reviewed on the file

Approvals were cards at the end of each turn. Five appends to one Google Doc made five cards, and
with a few waiting the newest pushed the oldest off screen, where the agent still waited on them.

- **One place for what waits.** A tray over the composer, which is where the eye is when the agent
  stops, holds every approval waiting in the chat, whichever turn asked. It is never scrolled away,
  and it goes once nothing waits. The transcript keeps only what was decided.
- **By what it changes, not by request.** The tray has a row per thing (a Google Doc, a Jira board),
  counting its changes, and the amber dot pulses while the agent is held. The decision people make
  is about the thing ("is this what I want in my doc?"), so that is the unit.
- **A file is reviewed on the file.** From the old prototype's draft review: a Google Doc, Sheet or
  Slides deck that exists opens beside the chat drawn as it will be, and a bar over its foot steps
  through the changes in place, deciding one or all. We kept the bar, lean, because grouping takes
  the single changes out of the tray (denying one append of five happens here), and on a phone the
  file covers the chat. On a wide screen the tray's row says the file is open beside, rather than
  offering Review again.
- **A new file is reviewed whole.** From the old prototype too: a Google Doc, Sheet or Slides deck
  the agent wants to create is drawn as it will be made, with its slides or text, and the bar
  offers Create or Discard rather than stepping through edits to something that does not exist.
- **Order is kept.** Approving goes oldest first, so an edit never lands before the one it builds
  on; denying newest first. A run stops at the first failure and says which and why.
- **Decided runs fold.** "Append to Google Doc, 5 times · Approved", unfolding to each request.
- **Restricted workspaces** keep their rule: each request is read in full, and there is no Approve
  all.

No kernel change: it is all the chat's history and `approveAction` / `rejectAction` as they were.

## 12. Sharing: a snapshot, or live

Sharing a dashboard built on a data warehouse with a team that has no access to the warehouse
should let them see what the owner sees, without letting them reach the warehouse. The person
sharing takes that responsibility, knowingly.

- **Two ways to hold a gadget, chosen per person.** "Can use" opens it live, with the owner's
  data, once the person confirms with their own account on each service that they can see what
  it reads (observer verification: their account is checked, never used in the owner's place);
  "Can view" is a snapshot of the owner's data, reaching nothing, so nothing is asked of the
  viewer. The kernel has this as shared views (`CollaboratorGrant.viewOnly`, `GadgetView`), where
  an admin turns it on.
- **Show the sharer what people get: the real thing, not a picture.** The reason both prototypes
  put a preview in the dialog (Option B's card, Max's `ShareSnapshotPreview` in #1077) is that a
  gadget's screen is code, rendered from whatever is in its storage. Nobody can know from a
  description whether the snapshot shows the numbers, or an empty state because the UI reads
  through a binding the copy does not have. So a card under who has it ("Viewers see a snapshot ·
  2 people · from 12 min ago", with the gadget's picture) opens the dialog's second page, "What
  people see": the owner's view itself (`GadgetClient.openView()`, which takes it again first),
  running in a frame at 0.6 scale, as #1077 does, so a page laid out for a window reads as itself.
  It can be used, since what is done in the copy is overwritten when it is next taken. Under it the
  two tiers, each saying what it costs the recipient, with the connections listed by service. The
  card appears only for a gadget that reads from a connection that needs a sign-in.
- **Honest about freshness.** The snapshot is taken again when the owner opens the gadget or this
  page (`viewTakenAt`), and a failed update says so (`viewUpdateFailedAt`). "Always up to date"
  from Option B is not true of the kernel, so it is not said.
- **Not done.** "Ask the agent to fix it", for a snapshot that comes out empty (Option B, unwired
  in #1077): it needs a way to start a chat with a draft, which the app does not have yet. And
  #1077's refreshable per-person snapshot for every recipient, which is a kernel change of its own.

**The workspace invite.** Its note said whoever opens it "uses their own Skills, Scheduled Tasks
and Google Drive accounts with it". Both halves were wrong: their accounts are only checked, and
Skills and Scheduled Tasks set themselves up. It now names only services that need a sign-in:
"Anyone who joins confirms with their own Google account that they can see what this workspace
reads. If they can't, give them access in Google first."

No kernel change.

## 13. Accepting changes, and changes that go ahead on their own

The write-up with three prototypes to try (two chats finishing on one gadget, an account's rules,
and the proposed per-account default) is `plans/approvals-prototypes.html`; open it in a browser.

Two different things wait for the user, and the design keeps them apart because they carry
different risks:

- **A chat's changes to its gadgets** (code) are like a git worktree: proposed in the chat, then
  kept into what everyone uses. Undoable, and invisible to anyone outside the workspace.
- **A connection's changes to the world** (a Doc edited, an email sent) are approvals, one action
  at a time. Some cannot be taken back.

**Keeping a chat's changes: the default is to keep them, without asking.** Already the behaviour
(`chat/autoAccept.ts`), and now simpler: chats are kept as they finish. The old rule held a chat
back whenever another chat had changes waiting to the same gadget, which meant a person with two
chats on one tracker was asked about both, for no risk to either. Now the first to finish is kept;
the second, when its turn ends, brings in what the first kept and is kept on top of it if that
merges cleanly. Only three things still ask: a conflict (named by file, "Look over the conflicts
before keeping them"); a binding, a blueprint update or a bring-in the user asked for, which are
theirs to decide; and a workspace someone else is in, whose work in progress keeping could
overtake. A non-technical user never sees the words merge, branch or worktree. Undo stays one
click, on the answer that ended the turn.

Not done, and why: letting the agent resolve conflicts on its own. It can (the markers are in its
files), but the user then keeps code neither of them looked at. The question names the files, and
"ask the agent to combine them" is one message away. Worth revisiting once there is a way to start
a turn with a drafted message.

**Changes through a connection: ask first, unless the user said otherwise, per service.** The
kernel has four ways for an action to go ahead unasked: the owner's default for a kind of change on
a service, across every workspace they own (new, `setDefaultAutoApprovedActionKind`); a rule per
kind on one connection in one workspace (`setAutoApprovedActionKind`, "Always approve" on a
request); a chat in Auto; and a gadget in Auto. The defaults are what the account's page (§14)
sets. Workspace rules stay as exceptions, shown under the kind they apply to ("Automatic in Trip
planner", with Ask there too). A chat's or a gadget's Auto is not offered: it is a third and
fourth place to look when something went ahead unexpectedly. Every one of them is off while a
workspace has read sensitive data, and the page says so.

**How the defaults work (kernel).** A workspace does not record which of the user's accounts a
connection came through, so a default is keyed by service (`vendorId:tag`), not account: two
Google accounts share one. The user's object keeps them (`autoApproveDefaults`) and pushes them to
every workspace it owns whenever they change; a workspace also reads them again as its owner opens
it, which covers workspaces made afterwards and a push that did not arrive. The overseer applies
them only to connections of that service, only to actions their gatekeeper marks
`autoApprovable`, and only for the owner: in a workspace shared with them, the owner's defaults
apply, not theirs. Setting one drains what is waiting. The page lists every kind the service can
make, not only those a workspace has met: gatekeepers now declare them in
`SupportedResource.actionKinds`, including the ones that always ask (Send email), which the page
shows as "Always requires approval" so that nothing is left unsaid. Integration tests in
`auto-approval-policy.test.ts`.

## 14. Each account gets a page

The Connections page, now called Gatekeepers (`/gatekeepers`), opens a page per account
(`/gatekeepers/$accountId`), the home for standing permissions. Top to bottom:

- The service, which account, and whether it is signed in; Reconnect when it is not.
- **When it changes something.** "Reading never asks." Then every kind of change the service can
  make, grouped by what it changes (Gmail, Google Doc, Spreadsheet), each **Ask first |
  Automatic**, holding in every workspace the user owns, or "Always requires approval" for those
  that can never go ahead alone. Kind labels from gatekeepers ("Slide text edits, in any
  presentation this connection reaches") read as a title and how far it reaches. A workspace rule
  that goes further than the default shows under its row, with Ask there too.
- What it can reach, five until "Show all" (Google has thirteen), with more to grant.
- Disconnect, asked first.

An earlier version set rules per workspace, a group per workspace. It answered the wrong question
("what may this account do in Trip planner?") and only listed kinds a workspace had already met,
so a Google account showed Drive edits and nothing of Gmail.

**Kernel.** One line of behaviour: `listPreApprovableActions` now covers every connection the
workspace holds, not only those a gadget binds, since connections added to a chat (where Google
edits happen) were missing, so their rules could be set from a request but never seen again. It
also reports an ambient connection's vendor. Integration test in `auto-approval-policy.test.ts`.
