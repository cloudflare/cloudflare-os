# Gatekeeper Google

This package provides Google OAuth integration for Gadgets. It serves two purposes:

- **Sign-in:** when `google` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Google" appears on the login page. Sign-in requests only minimal scopes (`openid`,
  `userinfo.email`, `userinfo.profile`) to read the account's **verified email** (`email_verified`),
  which becomes the user's identity.
  The sign-in grant is transient (discarded right after the email is read).
- **Connections:** when a user connects Google (or signs in and later connects it), the scopes for
  the selected resources (Gmail, Docs, Sheets, Slides, Drive, Calendar, or BigQuery — see below) are requested
  so gadgets can access those APIs on the user's behalf.

A single Google OAuth client is used for both. Set it up as follows.

## Setting Up Google OAuth Credentials

If you're running this project locally and want to use Google API integrations, you'll need to create your own Google OAuth credentials. This guide walks you through the process step-by-step.

### Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Sign in with your Google account
3. Click the project dropdown at the top of the page (it may say "Select a project" or show an existing project name)
4. Click **New Project** in the top-right of the popup
5. Enter a project name (e.g., "Gadgets Local Dev")
6. Click **Create**
7. Wait for the project to be created, then select it from the project dropdown

### Step 2: Enable Required APIs

You'll need to enable the Google APIs that you want to use. Currently supported: Gmail, Google Docs, Google Sheets, Google Slides, Google Drive, Google Calendar, Google Chat, and BigQuery.

1. In the left sidebar, go to **APIs & Services** > **Library** (or [click here](https://console.cloud.google.com/apis/library))
2. Search for "Gmail API"
3. Click on **Gmail API** in the results
4. Click **Enable**
5. Go back to the Library, search for "Google Docs API"
6. Click on **Google Docs API** in the results
7. Click **Enable**
8. Go back to the Library, search for "Google Drive API"
9. Click on **Google Drive API** in the results
10. Click **Enable**
11. Go back to the Library, search for "Google Sheets API"
12. Click on **Google Sheets API** in the results
13. Click **Enable**
14. Go back to the Library, search for "Google Slides API"
15. Click on **Google Slides API** in the results
16. Click **Enable**
17. Go back to the Library, search for "Google Calendar API"
18. Click on **Google Calendar API** in the results
19. Click **Enable**
20. Go back to the Library, search for "BigQuery API"
21. Click on **BigQuery API** in the results
22. Click **Enable**
23. To offer **Google Group** connections (mail addressed to a group, shareable with its members), enable **Cloud Identity API**. Without it, that card reports the API is off, and everything else works.
24. For Chat, enable **Google Chat API**, plus **People API** so direct messages and group chats can be named when Chat omits a participant's name, and so a whole-account Chat connection can search the organization's directory and confirm that everyone in a conversation it starts belongs to the organization.
25. On the Google Chat API's **Configuration** tab, set an app name, avatar URL, and description, turn off **Interactive features**, and click **Save**. Reads work without this, but Google refuses every Chat send, edit, and reaction until a Chat app is configured.

The Google Drive API powers the Drive resource picker, which also chooses Docs, Sheets and Slides files, Drive discovery, and Drive scope checks. Native document, spreadsheet, or presentation content opened from a Drive binding is read through the Google Docs, Google Sheets, or Google Slides API. Direct Google Doc reads and edits still go through the Docs API, direct spreadsheet reads and edits go through the Sheets API, and direct presentation reads and edits go through the Slides API.

### Step 3: Configure the OAuth Consent Screen

Before creating credentials, you must configure how the consent screen appears to users.

1. In the left sidebar, go to **APIs & Services** > **OAuth consent screen** (or [click here](https://console.cloud.google.com/apis/credentials/consent))
2. Select **External** as the user type (unless you have a Google Workspace organization and want to restrict to internal users only)
3. Click **Create**
4. Fill in the App Information:
   - **App name**: Enter anything (e.g., "Gadgets Local Dev")
   - Details are largely optional / irrelevant here, since this app will run it testing mode.
   - Click **Save and Continue**
5. On the Scopes page, you can just click **Save and Continue** without adding anything. The scopes are specified by the OAuth request itself, not the console configuration. (The console's scope UI is only relevant if you later want to publish your app for Google's verification review.)

The scopes requested depend on what the user is doing. **Sign-in** requests only the identity
scopes (`openid`, `userinfo.email`, `userinfo.profile`). **Connecting** Google for capabilities
requests scopes per connect card, not all at once: connecting a Gmail mailbox asks only for the
Gmail scopes, a calendar only for the Calendar scopes, and so on (identity is always included).
A card asks for every type on it together, so connecting anything from the Google Drive card (all
of Drive, a folder, a file, a Doc, a spreadsheet or a presentation) asks for all of their scopes.
Across all resource types, the gatekeeper can request:

- `openid`, `userinfo.profile`, and `userinfo.email` to identify the connected account.
- `gmail.modify` for Gmail thread reads, organization, replies, forwards, and sending. This single scope already includes label access and sending.
- `documents` for direct Google Docs reads, edits, comments, and creation; `documents.readonly` for native Docs opened from account-wide, folder, or exact-file Drive bindings. Appending and replacing text in a bound Doc, in table cells too, can be auto-approved ("Document edits"), and so can every table change ("Table changes"): adding and deleting tables, rows and columns, restyling cells, sizing columns and rows, and merging and splitting cells, which the Doc's version history undoes. So can adding a tab ("New document tabs") and its comment writes ("Google Doc comments"), which go through the Docs API under this scope (see [Google Doc comments](#google-doc-comments)).
- `drive.metadata.readonly` so the Drive picker can browse to a Doc, spreadsheet or presentation connected on its own, and so a bound Doc can read whether the connected account may comment on it. Google classifies this as a restricted scope. Docs, Sheets and Slides share the Google Drive connect card with the Drive resources, and the Workshop asks for every type on a card together, so connecting any of them also asks for the other types' scopes, `drive.readonly` among them.
- `drive.readonly` for account-wide, folder, and exact-file Drive bindings: the Drive picker, discovery, file metadata, folder descendant proofs, native-file scope checks, downloading a PDF to read its text with `readPdf()`, and downloading any other file's bytes with `readFile()`. Google classifies this as a restricted scope too, so every Drive resource here needs restricted-scope verification.
- `drive.readonly` and `drive.file` for the Office import grant (`https://docs.google.com/import`), which converts an Office file into a Google Docs, Sheets or Slides copy (see [Office files](#office-files)). Only the connect dialog's **Convert** button asks for it, by incremental consent, the first time an account converts a file; using a copy made before reads only metadata and asks for nothing. Once held, it is part of the account's recorded grants, so a reconnect asks for it again. `drive.readonly` lets the gatekeeper see a source file this OAuth client did not create, which `drive.file` alone cannot, and `drive.file` lets it create the copy. The grant is private to the gatekeeper: it is not a resource, so it is never offered on connect, listed, bound, or shown among an account's granted resources, and admins cannot turn it off separately from Docs, Sheets and Slides. Once held, `drive.readonly` lets the account's token read any Drive file, so bindings stay limited by the gatekeeper's code rather than by the token. A verified OAuth app must add both scopes to its consent screen, and `drive.readonly` is a restricted scope.
- `drive.readonly` for the shared-drives grant (`https://drive.google.com/drive/shared-drives`), which lets the Drive picker list the shared drives the account belongs to, since Drive's `drives.list` accepts no narrower scope. Only the picker's **Allow access** button asks for it, by incremental consent, the first time an account opens Shared drives; once held, a reconnect asks for it again. It is private to the gatekeeper as the Office import grant is, and an account holding that grant is still asked once, since a private grant counts only once it has been asked for, not because its scopes happen to be held.
- `drive.file` for the created-files grant (`https://drive.google.com/drive/created-files`), which lets the gatekeeper put what a creation makes where its approver chose: move a new Doc, spreadsheet or presentation out of My Drive into a folder, or make a new Drive folder. `drive.file` reaches only files this OAuth client created or the user opened or shared with it. Only the creation dialog's **Allow access** button asks for it, by incremental consent, the first time an approver picks a folder (or approves a new folder); a file kept in My Drive needs no Drive call and asks for nothing. Saving a file to Drive (see [Saving files](#saving-files)) uploads it under this grant too, and asks for it in every folder. It is private to the gatekeeper as the Office import grant is.
- `drive` for the Drive writes grant (`https://drive.google.com/drive/writes`), which lets a Drive binding with read and write access change files (see [Drive comments](#drive-comments), [Moving and sharing](#moving-and-sharing) and [Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)): edits, comment writes, sharing and moves need full `drive`, and `drive.file` does not reach a file picked in Drive. Every consent that asks for a Drive resource type (Google Drive, Drive Folder or Drive File) asks for it too, so a Drive account can make read and write connections without a second consent, and **Read only** in the connect dialog is how one connection is kept from changing anything. An account that declined it on Google's consent screen, or was connected without it, gets it from the Drive connect dialog's **Allow changes** action, by incremental consent; an account with no Drive resource type is never asked. Once a consent asking for it has completed, the grant is among the account's recorded grants whether or not Google granted `drive`, so every later consent for the account asks for `drive` again: a reconnect, **Allow editing**, **Allow access**, **Convert**, or granting another Google resource type. A deployment that keeps Google Drive read-only asks for it at no consent (see [Keeping Drive read-only](#keeping-drive-read-only)). One grant covers every Drive write on the account. It is private to the gatekeeper as the Office import grant is, so Workshop does not list it among an account's grants and the admin page cannot turn it off separately from the Drive resource types; a deployment turns Drive writes off with `GOOGLE_DRIVE_ACCESS` (see [Keeping Drive read-only](#keeping-drive-read-only)). The token it yields can read and write every Drive file the account can, and every Google binding of the account uses that token, so a binding's scope, its access level and the grant itself are enforced in the gatekeeper's code, when a write is queued and again when it is approved. The Drive writes a binding's session can queue are comments and replies, permission changes (`permissions.create`, `permissions.update`, `permissions.delete`), a move (`files.update` of a file's parents), and the edits of a Doc, Sheet or Slides presentation it reaches (each editor's `batchUpdate`), and no other. The grant counts only while the scopes Google last returned for the account include `drive`: a consent that comes back without it withdraws the grant, and the account keeps its read and write bindings, which go on reading while it still holds a Drive read scope and whose writes are refused until **Allow changes** succeeds again; a write queued before that stays pending when it is approved, and is posted by an approval made after. Disconnecting the Google account revokes its token and forgets its recorded grants, this one included; what the app may do is shown, and can be removed, on the Google Account's own page of third-party access. Because the gatekeeper takes `drive` to cover `drive.readonly`, `drive.file` and `spreadsheets`, an account that holds it also satisfies those scopes for grants it had already recorded: the Office import, shared-drives and created-files grants, and a Sheets grant whose `spreadsheets` scope was declined or retracted, so a spreadsheet then binds as its editable type with no **Allow editing** step, while a Docs or Slides grant still needs its own scope. A verified OAuth app must add `drive` to its consent screen, where Google words it as "See, edit, create, and delete all your Google Drive files"; it is a restricted scope.
- `cloud-identity.groups.readonly` for the Google Group resource, its only scope. The owner's account uses it to list their groups and look the chosen one up; each member's own account uses it, on every open of a shared gadget, to show its own membership. A member is asked for nothing else, never for Gmail. Google classifies this as a sensitive scope, so a verified OAuth app must add it to its verification.
- `gmail.readonly` for the group mail grant (`https://groups.google.com/mail`), which the owner's Google Group connections read their mail with. Private as the Office import grant is: only the Google Group dialog's **Allow access** button asks for it, by incremental consent, and an owner holding the Gmail Mailbox grant, whose scopes read mail too, is never asked.
- `spreadsheets` to read metadata, bounded cell ranges and their formatting from directly selected spreadsheets, edit their values, sheets, rows, columns and formatting with approval, and create spreadsheets. The switch from `spreadsheets.readonly` retracted every existing Sheets grant, including one derived from `drive.readonly`: owners re-consent the next time they connect a spreadsheet, and collaborators observing an existing Sheets binding are asked to grant read-write `spreadsheets` the next time they open its workspace. A `spreadsheets` grant covers the Drive resources' `spreadsheets.readonly`.
- `spreadsheets.readonly` to read native Sheets opened from account-wide, folder, or exact-file Drive bindings.
- `presentations` to read, edit, and create directly selected presentations, and to render slide thumbnails; `presentations.readonly` to read and render native Slides opened from account-wide, folder, or exact-file Drive bindings. Google counts each thumbnail as an expensive read, limited to 60 a minute per user and 300 per project.
- `calendar.calendarlist.readonly` so the resource picker can list calendars.
- `calendar.events` to read and manage the selected calendar. Creating or changing an event nobody else is on can be auto-approved ("Add and change calendar events"). A change waits for approval when it would make the event public or otherwise widen who can see it, or when the event is an out-of-office, focus-time or other special event. Anything Google would tell attendees about, meaning an event that has or gains attendees, one organized by someone else, or one whose guest list Google hides, is "Send event invitations and updates", a separate kind a user may also opt into auto-approving, whatever `sendUpdates` is; the same visibility and special-event holds apply to it. An auto-approvable change is checked again when it applies, and fails without changing anything if the event has gained or lost guests, so that it would now fall under the other kind, or the change would now widen its visibility; the write is conditional on the version it checked, so a change made in between also fails it.
- `calendar.events.freebusy` to check availability, which `calendar.events` does not cover. Adding it retracted every existing Calendar grant that lacks a whole-calendar scope: owners re-consent the next time they connect a calendar, and an existing binding checks availability only after its account reconnects or grants Calendar again.
- `chat.spaces.readonly`, `chat.messages`, and `chat.memberships.readonly` for every Chat resource. A whole-account Chat connection adds `chat.users.readstate.readonly` for its unread-only search, and `chat.spaces.create` and `directory.readonly` to start direct messages and group chats with people in the connected account's Workspace directory. Starting a conversation is its own approval kind, separate from sending in an existing one, and people outside the organization can't be added to a new conversation.
- `bigquery` for BigQuery dry-runs and queries. This is intentionally broader than `bigquery.readonly` because dry-runs use `jobs.insert`; the gatekeeper enforces read-only SQL and resource scope checks before running queries. Query jobs run in the connected project, which must grant the account `bigquery.jobs.create`; a dataset shared from a project that doesn't (a dataset-level grant never does) is connected with `?queryProject=<own-project>` on its resource URL, which runs and bills the jobs there while the data scope stays on the shared dataset. The configurator asks for that project only when BigQuery neither lists the data's project for the account nor accepts a dry-run job from it there, since its project list can omit a project the account may run jobs in.

### Step 4: Test Users

This is important! While your app is in "Testing" mode (which it will be by default), only users you explicitly add here can use OAuth.

1. Click **Add Users**
2. Enter your own Google email address (the one you'll use to test Google API integrations)
3. Click **Add**
4. Click **Save and Continue**
5. Review the summary and click **Back to Dashboard**

### Step 5: Create OAuth Credentials

1. In the left sidebar, go to **APIs & Services** > **Credentials** (or [click here](https://console.cloud.google.com/apis/credentials))
2. Click **Create Credentials** at the top
3. Select **OAuth client ID**
4. For **Application type**, select **Web application**
5. **Name**: Enter anything (e.g., "Gadgets Local")
6. Under **Authorized redirect URIs**, click **Add URI** and enter: `http://localhost:8787/gatekeeper/google/oauth`
7. Click **Create**

A popup will appear with your **Client ID** and **Client Secret**. Keep this window open or copy these values somewhere safe.

### Step 6: Configure Your Local Environment

Create a `.env` file in this package's directory (`packages/gatekeeper-google/.env`):

```bash
CLIENT_ID=your-client-id-here.apps.googleusercontent.com
CLIENT_SECRET=your-client-secret-here
```

Replace the values with the credentials from Step 5.

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 7: (Optional) Enable Google sign-in

To offer "Continue with Google" on the login page, add `google` to the deployment's
`AUTH_GATEKEEPERS` allowlist (e.g. in the root `.dev.vars`):

```
AUTH_GATEKEEPERS=cloudflare,google,github
```

Sign-in only needs the identity scopes, which are always available, so no extra Google setup is
required. (While the app is in Testing mode, the signing-in user must still be listed as a Test
User — see Step 4.)

### Step 8: Verify Setup

1. Start the application in dev mode (see instructions in the root README.md).
2. Create or open a gadget.
3. Navigate to the **Connections** tab.
4. Click **+ New Connection**.
5. Choose a Google resource type: Gmail, Google Doc, Google Spreadsheet, Google Slides Presentation, Google Drive, Google Calendar, or BigQuery.
6. If prompted, connect a Google account.
7. You should be redirected to Google's consent screen in a new tab.
8. The consent screen acts extra-scary since this is an "unverified" test app.
9. After granting access, the tab closes, and you're back to Gadgets.
10. Use the picker to choose the mailbox scope, project, dataset, or table to connect, or for Google Drive, the whole of Drive, a folder, a file, or a document, spreadsheet or presentation to edit.
11. Create the connection. Ask the agent what it can do, or ask it to write a gadget using the new binding.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

## Gmail attachments

New messages, replies, forwards, and their draft-creation methods accept
`attachments?: GmailAttachmentInput[]`. Each input is a regular file with a filename,
MIME media type, and exact `ArrayBuffer` bytes; strings, base64 inputs, inline uploads,
and multipart container uploads are not supported.

For example, given an exported PDF as `pdfBytes: ArrayBuffer`:

```ts
using draft = await gmail.createDraft({
  to: ["recipient@example.com"],
  subject: "Cloudflare at a Glance",
  text: "Attached is the one-page overview.",
  attachments: [{
    filename: "cloudflare-at-a-glance.pdf",
    mimeType: "application/pdf",
    content: pdfBytes,
  }],
});
```

For an existing draft, `draft.addAttachment(input)` returns a readable, removable
`GmailDraftAttachment`. `draft.attachments()` lists `{info, attachment}` entries, and
`entry.attachment.remove()` removes that exact part, even when filenames are duplicated.
Dispose attachment capabilities when finished. `draft.update()` preserves attachments;
it does not replace their list. Message attachment capabilities remain read-only.

Replies include only supplied files. Forwards preserve the original attachments and
inline parts, then append supplied files. A forward draft's preserved source parts are
immutable; its added files can be removed.

Files may be empty, but each upload is limited to **10 MiB**. Filenames must be nonempty
and contain no path separators or control characters; `.` and `..` are refused.
The upload's `filename` is authoritative: redundant MIME `name`/`name*` parameters are
discarded, while other media-type parameters such as `charset` are preserved.
Outgoing MIME is limited to **25 MiB**, including transfer encoding and message headers.
The binding's existing **50 MiB** retained-file quota is shared by uploads and forward
source snapshots, including uploads in active drafts.

Uploaded bytes are captured in the existing integrity-checked chunk store, not embedded
in queued-action metadata. Pending reads expose the files before approval, and body edits
and Durable Object restarts preserve their exact bytes. Approval descriptions include
filename, media type, size, and SHA-256, with uploaded bytes marked as incomplete for
human review. Files remain retained while a pending action or active draft references
them and are released when the last reference is removed. Rejecting a prerequisite
invalidates dependent edits; reject those edits too to release their references.

Calendar files retain their original line endings and charset rather than being normalized.
Nested `message/rfc822` files also retain their exact bytes, including trailing line endings,
through edits and sends; duplicate `.eml` filenames and identical files remain separate parts.
Provider draft rewrites correlate attachment identities by metadata and SHA-256 in the actual
MIME order, so queued edits and removals still select the right part when inline parts move.
An imported attachment without a disposition keeps its identity when a draft rewrite
emits the regular `attachment` disposition.

Draft and send fingerprints are prefixed `v2:` and hash attachment bytes exactly. Approvals
queued before that upgrade keep their unprefixed fingerprints and still apply, including a send
whose response was lost, which is reconciled rather than sent again. See
`plans/gmail-simulation.md` for how they are verified.

### Gmail PDF attachments

Every `GmailAttachment` has `readPdf()`: a message's, a pending message's, a draft's, and those
of the message a hook delivers. It takes no argument and returns `{text, hasText, transcribed}`
as Drive's `readPdf(fileId)` does, from the same reader (`pdfToText()` in `src/drive-pdf.ts`,
built by `pdfConverter(env, GMAIL_PDF)`). What [Google Drive bindings](#google-drive-bindings)
says of that reader holds here: the conversion, pages drawn and read in bands, page images sent
as stored, pages read ahead of the reader, the notes on a page, the idle minute, what is billed,
the `AI` and `PDF_RENDERER` bindings, `PDF_OCR` and `PDF_OCR_CALLS`. Its failures are in Gmail's words (`The Gmail attachment could not be
converted from PDF.`, `The Gmail attachment's PDF could not be transcribed.`, `The Gmail
attachment changed while it was being read; read it again.`), and its log lines are
`google.gmail.pdf.*` under the component `gatekeeper.google.gmail.pdf`. A part is read when its
MIME type is `application/pdf`, parameters and case aside, or its filename ends in `.pdf` in any
case; any other is refused with `This attachment is not a PDF.` before anything is fetched. What
differs from Drive is how the bytes are had.

Gmail gives an attachment only whole, as a JSON object whose `data` member holds the bytes in
base64url (`users.messages.attachments.get`), and has no ranged read.
`GmailApi.openAttachmentContent()` asks for it with `?fields=data` and resolves once Gmail has
begun its answer, having read none of it. `gmailAttachmentBytes()` (both in `src/google-api.ts`)
decodes `data` as it arrives: a chunk of the answer is read only when the stream is, decoded and
handed on, and nothing is kept of it but the parser's place and the bits of an unfinished
quartet. It takes whitespace, other members around `data` (strings, numbers, `true`, `false`,
`null`), either base64 alphabet, padding or none, and a base64 character written as a JSON
escape. Any other answer, one with a nested member, a second `data` or an early end included,
errors the stream with `Gmail returned an invalid attachment response.`, and one without `data`
with `Attachment content is no longer available.` The bytes must number the `size` the message's
listing gave: the stream errors with `Attachment content no longer matches the authorized
snapshot.` at the end of the chunk that takes it past `size`, and at the string's end when there
are fewer. Cancelling the stream cancels Gmail's answer. A part whose data came inside the
listing is decoded from that string, 65,535 bytes at a time, once its length has been checked.
Only the wait for an answer to begin is timed, at 60 seconds over all of `fetchWithAuthRetry`'s
attempts together (a backoff sleep in progress, of up to 10 seconds, is not interrupted), so a
long attachment is not cut off. Its body is timed by what reads it: the pass described below,
the idle minute while it streams into the renderer, and during `readPdf()` itself, while it
streams into the conversion, a minute for each read of it that is outstanding (the conversion
takes the bytes at the pace of its own upload, which is not counted). An attachment that stops
arriving then fails `readPdf()` with `The attachment stopped arriving while it was being read;
read it again.`, having reported nothing and let its approval queue go.

`readPdf()` has no size limit of its own for bytes Gmail holds (a message's attachment, and a
draft's part that Gmail stores) and does not go by `readable`; `getContent()` and its 10 MiB
limit are unchanged. Bytes this binding stores (a pending message's part, and a draft's uploaded
file, inline part or forward source) are read whole at each open, one copy, and handed on 64 KiB
at a time. A forward copies its source's parts under the whole message's 25 MiB limit alone, so
such a part can be over 10 MiB: it is then refused before it is read, with `This attachment
exceeds the 10485760-byte safe limit for a PDF read from a pending message or a draft.`, and can
be read from the forwarded message instead.

A text with pages to transcribe reads the attachment again as it is read. A PDF whose pages are
drawn is fetched whole once more, for the first page drawn, and streamed into the renderer, as
Drive's second download is. Page images sent as stored are what Drive reads by range;
`forwardRangeReader()` (`src/pdf-forward-reader.ts`) serves them from one pass over a single
open answer instead. The bytes before an image are read and dropped, each chunk of them moving
the idle clock; the image's own are read only as the model's request takes them; and the pass
then stays open, unread, for the next image, with nothing of the file kept but the rest of the
chunk the last image ended in. Pages are read ahead here as on Drive, and the pass is why an
image is asked for only once the one before it has been read to its end: the next is then taken
from the pass while the answers before it arrive. So a scan read as stored costs one more fetch
of the attachment, as far as its last page image, however many pages it has, and reading ahead
adds no reported read to that one. A pass breaks when a read of it fails
or it ends before the image does, and stalls when a read of it has waited 15 seconds for a
chunk; the time between two images, while the model answers, is not counted. Either way the pass
is let go and the attachment opened again from its start, once for each image, which goes on
from where it had got to. A second break or stall under the same image fails the text: with what
the read failed with, as a changed attachment when it ended short, or with `The PDF stopped
arriving while a page was being read; read it again.` An open that fails is not tried again. An
image that a later update to the file defined again lies after the images of later pages, so its
range starts before the pass's place and a new pass is opened for it: four times for one text,
after which the text fails as a failed transcription. A page whose call the model's service
refused has its image asked for again, for which a new pass is opened too, as one is for the
next image when the refused call had not taken all of its own: each is one more reported read,
`…from page image N on`, and neither is counted among the four.

`readPdf()` reports one observation, `Read Gmail attachment text`, after the conversion and
before anything is returned or a refusal to transcribe thrown, since such a refusal says what
the content is like. A conversion that answers before the bytes have ended is refused: they are
known to be the listed ones only at their end. Every later open (the whole read for the
renderer, a pass, a pass opened again) is an observation of its own under the same title, its
description saying which read it is, authorized once the attachment is open and before any of
it is used; a refusal lets what was opened go and fails the text. A text that may read the
attachment again keeps its approval queue and its pass until it ends, whether by its end, a
cancel, an error or the idle minute; any other lets both go before it is returned. A draft
attachment's capability is checked for staleness when `readPdf()` starts and at each open, not
while a pass already open is read, so the text of a draft that has changed fails at its next
open. In the workerd tests a text returned over RPC was pulled before its reader read anything,
so the first later read, and its observation, can follow `readPdf()` at once.

The tests fake Gmail at the fetch layer (`__tests__/workerd/gmail-pdf.test.ts`) and test the
decoder on answers built for it. What they assume of Gmail was checked once against the real
API, on four generated PDFs of 362,648 to 20,897,581 bytes inserted into a mailbox as
attachments, over HTTP/1.1 from a workstation and not from a Worker:

- `attachments.get?fields=data` answers with one pretty-printed object, `{"data": "…"}`, sent
  chunked, its `data` in the base64url alphabet with `=` padding and no whitespace inside it.
- The `size` a message's listing gives for a part was the count of the decoded bytes, and the
  bytes were the file's, for all four.
- An answer left unread was still good after 30 and 45 seconds and had been reset by Google
  after 60, 75, 90 and 240. A pass is left unread while the model reads a page, so it can break
  under a slow page, at about the moment the text's own idle minute ends it; opening again is
  what covers it.
- A message read twice lists a different attachment id each time. An id went on working 25
  minutes after it was listed, which is as long as it was tried, so opening again with the id a
  listing gave holds over the time a text is read.

Not checked: the same from a Worker's `fetch`, which may hold more of an answer before it stops
taking it; that the runtime does not draw in an answer nobody reads, seen only against a faked
fetch; and the decode's cost as a Worker's CPU (about 50 ms for 10 MiB in Node). A pass stops at
the last page image, short of the answer's end where the byte count is checked, so on a pass an
attachment that ends short of an image fails as changed and no other change of size is noticed.

## Sharing Gmail with a Google Group

A **Google Group** connection reads only the mail addressed to that group, live from the owner's
own Gmail mailbox, and is read only (`GmailGroupSession` in `src/types.d.ts`). If the owner shares
a gadget or workspace using it, the group's members can open it, and nobody else can. It is its own
resource type rather than a Gmail view, so a member is asked only to show their membership, never
for Gmail access, and an admin can switch it off alone. `plans/gmail-group-sharing.md` is the
design record.

- **Only the group's mail.** A message is shown when Google's headers prove it came through the
  group, when the owner sent it to the group, or when it names the group as a recipient and DMARC
  or DKIM authenticates it as from the group's own domain. Authenticated mail from any other
  domain that only names the group is shown as a reply in such a conversation, never on its own,
  so nobody outside can start a conversation members see unless the group delivers it. Nothing
  else in a conversation is shown or described: no side replies, labels or unread state, and
  the snippet and count are those of the shown messages.
- **Only members.** Every read reports the group as a subresource (`gmail/group/<groupId>`, see
  [docs/observers.md](../../docs/observers.md) §10), and the Workshop asks Cloud Identity, with each
  collaborator's own Google account, whether that account is a direct member, refusing otherwise
  or when the check fails. A member sees all of the group's mail the owner has, including mail
  from before they joined. An account's answer is reused for up to 15 minutes, so someone removed
  from the group can still open the gadget for that long. Membership is checked when a gadget is
  opened, not while it is open: someone removed keeps a session they already have, new group mail
  included, until they reopen it.
- **Searches test only what a message says.** `label:`, `is:`, `in:`, `category:`, `deliveredto:`,
  `bcc:` and most `has:` terms are refused, since they would reveal the owner's own mailbox through
  what matches, and a message with a Bcc never counts as the match.
- **Not restricted data.** As with a Gmail Mailbox, reading group mail leaves the workspace's web
  fetches and auto-approval rules on, so a hook can act on new mail unattended. Who can open the
  gadget is decided by group membership alone.

Things to know:

- Workspace groups only, and direct members only; people in it through another group are refused.
- The group's "Who can view members" setting must include its members, or every member is refused.
  The dialog doesn't offer a group that hides its members from the owner, and warns when it can.
  An owner who manages the group sees its members whatever the setting, so the dialog can't check
  it for them and says so.
- A copy of a message that some other mailing list delivered is never shown, even when it names
  the group: when one message goes to two lists the owner is on, Gmail may keep only the other
  list's copy.
- The group's domain must sign with its own DKIM key (Workspace's default `gappssmtp.com` key
  doesn't count), and an inbound gateway Workspace doesn't trust can leave mail unvouched for too.
  Either way none of it is shown; the dialog checks the group's recent mail and says so.
- Mail that names the group is shown even if the group rejected or held it, when a colleague on
  the group's domain sent it or it is a reply in one of the group's conversations, since it is
  still the sender's own authenticated mail. It wakes the group's hooks as well.
- A new message from outside that was sent to the owner and the group both can reach the owner
  without the group's headers. It appears once someone replies to the group, and no hook fires
  for it. For a group that outsiders write to, such as a feedback or support address, choose
  **Who emails this group? Anyone, including people outside** when connecting (`?senders=anyone` on the resource URL):
  authenticated mail from anyone that names the group is then shown, and wakes hooks, at once.
  Leave it off for an internal group, where it would let anyone outside put mail in front of
  the team's gadget by naming the group.
- Google Groups resends some outside senders' mail under the group's own address ("Name via
  Group"), and who wrote it is then not always given. `replyTo` is where replies are asked to
  go, which the group's settings can point at the whole group or its owners, not who wrote it.
- The mail comes from the owner's own copies: nothing from before they joined the group, nothing
  they have binned, and nothing at all if they get the group as a digest or read it only on the
  web.
- An owner who leaves the group keeps sharing the copies they already have. Remove the connection
  to stop.
- A team gadget should carry no personal bindings: what a gadget stores reaches every collaborator.
- Members' reads spend the owner's Gmail quota.
- Switching off the Gmail Mailbox resource doesn't stop Google Group connections, which read mail
  with their own read-only grant; switch off Google Group as well.

## Google Chat and Gmail new-message hooks (optional)

Gadgets can watch a Chat conversation for new messages (see `docs/google-chat-capabilities.md`),
and a Gmail inbox, label, thread or group for new mail (`subscribeNewMessages()` in `src/types.d.ts`).
Google delivers both through Pub/Sub, Chat's by Workspace Events and Gmail's by `users.watch`, so
this needs a public URL and these steps in the same Cloud project as the OAuth client:

1. Enable the **Google Workspace Events API**, the **Cloud Pub/Sub API**, and the **Gmail API**.
2. Create a Pub/Sub topic for Chat, granting `chat-api-push@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on it, and one for Gmail, granting
   `gmail-api-push@system.gserviceaccount.com` the same role. One topic granting both may serve
   for both.
3. Create a service account for push authentication (it needs no roles). Whoever creates the push
   subscriptions needs `iam.serviceAccounts.actAs` on it (e.g. **Service Account User**). Pub/Sub
   signs push tokens as its service agent, `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com`,
   which needs `iam.serviceAccounts.getOpenIdToken` on this account. Its default **Cloud Pub/Sub
   Service Agent** role on the project includes that; only if it lacks the permission, grant it
   **Service Account Token Creator** on this service account.
4. Create a **push** subscription on each topic with endpoint
   `${BASE_URL}/pubsub` (e.g. `https://example.com/gatekeeper/google/pubsub`), **Enable
   authentication** with the service account from step 3, and audience set to that same endpoint.
5. Set these values for this worker (in `.env` locally), both topics to the same one if it serves
   for both:

   ```bash
   PUBSUB_CHAT_TOPIC=projects/your-project/topics/your-chat-topic
   PUBSUB_GMAIL_TOPIC=projects/your-project/topics/your-gmail-topic
   PUBSUB_PUSH_SERVICE_ACCOUNT=your-push-account@your-project.iam.gserviceaccount.com
   ```

If the deployment sits behind Cloudflare Access, add a bypass for `/gatekeeper/google/pubsub`;
the worker instead accepts only pushes whose Google-signed token names that endpoint as audience
and `PUBSUB_PUSH_SERVICE_ACCOUNT` as sender. That token proves a push came through a push
subscription, not who published to its topic, so each topic's Pub/Sub principals are trusted with
hooked messages: anyone who can subscribe to it reads them all, and anyone who can publish to it
can inject messages into hooks of either kind, since a push is routed by its shape rather than
its topic. Grant those roles to no one beyond step 2. A Gmail push carries only a mailbox address
and a history ID, so a forged one can only make the worker read that mailbox's new history with
the connected account's own credentials. Without its topic and the push service account a kind of
hook is refused, and everything else works as before.

Disconnecting a Google account drops its hooks from the mailbox's and each space's driver, so
nothing goes on reading or renewing with credentials that are gone; a watch or subscription no
hook uses any more lapses, as when the hooks are disabled.

## Worker Preview OAuth callbacks

Deployments using Worker Preview hostnames can register one stable Google callback and relay the
result to the preview that initiated authorization. Configure the stable Worker and its previews
with the same `OAUTH_STATE_SIGNING_SECRET` and `OAUTH_ALLOW_PREVIEW_REDIRECTS=true`. Set the fixed
redirect only on previews:

```text
OAUTH_REDIRECT_URI=https://gatekeeper-google.example.workers.dev/oauth
```

Register `OAUTH_REDIRECT_URI` as the authorized redirect URI in Google. The preview sends that fixed
URI to Google and carries its own callback in signed, short-lived OAuth state. The stable Worker
accepts return URLs only on its `<preview>-<worker>.<workers.dev>` hosts and forwards only the OAuth
result and state. Normal deployments should omit these settings and continue using
`${BASE_URL}/oauth` directly.

Deploy the relay-capable stable Worker before enabling the fixed redirect on previews. Wrangler
stores baseline and Preview secrets separately, so provision the same signing value in both places.

## Creating files

Google Docs, Sheets and Slides, and Google Drive folders, are creatable resource types: an agent can
ask for a new one with `createExternalResource`, giving a one-line title (trimmed, at most 256
characters), and its binding works at once, before anything exists at Google. Until the creation is
approved the gatekeeper simulates an empty file: a Doc reads as one empty tab and queues edits and
new tabs as usual, a spreadsheet as
one empty `Sheet1` of 1000 × 26 cells, which takes no change until it exists, and a presentation as the one Google creates, a 16:9 deck
with a title slide, which queues changes as usual. Of the default theme's layouts it offers only
five (title slide, section header, title and body, title only, and blank); the others become
available once the presentation exists. A folder lists nothing and opens nothing. Nothing reaches
Google and no account is involved.

A creation is never auto-approved. The approver picks which of their connected Google accounts to
create the file in, and where in that account's Drive (My Drive by default, or any folder or shared
drive the account can add files to), and the binding switches to the real file. The picker opens
on the folder the agent suggested, read from its Drive link, when it suggests one, and says the
agent chose it until the approver chooses another. A suggestion that names no folder the account
can add files to selects nothing, and the picker says so, so the approver must choose. A folder is
made in place, by an account that also holds the Drive folder grant, without which its binding
could read only what this app puts in it. The Docs, Sheets and Slides APIs cannot name a folder,
and Drive's own `files.create` would lose the default `Sheet1` and fixed Slides IDs the
simulations rely on, so those files are made in My Drive and then moved. The folder is checked
before anything is made; a retried approval binds the file the first one made and moves it to the
retry's choice, reading where it is rather than trusting what was recorded. Only the account the
file was made in can move it, so another approver's retry is refused unless it chooses where the
file already is (their own My Drive is never that). Doc edits queued against the simulation then
apply to the created document like any other edit, and Slides changes apply to the created
presentation unchanged.

That works for Slides because Google gives every new presentation the same object IDs (master
`simple-light-2`, title slide `p`, and layouts `p2` to `p12`, seen both on a personal account
through the API and on a Workspace account in the editor), so the simulation reads a recording of
one, `src/blank-presentation.json`: each read a session makes, through the session's own field
masks, less the presentation's ID, title and revision and the layouts it does not offer.
`pnpm --filter @gadgets/google-gatekeeper record:blank-presentation <token-file>` records it again;
the file holds an access token with the `presentations` and `drive.file` scopes. It creates two
presentations, refuses to record unless they read the same, and deletes them; with `--check` it
compares them with the committed recording instead. Should Google's new presentation change, a
queued change naming a slide, element or layout the created presentation lacks fails when
approved, writing nothing.

A folder is created under an ID Drive generated for it (`files.generateIds`), recorded before the
create is sent, so a create whose reply is lost is sent again, by the request and by a retried
approval, and Drive, which answers 409 for an ID already used, makes the folder once. A retry that
did not make the folder, after a 409 or a success, reads it back and is refused if it was trashed
or deleted since, and every attempt needs both grants. The Docs, Sheets and Slides create calls
take no such ID or idempotency key. A retried approval after a lost reply binds the file already
created (the gatekeeper records it), but one of those files can still be orphaned in the approver's
Drive: by a create request that times out or fails with a 5xx after Google acted, or a crash
between Google's reply and that record being written. A creation rejected after an approval whose
success was lost orphans a folder too. A created file's ID is logged
(`google.creation.file.created`) once its create's reply arrives; an orphan whose reply was lost
has to be found in the approver's Drive.

## Saving files

Docs, Sheets and Slides also declare `savableFrom` (`.docx`, `.xlsx` and `.pptx`), so a user can
save a file of that type, such as a gadget's export, to their Drive as a native file
(`GatekeeperUser.saveFile()`). No agent is involved, and nothing is simulated, queued or logged as an
action. The user picks the folder in the creation dialog, opened for saving, which asks for the
created-files grant in every folder, My Drive included: the file is uploaded, and an upload needs
`drive.file` wherever it lands. That grant is all a save needs, so it works where Drive is otherwise
read-only (see [Keeping Drive read-only](#keeping-drive-read-only)).

The gatekeeper streams the file to Drive through a resumable upload session, 8 MB at a time, so it
never holds the file whole, and stops at the size Drive imports into the type (`about.maxImportSizes`:
10 MB for Docs, 100 MB for Sheets and Slides). Drive converts it once the last chunk arrives
(`files.create` with the native MIME type); until then nothing is made, and a session abandoned
part-way leaves nothing behind. A file a save makes is marked in its `appProperties`. Saving again,
to the URL the first save returned, replaces that file's content (`files.update`), keeping its ID,
link, name and sharing; only a marked file is replaced, whatever else the account may edit, and one
that is in the trash, deleted, or no longer within the app's reach is refused with a message to save
a new copy. After a lost or failed reply the gatekeeper asks the session what it holds and sends only
the rest, so a retry never makes a second file. Each save is logged (`google.save.saved`,
`google.save.failed`) without the file's name.

## Office files

Google's Sheets, Docs and Slides APIs cannot edit an Office file stored in Drive (`.xlsx`, `.xls`,
`.xlsm` and `.ods`; `.docx`, `.doc`, `.odt` and `.rtf`; `.pptx`, `.ppt` and `.odp`): Sheets and
Slides refuse to open one, and Docs reads one but refuses every edit to it. So the Drive picker
lists them as the type they convert into, and choosing one converts it. The connect dialog says
what converting does and offers **Convert**, which has Drive copy the file into the native type
(`files.copy` with the native MIME type: Google converts it, and no file content passes through the
Worker). The copy is named after
the original without its extension, lands next to it when the original's folder takes new files and
at the root of My Drive otherwise, and is what gets connected. The original is never changed, and later edits
to it do not reach the copy. The conversion is Google's, and loses what Google's import loses, such
as macros, some formulas, and complex layout.

**Convert** asks for the Office import grant (see the scopes above) when the account does not yet
hold it. Workshop opens Google's consent pop-up, and the dialog waits up to three minutes for the
grant before giving up. Each copy carries app properties naming its source (`gadgetsConvertedFrom`)
and the source's modification time when it was copied (`gadgetsSourceModified`), so choosing the
same file again offers the copy made before instead of making another; using it reads only Drive
metadata, so it needs no new grant. App properties are private to the OAuth client that set them
but not to a user, so only copies this deployment's client made are found, and of those only ones
the account can edit; that may include a copy another user made in a folder they both edit. The
lookup is best effort: a missed match makes another copy. A copy request is never retried, since a
lost reply may still have made one. A file whose owner has turned off copying, a file in the trash,
or one larger than Google imports into that type (`about.maxImportSizes`) is refused before
anything is copied.

A pasted link to an Office file fails to connect, and its error offers to open the connect dialog,
where it can be converted. An Office file bound any other way is refused with a message pointing to
the dialog: by Sheets and Slides when they cannot open it, and by Docs on connecting, since Docs
reads it. An Office file already bound as a Doc answers each approved edit with the same message.

## Google Docs edits

A `.docx` or other Office document cannot be bound; connecting one makes a native copy (see
[Office files](#office-files)). A directly bound Doc accepts fourteen changes, each call queued for
approval as one change: `replaceText()` and `appendText()` edit one tab's Markdown,
`insertTable()`, `insertTableRows()`, `insertTableColumns()`, `deleteTableRows()`,
`deleteTableColumns()`, `deleteTable()`, `mergeTableCells()` and `unmergeTableCells()` change a
tab's tables, `setTableCellStyle()`, `setTableColumnWidths()` and `setTableRowHeights()` change
a table's look, and `addTab()` adds a tab, which reads as an empty tab and takes every other
change while its add waits. Changes apply in the order they
were queued. Calls on one document take effect in the order they are made, whether or not the
caller awaits each before the next: a write waits for the writes before it, and so does a read that
shows queued changes (`getContent()`, `listTabs()`, `getMetadata()`). A Doc opened from a read-only
Drive binding has none of the write methods; one opened from a read and write Drive binding has
all of them but `addTab()` (see
[Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)).

`getContent()` shows a table as HTML. A replacement that lies inside one table changes the text of
its cells' paragraphs, headings and list items, in one cell or several, written in that HTML:
`&amp;`, `&lt;` and `&gt;` for `&`, `<` and `>`, `<br>` for a line break within a paragraph, and
`<strong>`, `<em>`, `<s>` and `<a href>` for bold, italic, strikethrough and links. Everything else
in the table has to stay as it is, so a replacement cannot add or remove paragraphs, list items,
cells, rows or columns, change the table's look, or change a table together with the text around
it. The characters
a replacement keeps are not rewritten, and the only formatting sent for them is the bold, italic,
strikethrough or link the replacement changes. A link that stays is never cleared, so a word
corrected inside a link stays part of it, and a link pointed to another URL as a whole is only
pointed there. A kept character that shares a grapheme cluster with text the replacement changes,
as a letter does when new text goes between it and its combining accent, is written again as new
text, in a cell or outside tables, since Google does not insert text inside a cluster. New text
takes the bold, italic, strikethrough and link the replacement gives it, and loses the characters
Google removes from inserted text. Text a replacement leaves with no link,
where it had one or was typed next to one, also loses the colour and underline Google gives a link,
and nothing else of its look. A link to a heading that does not exist fails when the change is
approved, and writes nothing.

Google stores bold, italic or strikethrough written into a paragraph whose named style already
gives it as inherited, and a read shows only the formatting text sets itself, so such formatting
reads without its tag once the change is applied: italic written into a Heading 6, bold into a
heading the document's owner made bold, in a cell or outside tables. The read of a waiting change
shows it so too, so that the changes queued behind it find their tables as they will be. Text a
replacement does not rewrite keeps such formatting where it has it, as text given it before its
paragraph took that style does. The copy of the document that changes are made in (see below) holds each
paragraph's named style, a title's and a subtitle's included, with the queued changes made in it,
so a replacement is checked the same with changes waiting as with none. A subtitle reads as italic only where its named style makes it so.

A paragraph break written inside a paragraph outside tables is accepted: the text after the break
becomes a normal paragraph and reads as normal text reads it, also where the normal style gives
the bold, italic or strikethrough that text had, which then reads without its markers. Inside a
subtitle, a replacement that rewrites none of its formatting markers is refused where the text it
writes, apart from what it does not rewrite, starts after the start of the subtitle's line and ends
in new text followed by a break before the subtitle's end, and the refusal says to write the break
at the subtitle's end or to replace the whole subtitle. Where such text starts the line, it is
written ahead of the subtitle as paragraphs of its own, and the text after the break stays the
subtitle. A break written there any other way is taken as in any paragraph.

The HTML also shows a table's look, the parts of it a request can set: each cell's shading,
vertical alignment, padding and borders as `style` on `<td>`, each fixed column width in a
`<colgroup>` line after `<table>`, and each row's least height as `style` on `<tr>`. A field Google
leaves out reads as the default a table added through the API has (no shading, top alignment, 5pt
padding, a 1pt solid black border), and a table that sets only these defaults, explicitly or not,
reads as plain `<table>`, as one added with Insert › Table in Google Docs does. What most cells share is written once on `<table>`, each
longhand separately, a tie going to the default, and a cell writes only what differs from it,
`transparent` for an unshaded cell under a shaded table. Google stores an edge on both cells that
share it, and both show it. A merged cell shows its block: its shading, alignment and padding are
the top-left cell's, and its right and bottom borders those Google keeps on the block's last column
and row. A cell that a merged cell covers shows no look.

`setTableCellStyle()` sets the shading, vertical alignment, padding and borders of a block of
cells. Values are checked when the call is made: a colour as `#rrggbb`, padding from 0 to 100pt and
a border from 0 to 24pt wide, at most three decimals kept, though Google takes any padding,
negative ones included. It is sent as one request for what is not a border, one for `border`, and
one for each edge `borders` names, in that order, since Google applies a border to every cell a
request reaches: the block's top edge is the top of its first row, and the edges between its rows
the bottoms of all rows but its last. Google keeps an edge on both cells that share it, so an edge
set on the block's outside changes the cell beside it too, and a later write wins. A request
reaches the whole of every merged cell it reaches any part of and draws a border along the merged
cell's outside, so the block has to hold every merged cell it takes in whole, and one that holds a
merged cell cannot set the edges between its rows or columns. `setTableColumnWidths()` makes
columns a fixed width, from Google's least of 5pt to 1,000pt, or has them share what the fixed ones
leave of the page; the other columns keep theirs. `setTableRowHeights()` sets rows' least heights,
from 0 to 1,000pt, sending only the height so a pinned header row stays pinned. A change to a
table's look leaves the table's identity as it was, so a change queued behind it does not fail
when it does.

`mergeTableCells()` merges a block of at least two cells into its top-left one. Google joins the
paragraphs of every cell into it, row by row, keeping their headings and list items, and a cell
that is one empty paragraph adds none, the top-left one included; the others are left one empty
paragraph. It also sets each merged row's least height to the height it renders at, which only
Google knows, so the change sends the rows' heights again after it. The merged cell keeps the
top-left cell's shading, alignment and padding. A block may hold a merged cell whole, but a block
that takes in part of one is refused, as Google refuses it. Google also refuses a block that takes
in a pinned header row together with a row below the header. No read shows which rows are pinned,
but the copy of the document says which are, so the merge of such a block is refused when
it is called, with or without earlier edits waiting. So that reads can show the
merged cell exactly, the first version refuses a block where a cell other than the top-left one
starts with a heading, a list item or a subtitle or holds a numbered list, where any cell holds a
table, a footnote, a smart chip or an element the view does not show, or an empty paragraph beside
others, or an empty top-left cell that is a heading or list item, and a table that holds
suggestions. A block where any cell holds a positioned image is refused as well, when the call is
made and again at approval, since what Google does with the image's anchor then has not been seen.
`unmergeTableCells()` splits a merged cell named by its top-left cell: its text stays there, and the
cells it covered come back empty and editable. Google gives those cells the looks they kept while
covered, which no read shows, so the change then sets each of them to the merged cell's look, the
edges between them taking its top edge. Rows and columns that cross no merged cell can be added and
deleted in a table that has some, and its merged cells move with their lines. One that crosses a
merged cell is refused, naming it: Google grows a merged cell that lines are added through, gives
lines copied from one its spans, and moves or shrinks one whose lines are deleted.

A replacement outside a table is applied to the tab's paragraphs as Markdown. One that changes a
table together with text outside it, or the blank line between a table and the paragraph beside it,
is refused, and the refusal says to write text that goes above or below a table as a change to the
paragraph on that side, and to use `insertTable()` and `deleteTable()` for a table as a whole. It
names two spellings, as the `replaceText()` documentation does. A paragraph with text is quoted by
its own characters, with the blank line and the table left out. An empty one (the paragraph Google
Docs keeps before a table that opens a tab, between two tables, and after a table added with
nothing after it) has no characters, so it is quoted as its empty line together with the blank line
and the table's first or last characters, all unchanged, with the text put on the empty line
(`\n\n<table` replaced by `## Results\n\n<table`).

The blank line beside a table stays. The paragraph next to a table is removed by taking the blank
line on the paragraph's other side with it.

A list item replaced by nothing is removed with its paragraph, whether or not the replaced text
holds the line break after it, so the items around it stay one list. A nested item's line starts
with the indentation before its marker, which the replaced text may leave out only together with
the line break (`- b` for the line `  - b`). Quoted from its marker with the line break (`- b\n`),
the item is cut out of the Markdown as it reads, and the indentation left behind goes to the next
line: an item there is nested that much deeper, or the change is refused where that passes the
ninth level, and a blank line or the end of the tab there keeps a paragraph of those spaces.

Two cases leave an empty paragraph in the removed item's place, which the read of the waiting
change shows. The only item of its list, with a blank line on both sides, leaves one with or
without the line break: to remove it, replace the item together with the blank line after it
(`- a\n\n`), or, where the item is the last paragraph of the tab, together with the two line breaks
before it (`\n\n- a`). And where the line break cannot go with the item (the item is the last
paragraph of the tab, or stands before a table, behind an item of another level or list; or a line
beside it holds an image, a smart chip or a footnote), the item's text and bullet go and its
paragraph stays: quoted with its line break, the same removal is refused or leaves that paragraph
too.

A table is named by its position among the tab's tables, counting from 0, and its rows and columns
from 0 too; `insertTable()` returns the position of the table it adds. A queued change to an
existing table (rows or columns added or deleted, cells restyled, merged or split, widths or
heights set, the table deleted) remembers how its table read
when it was requested, and is kept to that table by one rule: it applies only while exactly one
table of the tab reads so, wherever in the tab that table then is. So such a change is refused
while another table of the tab reads the same (two empty tables, two that hold only the same header
row): the refusal names the other table and says to make the two differ first, for example by
changing the text of a cell with `replaceText()`. Such a replacement quotes the text above the
table together with the cell, so that it matches once. Adding a table that reads like another is
not refused, and neither is replacing the text of its cells. "The same" leaves out where a
numbered list in a cell starts and the number of a footnote: both are counted through the whole
tab, so an edit elsewhere moves them, and two tables that differ in nothing else would trade
readings. Any number in square brackets counts as a footnote's, since the Markdown does not tell
the two apart. It leaves out the table's look too, and so does what a change remembers: a
collaborator restyling a table, resizing its columns or rows, does not fail the changes queued for
it. A replacement written against a cell's `style` attribute is the exception, since it is found
by its text: it no longer matches once the cell is restyled, so quote the text of cells, not their
tags.

A queued change whose table was edited meanwhile, that was built on a change since rejected, or
whose table another table has come to read the same as, fails without writing and says so. When a
queued change that adds or deletes rows, columns or a table, merges or splits cells, or replaces
the text of cells fails, every change to an existing table queued after it on that tab fails with
it, a change to its look included, since their tables were recorded with it applied. A new table
and a text replacement queued after it do not fail with it, and a failed change to a table's look
takes nothing with it. On a Doc's own connection a rejection is settled at
once, by replaying what is still queued over the stored copy, so that it is never weighed together
with another rejection or with a collaborator's edit; where none is stored, as after an approval
whose reread of the document failed, it is settled as on a Doc opened through Drive. A Doc
opened through Drive replays nothing at a rejection: the changes to existing tables queued
behind a rejected change to a table's structure or to the text of its cells fail with it, as
they do behind one that fails or is refused when it is approved, and the rest stay queued for the
next read, which replays them (see
[Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)). That leaves two ways in which
a collaborator can still
send a change to another table between two reads: by moving the text that an earlier queued
replacement was found by to the other of two tables that read the same (the replacement, and a
change to its table queued behind it, then go to that table), or by changing one table and making
another read exactly as it did.

The cells of a table, row or column that is added take plain text, in which `\n` starts a paragraph
and U+000B breaks a line. `insertTable()` puts the table after the paragraph, heading, list item or
table that its `after` text ends in, or at the end of the tab. Google Docs keeps a paragraph on
each side of a table, so one empty paragraph is added with it: after the new table, or between the
two tables when it follows one. Every cell of a new table, and that paragraph, is reset to a normal
paragraph with no list and no indent, in default text. A row or column added to a table takes the
look of the cells beside it, as Google copies it: cell shading, alignment, padding, borders, font,
size and colour, and the row's least height or the column's width.
It never takes their bold, italic, strikethrough, links, list items or headings, so new cells read
as plain paragraphs; a cell added beside one that starts with a heading or a list item is reset to
default text, since the request that takes the heading off takes the rest with it. "Beside" is the
row or column the new ones go before, or the last one when they go at the end. The header rows a
table pins keep their count when a row is added beside one: Google would pin the new row as well,
so the change pins the count again. A row added above a header row therefore becomes a header row,
and the last of the rows that were pinned stops being one. Reads do not show it, since pinning is
not something the Markdown shows, but the approval card says which new rows the header takes in and
how many of its rows it lets go, and the change is refused at approval once the header's size has
changed since it was queued. Google copies a cell's borders as the cell stores them,
so an edge it shares with the line beside the new one can read differently on its two sides. A
column added beside one that shares the page's width can make Google narrow the table's fixed
columns, and only sometimes, so such a change sets every fixed width back to what it was. Reads
show all of this as it will be. Where a cell
beside the new rows holds one dropdown, person chip, date chip, rich link or placeholder and no
text, Google Docs copies it into each new row, as the status tables it offers as building blocks
need: a dropdown of the same choices set to its first, and the placeholder character for the
others, also where spaces follow the chip, which are not copied. The new cells in that column take
no text, and reads and the approval card show the copies. Of two or more person chips, date chips
or rich links, Google copies nothing, and the new cells take text as any other. A chip alone in a
cell reads as an empty cell, so a queued row insertion records what the row beside it copies, and
fails without writing once that row comes to copy otherwise.

What cannot be applied exactly is refused. Each of the following is refused when the call is made,
before anything is queued:

- adding rows or columns beside, or deleting, lines that cross a merged cell, since Google grows,
  copies, moves or shrinks the merged cell then, or the text of a cell a merged cell covers, which
  Google writes into the merged cell. The merged cell's own text can be replaced;
- changing anything in a table inside a cell, or the text of the cell holding it;
- changing the text of a cell paragraph that holds an image, smart chip, footnote or rule, or that
  is a subtitle;
- adding a table between two items of one list, or deleting one that sits between two items of one
  list;
- deleting rows, columns or a table that hold a footnote (the footnotes after it would be
  renumbered), or that hold items of a numbered list while a numbered list follows them in the tab
  (the deletion would renumber it, and the Markdown does not say how);
- adding a table beside a paragraph that holds a positioned image, where the image would end on the
  other side of the table from its text: after a table that such a paragraph follows, or after an
  empty paragraph that holds one. After a paragraph with text the table is added, and the image
  stays with the text;
- deleting every row or column of a table, which is done by deleting the table;
- changing an existing table (its rows or columns, its look, its merged cells), or deleting it,
  while another table of the tab reads the same, as above;
- adding a row beside a row in which a cell holds chips and no text in a shape not listed above
  (a chip after a space, a dropdown beside another chip), since what Google Docs copies of them
  into the new row has not been seen, or giving text for a cell that takes a copied chip;
- changing the rows or columns of a table that holds suggested changes to its rows, columns or
  cells (their insertion, their deletion or their style), or to those of a table inside one of its
  cells, since deleting a suggested row or column
  would discard the suggestion, or merging or splitting its cells. The text of such a table's
  cells can still be replaced, and the
  table deleted, with a note on its approval card. A table that comes to hold suggested changes,
  or more of them, after its deletion was requested is not deleted: the deletion fails without
  writing, and is requested again.

A table holding merged cells or another table can still be deleted whole. The checks that ask
whether paragraphs are list items are made on the copy of the document with the queued
changes applied, in which a paragraph that merely starts `1. ` is a paragraph and a list whose
items show no marker is a list: they are exact when the call is made, with changes waiting as with
none. Approval checks again, on the document as it is then.

Text edits, in cells too, are "Document edits", and every table change is "Table changes": adding
or deleting tables, rows and columns, restyling cells, sizing columns and rows, and merging and
splitting cells. A user may let both kinds apply without asking, and the kind of a new tab, "New
document tabs". A deletion may apply that way
too, since the document's version history undoes it. The card of a deletion shows what is deleted
as `getContent()` reads it. A dropdown reads as nothing there, and so does a smart chip that has no
text of its own, so a cell that holds nothing else reads as an empty cell; the card says when what
is deleted holds one. Where one more is put into those cells after the deletion was requested, the
table still reads as it did and the card says nothing of it, so the deletion fails without writing
and is requested again: the change records how many such elements its cells held. The card of a replacement in table cells says that its values are the table's
HTML, where Markdown syntax is written to the cells as typed.

A replacement's card shows `Old` and `New`, the text the change replaces and the text that stands
there once it is made, as a read returns them. Where that differs from what was typed (formatting
the paragraph's named style already gives, a break that makes a normal paragraph), `Requested New`
shows the text as typed and `New`, after it, the text as it will read. An append's card shows
`Content`, or `Requested` and `Resulting` where what the append adds will read otherwise than it
was typed. A table change's card ends in `Resulting`, the lines of the tab that will read
otherwise, as HTML where they are all of one table. Past 8 KiB the field is
`Resulting (first lines)` and holds the first of them, and it is left out where another field of
the card shows those lines or the change adds no line, as a deletion does.

Reads show queued changes. The gatekeeper keeps a copy of the document as Google returned it,
each tab pruned to what the Markdown rendering and a model of `documents.batchUpdate` read. A
queued change is made in that copy by the same requests approval sends, which the model applies as
Google Docs applies them, and `getContent()` renders the copy: the tab as it will read once the
queued changes apply, table changes and the look of new rows and columns included. A tab whose
`addTab()` is queued is replayed as an empty tab, under its provisional ID, so the changes queued
for it are made there too. `insertTable()`
reports its table's position as a read of the document, since the number says how many tables the
tab holds before it, and it does so before it queues anything; so where the workspace refuses reads
of the document (a collaborator has no access to it), `insertTable()` fails while `appendText()`
and the other table methods still queue; through Drive, where the read that prepares any change
is authorized, they fail too. The other table methods report nothing when they succeed.

The gatekeeper keeps the copy in its Durable Object's SQLite storage: each tab as it was fetched,
pruned, with the tab as each queued change leaves it, the requests of each queued change, and
each rendering. So a read of a pending state is read from storage, a queued change is made once
for as long as what it follows in its tab stays (an approval or a rejection ahead of it has it
made again: see [Google Docs request costs](#google-docs-request-costs)), and the copy outlives
an eviction. Nothing of the document is held in memory between two
requests: a request loads the rows it needs, which for a read is the stored Markdown of the tab's
runs, and for a change the few runs around it. The code that builds a change's requests reads a
rendering of a piece of the tab, the elements the change names and those beside them, and asks
the rest of stored rows, as described below. The requests are then applied to the runs they
touch, and only those are cut and stored again: every
other run of the tab is listed as it was. A change that reaches across N runs takes N in hand,
so a replacement of most of a tab takes most of the tab.

A tab is stored as runs: stretches of its body, each stored under a name made from its content,
with positions counted from the run's start. Consecutive paragraphs make runs of about 32 KiB of
pruned JSON and 64 KiB at most. A table is always a run of its own, as large as the table, and so
is a paragraph larger than 64 KiB. Where a run of paragraphs ends is decided by the content around
the cut, so where paragraphs differ a change moves the cuts near it and no other. A tab is
therefore about one run for
each 32 KiB of consecutive paragraphs, plus one for every table and one for every stretch of
paragraphs between two tables: a long tab of prose is some hundreds of runs, and a tab of hundreds
of tables is twice as many runs as it holds tables. A tab's state is a list of its runs, a row a
run, and the tab as a queued change leaves it shares every run the change did not touch with the
tab before it. Each run's Markdown is stored with it when the tab is stored (at a fetch, at a
queued change), under what the run shows of the text before it (the number a list resumes at, a
footnote's number), so a read joins stored Markdown and decodes nothing. After a change, the runs
past it are rendered again only where what they show moved: a list that resumes in them at
another number, a footnote added before theirs. A fetch that brings a tab unchanged writes
nothing of it, and one that brings it changed writes the runs near the change, their renderings
and the tab's list. A long stretch that repeats a few paragraphs, such as thousands of checklist
items with the same three texts, is the exception: where none of its paragraphs ends a run it is
cut every 64 KiB, and a paragraph added to it or removed from it can move every cut after it as
far as the next table at the next fetch, so that those runs are stored and rendered once more. A
bound Doc's object does not read the keys that start `docCopy:` in its key-value storage; it
removes them, a few at each use of the Doc, and fetches the document.

A queued change does two things to the runs. The first is what a later fetch finds. A run is
named by its bytes, and what a change writes is not Google's bytes for the same content, so the
runs that hold what a queued change wrote are stored and rendered once more when the document is
fetched after the change is applied; every run the change did not touch is found again by name,
with its rendering. On the recorded changes (`__tests__/fixtures/docs-live/`), with runs cut as
they are stored, a fetch finds again 86 of the 87 runs outside a change and 22 of the 219 runs
the changes wrote (`__tests__/docs-store-slices.test.ts`); the one run outside a change that it
does not find is the run a table ended, where the change removed the table. The second is where
runs are cut. The runs a change touches are cut again between the two places they began and
ended, so a change moves no cut outside them, and the last of them may be shorter than a run is
otherwise cut. In a tab of 20,000 short lines, one replacement in a paragraph leaves no run cut
otherwise than a cut of the same tab from its start (none in 200 such replacements, the same
file). No change joins a short run to its neighbour, so changes queued in one place leave short
runs that add up: a hundred text replacements queued in one run leave two runs in its place, as
a cut of the tab from its start does, and fifty tables put in and taken out again, a hundred
changes, leave 51, until the document is fetched again, which every approval and every read of a
changed revision brings about. Each short run is one more row in the list of the tab as each
later queued change leaves it.

A fetch reads Google's answer whole and parses it whole: at most 10 MiB of bytes, and up to twice
that in memory where its text is not all Latin-1, since the engine then keeps two bytes a
character. A fetch holds the most at the end of the parse, when the answer's text and its parse
tree are both in memory (a fetch of a tab of many runs that changed early can come level with
it, as the last item below says); the text is let go when the parse returns. The parsed answer
is then stored tab by tab and, in a tab, element by element: each paragraph or table is pruned,
added to the run being cut and taken out of the parsed answer, and a run is written, with its
rendering, when it is cut. So after the parse a fetch holds the parsed answer, shrinking, and one
run. Everything it writes is one transaction: a fetch that fails part-way (an element the copy
refuses, an element too large for a row) leaves the copy that was stored as it was.

A fetch also holds something for every run of the tab in hand, which matters for a tab of many
runs. The figures below are measured, each on an answer under the 10 MiB limit, and each total
is for its shape and its count of runs: how many runs an answer holds depends on what Google
sends for a table, so the bytes a run are what carries to another shape.

- Each run's name and its entry in the tab's list, until the tab's end, since the list is stored
  under a name made from every run's. About 200 bytes a run for a tab of 9,800 tables of one
  cell, each followed by an empty paragraph, where each table and each stretch between two is a
  run: 3.7 MiB for its 19,601 runs, in an answer of 9.9 MiB. About 250 bytes a run where each
  cell holds an item of one list, and about 300 where each holds an item of a list of its own.
  Under 0.1 MiB for a tab of prose near the limit, which is some hundreds of runs.
- Of a tab the stored copy holds, one page of the stored tab's list, which is read once, a page
  of 500 runs at a time, to compare the two tabs run by run, by name. A tab fetched unchanged
  holds no more of that list, and nothing of the tab is rendered or written. Its fetch reads
  three rows for each of its runs: the run's row of the stored list, the row of the rendering
  that entry names, and a row for the run found stored under its name (`3n + 10` rows for a
  document of one tab of n runs, and one row written, the copy's record).
- Of a tab fetched changed, what places the stored renderings beside the fetched runs: the stored
  tab's list from the first run that differs to the tab's end, or from the tab's first run where
  one of its lists is defined otherwise, since every run is then rendered under other lists.
  About 300 bytes a run of the stored tab from there on for the 9,800 tables (5.6 MiB for its
  19,601 runs after a change in the first) and where each cell holds an item of one list, and
  about 650 where each holds an item of a list of its own (9.5 MiB for 15,401 such runs in an
  answer of 9.9 MiB, the most measured). With the page of the list in hand counted in, about
  0.3 MiB for a tab of 20,000 paragraphs (274 runs) and about 0.9 MiB for a document of 199 runs
  that each name several lists. It grows with the lists a run names and their levels, so no
  figure here bounds another shape, and a change in a tab's last run holds next to none of it.
  At the first run of a tab that changed there, this is held beside the parsed answer, still
  whole: for the 15,401 runs that is about what the end of the parse holds, some 26 MiB each,
  and a tab of more runs, or of runs that name more lists, would hold more than its parse did.

A change reads a piece of its tab and not the tab. The elements it names are found from stored
rows: the text of a replacement by a scan of the runs' stored Markdown, a run at a time, which
also says whether the text stands exactly once; a table by its number, counted through what each
run's stored summary says of its tables; an append at the tab's end. The code that builds the
change's requests then reads a rendering of those elements and of the elements around them: on
each side the two nearest paragraphs or tables that hold a character, with the empty paragraphs
between, and before them, where the piece would otherwise start with a nested list item, the
elements before it back to one that is not a nested item. The piece is rendered from the runs
that hold it, which are decoded for it, and is cut at those elements, so it is the same piece
however the tab's runs are cut. Its size is the document's and no constant: a few paragraphs of
one run in a tab of prose (of two runs where the change stands in a run's first or last
paragraph, of three around a table), all of 200 empty paragraphs that stand beside a change, all
of 3,000 nested items under one item. Everything else the builders ask of the tab is answered
from stored rows, with no run decoded: whether the tab is blank, how many tables and cells it
holds, which tables read as the change's table does, whether a numbered list follows a table,
and the line above a table for its card, each by a pass over the runs' stored summaries, a page
of 500 runs at a time, or over their stored Markdown, a run at a time. The model then applies
the requests to the runs they touch, and takes those runs as the piece decoded them where they
are the same runs. Of the piece's rendering nothing is in hand while the model runs and the tab
as the change leaves it is stored. `insertTable()` renders the piece around the new table's
place a second time, once the change is made, to report the table's position.

A change's card is written from the stored Markdown of the runs in which the tab reads otherwise
than it did before the change, and decodes nothing. Storage says where the two tabs' lists of
runs first and last differ. A change can list runs anew that read as before (items made list
items again, runs stored under another number that a list resumes at), and their text often
stands in other runs, cut elsewhere, so the two tabs' stored Markdown is compared as text from
both ends of what was listed anew, one run of each tab in hand, and what reads alike is left
out of the card's strings. The price is rows: each such run's Markdown is read once in each
tab. One of 3,000 nested items made a top-level item lists every run of its tab anew (41 runs
become 44), and its card reads 476 rows as storage bills them, 89 of them a run's Markdown,
where over 300,000 characters before the item read alike and the card's two strings hold under
4,000 characters between them (`__tests__/workerd/docs-store.test.ts`). A text change that
renumbers an item far later shows everything between the two, and past what a card may store
it is refused, as soon as a character that differs is found past that limit and before any of
it is joined. A table change whose changed lines reach a far run reads the Markdown between
whole, which is bounded by the tab's Markdown: what a read of the tab holds.

A batch is checked against the piece it was built from before the model runs. One that names an
index before its piece, or an index after it, each index taken where it stood at least (less
the text the batch inserted before it), is not sent: the change is refused as one that "cannot
be shown as it will read once applied", the refusal is stored with the change, and it is logged
as `google.doc.piece.overreach` with the operation and the side, and no document text. Every
path treats it as any refusal: a call is refused, a queued change that is made again is dropped
with that reason while reads go on, a rejection succeeds, and an approval that builds the
change from a fetched document records it as one that cannot be applied. The check stops a
batch that writes past its piece. It does not see a piece that is short on what a builder
read, which builds another batch inside the piece; and it counts no index after a request
that adds length no request states (a table, a row or a column inserted, cells merged), which
the first request of every batch of those four kinds is (all 47, 33, 13 and 7 such batches
of the default pass of `__tests__/docs-piece-differential.test.ts`, and none of the 87
batches of the other seven kinds). What holds the piece to be enough is tests: the
builders on a piece are held to the builders on the whole tab's rendering.
`__tests__/docs-piece-teeth.test.ts` makes the piece smaller and counts, of 945 appends and
replacements outside tables that the whole tab builds, those for which the smaller piece
builds another batch with no error, those of them the check stops, and those the smaller
piece refuses:

| The piece without | Another batch | Stopped by the check | Refused |
|---|---|---|---|
| its second step forward | 12 | 12 | 13 |
| the walk back through nested items | 14 | 14 | 0 |
| its last element | 19 | 15 | 13 |
| the second step back and the walk | 15 | 15 | 0 |
| both steps back | 41 | 26 | 5 |
| everything but the change's own elements | 202 | 161 | 38 |
| its second step back, the walk kept | 0 | 0 | 0 |
| its first element | 0 | 0 | 0 |

The two rows of zeros are measures and no proof: with the walk back through nested items kept,
taking the second step back away changed no batch, and neither did taking the piece's first
element away, though the builders read both (a test that fails on any read of content outside
the piece fails for 47 and 98 of those changes). The step is kept all the same. A piece one
element short refuses a table change and builds no other batch for any of the eleven kinds, as
measured on 187 table changes: a deletion and `insertTable()` read what stands beside the
table, and a piece that lacks it refuses them where the whole tab builds them; rows and columns
added or deleted, the three looks, a merge, a split and a replacement in a cell are built from
the table alone, the same from every piece that holds the table with an element on each side
of it, and a piece that is the table alone, or starts with it, is stopped by the check.

What a change holds is therefore a small multiple of a run and its own text, and nothing for
every run of its tab. The figures below are measured under Node, with SQLite standing in for
the Durable Object's storage, on two shapes: a tab of prose (20,000 paragraphs, 196 runs, 2.48
million characters of Markdown) and a tab of very many small runs (tables of one cell, each
followed by a paragraph, each a run: 4,001 runs for 2,000 tables, and up to 19,601).
[Google Docs request costs](#google-docs-request-costs) gives the runs decoded and the rows
read for the same changes. A Doc opened through Drive builds a change from the same piece, read
from the copy its connection stores, and what its reads add is said after this list
(`__tests__/workerd/google-doc-actions.test.ts` holds a queued change, an approval and a
rejection of each kind of session to the piece's runs).

- The Markdown in hand at once is at most that of the piece's runs and the change's text
  (`__tests__/docs-piece-counts.test.ts`, which holds each change to it). On prose that is one
  run's Markdown for a change inside a run, two at a run's first or last paragraph and three
  around a table, of runs of about 47,000 characters there; on the tables seven runs' around a
  table and four at the tab's end, under 300 characters. The scan for a replaced text is
  handed the text and one run's Markdown at a time, exactly that for a text of 1 MiB, and
  holds about two runs' Markdown more while it searches a run. A change whose own text is
  large holds twice the text and under one run's Markdown more, when its card's two strings
  are in hand. A read of the tab with changes waiting holds the 2.48 million characters it
  answers: `getContent()` returns a tab's whole Markdown, so that string is the least a read
  can hold, and no read asks for a part of a tab.
- As objects, where a change holds the most (a rendering being stored): the runs the requests
  touch as the model left them, the runs cut from them, one of those as JSON with its rendering,
  and the batch. On prose 0.5 to 1.9 times the longest run's JSON at two bytes a character (a
  row added to a small table, an append) where the change lands in a run of ordinary length,
  and about 2.9 times it where it lands in the longest run: held under 3 times it; a change
  found stored holds under 64 KiB (`__tests__/docs-piece-heap.test.ts`). A change in a large
  table holds the most earlier, with the piece in hand (the decoded table, the run before it
  and the renderings of the tables around it): about 3 times the longest run on a document
  Google served whose longest run is a table of 326 KB, and 3.6 to 3.7 times it for a cell
  changed among ten tables of 124 KB each, which no test holds.
- The card's reads: one run's Markdown of each tab while the two are compared, and then the
  card's two strings. Measured, not held by a test: on the tables under 64 KiB at each of those
  moments, on 8,001 runs as on 19,601, and under 4 bytes a run between the two; on a tab of
  prose (6,000 lines) under three runs' Markdown.
- For every run of the tab, nothing. Finding the change's elements, each pass that makes its
  piece, applying the requests and storing the tab as the change leaves it read the tab's list
  of runs a page of 500 at a time, and the runs the change did not touch are listed inside
  storage and never brought to the request. An append is held to 2 MiB and 16 bytes a run on
  8,001 and 19,601 runs (`__tests__/docs-edit-heap.test.ts`). Measured, not held: a change to
  the look of the middle table keeps to the same bound, and a piece in its passes, the scan,
  the line above a table read back over half the tab, a row queued and its card each take
  under 16 bytes a run between tabs of 2,001 and 4,001 runs, and under 4 on tabs of up to
  19,601 runs. The price is reads: a change walks the
  tab's list from its start once for each thing it asks of the tab and once for each pass of
  its piece, some tens of rows for every run of the tab (see
  [Google Docs request costs](#google-docs-request-costs)).
- A piece as large as the document: its rendering, and of the runs decoded for it the change's
  own and the one before them, until the model takes them. Beside 200 empty paragraphs and
  under 3,000 nested items, in tabs cut one element a run, 675 and 10,115 runs are decoded
  for the piece, counting those decoded again, and of them only the change's own and the one
  before stay decoded (`__tests__/docs-piece-counts.test.ts`); the piece held measured under
  3 times its Markdown at two bytes a character and its map as JSON.
- For every list that holds a number, what the renderer carries from run to run: a number for
  each numbered list so far. A pass over a tab's runs has one, moved in place at each run at the
  cost of the lists that run counts in; a pass that keys one state of a tab beside another holds
  the second state's as what differs from the first's; a read of a tab with changes waiting makes
  none. It measured 113 to 176 bytes a list, and a pass over a tab of 7,700 numbered lists, each
  in a table's cell (15,401 runs), takes 0.49 s for a fetch that stores the tab and 0.82 s for a
  tab keyed again after a deploy and the read that asks for it. A change makes one for each
  pass of its piece and one for the walk to the runs its requests touch, each moved from the
  tab's first run: a change in the last table of that tab moves six, which is 11 to 13 numbers
  read or written for each list of the tab (`__tests__/docs-edit-heap.test.ts`).
- For the page of 500 runs a pass renders in, the definitions of the lists that page's runs
  name, as text. That is at most the tab's whole set of definitions, which is one stored row.
  On a tab of many pages it is a page's share, read by one statement a page: 31 statements for
  a keying of the tab of 7,700 lists, each answering the 250 definitions its page names, at
  most 300 characters a definition there. A pass of a piece runs that statement once for the
  page its runs stand in, so a piece made in five passes runs it five times, whatever its
  runs (`__tests__/docs-edit-counts.test.ts`). On a tab of one page whose runs name every
  list, which a tab of prose is, it is all of them: measured, 548 bytes for each list of the
  tab where 31 runs name 3,000 lists.
- One change takes every list of its tab in hand: a change that makes a list, which reads the
  tab's definitions, parses them and writes them with the list added, measured at about 1,100
  bytes a list (3.35 MB for 3,000 lists).

A Doc opened through Drive keeps its copy the same way in its Drive connection's storage, by file
ID, on a read-only connection too, with these differences:

- The copy is stored only once the scope check of the read that fetched it has passed. Until then
  the document is in that read's hands, and what the read stores to replay over it is removed
  before the read's transaction commits.
- A read the scope check refuses stores nothing of what it fetched. The copy an earlier read was
  allowed to keep stays, whichever session is refused and wherever it stands, unless the
  refusal shows that the connection does not reach the file (below), and it is served to no read
  whose scope check fails, since every read passes its check before anything is answered.
- The copy is stored with two facts about the last read of it that a scope check allowed: the
  folder that read's session stood on, where it stood on one, and the hour the check allowed it.
- A write of the connection's that lands marks the stored copy as lacking it, so that it is
  served to no one until the next read's fetch replaces it.
- An approval and a rejection remove, as they are decided, what the decided edit stored (the runs
  that only the tab as it left it lists, their renderings, that tab's list and its requests), so
  a connection keeps of a file's edits only what its pending edits reach.
- A connection keeps one copy for each document it read and was allowed to read, replaced by each
  allowed read that fetched, and removes it under three rules: a cap of 200 documents and
  512 MiB, 7 days with no allowed read, and a refusal that shows the connection does not reach
  the file. Where the copies are stored, what each rule counts and what a removal costs are under
  [What a Drive connection keeps of the Docs it reads](#what-a-drive-connection-keeps-of-the-docs-it-reads).

What a Drive connection keeps in memory is which copy a scope check approved, with the newest
queued edit and the revision moves it was fetched after (the copy's record and a few counters,
and no text of the document's body: see
[What a Drive connection keeps of the Docs it reads](#what-a-drive-connection-keeps-of-the-docs-it-reads)),
so a connection started again reads the document once more. While it runs, a read that fetches
through Drive holds the document's runs
as the bytes of their stored JSON, and nothing made of them, until its scope check ends, and
beside it the Markdown of the one tab it reads, joined from the rows the read just wrote. It
decodes runs of that tab from their rows only where a queued change has to be made in it, and
then the runs of the change's piece. What waits is the
UTF-8 of the runs' stored JSON and of each tab's lists and named styles, which is Google's answer
less its white space and the fields the copy does not keep, and 12 bytes a run: about the
answer's bytes at most, and 12 bytes a run, whatever the document's script, and less where the
answer holds much the copy leaves out (0.56 to 0.87 of the answer's bytes on three documents
Google served under the copy's field mask, and 0.24 to 0.92 of six answers read without it).
As measured on generated tabs, 8.4 MiB for a tab of 20,000 paragraphs (274
runs, an answer of 9.1 MiB) and 9.2 MiB for a tab of 9,800 tables of one cell, each followed by
an empty paragraph (19,601 runs, an answer of 9.9 MiB): 0.47 to 0.63 of what the same documents
take as pruned objects. Both answers are under the limit, and the figure for the tables is for
that shape, not for the most runs an answer can hold. A session opened with no storage keeps the
held document itself and renders a tab from it at each read.

A queued change is replayed with its tab, so one that the copy does not take is found at a read of
that tab's content or at a write to that tab; after any approval that leaves changes queued, which
replays every tab that has some; on a Doc's own connection, at a rejection that leaves a change to
an existing table of the rejected change's tab queued behind it, which also replays every tab that
has some; and when it is approved itself, which answers with the reason. A change queued for a tab
the document does not hold is found at the next read of any tab or of the tab list. Until it is
found, it is still the next change to approve, and the changes queued after it wait behind it.
A change the copy does not take is one whose text is gone from the copy, whose table changed there
or came to read like another, that the request builder refuses on the tab as the copy has it, or
whose batch is one the model knows Google Docs refuses. The change is marked dropped with the
reason, reads show the tab without it, approving it answers with that reason, and rejecting it
clears it. That is what the copy shows and no more: what the model does not check, such as a link
to a heading that does not exist, fails when the change is approved, and a collaborator's edit
made after the copy was read is met then too: Google refuses the batch pinned to the copy's
revision, and approval builds the requests again on the document as it is then.

A write is made in the copy when it is called, and what the copy does not take is refused then,
with nothing queued. `appendText()` is made in the copy when it is called as the other writes are,
so an append the request builder would refuse at approval is refused at the call. Each new list
item is written at the nesting level it reads at, two spaces before its marker for each level. A
list has nine levels, so an item written deeper, with eighteen or more spaces before its marker, is
refused, and the refusal says to write it at most nine levels deep. An item shallower than the item
before it is refused where placing it would rewrite an item that holds a positioned image (that
item, or one between it and an item as shallow), and the refusal says to write the item at that
item's level or to move the image in Google Docs first. A list item's text may start with a tab.
Google Docs reads the tabs a paragraph starts with as its nesting level when it makes a list item
of it, and removes them. So a new item is made a list item without the tabs of its own text, and
they are written at the start of its text afterwards, in the same change. An item that has to be
made a list item again to place a shallower item behind it has the tabs of its own text counted
toward its level, and written back afterwards the same way, when the change writes or rewrites
that item's line, or a line before it. Where such an item lies before the first line the change
alters (for an append, anywhere in the list it lands behind), its tabs are not written back, so the
change is refused, and the refusal says to remove that tab first or to write the new item at that
item's level. A change whose
result the model has no answer for is refused as one that "cannot be shown as it will read once
applied", to be made in Google Docs, and a batch the model knows Google Docs refuses is refused
with "Google Docs would refuse this change" and the reason. A tab whose content the model cannot
index as Google Docs does is read-only: it reads as it is, every write to it is refused when it is
called, the changes queued for it are dropped at the next read of it, and the document's other
tabs take edits.

Each approved change is one `batchUpdate`, pinned with `requiredRevisionId` to the revision it was
built against, so a concurrent edit makes Google refuse it and nothing is written. It is built
from the copy of the document the connection holds, or against a fresh read where the copy cannot
serve or Google refuses the pin. The batch carries a named range marking the write; a retry after
a lost response finds the marker and does not write again (see
[Google Docs request costs](#google-docs-request-costs)).

The limits, and what each is for:

- A table is created with at most 20 columns, and columns are added only until a table has 20.
  That is this connection's own limit, the width the Slides connection stops at too, at which a row
  can still be read on an approval card; a table that is already wider keeps every other operation.
- One change adds at most 1,000 cells that have text, an empty cell counting as half, and a column
  is added only to a table of at most 500 rows: a change travels as one batch that has to answer
  within the client's 30 seconds, and filling new cells takes longer the taller the table. For the
  same reason one replacement in table cells sends at most 8,000 requests, which takes thousands of
  texts or formatted stretches changed at once.
- The text of one change's cells holds at most 2,000 paragraph breaks, the limit text edits have,
  since each becomes a paragraph.
- Tables, rows and columns are added, and cells merged, only until the tables of one tab hold
  5,000 cells in all, a cell counting once for each paragraph it holds, those of tables inside cells
  and those no replacement can edit included (a merge moves the paragraphs of the cells it covers
  into its top-left cell and leaves one empty paragraph in each of them, so it adds one for every
  cell past the first that holds anything): a document is read whole, in one answer of
  limited size, and one whose tables grow far past that cannot be read, and so cannot be changed,
  through the connection (see [Known limitations](#known-limitations)).
- One deletion removes at most 19,005 rows or columns, the most requests a batch holds.
- A queued change, with the table it applies to, is at most 1 MiB, the size limit of a text edit,
  so a table whose own HTML is larger takes no change through the table methods, to its look and
  its merged cells included (the refusal says so; the text of its cells can still be replaced).
  The changes waiting on one document record at most 4 MiB of table HTML between them (4,194,304
  characters), because every read loads all of them: past that, a further change to an existing
  table is refused until some are approved or rejected, while a new table, which records no table,
  is still queued.
- For `replaceText`, in a table as outside one, each of its two values holds at most 2,000 lines
  and 5,000 Markdown formatting tokens, and the two together 1 MiB. Table HTML has a line for every
  cell and two for every row, so a table of a few hundred rows cannot be quoted whole and is
  changed in several calls.
- Through Drive one change is held to 100 KiB, well under the two 1 MiB limits above (see
  [Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)).

What Google Docs does with the requests is on record. `__tests__/fixtures/docs-live/` holds, for
each scenario, the batches the request builders sent and the document Google Docs returned after
each, and `__tests__/docs-live.test.ts` holds the model to them: applied to the document before a
batch, it has to give the document Google returned after it. The recordings are re-made with
`pnpm --filter @gadgets/google-gatekeeper record:docs-fixtures <token-file>`, and compared without
writing anything with `--check`. The command needs an access token and, for the scenarios that
start from a template document, one made by hand (`--template <docId>`), whose contents
`__tests__/docs-live-recorder.ts` lists.

The model is also held, from every stretch of a tab's elements and of its stored runs, to what
it does on the whole tab: `__tests__/docs-slices.test.ts` from every stretch of elements, and
`__tests__/docs-store-slices-forced.test.ts` and `__tests__/docs-store-slices-real.test.ts`
from every stretch of runs cut one element a run and as a store cuts them.

The request builders are held the same way: from a piece they have to build what they build
from the whole tab's rendering, the same batch or the same refusal in the same words, and the
same card. `__tests__/docs-piece-differential.test.ts` holds that on every recorded step, on
the tabs the generated sequences reach, and on generated tabs (empty paragraphs, nested and
tabbed list items, lists off the presets, positioned images, protected content, tables beside
tables and inside cells, suggested content, section breaks inside the body), stored as runs of
one element and as runs are cut by default, so that a piece is a part of its tab and crosses
runs. A setup file of the package's
Node tests (`__tests__/docs-piece-suite-shadow.ts`) builds every batch the other suites build
from a whole tab once more from its piece, and fails the calling test where the two differ.
A read past the piece fails a test: the same builds are made from the whole rendering under a
wrapper that throws on any read of content outside the piece. It allows a read of where an
element outside the piece stands, so it does not hold the piece's second step forward, which
the batches hold. `__tests__/docs-piece-teeth.test.ts` makes the piece smaller, as the table
above shows. `__tests__/docs-piece-rendering.test.ts` holds a piece cut from the renderings of
joined runs to the same part of the whole tab's rendering;
`__tests__/docs-piece-store.test.ts` and `__tests__/docs-closure.test.ts` hold a
piece found run by run to the piece of the whole rendering, on tabs in which each of its steps
ends at a run's edge, one element short of it and one past it;
`__tests__/docs-reading.test.ts` holds what is asked of stored rows to the whole rendering's
answer; `__tests__/docs-piece-cards.test.ts` holds each card to the one written from the two
tabs' whole Markdown; and `__tests__/docs-piece-counts.test.ts`,
`__tests__/docs-piece-heap.test.ts` and `__tests__/workerd/docs-piece.test.ts` hold the counts,
the heap and the rows this file gives.

The package's tests run
a part of all this by default, and all of it with `GOOGLE_DOCS_WIDER_TESTS=1` set, by either
entrypoint (`GOOGLE_DOCS_WIDER_TESTS=1 pnpm exec vp run -F @gadgets/google-gatekeeper test`,
whose task declares the variable, or the `test:run` script): the second seed of the generated
sequences, their batches from every stretch, more of the pairs from stored runs cut one element
a run, the larger tables of generated requests, and, of the tests of the builders on a piece
(`docs-piece-rendering`, `docs-piece-store`, `docs-piece-differential`, `docs-reading`,
`docs-piece-cards` and `docs-piece-counts`), three seeds of 500 generated tabs for the
differential, more drawn tabs and ranges for the pieces, the stored rows and the cards, and
the counts on a tab of 19,601 runs;
and, of what a Drive connection keeps, more quotes drawn for the search of a comment's text
and, in the workerd Docs pass, which is handed the variable too, the rows of a sweep, an
eviction and an expiry on the tab of 19,601 runs. The wider run's Node pass allows a test
four times the default pass's fifteen seconds.
On the machine they were measured on, each file run alone, the tests of the model from a
stretch and those that count and measure what a read and a change hold (the `docs-slices*`,
`docs-store-slices*` and `docs-store-paged*` files, `docs-carry-slope`, `docs-edit-counts`,
`docs-edit-heap` and `docs-edit-widening`, and the carry's tests in `render-run.test.ts`) take
about 80 s between them by default and about 180 s in the wider run, and the tests of the
builders on a piece (the `docs-piece-*` files, `docs-closure` and `docs-reading`) about 48 s
and about 165 s, of which the differential is 14 s and 87 s. The Node pass of the package's
tests, which runs them all side by side with the rest, takes about 30 s by default and about
95 s in the wider run.

## Google Doc comments

A directly bound Doc offers `listComments()`, `comment(text, { quote, tabId? })`, `suggestEdit(oldText, newText, { note?, tabId? })`, `reply(commentId, text)` and `resolve(commentId, text?)`. None takes a file ID: the binding's one Doc is the file, as an item is for the comments of the other gatekeepers. Its grant, `documents` and `drive.metadata.readonly`, reaches the comments through the Docs API; Drive's comment API refuses it. Through Docs it lists every comment, makes comments attached to text and suggestions, and replies to, resolves and reopens any comment attached to text, someone else's too. It cannot make a comment attached to no text, nor answer one (one made through Drive, or on the whole file). So `comment()` requires a quote, and a reply to or resolve of such a comment is refused with the resource URL of a read and write Drive connection to the file, which can answer it; `getMetadata()` returns the Doc's `id` for that URL.

The writes go through the engine behind Drive's comment writes (see [Drive comments](#drive-comments)): each is queued for approval, listed `pending` until it is decided, checked again when it is approved, and looked for before a send Google did not confirm is retried. The checks at approval are the same: the account can still comment, a quote still occurs exactly once in its tab, and the comment a reply or resolve answers still exists with the text it had, a resolve's still open. They are queued as **Google Doc comments**, a kind of their own, auto-approvable with the same exception for mentions as Drive comments, and are not gated on the Drive writes grant or a read and write choice, as the Doc's edits are not. A quote is matched against the Doc as Google has it saved, not with pending edits replayed, so text only in an edit waiting for approval is refused as such. When a comment or a suggestion is queued, the quoted text is looked for in the binding's stored copy of the Doc, a run at a time and with no document held whole: the copy a read fetched or confirmed in the last 10 seconds, and otherwise the Doc fetched then and kept as the copy. So text someone else added in those 10 seconds is not found until the copy is fetched again; the check at approval reads Google. At approval the Doc is fetched as a write is based on it, with suggestions inline, and the quoted text is found in that answer an element at a time, each element let go as it is read; nothing of that answer is stored. A Doc the binding cannot keep a copy of (one paragraph or table too large for a stored row, see [Known limitations](#known-limitations)) still takes a reply and a resolve, which read no document; a comment or a suggestion on it, which quote it, is refused with the error a read of it gives, and nothing is queued. `tabId` follows the binding's rule: it may be left out only for a Doc with one tab. A comment, reply or note holds at most 2048 bytes of UTF-8, the Docs limit. Comment writes and edits share one counter of approval IDs, so an ID names one action; comments apply in any order while edits keep theirs, and rejecting a comment restarts nothing.

Google shows a Doc's comments only to an account that can comment on it, and refuses the read (comments require suggestions inline) to one that can only view the Doc. The binding refuses such an account every comment read and write, saying why, as Drive's metadata tells it. A Doc not created yet lists no comments and takes no comment writes. A listing, and the read that finds a quote, report the document, `docs/document/<documentId>`, as the binding's other reads do.

## Google Docs request costs

Connecting a Doc reads its Drive metadata once, to refuse an Office file (see
[Office files](#office-files)). A read costs one full `documents.get`, replayed for 10 seconds and then revalidated by a
revision-only `get`. In this section a full `get` is that read, as against the revision-only one:
every tab of the document in one answer, with only the fields the gatekeeper keeps of a document.
It asks for them through a field mask read off the same table as the pruning of the stored copy,
so that the two cannot differ. The mask names the fields three levels of tabs deep and, in each
tab, through the cells of a table and of a table inside one of those cells; child tabs nested
deeper, and what the cells of a table inside a table hold, come whole, never left out. A tab's
lists and named ranges come whole too, because Google refuses a selection inside them. What the
mask saves depends on the document: about 7% of the answer for plain text, about 16% for heavily
formatted text, and about half (52%) for a document that is mostly tables. A read that Google
refuses for its mask is made once more without it;
`pnpm --filter @gadgets/google-gatekeeper check:docs-fields-mask <token-file> <document-id>...`
asks Google whether it takes the mask, and whether a document's copy is the same with it and
without, printing sizes and no content. Approving the creation of a Doc reads only the
new document's tab IDs, since edits queued before it existed name the tab of the blank document.
Queuing an edit costs nothing more than the read. Applying one costs the `batchUpdate`
carrying the edit and its write marker, built from the stored copy and pinned to the copy's
revision, and a second `batchUpdate` removing the marker; the document is reread after it only
when more edits are queued behind it, since they must be replayed over the new revision. A table
change is one `batchUpdate` whatever its size (the rows or columns, and the text of their cells,
travel together), so it costs what a text edit costs. Rejecting a change costs no request, and the
read after it checks the document's revision (the revision-only `get`) and reads the document again
only if that moved.

A full `get` precedes an approved write only where the stored copy cannot serve: none is stored, a
write landed since it was fetched, the change adds a tab, an earlier write's marker is still to be
deleted, the copy's tab does not take the edit (the document as it is then decides), the copy
already built a batch, the connection itself moved the document's revision since the copy's fetch
began (it applied a comment or a suggestion, or deleted a write's marker, which a read made
meanwhile does not hold), or the copy was fetched more than 24 hours ago, which is how long Google
holds a revision id valid. The write is then built against that read and pinned to its revision.
The document such an approval fetches is read in hand for the receipt and the write markers,
which settle an edit whose write landed, and for an edit that no longer replays or whose tab is
gone, which is refused; none of these stores anything. Where the edit's write must be built from
it, the document is stored as it is read, in a trial that keeps nothing, and the write is made
in the edit's tab of that copy as a replay makes it, with the same checks (an edit that would
leave a paragraph or a table too large for a row among them), in a transaction that is undone:
a store of the runs the stored copy does not hold, each rendered as it is stored, and the
edit's piece decoded and rendered, neither of which an approval that sends the stored requests
makes. Where the tab came back as it was when a replay stored the edit's result, that result is
found and nothing is decoded. A write built from the stored copy is made and checked the same
way, and keeps nothing either.
Google refuses a batch pinned to the copy's revision once the document has moved past it, and
writes nothing; the approval then reads the document and builds the edit again, or fails with the
reason the edit no longer applies, so it costs the refused `batchUpdate` more. A batch built from
the copy that is not accepted is logged as `google.doc.action.apply.copy-refused`, with the edit's
number and kind and Google's status, and no document text. A copy builds one batch: an approval
tried again after a batch that did not land reads the document first, and finds there the marker
of a write whose answer was lost (or finds it in the copy, when a read has stored the document
since). That holds for as long as the instance that sent the batch lives, since it remembers in
memory which revision built a batch: an instance started again in between builds from the stored
copy once more, pinned as before, so nothing is written over a document that has moved.

A read replays the queued changes of the tab it reads, over that tab of the copy, and no other
tab's; `listTabs()` replays no tab, and only places the tabs that queued `addTab()` calls make in
the list. Each read replays that tab's queue again, a step for each change, and a step reads what
the change made of the tab from storage where it was made before, so a change queued, dropped or
rejected in another tab costs it nothing. A fetch stores again nothing of a tab whose content
did not change, and of a tab that changed the runs near the change, whether it follows a
revision-only `get` that found the document changed or an approved write, so a write to one tab
does not store the others again.

A read and an edit cost this in storage, where a tab's list of runs is a row a run (see
[Google Docs edits](#google-docs-edits) for how many runs a tab is). A first read stores every
tab: its runs, each rendered once, alone, as it is stored, with its rendering, and the tab's
list. A later read of the same state reads rows, decodes and renders nothing, and writes none.
Queuing an edit decodes and renders the runs of its piece, for the code that builds its
requests, and no other run of its tab, on a short tab as on a long one (see
[Google Docs edits](#google-docs-edits) for what a piece is). In a tab of prose that is one run
for a change inside a run, and two where it stands in a run's last paragraph, whose piece takes
in the next run. A piece is found from the run the change stands in, and where it starts
earlier it is made again from an earlier run, since a rendering is made forwards: a change in
a run's first paragraph decodes its run and then that run and the one before, three in all,
and a change to a table between two runs of prose four. Where it starts more than one run
back, the runs before are rendered once more to find where, two and then four of them, and
then the piece from its first run: around a table of a tab of one-cell tables, where every
table and every paragraph between two is a run, that is 1, 2, 3 and 5 runs and a piece of 7 or
9, so 18 or 20 runs decoded for one change, and 15 at the tab's end. The model then applies the
requests to the runs they touch: one for a change inside a paragraph or a table,
and two where it joins two paragraphs across the boundary of two runs, where it makes a list
item of the paragraph a run starts with, or where it removes a table whole, which takes the run
after the table too, since the end of a deletion is among the places the runs are chosen from.
Of those it takes, as the piece decoded them, the runs the change's own elements stand in and
the run before them, and decodes any other itself, so a batch that names an index in the run
after the change's own decodes that run a second time.
The runs are chosen from the places the change's requests name in the tab as it is stored, which
leaves out a place an earlier request of the same change moved (the text typed into a row just
added, the range styled over a longer replacement), so a row or a column added with text and a
replacement longer than what it replaced touch one run, whatever stands after it. Where the
first choice of runs is too small, the change is applied again to more of them, which decodes
them again: requests written by hand that make a list item from one position past a run's start
decode that run, and then it and the run before it (`__tests__/workerd/docs-store.test.ts`
holds each of these counts on a tab of prose and tables, and
`__tests__/docs-piece-counts.test.ts` those on the tab of one-cell tables). `insertTable()` makes its piece twice, the second time to report the new
table's position. An edit made again whose result is stored, as when a preview's card is
written again, decodes and renders its piece's runs once more and writes nothing. An approval
that sends the requests stored with the edit decodes and renders nothing and reads three rows;
one that builds them, from the stored copy or from a document it fetched, makes the edit as a
replay does and keeps nothing of it: the rows it writes are undone. A rejection makes the edits queued behind
the rejected one in its tab again, each at an edit's cost. On a tab of 20,000 paragraphs
(196 runs) and on one of 2,000 one-cell tables (4,001 runs), runs decoded and rendered: a
replacement 1 and 2, and 18 and 19; an append 1 and 2, and 15 and 16; a row added to a table 4
and 5, and 18 and 19; a table added after a line 2 and 5, and 36 and 39; an approval that
builds its requests 1 and 1, and 18 and 18; a rejection with two edits behind it 2 and 4, and
38 and 40; a read with changes waiting none (`__tests__/docs-piece-counts.test.ts`, and
`__tests__/workerd/docs-piece.test.ts` on a Durable Object's storage, which holds the same
counts on shorter tabs too). Queuing an edit stores the runs
the edit changed, each rendered once more, alone, with its rendering; the list of the tab as the
edit leaves it, whatever the edit touched; and the edit's requests. A fetch that brings a tab
changed stores the runs near the change, rendered alone, with their renderings, and the tab's
list, and removes those of the tab it replaces. The runs after a change, queued or fetched, are
rendered again only where what they show moved. An approval or a
rejection removes what no queued edit reaches, in the same transaction, and so does the
preparation of an edit, before it stores anything, so an edit that was prepared and never queued
leaves nothing behind the next. An approval and a rejection also have edits made once more, with
their rows stored again and no request added. The tab an approval's fetch brings is stored as
Google holds it, which is another state than the one the copy worked out, so each edit still
queued in the tab the approval wrote is made again over it; a rejection has the edits queued
behind the rejected one in its tab made again, since they follow another state. So N edits queued
in one tab and approved in order are made N(N+1)/2 times in all, and edits queued in other tabs
are not made again. What the gatekeeper worked out of a stored tab (each queued
change's requests and result, each run's rendering and what it is stored under) is stored with a
digest of the code that worked it out and is used only by that code. After a deploy that changes
how an edit is made or a tab is rendered, nothing is fetched: each tab is decoded and rendered
once more, a run at a time, at its next read, and each document's queued edits are made once
more from the stored copy.

What is not held in memory is paid for in rows read, which storage bills in three kinds: a row
of a table; a row for every value of a stored run's JSON that a statement walks inside storage
(about 30 to 67 values for each KiB of a stored run of paragraphs, from long paragraphs to short
lines, and 73 to 74 for each KiB of a tab of one-cell tables, which is about 35 for each of its
runs); and a row for every list the tab defines that a statement steps over.
`__tests__/workerd/docs-store.test.ts` and `__tests__/workerd/docs-piece.test.ts` pin the counts
below on real storage, with n the tab's runs, P the pages of 500 runs its list is read in, N
the values of its stored runs, L the lists it defines, p the place of the run a change stands
in, and q the runs of the pages a walk from the list's start reads to reach that run (whole
pages of 500, so n on a tab of one page). The pairs of figures are for two tabs that define no
list: one of 20,000 paragraphs and three tables, which is 196 runs, and one of 2,000 one-cell
tables, each followed by a paragraph, which is 4,001 runs.

- A read of a tab with changes waiting reads `3n + 1` rows for its content: a row of the list,
  of the rendering it names and of that rendering's Markdown for each run, and nothing else.
  589 and 12,004.
- Queuing a change reads the tab's list several times over, and no value of a run where the tab
  defines no list. Its parts:
  - the scan for the text a replacement names, or the text a new table is to follow: `3n`,
    every run's Markdown among them, since a second place has to be ruled out;
  - the pass that finds the run the change stands in: `2q`. An append reads `2n` for it, and
    a table change `2n` for each thing it asks of the tab's tables (which table reads as the
    change's does; how many cells the tab's tables hold);
  - whether the tab is blank, which an append asks of the first page of the list:
    `2 * min(n, 500)`;
  - each pass of the piece, from the run at place a over r runs: `n + 2q + (n - a) + 2r + 3`
    on a tab of one page, which is the tab's totals, the stored summaries of the runs before a
    for what the renderer carries there, the list from a, and each run found and read; on a
    tab of many pages the list from a is read to the end of a's page;
  - applying the requests and storing the tab as the change leaves it: `5n + 2q + p`;
  - the card: `4n + 2f`, with f the place of the first run the two tabs list otherwise, for
    where the two lists differ and the summaries before f, and some 120 rows for the runs it
    compares and joins. The line above a table, for a table change's card, is read back a
    run at a time, four rows a run, to the nearest line of text.

  So before its card a replacement inside a run reads `10n + 6q + 13` rows, and
  `n + 2q + (n - p + 1) + 7` more where its piece is made in a second pass; an append
  `11n + 4q + 12` on a tab of one page (on a tab of more, whether it is blank reads the 1,000
  rows of the first page and not `2n`); a change to a table's look `11n + 8q - p + 24`, its
  piece being two passes; a row added `2n` more. With their cards, on the two tabs: a replacement 4,302 and 107,695
  rows, an append 4,150 and 125,112, a row added 5,045 and 123,688, a table added after a line
  5,755 and 166,277 and one added at the tab's end 5,187 and 200,261, its piece being made
  twice. That is 21 to 30 rows for each run of the first tab, and 27 to 50 for each run of the
  second, where a piece is five passes and each is a walk from the list's first run.
- A change made again whose result is stored reads the same less applying and storing: 2,803
  and 80,691 for the replacement. An approval that builds its requests reads the scan, the
  pass that finds the run and the piece: 1,643 and 60,564. A rejection with two changes queued
  behind the rejected one reads 6,314 and 201,280.
- Where the tab defines lists, each pass of a piece also reads, by the one statement that finds
  the lists the runs of its page name, that page's rows of the list and its runs (`2 * 500`),
  a row for every value of those runs' JSON and a row for every list of the tab: a pass costs
  its page, not its runs. On a tab of 300 lists, each in a table's cell (601 runs), the piece
  around a table, 9 runs made in five passes, reads 105,862 rows, 88,765 of them the values
  of its page's runs five times over, and a replacement in that table's cell 112,583 before
  its card.
- The first edit after the code that derives the stored renderings changed asks again whether
  the model follows the tab and keys the tab again, which renders every run: `14n + 25` rows
  more on a tab of lines that defines no list, and where the tab defines lists every value of
  its runs and its lists once for each page, `N + L * P`, beside rows of tables.

These reads are made inside storage and bring nothing of the tab to the request but a page of its
list and the lists a page names, which is why they are made.

That is the price of holding a piece and not the tab, and it is paid in work as well as rows.
A rendering is made forwards, so a piece that starts before the run it was asked from is made
again from an earlier run, and beyond one run back the runs before it are rendered once more
to find where it starts, each attempt a walk of the stored summaries from the list's first run.
In a tab cut one element a run, the piece beside 200 empty paragraphs is 205 runs and decodes
675 to be made (1, 2, 467 and 205), and the piece under 3,000 nested items is 3,003 runs and
decodes 10,115; as runs are cut by default the first tab is one run, and the second piece is
every run of its tab (`__tests__/docs-piece-counts.test.ts`). The model decodes again any run
of the piece that it touches but the change's own and the one before them. The scan reads
every run's Markdown row, since a second place has to be ruled out. And on a tab of thousands
of runs each of these is a walk of the list, which is what the tens of rows a run above are.

These are a directly bound Doc's costs. A Doc opened through Drive replays the same way and adds
its connection's scope checks. Its sessions share one stored copy of a document (see
[Google Docs edits](#google-docs-edits)). A read reuses the snapshot its connection last approved
while no write has landed and no edit was queued since it was fetched, for 10 seconds and then
for as long as the revision-only `get` confirms it. So the first read after an edit is queued,
the newest queued edit is rejected or fails, or a write lands fetches the document whole, and the
reads after it do not. What a session reuses is the snapshot its own reads approved: the sessions
of a read and write connection share it, for the connection's four documents opened most
recently, and each session of a read-only connection has its own, so it fetches the document at
its first read though its connection stores the copy (see
[Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)). An approved write
is built from that snapshot under the same rules, while a read could still reuse it (no write
landed and no edit was queued since it was fetched), the connection has not moved the revision
since, and within 24 hours of its fetch: the first
approval after a read saves the `get`, and one that follows a landed write, or an edit queued with
no read since, does not.

In one place a Doc opened through Drive is fetched once more than its sessions' own snapshots
would ask. Two sessions that do not share a snapshot (each read-only session has its own, and a
read and write connection shares those of its four documents opened most recently) read one
file; the second fetches a document that has changed, and its read is approved. The first, still
inside the 10 seconds its snapshot is served for, then fetches the document rather than answer
the older one, and an approval pinned to that snapshot fetches too. Where the second fetched the
same document, nothing is added: both keep reusing. A refused read adds no Docs request for
anyone, and at most one Drive request: one batched read of the file's parent folder, where a
folder connection stores a copy of the refused file and what the refusal read of the file does
not settle it (the account sees the file, out of the trash and in a single folder, and that
folder is neither where its last allowed read found it nor a folder of the refused session's
path). The copy is removed where the refusal itself (the account cannot see the file, or it is in
the trash or in no single folder) or that one request shows the connection does not reach the
file, so the file's next allowed read fetches once; any other refusal removes nothing, and the
read after it finds what the read before it found. That request is the one a stored copy adds:
the cap and the expiry ask Google nothing (see
[What a Drive connection keeps of the Docs it reads](#what-a-drive-connection-keeps-of-the-docs-it-reads)).

A read of a fetched document costs work through Drive, and no request. What the read stores of
the document before its scope check has passed is removed, and stored again once the check has
passed and the copy is kept. So whatever the fetch brought that the stored copy does not hold is
stored and rendered twice in that read, and its rows are written, deleted and written again: at
the first read of a document every run of every tab, twice the renderings of a bound Doc's first
read, and at a fetch that brings a tab changed the runs near the change. The pending edits of a tab
that changed since the stored copy are made in the read that fetched it and once more at the
first read after its copy is kept. An edit queued through Drive straight after another, with no
read of the file allowed between the two, is made twice, once when it is prepared and once at the
next read, because its preparation fetches the document and what a read stores before its scope
check has passed is not kept. So N edits queued back to back are made at most 2N-1 times; with a
read between each two, as an agent that reads back what it queued does, each is made once, as a
bound Doc makes it. A read that fetches the document unchanged makes no queued edit again.

The read holds the runs as bytes while its scope check runs, so each of its two writes, the one
it removes and the one it keeps, decodes every run of the fetched document. With n the runs of
the document, a first read through Drive decodes 2n runs and renders 2n; a read that fetched a
document the stored copy holds unchanged decodes 2n and renders none. A first read through Drive
of one tab of 20,000 short lines, which is 133 runs, so renders 266 runs and decodes 266; as
storage bills them it writes `10n + 7` rows and removes `3n + 2`, where a bound Doc's first read
of that tab writes `5n + 4`. Nothing of a document is in storage after a read that was refused.

Adding a tab costs the same: its `batchUpdate` carries the `addDocumentTab` and the marker, which
goes in the new tab's parent or the first tab. Until Google names the tab, `addTab()` returns a
provisional `pending-tab-…` ID that edits can target; approving the add points them at Google's ID,
and the provisional one keeps resolving for the binding's last 100 added tabs. An add whose reply was
lost is refused on the retry: Google names a new tab only in that reply, takes no tab ID from the
caller, and puts no marker sent with the add in the tab it makes, so a title and place could be a
collaborator's tab. The tab it made stays in the Doc, and denying the add withdraws it and the
edits queued for its tab. A retry that finds no marker (a top-level add's marker is in another
tab, which may have been deleted) sends the add again only when no tab has appeared anywhere in
the Doc since, and otherwise fails, since nothing ties such a tab to the add.

Listing comments costs one `documents.get` that asks only for the comment threads (a field mask:
about 1 KB on a small Doc against 18 KB for the whole). Queuing a comment or suggestion costs a Drive
metadata read, for whether the account may comment, and at most one request of the Doc to find the
quote:

| The Doc's stored copy when the comment or suggestion is queued | Bound Doc | Through a Drive connection |
|---|---|---|
| Fetched or confirmed in the last 10 seconds (through Drive: with a read of it allowed, as the connection's memory has it) | a `get` of the title; the quote is read from the copy | none; the quote is read from the copy |
| Otherwise: none, older, behind a write of the connection or, through Drive, behind an edit queued since | a full `get`, whose answer carries the title and is kept as the copy | a full `get`, kept as the copy once the read's scope check has passed |

The lookup asks for no revision-only `get`: a copy older than 10 seconds is fetched, not confirmed,
since a confirmation that found the document changed would be followed by the full `get`. Through
a Drive connection that stores no copy of the Doc, the fetched document is stored and rendered
twice, as at any first read through Drive (see
[Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)). A reply or
resolve costs the metadata read, the threads read and a `get` of the title. Applying a comment or
suggestion costs the metadata read, a `get` of every tab with suggestions inline (with the fields
the copy keeps and the suggestion threads, unindented, and again without the field mask where
Google refuses it) and the `batchUpdate`, and
a suggestion's note one more `batchUpdate`; applying a reply or resolve costs the metadata read, the
threads read and the `batchUpdate`. A retry after a send Google did not confirm first reads the
threads, or the suggestions, once.

## Known limitations

A document is read whole, all its tabs in one answer, of which at most 10 MiB is read. A longer
answer fails reads of the document's tabs and content, edits and approvals, for a bound Doc and for
a Doc opened from a Drive binding, until the document is made smaller in Google Docs. A fetch
holds the answer's text (its bytes, or twice them where the text is not all Latin-1) and its
parse tree, as large as it gets, together when the parse ends, so the limit is also what bounds
a fetch's memory; a larger document would need the answer parsed as it arrives. The answer is
asked for without indentation and with only the fields the gatekeeper keeps (see
[Google Docs request costs](#google-docs-request-costs)), so that the limit is reached later than
it would be: a document that is mostly tables reaches it at about twice the size it otherwise
would. The read made again without the field mask is under the same limit, so while Google refuses
the mask a document that fits only with it is not read. Applying a comment or a suggestion reads
the document with the same fields and its suggestion threads, so on a document near the limit a
read can succeed where applying a comment fails for the size of those threads. A table cell
takes far more of that answer than of the Markdown. For that reason the table methods add to the
tables of one tab, and merge their cells, only up to 5,000 cells (see the limits of
[Google Docs edits](#google-docs-edits)), so that a table grown through the table methods does not by
itself take the document past the limit. A document whose tables were made larger in Google Docs,
or that is large in its other tabs or in its text, can still be past it.

One paragraph or one table of the copy the gatekeeper keeps is stored as one row, of at most
8,000,000 bytes as pruned JSON (text outside ASCII counts by its UTF-8 bytes), and so is its
rendering. A document that holds a larger one fails reads, edits, a comment's quote
and a suggestion with an error that says so, until that paragraph or table is made
smaller in Google Docs, and a queued edit that would make one is refused. An approval
that must build its write from a document it fetched fails with that
error where the document holds such an element, or one the copy refuses, as a read of that
document fails, and the edit stays pending. The definitions of a tab's lists are one row
together, under the same limit. A tab is as many rows as it has runs, so it has no limit of its
own under Google's answer of 10 MiB for the document. A tab whose footnotes are not numbered in
the order they stand is read as it is and takes no edit through this connection. So is a tab in
which a paragraph of the body ends in half a surrogate pair, in which a start index is left out
anywhere but on the section break that opens the body, or in which a paragraph names a list
under an id of the form this connection gives the lists it makes, with no such list defined; no
recorded answer of Google's has any of the three.

A change holds a small multiple of a run and nothing for every run of its tab (see
[Google Docs edits](#google-docs-edits)). What it holds that a run does not bound:

- Its own text, which may be 1 MiB, and the runs that text spans, which are all in hand at
  once. A replacement of 0.45 MiB by as much holds the most while the tab as it leaves it is
  stored: 2.09 MB beside its two texts, which is 4.4 bytes of heap for each character of the
  longer text. It holds 3.0 bytes a character while its requests are built, the spanned runs
  decoded beside their renderings, and 2.0 with its card's two strings in hand. That is the
  change's size and not the tab's: the figures measured the same on a tab of 5,000 paragraphs
  as on one of 20,000 (`__tests__/docs-piece-heap.test.ts` holds the first, on the tab of
  20,000, under 5.2 bytes a character and one run).
- A very large table or paragraph, which is a run of its own, as large as it is.
- Hundreds of empty paragraphs or nested list items beside a change, all of which its piece
  takes in: their rendering is held whole while the requests are built, though not their
  decoded elements. For 3,000 nested items of 100 characters that is 321,000 characters of
  Markdown and, with the map to the document's positions, about 1.9 MB.
- A card that reaches a far run: a text change's two strings up to the 1 MiB a card stores, and
  a table change's up to the tab's Markdown.
- A replaced text that overlaps itself in more places than the scan follows from one run into
  the next, which is 64, as hundreds of equal rows do: the scan is then made over joined
  windows and holds about three times the text and two runs' Markdown
  (`__tests__/docs-reading.test.ts`).

A tab of very many tables that is asked about all of them (which one reads as a change's table
does, how many cells they hold) is not held but is read: one pass over every run's stored
summary for a table change, a page at a time.

A read of a tab with changes waiting holds the Markdown it
answers, as a string a run and once more joined, and a page of 500 of the tab's list of runs:
beside the Markdown itself, about 46 bytes a run on the tab of 19,601 runs, held under 57
(`__tests__/docs-store-paged-heap.test.ts`). It
holds nothing for a list, since it reads no list definition and carries nothing from run to run
where every run's rendering is stored. `getContent()` answers a tab's whole Markdown, so that
string is the least a read holds; only a read of a part of a tab would hold less, and the
connection has none.

After a deploy that changes how a Doc's stored copy is worked out, the first change or write of
each stored tab asks again whether the model can index the tab as Google Docs does, decoding
its runs one at a time and never the tab whole, and the first read or change keys the tab again,
a run decoded and rendered at a time. For the first change that is, once, each run decoded twice
and rendered once, beside the runs of the change's piece and the run the change cut: 2,422 runs
decoded and 1,222 rendered for a change to a table's cell in a tab of 1,201 runs, 20 of each
for the piece and one rendering for the run cut (`__tests__/docs-edit-counts.test.ts`).
The tab's lists are read once a page of 500 runs, never once a run, whichever of these it is:
11 statements for that change, in a tab of 600 lists, each in a table's cell, which are one for
the question, one for each of the keying's three pages, one for each of the piece's five passes
and two for the runs the requests touch.

The copies a Drive connection keeps of the Docs it read are limited by count, by bytes, by age
and by the connection's reach (see
[What a Drive connection keeps of the Docs it reads](#what-a-drive-connection-keeps-of-the-docs-it-reads)).
What those limits leave: a connection that nobody uses again keeps what it stored, under the
caps, until it is used or removed from its workspace, since it has no alarm. A connection whose
Google account was disconnected or revoked keeps its copies the same way, though a read is
answered from one only inside its ten seconds of freshness. And a file moved two or more folders away from the path of the session that
is refused it, and still inside the connection's folder, loses its copy as a file that left
would, and is fetched once more at its next allowed read. The removal of what no queued
edit reaches reads small rows for the runs of the tab states stored for that document, and does
not slow as the connection stores more documents; neither does the removal of a copy, and a read
that keeps a document reads one small row for each copy the connection stores.

A Google Slides presentation's slide summaries come from one response capped at 10 MiB. It holds the
text of every slide's shapes and speaker notes, but no styles or geometry: about 2 KiB a slide on a
live deck, so a presentation needs thousands of slides to exceed it. It also holds every master's
and layout's name and background and the masters' theme colours, a few KiB in all. Slide content is
read one slide at a time, capped at 2 MiB each. Reads ask Google for compact JSON, so a cap counts
content and no indentation. While changes await approval, reads also fetch the
slides they address, so each can be checked as approving it would: slide content reads the other
slides of any batch touching a slide it shows, since a batch applies all or none, and the summaries
read every slide a queued batch changes, since they hold no tables or grouped shapes. Large batches
awaiting approval therefore cost reads more requests against Google's per-user quota. Queueing a
move, a skip, a deletion, or a new slide placed after another reads, of each slide it names, only
its shapes' text and whether it is skipped, a couple of KiB, and reads the slide whole when a queued
change edits it. A read asks for every slide it needs at once, whole or only that much of it, each
capped at 2 MiB. The 20 slides a read and the 100 a change may name bound what one call names, not
the pages fetched: the other slides of the queued batches that touch them are fetched too.

The simulated presentation was recorded from an English-locale account, so until it is created it
reads with locale `en` and English layout names. Google translates those names: a presentation a
Spanish-language account made in the editor read locale `es-419` and layout names such as
`Título y cuerpo`, with the recording's object IDs, placeholders and geometry. One created through
the API in a non-English account has not been checked, so an approver's presentation may name its
layouts differently from what the agent saw before approval, including in an approval card queued
then. `createSlide()` takes a layout's ID, never its name.

## Google Slides reads

`getSlides()` reads each element as the Slides editor shows it: its box and rotation, and what it
sets rather than inherits. Shapes carry their text and its formatting (links to URLs or to slides,
font weight, paragraph indents and bullets), and their fill, its opacity, and their outline with its
dash. Tables carry their cells, column widths, row heights and borders, collapsed to one `border`
when every edge matches. A table's `size` is nominal, 3,000,000 EMU square on every live read, so
its box is its columns and rows added up; a row's height is the least it may have, since Google
draws it taller to fit its text and reports that nowhere. Lines carry their ends, computed from
their transform, arrowheads, and the elements they connect; videos their YouTube or Drive ID; and
images and Sheets charts their source URL and spreadsheet. The `contentUrl` an image or chart also
has is a bearer URL, like a thumbnail's, so it is never read. `getPresentation()` lists the
presentation's layouts with their placeholders, for `createSlide()`.

## Google Slides edits

A `.pptx` or other Office presentation cannot be bound; connecting one makes a native copy (see
[Office files](#office-files)). A directly bound presentation accepts six changes, each queued for approval: `updateSlides()`,
`duplicateSlide()`, `deleteSlide()`, `moveSlides()`, `createSlide()`, and `setSlidesSkipped()`.
Changes are journaled with the kit's `ActionJournal`, and apply in the order they were queued.

`updateSlides()` takes up to 50 changes applied together: find-and-replace or whole-text
replacement in shapes, table cells, and speaker notes, text and paragraph formatting (including
bullets), shapes and their fill, outline and vertical alignment, moving, resizing, rotating,
stacking and deleting elements, alt text, images by public `https:` URL, and tables with their
rows, columns and cell fills. Elements a batch creates get IDs the gatekeeper mints: later changes
in the batch can address one by its `ref`, and later batches by the ID returned for it. An image
URL is never fetched by the gatekeeper: Google downloads it when the change is applied, so nothing
is read from it before approval.

Two of its changes reach beyond a slide's elements:

- `setBackground` sets the background of a slide, a layout or a master, named by exactly one of
  `slideId`, `layoutId` and `masterId`: a colour, `"none"`, a picture by public `https:` URL, or
  `null` to inherit the background of the layout or master the page is made from. A master has
  nothing to inherit from, and Google turns a reset there into no background, so `null` is refused
  for one. As with images, Google, not the gatekeeper, downloads a picture URL when the batch is
  applied. Reads report a picture background only as `"picture"`, and never request its content
  URL, a short-lived URL that reads as the account that fetched it.
- `setThemeColors` sets some of a master's 12 theme colours. Google takes all 12 at once, so the
  colours not given are merged in from the master's scheme as the batch is planned against its
  fresh read: a colour a collaborator changed meanwhile is kept, and one changed after that read
  makes Google refuse the revision-pinned write, so it is planned again.

`getPresentation()` lists the masters, with their backgrounds and theme colours, and the layouts,
with their master and background, but not their elements; each slide reports its layout, its master
and a background of its own. The Slides API cannot change which layout an existing slide is made
from.

A batch is queued as the first of five action kinds that fits it; they share everything but their
names and whether a user may let them apply without asking. A user may let four apply without
asking: "Slide text edits" (only text edits); "Slide formatting and arrangement" (only formatting
text, setting no link or font, since Google keeps their whole strings; formatting paragraphs and
shapes; moving or stacking elements; and setting slides' backgrounds to a colour, `"none"` or
`null`); "Slide edits that keep every element, table row and column and download no images"
(every other batch that deletes no element, table row or column and downloads no image: mixed
batches, links, fonts, alt text, new shapes and tables, table rows, columns and cell fills, and
changes to layouts, masters and theme colours, which reach every slide made from them); and
"Slide changes that delete elements, table rows or columns" (a batch that deletes any of those
and downloads no image), since the presentation's version history restores what it deletes. The
fifth, "Slide changes that download images", always waits for approval. It holds a batch that has
Google download an image from a URL the agent chose (to insert it, replace one, or use it as a
picture background), whatever else it does, since that URL can carry whatever the agent encoded
in it.

`createSlide()` adds a slide made from one of the presentation's layouts, at the start, the end, or
after a given slide. The gatekeeper mints the slide's ID and one for each placeholder it gets from
the layout, read from the layout's page when the change is queued, so later changes can fill the
placeholders before it is approved. Reads show the new slide with the layout's placeholders, empty,
at the layout's size and position, as a live probe showed Google makes them, but for a slide
number: Google adds one only while the presentation shows slide numbers, which a new one does not,
and otherwise ignores its mapping, so none is minted and a slide number appears once the slide
exists (`instantiatedPlaceholders()` in `slides-simulation.ts`).
Google takes a new slide's layout only from the master of the slide before it, of the first slide
when it goes first, or of the presentation's first master when it has no slides, so a deck with
slides imported in another theme has layouts that fit only some places: layouts and slide
summaries carry their master's ID, and a layout that does not fit where it is to go is refused
when queued, and again on approval against a fresh read, as is one deleted since; approval also
refuses one that has lost a placeholder the slide was to get. Google deletes a master and its
layouts with the last slide on it, unless it is the presentation's first master, as a live probe
showed, so reads drop a master whose last slide a queued deletion removes, with its layouts, and
a slide queued after it on one of those layouts is refused. Google names a new slide's speaker notes
only as it creates the slide, so they cannot be edited until it is approved.

Adding, duplicating and moving slides are the "Adding, copying and reordering slides" kind, which a
user may let apply without asking. Deleting a slide is the "Deleting slides" kind, which a user may
let apply without asking too: it takes the slide's content and notes, and can take its master and
layouts, and the presentation's version history restores them.

`setSlidesSkipped()` skips slides, leaving them out when presenting, or shows them again. It is
the "Skipping slides" kind, which a user may let apply without asking: it destroys nothing, and
is undone the same way. It applies against the presentation's outline alone, reading no slide.

Reads show queued changes as if applied, by replaying them over Slides' own JSON before it is
projected; thumbnails show the presentation as saved. Each change is replayed as Google documents
its request, and one the replay cannot follow exactly is refused instead: a bullet list started
right after another list item, which Google may join to that list; table rows or columns inserted
or deleted beside a merged cell; deleting a grouped element that would leave its group with one;
rotating a video, which Google cannot shear; and new text filling a list item whose bullet is
styled apart from its text, which Google would restyle to match. The replay makes no claim about
what Google renders: shrinking text to fit, wrapping, the box Google fits an image to, the borders
around new or deleted table rows and columns, and the formatting new rows and columns take appear
once applied. Table rows and columns are sized as live reads show Google sizing them: a new table
shares its box evenly, a new row or column copies the one beside it, every column then narrows so
the table keeps its width, and the lines a deletion leaves keep theirs. It does follow Google in
turning a shape's autofit off once its text changes, fixing the font sizes and line spacings the
text sets at what the autofit had shrunk them to. A replacement takes the style of the text it
replaces, and text left unchanged at either end of a match is not rewritten, so it keeps its own.
Formatting a whole list paragraph also updates its bullet's style in replay, which later
replacements use when checking whether they can keep that style. Setting a font sets it at
regular weight, so the text is no longer bold unless the change says so. A slide number or other
AutoText can only be replaced whole.

Each approved change is one `batchUpdate`, planned against a fresh read and pinned to its revision
with `requiredRevisionId`, so a change applies only to the text it was planned against: one that no
longer applies fails without writing, and a concurrent edit makes Google refuse the write so it is
planned again. A write whose response is lost may have been committed, so it is only ever resent as
first sent, at the same revision. If that is refused, a read decides whether it landed, counting
only what the write would have changed: an element it created that it does not also delete, an
element it deleted that was there before, text it edited, a table it adds or deletes rows or columns
of, by its size and its cells' positions, spans and text, a theme colour it set, and a background
other than a picture it left a page with, that the page did not already have (every picture reads
alike). If the read cannot tell, as for a batch that only formats or moves elements or leaves a page
a picture, the change is marked as having an unknown outcome and never retried.

Google returns a presentation's revision only to an account that can edit it, so a view-only
account can read a presentation but every change to it fails. A queued change is stored in one
Durable Object value, so each is capped at 100 KiB.

## Google Sheets edits

An `.xlsx` or other Office spreadsheet cannot be bound; connecting one makes a native copy (see
[Office files](#office-files)). A directly bound spreadsheet accepts `updateSpreadsheet()`, which queues up to 50 changes for
approval as one batch, applied all or none and in order: `writeCells` enters values in every cell
of a bounded A1 range that names its sheet, such as `'Sales 2026'!A1:C3`, and `clearRange` clears
a range's contents, keeping its formatting. Batches are journaled with the kit's `ActionJournal`, and
apply in the order they were queued. A spreadsheet opened from a read-only Drive binding has no
change method; one opened from a read and write Drive binding has the same one (see
[Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)).

Input is literal and typed, so nothing depends on the spreadsheet's locale: a string starting with
`=` is a formula, any other string is text exactly as given, never read as a number or date,
numbers and booleans are entered as such, and `null` clears a cell. A date is entered as its
serial number in a cell formatted as a date, as `formatCells` can format it. Text starting with
`=` cannot be written as text, and formula-mode reads show it exactly as a formula, so writing
back what was read can turn it into one. A batch of only literal values and clears is queued as
"Sheet value edits", which a user may let apply without asking; a batch with any formula is never
that kind. A formula naming `IMPORTRANGE`, which reads another spreadsheet and so escapes the
binding, or `IMPORTDATA`, `IMPORTHTML`, `IMPORTXML`, `IMPORTFEED` or `IMAGE`, which make Google
fetch a URL, is refused in any letter case, outside string literals. Formulas the spreadsheet
already holds are not inspected, and one of its named functions could wrap a refused function, so
a batch with a formula may apply without asking, as "Spreadsheet edits that keep every sheet, row
and column" (below), only when every function its formulas call is a built-in the gatekeeper
knows computes from the spreadsheet alone, such as `SUM`, `IF`, `VLOOKUP` or `FILTER`. The batch
waits for approval as "Spreadsheet changes that run unchecked formulas" when a formula has any of
these:

- a call to any other name, including `HYPERLINK`, whose link carries what the formula puts in it
  to the site a click opens, and `LET` and `LAMBDA`, whose names can take a listed function's name
  and stand for a named function;
- a name that is not called, other than `TRUE` and `FALSE`, such as a named range, since a named
  function can be passed by name;
- a call on a parenthesized expression or on another call's result;
- apostrophe-quoted text that names no sheet.

Letting any of these kinds apply without asking trusts the formulas the spreadsheet already holds:
a value written into a cell an existing `IMAGE` or `IMPORTXML` formula reads makes Google fetch
whatever URL that formula builds from it.

Reads show queued changes as entered and never guess what Google computes. Formula-mode reads are
exact, and raw reads are exact for literal values. A queued formula's result, and in formatted
reads a queued number or boolean, whose display depends on number format and locale, read `null`,
and their cells are listed in the range's `pendingCells`. Formulas elsewhere keep their saved
results, even when they depend on queued cells. Google tidies the references in a formula as it is entered: column
letters upper-cased, a sheet named by its title as the spreadsheet spells and quotes it, a range of
one cell collapsed to that cell. A queued formula is shown, approved and written already tidied, but
with its whitespace as typed, which Google may later drop. A queued change that no longer applies,
such as one writing to a sheet since shrunk, is reported as `queuedChangeConflict`, and it and the
changes queued after it are not shown.

The same batch can change a spreadsheet's structure: `addSheet`, `renameSheet`, `duplicateSheet`
and `deleteSheet` act on its sheets, and `insertRows`, `deleteRows`, `insertColumns` and
`deleteColumns` on a sheet's rows and columns. A change names its sheet by title in `sheet`, as a
range does, including a title an earlier change of the batch gives a sheet it adds, copies or
renames, so it never needs an ID the spreadsheet has not assigned yet. The gatekeeper mints the ID
of each sheet a batch adds. A batch that adds, copies or renames sheets or inserts rows or columns,
alone or together with values, clears and formatting, is queued as "Spreadsheet edits that keep
every sheet, row and column", which a user may let apply without asking unless one of its formulas
calls a function the paragraphs above exclude. A batch that also resizes rows or columns, freezes
lines or unmerges cells is queued as "Spreadsheet edits that resize rows or columns, freeze lines
or unmerge cells", a kind of its own that a user may let apply without asking under the same
condition, so that a rule enabled for the kind above covers no layout change. A batch that also
deletes a sheet, rows or columns, or merges cells, is queued as "Spreadsheet changes that delete sheets, rows, columns or merged cells'
values", which a user may also let apply without asking, since the spreadsheet's version history
restores what it deletes, unless one of its formulas calls such a function: that batch waits for
approval as "Spreadsheet changes that run unchecked formulas". Each batch is
queued as exactly one kind, so letting edits that keep every sheet, row and column apply without
asking leaves batches of only literal values and clears, or only formatting, to their own kinds.
Every default is sent explicitly, so the approver sees what will be made: a new sheet has Google's
1,000 rows and 26 columns and comes last, and a copy is titled `Copy of <title>` and placed right
after its source (Google would put it first, under a name of its own choosing). Changes are refused
when queued that would delete the last visible sheet, every row or column of a sheet, or every one
of its unfrozen ones, delete a sheet of more than 50,000 cells, whose content the guard below could
not cover (delete it in Google Sheets instead), grow a sheet past 18,278 columns or the spreadsheet
past 10,000,000 cells, or change or copy a sheet holding a protected range the account cannot edit,
though rows and columns outside that range may be resized and lines frozen through it, as Google
allows: in a scratch spreadsheet where another account protected A1:C1, resizing row 1 or column A
was refused with "You are trying to edit a protected cell or object", and a freeze was allowed.
Reads show the
queued structure: sheets, rows and columns where the changes put them, cells moved with their rows
and columns, and formulas rewritten as Google rewrites them, references shifted, grown, shrunk or
turned into `#REF!`, and sheet titles requoted. A formula's value is shown only while every
reference it holds keeps exactly its cells; one whose reference grows, shrinks or breaks, or that
calls a position-dependent function such as `ROW`, `OFFSET` or `INDIRECT`, or `QUERY`, whose query
names columns by letter, or uses a name such as a named range, or calls a function the
gatekeeper does not know to depend only on its arguments (one of the spreadsheet's named functions
may hide references or such calls), reads `null` and is listed in `pendingCells`, as are cells a
queued formula enters. Cells of inserted rows and columns and of
added sheets read as empty. Deleting a sheet leaves the formulas that refer to it as written, as
Google does; they read `#REF!` once it applies, and stay so even if a later sheet takes the title.
Once rows, columns or sheets are queued, cells Google fills with nothing entered in them, such as an
array formula's results (`SORT`, `SEQUENCE`, `FILTER`, `QUERY`) or a pivot table, read `null` and
are listed in `pendingCells`.

`formatCells` formats every cell of a range, keeping its contents: bold, italic, underline,
strikethrough, font size, text and fill colour (`#rrggbb` or a theme colour such as `ACCENT1`),
number format (a type and an optional pattern in Google's syntax), horizontal and vertical
alignment, wrapping, and borders along the range's edges and between its rows and columns. A field
set to `null` is reset to the default, and a border set to `null` is removed; fields left out are
kept. A batch of only `formatCells` changes is queued as "Sheet formatting", which a user may let
apply without asking; mixed with other changes it is queued as one of the kinds above. `readFormats()`, which a
spreadsheet opened from a Drive binding offers too, reads the formatting set on up to 10,000 cells
of a range, never their values, and shows queued formatting merged in queue order. Cells of rows
and columns a queued change inserts, whose formatting Google inherits from a neighbour in ways that
differ between rows and columns, read `null` and are listed in `pendingCells`. A border along a
range's outer edge removes the facing border of the cell beside it, since Google gives an edge one
owner, and reads show that. A formatted value read of a cell whose number format a queued change
sets or resets reads `null` too, listed in that range's `pendingCells`, unless a queued change
leaves the cell empty: a format such as `;;;` can hide what a blank-looking cell holds. So does a
value queued on an inserted row or column, which takes the number format of the line before it.
Google accepts any font size and number pattern, so the gatekeeper's checks are the only ones: a font size is an
integer from 1 to 400, and a pattern holds 1 to 200 characters and no control characters.
Formatting is not guarded: a collaborator's formatting change made after a batch is queued is
overwritten when it applies.

`getSpreadsheet()` lists how many leading rows and columns each sheet freezes, and `readFormats()`
lists the merges that overlap the range, each whole, and each of its rows' height and columns' width
in pixels. Queued changes to rows and columns move them as a scratch spreadsheet showed Google moving
them: lines inserted within a merge or among the frozen lines join it, lines inserted at either of its
edges do not, and deleted lines shrink it, a merge left one cell vanishing. An inserted line's size
reads `null` unless a queued resize sets it, since Google takes it from the line beside it. `resizeRows` and `resizeColumns` set
lines' sizes, a whole number of pixels from 1 to 10,000 (Google accepts any number, negative ones
included), and `freeze` sets how many leading rows or columns a sheet freezes. Both keep every sheet,
row and column and every cell's value, and are queued as the layout kind. A freeze is refused when queued that would leave no row or
column unfrozen, or freeze only part of a merge, as Google refuses both.

`mergeCells` merges a range into one cell, or with `merge: "ROWS"` or `"COLUMNS"` each of its rows
or columns, and `unmergeCells` unmerges every merge within a range. As a scratch spreadsheet showed,
a merged cell shows its top-left cell's value, and Google clears every other cell it covers, gives
them the top-left cell's formatting, and restores neither on unmerging; reads show the cleared cells
blank and their formatting `null`, listed in `pendingCells`. A merge is refused when queued that would
take in part of an existing merge (one the range holds whole is replaced) or merge frozen lines with
others, as is an unmerge of a range holding part of one and a value written into a cell a merge
covers, which Google accepts and drops. Since a merge clears cells, a batch with one is queued as
"Spreadsheet changes that delete sheets, rows, columns or merged cells' values", which a user may
let apply without asking, and its guard covers the cells it clears; an unmerge keeps every sheet,
row and column, and is queued as the layout kind. An unmerge splits only the merged cells its range
held when it was queued: one whose range then holds others, because a merge or an unmerge queued
before it was rejected or a collaborator changed the merges, fails without writing.

Sheets has no revision to pin a write to, so each approved batch is planned against a fresh read
and guarded by a digest of what it overwrites or removes: the cells it writes and the rows,
columns and sheets it deletes, as entered, the title and size of each sheet it addresses, and,
when it adds or copies a sheet, the order of every sheet, ignoring whitespace in formulas. Cells
that changes queued before it write are expected to hold what those enter, and sheets those
restructure to have the shape they leave, and an unmerge records the merged cells within its range
as those changes leave them, which it applies only while the range holds exactly those, so a batch
built on one that was rejected or failed fails too, as does a batch with a formula when any
structural change queued before it was not applied,
and a batch adding or copying a sheet when a sheet queued before it to be added, copied or deleted
was not. A batch guards at most 50,000 cells. A change whose cells or sheet
changed since it was queued fails without writing; a collaborator's edit between that read and the
write is not caught. Each batch also creates a developer-metadata marker whose ID is minted at queue
time, which Google stores at most once, so a write whose response is lost is found by its marker or
resent exactly as first sent. A lost write that cannot be resent, because its cells changed in the
meantime or Google refused the resend, or that three sends leave unfound, is marked as having an
unknown outcome. A marker is visible only to the Google Cloud project of this deployment's OAuth
client, leaves no Drive revision, and is deleted by the first write at least ten minutes after its
batch was last sent, since a send given up on may commit until then. While a write with an unknown
outcome could still land, later changes stay pending.

A change is refused when it is queued if the connected account can only view the spreadsheet, or
if it writes outside a sheet's grid or into a protected range the account cannot edit. A change
addresses at most 10,000 cells and a batch 20,000, a cell holds at most 50,000 characters, the
changes queued at once may set values or formatting in at most 100,000 cells in all (a cell given
both counting twice, a copied sheet counting what changes queued to it set) and make at most 50
changes to rows, columns and sheets, and a queued batch is capped at 100 KiB. While such changes are
queued, a read or a batch may involve at most 5,000,000 characters of formulas times their number,
since each formula is rewritten through each of them, and hold at most 5 MiB of text as rewritten.
Queuing a batch, applying it, and a read while changes are queued fetch the spreadsheet's sheets and
protected ranges, and, in a second request, the merges of only the sheets the batch and the changes
queued before it act on (and, for `readFormats()`, the sheet it reads), so merges elsewhere hold up
no write. Applying a batch, `getSpreadsheet()` and a range read send the two requests together,
since the changes name their sheets by ID; queuing a batch and `readFormats()` find sheets by title,
so they send the second once the first answers. Google refuses a merges request that names a sheet a
collaborator has deleted (400, `INVALID_ARGUMENT`), so one that fails while a sheet it names is gone
is sent again for the sheets left, if any. The request needs a grant that may edit the spreadsheet,
so where Google refuses it for the grant (403), as for a read and write connection whose account can
now only read, the merges of every sheet are read with `spreadsheets.get` instead. Google's list of
those merges may be at most 5 MiB, about 70,000 merges; a batch acting on sheets holding more is
refused with an error saying so, as is a read with such a change queued. Google allows 60 write
requests a minute per user; a write over that quota stays pending.

## Google Drive bindings

Drive exposes three permanent resource URL forms:

- `https://drive.google.com/drive/my-drive` selects everything the connected account can read in Drive. Despite the `my-drive` URL it is not limited to My Drive: any ID the account token resolves is in scope. Listings use `corpora=user`, which Google defines as My Drive items the account created or opened plus items shared directly with it, so a shared drive's contents may be readable by ID without appearing in a listing. Bind a folder or file when this authority is too broad.
- `https://drive.google.com/drive/folders/<folderId>` selects one folder or shared-drive root.
- `https://drive.google.com/file/d/<fileId>/view` selects one file by its immutable ID.

Each form connects read-only unless it carries `?access=write`, which makes the binding read and write, as in `https://drive.google.com/drive/folders/<folderId>?access=write`. Any other value, or none, is read-only, so a binding made without the parameter is read-only. The level is part of the binding and does not change; to change it, connect the folder or file again. A deployment can still keep every Drive binding read-only (see [Keeping Drive read-only](#keeping-drive-read-only)). A read-only binding's TypeScript types hold no write method, and its session refuses one, naming the URL to request instead. A read and write binding's title ends in "(read and write)". Its writes also need the account to hold the Drive writes grant above, checked when a write is queued and again when it is approved, so a read-only binding stays read-only whatever the account has granted. Code that holds a binding reads its level from `getScope()`, whose result carries `access`, `"read"` or `"write"`, whatever the account has granted. A blueprint carries a binding's level only in the URL it may suggest for it. The blueprint's install page shows that URL to the installer but does not pre-fill it, so its dialog opens on **Read and write**, the dialog's default, whatever the URL says, and the binding installs read and write unless the installer chooses **Read only**. An agent that makes or merges a gadget from the blueprint is given the suggested URL, so its connection request opens the dialog on the level the URL asks for. A gadget that comments checks `getScope()` before it writes, since on a read-only binding every write fails, and an author who needs writes says so in the binding's description.

The Drive picker opens on Google Drive, whose own choice binds the whole account, above My Drive, Shared drives, Shared with me and Recent. Locations list a page at a time. Search spans My Drive, "Shared with me" and every shared drive the account is a member of (`corpora=allDrives`) and says where each result lives, and a Drive, Docs, Sheets or Slides link pasted into it answers with the one folder or file the link names. A pre-filled folder or file opens where it lives, with breadcrumbs up to My Drive or its shared drive, or with none when an ancestor is out of reach or more than 20 folders up. All of this runs on the Drive resources' own grant except listing Shared drives, which also needs the shared-drives grant above: until the account holds it, opening Shared drives offers **Allow access**, and a shared drive's folders stay reachable through search, a pasted link or a pre-filled URL. Folders whose children the account cannot list are shown but cannot be opened or bound; on a pre-filled node's breadcrumbs, where Google's [folders with limited access](https://developers.google.com/workspace/drive/api/guides/limited-expansive-access) put them above a file shared directly, they can be opened but are not offered. A shortcut stands for its target, which a listing says nothing of, so a page's shortcut targets are read in one batch: a shortcut left behind when its target was deleted, unshared or trashed is left out, and one to a folder is judged as that folder would be. A search Google reports as incomplete fails rather than presenting partial results as complete.

A native Docs, Sheets or Slides file binds as its editable type (Google Doc, Spreadsheet or Slides Presentation) unless the Workshop accepts only Drive files, as a blueprint's Drive file binding does, when it binds as a Drive file, whose content is edited only through a read and write binding (see [Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)). It also binds as a Drive file, and the picker says so, on the Google Drive card when the account lacks its type's grant or an admin disabled the type. On the card, the notice's **Allow editing** asks Google for every editable type the account lacks; the grant restarts the picker, so the file is chosen again, and an account that already held them (the type is disabled) is told editing isn't available. A file the picker showed as native connects as it is; one pre-filled from a URL is checked first, as an Office file is. An Office file binds as the type it converts into, once converted (see [Office files](#office-files)); any other file binds as a Drive file. Each file shows when it was last modified and, when Drive reports one, its size; a shortcut shows none, since its target is read only for what decides scope. Recent lists the files the account created, opened or had shared with it, newest first, folders left out.

Under the picker, **Access** offers **Read and write**, the default, or **Read only**, whenever the chosen target connects as a Drive type, where the deployment offers read and write: all of Drive, a folder, or a file bound as a Drive file. It is not offered for a Doc, spreadsheet or presentation that connects as its editable type. A Doc bound that way reads all its own comments and writes them (see [Google Doc comments](#google-doc-comments)), except that it cannot make or answer a comment attached to no text; that, and the comments on a spreadsheet or presentation, go through a Drive binding that reaches the file. In the dialog that is its folder, or all of Drive. An agent can also request the file's own Drive link, `https://drive.google.com/file/d/<fileId>/view`, with `?access=write` to write comments as well as read them, which opens the dialog on that file as a Drive file, and a person can paste the same link into the chat composer. Pasted into the picker's search the link does not do this: there it finds the file as the picker lists it, which for a native file is its editable type. Read and write, chosen or by default, asks the gatekeeper whether the account holds the writes grant once a target is chosen; if it does not, a notice offers **Allow changes**, which asks Google from that click, and the dialog cannot add the connection until the account holds the grant. That consent asks again for everything the account has asked for before, so it can also grant an editable type the card lacked; Workshop then restarts the picker, as it does after **Allow editing**, and the choice is made again, which the notice says beforehand on a card that lacks such a type. A connection request an agent pre-filled is applied to the restarted picker too, which reopens on Read and write. A refused or abandoned consent leaves Read only available. A resource URL carrying `?access=write` opens the dialog with Read and write chosen, so an agent's connection request can ask for it, and one without it opens the dialog on Read only; the choice sits under the list, so the form's first line then says that Read and write is chosen, until the choice is changed. A link pasted into the chat composer is connected as written, so one carrying `?access=write` makes a read and write binding without the dialog; it can write only once the account holds the grant.

A folder URL carrying `?resourcekey=` is not supported: the key is dropped, and the binding then fails with a Drive 404 for anyone whose access to that folder comes from the link rather than from a direct grant. Google requires resource keys only for items shared by link before September 2021, and only for link-access users — an owner or anyone granted access directly is unaffected, even when the URL they paste happens to carry a key. Such a folder needs direct access to connect.

The agent-facing `GoogleDriveReadSession` covers read-only account and exact-file bindings, and `GoogleDriveFolderReadSession` a read-only folder binding, positioned at the selected root and exposing only its current folder's direct children and the targets of shortcuts among them (see below): `list()`, provider-side structured `search()`, `getEntry()`, native Doc/Sheet/Slides opens, `readPdf()` and `readFile()`, and `openFolder()` for one live direct child folder or shortcut target. A read and write binding gets `GoogleDriveSession` (the account), `GoogleDriveFileSession` (a file) or `GoogleDriveFolderSession` (a folder), which add the comment writes and the sharing calls `listAccess()`, `share()`, `updateAccess()` and `unshare()`, and, for the account and the folder, `move()`; a folder opened from one keeps its access, except that one opened through a shortcut, and any folder opened from it, is read-only and says so. Every session's `getScope()` reports its binding's access as `access`, so code given either kind of binding can tell which it holds. A folder session's scope also names the folder it was opened from, as `parentFolderId`, which is the one place above itself it can move a file to. Listing and search return disposable RPC cursors; child folders and native content sessions are independently disposable capabilities. There is no built-in recursive folder search, traversal pager, raw Drive `q`, file write other than [comments](#drive-comments), [moving and sharing](#moving-and-sharing) and [editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides), shortcut traversal beyond a folder binding's reads, or export of Google-native files.

Every Drive session offers `readPdf(fileId)`, which downloads an in-scope PDF and returns its text as Markdown, converted by Workers AI's `toMarkdown()`. It downloads with the Drive resources' `drive.readonly`; on an account connected before they requested it, `readPdf()` fails asking the user to reconnect. The file is checked against the binding's scope, and must be a PDF, before anything is downloaded, and a folder binding re-proves it is a live direct child, or a shortcut target, after the download, as for a native read: the token's `drive.readonly` reaches any Drive file, so scope is enforced in code. Neither the PDF nor its text is held in memory: the download streams straight into the conversion request (through the `AI` binding's own `fetch`, since the binding's `toMarkdown()` takes a whole `Blob`), and `text` is a `ReadableStream` of UTF-8 Markdown read from the conversion's response as it is converted, so the agent bounds how much it reads. `readPdf()` reads the response only until the text begins before it returns, so `hasText` is already known. Pages are separated by `### Page N` headings, and pages before the first with text are left out, unless pages without text are read into the text, as said further down. There is no download or text cap: a PDF Workers AI cannot convert, including one too large for it, fails. A scanned or image-only PDF has no text to convert, so its pages are transcribed, as said next. Conversion runs under a fixed file name with its images left undescribed, so no Drive file name reaches Workers AI and the conversion makes no billed model call.

`readPdf()` has a vision model read the pages that have no text of their own. It takes no option for that: a deployment turns it off for every connection with `PDF_OCR`, described below. A PDF that proves to have no text is transcribed, and returns `transcribed: true` with the transcription as `text`; one that has text keeps it, and the pages of it that have none may be read into it, as said further down. Each image sent is one billed call to the Workers AI vision model `@cf/google/gemma-4-26b-a4b-it` (about 320 input and a few hundred output tokens for a page of prose sent whole), made with no budget or approval of its own, through the same AI Gateway as conversion when `CF_AI_GATEWAY` is set; a gateway that stores its logs then holds the images and their transcriptions. As the PDF streams into the conversion, a scanner (`src/pdf-images.ts`) notes where each page image sits in the file, reading each object once and keeping a few numbers of it whatever the file holds. Any image at least 200 pixels on each side that is not a mask is a page image; a smaller one, and a mask that large, are only counted, the mask with whether it holds one bit a pixel. What the scanner found decides, in `pdfToText()` (`src/drive-pdf.ts`), how a PDF without text is read. An encrypted one is refused. One of up to 32 MiB has its pages rendered, when the Worker has its `PDF_RENDERER` binding, whatever the scanner counted: a page may show an image written into its content stream, or writing drawn as shapes, neither of which is an object for the scanner to see. Any other that holds no image of any kind, the counted ones included, has nothing to transcribe and returns an empty `text` with `transcribed: false`; one that does has its page images sent as the file stores them, or is refused when none of its images is a page's, as said further down. Either way nothing is done until `text` is read. Pages are then read ahead of the reader, up to 16 of a rendered scan and up to four stored page images begun at a time, so an agent that stops reading, or cancels, stops paying for the pages that were not begun: what reading ahead costs is said further down.

A rendered PDF's pages are drawn by [PDFium](https://pdfium.googlesource.com/pdfium/) in a Worker of its own, `pdf-renderer`, which this one reaches over the `PDF_RENDERER` service binding, taking only the types and limits of its `src/api.ts`; [its README](../pdf-renderer/README.md) says what it holds and the limits it draws under. Drawing reads what sending stored images cannot: pages stored as fax, JBIG2 or JPEG 2000, with a palette or in CMYK, in layers, tiles or strips, or turned, and pages that the file stores in another order than its page tree lists them. At the first read of `text` the file is downloaded a second time, as one content read of the whole file: checked against the binding's scope, re-proved on a folder binding, reported as `drive/content/<fileId>`, and failed if the file is no longer the size it was converted at, or, on a folder binding, if its modification time has moved. The download streams into the renderer's `open()`, which keeps the file in its own isolate; what this Worker holds is a stub to the open document, and the bands of the pages read ahead while they are read. A scan's pages are asked for ahead of the reader: from the first read of `text` on, up to 16 are begun and not yet given (`READ_AHEAD.pages`), the one being read among them, and they are drawn and their pixels held as is said further down of the pages read into a PDF that has text. A page that fails, and the text with it, does so when the reader reaches it, and the pages begun after it are given up as it fails. Each page is asked for with `renderPage(index, { bands: 4, denseLines: 14 })`: the renderer draws it in 8-bit grey at 150 dpi (fewer for a page that would pass 3,000,000 pixels or 4,000 on a side) and cuts it across, at its least inked rows, into at most four bands, fewer for a short page and for one set in columns. A band that holds more than 14 lines of writing is then cut once more, up to eight bands a page, so that a closely written page is read in smaller images: on a generated page of small print (1,236 words) the model got 5 to 8 words wrong in four bands and, in two reads of six, left a whole clause out of the tallest, against 2 to 4 wrong and no clause lost in the six bands this cut gives, for two calls more. 14 is the largest number that cuts that page, and of the other seven test pages it cuts only a table's, once; the words at the new cuts are where the six-band reads err. The renderer counts lines only on an upright page, so a scan turned a degree or so keeps its four bands. A band with no ink is sent to no model. Every other band is wrapped as a PNG (`pngFromSamples` in `src/pdf-png.ts`, deflated a step at a time as the request takes it) and sent with the prompt a whole page is and one sentence more, against writing a stamp or a logo as an image or a link (a prompt that said the image is a band, which may begin or end inside a table, made the model stop short of a long band's end); the calls of all a page's bands are begun at once (`src/pdf-bands.ts`), each in one of the text's slots for model calls, of which further down. The bands' texts come under the page's one heading, each on a line of its own after the last, so a table or a paragraph that a cut falls in comes back in two parts, the second part of a table at times under an empty header row. The page is given whole, in one read, and a cancel sent while it is being read is acted on once it has been. Pages are numbered by the page tree.

A band costs three model calls at most, not counting those the service refused, all with the same prompt and settings: no seed is sent, since on the band it was tried on the model gave one answer whatever seed it was sent. A call is made again as it was, once, when it failed with a 5xx that does not carry Workers AI's code 3040, or when its response broke off or reported an error partway; a second such failure fails the text, as any other failure does at once, and the answer of a call made again is the band's however it ended. Before it is made again there is a pause of 250 ms and up to 250 ms more at random (`RETRY_PAUSE` in `src/pdf-bands.ts`). A call the service refused for rate or capacity is one that failed before any answer with HTTP 429, or under any status with code 3040, which says the model has no room just now. The code is the first `internalCode` or `code` in the first 1,024 bytes of the failed answer (`src/workers-ai-vision.ts`), and is 3040 when any code there is, or when those bytes hold `3040: Capacity temporarily exceeded`. A refused call is not one of the band's three: it is made again after a pause, of 1, 2, 4, 8 and then 16 seconds and up to a quarter more of each at random (`REFUSED_PAUSE`), so that the calls a model had no room for do not all come back at once. Each refusal counts as the text moving, and no pause is as long as the idle minute, so a band being refused is not what the idle minute ends: the text fails at that band's page instead, once its ask is refused for the sixth time. The sixth refusal of one ask is a failure after which the call is not made again. Either pause ends at once when the page is given up, by another band's failure or by the text's ending. An answer did not end whole when it was stopped at the model's output limit, or ran away repeating itself and was stopped by the gatekeeper: a unit of 12 or more characters said 12 times on end, or 2,000 characters on end of a shorter unit or of one with no letter or digit in it, so that a table's rule and a contents page's dot leaders are not taken for one. A band whose first answer did not end whole is not asked again as it was, since the model would answer the same. It is cut in two at the least inked row of its middle third (a row's ink measured from the row's own ground, as the renderer measures it, so that a page of light writing on dark is cut between its lines too), of rows equally inked the one nearest the middle, and each half that has ink is asked for, the top and then the bottom, with no pause; the halves are views of the band's rows, not copies. A cut that would part the columns of a page set in columns is not made, by the renderer's own test of its cuts (`partsColumns()`, which the renderer package exports), and the band keeps its first answer: the halves' texts are joined one after the other, so the columns would come back in pieces. A half's answer is stopped only at the 2,000 characters, whatever its unit: a table may hold twelve equal rows, and the first answer is stopped in them. The halves' texts, the bottom's on the line after the top's, are then the band's, and when either did not end whole the page is followed by `[The transcription of this page was cut off.]`. When a half's call fails, which unless it was refused is not made again and after which a bottom half is not asked, when neither half has ink, or when the halves say nothing where the first answer said something, the first answer is kept, a runaway as far as the first of what it repeated, and the page is followed by the same line. And once every band of the page has an answer, a band whose one answer is short for its ink is cut in two likewise, and its halves' texts are kept when together they are longer. Short is under a third of the characters for each unit of ink that the page's other bands with text have at their median, of which there must be at least two, unless the band's own ink is under a tenth of their median; the three numbers are a first setting. A band of fewer than 64 rows is not cut but asked again as it is: a second answer that ended whole replaces a first that did not, unless it says nothing where the first said something, and of a short band's two answers the longer is kept. Against the real model and through the real renderer, on generated pages, the cut has been seen only for a short answer (five bands of a page that is mostly a figure, each read better in halves); no call there failed, was stopped at the output limit or ran away, so the retry, a refused call's pauses and the cut after an answer that did not end whole are tested with a fake model only.

A page the renderer could not draw within its limits has its heading and `[This page could not be drawn within the memory and work a page is allowed, so it was not read.]`, and the text goes on. A page that comes out with no ink is sent to no model: it has its heading and, when it draws an image, `[This page came out blank: it has nothing on it, or its image could not be read.]`. A page drawn on a second try, at half the resolution, is followed by `[This page was read from a drawing at half the usual resolution, which is what its size allowed, so its text may be less exact.]`.

The renderer may not open the PDF: an isolate of it has room for 40 MiB of open PDFs and refuses another, the call may fail with nothing behind the binding, and the file may not open, may have more than 2,000 pages, or may be encrypted where the scanner did not see it. Whether the page images can be sent as stored instead is settled when `readPdf()` runs, and when they can be they are, from the first page (logged as `google.drive.pdf.renderer_fallback` with the reason as a word). That happens only before any page has been given, since the two paths number pages differently; an encrypted file is never read so. When they cannot be, `text` errors at its first read: with `The PDF's pages cannot be rendered to be read just now; read the PDF again in a minute.` for want of room or of an answer, with the refusal of an encrypted PDF, and with `Google Drive's PDF could not be transcribed.` otherwise. A download that is not of the size the first was fails the text as a changed file. As for `readFile()`, a failure of the stream reaches a caller over RPC as a broken stream rather than with these words, which is why the types tell the agent to read a PDF again whatever the error says. An open document can also be lost, when the renderer's isolate goes away, or when the renderer, to open another PDF, takes back the room of a document that has gone two minutes without a call, as one whose page takes that long to read has. The next `renderPage` then throws, or answers `released`. If the lost document had rendered a page, the file is downloaded and opened again and the page asked for once more; if it had not, or it is not opened again, the text fails. A document is also lost to what its pages cost to draw: every page drawn of one open document counts against the CPU time one invocation of the renderer may use, which its config sets to five minutes, the most a Worker may have. Measured on the edge, a fax scan of 557 pages at 300 dpi, about the most that fits in the 32 MiB a PDF is rendered up to, used 88 to 135 seconds of it and was opened once, where the default 30 seconds ran out three times on the same file, every 130 to 155 pages. Pages that are heavy to draw use that up soonest: the heaviest that are still drawn within a page's limits, pages of shadings as a map or a technical drawing may be, take 3 to 5 seconds each, so about a hundred of them do. The `renderPage` that runs out throws, the file is downloaded and opened again, one more content read, and the text goes on from that page.

A text that may read the file again, which is every transcription and every text that pages without text may be read into, is ended with an error after a minute with nothing moving (a transcription from when it is returned, the other from when its first page without text is asked of the renderer), whether the model has stopped answering or the caller has stopped reading, and its requests, its reads of the file, its approval queue and its document in the renderer are let go, as a file read's stream is: a cancel sent over RPC is delivered only after the read it is waiting on, so nothing else would end a page the model stalled on. On the rendered path the clock is moved by each chunk of the file handed to the renderer, each answer of the renderer and each piece of any band's text, so a long download, a run of blank pages and a slow page are not taken for a stalled text. It is also moved every 15 seconds while a page waits its turn for the isolate's room for pixels and its text holds none, since it is then other texts that it waits for; a text that holds pixels is moved by what becomes of them. What is read ahead of the reader moves the clock only while a read of `text` is waiting, so a text nobody reads still ends a minute after its last read. However such a text ends, the calls of every page begun are given up, whether in flight, waiting for a slot or pausing, an `open` in flight is ended by erroring the stream handed to it, a page being rendered is left to finish, and then the document is disposed, which gives its room in the renderer back; a document is also disposed as soon as its last page has answered.

Sending page images as stored holds nothing of the file: a page's image is read from Drive by range and base64-encoded into the model's request as it arrives, one call a page. Pages are read ahead of the reader: from the first read of `text` on, up to four (`READ_AHEAD.storedPages`) are begun and not yet read to their end, the one being read among them. Their ranges are asked for one at a time, in page order, the next once the image before it has been read to its end or its call is over, and the answers then arrive side by side. A page's heading is given once its call has answered, and its text in the pieces the model produced it in; once 262,144 characters of an answer are held for the reader (`READ_AHEAD.answerChars`), no more of it is read until some are taken. Cancelling gives up every page begun. Every page read is a content read of its own, made ahead of the reader as the page's call is: checked against the binding's scope, re-proved on a folder binding and reported as `drive/content/<fileId>`, and it fails if the file is no longer the size it was converted at, or, on a folder binding, if its modification time has moved. A page whose call the service refused, as said of a band's, is asked for again after the same pauses, its range first, which is one more content read; its sixth refusal fails it, and any other failure does at once. Its `page_transcribed` line carries how often it was refused, as a band's line does. A page that failed errors the text when the reader reaches it; the pages begun after it are given up as it fails. Pages come under `### Page N` headings numbered in the order the file stores their images, which is page order for scanner output but is not guaranteed, since the page tree is not followed. Every page image counts as a page, so a PDF of pictures and no text has each picture read as one, and so is an image an edit left in the file that no page shows any more. An image whose object a later incremental update defines again is read once, as it was last defined. JPEG page images are sent as they are stored, and losslessly compressed grey or RGB ones are wrapped as PNG on the way without being decoded (`src/pdf-png.ts`). Rows the PDF keeps without PNG's filter bytes are inflated and deflated again to be given them, a step at a time as the request takes them, since workerd's compression streams would otherwise draw the whole page in at once; a page whose data does not inflate to exactly the rows its dictionary describes, or whose PNG would pass 12 MiB, fails the stream, though data that is out by a line end after rows that are whole (one counted into its length, or its checksum's last bytes taken for one) is read as a PDF reader reads it. A scanned PDF that is not rendered is refused, in the gatekeeper's words and before any model call, when a page is stored as fax (CCITT), JBIG2 or JPEG 2000, or as an image PNG cannot hold (a palette, CMYK), when a mask the size of a page holds one bit a pixel, which one stored as fax or JBIG2 always does, and which beside page images a stencil (`/ImageMask`) or a mask of one-bit samples that an image names does however it is stored (a scan stored in layers keeps its text in such a mask, which its colour layers would be read without, and a black-and-white page may be nothing else; a mask of more bits is a picture's transparency, and the picture is sent without it), when a page image is over 12 MiB (Workers AI refuses a request somewhere between that and 16 MiB) or has rows to inflate of more than 128 MiB, is not where the file says it is, when there are more than 2,000 of them, when an incremental update defines again an image that named a mask (what it named was passed over as a mask and may be a page's image in the file as it now stands), or when there is none, its images all being smaller than a page or masks: the refusal then says that its pages have to be rendered, and that this is done only for a PDF of up to 32 MiB or is not available on the deployment. Such a refusal says what the file's content is like, so it is authorized as a content read before it is given, as the text is.

A PDF that has text is returned as that text, and the pages of it that have none are read into it when the Worker has its `PDF_RENDERER` binding, the file is of up to 32 MiB, and the scanner saw all of it. What images the scanner found in it is not asked, for the reason a PDF without text is rendered whatever the scanner counted. The text is then the conversion's from its first page heading on, to the byte where no page is read from its image, so it keeps the headings of the pages before the first with text, which a text that no page is read into leaves out. (A text that does not begin under the heading that follows those of such pages, each written as a conversion writes a page without text, is returned as such a text.) A line is taken for a page's heading only when it reads `### Page N` with N one more than the page before and comes first or after four line breaks on end, which is where a conversion puts a heading and not where it puts a line of the document's that reads like one. A page whose section holds nothing but line breaks is rendered ahead of the reader. From the first read of `text` on, the conversion's text is read ahead and held, while under 262,144 characters of it are (`READ_AHEAD.ownTextChars`) and fewer than 16 such pages are begun and not yet given (`READ_AHEAD.pages`), and each such page found in it is asked of the renderer at once. They are drawn one at a time, in page order, and a drawn page's bands are read while the next is drawn. A page is of use drawn only while its bands are asked of the model, so none is drawn while a page's worth of the text's calls, four, still wait for a slot (`CallSlots.wanting()` in `src/pdf-read-ahead.ts`): a text holds the pixels of the pages whose bands are being read, a page keeping its own until its slowest band has answered, and of a page's worth of bands more that wait for calls, which is one page cut in four and up to four pages set in columns, each one band. A call that rests after a refusal counts as one that waits. A text has no number of bytes of its own, so one of pages that are one band each can hold all the isolate's room, as it could hold its 32 MiB before. A page counts as 3,000,000 bytes until it is drawn, then as its bands' pixels, and as nothing once its bands have been read, the calls made again and the cuts included, so no page is drawn twice. Every such text in the isolate shares 32 MiB between them (`READ_AHEAD.isolateBytes`), which none passes, whether or not its reader waits: the isolate is the Worker's, in which the Durable Objects of every connection that a machine runs share one 128 MB. A page that finds that room taken waits its turn, first come first served (`pixelRoom()` in `src/pdf-read-ahead.ts`), and is drawn once another text lets pixels go, as each does when a page of its has been read and when it ends, by its idle minute if by nothing else. A Durable Object that is reset while its text holds pixels runs nothing to let them go, and the isolate outlives it: pixels whose text has shown no life for three minutes, no page of its moving and no reader asking for one, are taken to be such and are taken back (`READ_AHEAD.abandonedMs`, logged as `google.drive.pdf.pixels_abandoned` with the bytes). So scans read at once on one machine may read slower, and hold no more. Measured on the edge against the reader as it was, which drew pages as far ahead as 32 MiB a text allowed: one text reads as fast (a 100-page scan at eight calls in 455 seconds either way, with as many calls in flight) and the isolate holds 11 MB of its pixels on average and 15.6 MB at most, where it held 29 MB and 32.5 MB. Four texts read at once in one isolate held 64 MiB between them, and held to 32 MiB they read slower: a 100-page scan by a tenth at eight calls, and by four fifths at 32 calls, where each text has 7.6 calls in flight for the 15.4 it had. With 48 MiB those were a hundredth and a quarter. Durable Objects asked for from one place seldom share an isolate, though: 400 landed on 305 machines. The PDF is opened in the renderer for the first such page, by the same second download, so a PDF whose pages all have text is downloaded once. When the page has ink, whatever drew it (a scan, an image written into the page's content, writing or a figure drawn as shapes), its bands are read as a scan's are, and what they give stands under the page's heading as `[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]`, an empty line, the text, the cut-off and half-resolution lines where they apply, and an empty line; an answer cut off before it held anything has the cut-off line directly under the first. A page that cannot be drawn within the renderer's limits has `[This page could not be drawn within the memory and work a page is allowed, so it was not read.]` and an empty line under its heading, as a scan's page has, and the pages after it are still read. A page that comes out blank, or reads as nothing without having been cut off, is left as the conversion gave it; a blank page costs its render and no model call. The document's own text is worth more than the pages missing from it, so what keeps a page from being read does not fail the text: a renderer that does not open the PDF or renders it no further, and a model call that fails, are logged, that page gets `[Pages of this PDF that have no text of their own could not be read just now.]`, and no page after it is read: those begun ahead are given up at once, and what came of one that had ended is not used. The text does fail when a read of the file fails, a changed file included, since it is then the text of another version, and when the conversion fails, in each case once the reader has been given all that came before. It returns `hasText: true` and `transcribed: false`, and it is a text that may read the file again, whether or not a page of it proves to have no text, which is known only as it is read. It has the idle minute only from when the first such page is asked of the renderer, which may be ahead of the reader: until then it is a conversion's text and may be left unread as one may, and a PDF whose pages all have text never has it. Until then a minute is counted only while a read of the text waits, so a conversion that stops arriving ends the read that waits for it, with the same error, and lets the conversion go. It keeps its approval queue until it ends, since a page without text may turn up anywhere in it and the read of the file made for it may be authorized after the session is disposed; so an unread text of a PDF whose pages all have text holds that queue, beside its conversion, until it is cancelled or let go.

Every call one text makes to the vision model is made in one of its eight slots (`READ_AHEAD.calls` and `callSlots()` in `src/pdf-read-ahead.ts`), the lowest page's first, and holds it until its answer has ended, not through a pause. Each refusal halves the slots, never to under one, while the calls already made go on, and each answer gives one back. So a rendered scan and a PDF with text can have eight calls in flight, and stored pages four. A cancel, a failure or the idle minute gives all of them up, and what they had produced by then is still billed, as are the pages read ahead that the reader never reached. The slots are one text's, and `PDF_OCR_CALLS`, described below, sets their number in place of eight: nothing holds a deployment's texts to a number between them, so one long PDF, and several read at once more so, can take a large share of the model rate the deployment has. The service then refuses calls, this text's and any other's; a refused call pauses and is made again, as said above, so other reads slow down and go on, and a refusal fails a page only when it is one call's sixth on end. A deployment that has the rate to spare gives a text more slots with `PDF_OCR_CALLS`, which is what makes a long PDF quicker to read; one that cannot spare the rate eight calls take gives it fewer, or turns the reading off with `PDF_OCR`. A page's log lines are written when its work is done, which may be before the reader reaches it and not in page order; a failed page's when the reader reaches it. What a text asks for while it is read is counted against the subrequests of the one invocation that returned it, however long the reading takes: measured on the edge, the 10,001st request made while a Durable Object produces a stream it returned fails with `Too many subrequests by single Worker invocation`, whether it is a model call, a request to Google or a new call on a service binding, all in one count; a call on the open document's stub, as `renderPage` is, is not counted. A PDF of 2,000 closely written pages makes 16,000 model calls before any is made again, so this Worker's config raises the limit from the default 10,000 to 100,000 (`limits.subrequests`), which is every band of such a PDF asked three times, twice over.

The model reads an image at a fixed resolution whatever the scan's, so small print is where it errs: in testing on pages sent whole, as stored, it got 98 to 100% of a page's words right, and its misses were codes, numbers and names in 6 to 8 point type, which is why the types tell the agent a transcription is not the document's own text. Of pages sent as stored, one the model is stopped partway through ends with `[The transcription of this page was cut off.]`, a blank one has a heading and no text, and one that fails errors the stream. Thinking is turned off for the model: it tripled a page's tokens and time and held the text back, without reading a poor scan any better. Logs carry page counts, page and band numbers, sizes, encodings, status codes, reasons as one word and the renderer's memory and work as numbers, never text.

The gatekeeper's `AI` binding is what `readPdf()` converts with. It runs remotely, so start the dev server with `pnpm dev-server -- --use-workers-ai-binding` (which needs a Cloudflare login) to read PDFs locally; without the binding `readPdf()` says PDF reading is not available, and everything else works. When `CF_AI_GATEWAY` is set on this Worker, conversion goes through the AI Gateway it names, which must be in the Worker's own account; otherwise it calls Workers AI directly. Its `PDF_RENDERER` service binding is the `pdf-renderer` Worker, which `pnpm dev-server` runs beside it. A Worker that binds another is deployed after it, so a deploy of this one by hand needs the renderer deployed first (`pnpm --filter @gadgets/pdf-renderer run deploy`). Where the binding is absent, scanned PDFs are read from their page images as stored and a PDF with text is returned as its text alone.

A deployment can have no PDF page read by a vision model by setting `PDF_OCR` on this Worker to `false`. The value is read with surrounding spaces trimmed and in any case; unset, empty or anything else leaves the reading on. It is a variable like `GOOGLE_DRIVE_ACCESS`: whoever deploys sets it, it is not on the admin page and the deploy wizard does not ask for it, and `pnpm dev-server` passes it through from the shell or the root `.dev.vars`. Under `false`, `readPdf()` makes no billed model call and downloads no file a second time: a PDF without text returns `hasText: false`, `transcribed: false` and an empty `text`, a PDF with text returns that text alone, without the headings of the pages before its first with text, and no text has the idle minute or keeps an approval queue. The agent-facing types say that a deployment may have turned it off, so an agent that gets an empty text for a scan knows why.

`PDF_OCR_CALLS` on this Worker is how many calls to the vision model one text may have in flight, in place of eight: a whole number of at least 1 in decimal digits, read with surrounding spaces trimmed. Unset, empty or anything else leaves the eight. Like `PDF_OCR`, whoever deploys sets it: it is not on the admin page and the deploy wizard does not ask for it, and `pnpm dev-server` passes it through from the shell or the root `.dev.vars`.

A deployment can count the calls this Worker makes to the services behind it, by giving the Worker the `METRICS` Analytics Engine binding and setting `SUBSERVICE_METRICS` on it to `true`. The value is read with surrounding spaces trimmed and in any case; unset, empty or anything else counts nothing, as does a Worker without the binding, and then nothing else changes either. Neither is in this Worker's config, on the admin page or asked for by the deploy wizard, and `pnpm dev-server` passes neither through: a deployment adds both itself. What is written is the `subservice/v1` family of the metrics dataset, whose columns, limits and example queries are in the [observability README](../observability/README.md#subservice-calls). A point is a count under closed words, with an HTTP status, the service's numeric error code, bytes sent and milliseconds where there are any. Nothing of a document, a message or a request is recorded: no file name, file or message ID, URL, query, address, token, prompt, model output or error message. Counting never fails, delays or changes the call it counts.

For a PDF, `pdfToText()` sums what one text asks of Workers AI, of the renderer and of the file, and writes the sums once, when the text ends: read to its end, cancelled, failed, idle for its minute, or refused before it began. A call that was still in flight then is written when it ends, as a point of its own. The source of these points is the component of the text's log lines, `gatekeeper.google.drive.pdf` for a Drive file and `gatekeeper.google.gmail.pdf` for a Gmail attachment.

| Service | Operation | What is counted | Outcome, reason and detail |
|---|---|---|---|
| `workers-ai` | `to-markdown` | The conversion of the PDF to text, once a text. | `success` when it answered. `error` when it failed: with no reason before any text, and with reason `partway` after text of it had been given, which is then counted in place of the `success`. `bytes` is what was sent of the PDF. |
| `workers-ai` | `vision.page` | Each call to the vision model for a page image sent as stored, every attempt. | `success` when the answer ended, with detail `truncated` when the model was stopped at its output limit, and with detail `given-up` when the answer was let go after it began, which is billed all the same. `refused` with reason `capacity` (code 3040, under any status) or `rate` (HTTP 429 without that code). `error` with reason `http` (any other status, and an answer with no body), `network` (the request itself failed) or `stream` (the answer broke off or reported an error partway). It carries the status and the service's code when there is one, the image bytes sent, and the milliseconds to that end, which for an answer include any time it waited for its reader. |
| `workers-ai` | `vision.band` | The same for a band of a rendered page. | As `vision.page`. |
| `pdf-renderer` | `open` | Opening the PDF in the renderer, the first time. | `success`. `refused` with the renderer's word as the reason. `error` with reason `call` when the call threw. `bytes` is the file's size. |
| `pdf-renderer` | `reopen` | Opening it again, after the open document was lost. | As `open`, with why the document was lost as the detail: `call` when a `renderPage` threw, as it does when the call ran out of CPU time or the renderer's isolate went away, and `released` when the renderer had taken the document's room back. |
| `pdf-renderer` | `render-page` | Each `renderPage`. | `success`. `refused` with the renderer's word as the reason. `error` with reason `call` when it threw. |

The renderer's words are `RenderRefusalReason` in its `src/api.ts`: `start`, `released`, `file-size`, `size-mismatch`, `room`, `encrypted`, `unreadable`, `page-count`, `empty-work`, `page-size`, `page-load`, `image-pixels`, `steps`, `work`, `memory`, `abort`, `trap` and `render`. The renderer itself counts each document it lets go, as [its README](../pdf-renderer/README.md#metrics) says, and `reopen` by its detail beside that Worker's `cut-off` is how a deployment sees whether the renderer's CPU time is enough. The reads of the file a text makes, the second download and each page image's range, have their Google requests summed with the text's other calls, under the source and words given next: those made as the read begins, and those made only as its bytes are read (a Gmail attachment opened again partway). The download the conversion reads is made before the text exists, so its requests are written at once. A text that makes more than 48 kinds of call has the rest summed under the operation `other`, all but its conversion, which is always a `to-markdown` point of its own, and a word that is not one is written as `invalid`, as the observability README says.

Every request made through `fetchWithAuthRetry()` (`src/auth-retry.ts`), which is how the gatekeeper's clients call Google's APIs, is counted under the source `gatekeeper.google.api`: one point for each HTTP attempt, a retry and a request replayed with another token included, written at once unless a PDF's text is summing it. The service is taken from the URL's host, and for `www.googleapis.com` from the first segment of its path, by a closed table (`googleService()` in `src/call-metrics.ts`):

| Service | Requests to |
|---|---|
| `google-gmail` | `gmail.googleapis.com` |
| `google-drive` | `www.googleapis.com/drive`, and Drive's paths under `/batch` and `/upload` there |
| `google-calendar` | `www.googleapis.com/calendar` |
| `google-docs` | `docs.googleapis.com` |
| `google-sheets` | `sheets.googleapis.com` |
| `google-slides` | `slides.googleapis.com` |
| `google-chat` | `chat.googleapis.com` |
| `google-people` | `people.googleapis.com` |
| `google-bigquery` | `bigquery.googleapis.com` |
| `google-events` | `workspaceevents.googleapis.com` |
| `google-oauth` | `oauth2.googleapis.com` and `www.googleapis.com/oauth2` |
| `google-other` | any other URL |

Google's requests are counted by HTTP method, so the operation is `GET`, `POST`, `PATCH`, `PUT` or `DELETE`, except where a helper already names the request and passes the name on. Today only Google Chat's does, so a request to the Chat API made through it is `spaces.list`, `spaces.search`, `spaces.get`, `spaces.findDirectMessage`, `spaces.findGroupChats`, `spaces.setup`, `messages.list`, `messages.search`, `messages.get`, `messages.create`, `messages.patch`, `messages.delete`, `members.list`, `members.get`, `reactions.list`, `reactions.create` or `reactions.delete`. Every other request goes by its method: Gmail's, Drive's, Calendar's, BigQuery's, People's and Workspace Events', a Chat attachment's download, and those of Docs, Sheets and Slides, whose helpers name a request in words for an error message and not in one word. An attempt that was answered carries its status: below 400 it is `success`, a 429 is `refused` with reason `rate`, and any other status is `error` with reason `http`, a 401 or 403 that is then replayed with another token included. An attempt that threw is `error`, with reason `timeout` when its own time limit ran out or the caller's timed wait for an answer did, and with reason `network` otherwise. Each carries its milliseconds, from just before the request to its answer or failure; no body is read for it.

Some calls are not counted. A request that does not go through `fetchWithAuthRetry()` is not: the OAuth code exchange, the token refresh, the token revocation and the verified-email read at sign-in (all in `src/google-api.ts`), and the download of a Slides thumbnail's image. A Google request its caller gave up before an answer is not, unless what gave it up was the caller's own timeout, and then only an attempt that had been sent: one that would have begun after the timeout, following a retry's pause or a token's minting, is never sent and never counted. Of a PDF's calls, a model request that was given up, or broken off by its own image, before the service answered is not counted, since the service did not fail it; nor is an `open` or `reopen` that was ended from here, by the file's read failing or its page being given up; nor a conversion that the download's own failure ended before it answered. And the conversion of a PDF that is returned as its own text alone is written when that text is read to its end, fails or is cancelled: such a text has no idle minute, so one that is left unread writes nothing.

Every Drive session also offers `readFile(fileId, { offset, length })`, which streams the raw bytes of any in-scope file with content of its own (a CSV, image, PDF, Office file, anything uploaded) and returns its MIME type, size and modification time with them. With no range it reads the whole file, whatever its size; `offset` and `length` read one part of it, and the `length` returned says how many bytes the stream carries. `content` is a `ReadableStream` read from Drive as the caller reads it (RPC reads one chunk ahead of an idle caller and then waits), so a read costs the binding's Durable Object no memory that grows with the file: an agent passes the stream to a worktree's `writeBytes()`, which stores it as it arrives, or reads it itself. Nothing limits how many a binding has open at once: each holds a Drive download and that one chunk. What a read does cost is CPU, since every chunk passes through the gatekeeper's JavaScript; that grows with the file and has not been measured in production. A stream's download is let go when it is read to its end, fails or is cancelled, and after a minute with no bytes moving, whether Drive stopped sending them or the caller stopped reading, counted from when the stream is handed over, so a stalled download or a stream an agent drops unread is not held for good. A cancel that arrives while Drive has stalled is acted on only when that minute ends, because RPC delivers it after the read it is waiting on. Google Docs, Sheets and Slides are refused naming the method that opens them, as are folders, shortcuts and other `application/vnd.google-apps.*` types, which have no content to download, and a file whose `capabilities.canDownload` is false; each of these is refused after the file's metadata read is observed and before anything is downloaded. A call asks Drive for exactly its range (`Range: bytes=…`) and returns once Drive begins its answer, having read none of it: the read is checked and authorized on the answer's headers, and a refusal cancels the download. The wait for that answer to begin is timed as a whole and its body only between chunks, so a long file is not cut off while it is being read. An answer Drive gives from any other offset is refused, and a whole-file answer to a range from the start is cut to the range. Drive's download refusals are explained: `cannotDownloadFile` for a file whose owner or administrator restricted downloading it, and `cannotDownloadAbusiveFile` for one Google identified as malware or spam, which only its owner may download; the gatekeeper never sets `acknowledgeAbuse`. A file whose size changed since its metadata read fails the read, asking for it to be read again: before any byte is returned when the answer's headers show it (the size Drive's `Content-Range` reports, a `Content-Range` that ends before the range asked for, a whole-file answer's unencoded `Content-Length`, or a 416 for a range the file no longer has), and otherwise by failing the stream where the answer ends short of the range, which reaches the caller over RPC as a broken stream rather than with that message. A `Content-Range` whose total is unknown (`*`) gives no size to compare, so only an answer that ends short is caught then, and a file that grew is not. A folder binding re-proves the file is still a live direct child, or a shortcut target, once before asking Drive for the bytes and again once Drive has begun answering, before the stream is returned; that second read of its metadata also fails a read whose modification time moved, catching a rewrite that keeps the size. A file moved or rewritten after that, while its bytes are still being read, does not stop the stream. That rests on Drive answering a download from the one revision that was current when the answer began, which the gatekeeper does not check: were Drive to switch revision partway, a folder binding could return bytes written after the file left the folder, and any binding bytes that do not match the size and modification time returned with them. An account or exact-file binding does not detect a same-size rewrite, since a download cannot be pinned to the revision whose metadata was read. `readFile()` needs no `AI` binding, and like `readPdf()` asks an account connected before Drive bindings requested `drive.readonly` to reconnect.

On a read-only binding `openGoogleSlides()` returns a `GooglePresentationReadSession`: the same `getPresentation()`, `getSlides()`, and `getSlideThumbnail()` a directly bound presentation offers, read through the same code, but with no change methods and no queued changes to show. A read and write binding returns the editable session instead (see [Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)). A folder binding re-proves the presentation is a live direct child, or a shortcut target, before and after each read, the thumbnail render included, as it does for Docs and Sheets.

Every folder operation revalidates the selected root and the root-to-current path. A root carrying a `driveId` uses `corpora=drive`; other folders use `corpora=user`. That drive corpus requires membership of the shared drive, so a folder shared directly with a non-member connects and then fails every listing with `teamDriveMembershipRequired` — such a folder needs drive membership, not just folder access. Listing and search always carry a direct-parent predicate, so indexed content, descriptions, and OCR match only immediate children. `search()` accepts up to 50 `childFolderIds` to search inside named direct child folders instead of the positioned one: each is proved a listable direct child in a single batched check, revalidated on every page, and one request then covers them all, so polling many sibling folders no longer costs a request each. That request names every folder in one query, which is what the cap bounds, and every page reports every named folder as a subresource — so a page is refused while any collaborator checked under [the Workshop's policy](../../docs/observers.md#10-kernel-checked-subresources-per-observation) cannot list one of them, where opening folders individually keeps each disclosure independent. `openFolder()` appends one validated direct-child edge to a new capability without changing the parent capability.

A folder holds what its members put in it, and Drive puts a file or folder that lives elsewhere into a folder as a shortcut, so a folder binding's reads follow a shortcut among the positioned folder's direct children to its target. `getEntry()`, `readFile()`, `readPdf()`, the native opens and `openFolder()` take the target's ID: a file that is not a direct child is accepted when a listing of the positioned folder's shortcuts (in its corpus; Drive cannot search by a shortcut's target) finds a live shortcut to it that is a live direct child, proved again around every read as a direct child is. A folder opened that way records the shortcut on its edge of the saved path, which every later read re-proves in its batch, and lists in its own drive's corpus. A shortcut to a shortcut cannot exist, and a path can name a folder once, so a cycle of shortcuts ends at the first repeat. A read through a shortcut reports what any read reports, the positioned folder and the target, so a collaborator is checked against the target with their own account, wherever it lives. Writes do not follow shortcuts: comment, sharing and move targets stay direct children, a write in a folder opened through a shortcut is refused before it is queued, and an edit's or any write's proof at approval runs along the plain saved path, which neither a shortcut's target nor such a folder satisfies. Whoever can add to the bound folder can therefore widen what it reads to anything the connected account can read, as sharing that folder with them already intends.

Account, folder, and exact-file Drive bindings request `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, and `presentations.readonly`. A `drive` grant the account already holds covers those requirements, and so does `presentations` for `presentations.readonly`, but no Drive resource's own scopes include `drive`: only the Drive writes grant's do, which a consent for any of them also asks for, and declining it leaves the Drive resources granted. When a Drive resource gains a scope, an account connected before it reads that resource as ungranted unless a scope it already holds covers the new one, and the Workshop prompts the user to expand it. So `presentations.readonly` re-prompts every Drive connection made before Drive-native Slides that holds none of `presentations`, `drive.readonly`, or `drive`, and `drive.readonly`, which replaced `drive.metadata.readonly` so PDFs can be read, re-prompts every Drive connection that holds neither it nor `drive`. Until such an account re-consents, its existing Drive bindings keep listing and reading Docs and Sheets, `openGoogleSlides()` still opens a presentation but every read from it fails with Google's insufficient-scope 403, `readPdf()`, `readFile()` and a comment listing fail asking the user to reconnect, and that account cannot be admitted as a collaborator on a Drive binding, since admission requires a current Drive grant. A re-consent reaches open bindings without restarting them, since a 403 makes the token cache reload the stored token.

Drive reads report what they depend on as subresources, which the Workshop checks collaborators against (see [docs/observers.md](../../docs/observers.md) §10): `drive/file/<fileId>` for each file whose metadata a read returns, `drive/content/<fileId>` for each file whose PDF text or bytes it returns, and `drive/folder/<folderId>` for each folder it lists. A folder operation reports its positioned folder plus each disclosed direct child. `readPdf()` and `readFile()` report the file's content rather than the file alone (on a folder binding, with the folder and the file as well) because an owner or administrator can stop viewers downloading a file they can still see: a collaborator passes a content subresource only if their own account may download the file (`capabilities.canDownload`). PDF text read before content subresources existed was reported as `drive/file/<fileId>`, so a workspace that read it still admits a collaborator who can see that PDF but not download it. A Doc, Sheet or Slides presentation read through Drive reports it as a bound one does, as `docs/document/<documentId>`, `sheets/spreadsheet/<spreadsheetId>` or `slides/presentation/<presentationId>` (on a folder binding, with the folder and the file it was found in), since Google shares each of these as a whole: no tab, worksheet or slide has permissions of its own. A collaborator passes a file, its content or a folder only with their own explicit Drive resource consent and a batched metadata read, which a folder passes only if it is still a live folder they can list, and content only if they may download the file; a native file only if its API opens it for them. A file's comments are reported as the file: a comment listing reports `drive/file/<fileId>` (and, on a folder binding, the folder) on every page, an empty one included, and nothing of its own, and a page showing a comment that quotes the Doc while it still awaits approval reports the document too. So a collaborator who can open a file sees its comments in a shared chat or gadget, including a collaborator who can only view the file, to whom Google itself shows none. A comment write reports the same file (and folder) before it is queued, and the document as well when it quotes one, and adds no requirement of its own. A file's sharing is reported as the file too: a sharing call (`listAccess()`, `share()`, `updateAccess()`, `unshare()`) reports `drive/file/<fileId>` (and, on a folder binding, the folder) and nothing of its own, before it returns or queues anything. So a collaborator who can open a file sees who it is shared with in a shared chat or gadget, addresses and roles included: what a listing returned, and the grantee an approval names. Google itself withholds that from an account that cannot share the file, which it refuses the file's permission list. That the connected account can share the file is a check of that account alone, as the check that it can comment is, and adds no requirement. A move reports the file and the folder it goes into, as files (and, on a folder binding, the positioned folder), and nothing about who has access. An account binding does not report the folder the file leaves, whose ID is the file's own metadata, and neither binding reports the connected account's own My Drive root as the folder a file goes into, which no other account can see: either would be a requirement a collaborator could never pass for a file at the top level of My Drive, or moved to it. A sharing call refuses that root as its target, for the same reason, before it reports anything. A requirement governs what a call discloses, not who may approve: a collaborator with the build role may approve any pending action, a sharing change or a move among them. These answers can come from the collaborator's account cache: it reuses an allowed answer for up to 15 minutes and a denial for up to 15 seconds. Before a collaborator opens the workspace, the gatekeeper still requires that Drive consent and rechecks, uncached, the bound folder or file and any units remembered before reads reported subresources. It also still refuses a binding that an earlier release closed to collaborators after an owner-relative read, since that read recorded nothing to check them against. Hidden rejected candidates are not disclosed or reported.

A read whose answer is relative to the connected account rather than to a file — an account binding's search with no match, a folder it can't list, a file it can't see, a file it can't comment on, when a comment listing or a comment write is refused for that, a file it can't share, whose sharing is then neither read nor changed, the top level of its own My Drive named as a sharing target, or a move it isn't allowed to make — reports no subresources, so it restricts no collaborator. A comment or sharing call refused for a file the account can't comment on or share has already reported the file (and, on a folder binding, the folder) when it checked that the file is in the binding's scope, and the refusal adds nothing to that. A folder binding's search reports its positioned folder, and any child folders it names, even when nothing matches. Invisible-file 403 and 404 probes on an account binding both report `[]` and return the same generic unavailable-file error, without Google's per-file reason. They therefore cannot leave an unsatisfiable sharing requirement. Account-wide failures still propagate unchanged. Missing OAuth scopes (`insufficientPermissions`) also propagate unchanged without recording a file-access observation, for both account and folder bindings. An empty search returns an empty result.

### Drive comments

Every Drive session offers `listComments(fileId)` on any in-scope file (for a folder binding, a live direct child; comments do not follow shortcuts). Reading comments is an observation, recorded after the file's own, and it reports what reading the file reports and nothing of its own: the file, on a folder binding the folder too, and the document on a page showing a comment that quotes it while it still awaits approval. So whoever can open the file, and on a folder binding list its folder, may see its comments in a shared chat or gadget, a collaborator who can only view the file included, to whom Google itself shows none. The connected account is another matter. Google shows a file's comments only to accounts that can comment on it, and answers the listing of an account that can only view the file with an empty list and no error, which would read as a file without comments. So before it lists, the binding checks that the connected account can comment on the file, and refuses, saying why, a file it can only view. That check is of the connected account alone: its refusal reports nothing, and it adds no requirement for collaborators. A listing is read with the Drive resources' `drive.readonly`; on an account connected before they requested it, the listing fails asking the user to reconnect, as `readPdf()` does. A comment lists with its text, its replies, its times as `Date`s and, when Drive reports one, `quotedText`, the passage of the file it is attached to, as text.

A read and write binding adds `comment(fileId, text, { quote?, tabId? })`, `suggestEdit(fileId, oldText, newText, { note?, tabId? })`, `reply(fileId, commentId, text)` and `resolve(fileId, commentId, text?)`. Every write is queued for approval and returns the pending item; `listComments()` shows the binding's own undecided writes marked `pending`, a reply or resolve under the comment it answers. A suggested edit returns a `DocSuggestion` instead, which no listing shows, queued or made: Drive lists no suggestion. The action kind is **Drive comments**, which is off for auto-approval until the user turns it on, and every comment write is auto-approvable under it. Google emails a comment's or a reply's text to each person it mentions, an address written after `@` or `+`, whether or not that person can open the file. The gatekeeper does not look for mentions, so with the kind's rule on such a write is posted without asking, like any other comment: the `write-gatekeeper` skill's auto-approval policy lists it as an exception to its rule against sending content as the user to people outside the bound resource. A pending item's `pending:<n>` ID names it only until the write is decided, and a reply to, or resolve of, a `pending:` ID is refused: as still waiting while its comment is, and otherwise as naming no waiting comment, with a pointer to list the file's comments for the Drive ID. A comment's `resolved` is Drive's own state, so a queued resolve shows as a pending reply and not as a resolved comment. A second resolve of a comment that has one queued is refused, and so is a reply to it, which would reopen the comment once the resolve is applied: a closing reply is the resolve's own text, so a resolve already queued gets one by being rejected and queued again with it. The refusal looks at what waits when the call is made: of two calls made at once both can queue, and the one approved second fails its check at approval. A write is refused on a read-only binding, and on one whose account does not hold the Drive writes grant, when it is queued and again when it is approved. Approved on a read-only binding it fails; approved while the account does not hold the grant it stays pending, and an approval made once the account allows changes posts it. A binding whose Google account was disconnected records no grant either, but allowing changes cannot restore it, so its writes fail as its reads do, saying that the connection has to be made again. Both times the gatekeeper also checks that the file is still in the binding's scope (a folder binding re-proves each folder from the bound root down to the file), that the connected account can comment on it, and, for a reply or resolve, that the comment still exists and that its text is what it was when the write was queued, anywhere in it: one edited since fails, to be queued again. Before it is queued a write reports the file, as a listing does, and the document when it quotes one; that the account can comment is a check, not a report, and a refusal for it reports nothing. A write is refused on a folder, which takes no comments: Drive reports that a folder can be commented on and then answers the comment with a server error, every time. An approval shows what is posted first, then the file, by its ID and by the name it had when the write was queued. One of a reply or resolve shows the comment it answers and its author as fields, which are displayed as written and never as Markdown, since anyone who can comment on the file wrote them; it shows the comment whole, or the first 200 characters of a longer one, which it then says. A reply to a comment resolved since it was queued is refused rather than reopening the comment its approval said nothing about. Google emails the file's owner about new comments.

Comments are plain text. Drive cannot attach one to text in the file: Docs lists a comment made through Drive under "Original content deleted", with or without an anchor. So a comment with a `quote` is made through the Docs API instead, attached to the quoted text as one made in the editor is, and `suggestEdit` makes a real suggestion, sent in the Docs API's `SUGGEST` write mode as one delete and insert, which someone who can edit the Doc accepts or rejects there; a commenter may make one. Its `note` is posted as a reply on the suggestion once it is made. Both work only on native Google Docs, read through the Docs API as a content observation, and the quoted text must occur exactly once in the chosen tab (by default, the first) when the write is queued and again when it is approved, when the Doc is read again and the write is sent on the revision that read saw: if the text no longer occurs exactly once the write fails, and if the Doc changed in between it is refused and the next approval places it on the Doc as it is then. When the write is queued the text is looked for in the connection's stored copy of the Doc (see [Editing Docs, Sheets and Slides](#editing-docs-sheets-and-slides)), a run at a time: the copy fetched or confirmed in the last 10 seconds, where a read of it through the connection was allowed, and otherwise the Doc fetched then, which is kept as the connection's copy once the scope check of that read has passed, whether or not the text was found. So text someone else added in those 10 seconds is not found until the copy is fetched again. At approval the Doc is fetched as a write is based on it, with suggestions inline, and the quoted text is found in that answer an element at a time, each element let go as it is read; nothing of that answer is stored. A Doc the connection cannot keep a copy of (one paragraph or table too large for a stored row, see [Known limitations](#known-limitations)) can be commented on without a quote, replied to and resolved; a quote or a suggestion on it is refused with the error a read of it gives, no read of its content is reported and nothing is queued. Drive lists a comment made through Docs under the same ID, so replies, resolves and the check before a retry stay on Drive; a retry of a suggestion looks for the account's suggestion from around the earlier send by Google's summary of it, and fails as of unknown outcome when it cannot tell. Docs makes no comment that is attached to nothing, so a comment without a quote is still made through Drive. Google limits a comment to 4096 bytes of UTF-8 through Drive and 2048 through Docs, which also limits a suggestion's note, checked on the exact text that is sent; a quote or `oldText` is capped at 500 characters, `newText` at 1000 characters without line breaks, and empty text is refused, but for an empty `newText`, which suggests deleting `oldText`. A `newText` with a character Google Docs drops from inserted text (a control character or a private-use code point) is refused rather than stripped, so the approval shows exactly what the Doc gets, and so is an `oldText` that runs across an element that reads as no text, such as a dropdown or a horizontal line, which the suggestion would delete unseen. Replying to a resolved comment reopens it, as Google does; resolving a resolved comment is refused, although Google would add another resolve.

Drive takes no idempotency key for a comment, and an error response does not prove nothing was posted. So a send leaves a marker first; an approval that finds one looks for what was posted, by the connected account and with exactly the same text, before it sends again. The marker stays until the write is settled, and records what a send Google confirmed posted (for a suggested edit, once its note is posted too), so an approval repeated after such a send, when the action could not be recorded as applied, binds it without looking or sending again, even if it was edited since. A write whose send Drive did not confirm is still undecided, and nothing looks for what that send posted until it is approved again or rejected: until then a listing shows a comment or reply the send did post twice, as Drive has it and as the `pending` item. Two identical matches end the action as unknown rather than guess which one it posted, and so does a file or comment that Drive has stopped showing the account. So does a look that finds nothing once the connected account can no longer comment on the file: Google lists an account that can only view a file none of its comments, its own included, with no error, so nothing found proves nothing, and the write is not sent again. A send Google refuses outright, for a missing permission, a missing Drive scope or a rate limit, is taken to have posted nothing: one refused for a rate limit or for the scope is sent again by the next approval, and any other fails for good. A send Drive leaves unconfirmed, and that a look made after its window finds to have posted nothing, is sent again by that approval, at most twice: a write whose third send is also found to have posted nothing fails for good rather than being sent a fourth time. A look Google refuses for a missing Drive scope decides nothing: the write stays pending with its marker, and the next approval looks again. A queued write is posted as, and a lost send is looked for among the comments of, whichever Google account the connection holds when it is approved, so reconnecting as another Google account between a send and its retry can post the comment twice. Rejecting a write withdraws it, as for every action, from whatever state approving left it in: waiting, failed for good, or of unknown outcome. A comment an unsettled send already posted stays on the file, and the next listing shows it as an ordinary comment.

### Moving and sharing

A read and write binding can see and change who a file or folder is shared with: `listAccess(fileId)` lists who has access, `share(fileId, grantee, role, options?)` gives access to a person or a Google Group by address, to a whole Google Workspace domain, or to anyone who has the link, `updateAccess(fileId, access, role)` changes a role, and `unshare(fileId, access)` removes access, where `access` is an entry's ID or the grantee who has it. An account binding takes any file or folder the account can share, a file binding its own file, and a folder binding a live direct child of the positioned folder or the positioned folder itself. A folder binding proves that again once the permissions are read, as after its other reads of a child: a file moved out of the folder meanwhile lists the sharing of the folder it went to, so the call is refused before anything from that list is returned, said in a refusal or queued. Roles that can be given are `reader`, `commenter` and `writer`; ownership is never transferred, access given here has no expiry, and a shared drive's own root is refused by all four, the listing included, since sharing it is membership of the drive: its members are read as inherited access on any file or folder in the drive. The top level of the connected account's own My Drive is refused by all four as well. The connected account has to be able to share a file for its sharing to be read or changed here; Google refuses the permission list of a file to an account that cannot, and the binding refuses first, saying so. That is a check of the connected account alone: its refusal reports nothing, and it adds no requirement for collaborators, who see a file's sharing in a shared chat or gadget whenever they can open the file. Whether a domain's or a link's access can be found by searching is set when the access is given: `updateAccess()` changes a role and nothing else, so changing it takes removing the access and, once that is approved, giving it again. An owner's and a shared drive manager's access cannot be changed, nor a shared drive's membership at any role, which is read as inherited whatever flag Drive gives it, nor the connected account's own user permission, which a listing marks `me`; access the account has only through a group, a domain or a link is not protected that way. A grantee or an options object with a key the types do not have is refused, since gadget code is not type-checked and a share asked for with an expiry must not be queued as one without; access named by an entry itself, or by a bare address, is refused with what does name it.

Drive lists one permission per grantee with one detail per source, and `listAccess()` returns one entry per detail, so someone with access from a parent folder and access given on the file itself is two entries with one ID, the first marked `inherited`. Each entry has its own detail's role and, inside a shared drive, the ID of the folder or drive it comes from. Only access given on the file itself can be changed here. Google does not let inherited access be lowered or removed on a child, and drops the part given on the file only when its role is set to exactly the inherited one, so `unshare()` of access that sits on top of a parent's is sent as that update, and the approval says the parent's access stays. `share()` refuses a grantee who already has access on the file, and one a parent already gives as much: Google's own create would raise a lower role and ignore an equal or higher one without saying which it did. A grantee is matched to an existing permission by address whether it was given as a person or as a group. Google decides which an address is: a person's address shared as a group's is recorded, and from then on listed, as that person's. Anyone's access is one permission, which Drive lists under the ID `anyoneWithLink` or, when it can be found by searching, `anyone`; either ID names it here, whichever it is listed under.

Sharing a folder shares what it holds, and it changes access the same grantee already had inside it: a grant on a file or folder in it, at the role the folder is shared at or a lower one, is merged into the folder's, for good. Removing the folder's access later leaves that grantee with nothing on it, which is less than before the folder was shared. A raised role on a folder does the same. The approval of a share, of a raise and of a removal on a folder each say so.

An account or folder binding can also move a file or folder with `move(fileId, folderId)`. An account binding moves anything it can see that the connected account can move within its drive, that is not in the trash and that sits in exactly one folder it can see, into any folder the account can add to in the same drive: one shared drive, or outside every shared drive. A destination is named by its ID, and the top level of the account's own My Drive also by Drive's alias `root`, which is resolved to that folder's ID before anything is reported or queued; the alias is accepted nowhere else. A folder binding moves a live direct child of the positioned folder into a live direct child folder, or up into the folder the session was opened from, which `getScope()` reports as `parentFolderId`; the session of the connected folder itself reports none, so nothing leaves the connected folder and nothing enters it from outside. There too the connected account has to be able to move the file within its drive and to add to the folder it goes into. So a move between two folders takes a binding to a folder that holds both, one level per move, or an all-of-Drive binding, which makes it in one. A file binding cannot move its file. Nothing here creates a folder, so a file is moved only into one that exists. A move is sent with both `addParents` and `removeParents`: alone, the first moves a file out of wherever it is and the second drops it into the My Drive root. Google itself moves a file that is in the trash, and moves a file into a folder that is. Neither is done here, since the first stays in the trash and the second leaves a live file in a folder no listing shows: an account binding refuses each in words of its own, and a folder binding treats whatever is in the trash as outside it. What a folder put in the trash holds can go on reading as live for a few seconds, and a file moved out then stays in the trash in its new folder, so a move is also refused when the folder the file is in reads as in the trash. One case is known not to be caught: when the folder that was put in the trash is further up, the file and its folder both read as live for those seconds, and a move of the file goes through and leaves it in the trash in its new folder.

Every one of these is queued for approval, under the kinds **Drive sharing** and **Drive moves**. Neither can be auto-approved: each changes who has access, and a move does so without naming anyone, since a file takes the sharing of the folder it is in. The file gains the access of its new folder at once and loses what came from the old one, and access given on the file itself that the new folder also gives is merged into the folder's and does not come back when the file leaves. Because the Workshop applies a connection's auto-approved actions in order and stops at the first that needs a person, a comment set to apply without asking waits behind an undecided sharing change or move on the same connection, and behind one Google refused until that is rejected.

An approval names the file and its ID, and for a share the grantee, the role and whether Google emails them, with the message. A share with anyone who has the link, with a whole domain, or with an address outside the connected account's own domain says so first, at the start of its title and as the first sentence of its text, in bold, because two approval surfaces offer Approve on a collapsed row of a title and two lines of text; so does a role that is raised for any of them. A share that can be found by searching, public or with a domain, and a domain other than the account's own, each begin their title differently from the plain case. The role given is in the first paragraph, and a role change names both roles before the file's ID. "Outside" compares the mail domain of the address with that of the connected account and nothing else. It is not said for an account at `gmail.com` or `googlemail.com`, a personal account with no organization; a personal account registered under another provider's address is compared like any other, by that provider's domain. A grantee whose address Drive does not show is never passed as inside: a raise of their role says first that the address is not shown. Where Drive gives the connected account no address of its own, nothing can be compared, and a share with a person or a group, or a raise of one's role, says that first instead. A role change and a removal say whether the access is a person's, a group's, a domain's or the link's, as Drive lists it, since an address given as a person's may be a group's. A share names the kind the caller gave: "a person" is held to when it is applied, and "a group" is the wider reading of an address that may be one person's. A move's approval opens by saying that moving changes who has access, then names the file and the folder it goes into and gives both folders' IDs; it does not list who has access to either folder. Names, addresses and messages are shown as fields, never as Markdown.

A sharing change shows in `listAccess()` as soon as it is queued: access being given is one more entry with a `pending:<n>` ID, a role being changed shows its new role, both marked `pending`, and access being removed is left out. Calls made one after another leave at most one change of one access waiting (of two made at once both can queue, and the one approved second fails its check at approval), and one that still waits is neither changed nor removed from the session: the user withdraws it by rejecting it, and the refusal for access that is still waiting to be given says so, since approving a share in order to remove it would make a file public, or email a grantee, in between. A move is not simulated: its action asks the Workshop to pause the agent's turn until it is decided, and every read shows the file where it is until it has moved, because showing it elsewhere would mean accepting as a folder's child a file that is not one yet, in the code that keeps a folder binding inside its folder. A gadget is not paused, and no read tells it a move that still waits from one that was rejected. On a folder binding a write names the path of folders its file is under, so a comment, a sharing change or a move is refused while a move waits for the same file or for a folder on that path, and a move into a folder while that folder's own move waits; one queued before the move fails as out of scope if the move is approved ahead of it. A sharing change or a move whose approval ended before it was settled still waits, for these refusals and for those of a second change of one access or a second move of one file, since the next approval takes it up; a listing does not show it as pending meanwhile. A session opened at a folder that has since moved answers that everything is outside the binding: the folder is opened again from where it now is. What a file inherits is Google's to show, and it lags: after a folder's sharing changes, what the folder holds lists the new access some seconds later, and goes on listing access that was removed as long (up to five seconds when it was measured), and what a moved folder holds lists its new folder's access about two seconds after the move.

The gatekeeper does not check an organization's sharing rules: Google enforces them when an approved change is sent. A refusal fails the action with a message built from the HTTP status and Google's reason code alone, which it ends with, as in "Your organization does not allow sharing this outside the organization. [http=403 reason=shareOutNotPermitted]"; a reason it has no words for is reported as refused with its code. Google's own message is never read or logged, since it can quote an address.

At approval the gatekeeper checks again that the binding is read and write, that the account holds the writes grant, that the file (and, for a move, both folders) is still in the binding's scope, which a folder binding proves once more after a sharing change's read of the file's permissions, and again before the second request of a removal that takes two, that the account can still share or move it, and that what the approval described still holds: the grantee's access, the role being changed, whether a domain's or a link's access can be found by searching, the folder the file is in, and that none of a file to be moved, the folder it is in and the folder it goes into is in the trash. A link's access is looked up as the link, not by the ID it had: Drive changes that ID when the link is made searchable or made to open from its URL only, and a change approved for one form is not made to the other. A share Google records as a group's where the approval said a person, or answers as found by searching where the approval said it was not, ends as an unknown outcome that says so; a person recorded where the approval said a group is applied, since it reaches no more than was approved. A share Google answers at another role than the approval's changed nothing, since Google's create only raises a role, and fails saying the grantee's access changed; one that was to be found by searching ends as an unknown outcome instead, since the create may have made the access found by searching all the same. A role change whose own answer shows another role, or access found by searching otherwise than the approval said, ends as an unknown outcome too. A removal of access a parent also gives at a lower role is sent as an update to the parent's role, followed by a delete when Google's answer still shows a role on the file, and is never sent as an update that could raise the grant. A sharing change or a move is also staged under the Google account that queued it, by its Drive permission ID, and fails if another Google account is connected when it is approved; comments are not. The account is asked of Drive with the credentials installed at that moment: a connection keeps its access token until it nears expiry and a reconnect does not revoke the earlier one, so the gatekeeper loads the token the account stores before each such read, and a connection switched to another Google account is seen as that account at once. An approval's identity read starts from that token and may refresh it, as a token Google stopped accepting before its recorded expiry needs; everything after the read, the checks and the change, is sent under the token the read was answered under. So a reconnect as another account that lands during an approval changes nothing of it: the change is made as the account that was read, or not at all, and a request Google refuses after the read is never sent again under other credentials. Nothing refreshes the token after the read, so if Google stops accepting it before the change is sent, the write stays pending and the next approval starts afresh. A send leaves a marker first, as a comment's does, and an approval that finds one reads the file's sharing or parents before it sends again: the change already there is taken as made, the state the approval described is sent again, and anything else ends the action as unknown. A send Google answers with 400 `invalidParameter` is not taken for a refusal: Google gives that answer to a response mask it does not accept after making the change, so the write stays pending and the next approval looks. An approval that finds a marker while another Google account is connected than the one that queued the write does neither: it leaves the write as it is and says to reconnect as that account, or to check the file and reject. Each of these calls can be repeated at Google without a second effect, so a repeated send can at most repeat Google's notification email.

No revert is offered: nothing in the Workshop calls a gatekeeper's `revertAction()`, so each approval's card carries `implementsRevert: false`, nothing is kept of an applied change, and `revertAction()` refuses. A change is undone by a second one, with its own approval: `unshare()` of what was shared, `updateAccess()` back to the role there was, `share()` again of what was removed, `move()` back. Three things no second change puts back: access that was given on a file itself and that a folder it was moved into also gave, which Google merges into the folder's and drops when the file leaves; access someone had inside a folder at or below a role the folder was then shared with them at, or raised to, which Google merges the same way and drops when the folder's access is removed; and an email Google sent.

Logs carry action and file IDs, statuses and reason codes: never an address, a domain, a name, a message, a role or a permission ID, which for a person is their Google ID.

What rests on Google's documentation and not on a live check: everything about shared drives (their `organizer` and `fileOrganizer` roles, access inherited from membership, their move rules), the reason codes of an administrator's refusals and of three other refusals (`abusiveContentRestriction`, `sharingRateLimitExceeded` and `storageQuotaExceeded`), whether an editor who can share a file is shown all of its sharing, what an editor or a commenter who cannot share a file is shown of its sharing, what a move needs of a file the connected account does not own or of a folder it does not own, whether a folder put in the trash reads as in the trash at once, on which the refusal of a move out of it rests, whether Drive withholds other grantees' addresses from an account outside a file's organization, sharing with a group and what Google does with a group's address given as a person's, what Google's email holds and that an address with no Google account is shared with once it is emailed, that a role change leaves an expiry date in place, whether a domain's access keeps its ID when it is made searchable, how a permission that belongs to a view of a file or folder, or to an account that was deleted, is listed, what Google answers a token that holds no Drive scope at all, whether an access token issued before a later consent still answers for its account (the stored token is loaded before each identity read so that nothing depends on it), and which address Drive gives a Workspace account as its own, against which "outside" is judged.

### Editing Docs, Sheets and Slides

A read and write binding opens a native Google Doc, Sheet or Slides presentation as the editable session one connected on its own has: `openGoogleDoc()` returns a `GoogleDocEditSession`, `openGoogleSheet()` a `GoogleSpreadsheetSession` and `openGoogleSlides()` a `GooglePresentationSession`, and a read-only binding returns the read sessions, with no write method at all, which code learns before it calls one from `getScope().access`. Every binding scope does: all of Drive, a folder (a live direct child of the positioned folder) and a single file. The changes are the editor's own: they are simulated, described, queued, ordered and applied as on the file's own connection (see [Google Docs edits](#google-docs-edits), [Google Sheets edits](#google-sheets-edits) and [Google Slides edits](#google-slides-edits)), under the same action kinds, so a user enables a rule for them on the Drive connection under the same names. A rule is kept per connection, so a rule enabled on a file's own connection does not cover changes made to it through Drive, and a rule enabled on a Drive connection covers every file of that kind the connection reaches, which its label says ("Table changes, in any Doc this connection reaches"). That is so for every kind a user may let apply without asking, those that delete included: a Doc's "Table changes", which also deletes tables, rows and columns, a spreadsheet's "Spreadsheet changes that delete sheets, rows, columns or merged cells' values", and a presentation's "Slide changes that delete elements, table rows or columns" and "Deleting slides". The card names the file first, by ID and by the name it had when the session opened it. An exact-file binding lists only the kinds of its own file's editor, as its `describe()` last read the file.

Each change is one record in the binding's one journal, beside its comments, sharing changes and moves, and its payload names the file. Changes to one file are prepared one at a time and apply in the order they were queued; a change to another file does not hold them back, and an approval out of order is refused with "Approve or reject the earlier change to this file first". When a change is queued, and again when it is approved, the binding proves before anything else that it may still make changes (its access, the account's writes grant and `GOOGLE_DRIVE_ACCESS`) and that the file is still in its scope, still of its kind, not in the trash, and editable by the connected account. A missing grant or a deployment kept read-only leaves the change pending; anything else about the file fails it for good, without a request to the file's own API. Changing a file through Drive needs the same Drive writes grant as a comment. Disabling the Google Doc, Sheets or Slides resource type on the admin page does not stop it, just as it does not stop a Drive binding reading the file; `GOOGLE_DRIVE_ACCESS` does.

A Doc opened that way is a `GoogleDocEditSession`: a directly bound Doc's `GoogleDocSession` without its comment methods, since the binding's own `comment()`, `suggestEdit()`, `reply()` and `resolve()` reach the file, and without `addTab()`: a Drive binding adds no tabs. It has `replaceText()`, `appendText()` and the eleven table methods (see [Google Docs edits](#google-docs-edits)). One Doc change, with what its card is built from (the text of the tab that a replacement's card shows around it, how new text will read where that is not as it was typed, a table change's card), has to fit in 100 KiB by the editors' estimate (two bytes for every character of it as JSON), about 50,000 characters, where a Doc's own connection takes 1 MiB of Markdown in a text edit and 1 MiB in a table change with its table: every read of the binding's one journal loads every edit it holds, for any file. Split a larger append or replacement into several calls: a change over the limit is refused, and nothing is queued. A change to a table that exists records the table as it read, without its look, so through Drive a table whose HTML is past about 50,000 characters cannot be changed at all, not even a column's width, and one past about 25,000 cannot be deleted with `deleteTable()`, whose card shows the table as well; `insertTable()` records no table and is held only by its own cells.

A Doc's reads do not wait on its approvals, as on its own connection; the receipt of a write that landed (`driveDocs:receipt:<id>`) and a count of the writes landed keep a read from showing an edit twice while its approval completes, and the write's marker is deleted, and the edits behind it replayed over the new revision, only once the edit's record is retired. An edit that no longer replays is failed in the journal, with the reason, where a Doc's own connection marks it in its record. The read that prepares a Doc edit through Drive is authorized, as a spreadsheet's and a presentation's are, so the approval card's file is recorded for the chat that queued it, and that read is also the one of the position `insertTable()` returns; a Doc's own connection authorizes a read only when the edit is refused, and for that position.

A Doc opened through Drive keeps its copy of the document (see [Google Docs edits](#google-docs-edits)) in its Drive connection's storage, by file ID, as a Doc's own connection stores it: one copy of a document, shared by the sessions the connection opens on it, and stored only once the scope check of the read that fetched it has passed; where that storage is, and what removes a copy from it, is under [What a Drive connection keeps of the Docs it reads](#what-a-drive-connection-keeps-of-the-docs-it-reads). Which copy a read approved is held in the connection's memory: for the four documents opened most recently on a read and write connection, and by each session of a read-only one. A copy is reused only after a read that used it passed the connection's whole scope check, and not once a write has landed in the document or an edit was queued for it since the copy was fetched; so a revision fetched while the file was outside the connection's scope is never stored and never reaches a later read. Three things cost more than on a Doc's own connection. A read that fetches a document stores and renders twice what the stored copy does not hold of it, which at a first read is the whole document, and decodes every run of the fetched document twice, changed or not (see [Google Docs request costs](#google-docs-request-costs)). The first read of a document after the connection's Durable Object is evicted fetches it whole, where a Doc's own connection reads its stored copy and checks only its revision. And a Drive connection replays nothing at a rejection: rejecting, through Drive, a change to a table's structure (a table, rows or columns added or deleted, cells merged or split) or a replacement of text in its cells fails the changes to existing tables queued behind it in that tab, a change to a table's look among them, where a directly bound Doc replays them over its stored copy and keeps those that still apply. Rejecting a paragraph edit, an append or a change to a table's look fails nothing: the changes behind it stay queued, as a new table and a text edit do behind any rejection, and the next replay of their tab judges them. A structure or cell-text change that fails when it is approved, or that an approval refuses for good because of the file (see above), fails the changes to existing tables behind it in the same way, so that none is approved later over a table that change never reached.

A spreadsheet's marker list and the numbers of its applied changes, which its own connection keeps for its one file, are kept per spreadsheet (`driveSheets:file:<id>`), so a lost write to one spreadsheet holds back only that spreadsheet's later changes. Each spreadsheet's state also notes the numbers queued for it, and a new session drops the state of a spreadsheet the journal holds none of and none of whose markers can still land, keeping the 20 written most recently. Two connections that reach one spreadsheet do not see each other's markers, as is already so for two connections to it of any kind. A read of a spreadsheet's ranges or formats made while changes to its rows, columns or sheets are queued goes through an endpoint that needs a grant that may edit it, so such a read fails once the account no longer holds the writes grant, until the grant returns or those changes are decided.

### What a Drive connection keeps of the Docs it reads

A Drive connection keeps one copy of each Google Doc that a session of it read and that the
read's scope check allowed, by file ID, in the connection's own storage. A read-only connection
stores under the same rules. A copy is the document as Google sent it, less the fields the
gatekeeper does not keep, cut into runs; each run's rendering; and what the file's queued edits
made of it (see [Google Docs edits](#google-docs-edits) for the rows).

That storage is a SQLite database of the connection's own. A Drive connection's Durable Object
is a facet of its workspace's Durable Object: it runs the Google gatekeeper's code, and its
database is stored with its workspace's object and is read and written only by the Google
gatekeeper's code. The kernel's code never reads a copy.

Removing the connection from its workspace deletes that storage with every copy in it: the
kernel deletes the connection's facet, and with it the facet's database. Disconnecting or
revoking the Google account does not. That deletes the account's own storage, and a connection
of the account keeps its copies until it is removed from its workspace, or until it is used
again and the limits below remove them. Its requests to Google fail at the token, so a read
is answered from such a copy only inside the copy's ten seconds of freshness, and only on a
connection of one file or of the whole account, whose reads ask Drive nothing first.

The copy is a cache. It saves round trips to Google and CPU (a read with a fresh copy fetches
nothing, and an approval sends the batch that was previewed), and it lets a request hold a piece
of a document in place of the document. Nothing depends on its staying: a copy removed costs the
file's next allowed read one `documents.get` and its queued edits being made again, and changes
no edit, card, approval or refusal. So the limits are limits on document content at rest and on
storage, and there are three (the constants are in `src/docs-copy.ts`):

- 200 documents and 512 MiB (`MAX_DRIVE_DOC_COPIES`, `MAX_DRIVE_DOC_COPY_BYTES`), whichever is
  met first. The bytes are each copy's runs and contexts (a tab's lists and named styles) as
  stored, counted as the document is stored and kept on the copy's record, so no stored content
  is read to know them. Stored beside them, and not counted, are the runs' renderings, each
  tab's list of its runs and what queued edits made. As measured with no edit queued, all that
  a document stores is 1.6 times its counted bytes for a tab of prose and 1.8 times for a tab
  of 19,601 runs (tables of one cell with a paragraph between each two), so 512 MiB counted is
  about 0.8 to 0.9 GiB at rest; a queued edit adds its own state of its tab, whose list names
  every run of the tab (138 bytes a run on that tab). The allowed read that keeps a document
  and brings the connection past either figure removes copies until it is under both, in the
  transaction that keeps the document: the copy whose last allowed read is oldest goes first,
  those of files with queued edits after every other, and never the one being kept. A read
  whose scope check has not passed removes nothing. The cap refuses no read: a document larger
  than the byte figure by itself would be kept alone.
- 7 days with no allowed read (`DRIVE_DOC_COPY_EXPIRY_MS`). A copy's record holds the hour a
  scope check last allowed a read of it, so a copy goes no later than 7 days after that read
  and up to an hour sooner. It is removed the next time the connection is used: when a session
  of it starts, when anything queued through it is approved or rejected, whatever it is, and
  when a Doc is read through it, the copy of the file being read included, which is then
  fetched. The pass runs at most once an hour and reads one small row a copy. One request
  removes a bounded amount, 64 MiB of copies as the cap counts them
  (`DRIVE_DOC_EXPIRY_CALL_BYTES`): the copy of the file being read first, then the one whose
  last allowed read is oldest, and the connection's next request goes on where more is past
  the limit. The bound is there because a Durable Object commits what a request wrote between
  two awaits whole or not at all, so a request cut short loses the removals it made and the
  next one makes them again, at the size of the bound and not of the connection. The connection
  has no alarm, so a connection nobody uses again keeps what it stored, under the caps, until
  it is used or its storage is deleted.
- Loss of reach. When a session of a folder connection is refused a file the connection stores
  a copy of, the copy is removed where the connection does not reach the file, at the cost of
  at most one Drive request. Nothing is asked where what the refusal read of the file settles
  it: the copy is removed where the account cannot see the file or the file is in the trash or
  in no single folder, and kept where the file's folder is one of the refused session's path
  or the one the copy's last allowed read stood on. So a file that did not move keeps its copy
  whichever session is refused it. Otherwise one request reads the file's parent folder, and
  the copy is kept where that folder is directly inside a folder of the refused session's path
  and removed where it is not. Drive answers no folder's ancestry, so that request cannot tell
  a file moved two or more folders away from that path, and still inside the connection's
  folder, from one that left it: that copy goes too, and the file's next allowed read fetches
  once. A refusal of a file with no stored copy asks nothing, and neither does a session that
  is refused because its own folder left the connection. A connection bound to one file or to
  the whole account has no scope check that refuses a read, so its copies end by the expiry
  and the caps, as does any copy no refusal removes.

Each removal logs one event with the file's ID and a reason, and never content, a title or a
folder's name: `google.doc.copy.evicted` (`count` or `bytes`), `google.doc.copy.expired`
(`unapproved`) and `google.doc.copy.unreachable` (`invisible`, `trashed` or `moved-out`). A
lookup of the parent folder that fails, or a removal storage refuses, logs
`google.doc.copy.reach.failed` and leaves the copy.

Between two requests the connection's memory holds, of a document, which copy a read approved:
for the four documents opened most recently on a read and write connection, and for each
session a read-only one has open on a Doc. That is the copy's record (its name, its revision,
its clocks, whether a write has landed since it was fetched, the folder its last allowed read
stood on, the digest of the code it was last swept under, its counted bytes, and for each tab
its ID, title, place, base version's name and write markers) and a few counters of the
connection's writes and queued edits. It holds no text of a document's body: as JSON it
measured 673 bytes for a document of one tab and 155 for each further tab, with a revision ID
of 64 characters and tab titles of 20, held under 700 and 165
(`__tests__/workerd/doc-actions.test.ts`). So a connection
started again fetches each document once more at its first read, though its copy is stored. The
stored copy still spares work: the runs that fetch brings unchanged are neither written nor
rendered again.

The text a comment or a suggestion quotes is looked for in the stored copy when the write is
queued, and in the answer of the approval's own fetch when it is approved, of which nothing is
stored (see [Drive comments](#drive-comments)).

### Keeping Drive read-only

A deployment can keep Google Drive read-only by setting `GOOGLE_DRIVE_ACCESS` on this Worker to `read`. The value is read with surrounding spaces trimmed and in any case, so `Write` is `write`. The default, and what an unset or empty value means, is `write`; any other value means `read`. It is a variable, like the Microsoft 365 gatekeeper's access settings: whoever deploys sets it, it is not on the admin page, and `pnpm dev-server` passes it through from the shell or the root `.dev.vars`. Under `read` no Drive connection makes a change, and none opens a native file for editing. The connect dialog offers no **Access** choice, and a request that asks for read and write opens read-only and says so. A resource URL carrying `?access=write` is refused when a connection is made from it. A connection that was made read and write behaves as a read-only one for as long as the setting holds: `getScope()` reports `access: "read"`, its types are the read-only ones, it lists no action kind, and every write refuses, saying that the deployment keeps Drive read-only: a comment, a sharing change and a move, and `listAccess()` with them. Its native sessions are the read-only ones. A write queued before the setting and approved under it is not sent; it stays pending, and is applied if it is approved after the setting is lifted. Under `read` no consent asks Google for the `drive` scope either: an account whose consent asked for the writes grant keeps it among its recorded grants, and is asked for the scope again by the first consent after the setting is lifted. The setting takes nothing back: which scopes the account's token holds is Google's to say, and what the app may do is still removed on the Google Account's own page of third-party access. It covers Drive connections only. Two things are outside it: a Doc, spreadsheet or presentation connected or created as its editable type, which is another resource type and is turned off on the admin page, and the connect dialog's **Convert**, which still copies an Office file into the user's Drive as a Google file when the user asks for it.

## Troubleshooting

### "redirect_uri_mismatch" error

This means the redirect URI in your OAuth credentials doesn't match what the app is sending. Double-check that you added exactly `http://localhost:8787/gatekeeper/google/oauth` (no trailing slash, http not https) to your OAuth client's Authorized redirect URIs.

### "access_denied" error

Common causes:
- **You're not a test user**: While the app is in Testing mode, only users listed in the OAuth consent screen's Test Users can authenticate. Add your email there.
- **You denied consent**: Try again and click "Allow" on Google's consent screen.

### "invalid_client" error

Your CLIENT_ID or CLIENT_SECRET is incorrect. Double-check the values in your `.env` file match exactly what's shown in the Google Cloud Console.

### OAuth consent screen shows "unverified app" warning

This is normal for apps in Testing mode. Click "Advanced" and then "Go to [app name] (unsafe)" to proceed. This warning only appears for test users during development.

### Connections keep asking to re-authenticate

When Google permanently refuses to refresh an account's access token, the connection shows as expired and the Worker logs `google.token.mint.refused` with Google's own codes: `providerError` (`invalid_grant` or `admin_policy_enforced`) and, when Google sends one, `providerSubtype`. Common causes:
- **The OAuth app is in Testing**: Google expires a Testing app's refresh tokens after 7 days. Publish the app to production to stop it.
- **Google's own limits on refresh tokens**: a password change expires the refresh tokens that carry Gmail scopes, a token unused for six months expires, and Google keeps at most 100 refresh tokens for one Google account and OAuth client, dropping the oldest without notice when another is issued.
- **The same Google account is connected more than once**: disconnecting a Google account, or dropping a connection that was never finished or that repeats an account the same user already connected, revokes its grant, and Google revokes a grant for every OAuth client in the project at once. That expires every other connection of the same Google account: any on this deployment, the user's own or another user's, which then has to be reconnected, and those on any other deployment that uses the same Google Cloud project, so give each deployment its own project.
- **`providerSubtype` is `invalid_rapt` or `rapt_required`**: the account's Google Workspace sets a session length for Google Cloud, and a grant that includes a Cloud scope, which BigQuery's is, must sign in again each time it runs out. Consents add to what the account granted before (`include_granted_scopes`), so this reaches every Google connection of an account that has connected BigQuery. A Workspace admin can lengthen the session or exempt the app.

### Gmail requests fail

A failed Gmail request logs `google.api.request.failed` with Google's reason codes (`providerReasons`), as Docs, Sheets and Slides requests do (as information when it is a 404, which callers expect and handle, and as a warning otherwise), and its error names them, since a 403 can be a usage limit (`rateLimitExceeded`, `userRateLimitExceeded`, or `dailyLimitExceeded` for the Google Cloud project's own quota), where the error says to try again later, a missing permission (`insufficientPermissions`), where it says to reconnect, or another refusal such as `domainPolicy` (a Workspace administrator has blocked the app), where the error names the reason only. A 429 gets the rate-limit advice whatever its reason; the codes do not tell a per-minute quota from a daily limit such as the one on sending mail, which can take hours to lift, so the error promises no wait. Google's own error text is never logged or returned: it can repeat a search query or a header. A Gmail connection limited to a search or a label has no `send()`, `createDraft()` or label methods; an agent that calls one is told so, what the connection offers instead, and that connecting Gmail as **All Gmail** has it.

### "This app is blocked" or quota errors

You may have hit rate limits or your project may have issues. Check the [Google Cloud Console](https://console.cloud.google.com/) for any alerts or quota warnings on your project.
