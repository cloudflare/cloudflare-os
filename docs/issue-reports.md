# Issue reports: how a user reaches the admins

A user who hits a problem files an issue report from the Workshop: what went wrong, a priority,
where they were, and up to five images. The deployment's admins read it in the admin panel's
Reports tab, and the two sides follow it in a thread on the report. A reporter who owns the
workspace can give the admins a grant to read its content with the report (see
[admin-access.md](admin-access.md#grants)); filing alone gives admins nothing but the report.

The names say "issue report" throughout (`submitIssueReport`, `IssueReport`): `reportIssue`
already names exception telemetry (see
[the observability guide](../packages/observability/AGENTS.md)), and this is not that.

The API is documented on `AuthenticatedApi` and `AdminApi` in
`packages/workshop-shared/src/api.ts`; the pieces are:

| Concern | Location |
| --- | --- |
| The deployment-wide store: reports, threads, links, images, the grant copies, retention (`IssueReportsDurableObject`) | `packages/workshop-backend/src/issue-reports.ts` |
| The reporter's methods (`AuthenticatedApiImpl`) | `packages/workshop-backend/src/server.ts` |
| The admins' methods (`AdminApiImpl`) and the retention setting | `packages/workshop-backend/src/admin-settings.ts` |
| Whether a reporter can open what a report names (`issueReportContext`) | `packages/workshop-backend/src/overseer.ts` |
| Recognising an image from its first bytes (`sniffImageMimeType`) | `packages/workshop-backend/src/chat-attachment-validation.ts` |
| The retention floor (`minIssueReportRetentionDays`), a user as a report names them (`namedUser`) | `packages/workshop-backend/src/admin-access.ts` |
| Report issue, its dialog and the My issues page | `packages/workshop-frontend/src/features/issue-reports/` |
| The admin panel's Reports tab | `packages/workshop-frontend/src/features/admin-reports/` |

## What a report holds

An `IssueReport` holds:

- **who filed it and when**, both stamped by the server: the reporter is the session's user, never
  an argument;
- **what went wrong**, in the reporter's words: non-blank, at most
  `MAX_ISSUE_REPORT_TEXT_LENGTH` (2,000) characters;
- **a priority**: low, medium or high, as the reporter judges it;
- **where the reporter was**, as ids only (`IssueReportContext`): the workspace, the open chat,
  the open gadget, each optional, and the app version their client ran. A report from the home
  page names no workspace. The version is a label, cut to 100 characters, and never read to make
  a decision. The Workshop sends the frontend build the page runs (its entry script) and then
  the version of the backend it is connected to: a tab that outlived a deployment runs an older
  build than the backend it reconnected to;
- **up to five images** (see [Images](#images));
- **its status** (see [Statuses](#statuses));
- **the links admins attached**, which only admins read (see [Links](#links));
- **the grant given with it**, if any (see [The grant given with a report](#the-grant-given-with-a-report)).

Text bounds count UTF-16 code units (a string's `length`) of the text once trimmed, for a report
and for each entry of its thread.

### Who is kept, and how much

A report and an entry keep only their author's id and display name (`NamedUser`), each bounded at
256 characters: a longer name is cut and marked, and a longer id is kept as its start and a digest
of the whole, as the admin audit log keeps a workspace owner's, so two long ids stay apart.
Nothing else of a profile is stored. The reason is that a display name has no bound of its own
and the store is deployment-wide: one report returns hundreds of entries, and each must be small.
Every user the store is handed goes through `namedUser()` before it is compared or stored.

### What a report may name

A workspace a report names must be one the reporter owns or is a collaborator on, and a chat or a
gadget one they can open there: any chat and gadget for the owner and a `build` collaborator; no
chat, and only a gadget shared with them, for a `use` collaborator. Anything else is refused
`contextNotFound`, a workspace that does not exist included, so a report cannot point admins at
somebody else's workspace and cannot tell which workspaces exist. The workspace answers the
question itself (`issueReportContext()`), from its sharing records, for the caller's own user id:
it opens no session, joins no presence and writes nothing.

## Filing

`AuthenticatedApi.submitIssueReport(report)` files a report, whose status is `"new"`. A user may
file `MAX_ISSUE_REPORTS_PER_DAY` (20) in a UTC day (`tooManyReports` past it). Images are added
afterwards, one call each (`addIssueReportImage()`), and a grant, if the reporter gives one, with
the owner's grant call naming the report. So a report is filed even when an image or the grant is
then refused, and the dialog says which part did not go through.

The reporter then has:

- `listIssueReports(cursor?)`: their own reports that are still kept, newest first. The list is
  paged, `ISSUE_REPORT_PAGE_SIZE` (50) a page with a cursor, since a user can keep more reports
  than one answer holds. The cursor is the id of one of the reporter's own reports and no other
  value is taken: the admins' list is paged by a report's number, which counts every report the
  deployment was sent, so a reporter is never handed one and cannot page by one;
- `getIssueReport(reportId)`: one report with its public thread, oldest entry first;
- `readIssueReportImage(reportId, imageId)`: one image's bytes, as a stream;
- `replyToIssueReport(reportId, text)`;
- `getUnseenIssueReportCount()` and `markIssueReportSeen(reportId)` (see [The count](#the-count)).

Every one of them answers `notFound` for a report that is not the caller's, exactly as for one
that does not exist.

## The thread

Each report has a thread of entries (`IssueReportEntry`). An entry has an author, a time, a
visibility, and a text bounded as the report's is; an admin's entry also says how their call
reached the deployment (`via`, as on an audit record).

- **`"public"`** entries are read by the reporter and the admins.
- **`"admins"`** entries are read by the admins alone.

The reporter writes public entries only and reads public entries only. Admins write both kinds
(`addIssueReportEntry(reportId, text, visibility)`) and read both. An admins-only entry never
reaches the reporter: not through a method, a count, a time or an id.

- **Entry ids are random and opaque.** A numbered id would tell a reporter how many entries the
  thread holds, and so how many notes the admins wrote between two of theirs.
- **The reporter's report carries nothing an admins-only entry moves.** It is built without the
  links and without the time the thread last grew (`updatedAt`), which an admins-only entry
  changes.
- **The bounds are counted apart.** A thread holds up to `MAX_ISSUE_REPORT_THREAD_ENTRIES` (200)
  entries of each of three kinds: the reporter's replies, the admins' public entries, and the
  admins-only ones. A reporter who fills their side cannot stop the admins answering, and a full
  thread (`threadFull`) tells a reporter nothing of the admins' notes, since only their own
  replies count against them. A change of status is in none of the three, so a person can
  always close a report. What is written [through an agent](admin-access.md#through-an-agent)
  is counted apart from what people write, since a workspace's rule can write it with no person
  deciding: an agent's public entries, its admins-only ones and its changes of status each have
  the same bound of their own, so an agent that fills its share leaves the admins all of theirs.
- **A reporter reads an admin by name alone.** An admin's entries and status lines reach the
  reporter with the admin's display name and no id: an admin's id is their account name, which
  can be an email address, and a thread only has to say who answered. The id is returned to
  admins only. The rule is how the entry was written (through the admins' methods), not a
  comparison of ids, so it holds for an admin who files a report too.

A reporter may write `MAX_ISSUE_REPORT_REPLIES_PER_DAY` (100) replies in a UTC day, over all
their reports (`tooManyReplies`).

### Entries an agent wrote

An admin's agent can write to a thread through the admin gatekeeper (see
[admin-access.md](admin-access.md#through-an-agent)). Such an entry is the admin's, written
through the admins' methods like any other, and its `via` is `"gatekeeper"`.

- **The reporter reads that an agent wrote it, and nothing more.** The entry reaches the
  reporter with `via` and the admin's name, and the Workshop shows its author as "Agent, for"
  that admin.
- **Admins also read where it came from** (`agent`: the workspace whose connection made the call
  and, when there is one, the chat). It is never returned to the reporter.
- **A public reply through the whole admin binding always waits for a person**, whatever
  auto-approval rules its workspace has: an agent that can read what only admins see never posts
  to a reporter by itself.
- **A public reply through a session limited to the report can be applied by a rule**, in a
  workspace that has read nothing through the whole binding and nothing of a reporter's
  workspace that holds restricted data. Such a session reads the report as its reporter does,
  and the reporter's workspace only as the reporter chose to show it, so its answer holds
  nothing the reporter could not see. Either of those reads marks the workspace as holding
  restricted data, and no rule applies anything there afterwards.
- **An admins-only note and a status change** are queued as actions too, and applied by a person
  or, where the workspace has a rule for the kind and holds no restricted data, by that rule.

## Statuses

| Status | Meaning |
| --- | --- |
| `new` | Filed, and no admin has set a status. |
| `investigating` | An admin is looking into it. |
| `answered` | An admin answered, and expects nothing more. |
| `waitingOnReporter` | An admin asked the reporter something. |
| `withAdmin` | Back in front of the admins: the reporter replied to a report that was `answered` or `waitingOnReporter`. |
| `closed` | Done. The reporter can no longer reply or add an image. |

Admins set any status (`setIssueReportStatus()`). A reporter sets none, with one exception: their
reply to a report that is `answered` or `waitingOnReporter` moves it to `withAdmin`, which is what
puts it back in front of the admins. A reply to a report in any other open status leaves the
status alone, and a closed report takes no reply (`closed`). An admin's written entry changes no
status: the admin sets it separately.

**A status change is a public line in the thread that names the admin who made it.** It has no
text, and it tells the reporter where the report stands without counting as an answer:

- it does not raise the reporter's count of unseen reports;
- it is outside the thread's bound, so a full thread can still be closed;
- setting the status a report already has adds nothing.

The reporter's reopening reply carries the status it set (`withAdmin`) the same way.

A status an agent set for an admin is the same line, with `via: "gatekeeper"`: the reporter
reads "Agent, for" that admin, and admins also read the workspace and the chat it came from. It
is set over whatever status the report has by the time the action is applied.

## Hooks

The admin gatekeeper offers two hooks to the code of a workspace that has its connection (see
[its README](../packages/gatekeeper-instanceadmin/README.md#hooks)):

| Hook | Fires | Its event |
| --- | --- | --- |
| Issue reported | Once for each report filed. | The report's id, its priority and when it was filed. |
| Investigation complete | Once each time an admin moves a report from `investigating` to `answered`, `waitingOnReporter`, `withAdmin` or `closed`. | The report's id, its status and when it changed. |

An event carries ids and labels only: a subscriber reads the report through its own connection.
Only a deployment admin can hold that connection, and a hook delivers only while its workspace's
owner is one. A hook wakes a gadget's stored callback or an existing chat; it opens no chat.

- **"Issue reported" fires at `submitIssueReport()`**, before the reporter's client has called
  `addIssueReportImage()` or given the grant that may come with the report. A subscriber that
  reads at once may see no image and be refused content, and reads again later.
- **Delivery is at least once.** A subscriber sees an event twice only when its own callback
  failed or timed out part of the way through, so a callback of either hook keys its work by
  the event's `eventId`: the same each time one event is delivered, and different for a report
  investigated again that ends with the status it ended with before, which is a second event
  and can carry the same time.
- **A callback answers within 30 seconds.** It starts long work and returns; one that takes
  longer is given up on and called again later, so that it holds back no other subscriber's
  events.

**The store's outgoing events.** The report store tells the gatekeeper; the gatekeeper holds
nothing it could ask with. The store writes one row per event (`events`: a sequence number, a
random id, the kind, the report's id, the priority or the status, and the time) in the same
step as the change it reports, and deletes the row once the gatekeeper has taken it. The
sequence number orders the rows and stays in the store; the id is what the gatekeeper and a
subscriber know the event by, so neither learns how many events the deployment has had.

- **It sends them oldest first**, `EVENT_BATCH` (100) a call, as soon as the change is stored
  and again from its alarm.
- **A call that is rejected, or has not settled within `EVENT_RETRY_MS` (a minute), is given up
  on**, and its rows are offered again with the same ids. A row not taken for
  `EVENT_MAX_AGE_MS` (a day) is dropped.
- **Where the gatekeeper is not bound or is turned off, every row is deleted**: nobody is to be
  told, and turning the gatekeeper on later replays nothing.
- **It never delays the retention pass.** Every alarm runs the pass first and then offers the
  waiting events, and the alarm comes back within `EVENT_RETRY_MS` while one waits. So the pass
  can run more often than its own cadence, and never less.

## Links

Admins attach a short list of links to a report (a ticket, a pull request) with
`setIssueReportLinks()`: at most `MAX_ISSUE_REPORT_LINKS` (10), each an `http` or `https` URL of
at most `MAX_ISSUE_REPORT_LINK_LENGTH` (2,000) characters. A link is kept as the URL the server
parsed (its normalised form), never as the text sent, so what a report returns is what was
checked. Links are shown to admins only.

## Who reads what

| | The reporter | Admins |
| --- | --- | --- |
| The report: text, priority, context, status, images | Their own reports | Every report |
| Public entries and status lines | Yes, an admin named without their id | Yes |
| Admins-only entries | Never | Yes |
| Links, and when the thread last grew | Never | Yes |
| The grant given with the report | Yes | Yes, with its time left |
| Images | Their own reports' | Every report's |

The admins' methods are `listIssueReports(options)` (newest first; filtered by status, priority,
reporter and workspace, which combine; paged with a cursor), `getIssueReport()`,
`addIssueReportEntry()`, `setIssueReportStatus()`, `setIssueReportLinks()` and
`readIssueReportImage()`. Each checks again, on every call, that the caller is still a deployment
admin (`notAdmin`).

### The count

My issues shows how many of the reporter's reports hold a public entry an admin wrote that they
have not marked seen (`getUnseenIssueReportCount()`, and `OwnIssueReport.unseen` on each report).
Only a written public entry by an admin raises it: an admins-only entry and a bare status change
do not.

- **The count is read, not pushed.** The Workshop asks again to refresh it; no event is raised to
  the reporter's sessions.
- **Marking a report seen marks what it holds when the call arrives**
  (`markIssueReportSeen()`), which can be more than the caller last read. A client therefore
  reads the report again after marking, as My issues does.

## The grant given with a report

A reporter who owns the workspace can give admins a grant to read its content with the report:
for that workspace (`Overseer.grantAdminAccess({ reportId })`) or for all of their workspaces
(`AuthenticatedApi.grantAccountAdminAccess({ reportId })`). The report then shows which grant came
with it, and admins see how long it has left. A collaborator can file a report but cannot grant.

- **The link is made by the server, from the owner's own grant call**, never on a client's word:
  the workspace or the account that stores the grant tells the report store.
- **It is checked before the grant is given** (`checkGrantLink()`): the report is the caller's,
  it names that workspace (or, for the account-wide grant, no workspace or one its reporter owns),
  and it holds no live grant already. A report that cannot show the grant refuses the call
  (`notFound`), and no grant is given.
- **It is made after the grant is stored** (`noteGrant()`). If the link then fails, a grant that
  call gave is ended, so the caller is never told the call failed while a grant it gave stays
  live. An account-wide grant the call only renewed stays renewed, with its later end, since
  ending it would take away access given before; the call fails all the same.
- **A report shows one grant.** Once it has ended, the reporter can give another with the same
  report, which replaces it.
- **An account-wide grant is linked only to a report that names no workspace or one its reporter
  owns**, so a report never shows a grant that does not cover its workspace. One account-wide
  grant can be linked to several reports.

**What a report shows is a display copy.** The workspace's or the account's record is the
authority, and the copy is the last that record's holder reported:

- a renewal or an end is passed on after it is stored, best effort. A revocation that could not
  be passed on shows as live until the grant's end;
- the owner ending the grant again sends the end again, so pressing End access a second time,
  which My issues still offers while the copy says live, repairs the copy;
- an admin's content call is decided by the workspace when it is made, never by the copy.

**The store keeps a copy of a grant only while a report names it.** A replaced link's copy and a
deleted report's copy are deleted in the same step, and a grant no report names is never stored.
An owner gives and ends grants without limit, and their grants cannot grow the store.

## Images

A report takes up to `MAX_ISSUE_REPORT_IMAGES` (5) images, each added with
`addIssueReportImage(reportId, image, byteLength)`: a stream of the image's bytes and their number.

- **The format is recognised from the bytes**, the first 12, never from a name or a type the
  client sent: PNG, JPEG or WebP (`ISSUE_REPORT_IMAGE_TYPES`), and anything else is refused
  (`imageNotRecognised`) before a byte is sent to storage.
- **An image is at most 5 MiB** (`MAX_ISSUE_REPORT_IMAGE_BYTES`, `imageTooLarge`): the size a PNG
  capture of a browser tab on a high-density display fits in. The Workshop re-encodes a larger
  capture or file before sending it.
- **A reporter's reports hold at most 50 MiB of images together**
  (`MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER`, `imageQuotaReached`): ten images of the largest size,
  over all the reports of theirs that are still kept. The images have no bound as a whole, so
  this is what bounds how much they grow: by 50 MiB a reporter, for as long as the retention keeps
  their reports. A report whose image is refused for the quota is still filed, without that image.
- **An upload declares its length.** `byteLength` is checked before a byte is read (a whole
  number, at most the bound, and at least the 12 bytes a signature takes), and the stream must
  then hold exactly that many bytes: one that holds more or fewer fails, and nothing of it stays
  stored.
- **An upload in progress holds its declared length** of the reporter's 50 MiB, and its place
  among the report's five, from the moment it is accepted until it ends. Uploads racing each
  other therefore count each other's, and cannot pass a bound together.
- **A reporter has at most two uploads in progress at a time**
  (`MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER`, `tooManyUploads`), over all their reports. Each is
  a stream and an open put held in the one deployment-wide store, so a reporter may not hold one
  for every slot of every open report. An upload that was interrupted counts until the store has
  cleared it away, some minutes later.
- **A report already past its retention takes no image** (`notFound`), and neither does a closed
  one (`closed`). An upload must not put off a deletion that is due.
- **Images are streamed in and out.** An upload goes to storage as it arrives, a piece at a time,
  and a read returns the stored object's own byte stream: nothing is held whole, in the store or
  in the session Worker, which reads no byte of an image either way.
- **An image is rendered only as an image of the recognised type.** A report lists each image
  with the format the server recognised (`IssueReportImage.type`), and the Workshop shows the
  bytes through an object URL in an `<img>`, typed as that format and nothing else. No HTTP
  route serves an image, so no response can be sniffed, navigated to or rendered as a document:
  inline HTML and SVG have no way in.

### Where images are kept

An image's bytes are one object in an R2 bucket that holds nothing else, bound to the backend as
`ISSUE_IMAGES` (`gadgets-issue-images` in the committed config). The blueprint bucket holds no
report image. The image's row in the report store holds everything else (its format, its length,
its reporter, whether its upload finished) and is what decides who reads it, how many a report
has and how many bytes a reporter holds. Nothing but the bytes is stored on the object.

**The key is not the access control.** An object is named `<report id>/<image id>`, two random
ids, built from rows alone and returned by no method. What protects an image is this:

- the bucket is private: it is never made public or served from a domain;
- no HTTP route and no URL serves an image;
- one source file (`issue-reports.ts`) uses the binding;
- both reads (`readIssueReportImage()` on either API) check the row before the object is opened:
  that the image is stored in that report, and, for the reporter's read, that the report is
  theirs.

**A row before its object, an object deleted before its row.** A row is inserted before its
object is put, and deleted only after the delete of its object has resolved. So what a failure
leaves is a row, which is retried, and never an object nothing names.

**The upload runs in the report store**, not in the session Worker that received the stream. One
class then writes the row before its object and deletes it after, no path reaches an object
without the row's check, and an upload whose session dropped is cleared away by the code that
began it. The cost is that an image's bytes pass through the deployment-wide object: they pass as
a stream, an image is 5 MiB at most, and the object serves other calls while it waits.

**An upload that never finishes leaves nothing.**

- An upload is cut off after 5 minutes: its stream is cancelled and the call fails.
- The byte that completes an image is sent to the bucket only once its stream has ended. The
  bucket stores an object as soon as its body is complete, so until then it holds nothing of the
  upload, and a stream that runs long, runs short or fails stores no object.
- An upload deletes its object only after its put has settled: a delete sent while the put is in
  flight can be answered before the put lands.
- An unfinished upload's row and object are swept after 10 minutes, before the next upload is
  accepted and at the start of every daily run. Ten minutes is twice what an upload is given, so
  an upload that is still being received is never swept.

**Deletion.** An image is deleted with its report, by the retention's daily run (see
[Retention](#retention)), objects first and rows second. Nothing a reporter does puts a due
deletion off: an upload to a report already past its retention is refused. While the bucket
cannot be reached, the run deletes the due reports that have no image, keeps the others whole,
and comes back in an hour, so a report with images can outlive its retention until the bucket
answers.

**For an operator:**

- the bucket is never made public or served from a domain;
- an object deleted by hand shows as an image that cannot be read; the report and its other
  images are unaffected;
- no lifecycle rule is needed: the daily run deletes;
- the bucket has no bound as a whole. Its growth is bounded by the 50 MiB a reporter may keep,
  for as long as the retention keeps their reports.

**What a deployment needs.** The bucket has to exist before a deployment runs a release that has
the binding:

- the release manifest names it `$R2_ISSUE_IMAGES_NAME`, as it names the blueprint bucket
  `$R2_BLUEPRINT_CONTENT_NAME`: a bucket provisioned at deploy time
  (`scripts/release/manifest-lib.ts`);
- a deployment made with its own `wrangler deploy` creates the bucket its config names: the
  Wrangler this repository pins (4.154.0) provisions a bucket that does not exist by default;
- every pull request preview gets one of its own;
- `pnpm dev-server`, `pnpm run-local` and the tests use a local one, with nothing to set up.

## Retention

A report is kept for 90 days from its filing (`DEFAULT_ISSUE_REPORT_RETENTION_DAYS`) unless an
admin sets another retention, and is then deleted with its thread, its images and its copy of a
grant.

- **The setting** is `AdminApi.setIssueReportRetentionDays(days)`, in the Reports tab: a whole
  number of days from the deployment's minimum to `MAX_ISSUE_REPORT_RETENTION_DAYS` (3650). It is
  an admin setting like any other, recorded in the admin audit log before it takes effect.
- **The floor** is the backend's `ISSUE_REPORT_RETENTION_MIN_DAYS`: the fewest days a report is
  kept, whatever admins choose. It is 90 when unset, blank or invalid, and works exactly as the
  audit log's `ADMIN_AUDIT_RETENTION_MIN_DAYS` does (see
  [admin-access.md](admin-access.md#the-environments-bounds)). `getSettings()` reports the
  retention as `issueReportRetentionDays`: `chosen`, `min` and `effective`.
- **The daily run is the one place reports are deleted** (the store's `alarm()`). It asks
  `AdminSettings` for the committed retention each time, never a mirror and never a value it
  kept, and deletes the reports filed before it, 100 a run, a minute apart while more are due.
  If the retention cannot be asked, it deletes nothing and comes back in an hour.
- **A report therefore outlives its retention by about a day**, and by longer only while its
  images cannot be deleted from their bucket. No read filters by age: until the run deletes it, a
  report past its retention is still listed and read.

## What is recorded where

Reading and writing reports is not recorded in the admin audit log. A report is written to the
admins, so an admin reading it is what it is for, and its thread is its own record of who did
what: each entry and each status line keeps its author, its time and, for an admin's, how the
call reached the deployment. So `addIssueReportEntry()`, `setIssueReportStatus()` and
`setIssueReportLinks()` are the three `AdminApi` methods that write without an audit record.
The links are the exception to that record: replacing them adds no line to the thread and keeps
no author and no time, so a report shows the links it has, not who set them or when.

What is recorded there:

- **a change of the retention**, as a setting record;
- **a content read of the reporter's workspace**, as every admin call into a workspace is, with
  the id of the grant it ran under (see [admin-access.md](admin-access.md#the-audit)). A report
  gives admins no access by itself: content is read only under a live grant, through a view
  opened for content.

An owner's grant, given with a report or not, is the owner's own record and is not in the audit
log either; the report's copy of it is where admins see it.

An agent's entries and status lines are recorded in the thread like any admin's, with `via`
`"gatekeeper"` and the workspace and the chat they came from: admins read that origin, and the
reporter reads only that an agent wrote the entry. An agent's reads of reports leave no audit
record, as an admin's do not. Their one trace is the observation in the activity of the
workspace that read, which is deleted with that workspace.

## The Workshop

- **Report issue** is one component (`features/issue-reports/`), offered in the user menu, the
  workspace editor's top bar included, in the editor's phone menu and in a workspace's row menu.
  Opened from a workspace, it carries the workspace, the open chat and the open gadget as the
  report's context; the use-only view of a gadget carries the workspace and that gadget. A chat
  or gadget that is gone by the time the report is sent (refused `contextNotFound`) does not hold
  the report back: the dialog files it again for the workspace alone.
- **The dialog** asks what went wrong, a priority, images, and what to give admins access to:
  Metadata only (the default, and no grant), or Content, for this workspace or for all my
  workspaces, for 72 hours, which the reporter can end sooner. The content options appear only
  for the workspace's owner and only where the deployment allows content
  (`ServerConfig.adminContentGrants`); from the home page only "all my workspaces" is offered. It
  says that everything an admin reads under a grant is recorded.
- **Images in the dialog**: an opt-in Capture this tab button, which uses the browser's own
  screen-capture prompt (`getDisplayMedia`, preferring the current tab), takes one frame, stops
  the capture at once and shows the frame as a preview the user can remove; and images the user
  picks, drops or pastes. Five in all. A capture that cannot take its frame within three seconds
  of the prompt's answer (the page went to the background, or the capture delivers nothing) is
  stopped with no picture, and a press whose prompt is still unanswered is withdrawn when the
  dialog closes or goes away. Where the browser has no screen capture the button is
  absent, and nothing is captured without the press and the browser's prompt.
- **My issues** (`/issues`, with a sidebar item that carries the count): the reporter's reports
  with their statuses, the public thread where they reply (an entry an agent wrote for an admin
  is shown as "Agent, for" that admin), the images they sent, and the grants they gave, each
  with Renew and End access. End access ends that one grant, and the page says
  so: any other grant the owner gave stays until it is ended too.
- **The Reports tab** of the admin panel: the list with its filters, a report with its whole
  thread (an agent's entry with the workspace and the chat it came from), a reply, an
  admins-only note, the links, the status, the images, the grant that came with it and its time
  left, the retention setting, and the way into the workspace's admin page.

## Error codes

Expected refusals carry a code from `ISSUE_REPORT_ERROR_CODES` (read with
`getIssueReportErrorCode()`):

| Code | When |
| --- | --- |
| `ISSUE_REPORT_NOT_FOUND` | No such report, or one that is not the caller's; an image that is not stored in it; an upload to a report past its retention; a report that cannot be linked to the grant being given; an admin view opened for a report (`forIssueReport`) that the workspace's owner did not file about that workspace. |
| `ISSUE_REPORT_CONTEXT_NOT_FOUND` | The report names a workspace, chat or gadget its reporter cannot open. |
| `ISSUE_REPORT_CLOSED` | A reply or an image for a closed report. |
| `ISSUE_REPORT_TOO_MANY` | The reporter filed `MAX_ISSUE_REPORTS_PER_DAY` reports today. |
| `ISSUE_REPORT_TOO_MANY_REPLIES` | The reporter wrote `MAX_ISSUE_REPORT_REPLIES_PER_DAY` replies today. |
| `ISSUE_REPORT_THREAD_FULL` | The thread holds `MAX_ISSUE_REPORT_THREAD_ENTRIES` entries of the kind being written. |
| `ISSUE_REPORT_TOO_MANY_IMAGES` | The report already has five images, uploads in progress included. |
| `ISSUE_REPORT_IMAGE_TOO_LARGE` | The declared length is over 5 MiB. |
| `ISSUE_REPORT_IMAGE_NOT_RECOGNISED` | The bytes are not a PNG's, a JPEG's or a WebP's. |
| `ISSUE_REPORT_IMAGE_QUOTA_REACHED` | The reporter's reports would hold more than 50 MiB of images. |
| `ISSUE_REPORT_TOO_MANY_UPLOADS` | The reporter already has two uploads in progress. |

The admins' methods also refuse with `ADMIN_NOT_ADMIN`.

## Code and tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `issue-reports.test.ts`: the store. Filing and its daily bound; who is kept and how much; the
  reporter's paged list; the thread, with an admins-only entry reaching the reporter through no
  method, count or time and an admin named without their id; the three bounds counted apart; the
  statuses, the reporter's one move and a status line that does not count; links kept as parsed;
  the grant copy, linked, replaced and deleted with its last report; and the daily run with the
  committed retention.
- `issue-report-images.test.ts`: images. The formats recognised from bytes; each bound, racing
  uploads included; a declared length the stream must match; an upload cut off, and one swept;
  what a failed upload leaves in the bucket; the reads, with the row checked first; and deletion
  with a report, while the bucket answers and while it does not.
- `issue-report-events.test.ts`: the events the store sends the admin gatekeeper. One for each
  report filed and each end of an investigation, and none for any other change of status; a
  delivery that is not taken, offered again with its id and dropped after a day; two ends of
  one millisecond, each with its id; a store whose `events` table gains the `id` column; a
  deployment whose gatekeeper is off or not bound; what arms the alarm; the retention pass
  running first; and a gatekeeper that does not answer.
- `issue-reports.test.ts` also covers an entry and a status line written through the admin
  gatekeeper: `via` and the origin kept, the origin returned to admins and never to the
  reporter, and a store whose `entries` table gains the `agent` column.
- `issue-report-context.test.ts`: `issueReportContext()` for an owner, a `build` and a `use`
  collaborator, a stranger and a workspace that does not exist, writing nothing.
- `chat-attachment-validation.test.ts` also covers `sniffImageMimeType()`.
- `admin-owner-grants.test.ts` and `admin-account-grant.test.ts` cover the grant given with a
  report from the grant's side (see [admin-access.md](admin-access.md#tests)).

The integration suite, `packages/integration-tests/__tests__/workshop-issue-reports.test.ts`,
follows a report from filing to closing with images, through both APIs.

Frontend suites, in `packages/workshop-frontend/src/`:

- `features/issue-reports/`: the dialog (`ReportIssueDialog.test.tsx`, and its browser test,
  which drives the capture with a faked `getDisplayMedia`), the capture and the re-encoding
  (`captureTab.test.ts`, `reportImage.test.ts`), the images shown (`IssueImages.test.tsx`), My
  issues and its count (`MyIssues.test.tsx`, `MyIssues.browser.test.tsx`,
  `MyIssuesSummary.test.tsx`), and the one dialog every Report issue item opens
  (`ReportIssueHost.test.tsx`).
- `features/admin-reports/`: the Reports tab (`AdminReportsPanel.test.tsx` and its browser
  test), its filters and its retention setting (`reportFilter.test.ts`, `reportSettings.test.ts`).
