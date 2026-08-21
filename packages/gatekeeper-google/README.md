# Gatekeeper Google

This package provides Google OAuth integration for Gadgets. It serves two purposes:

- **Sign-in:** when `google` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Google" appears on the login page. Sign-in requests only minimal scopes (`openid`,
  `userinfo.email`, `userinfo.profile`) to read the account's **verified email** (`email_verified`),
  which becomes the user's identity.
  The sign-in grant is transient (discarded right after the email is read).
- **Connections:** when a user connects Google (or signs in and later connects it), the scopes for
  the selected resources (Gmail, Docs, Sheets, Drive, Calendar, or BigQuery — see below) are requested
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

You'll need to enable the Google APIs that you want to use. Currently supported: Gmail, Google Docs, Google Sheets, Google Drive, Google Calendar, and BigQuery.

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
14. Go back to the Library, search for "Google Calendar API"
15. Click on **Google Calendar API** in the results
16. Click **Enable**
17. Go back to the Library, search for "BigQuery API"
18. Click on **BigQuery API** in the results
19. Click **Enable**

The Google Drive API powers the Docs and Sheets resource pickers, Drive discovery, and Drive scope checks. Native document or spreadsheet content opened from a Drive binding is read through the Google Docs or Google Sheets API. Direct Google Doc reads and edits still go through the Docs API, and direct spreadsheet reads go through the Sheets API.

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
- `documents` for direct Google Docs reads and edits; `documents.readonly` for native Docs opened from account-wide or exact-file Drive bindings.
- `drive.metadata.readonly` for the Docs and Sheets pickers, account-wide Drive discovery, exact-file metadata, and native-file scope checks.
- `drive.readonly` for discovery and native Docs or Sheets reads within one shared drive. Google accepts this Drive scope for those native APIs, so shared-drive grants do not need redundant Docs or Sheets scopes.
- `spreadsheets.readonly` to read metadata and bounded cell ranges from directly selected spreadsheets or native Sheets opened from account-wide or exact-file Drive bindings.
- `calendar.calendarlist.readonly` so the resource picker can list calendars.
- `calendar.events` to manage selected calendar and check calendar availability.
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
5. Choose a Google resource type: Gmail, Google Doc, Google Spreadsheet, Google Drive, Google Calendar, or BigQuery.
6. If prompted, connect a Google account.
7. You should be redirected to Google's consent screen in a new tab.
8. The consent screen acts extra-scary since this is an "unverified" test app.
9. After granting access, the tab closes, and you're back to Gadgets.
10. Use the picker to choose the mailbox scope, document, Drive account/shared-drive/file scope, project, dataset, or table to connect.
11. Create the connection. Ask the agent what it can do, or ask it to write a gadget using the new binding.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

## Google Drive bindings

Drive exposes three permanent resource URL forms:

- `https://drive.google.com/drive/my-drive` selects the connected account's My Drive and items shared directly with it in Shared with me (`corpora=user`).
- `https://drive.google.com/drive/folders/<driveId>` selects one Google Workspace shared drive, where the organization rather than an individual owns the files.
- `https://drive.google.com/file/d/<fileId>/view` selects one file by its immutable ID.

Despite the `/folders/` URL, the second resource is a Google Workspace shared drive, not an individual folder. Google uses a shared drive's ID for its root folder too. The gatekeeper confirms the ID with `drives.get`, so it rejects ordinary folder IDs.

The agent-facing Drive sessions report the binding scope, list entries, run structured metadata searches, and fetch one entry by ID. Listing and search return disposable RPC cursors. A parent filter means direct children only, never recursive descendants. For a native Google Doc or Sheet, `openGoogleDoc()` or `openGoogleSheet()` returns an independently disposable, read-only nested session. Docs expose metadata and Markdown content; Sheets expose spreadsheet metadata and bounded A1 range reads.

Account and shared-drive bindings also queue creation of blank native Google Docs, blank native Google Sheets, and folders. An omitted destination means the My Drive root for an account binding or the bound shared-drive root; callers may instead name an in-scope writable folder by immutable ID. Exact-file bindings remain read-only, even when the selected file is a folder.

Each create call returns an asynchronous handle and submits a manual approval that names the destination. The new item contains no initial content and inherits the destination folder's permissions. `getCreationResult()` reports pending, rejected, failed, created, or reverted state. Revert moves an item to Drive trash; it never permanently deletes it.

Every native open and creation destination lookup re-fetches Drive metadata, enforces the immutable account, shared-drive, or exact-file scope, and checks the exact MIME type and current capability before authorizing the observation. A folder, shortcut, non-native blob, wrong native type, or out-of-scope file cannot mint a content capability. The Drive API exposes no agent-authored raw `q` strings, generic upload or write primitive, shortcut traversal, arbitrary download or export, or Workers AI extraction. Direct Google Doc bindings retain their existing editing API; Drive-opened Docs do not expose it.

Account bindings request `drive.metadata.readonly`, `documents.readonly`, `spreadsheets.readonly`, and `drive.file`. Shared-drive bindings request `drive.readonly` plus `drive.file`. The new scope limits write access to files this app creates or the user explicitly opens with it; the gatekeeper further restricts creation to an authorized destination in the bound scope. Older account and shared-drive connections are prompted to expand consent. Exact-file bindings remain on the three read-only scopes, and direct Google Doc and Spreadsheet grants are unchanged.

Account and shared-drive bindings remember every file ID whose metadata or native content a workspace has read. Before each collaborator opens the workspace, the gatekeeper requires an explicit Drive grant and rechecks all remembered IDs with fresh batched `files.get` calls. Before a new result page or native child capability is disclosed, it checks the file ID against every existing observer and excludes observers who cannot access it. Exact-file bindings perform the same fresh check for their single file on each share attempt. Google batch requests contain at most 100 `files.get` subrequests; there is deliberately no cached access verdict, so revoked access fails closed on the next open.

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
