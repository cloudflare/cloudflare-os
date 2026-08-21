# Gatekeeper Google

This package provides Google OAuth integration for Gadgets. It serves two purposes:

- **Sign-in:** when `google` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Google" appears on the login page. Sign-in requests only minimal scopes (`openid`,
  `userinfo.email`, `userinfo.profile`) to read the account's **verified email** (`email_verified`),
  which becomes the user's identity.
  The sign-in grant is transient (discarded right after the email is read).
- **Connections:** when a user connects Google (or signs in and later connects it), the scopes for
  the selected resources (Gmail, Docs, Sheets, Calendar, or BigQuery — see below) are requested so
  gadgets can access those APIs on the user's behalf.

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

You'll need to enable the Google APIs that you want to use. Currently supported: Gmail, Google Docs, Google Sheets, Google Calendar, and BigQuery.

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

The Google Drive API is used only to search and display document and spreadsheet metadata in the resource pickers. Document reads and edits still go through the Google Docs API, and spreadsheet reads go through the Google Sheets API.

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
- `documents` for Google Docs reads and edits.
- `drive.metadata.readonly` so the resource pickers can search Google Docs and Sheets by title.
- `spreadsheets.readonly` to read metadata and cell values from selected Google spreadsheets.
- `calendar.calendarlist.readonly` so the resource picker can list calendars.
- `calendar.events` to manage selected calendar and check calendar availability.
- `bigquery` for BigQuery dry-runs and queries. This is intentionally broader than `bigquery.readonly` because dry-runs use `jobs.insert`; the gatekeeper enforces read-only SQL and resource scope checks before running queries. The same single scope covers both BigQuery resource types, so a user who has already granted BigQuery can add a **BigQuery Public Data** connection without re-consenting.

## BigQuery Public Data

**Off by default.** This connection type is only offered when the Google gatekeeper is deployed
with the var `ENABLE_BIGQUERY_PUBLIC_DATA=true`; `wrangler.jsonc` commits `"false"`, so a
deployment opts in rather than acquiring a new data source from a repo update, and the release
manifest carries the var so an operator can see and flip it. `pnpm dev-server` defaults it to
`"true"` for local development — set `ENABLE_BIGQUERY_PUBLIC_DATA=false` in your shell or the root
`.dev.vars` to turn it back off there.

The flag is enforced in four places, so switching it off disables connections that already exist
rather than just hiding the option: the resource is dropped from `getSupportedResources()`, the
configurator refuses to open, `connect()` refuses to mint a capability for a
`public.bigquery.googleapis.com` URL, and `startSession()` refuses to start. (It is an env var, not
an `AdminConfig` entry, so it can't be flipped from a compromised admin session. Admins can still
disable the resource on top of it, as they can any other.)

When enabled, the gatekeeper offers **BigQuery Public Data** alongside the ordinary **BigQuery**
connection: a connection to one of Google's public projects — `bigquery-public-data`, `patents-public-data`,
`gdelt-bq`, `nyc-tlc`, `openaq`, or `bigquery-samples` — which grant read access to every
authenticated Google user. The allowlist is `PUBLIC_DATA_PROJECTS` in `src/bigquery-resource.ts`;
adding an entry is a one-line data change, and removing one disables the bindings that name it
(the list is re-checked when a session starts, not only when the binding is created).

Such a connection names **two** projects, because a public project can be read but not billed:

- a **billing project** — one of the user's own, which the query jobs are charged to, and
- a **data project** — the public one, the only project whose tables the connection may reference.

That split is the point. The session's scope is the *public* project, so the existing
`referencedTables` check rejects any query touching the billing project: the connection spends the
user's money but cannot read a byte of their data. Because it provably reads only data anyone
signed in to Google can already read, its observations are **not** marked as restricted data — so a
workspace built on one stays shareable and can still fetch from the web, unlike one that has read a
private BigQuery dataset.

Costs still apply: public tables are large and the queries bill the user's project. The default
100 GB `maximumBytesBilled` cap and the mandatory dry-run gate apply exactly as they do to a
private connection, and each observation reports the billing project and the estimated bytes.

The two types use distinct synthetic resource URLs:

```
BigQuery              https://bigquery.googleapis.com/<project>[/<dataset>[/<table>]]
BigQuery Public Data  https://public.bigquery.googleapis.com/<billingProject>/<dataProject>[/<dataset>[/<table>]]
```

Distinct hostnames rather than a marker segment, so the two `URLPattern`s stay disjoint and one URL
never matches both resource types.

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
5. Choose a Google resource type: Gmail, Google Doc, Google Spreadsheet, Google Calendar, or BigQuery. (BigQuery Public Data also appears under `pnpm dev-server`, which enables it by default — see below.)
6. If prompted, connect a Google account.
7. You should be redirected to Google's consent screen in a new tab.
8. The consent screen acts extra-scary since this is an "unverified" test app.
9. After granting access, the tab closes, and you're back to Gadgets.
10. Use the picker to choose the mailbox scope, document, project, dataset, or table to connect.
11. Create the connection. Ask the agent what it can do, or ask it to write a gadget using the new binding.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

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
