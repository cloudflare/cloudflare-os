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

**Kernel.** None.

## 7. A chat in a workspace, and a chat on its own

**Decision.** A chat started from Home is a chat on its own; its workspace is never shown, as in
the prototype. A workspace is made on purpose and named. Home's composer says where the chat goes
("No workspace" or a workspace), the way the prototype's picker did. A chat on its own is drawn
in the sidebar with a chat glyph and no workspace name, its crumb is the chat alone, and its
settings can make it a workspace once it outgrows being one chat.

**Kernel.** `Overseer.makeWorkspace(title)`: names an unnamed workspace and marks it as one.

## 8. Blueprints

**Decision.** One Blueprints page: featured ones, then yours (published and saved), searched by
name, each a tile with its picture. A blueprint has its own page: its picture, what it is, what it
needs, and Use, which sets up what it needs and makes it in a new workspace or adds it to one.
Home offers a few featured ones under the composer. Publishing takes the gadget's picture.

**Kernel.** None beyond the gadget picture.

## 9. The user's profile

**Decision.** The account menu's first row opens the profile: picture, name, commit email, default
model, usage, and password, as settings rows.

**Kernel.** None.

## 10. Not in the design yet

See the end of this file, which lists what the product has and the new app leaves out.
