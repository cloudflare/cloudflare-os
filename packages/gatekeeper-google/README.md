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

The Google Drive API powers the Docs, Sheets, and Slides resource pickers, Drive discovery, and Drive scope checks. Native document, spreadsheet, or presentation content opened from a Drive binding is read through the Google Docs, Google Sheets, or Google Slides API. Direct Google Doc reads and edits still go through the Docs API, direct spreadsheet reads go through the Sheets API, and direct presentation reads and edits go through the Slides API.

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
- `documents` for direct Google Docs reads and edits; `documents.readonly` for native Docs opened from account-wide, folder, or exact-file Drive bindings.
- `drive.metadata.readonly` for the Docs, Sheets, Slides, and folder pickers, account-wide Drive discovery, exact-file metadata, folder descendant proofs, and native-file scope checks. Google classifies this as a restricted scope, so every Drive resource here needs restricted-scope verification.
- `spreadsheets.readonly` to read metadata and bounded cell ranges from directly selected spreadsheets or native Sheets opened from account-wide, folder, or exact-file Drive bindings.
- `presentations` to read and edit directly selected presentations, and to render slide thumbnails; `presentations.readonly` to read and render native Slides opened from account-wide, folder, or exact-file Drive bindings. Google counts each thumbnail as an expensive read, limited to 60 a minute per user and 300 per project.
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
5. Choose a Google resource type: Gmail, Google Doc, Google Spreadsheet, Google Slides Presentation, Google Drive Account, Google Drive Folder, Google Drive File, Google Calendar, or BigQuery.
6. If prompted, connect a Google account.
7. You should be redirected to Google's consent screen in a new tab.
8. The consent screen acts extra-scary since this is an "unverified" test app.
9. After granting access, the tab closes, and you're back to Gadgets.
10. Use the picker to choose the mailbox scope, document, presentation, folder, Drive file, project, dataset, or table to connect. (The Google Drive Account resource covers the whole account, so it has no picker.)
11. Create the connection. Ask the agent what it can do, or ask it to write a gadget using the new binding.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

## Google Chat and Gmail new-message hooks (optional)

Gadgets can watch a Chat conversation for new messages (see `docs/google-chat-capabilities.md`),
and a Gmail inbox, label or thread for new mail (`subscribeNewMessages()` in `src/types.d.ts`).
Google delivers both through Pub/Sub, Chat's by Workspace Events and Gmail's by `users.watch`, so
this needs a public URL and these steps in the same Cloud project as the OAuth client:

1. Enable the **Google Workspace Events API**, the **Cloud Pub/Sub API**, and the **Gmail API**.
2. Create a Pub/Sub topic, and grant both `chat-api-push@system.gserviceaccount.com` and
   `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
3. Create a service account for push authentication (it needs no roles).
4. Create a **push** subscription on the topic with endpoint
   `${BASE_URL}/pubsub` (e.g. `https://example.com/gatekeeper/google/pubsub`), **Enable
   authentication** with the service account from step 3, and audience set to that same endpoint.
5. Set both values for this worker (in `.env` locally):

   ```bash
   PUBSUB_TOPIC=projects/your-project/topics/your-topic
   PUBSUB_PUSH_SERVICE_ACCOUNT=your-push-account@your-project.iam.gserviceaccount.com
   ```

If the deployment sits behind Cloudflare Access, add a bypass for `/gatekeeper/google/pubsub`;
the worker instead accepts only pushes whose Google-signed token names that endpoint as audience
and `PUBSUB_PUSH_SERVICE_ACCOUNT` as sender. That token proves a push came through the push
subscription, not who published to the topic, so the topic's Pub/Sub principals are trusted with
hooked messages: anyone who can subscribe to it reads them all, and anyone who can publish to it
can inject messages into hooks. Grant those roles to no one beyond step 2. A Gmail push carries
only a mailbox address and a history ID, so a forged one can only make the worker read that
mailbox's new history with the connected account's own credentials. Without these settings hooks
are refused and everything else works as before.

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

## Known limitations

Very large Google Docs can exceed Durable Objects' 2 MB value limit after Markdown conversion,
causing tab listing, content reads, and edits to fail.

A Google Slides presentation's slide summaries come from one response capped at 10 MiB. It holds
the text of every slide's shapes and speaker notes, but no styles or geometry: about 4 KiB a slide
on a live deck, so a presentation needs thousands of slides to exceed it. Slide content is read
one slide at a time, capped at 2 MiB each. While changes await approval, reads also fetch the
slides they address, so each can be checked as approving it would: slide content reads the other
slides of any batch touching a slide it shows, since a batch applies all or none, and the
summaries read every slide a queued batch changes, since they hold no tables or grouped shapes.
Large batches awaiting approval therefore cost reads more requests against Google's per-user quota.

## Google Slides edits

A directly bound presentation accepts four changes, each queued for approval: `updateSlides()`,
`duplicateSlide()`, `deleteSlide()`, and `moveSlides()`. Changes are journaled with the kit's
`ActionJournal`, and apply in the order they were queued.

`updateSlides()` takes up to 50 changes applied together: find-and-replace or whole-text
replacement in shapes, table cells, and speaker notes, text and paragraph formatting (including
bullets), shapes and their fill, outline and vertical alignment, moving, resizing, rotating,
stacking and deleting elements, alt text, images by public `https:` URL, and tables with their
rows, columns and cell fills. Elements a batch creates get IDs the gatekeeper mints: later changes
in the batch can address one by its `ref`, and later batches by the ID returned for it. An image
URL is never fetched by the gatekeeper: Google downloads it when the change is applied, so nothing
is read from it before approval.

A batch is queued as one of three action kinds, which share everything but which ones a user may
let apply without asking: "Slide text edits" (only text edits), "Slide formatting and layout"
(only formatting text, paragraphs and shapes, and moving or stacking elements, setting no link or
font, since Google keeps their whole strings), and every other batch, mixed ones included, which
always waits for approval.

Reads show queued changes as if applied, by replaying them over Slides' own JSON before it is
projected; thumbnails show the presentation as saved. Each change is replayed as Google documents
its request, and one the replay cannot follow exactly is refused instead: a bullet list started
right after another list item, which Google may join to that list; table rows or columns inserted
or deleted beside a merged cell; deleting a grouped element that would leave its group with one;
rotating a video, which Google cannot shear; and new text filling a list item whose bullet is
styled apart from its text, which Google would restyle to match. The replay makes no claim about
what Google renders: shrinking text to fit, wrapping, the box Google fits an image to, the size it
gives a new table, and the formatting new table rows and columns take appear once applied. It
does follow Google in turning a shape's autofit off once its text changes, fixing the font sizes
and line spacings the text sets at what the autofit had shrunk them to. A replacement takes the
style of the text it replaces, and text left unchanged at either end of a match is not rewritten,
so it keeps its own. Formatting a whole list paragraph also updates its bullet's style in replay,
which later replacements use when checking whether they can keep that style. Setting a font sets
it at regular weight, so the text is no longer bold unless the change says so. A slide number or
other AutoText can only be replaced whole.

Each approved change is one `batchUpdate`, planned against a fresh read and pinned to its revision
with `requiredRevisionId`, so a change applies only to the text it was planned against: one that
no longer applies fails without writing, and a concurrent edit makes Google refuse the write so it
is planned again. A write whose response is lost may have been committed, so it is only ever
resent as first sent, at the same revision. If that is refused, a read decides whether it landed,
counting only what the write would have changed: an element it created that it does not also
delete, an element it deleted that was there before, text it edited, and a table it adds or
deletes rows or columns of, by its size and its cells' positions, spans and text. If the read
cannot tell, as for a batch that only formats or moves elements, the change is marked as having an
unknown outcome and never retried.

Google returns a presentation's revision only to an account that can edit it, so a view-only
account can read a presentation but every change to it fails. A queued change is stored in one
Durable Object value, so each is capped at 100 KiB.

## Google Drive read-only bindings

Drive exposes three permanent resource URL forms:

- `https://drive.google.com/drive/my-drive` selects everything the connected account can read in Drive. Despite the `my-drive` URL it is not limited to My Drive: any ID the account token resolves is in scope. Listings use `corpora=user`, which Google defines as My Drive items the account created or opened plus items shared directly with it, so a shared drive's contents may be readable by ID without appearing in a listing. Bind a folder or file when this authority is too broad.
- `https://drive.google.com/drive/folders/<folderId>` selects one folder or shared-drive root.
- `https://drive.google.com/file/d/<fileId>/view` selects one file by its immutable ID.

The folder picker is one search over `corpora=allDrives`, which spans My Drive, "Shared with me", and every shared drive the account is a member of. It runs on the baseline `drive.metadata.readonly` grant and asks for no broader scope. It returns a single provider page of suggestions, so it is an interactive search rather than an exhaustive enumeration: a known folder or shared-drive root that does not surface can still be connected by supplying its `https://drive.google.com/drive/folders/<folderId>` URL, which opens the picker prefilled. Folders whose children the account cannot list are not offered, and a search Google reports as incomplete fails rather than presenting partial results as complete.

A folder URL carrying `?resourcekey=` is not supported: the key is dropped, and the binding then fails with a Drive 404 for anyone whose access to that folder comes from the link rather than from a direct grant. Google requires resource keys only for items shared by link before September 2021, and only for link-access users — an owner or anyone granted access directly is unaffected, even when the URL they paste happens to carry a key. Such a folder needs direct access to connect.

The agent-facing `GoogleDriveReadSession` covers account and exact-file bindings. `GoogleDriveFolderSession` is positioned at the selected root and exposes only its current folder's direct children: `list()`, provider-side structured `search()`, `getEntry()`, native Doc/Sheet/Slides opens, and `openFolder()` for one live direct child. Listing and search return disposable RPC cursors; child folders and native content sessions are independently disposable capabilities. There is no built-in recursive folder search, traversal pager, raw Drive `q`, file write, shortcut traversal, arbitrary download/export, or Workers AI extraction.

`openGoogleSlides()` returns a `GooglePresentationReadSession`: the same `getPresentation()`, `getSlides()`, and `getSlideThumbnail()` a directly bound presentation offers, read through the same code, but with no change methods and no queued changes to show. A folder binding re-proves the presentation is a live direct child before and after each read, the thumbnail render included, as it does for Docs and Sheets.

Every folder operation revalidates the selected root and the root-to-current path. A root carrying a `driveId` uses `corpora=drive`; other folders use `corpora=user`. That drive corpus requires membership of the shared drive, so a folder shared directly with a non-member connects and then fails every listing with `teamDriveMembershipRequired` — such a folder needs drive membership, not just folder access. Listing and search always carry a direct-parent predicate, so indexed content, descriptions, and OCR match only immediate children. `search()` accepts up to 50 `childFolderIds` to search inside named direct child folders instead of the positioned one: each is proved a listable direct child in a single batched check, revalidated on every page, and one request then covers them all, so polling many sibling folders no longer costs a request each. That request names every folder in one query, which is what the cap bounds, and it records every named folder as an observation — so one that later stops being listable fails collaborator admission for the whole set, where opening folders individually keeps each disclosure independent. `openFolder()` appends one validated direct-child edge to a new capability without changing the parent capability.

Account, folder, and exact-file Drive bindings request `drive.metadata.readonly`, `documents.readonly`, `spreadsheets.readonly`, and `presentations.readonly`. A broader `drive.readonly` or `drive` grant the account already holds covers those requirements, and so does `presentations` for `presentations.readonly`, but neither broader Drive grant is ever requested here. When a Drive resource gains a scope, an account connected before it reads that resource as ungranted unless a scope it already holds covers the new one, and the Workshop prompts the user to expand it. So `presentations.readonly` re-prompts every Drive connection made before Drive-native Slides that holds none of `presentations`, `drive.readonly`, or `drive`. Until such an account re-consents, its existing Drive bindings keep listing and reading Docs and Sheets, `openGoogleSlides()` still opens a presentation but every read from it fails with Google's insufficient-scope 403, and that account cannot be admitted as a collaborator on a Drive binding, since admission requires a current Drive grant. A re-consent reaches open bindings without restarting them, since a 403 makes the token cache reload the stored token.

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
