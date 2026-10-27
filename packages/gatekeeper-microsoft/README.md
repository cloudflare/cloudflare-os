# Gatekeeper Microsoft 365

Connects Microsoft 365 work and school accounts to Gadgets, for [SharePoint and
OneDrive](#sharepoint-and-onedrive), [Outlook](#outlook) mail and [Outlook Calendar](#calendar), all
through one connection. Agents act with the user's **delegated** permissions, so they never see more
than the user can open themselves, and each binding narrows that further. Every change goes through
the approval workflow, where the user may let a kind of change be auto-approved, except sending mail
and anything that mails a meeting's attendees, which are never auto-approved. A change shows to the
agent as though already made while it waits, so the agent keeps working.
`plans/microsoft-365-gatekeeper.md` is the design record.

## Setting up the app registration

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **App registrations →
   New registration**.
2. For supported account types, choose **Accounts in this organizational directory only**; a
   multitenant deployment (`MICROSOFT_TENANT_ID=organizations` with `MICROSOFT_ALLOWED_TENANT_IDS`,
   below) needs **Accounts in any organizational directory** instead. Then add a **Web** redirect
   URI, `{PUBLIC_BASE_URL}/gatekeeper/microsoft/oauth`.
3. Under **API permissions**, add these Microsoft Graph **delegated** permissions:
   - `openid`, `profile`, `email`, `offline_access`, `User.Read`
   - `Sites.ReadWrite.All` and `Files.ReadWrite.All`, or `Sites.Read.All` and `Files.Read.All` for
     a read-only deployment. To reach only sites your SharePoint admin chooses, use `Sites.Selected`
     and `Files.ReadWrite` instead: see [Every site or only selected sites](#every-site-or-only-selected-sites).
   - for Outlook: `Mail.ReadWrite`, `Mail.ReadWrite.Shared`, `Mail.Send`, `Mail.Send.Shared`,
     `MailboxSettings.ReadWrite`, `People.Read` and `User.ReadBasic.All`. A deployment capped below
     `send` needs neither `Mail.Send` permission, and a `read` one needs only the `.Read` variants.
     `User.ReadBasic.All` turns a shared mailbox's address into its owner's object ID; without it
     only the user's own mailbox can be connected.
   - for Calendar: `Calendars.ReadWrite`, `Calendars.ReadWrite.Shared`, `MailboxSettings.Read`,
     `People.Read` and `User.ReadBasic.All` (or the `Calendars.Read` variants for a `read`
     deployment). Without the `.Shared` permission and `User.ReadBasic.All`, only the user's own
     calendars can be connected.
4. Select **Grant admin consent for `<organization>`**. Many organizations stop users from consenting
   to these permissions themselves. In that case the connect flow shows an admin-consent page with a
   link an administrator can open.
5. Under **Certificates & secrets**, create a client secret. Connections stop refreshing once it
   expires, so set a reminder to rotate it.
6. Set the deployment's inputs:

| Name | Kind | What it is |
|---|---|---|
| `CLIENT_ID` | secret | The app registration's Application (client) ID. |
| `CLIENT_SECRET` | secret | The client secret's **Value**, not its ID. |
| `MICROSOFT_TENANT_ID` | secret | The Directory (tenant) ID, or a verified domain. Only accounts in this tenant can connect. It isn't a credential, but the deploy wizard only collects secrets. |
| `MICROSOFT_ALLOWED_TENANT_IDS` | var, optional | For a multitenant app. Set `MICROSOFT_TENANT_ID=organizations` and list the tenant IDs (GUIDs) that may connect, comma-separated. `organizations` without this list is refused. `common` and `consumers` are always refused, because personal Microsoft accounts have no SharePoint. |
| `MICROSOFT_SHAREPOINT_ACCESS` | var, optional | `write` (the default) or `read`; unrecognized values mean `read`. This caps what agents may do whatever the app was granted: the effective access is the lowest of this, the connection's own grant and, for a file, folder or library, the user's own role on it, so something shared with them to view binds read-only. |
| `MICROSOFT_SHAREPOINT_SITES` | var, optional | `all` (the default) or `selected`; unrecognized values mean `selected`. Which SharePoint permissions a connection asks for: every site the user can open, or only the sites a SharePoint admin grants the app. See [Every site or only selected sites](#every-site-or-only-selected-sites). |
| `MICROSOFT_OUTLOOK_ACCESS` | var, optional | `send` (the default), `draft` or `read`, capping Outlook bindings the same way. Unrecognized values mean `read`. |
| `MICROSOFT_CALENDAR_ACCESS` | var, optional | `schedule` (the default), `edit` or `read`, capping Calendar bindings the same way. Unrecognized values mean `read`. |

### Local development

Put `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT_ID` in the root
`.dev.vars`. `pnpm dev-server` maps the first two into the worker's `CLIENT_ID` and `CLIENT_SECRET`.
It passes the tenant ID, `MICROSOFT_ALLOWED_TENANT_IDS`, `MICROSOFT_SHAREPOINT_ACCESS`,
`MICROSOFT_SHAREPOINT_SITES`, `MICROSOFT_OUTLOOK_ACCESS` and `MICROSOFT_CALENDAR_ACCESS` through unchanged. Register
`http://localhost:8787/gatekeeper/microsoft/oauth` as a Web redirect URI; Entra allows
`http://localhost` for Web clients.

## SharePoint and OneDrive

Agents browse sites and OneDrive, read files (Word and PowerPoint as Markdown, workbooks as
cells, and PDFs and legacy Office formats as text where the worker has its optional Workers AI
binding; without it agents are told to read the bytes instead), query lists and read pages. They can propose new folders and files, uploads,
in-place edits, renames, moves and deletions, and list item changes. `src/types.d.ts` is the
agent's API.

A binding covers one of these:

| Choice | Link | What it reaches |
|---|---|---|
| All of SharePoint & OneDrive | `https://<tenant>.sharepoint.com/_layouts/15/sharepoint.aspx` | Every site, library, list and file the user can open, now or later. |
| A site | `https://<tenant>.sharepoint.com/sites/<site>` | The site's libraries, lists and pages, but not its subsites. |
| A library or a OneDrive | `…/sites/<site>/Shared%20Documents`, `https://<tenant>-my.sharepoint.com/personal/<user>/Documents` | Every folder and file in it. |
| A folder | `…/Shared%20Documents/<path>` | Every folder and file inside it. |
| A file | `…/Shared%20Documents/<path>/<file>` | Just that file. |
| A list | `…/sites/<site>/Lists/<list>` | The list's columns and items. |
| A page | `…/sites/<site>/SitePages/<page>.aspx` | Just that page. |

Every ID an agent passes is checked against the binding before Graph is called, including a
folder's whole ancestry; a proven folder is remembered for a minute, never longer however often it
is reused, and a listing re-proves its folder for every page. Paths are measured from the top of
the binding, so a folder binding never reveals the library around it.

The configurator starts at **All of SharePoint & OneDrive**. The user can open a site or their
OneDrive to choose one part of it, search, or paste any SharePoint or OneDrive link. The OneDrive tab
also lists what others have shared with the user from their OneDrives, as **Shared with you**. Graph's
`sharedWithMe` is deprecated, so that list comes from Microsoft Search, which takes minutes to show a
new share and doesn't include files shared from a site; a link pasted into the picker always works.

### Every site or only selected sites

`MICROSOFT_SHAREPOINT_SITES` chooses between two ways of granting SharePoint:

| | `all` (recommended, the default) | `selected` |
|---|---|---|
| Permissions | `Sites.ReadWrite.All`, `Files.ReadWrite.All` | `Sites.Selected`, `Files.ReadWrite` |
| Reaches | Every site and file the user can already open | Sites a SharePoint admin grants the app, one by one, and the user's own OneDrive |
| Setup | Admin consent once | Admin consent, then a Graph call per site, and again for each new site |
| Shared with you | Yes | No |
| Read-only sites | Show as read-only where Microsoft reports it | Changes are refused when approved |

Either way an agent can never reach more than the user can open, and each binding narrows that
further. `all` is the better experience and needs no upkeep. Choose `selected` when policy requires
Microsoft itself to keep the app out of every site that hasn't been approved.

### Only selected sites

To set up `selected`:

1. On the app registration, add the delegated permissions `Sites.Selected`, and `Files.ReadWrite`
   (or `Files.Read`) if people should reach their own OneDrive, instead of `Sites.ReadWrite.All` and
   `Files.ReadWrite.All`. Grant admin consent.
2. Set `MICROSOFT_SHAREPOINT_SITES=selected`, so connections ask for those permissions.
3. Grant each site to the app. This needs `Sites.FullControl.All`, so a SharePoint admin runs it
   in [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) or PowerShell, signed in
   as themselves, with the app's Application (client) ID:

   ```http
   GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Engineering?$select=id

   POST https://graph.microsoft.com/v1.0/sites/{id from above}/permissions
   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<client ID>", "displayName": "Gadgets" } }] }
   ```

   Use `"read"` for a site agents should only read. `DELETE …/sites/{id}/permissions/{permission id}`
   takes the site away again, and revoking consent to `Sites.Selected` takes every site away at once.

Microsoft then lets the app into a site only if the user can open it *and* it was granted to the
app. The gatekeeper works by what a connection was actually granted, not by the setting, so a
connection holding both kinds of permission reaches every site. Under `Sites.Selected`:

- **All of SharePoint & OneDrive** means every granted site the user can open, and the Sites tab
  lists only the sites whose document library Microsoft opens. Microsoft answers for any site's name
  and ID, granted or not, so the library is the test. A site that hasn't been granted can't be found
  or bound, and a pasted link to one says to ask the SharePoint admin.
- The user's own OneDrive is offered only with `Files.Read` or `Files.ReadWrite`. **Shared with you**
  isn't offered, because nobody else's OneDrive is granted.
- Microsoft Search doesn't honor `Sites.Selected`, but every hit is read again as the user, which
  Microsoft refuses outside the granted sites, so hits from other sites are dropped.
- Write access is decided per site by its grant, which the gatekeeper can't read. A change in a
  site granted `read` is refused by Microsoft when it's applied.

### SharePoint approvals

Every change is an action that goes through the approval workflow; every SharePoint kind may be
auto-approved if the user chooses:

| Kind | Actions | Can be auto-approved |
|---|---|---|
| `sharepoint.files.create` | Create a folder, upload or copy a file | Yes |
| `sharepoint.files.edit` | Replace a file's content, edit a Word document or deck in place, set cells in a workbook | Yes |
| `sharepoint.files.organize` | Rename, move within a library | Yes |
| `sharepoint.files.delete` | Delete a file or folder | **Never** |
| `sharepoint.lists.edit` | Add or edit a list item | Yes |
| `sharepoint.lists.delete` | Delete a list item | **Never** |

A binding offers only the kinds it can submit, so a list binding offers no file actions. Changes are
fenced: a replace or delete is refused if the file changed after it was proposed (on its `cTag`),
and an item update if the item changed (on its `eTag`). A file or folder that has since been moved
out of what the binding covers is refused too, since a move leaves those tags as they were. A second
change to a file's content is refused while one awaits approval. A create, upload or copy whose name
turns out to be taken fails rather than adopting what holds it; a copy SharePoint hasn't finished
after 45 seconds is recorded with an unknown outcome (the copy still lands, so it is cleared by
rejecting it rather than retried). The approver sees a replacement as a unified diff when the file is
text and no larger than 64 KB. Applied actions can be reverted for 30 days:

- A replace or in-place edit restores the previous version, while the file is still as the edit left it (restoring replaces the whole file). A cell change puts the range back, while it still holds what was written.
- A create deletes what it made, unless a created folder has gained contents since; those were never part of the action.
- A rename or move is undone.
- An item update restores the values it overwrote.
- A deletion can't be reverted from here. Restore it from the site's recycle bin.

Things agents can never do, at any access level: share or create sharing links, change permissions,
change sensitivity labels, check files in or out, create or delete sites, libraries or lists, or
publish pages.

### Word, Excel and PowerPoint

Files are written in the format their name says, so they open, co-author, print and search like any
other in the tenant:

- **Word (`.docx`)** from Markdown, in Word's built-in styles (Heading 1–6, List Bullet, Table Grid,
  and so on): headings, nested and numbered lists, task lists, tables, links, quotes and code.
- **PowerPoint (`.pptx`)** from Markdown, 16:9: each `#` heading starts a slide, and a blockquote
  starting "Notes:" becomes speaker notes.
- **Excel (`.xlsx`)** from rows or CSV, with a bold, frozen, filterable header row. A string starting
  with `=` is a formula. Formulas that reach outside the workbook (WEBSERVICE, HYPERLINK, RTD, DDE,
  links to other workbooks) are refused. After an approved write, Excel for the web calculates the
  workbook, so previews, the PDF view and search show formula results, not empty cells.

A Word document or deck can take its styles, theme, page setup and masters from a template the
binding covers (`template`). Graph can't convert into Office formats, so the gatekeeper writes the
Office Open XML itself (`src/content/*-write.ts`).

A file passed as bytes is uploaded as it is, but held to what a written file has by construction
(`src/content/package-check.ts`): no macros, ActiveX or embedded objects, nothing fetched from
elsewhere when it is opened, no DDE, and no formula the writer refuses. The check goes by content
types and relationship types, and reads every XML part with the namespace-aware parser, since a
byte upload is approved on its name alone. Formats that can run code when opened are refused
outright: the macro-enabled and legacy binary families (`.docm`, `.xlsm`, `.pptm`, `.xlsb`,
`.doc`, `.xls`, `.ppt`, `.rtf`, their templates and add-ins) and any OLE compound file.

A whole rewrite of an existing Office file loses what Markdown or rows can't express. The approver is
told what it will lose, such as "3 images" or "comments". To change part of a file, agents edit in
place, and everything else is kept:

- `editDocument` makes find/replace, insert and delete-paragraph edits to a `.docx`. By default it
  records them as tracked changes for the owner to accept in Word, authored `<owner> (agent)`.
- `editPresentation` makes find/replace, add-slides and delete-slide edits to a `.pptx`.
- `updateCells` sets a range through Excel's own workbook API, so every other cell, format, chart
  and sheet is untouched.

The approver sees each edit as before/after lines and each cell change as `B2: old → new`. Reading
for an edit counts as reading the file, so the [observation rules](#sharing-a-workspace) apply to it.

To see what the writers produce the way people will, `scripts/office-render.ts` uploads files to a
scratch folder in the contract user's OneDrive, has Microsoft 365 render them to PDF, draws each page
to PNG with macOS PDFKit, and deletes the folder. From this package's directory:

```sh
node scripts/office-render.ts out/*.docx out/*.pptx --out /tmp/m365-render
```

## Outlook

Agents read, search and triage mail, write drafts, and send with approval, in the user's own mailbox
or a shared one they can open. `plans/microsoft-outlook.md` is the design record and
`src/outlook-types.d.ts` the agent's API.

A binding is one mailbox, optionally narrowed, at one access level:

| Narrowing | Link | What it reaches |
|---|---|---|
| The whole mailbox | `https://outlook.office.com/mail/` | Every folder. |
| A folder | `…/mail/inbox`, `…/mail/folder/<id>`, `?subfolders=0` | That folder, with its subfolders unless excluded. Resolved once, at binding, to an immutable ID, so renaming or moving it changes nothing. |
| A conversation | `…/mail/inbox/id/<message id>`, `?conversation=<id>` | Every message in the thread, wherever it is filed. |
| People | `?senders=ada@contoso.com,@fabrikam.com` | Mail from those addresses or domains, by its From and Sender headers, which the sender writes: a way to narrow what the agent reads, not a defence against spoofed mail. |

A shared mailbox's links put its address first, `…/mail/team@contoso.com/inbox`. Narrowings
combine, and `&access=read|draft|send` sets the level. Links copied from Outlook on the
web, including "Open in Outlook" links (`/owa/?ItemID=…`), are read as they are.

Every message ID an agent passes is read first and checked against the binding, so a narrowed
binding can't reach a message outside it by guessing or pasting an ID, and an approved move or
update checks its messages and destination again before writing, since a message keeps its ID
wherever the user moves it meanwhile. Drafts a binding wrote stay in it whatever its narrowing, so
a sender-narrowed binding can reply, and only those can be deleted through it. Junk Email, Deleted Items,
Outbox and the hidden folders are left out of narrowed bindings unless named. Mailbox settings
(automatic replies) need a whole-mailbox binding.

The levels:

| Level | Adds | Kind | Can be auto-approved |
|---|---|---|---|
| `read` | Reading, search, attachments (Office files as text; PDFs and workbooks too with the Workers AI binding), categories, people | — | — |
| `draft` | Move, archive, delete (to Deleted Items), mark read, flag, categorize, create folders | `outlook.organize` | Yes |
| `draft` | Create drafts, including replies and forwards that keep the quoted thread, and edit and delete the drafts it wrote (never the user's own, which an auto-approved edit could change under them) | `outlook.drafts` | Yes |
| `send` | Send a draft, a new message, a reply or a forward | `outlook.send` | **Never** |
| `send`, whole mailbox | Automatic replies, which answer whoever writes | `outlook.settings` | **Never** |

A `read` binding's session is an `OutlookReader`, with no write methods at all, and a `draft`
binding's an `OutlookDrafter`, without the send methods. Everything else is
an action, shown to the agent as though already applied while it waits, and reverted for 30 days
where Exchange allows: moves go back, flags, categories and read state are restored, folders and
drafts are deleted, a draft edit is undone, automatic replies return to what they were. An undo is
proved against the binding as applying was: a message or folder that has since left it is left as
it is. A send can't be unsent.

The approver of a send sees every recipient, marked when they're outside the organization, when the
user has never written to them, or when they aren't in the conversation being replied to; the body
verbatim; each attachment with its size and, for one the agent added, its SHA-256; and for a forward,
the forwarded message's text and attachments. A draft edit is fenced on the draft's `changeKey`, so
it's refused if the user changed the draft meanwhile, and a send of a draft is refused when an edit
of ours changed it after the send was proposed.

A send is exactly-once. It carries a Message-ID chosen when it was proposed, and applying it first
looks for that ID across the whole mailbox (Outbox included), so a retry after a crash finds the
sent message rather than sending again.

Mail is written by its sender, so `readMessage` turns HTML into Markdown and removes what a person
couldn't see or an agent shouldn't follow (scripts, hidden text, tracking images; the message's own
stylesheet counts, for hiding rules and for the colours and sizes that make text unreadable), lists links
separately with their real targets, says whether the sender is the user, a colleague or someone
outside the organization, and says when a message is encrypted rather than showing it empty.

Agents can never, at any level: create inbox rules (a forwarding rule is a standing channel out),
delete permanently, change mailbox or folder permissions or delegates, or send as someone else.

**New-message hooks.** `subscribeNewMessages(hook)` delivers each new message the binding admits,
with a session for the same binding, through an `OutlookHookDriver` per connection and mailbox. The
driver reads what arrived since its cursor, so a lost, late or forged notification costs at most a
read. Where the deployment has a public `https` `BASE_URL`, it also keeps a Graph change-notification
subscription (`{BASE_URL}/outlook/notifications/<driver>`, checked by a secret `clientState`, renewed
halfway through its three days) and reads within seconds of a notification; it polls every two
minutes without one and hourly with one. A hook delivers nothing until the user enables it, and
disconnecting the account stops its hooks.

## Calendar

Agents read calendars, check when people are free, and propose events, meetings and responses, in
the user's own calendars or ones shared with them. `plans/microsoft-calendar.md` is the design
record and `src/calendar-types.d.ts` the agent's API.

A binding is one of three shapes, each made for a use:

| Shape | Link | What it reaches | Made for |
|---|---|---|---|
| Every calendar | `https://outlook.office.com/calendar/` (or any `…/calendar/view/…` link) | All the user's calendars (private events in full on the user's own calendars, as busy time on calendars shared with them), and availability of anyone in the organization. | Chat, as the user's own assistant. |
| One calendar | `…/calendar/default`, `…/calendar/id/<id>`, and `…/calendar/<owner>/…` for one shared with the user | That calendar alone, at a level of detail: `?details=freeBusy\|limited\|full`, and `&private=show` to show private events. | A gadget showing a team calendar, shared with whoever that calendar is shared with. |
| Availability | `…/calendar/availability` | Busy times and working hours of people in the organization, never what the events are. | Scheduling, without reading anyone's calendar. |

`&access=read|edit|schedule` sets the level. A calendar binding is resolved once, at binding, to the
calendar's immutable ID and its entry ID, so renaming the calendar changes nothing, and every event
an agent names is read and checked to be in that calendar before anything is shown. Graph's own
listings are rechecked the same way, and a stray event from another calendar is dropped and logged.

What a calendar binding shows follows Exchange's own sharing levels, enforced by the gatekeeper, not
just by what Graph returns: `freeBusy` is times and show-as only, `limited` adds subject and
location, `full` adds attendees, the description and the rest. A private event shows as a busy block
unless the binding shows private events. An availability binding answers through `getSchedule`,
which never returns subjects, and finds free time across people's working hours, each in their own
time zone.

The levels:

| Level | Adds | Kind | Can be auto-approved |
|---|---|---|---|
| `read` | Events, availability, free times, people | — | — |
| `edit` | Create, change and delete events only the user sees (no attendees), and their own copy's categories, show-as and reminder on others' meetings | `calendar.events` | Yes |
| `schedule` | Meetings: invitations, updates and cancellations | `calendar.invitations` | **Never** |
| `schedule` | Accept, tentatively accept or decline, optionally proposing another time | `calendar.responses` | **Never** |
| `edit` | Create, change and delete events in a calendar someone else owns | `calendar.shared-events` | **Never** |

Only a `full` binding can change events, since nothing a binding can't fully see can be changed
through it. A read binding's session is a `CalendarReader`, with no write methods at all. A change
is fenced on the event's `changeKey`, so an edit made in Outlook after the proposal stops it, and a
change or deletion proposed against an event not yet created is fenced on the version its creation
left, so an event that gained attendees in Outlook meanwhile isn't quietly changed as one nobody
else is on; a creation carries a `transactionId`, so a retry can't make two. Events only the user
sees revert for 30 days: a creation is deleted, a change restored, a deletion recreated as a new
event; one that has since left the calendar the action was approved for is left as it is. Anything
that sent mail can't be called back, and says so. The approver of a meeting sees every attendee,
marked when outside the organization, and while a change to who they are is pending, nothing more
is proposed to the meeting, since nobody could say whom it would reach.

Agents can never change who a calendar is shared with, delete someone else's meeting (they decline
it), or change a meeting they don't organize.

## Sharing a workspace

A collaborator can observe a workspace that reads SharePoint only if all of these hold:

- they have their own working Microsoft 365 connection
- that connection is in the same tenant
- their own account can open everything the workspace has already read

For Outlook, the same holds for mail: a collaborator observes mail reads only if they can open
that mailbox themselves, so a workspace reading a shared mailbox can be shared with its members,
while one reading the user's own mail is kept from everyone else.

For Calendar, a collaborator observes a calendar binding's reads only if that calendar's sharing list
gives them a role that sees at least as much as the binding shows (`freeBusyRead` for `freeBusy`,
`limitedRead` for `limited`, `read` for `full`, delegate access to private events for `private=show`).
Only a calendar's owner can read its sharing list, so this decides the user's own calendars; a binding
on someone else's calendar is observed by that calendar's owner and nobody else.
So a gadget showing the team calendar at free/busy can be shared with the whole organization if the
calendar is, and one showing full details only with the people it is shared with at `read`. An
availability read admits whoever can see those people's free/busy themselves, and an every-calendar
binding that has read events is the user's alone.

SharePoint can break permission inheritance on any folder, file or list item. So the gatekeeper
tracks each thing a read reveals (up to 2,000 per binding) rather than one container. Each later
read is checked against every observer, and a read that reveals something an observer can't open is
blocked for as long as they remain one. See `docs/observers.md`.

## Troubleshooting

### "An administrator needs to approve this app"

The organization allows only administrators to consent to the SharePoint, mail or calendar
permissions. An administrator can grant consent from the link on the page, or from the app
registration's **API permissions** page.

### "That account can't connect here"

The user signed in with an account from another tenant, or with a personal Microsoft account. Sign
in with a work or school account from the deployment's own tenant.

### "Your organization blocked this sign-in"

A Conditional Access policy refused the sign-in, for example because it requires a managed device.
The organization's administrators decide this.

### "That's a different Microsoft 365 account"

The reconnect signed in as a different user from the one the connection was made for. A connection
stays pinned to its tenant and user. Reconnect as that user, or connect the other account
separately.

### "The Microsoft 365 connection has expired or was revoked."

Entra refused the refresh token. Typical causes:

- the user's sessions were revoked
- their password was reset
- the client secret expired or was rotated
- a Conditional Access policy now requires an interactive sign-in

Reconnect from the Workshop's Connections page.

### Search finds nothing in a new site

SharePoint indexes new content in the background. On a new tenant that can take hours or more.
Browsing and reading don't depend on the index; search and the configurator's site list do. Until
the index catches up, the site list falls back to the user's home and followed sites.

## Tests

```sh
pnpm --filter @gadgets/microsoft-gatekeeper test:run    # Node, then workerd against a fake Graph
```

These are the tests CI runs, and all a change normally needs: they cover the logic against fakes of
Entra and Graph. The configurator frame tests (`__tests__/*-configurator-frame.test.ts`) drive the
generated frames in Chromium through `__tests__/frame-host.ts`, so they need Chromium installed once
with `pnpm --filter @gadgets/workshop-frontend exec playwright install chromium`.

### Live suite (optional)

A second suite runs the gatekeeper against a real Microsoft 365 tenant, as real users, for the
behaviour a fake can only assume. It is never part of `test` or CI, and skips itself unless set up as
below. Run it when you change how the gatekeeper talks to Microsoft. It applies real changes in the
test tenant and cleans up after itself, so use a tenant kept for the purpose, never a production one.

**1. A test tenant with three licensed users** (Microsoft 365 with Exchange Online and SharePoint),
known to the suite as `phillip`, `sarah` and `bob`:

| Fixture | Set up as | What it tests |
|---|---|---|
| **Engineering** team site | Private. Phillip owns it, Sarah is a member, Bob isn't. `Documents/Specs/` holds `apollo-brief.docx`, `apollo-budget.xlsx` and `Deep/notes.txt`; an `Issue Tracker` list has a Status choice column and a Priority number column | reads, list queries, observers refusing a non-member |
| **Marketing** communication site | Sarah and Bob are visitors. `Documents/Launch/` holds `roster.csv`; `Documents/Confidential/` has inheritance broken and Visitors removed; a `Launch Plan` page | observers, hidden folders, pages |
| **Phillip's OneDrive** | `GadgetsSpike/Apollo` shared read-only with Sarah; `GadgetsSpike/Private/secret.txt` shared with nobody; a top-level `Shared with Sarah` folder holding one Word document, the folder shared read-only with Sarah (Share, "Can view") | OneDrive sharing, shortcuts, the configurator's Shared with you |
| **Phillip's calendars** | A calendar named `Gadgets Spike Team`, shared with Sarah as "Can view all details" and with Bob as "Can view when I'm busy" | calendar bindings and observers by detail level |
| **Bob's calendar** | His main calendar shared with nobody, not even free/busy (Outlook: Calendar permissions, "My Organization": none) | unknown availability never reads as free |
| **Phillip's mailbox** | Sarah is a Reviewer of his Inbox and of no other folder (Outlook: Inbox, Sharing and permissions) | observers of a folder-only delegate |

**2. An app registration** in that tenant, made as the deploy wizard describes (`deploy-inputs.json`),
with admin consent granted, plus `http://localhost:8765/callback` as a second Web redirect URI for
signing the test users in. Its credentials go in the repository's root `.dev.vars`, the same ones
`pnpm dev-server` uses:

```
MICROSOFT_CLIENT_ID=…
MICROSOFT_CLIENT_SECRET=…
MICROSOFT_TENANT_ID=…
```

**3. Sign each user in once,** in a browser, so MFA and Conditional Access apply as for anyone:

```sh
pnpm --filter @gadgets/microsoft-gatekeeper contract:sign-in phillip   # then sarah, then bob
```

This saves each user's refresh token to `~/.config/gadgets-microsoft-contract/tokens.json` (or the
file `MICROSOFT_CONTRACT_TOKENS` names), readable only by you. The suite rotates the tokens in place,
so a user needs signing in again only if their token is revoked or goes unused for 90 days. A team
can share one tenant by sharing `.dev.vars` and the tokens file through a password manager.

**4. Run it:**

```sh
pnpm --filter @gadgets/microsoft-gatekeeper test:contract                       # 67 tests, a few minutes
MICROSOFT_LIVE=1 pnpm --filter @gadgets/microsoft-gatekeeper exec vitest run __tests__/outlook-configurator.live.test.ts __tests__/calendar-configurator.live.test.ts
```

What it does to the tenant: file writes happen in a scratch folder it creates and deletes;
`office.test.ts` also has Microsoft 365 render each Office file it writes to PDF, which proves Office
for the web opens it. `outlook.test.ts` has the three users mail one another and deletes what it
sent. `calendar.test.ts` makes its events five weeks out and deletes them. The hooks test makes a
real Graph subscription when `MICROSOFT_CONTRACT_BASE_URL` is a public `https` URL (a `cloudflared`
tunnel will do), and polls otherwise.

`node scripts/office-render.ts <file>...` uses the same credentials to render any Office file the
way Microsoft 365 does, for looking at what the writers produce.
