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

The Google Drive API powers the Docs, Sheets, and Slides resource pickers, Drive discovery, and Drive scope checks. Native document, spreadsheet, or presentation content opened from a Drive binding is read through the Google Docs, Google Sheets, or Google Slides API. Direct Google Doc reads and edits still go through the Docs API, direct spreadsheet reads and edits go through the Sheets API, and direct presentation reads and edits go through the Slides API.

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
requests scopes granularly per resource type, not all at once: connecting a Gmail mailbox asks
only for the Gmail scopes, a Google Doc only for the Docs scopes, and so on (identity is always
included). Across all resource types, the gatekeeper can request:

- `openid`, `userinfo.profile`, and `userinfo.email` to identify the connected account.
- `gmail.modify` for Gmail thread reads, organization, replies, forwards, and sending. This single scope already includes label access and sending.
- `documents` for direct Google Docs reads, edits, and creation; `documents.readonly` for native Docs opened from account-wide, folder, or exact-file Drive bindings.
- `drive.metadata.readonly` for the Docs, Sheets and Slides pickers. Google classifies this as a restricted scope.
- `drive.readonly` for account-wide, folder, and exact-file Drive bindings: the Drive picker, discovery, file metadata, folder descendant proofs, native-file scope checks, and downloading a PDF to read its text with `readPdf()`. Google classifies this as a restricted scope too, so every Drive resource here needs restricted-scope verification.
- `drive.readonly` and `drive.file` for the Office import grant (`https://docs.google.com/import`), which converts an Office file into a Google Docs, Sheets or Slides copy (see [Office files](#office-files)). Only the connect dialog's **Convert** button asks for it, by incremental consent, the first time an account converts a file; using a copy made before reads only metadata and asks for nothing. Once held, it is part of the account's recorded grants, so a reconnect asks for it again. `drive.readonly` lets the gatekeeper see a source file this OAuth client did not create, which `drive.file` alone cannot, and `drive.file` lets it create the copy. The grant is private to the gatekeeper: it is not a resource, so it is never offered on connect, listed, bound, or shown among an account's granted resources, and admins cannot turn it off separately from Docs, Sheets and Slides. Once held, `drive.readonly` lets the account's token read any Drive file, so bindings stay limited by the gatekeeper's code rather than by the token. A verified OAuth app must add both scopes to its consent screen, and `drive.readonly` is a restricted scope.
- `drive.readonly` for the shared-drives grant (`https://drive.google.com/drive/shared-drives`), which lets the Drive picker list the shared drives the account belongs to, since Drive's `drives.list` accepts no narrower scope. Only the picker's **Allow access** button asks for it, by incremental consent, the first time an account opens Shared drives; once held, a reconnect asks for it again. It is private to the gatekeeper as the Office import grant is, and an account holding that grant is still asked once, since a private grant counts only once it has been asked for, not because its scopes happen to be held.
- `spreadsheets` to read metadata, bounded cell ranges and their formatting from directly selected spreadsheets, edit their values, sheets, rows, columns and formatting with approval, and create spreadsheets. The switch from `spreadsheets.readonly` retracted every existing Sheets grant, including one derived from `drive.readonly`: owners re-consent the next time they connect a spreadsheet, and collaborators observing an existing Sheets binding are asked to grant read-write `spreadsheets` the next time they open its workspace. A `spreadsheets` grant covers the Drive resources' `spreadsheets.readonly`.
- `spreadsheets.readonly` to read native Sheets opened from account-wide, folder, or exact-file Drive bindings.
- `presentations` to read, edit, and create directly selected presentations, and to render slide thumbnails; `presentations.readonly` to read and render native Slides opened from account-wide, folder, or exact-file Drive bindings. Google counts each thumbnail as an expensive read, limited to 60 a minute per user and 300 per project.
- `calendar.calendarlist.readonly` so the resource picker can list calendars.
- `calendar.events` to manage selected calendar and check calendar availability.
- `chat.spaces.readonly`, `chat.messages`, and `chat.memberships.readonly` for every Chat resource. A whole-account Chat connection adds `chat.users.readstate.readonly` for its unread-only search, and `chat.spaces.create` and `directory.readonly` to start direct messages and group chats with people in the connected account's Workspace directory. Starting a conversation is its own approval kind, separate from sending in an existing one, and people outside the organization can't be added to a new conversation.
- `bigquery` for BigQuery dry-runs and queries. This is intentionally broader than `bigquery.readonly` because dry-runs use `jobs.insert`; the gatekeeper enforces read-only SQL and resource scope checks before running queries.

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
10. Use the picker to choose the mailbox scope, document, presentation, project, dataset, or table to connect, or for Google Drive, the whole of Drive, a folder, or a single file.
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

Google Docs, Sheets and Slides are creatable resource types: an agent can ask for a new one with
`createExternalResource`, giving a one-line title (trimmed, at most 256 characters), and its binding
works at once, before anything exists at Google. Until the creation is approved the gatekeeper
simulates an empty file: a Doc reads as one empty tab and queues edits as usual, a spreadsheet as
one empty `Sheet1` of 1000 × 26 cells, which takes no change until it exists, and a presentation as the one Google creates, a 16:9 deck
with a title slide, which queues changes as usual. Of the default theme's layouts it offers only
five (title slide, section header, title and body, title only, and blank); the others become
available once the presentation exists. Nothing reaches Google and no account is involved.

The approver picks which of their connected Google accounts to create the file in; it lands in
that account's My Drive, and the binding switches to the real file. Doc edits queued against the
simulation then apply to the created document like any other edit, and Slides changes apply to the
created presentation unchanged.

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

Google's create calls take no idempotency key. A retried approval after a lost reply binds the file
already created (the gatekeeper records it), but a file can still be orphaned in the approver's
Drive: a create request that times out or fails with a 5xx after Google acted, a crash between
Google's reply and that record being written, or a creation rejected after an approval whose
success was lost. Every created file's ID is logged (`google.creation.file.created`), so an orphan
can be found.

## Office files

Google's Sheets, Docs and Slides APIs cannot edit an Office file stored in Drive (`.xlsx`, `.xls`,
`.xlsm` and `.ods`; `.docx`, `.doc`, `.odt` and `.rtf`; `.pptx`, `.ppt` and `.odp`): Sheets and
Slides refuse to open one, and Docs reads one but refuses every edit to it. So the Docs, Sheets and
Slides pickers list these files too, named with their extension and marked "Makes a Google …
copy", and connecting one converts it. The connect dialog says what converting does and offers
**Convert**, which has Drive copy the file into the native type (`files.copy` with the native MIME
type: Google converts it, and no file content passes through the Worker). The copy is named after
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

## Google Docs request costs

Connecting a Doc reads its Drive metadata once, to refuse an Office file (see
[Office files](#office-files)). A read costs one full `documents.get`, replayed for 10 seconds and then revalidated by a
revision-only `get`. Queuing an edit costs nothing more. Applying one costs a full `get` (the
edit is materialized against the current revision), the `batchUpdate` carrying the edit and its
write marker, and a second `batchUpdate` removing the marker; the document is reread after it only
when more edits are queued behind it, since they must be replayed over the new revision.

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

A batch is queued as one of three action kinds, which share everything but which ones a user may
let apply without asking: "Slide text edits" (only text edits), "Slide formatting and arrangement"
(only formatting text, setting no link or font, since Google keeps their whole strings; formatting
paragraphs and shapes; moving or stacking elements; and setting slides' backgrounds to a colour,
`"none"` or `null`), and every other batch, mixed ones included, which always waits for approval.
A picture background, any change to a layout or master, and theme colours therefore always wait:
they change slides the user is not looking at, or make Google fetch a URL.

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
only as it creates the slide, so they cannot be edited until it is approved. Adding a slide always
waits for approval.

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
"Sheet value edits", which a user may let apply without asking; a batch with any formula always waits for approval.
A formula naming `IMPORTRANGE`, which reads another spreadsheet and so escapes the binding, or
`IMPORTDATA`, `IMPORTHTML`, `IMPORTXML`, `IMPORTFEED` or `IMAGE`, which make Google fetch a URL, is
refused in any letter case, outside string literals. Formulas the spreadsheet already holds are
not inspected, and one of its named functions could wrap a refused function, which is why every
formula needs approval.

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
of each sheet a batch adds. A batch with any structural change always waits for approval.
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
apply without asking; mixed with any other change it waits for approval. `readFormats()`, which a
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

## Google Drive read-only bindings

Drive exposes three permanent resource URL forms:

- `https://drive.google.com/drive/my-drive` selects everything the connected account can read in Drive. Despite the `my-drive` URL it is not limited to My Drive: any ID the account token resolves is in scope. Listings use `corpora=user`, which Google defines as My Drive items the account created or opened plus items shared directly with it, so a shared drive's contents may be readable by ID without appearing in a listing. Bind a folder or file when this authority is too broad.
- `https://drive.google.com/drive/folders/<folderId>` selects one folder or shared-drive root.
- `https://drive.google.com/file/d/<fileId>/view` selects one file by its immutable ID.

The Drive picker opens on Google Drive, whose own choice binds the whole account, above My Drive, Shared drives and Shared with me. Locations list a page at a time. Search spans My Drive, "Shared with me" and every shared drive the account is a member of (`corpora=allDrives`) and says where each result lives, and a Drive, Docs, Sheets or Slides link pasted into it answers with the one folder or file the link names. A pre-filled folder or file opens where it lives, with breadcrumbs up to My Drive or its shared drive, or with none when an ancestor is out of reach or more than 20 folders up. All of this runs on the Drive resources' own grant except listing Shared drives, which also needs the shared-drives grant above: until the account holds it, opening Shared drives offers **Allow access**, and a shared drive's folders stay reachable through search, a pasted link or a pre-filled URL. Folders whose children the account cannot list are shown but cannot be opened or bound; on a pre-filled node's breadcrumbs, where Google's [folders with limited access](https://developers.google.com/workspace/drive/api/guides/limited-expansive-access) put them above a file shared directly, they can be opened but are not offered. A shortcut stands for its target, which a listing says nothing of, so a page's shortcut targets are read in one batch: a shortcut left behind when its target was deleted, unshared or trashed is left out, and one to a folder is judged as that folder would be. A search Google reports as incomplete fails rather than presenting partial results as complete.

A folder URL carrying `?resourcekey=` is not supported: the key is dropped, and the binding then fails with a Drive 404 for anyone whose access to that folder comes from the link rather than from a direct grant. Google requires resource keys only for items shared by link before September 2021, and only for link-access users — an owner or anyone granted access directly is unaffected, even when the URL they paste happens to carry a key. Such a folder needs direct access to connect.

The agent-facing `GoogleDriveReadSession` covers account and exact-file bindings. `GoogleDriveFolderSession` is positioned at the selected root and exposes only its current folder's direct children: `list()`, provider-side structured `search()`, `getEntry()`, native Doc/Sheet/Slides opens, and `openFolder()` for one live direct child. Listing and search return disposable RPC cursors; child folders and native content sessions are independently disposable capabilities. There is no built-in recursive folder search, traversal pager, raw Drive `q`, file write, shortcut traversal, or arbitrary download/export.

Both sessions offer `readPdf(fileId)`, which downloads an in-scope PDF and returns its text as Markdown, converted by Workers AI's `toMarkdown()`. It downloads with the Drive resources' `drive.readonly`; on an account connected before they requested it, `readPdf()` fails asking the user to reconnect. The file is checked against the binding's scope, and must be a PDF, before anything is downloaded, and a folder binding re-proves it is a live direct child after the download, as for a native read: the token's `drive.readonly` reaches any Drive file, so scope is enforced in code. Neither the PDF nor its text is held in memory: the download streams straight into the conversion request (through the `AI` binding's own `fetch`, since the binding's `toMarkdown()` takes a whole `Blob`), and `text` is a `ReadableStream` of UTF-8 Markdown read from the conversion's response as it is converted, so the agent bounds how much it reads. `readPdf()` reads the response only until the text begins before it returns, so `hasText` is already known. Pages are separated by `### Page N` headings, and pages before the first with text are left out. There is no download or text cap: a PDF Workers AI cannot convert, including one too large for it, fails. Nothing is OCR'd, so a scanned or image-only PDF returns `hasText: false` and an empty `text`. Conversion runs under a fixed file name with its images left undescribed, so no Drive file name reaches Workers AI and no billed model call is made.

The gatekeeper's `AI` binding is what `readPdf()` converts with. It runs remotely, so start the dev server with `pnpm dev-server -- --use-workers-ai-binding` (which needs a Cloudflare login) to read PDFs locally; without the binding `readPdf()` says PDF reading is not available, and everything else works. When `CF_AI_GATEWAY` is set on this Worker, conversion goes through the AI Gateway it names, which must be in the Worker's own account; otherwise it calls Workers AI directly.

`openGoogleSlides()` returns a `GooglePresentationReadSession`: the same `getPresentation()`, `getSlides()`, and `getSlideThumbnail()` a directly bound presentation offers, read through the same code, but with no change methods and no queued changes to show. A folder binding re-proves the presentation is a live direct child before and after each read, the thumbnail render included, as it does for Docs and Sheets.

Every folder operation revalidates the selected root and the root-to-current path. A root carrying a `driveId` uses `corpora=drive`; other folders use `corpora=user`. That drive corpus requires membership of the shared drive, so a folder shared directly with a non-member connects and then fails every listing with `teamDriveMembershipRequired` — such a folder needs drive membership, not just folder access. Listing and search always carry a direct-parent predicate, so indexed content, descriptions, and OCR match only immediate children. `search()` accepts up to 50 `childFolderIds` to search inside named direct child folders instead of the positioned one: each is proved a listable direct child in a single batched check, revalidated on every page, and one request then covers them all, so polling many sibling folders no longer costs a request each. That request names every folder in one query, which is what the cap bounds, and it records every named folder as an observation — so one that later stops being listable fails collaborator admission for the whole set, where opening folders individually keeps each disclosure independent. `openFolder()` appends one validated direct-child edge to a new capability without changing the parent capability.

Account, folder, and exact-file Drive bindings request `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, and `presentations.readonly`. A `drive` grant the account already holds covers those requirements, and so does `presentations` for `presentations.readonly`, but no Drive resource ever requests `drive`. When a Drive resource gains a scope, an account connected before it reads that resource as ungranted unless a scope it already holds covers the new one, and the Workshop prompts the user to expand it. So `presentations.readonly` re-prompts every Drive connection made before Drive-native Slides that holds none of `presentations`, `drive.readonly`, or `drive`, and `drive.readonly`, which replaced `drive.metadata.readonly` so PDFs can be read, re-prompts every Drive connection that holds neither it nor `drive`. Until such an account re-consents, its existing Drive bindings keep listing and reading Docs and Sheets, `openGoogleSlides()` still opens a presentation but every read from it fails with Google's insufficient-scope 403, `readPdf()` fails asking the user to reconnect, and that account cannot be admitted as a collaborator on a Drive binding, since admission requires a current Drive grant. A re-consent reaches open bindings without restarting them, since a 403 makes the token cache reload the stored token.

Drive observations are typed as files or listable folders. A folder operation observes its positioned folder path plus each disclosed direct child, and native reads observe the file independently. Before a collaborator opens the workspace, the gatekeeper requires their own explicit Drive resource consent and rechecks remembered units with fresh batched metadata reads; folder units must still be live listable folders. Hidden rejected candidates are not disclosed or remembered.

A search that exhausts with no match is owner-relative and cannot be verified against a file. That read is audited, withheld from current observers, and permanently closes later sharing only after the positioned folder path is revalidated. Intermediate empty provider pages do not trigger the restriction.

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
