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
23. For Chat, enable **Google Chat API**, plus **People API** so direct messages and group chats can be named when Chat omits a participant's name, and so a whole-account Chat connection can search the organization's directory and confirm that everyone in a conversation it starts belongs to the organization.
24. On the Google Chat API's **Configuration** tab, set an app name, avatar URL, and description, turn off **Interactive features**, and click **Save**. Reads work without this, but Google refuses every Chat send, edit, and reaction until a Chat app is configured.

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
- `documents` for direct Google Docs reads, edits, comments, and creation; `documents.readonly` for native Docs opened from account-wide, folder, or exact-file Drive bindings. Appending and replacing text in a bound Doc can be auto-approved ("Document edits"), and so can adding a tab ("New document tabs") and its comment writes ("Google Doc comments"), which go through the Docs API under this scope (see [Google Doc comments](#google-doc-comments)).
- `drive.metadata.readonly` so the Drive picker can browse to a Doc, spreadsheet or presentation connected on its own, and so a bound Doc can read whether the connected account may comment on it. Google classifies this as a restricted scope. Docs, Sheets and Slides share the Google Drive connect card with the Drive resources, and the Workshop asks for every type on a card together, so connecting any of them also asks for the other types' scopes, `drive.readonly` among them.
- `drive.readonly` for account-wide, folder, and exact-file Drive bindings: the Drive picker, discovery, file metadata, folder descendant proofs, native-file scope checks, downloading a PDF to read its text with `readPdf()`, and downloading any other file's bytes with `readFile()`. Google classifies this as a restricted scope too, so every Drive resource here needs restricted-scope verification.
- `drive.readonly` and `drive.file` for the Office import grant (`https://docs.google.com/import`), which converts an Office file into a Google Docs, Sheets or Slides copy (see [Office files](#office-files)). Only the connect dialog's **Convert** button asks for it, by incremental consent, the first time an account converts a file; using a copy made before reads only metadata and asks for nothing. Once held, it is part of the account's recorded grants, so a reconnect asks for it again. `drive.readonly` lets the gatekeeper see a source file this OAuth client did not create, which `drive.file` alone cannot, and `drive.file` lets it create the copy. The grant is private to the gatekeeper: it is not a resource, so it is never offered on connect, listed, bound, or shown among an account's granted resources, and admins cannot turn it off separately from Docs, Sheets and Slides. Once held, `drive.readonly` lets the account's token read any Drive file, so bindings stay limited by the gatekeeper's code rather than by the token. A verified OAuth app must add both scopes to its consent screen, and `drive.readonly` is a restricted scope.
- `drive.readonly` for the shared-drives grant (`https://drive.google.com/drive/shared-drives`), which lets the Drive picker list the shared drives the account belongs to, since Drive's `drives.list` accepts no narrower scope. Only the picker's **Allow access** button asks for it, by incremental consent, the first time an account opens Shared drives; once held, a reconnect asks for it again. It is private to the gatekeeper as the Office import grant is, and an account holding that grant is still asked once, since a private grant counts only once it has been asked for, not because its scopes happen to be held.
- `drive.file` for the created-files grant (`https://drive.google.com/drive/created-files`), which lets the gatekeeper put what a creation makes where its approver chose: move a new Doc, spreadsheet or presentation out of My Drive into a folder, or make a new Drive folder. `drive.file` reaches only files this OAuth client created or the user opened or shared with it. Only the creation dialog's **Allow access** button asks for it, by incremental consent, the first time an approver picks a folder (or approves a new folder); a file kept in My Drive needs no Drive call and asks for nothing. It is private to the gatekeeper as the Office import grant is.
- `drive` for the Drive writes grant (`https://drive.google.com/drive/writes`), which lets a Drive binding with read and write access change files (see [Drive comments](#drive-comments) and [Moving and sharing](#moving-and-sharing)): comment writes, sharing and moves need full `drive`, and `drive.file` does not reach a file picked in Drive. Only the Drive connect dialog's **Allow changes** action starts asking for it, by incremental consent, the first time an account chooses **Read and write**; an account that never chooses it is never asked. Once an **Allow changes** consent has completed, the grant is among the account's recorded grants whether or not Google granted `drive`, so every later consent for the account asks for `drive` again: a reconnect, **Allow editing**, **Allow access**, **Convert**, or granting another Google resource type. A deployment that keeps Google Drive read-only asks for it at no consent (see [Keeping Drive read-only](#keeping-drive-read-only)). One grant covers every Drive write on the account. It is private to the gatekeeper as the Office import grant is, so Workshop does not list it among an account's grants and the admin page cannot turn it off separately from the Drive resource types; a deployment turns Drive writes off with `GOOGLE_DRIVE_ACCESS` (see [Keeping Drive read-only](#keeping-drive-read-only)). The token it yields can read and write every Drive file the account can, and every Google binding of the account uses that token, so a binding's scope, its access level and the grant itself are enforced in the gatekeeper's code, when a write is queued and again when it is approved. The Drive writes a binding's session can queue are comments and replies, permission changes (`permissions.create`, `permissions.update`, `permissions.delete`) and a move (`files.update` of a file's parents), and no other. The grant counts only while the scopes Google last returned for the account include `drive`: a consent that comes back without it withdraws the grant, and the account keeps its read and write bindings, which go on reading while it still holds a Drive read scope and whose writes are refused until **Allow changes** succeeds again; a write queued before that stays pending when it is approved, and is posted by an approval made after. Disconnecting the Google account revokes its token and forgets its recorded grants, this one included; what the app may do is shown, and can be removed, on the Google Account's own page of third-party access. Because the gatekeeper takes `drive` to cover `drive.readonly`, `drive.file` and `spreadsheets`, an account that holds it also satisfies those scopes for grants it had already recorded: the Office import, shared-drives and created-files grants, and a Sheets grant whose `spreadsheets` scope was declined or retracted, so a spreadsheet then binds as its editable type with no **Allow editing** step, while a Docs or Slides grant still needs its own scope. A verified OAuth app must add `drive` to its consent screen, where Google words it as "See, edit, create, and delete all your Google Drive files"; it is a restricted scope.
- `spreadsheets` to read metadata, bounded cell ranges and their formatting from directly selected spreadsheets, edit their values, sheets, rows, columns and formatting with approval, and create spreadsheets. The switch from `spreadsheets.readonly` retracted every existing Sheets grant, including one derived from `drive.readonly`: owners re-consent the next time they connect a spreadsheet, and collaborators observing an existing Sheets binding are asked to grant read-write `spreadsheets` the next time they open its workspace. A `spreadsheets` grant covers the Drive resources' `spreadsheets.readonly`.
- `spreadsheets.readonly` to read native Sheets opened from account-wide, folder, or exact-file Drive bindings.
- `presentations` to read, edit, and create directly selected presentations, and to render slide thumbnails; `presentations.readonly` to read and render native Slides opened from account-wide, folder, or exact-file Drive bindings. Google counts each thumbnail as an expensive read, limited to 60 a minute per user and 300 per project.
- `calendar.calendarlist.readonly` so the resource picker can list calendars.
- `calendar.events` to read and manage the selected calendar. Creating or changing an event nobody else is on can be auto-approved ("Add and change calendar events"). A change waits for approval when it would make the event public or otherwise widen who can see it, or when the event is an out-of-office, focus-time or other special event. Anything Google would tell attendees about, meaning an event that has or gains attendees, one organized by someone else, or one whose guest list Google hides, is "Send event invitations and updates", a separate kind a user may also opt into auto-approving, whatever `sendUpdates` is; the same visibility and special-event holds apply to it. An auto-approvable change is checked again when it applies, and fails without changing anything if the event has gained or lost guests, so that it would now fall under the other kind, or the change would now widen its visibility; the write is conditional on the version it checked, so a change made in between also fails it.
- `calendar.events.freebusy` to check availability, which `calendar.events` does not cover. Adding it retracted every existing Calendar grant that lacks a whole-calendar scope: owners re-consent the next time they connect a calendar, and an existing binding checks availability only after its account reconnects or grants Calendar again.
- `chat.spaces.readonly`, `chat.messages`, and `chat.memberships.readonly` for every Chat resource. A whole-account Chat connection adds `chat.users.readstate.readonly` for its unread-only search, and `chat.spaces.create` and `directory.readonly` to start direct messages and group chats with people in the connected account's Workspace directory. Starting a conversation is its own approval kind, separate from sending in an existing one, and people outside the organization can't be added to a new conversation.
- `bigquery` for BigQuery dry-runs and queries. This is intentionally broader than `bigquery.readonly` because dry-runs use `jobs.insert`; the gatekeeper enforces read-only SQL and resource scope checks before running queries. Query jobs run in the connected project, which must grant the account `bigquery.jobs.create`; a dataset shared from a project that doesn't (a dataset-level grant never does) is connected with `?queryProject=<own-project>` on its resource URL, which runs and bills the jobs there while the data scope stays on the shared dataset.

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
as stored, the notes on a page, the idle minute, what is billed, the `AI` and `PDF_RENDERER`
bindings and `PDF_OCR`. Its failures are in Gmail's words (`The Gmail attachment could not be
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
chunk the last image ended in. So a scan read as stored costs one more fetch of the attachment,
as far as its last page image, however many pages it has. A pass breaks when a read of it fails
or it ends before the image does, and stalls when a read of it has waited 15 seconds for a
chunk; the time between two images, while the model answers, is not counted. Either way the pass
is let go and the attachment opened again from its start, once for each image, which goes on
from where it had got to. A second break or stall under the same image fails the text: with what
the read failed with, as a changed attachment when it ended short, or with `The PDF stopped
arriving while a page was being read; read it again.` An open that fails is not tried again. An
image that a later update to the file defined again lies after the images of later pages, so its
range starts before the pass's place and a new pass is opened for it: four times for one text,
after which the text fails as a failed transcription.

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

## Google Chat and Gmail new-message hooks (optional)

Gadgets can watch a Chat conversation for new messages (see `docs/google-chat-capabilities.md`),
and a Gmail inbox, label or thread for new mail (`subscribeNewMessages()` in `src/types.d.ts`).
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
drive the account can add files to), and the binding switches to the real file. A folder is made in
place, by an account that also holds the Drive folder grant, without which its binding could read
only what this app puts in it. The Docs, Sheets and Slides APIs cannot name a folder, and Drive's
own `files.create` would lose the default `Sheet1` and fixed Slides IDs the simulations rely on, so
those files are made in My Drive and then moved. The folder is checked before anything is made; a
retried approval binds the file the first one made and moves it to the retry's choice, reading
where it is rather than trusting what was recorded. Only the account the file was made in can move
it, so another approver's retry is refused unless it chooses where the file already is (their own
My Drive is never that). Doc edits queued against the simulation then apply to the created document
like any other edit, and Slides changes apply to the created presentation unchanged.

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

## Google Doc comments

A directly bound Doc offers `listComments()`, `comment(text, { quote, tabId? })`, `suggestEdit(oldText, newText, { note?, tabId? })`, `reply(commentId, text)` and `resolve(commentId, text?)`. None takes a file ID: the binding's one Doc is the file, as an item is for the comments of the other gatekeepers. Its grant, `documents` and `drive.metadata.readonly`, reaches the comments through the Docs API; Drive's comment API refuses it. Through Docs it lists every comment, makes comments attached to text and suggestions, and replies to, resolves and reopens any comment attached to text, someone else's too. It cannot make a comment attached to no text, nor answer one (one made through Drive, or on the whole file). So `comment()` requires a quote, and a reply to or resolve of such a comment is refused with the resource URL of a read and write Drive connection to the file, which can answer it; `getMetadata()` returns the Doc's `id` for that URL.

The writes go through the engine behind Drive's comment writes (see [Drive comments](#drive-comments)): each is queued for approval, listed `pending` until it is decided, checked again when it is approved, and looked for before a send Google did not confirm is retried. The checks at approval are the same: the account can still comment, a quote still occurs exactly once in its tab, and the comment a reply or resolve answers still exists with the text it had, a resolve's still open. They are queued as **Google Doc comments**, a kind of their own, auto-approvable with the same exception for mentions as Drive comments, and are not gated on the Drive writes grant or a read and write choice, as the Doc's edits are not. A quote is matched against the Doc as Google has it saved, not with pending edits replayed, so text only in an edit waiting for approval is refused as such. `tabId` follows the binding's rule: it may be left out only for a Doc with one tab. A comment, reply or note holds at most 2048 bytes of UTF-8, the Docs limit. Comment writes and edits share one counter of approval IDs, so an ID names one action; comments apply in any order while edits keep theirs, and rejecting a comment restarts nothing.

Google shows a Doc's comments only to an account that can comment on it, and refuses the read (comments require suggestions inline) to one that can only view the Doc. The binding refuses such an account every comment read and write, saying why, as Drive's metadata tells it. A Doc not created yet lists no comments and takes no comment writes. A listing, and the read that finds a quote, report the document, `docs/document/<documentId>`, as the binding's other reads do.

## Google Docs request costs

Connecting a Doc reads its Drive metadata once, to refuse an Office file (see
[Office files](#office-files)). A read costs one full `documents.get`, replayed for 10 seconds and then revalidated by a
revision-only `get`. Queuing an edit costs nothing more. Applying one costs a full `get` (the
edit is materialized against the current revision), the `batchUpdate` carrying the edit and its
write marker, and a second `batchUpdate` removing the marker; the document is reread after it only
when more edits are queued behind it, since they must be replayed over the new revision.

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
metadata read, for whether the account may comment, and a full `get` to find the quote; a reply or
resolve costs the metadata read, the threads read and a `get` of the title. Applying a comment or
suggestion costs the metadata read, a full `get` with suggestions inline and the `batchUpdate`, and
a suggestion's note one more `batchUpdate`; applying a reply or resolve costs the metadata read, the
threads read and the `batchUpdate`. A retry after a send Google did not confirm first reads the
threads, or the suggestions, once.

## Known limitations

Very large Google Docs can exceed Durable Objects' 2 MB value limit after Markdown conversion,
causing tab listing, content reads, and edits to fail.

A Google Slides presentation's slide summaries come from one response capped at 10 MiB. It holds the
text of every slide's shapes and speaker notes, but no styles or geometry: about 4 KiB a slide on a
live deck, so a presentation needs thousands of slides to exceed it. It also holds every master's
and layout's name and background and the masters' theme colours, a few KiB in all. Slide content is
read one slide at a time, capped at 2 MiB each. While changes await approval, reads also fetch the
slides they address, so each can be checked as approving it would: slide content reads the other
slides of any batch touching a slide it shows, since a batch applies all or none, and the summaries
read every slide a queued batch changes, since they hold no tables or grouped shapes. Large batches
awaiting approval therefore cost reads more requests against Google's per-user quota.

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

A batch is queued as the first of four action kinds that fits it; they share everything but their
names and whether a user may let them apply without asking. A user may let three apply without
asking: "Slide text edits" (only text edits); "Slide formatting and arrangement" (only formatting
text, setting no link or font, since Google keeps their whole strings; formatting paragraphs and
shapes; moving or stacking elements; and setting slides' backgrounds to a colour, `"none"` or
`null`); and "Slide edits that keep every element, table row and column and download no images"
(every other batch that deletes no element, table row or column and downloads no image: mixed
batches, links, fonts, alt text, new shapes and tables, table rows, columns and cell fills, and
changes to layouts, masters and theme colours, which reach every slide made from them). The
fourth, "Slide changes that delete elements, table rows or columns, or download images", always
waits for approval. It holds a batch that deletes an element or a table's rows or columns, or has
Google download an image from a URL the agent chose (to insert it, replace one, or use it as a
picture background), since that URL can carry whatever the agent encoded in it.

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
user may let apply without asking. Deleting a slide always waits for approval, since it takes the
slide's content and notes, and can take its master and layouts.

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
apply in the order they were queued. A spreadsheet opened from a Drive binding has no change method.

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
waits for approval as "Spreadsheet changes that delete or run unchecked formulas" when a formula
has any of these:

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
calls a function the paragraphs above exclude. A batch that deletes a sheet, rows or columns always
waits for approval, as "Spreadsheet changes that delete or run unchecked formulas". Each batch is
queued as exactly one kind, so letting edits that keep every sheet, row and column apply without
asking leaves batches of only literal values and clears, or only formatting, to their own kinds.
Every default is sent explicitly, so the approver sees what will be made: a new sheet has Google's
1,000 rows and 26 columns and comes last, and a copy is titled `Copy of <title>` and placed right
after its source (Google would put it first, under a name of its own choosing). Changes are refused
when queued that would delete the last visible sheet, every row or column of a sheet, or every one
of its unfrozen ones, delete a sheet of more than 50,000 cells, whose content the guard below could
not cover (delete it in Google Sheets instead), grow a sheet past 18,278 columns or the spreadsheet
past 10,000,000 cells, or change or copy a sheet holding a protected range the account cannot edit. Reads show the
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

Sheets has no revision to pin a write to, so each approved batch is planned against a fresh read
and guarded by a digest of what it overwrites or removes: the cells it writes and the rows,
columns and sheets it deletes, as entered, the title and size of each sheet it addresses, and,
when it adds or copies a sheet, the order of every sheet, ignoring whitespace in formulas. Cells
that changes queued before it write are expected to hold what those enter, and sheets those
restructure to have the shape they leave, so a batch built on one that was rejected or failed fails
too, as does a batch with a formula when any structural change queued before it was not applied,
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
Google allows 60 write requests a minute per user; a write over that quota stays pending.
user; a write over that quota stays pending.

## Google Drive bindings

Drive exposes three permanent resource URL forms:

- `https://drive.google.com/drive/my-drive` selects everything the connected account can read in Drive. Despite the `my-drive` URL it is not limited to My Drive: any ID the account token resolves is in scope. Listings use `corpora=user`, which Google defines as My Drive items the account created or opened plus items shared directly with it, so a shared drive's contents may be readable by ID without appearing in a listing. Bind a folder or file when this authority is too broad.
- `https://drive.google.com/drive/folders/<folderId>` selects one folder or shared-drive root.
- `https://drive.google.com/file/d/<fileId>/view` selects one file by its immutable ID.

Each form connects read-only unless it carries `?access=write`, which makes the binding read and write, as in `https://drive.google.com/drive/folders/<folderId>?access=write`. Any other value, or none, is read-only, so a binding made without the parameter is read-only. The level is part of the binding and does not change; to change it, connect the folder or file again. A deployment can still keep every Drive binding read-only (see [Keeping Drive read-only](#keeping-drive-read-only)). A read-only binding's TypeScript types hold no write method, and its session refuses one, naming the URL to request instead. A read and write binding's title ends in "(read and write)". Its writes also need the account to hold the Drive writes grant above, checked when a write is queued and again when it is approved, so a read-only binding stays read-only whatever the account has granted. Code that holds a binding reads its level from `getScope()`, whose result carries `access`, `"read"` or `"write"`, whatever the account has granted. A blueprint carries a binding's level only in the URL it may suggest for it. The blueprint's install page shows that URL to the installer but does not pre-fill it, so its dialog opens on **Read and write**, the dialog's default, whatever the URL says, and the binding installs read and write unless the installer chooses **Read only**. An agent that makes or merges a gadget from the blueprint is given the suggested URL, so its connection request opens the dialog on the level the URL asks for. A gadget that comments checks `getScope()` before it writes, since on a read-only binding every write fails, and an author who needs writes says so in the binding's description.

The Drive picker opens on Google Drive, whose own choice binds the whole account, above My Drive, Shared drives, Shared with me and Recent. Locations list a page at a time. Search spans My Drive, "Shared with me" and every shared drive the account is a member of (`corpora=allDrives`) and says where each result lives, and a Drive, Docs, Sheets or Slides link pasted into it answers with the one folder or file the link names. A pre-filled folder or file opens where it lives, with breadcrumbs up to My Drive or its shared drive, or with none when an ancestor is out of reach or more than 20 folders up. All of this runs on the Drive resources' own grant except listing Shared drives, which also needs the shared-drives grant above: until the account holds it, opening Shared drives offers **Allow access**, and a shared drive's folders stay reachable through search, a pasted link or a pre-filled URL. Folders whose children the account cannot list are shown but cannot be opened or bound; on a pre-filled node's breadcrumbs, where Google's [folders with limited access](https://developers.google.com/workspace/drive/api/guides/limited-expansive-access) put them above a file shared directly, they can be opened but are not offered. A shortcut stands for its target, which a listing says nothing of, so a page's shortcut targets are read in one batch: a shortcut left behind when its target was deleted, unshared or trashed is left out, and one to a folder is judged as that folder would be. A search Google reports as incomplete fails rather than presenting partial results as complete.

A native Docs, Sheets or Slides file binds as its editable type (Google Doc, Spreadsheet or Slides Presentation) unless the Workshop accepts only Drive files, as a blueprint's Drive file binding does, when it binds as a Drive file, whose content can be read but not edited. It also binds as a Drive file, and the picker says so, on the Google Drive card when the account lacks its type's grant or an admin disabled the type. On the card, the notice's **Allow editing** asks Google for every editable type the account lacks; the grant restarts the picker, so the file is chosen again, and an account that already held them (the type is disabled) is told editing isn't available. A file the picker showed as native connects as it is; one pre-filled from a URL is checked first, as an Office file is. An Office file binds as the type it converts into, once converted (see [Office files](#office-files)); any other file binds as a Drive file. Each file shows when it was last modified and, when Drive reports one, its size; a shortcut shows none, since its target is read only for what decides scope. Recent lists the files the account created, opened or had shared with it, newest first, folders left out.

Under the picker, **Access** offers **Read and write**, the default, or **Read only**, whenever the chosen target connects as a Drive type, where the deployment offers read and write: all of Drive, a folder, or a file bound as a Drive file. It is not offered for a Doc, spreadsheet or presentation that connects as its editable type. A Doc bound that way reads all its own comments and writes them (see [Google Doc comments](#google-doc-comments)), except that it cannot make or answer a comment attached to no text; that, and the comments on a spreadsheet or presentation, go through a Drive binding that reaches the file. In the dialog that is its folder, or all of Drive. An agent can also request the file's own Drive link, `https://drive.google.com/file/d/<fileId>/view`, with `?access=write` to write comments as well as read them, which opens the dialog on that file as a Drive file, and a person can paste the same link into the chat composer. Pasted into the picker's search the link does not do this: there it finds the file as the picker lists it, which for a native file is its editable type. Read and write, chosen or by default, asks the gatekeeper whether the account holds the writes grant once a target is chosen; if it does not, a notice offers **Allow changes**, which asks Google from that click, and the dialog cannot add the connection until the account holds the grant. That consent asks again for everything the account has asked for before, so it can also grant an editable type the card lacked; Workshop then restarts the picker, as it does after **Allow editing**, and the choice is made again, which the notice says beforehand on a card that lacks such a type. A connection request an agent pre-filled is applied to the restarted picker too, which reopens on Read and write. A refused or abandoned consent leaves Read only available. A resource URL carrying `?access=write` opens the dialog with Read and write chosen, so an agent's connection request can ask for it, and one without it opens the dialog on Read only; the choice sits under the list, so the form's first line then says that Read and write is chosen, until the choice is changed. A link pasted into the chat composer is connected as written, so one carrying `?access=write` makes a read and write binding without the dialog; it can write only once the account holds the grant.

A folder URL carrying `?resourcekey=` is not supported: the key is dropped, and the binding then fails with a Drive 404 for anyone whose access to that folder comes from the link rather than from a direct grant. Google requires resource keys only for items shared by link before September 2021, and only for link-access users — an owner or anyone granted access directly is unaffected, even when the URL they paste happens to carry a key. Such a folder needs direct access to connect.

The agent-facing `GoogleDriveReadSession` covers read-only account and exact-file bindings, and `GoogleDriveFolderReadSession` a read-only folder binding, positioned at the selected root and exposing only its current folder's direct children: `list()`, provider-side structured `search()`, `getEntry()`, native Doc/Sheet/Slides opens, `readPdf()` and `readFile()`, and `openFolder()` for one live direct child. A read and write binding gets `GoogleDriveSession` (the account), `GoogleDriveFileSession` (a file) or `GoogleDriveFolderSession` (a folder), which add the comment writes and the sharing calls `listAccess()`, `share()`, `updateAccess()` and `unshare()`, and, for the account and the folder, `move()`; a folder opened from one keeps its access. Every session's `getScope()` reports its binding's access as `access`, so code given either kind of binding can tell which it holds. A folder session's scope also names the folder it was opened from, as `parentFolderId`, which is the one place above itself it can move a file to. Listing and search return disposable RPC cursors; child folders and native content sessions are independently disposable capabilities. There is no built-in recursive folder search, traversal pager, raw Drive `q`, file write other than [comments](#drive-comments) and [moving and sharing](#moving-and-sharing), shortcut traversal, or export of Google-native files.

Every Drive session offers `readPdf(fileId)`, which downloads an in-scope PDF and returns its text as Markdown, converted by Workers AI's `toMarkdown()`. It downloads with the Drive resources' `drive.readonly`; on an account connected before they requested it, `readPdf()` fails asking the user to reconnect. The file is checked against the binding's scope, and must be a PDF, before anything is downloaded, and a folder binding re-proves it is a live direct child after the download, as for a native read: the token's `drive.readonly` reaches any Drive file, so scope is enforced in code. Neither the PDF nor its text is held in memory: the download streams straight into the conversion request (through the `AI` binding's own `fetch`, since the binding's `toMarkdown()` takes a whole `Blob`), and `text` is a `ReadableStream` of UTF-8 Markdown read from the conversion's response as it is converted, so the agent bounds how much it reads. `readPdf()` reads the response only until the text begins before it returns, so `hasText` is already known. Pages are separated by `### Page N` headings, and pages before the first with text are left out, unless pages without text are read into the text, as said further down. There is no download or text cap: a PDF Workers AI cannot convert, including one too large for it, fails. A scanned or image-only PDF has no text to convert, so its pages are transcribed, as said next. Conversion runs under a fixed file name with its images left undescribed, so no Drive file name reaches Workers AI and the conversion makes no billed model call.

`readPdf()` has a vision model read the pages that have no text of their own. It takes no option for that: a deployment turns it off for every connection with `PDF_OCR`, described below. A PDF that proves to have no text is transcribed, and returns `transcribed: true` with the transcription as `text`; one that has text keeps it, and the pages of it that have none may be read into it, as said further down. Each image sent is one billed call to the Workers AI vision model `@cf/google/gemma-4-26b-a4b-it` (about 320 input and a few hundred output tokens for a page of prose sent whole), made with no budget or approval of its own, through the same AI Gateway as conversion when `CF_AI_GATEWAY` is set; a gateway that stores its logs then holds the images and their transcriptions. As the PDF streams into the conversion, a scanner (`src/pdf-images.ts`) notes where each page image sits in the file, reading each object once and keeping a few numbers of it whatever the file holds. Any image at least 200 pixels on each side that is not a mask is a page image; a smaller one, and a mask that large, are only counted. What the scanner found decides, in `pdfToText()` (`src/drive-pdf.ts`), how a PDF without text is read. An encrypted one is refused. One of up to 16 MiB has its pages rendered, when the Worker has its `PDF_RENDERER` binding, whatever the scanner counted: a page may show an image written into its content stream, or writing drawn as shapes, neither of which is an object for the scanner to see. Any other that holds no image of any kind, the counted ones included, has nothing to transcribe and returns an empty `text` with `transcribed: false`; one that does has its page images sent as the file stores them. Either way nothing is done until `text` is read, and then one page at a time, so an agent that stops reading, or cancels, stops paying.

A rendered PDF's pages are drawn by [PDFium](https://pdfium.googlesource.com/pdfium/) in a Worker of its own, `pdf-renderer`, which this one reaches over the `PDF_RENDERER` service binding, taking only the types and limits of its `src/api.ts`; [its README](../pdf-renderer/README.md) says what it holds and the limits it draws under. Drawing reads what sending stored images cannot: pages stored as fax, JBIG2 or JPEG 2000, with a palette or in CMYK, in layers, tiles or strips, or turned, and pages that the file stores in another order than its page tree lists them. At the first read of `text` the file is downloaded a second time, as one content read of the whole file: checked against the binding's scope, re-proved on a folder binding, reported as `drive/content/<fileId>`, and failed if the file is no longer the size it was converted at, or, on a folder binding, if its modification time has moved. The download streams into the renderer's `open()`, which keeps the file in its own isolate; what this Worker holds is a stub to the open document, and the bands of one page while they are read. Each page is asked for when the text has been read up to it, with `renderPage(index, { bands: 4, denseLines: 14 })`: the renderer draws it in 8-bit grey at 150 dpi (fewer for a page that would pass 3,000,000 pixels or 4,000 on a side) and cuts it across, at its least inked rows, into at most four bands, fewer for a short page and for one set in columns. A band that holds more than 14 lines of writing is then cut once more, up to eight bands a page, so that a closely written page is read in smaller images: on a generated page of small print (1,236 words) the model got 5 to 8 words wrong in four bands and, in two reads of six, left a whole clause out of the tallest, against 2 to 4 wrong and no clause lost in the six bands this cut gives, for two calls more. 14 is the largest number that cuts that page, and of the other seven test pages it cuts only a table's, once; the words at the new cuts are where the six-band reads err. The renderer counts lines only on an upright page, so a scan turned a degree or so keeps its four bands, and the cut makes a page no faster, since four of its calls run at once. A band with no ink is sent to no model. Every other band is wrapped as a PNG (`pngFromSamples` in `src/pdf-png.ts`, deflated a step at a time as the request takes it) and sent with the prompt a whole page is and one sentence more, against writing a stamp or a logo as an image or a link (a prompt that said the image is a band, which may begin or end inside a table, made the model stop short of a long band's end); up to four of a page's calls are in flight at once (`src/pdf-bands.ts`). The bands' texts come under the page's one heading, each on a line of its own after the last, so a table or a paragraph that a cut falls in comes back in two parts, the second part of a table at times under an empty header row. The page is given whole, in one read, and a cancel sent while it is being read is acted on once it has been. Pages are numbered by the page tree.

A band costs three model calls at most, all with the same prompt and settings: no seed is sent, since on the band it was tried on the model gave one answer whatever seed it was sent. A call is made again as it was, once, when it failed with HTTP 429 or a 5xx, when it failed under any status with Workers AI's code 3040, which says the model has no room just now, or when its response broke off or reported an error partway; a second such failure fails the text, as any other failure does at once, and the answer of a call made again is the band's however it ended. The code is the first `internalCode` or `code` in the first 1,024 bytes of the failed answer (`src/workers-ai-vision.ts`), and is 3040 when any code there is, or when those bytes hold `3040: Capacity temporarily exceeded`. Before a call is made again there is a pause of 250 ms and up to 250 ms more at random (`RETRY_PAUSE` in `src/pdf-bands.ts`), so that the calls a model had no room for do not all come back at once; it ends at once when the page is given up, by another band's failure or by the text's ending. An answer did not end whole when it was stopped at the model's output limit, or ran away repeating itself and was stopped by the gatekeeper: a unit of 12 or more characters said 12 times on end, or 2,000 characters on end of a shorter unit or of one with no letter or digit in it, so that a table's rule and a contents page's dot leaders are not taken for one. A band whose first answer did not end whole is not asked again as it was, since the model would answer the same. It is cut in two at the least inked row of its middle third (a row's ink measured from the row's own ground, as the renderer measures it, so that a page of light writing on dark is cut between its lines too), of rows equally inked the one nearest the middle, and each half that has ink is asked for, the top and then the bottom, with no pause; the halves are views of the band's rows, not copies. A half's answer is stopped only at the 2,000 characters, whatever its unit: a table may hold twelve equal rows, and the first answer is stopped in them. The halves' texts, the bottom's on the line after the top's, are then the band's, and when either did not end whole the page is followed by `[The transcription of this page was cut off.]`. When a half's call fails, which is not made again and after which a bottom half is not asked, or when neither half has ink, the first answer is kept, a runaway as far as the first of what it repeated, and the page is followed by the same line. And once every band of the page has an answer, a band whose one answer is short for its ink is cut in two likewise, and its halves' texts are kept when together they are longer. Short is under a third of the characters for each unit of ink that the page's other bands with text have at their median, of which there must be at least two, unless the band's own ink is under a tenth of their median; the three numbers are a first setting. A band of fewer than 64 rows is not cut but asked again as it is: a second answer that ended whole replaces a first that did not, and of a short band's two answers the longer is kept. Against the real model and through the real renderer, on generated pages, the cut has been seen only for a short answer (five bands of a page that is mostly a figure, each read better in halves); no call there failed, was stopped at the output limit or ran away, so the capacity retry, the pause and the cut after an answer that did not end whole are tested with a fake model only.

A page the renderer could not draw within its limits has its heading and `[This page could not be drawn within the memory and work a page is allowed, so it was not read.]`, and the text goes on. A page that comes out with no ink is sent to no model: it has its heading and, when it draws an image, `[This page came out blank: it has nothing on it, or its image could not be read.]`. A page drawn on a second try, at half the resolution, is followed by `[This page was read from a drawing at half the usual resolution, which is what its size allowed, so its text may be less exact.]`.

The renderer may not open the PDF: an isolate of it has room for 24 MiB of open PDFs and refuses another, the call may fail with nothing behind the binding, and the file may not open, may have more than 2,000 pages, or may be encrypted where the scanner did not see it. Whether the page images can be sent as stored instead is settled when `readPdf()` runs, and when they can be they are, from the first page (logged as `google.drive.pdf.renderer_fallback` with the reason as a word). That happens only before any page has been given, since the two paths number pages differently; an encrypted file is never read so. When they cannot be, `text` errors at its first read: with `The PDF's pages cannot be rendered to be read just now; read the PDF again in a minute.` for want of room or of an answer, with the refusal of an encrypted PDF, and with `Google Drive's PDF could not be transcribed.` otherwise. A download that is not of the size the first was fails the text as a changed file. As for `readFile()`, a failure of the stream reaches a caller over RPC as a broken stream rather than with these words, which is why the types tell the agent to read a PDF again whatever the error says. An open document can also be lost, when the renderer's isolate goes away, or when the renderer, to open another PDF, takes back the room of a document that has gone two minutes without a call, as one whose page takes that long to read has. The next `renderPage` then throws, or answers `released`. If the lost document had rendered a page, the file is downloaded and opened again and the page asked for once more; if it had not, or it is not opened again, the text fails.

A text that may read the file again, which is every transcription and every text that pages without text may be read into, is ended with an error after a minute with nothing moving, whether the model has stopped answering or the caller has stopped reading, and its requests, its reads of the file, its approval queue and its document in the renderer are let go, as a file read's stream is: a cancel sent over RPC is delivered only after the read it is waiting on, so nothing else would end a page the model stalled on. On the rendered path the clock is moved by each chunk of the file handed to the renderer, each answer of the renderer and each piece of any band's text, so a long download, a run of blank pages and a slow page are not taken for a stalled text. However such a text ends, the band calls in flight are given up, an `open` in flight is ended by erroring the stream handed to it, a page being rendered is left to finish, and then the document is disposed, which gives its room in the renderer back; a document is also disposed as soon as its last page has answered.

Sending page images as stored holds nothing: a page's image is read from Drive by range, base64-encoded into the model's request as it arrives, and its text passed on as the model produces it, one call a page; cancelling ends the page in progress. Every page read is a content read of its own, checked against the binding's scope, re-proved on a folder binding and reported as `drive/content/<fileId>`, and it fails if the file is no longer the size it was converted at, or, on a folder binding, if its modification time has moved. Pages come under `### Page N` headings numbered in the order the file stores their images, which is page order for scanner output but is not guaranteed, since the page tree is not followed. Every page image counts as a page, so a PDF of pictures and no text has each picture read as one, and so is an image an edit left in the file that no page shows any more. An image whose object a later incremental update defines again is read once, as it was last defined. JPEG page images are sent as they are stored, and losslessly compressed grey or RGB ones are wrapped as PNG on the way without being decoded (`src/pdf-png.ts`). Rows the PDF keeps without PNG's filter bytes are inflated and deflated again to be given them, a step at a time as the request takes them, since workerd's compression streams would otherwise draw the whole page in at once; a page whose data does not inflate to exactly the rows its dictionary describes, or whose PNG would pass 12 MiB, fails the stream, though data that is out by a line end after rows that are whole (one counted into its length, or its checksum's last bytes taken for one) is read as a PDF reader reads it. A scanned PDF that is not rendered is refused, in the gatekeeper's words and before any model call, when a page is stored as fax (CCITT), JBIG2 or JPEG 2000, or as an image PNG cannot hold (a palette, CMYK), when a mask the size of a page is stored as fax or JBIG2 (a scan stored in layers keeps its text in such a mask, which its colour layers would be read without, and a black-and-white page may be nothing else), when a page image is over 12 MiB (Workers AI refuses a request somewhere between that and 16 MiB) or has rows to inflate of more than 128 MiB, is not where the file says it is, when there are more than 2,000 of them, when an incremental update defines again an image that named a mask (what it named was passed over as a mask and may be a page's image in the file as it now stands), or when there is none, its images all being smaller than a page or masks: the refusal then says that its pages have to be rendered, and that this is done only for a PDF of up to 16 MiB or is not available on the deployment. Such a refusal says what the file's content is like, so it is authorized as a content read before it is given, as the text is.

A PDF that has text is returned as that text, and the pages of it that have none are read into it when the Worker has its `PDF_RENDERER` binding, the file is of up to 16 MiB, and the scanner saw all of it. What images the scanner found in it is not asked, for the reason a PDF without text is rendered whatever the scanner counted. The text is then the conversion's from its first page heading on, to the byte where no page is read from its image, so it keeps the headings of the pages before the first with text, which a text that no page is read into leaves out. (A text that does not begin under the heading that follows those of such pages, each written as a conversion writes a page without text, is returned as such a text.) A line is taken for a page's heading only when it reads `### Page N` with N one more than the page before and comes first or after four line breaks on end, which is where a conversion puts a heading and not where it puts a line of the document's that reads like one. A page whose section holds nothing but line breaks is rendered when the text has been read up to it; the PDF is opened in the renderer for the first such page, by the same second download, so a PDF whose pages all have text is downloaded once. When the page has ink, whatever drew it (a scan, an image written into the page's content, writing or a figure drawn as shapes), its bands are read as a scan's are, and what they give stands under the page's heading as `[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]`, an empty line, the text, the cut-off and half-resolution lines where they apply, and an empty line. A page that comes out blank, cannot be drawn within the renderer's limits or reads as nothing is left as the conversion gave it; a blank page costs its render and no model call. The document's own text is worth more than the pages missing from it, so what keeps a page from being read does not fail the text: a renderer that does not open the PDF or renders it no further, and a model call that fails, are logged, that page gets `[Pages of this PDF that have no text of their own could not be read just now.]`, and no page after it is rendered. The text does fail when a read of the file fails, a changed file included, since it is then the text of another version, and when the conversion fails. It returns `hasText: true` and `transcribed: false`, and it is a text that may read the file again, whether or not a page of it proves to have no text, which is known only as it is read: it has the idle minute from the moment it is returned, and keeps its approval queue until it ends.

The model reads an image at a fixed resolution whatever the scan's, so small print is where it errs: in testing on pages sent whole, as stored, it got 98 to 100% of a page's words right, and its misses were codes, numbers and names in 6 to 8 point type, which is why the types tell the agent a transcription is not the document's own text. Of pages sent as stored, one the model is stopped partway through ends with `[The transcription of this page was cut off.]`, a blank one has a heading and no text, and one that fails errors the stream. Thinking is turned off for the model: it tripled a page's tokens and time and held the text back, without reading a poor scan any better. Logs carry page counts, page and band numbers, sizes, encodings, status codes, reasons as one word and the renderer's memory and work as numbers, never text.

The gatekeeper's `AI` binding is what `readPdf()` converts with. It runs remotely, so start the dev server with `pnpm dev-server -- --use-workers-ai-binding` (which needs a Cloudflare login) to read PDFs locally; without the binding `readPdf()` says PDF reading is not available, and everything else works. When `CF_AI_GATEWAY` is set on this Worker, conversion goes through the AI Gateway it names, which must be in the Worker's own account; otherwise it calls Workers AI directly. Its `PDF_RENDERER` service binding is the `pdf-renderer` Worker, which `pnpm dev-server` runs beside it. A Worker that binds another is deployed after it, so a deploy of this one by hand needs the renderer deployed first (`pnpm --filter @gadgets/pdf-renderer run deploy`). Where the binding is absent, scanned PDFs are read from their page images as stored and a PDF with text is returned as its text alone.

A deployment can have no PDF page read by a vision model by setting `PDF_OCR` on this Worker to `false`. The value is read with surrounding spaces trimmed and in any case; unset, empty or anything else leaves the reading on. It is a variable like `GOOGLE_DRIVE_ACCESS`: whoever deploys sets it, it is not on the admin page and the deploy wizard does not ask for it, and `pnpm dev-server` passes it through from the shell or the root `.dev.vars`. Under `false`, `readPdf()` makes no billed model call and downloads no file a second time: a PDF without text returns `hasText: false`, `transcribed: false` and an empty `text`, a PDF with text returns that text alone, without the headings of the pages before its first with text, and no text has the idle minute or keeps an approval queue. The agent-facing types say that a deployment may have turned it off, so an agent that gets an empty text for a scan knows why.

Every Drive session also offers `readFile(fileId, { offset, length })`, which streams the raw bytes of any in-scope file with content of its own (a CSV, image, PDF, Office file, anything uploaded) and returns its MIME type, size and modification time with them. With no range it reads the whole file, whatever its size; `offset` and `length` read one part of it, and the `length` returned says how many bytes the stream carries. `content` is a `ReadableStream` read from Drive as the caller reads it (RPC reads one chunk ahead of an idle caller and then waits), so a read costs the binding's Durable Object no memory that grows with the file: an agent passes the stream to a worktree's `writeBytes()`, which stores it as it arrives, or reads it itself. Nothing limits how many a binding has open at once: each holds a Drive download and that one chunk. What a read does cost is CPU, since every chunk passes through the gatekeeper's JavaScript; that grows with the file and has not been measured in production. A stream's download is let go when it is read to its end, fails or is cancelled, and after a minute with no bytes moving, whether Drive stopped sending them or the caller stopped reading, counted from when the stream is handed over, so a stalled download or a stream an agent drops unread is not held for good. A cancel that arrives while Drive has stalled is acted on only when that minute ends, because RPC delivers it after the read it is waiting on. Google Docs, Sheets and Slides are refused naming the method that opens them, as are folders, shortcuts and other `application/vnd.google-apps.*` types, which have no content to download, and a file whose `capabilities.canDownload` is false; each of these is refused after the file's metadata read is observed and before anything is downloaded. A call asks Drive for exactly its range (`Range: bytes=…`) and returns once Drive begins its answer, having read none of it: the read is checked and authorized on the answer's headers, and a refusal cancels the download. The wait for that answer to begin is timed as a whole and its body only between chunks, so a long file is not cut off while it is being read. An answer Drive gives from any other offset is refused, and a whole-file answer to a range from the start is cut to the range. Drive's download refusals are explained: `cannotDownloadFile` for a file whose owner or administrator restricted downloading it, and `cannotDownloadAbusiveFile` for one Google identified as malware or spam, which only its owner may download; the gatekeeper never sets `acknowledgeAbuse`. A file whose size changed since its metadata read fails the read, asking for it to be read again: before any byte is returned when the answer's headers show it (the size Drive's `Content-Range` reports, a `Content-Range` that ends before the range asked for, a whole-file answer's unencoded `Content-Length`, or a 416 for a range the file no longer has), and otherwise by failing the stream where the answer ends short of the range, which reaches the caller over RPC as a broken stream rather than with that message. A `Content-Range` whose total is unknown (`*`) gives no size to compare, so only an answer that ends short is caught then, and a file that grew is not. A folder binding re-proves the file is still a live direct child once before asking Drive for the bytes and again once Drive has begun answering, before the stream is returned; that second read of its metadata also fails a read whose modification time moved, catching a rewrite that keeps the size. A file moved or rewritten after that, while its bytes are still being read, does not stop the stream. That rests on Drive answering a download from the one revision that was current when the answer began, which the gatekeeper does not check: were Drive to switch revision partway, a folder binding could return bytes written after the file left the folder, and any binding bytes that do not match the size and modification time returned with them. An account or exact-file binding does not detect a same-size rewrite, since a download cannot be pinned to the revision whose metadata was read. `readFile()` needs no `AI` binding, and like `readPdf()` asks an account connected before Drive bindings requested `drive.readonly` to reconnect.

`openGoogleSlides()` returns a `GooglePresentationReadSession`: the same `getPresentation()`, `getSlides()`, and `getSlideThumbnail()` a directly bound presentation offers, read through the same code, but with no change methods and no queued changes to show. A folder binding re-proves the presentation is a live direct child before and after each read, the thumbnail render included, as it does for Docs and Sheets.

Every folder operation revalidates the selected root and the root-to-current path. A root carrying a `driveId` uses `corpora=drive`; other folders use `corpora=user`. That drive corpus requires membership of the shared drive, so a folder shared directly with a non-member connects and then fails every listing with `teamDriveMembershipRequired` — such a folder needs drive membership, not just folder access. Listing and search always carry a direct-parent predicate, so indexed content, descriptions, and OCR match only immediate children. `search()` accepts up to 50 `childFolderIds` to search inside named direct child folders instead of the positioned one: each is proved a listable direct child in a single batched check, revalidated on every page, and one request then covers them all, so polling many sibling folders no longer costs a request each. That request names every folder in one query, which is what the cap bounds, and every page reports every named folder as a subresource — so a page is refused while any collaborator checked under [the Workshop's policy](../../docs/observers.md#10-kernel-checked-subresources-per-observation) cannot list one of them, where opening folders individually keeps each disclosure independent. `openFolder()` appends one validated direct-child edge to a new capability without changing the parent capability.

Account, folder, and exact-file Drive bindings request `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, and `presentations.readonly`. A `drive` grant the account already holds covers those requirements, and so does `presentations` for `presentations.readonly`, but no Drive resource requests `drive`: only the Drive writes grant does. When a Drive resource gains a scope, an account connected before it reads that resource as ungranted unless a scope it already holds covers the new one, and the Workshop prompts the user to expand it. So `presentations.readonly` re-prompts every Drive connection made before Drive-native Slides that holds none of `presentations`, `drive.readonly`, or `drive`, and `drive.readonly`, which replaced `drive.metadata.readonly` so PDFs can be read, re-prompts every Drive connection that holds neither it nor `drive`. Until such an account re-consents, its existing Drive bindings keep listing and reading Docs and Sheets, `openGoogleSlides()` still opens a presentation but every read from it fails with Google's insufficient-scope 403, `readPdf()`, `readFile()` and a comment listing fail asking the user to reconnect, and that account cannot be admitted as a collaborator on a Drive binding, since admission requires a current Drive grant. A re-consent reaches open bindings without restarting them, since a 403 makes the token cache reload the stored token.

Drive reads report what they depend on as subresources, which the Workshop checks collaborators against (see [docs/observers.md](../../docs/observers.md) §10): `drive/file/<fileId>` for each file whose metadata a read returns, `drive/content/<fileId>` for each file whose PDF text or bytes it returns, and `drive/folder/<folderId>` for each folder it lists. A folder operation reports its positioned folder plus each disclosed direct child. `readPdf()` and `readFile()` report the file's content rather than the file alone (on a folder binding, with the folder and the file as well) because an owner or administrator can stop viewers downloading a file they can still see: a collaborator passes a content subresource only if their own account may download the file (`capabilities.canDownload`). PDF text read before content subresources existed was reported as `drive/file/<fileId>`, so a workspace that read it still admits a collaborator who can see that PDF but not download it. A Doc, Sheet or Slides presentation read through Drive reports it as a bound one does, as `docs/document/<documentId>`, `sheets/spreadsheet/<spreadsheetId>` or `slides/presentation/<presentationId>` (on a folder binding, with the folder and the file it was found in), since Google shares each of these as a whole: no tab, worksheet or slide has permissions of its own. A collaborator passes a file, its content or a folder only with their own explicit Drive resource consent and a batched metadata read, which a folder passes only if it is still a live folder they can list, and content only if they may download the file; a native file only if its API opens it for them. A file's comments are reported as the file: a comment listing reports `drive/file/<fileId>` (and, on a folder binding, the folder) on every page, an empty one included, and nothing of its own, and a page showing a comment that quotes the Doc while it still awaits approval reports the document too. So a collaborator who can open a file sees its comments in a shared chat or gadget, including a collaborator who can only view the file, to whom Google itself shows none. A comment write reports the same file (and folder) before it is queued, and the document as well when it quotes one, and adds no requirement of its own. A file's sharing is reported as the file too: a sharing call (`listAccess()`, `share()`, `updateAccess()`, `unshare()`) reports `drive/file/<fileId>` (and, on a folder binding, the folder) and nothing of its own, before it returns or queues anything. So a collaborator who can open a file sees who it is shared with in a shared chat or gadget, addresses and roles included: what a listing returned, and the grantee an approval names. Google itself withholds that from an account that cannot share the file, which it refuses the file's permission list. That the connected account can share the file is a check of that account alone, as the check that it can comment is, and adds no requirement. A move reports the file and the folder it goes into, as files (and, on a folder binding, the positioned folder), and nothing about who has access. An account binding does not report the folder the file leaves, whose ID is the file's own metadata, and neither binding reports the connected account's own My Drive root as the folder a file goes into, which no other account can see: either would be a requirement a collaborator could never pass for a file at the top level of My Drive, or moved to it. A sharing call refuses that root as its target, for the same reason, before it reports anything. A requirement governs what a call discloses, not who may approve: a collaborator with the build role may approve any pending action, a sharing change or a move among them. These answers can come from the collaborator's account cache: it reuses an allowed answer for up to 15 minutes and a denial for up to 15 seconds. Before a collaborator opens the workspace, the gatekeeper still requires that Drive consent and rechecks, uncached, the bound folder or file and any units remembered before reads reported subresources. It also still refuses a binding that an earlier release closed to collaborators after an owner-relative read, since that read recorded nothing to check them against. Hidden rejected candidates are not disclosed or reported.

A read whose answer is relative to the connected account rather than to a file — an account binding's search with no match, a folder it can't list, a file it can't see, a file it can't comment on, when a comment listing or a comment write is refused for that, a file it can't share, whose sharing is then neither read nor changed, the top level of its own My Drive named as a sharing target, or a move it isn't allowed to make — reports no subresources, so it restricts no collaborator. A comment or sharing call refused for a file the account can't comment on or share has already reported the file (and, on a folder binding, the folder) when it checked that the file is in the binding's scope, and the refusal adds nothing to that. A folder binding's search reports its positioned folder, and any child folders it names, even when nothing matches. Invisible-file 403 and 404 probes on an account binding both report `[]` and return the same generic unavailable-file error, without Google's per-file reason. They therefore cannot leave an unsatisfiable sharing requirement. Account-wide failures still propagate unchanged. Missing OAuth scopes (`insufficientPermissions`) also propagate unchanged without recording a file-access observation, for both account and folder bindings. An empty search returns an empty result.

### Drive comments

Every Drive session offers `listComments(fileId)` on any in-scope file (for a folder binding, a live direct child). Reading comments is an observation, recorded after the file's own, and it reports what reading the file reports and nothing of its own: the file, on a folder binding the folder too, and the document on a page showing a comment that quotes it while it still awaits approval. So whoever can open the file, and on a folder binding list its folder, may see its comments in a shared chat or gadget, a collaborator who can only view the file included, to whom Google itself shows none. The connected account is another matter. Google shows a file's comments only to accounts that can comment on it, and answers the listing of an account that can only view the file with an empty list and no error, which would read as a file without comments. So before it lists, the binding checks that the connected account can comment on the file, and refuses, saying why, a file it can only view. That check is of the connected account alone: its refusal reports nothing, and it adds no requirement for collaborators. A listing is read with the Drive resources' `drive.readonly`; on an account connected before they requested it, the listing fails asking the user to reconnect, as `readPdf()` does. A comment lists with its text, its replies, its times as `Date`s and, when Drive reports one, `quotedText`, the passage of the file it is attached to, as text.

A read and write binding adds `comment(fileId, text, { quote?, tabId? })`, `suggestEdit(fileId, oldText, newText, { note?, tabId? })`, `reply(fileId, commentId, text)` and `resolve(fileId, commentId, text?)`. Every write is queued for approval and returns the pending item; `listComments()` shows the binding's own undecided writes marked `pending`, a reply or resolve under the comment it answers. A suggested edit returns a `DocSuggestion` instead, which no listing shows, queued or made: Drive lists no suggestion. The action kind is **Drive comments**, which is off for auto-approval until the user turns it on, and every comment write is auto-approvable under it. Google emails a comment's or a reply's text to each person it mentions, an address written after `@` or `+`, whether or not that person can open the file. The gatekeeper does not look for mentions, so with the kind's rule on such a write is posted without asking, like any other comment: the `write-gatekeeper` skill's auto-approval policy lists it as an exception to its rule against sending content as the user to people outside the bound resource. A pending item's `pending:<n>` ID names it only until the write is decided, and a reply to, or resolve of, a `pending:` ID is refused: as still waiting while its comment is, and otherwise as naming no waiting comment, with a pointer to list the file's comments for the Drive ID. A comment's `resolved` is Drive's own state, so a queued resolve shows as a pending reply and not as a resolved comment. A second resolve of a comment that has one queued is refused, and so is a reply to it, which would reopen the comment once the resolve is applied: a closing reply is the resolve's own text, so a resolve already queued gets one by being rejected and queued again with it. The refusal looks at what waits when the call is made: of two calls made at once both can queue, and the one approved second fails its check at approval. A write is refused on a read-only binding, and on one whose account does not hold the Drive writes grant, when it is queued and again when it is approved. Approved on a read-only binding it fails; approved while the account does not hold the grant it stays pending, and an approval made once the account allows changes posts it. A binding whose Google account was disconnected records no grant either, but allowing changes cannot restore it, so its writes fail as its reads do, saying that the connection has to be made again. Both times the gatekeeper also checks that the file is still in the binding's scope (a folder binding re-proves each folder from the bound root down to the file), that the connected account can comment on it, and, for a reply or resolve, that the comment still exists and that its text is what it was when the write was queued, anywhere in it: one edited since fails, to be queued again. Before it is queued a write reports the file, as a listing does, and the document when it quotes one; that the account can comment is a check, not a report, and a refusal for it reports nothing. A write is refused on a folder, which takes no comments: Drive reports that a folder can be commented on and then answers the comment with a server error, every time. An approval shows what is posted first, then the file, by its ID and by the name it had when the write was queued. One of a reply or resolve shows the comment it answers and its author as fields, which are displayed as written and never as Markdown, since anyone who can comment on the file wrote them; it shows the comment whole, or the first 200 characters of a longer one, which it then says. A reply to a comment resolved since it was queued is refused rather than reopening the comment its approval said nothing about. Google emails the file's owner about new comments.

Comments are plain text. Drive cannot attach one to text in the file: Docs lists a comment made through Drive under "Original content deleted", with or without an anchor. So a comment with a `quote` is made through the Docs API instead, attached to the quoted text as one made in the editor is, and `suggestEdit` makes a real suggestion, sent in the Docs API's `SUGGEST` write mode as one delete and insert, which someone who can edit the Doc accepts or rejects there; a commenter may make one. Its `note` is posted as a reply on the suggestion once it is made. Both work only on native Google Docs, read through the Docs API as a content observation, and the quoted text must occur exactly once in the chosen tab (by default, the first) when the write is queued and again when it is approved, when the Doc is read again and the write is sent on the revision that read saw: if the text no longer occurs exactly once the write fails, and if the Doc changed in between it is refused and the next approval places it on the Doc as it is then. Drive lists a comment made through Docs under the same ID, so replies, resolves and the check before a retry stay on Drive; a retry of a suggestion looks for the account's suggestion from around the earlier send by Google's summary of it, and fails as of unknown outcome when it cannot tell. Docs makes no comment that is attached to nothing, so a comment without a quote is still made through Drive. Google limits a comment to 4096 bytes of UTF-8 through Drive and 2048 through Docs, which also limits a suggestion's note, checked on the exact text that is sent; a quote or `oldText` is capped at 500 characters, `newText` at 1000 characters without line breaks, and empty text is refused, but for an empty `newText`, which suggests deleting `oldText`. A `newText` with a character Google Docs drops from inserted text (a control character or a private-use code point) is refused rather than stripped, so the approval shows exactly what the Doc gets, and so is an `oldText` that runs across an element that reads as no text, such as a dropdown or a horizontal line, which the suggestion would delete unseen. Replying to a resolved comment reopens it, as Google does; resolving a resolved comment is refused, although Google would add another resolve.

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

### Keeping Drive read-only

A deployment can keep Google Drive read-only by setting `GOOGLE_DRIVE_ACCESS` on this Worker to `read`. The value is read with surrounding spaces trimmed and in any case, so `Write` is `write`. The default, and what an unset or empty value means, is `write`; any other value means `read`. It is a variable, like the Microsoft 365 gatekeeper's access settings: whoever deploys sets it, it is not on the admin page, and `pnpm dev-server` passes it through from the shell or the root `.dev.vars`. Under `read` no Drive connection makes a change. The connect dialog offers no **Access** choice, and a request that asks for read and write opens read-only and says so. A resource URL carrying `?access=write` is refused when a connection is made from it. A connection that was made read and write behaves as a read-only one for as long as the setting holds: `getScope()` reports `access: "read"`, its types are the read-only ones, it lists no action kind, and every write refuses, saying that the deployment keeps Drive read-only: a comment, a sharing change and a move, and `listAccess()` with them. A write queued before the setting and approved under it is not sent; it stays pending, and is applied if it is approved after the setting is lifted. Under `read` no consent asks Google for the `drive` scope either: an account that went through **Allow changes** keeps the writes grant among its recorded grants, and is asked for the scope again by the first consent after the setting is lifted. The setting takes nothing back: which scopes the account's token holds is Google's to say, and what the app may do is still removed on the Google Account's own page of third-party access. It covers Drive connections only. Two things are outside it: a Doc, spreadsheet or presentation connected or created as its editable type, which is another resource type and is turned off on the admin page, and the connect dialog's **Convert**, which still copies an Office file into the user's Drive as a Google file when the user asks for it.

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

### "This app is blocked" or quota errors

You may have hit rate limits or your project may have issues. Check the [Google Cloud Console](https://console.cloud.google.com/) for any alerts or quota warnings on your project.
