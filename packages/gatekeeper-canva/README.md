# Gatekeeper Canva

This package provides Canva Connect API integration for Gadgets. Connect a Canva account and gadgets
can list and search your designs, browse folders, read your profile, create new designs, ask Canva's
AI to generate a doc or presentation from a brief, and remove image backgrounds
— all behind the approval queue.

It currently offers one resource granularity:

- **Canva Account** (whole-instance): profile, design search, folder browsing, design creation,
  AI design generation, and AI background removal.

> **Design generation and background removal use Canva preview APIs.** Canva may change them
> without a version bump, and public integrations that use preview APIs cannot pass Canva's review.
> A private integration (the normal choice for a single company's deployment) is unaffected. Both
> spend the connected user's Canva AI credits, so they always require approval and are never
> auto-approvable.

This gatekeeper is **not** an authentication provider (`providesAuth: false`) — Canva isn't offered
as a "Continue with…" sign-in method.

## Setting up Canva OAuth credentials

If you're running this project locally and want to use Canva integration, you'll need to create
your own Canva integration in the Developer Portal.

### Step 1: Create a Canva integration

1. Go to the [Canva Developer Portal](https://www.canva.com/developers/integrations) and click
   **Create an integration**.
2. Give it a name. A **Private** integration is fine for local development.
3. Under **Authentication**, add the redirect URL exactly:

   ```
   http://127.0.0.1:8787/gatekeeper/canva/oauth
   ```

   > Canva, like most OAuth providers, does not accept `localhost` as a redirect host for
   > non-HTTPS URLs — use the loopback IP literal `127.0.0.1`. Replace host/port with your
   > `BASE_URL` when not running locally (production must use HTTPS).
4. Under **Scopes**, enable: `design:meta:read`, `design:content:write`, `asset:read`,
   `asset:write`, `folder:read`, `profile:read`.
5. Copy the **Client ID**, then generate and copy a **Client secret**.

### Step 2: Configure your local environment

Create a `.env` file in this package's directory (`packages/gatekeeper-canva/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
# Must match the redirect URI host you registered. Use 127.0.0.1, not localhost.
BASE_URL=http://127.0.0.1:8787/gatekeeper/canva
```

Alternatively, put `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` in the root `.dev.vars`; the dev
server seeds this gatekeeper's `CLIENT_ID` / `CLIENT_SECRET` from those.

> **Note**: `.env` is gitignored and should never be committed. Because the redirect uses
> `127.0.0.1`, open the Workshop at `http://127.0.0.1:8787` (not `localhost`) so the OAuth popup
> stays on the same host.

### Step 3: Verify setup

1. Start the application in dev mode (see the root README.md).
2. Create or open a gadget and go to the **Connections** tab.
3. Click **+ New Connection** and choose **Canva Account**.
4. If prompted, connect your Canva account — you'll be redirected to Canva's authorization page
   in a new tab; after granting access the tab closes and you're back in Gadgets.
5. Create the connection.

You can see and manage connected accounts in settings (via the account menu in the upper-right).

## Notes & limitations

- **Approvals and simulation.** Reads are logged and writes are queued for human approval; nothing
  is created on Canva until approved. Each write returns the design or asset it will make under a
  temporary id (`~1`, `~2`, ...), which reads and listings honour at once and which keeps working
  after Canva assigns the real id, so the agent carries on without waiting for the decision. A
  pending design has null `editUrl`/`viewUrl`; a pending asset has no thumbnail. The temporary id
  of a pending background removal can be passed to `createDesign({ assetId })` or another
  `removeBackground()`, and the actions then apply in order.
- **Generation and background removal are asynchronous.** Approving a `generateDesign` or
  `removeBackground` action starts a job on Canva. Applying a removal waits up to 20 seconds for
  the job, which usually suffices; if Canva is still working after that, the approval card reports
  it and asks the user to approve again, and the retry resumes the same job (no second request, no
  further credits), so the temporary id stays live for actions that depend on the asset. A
  generation can take minutes, so its design stays pending until a read of its id finds the job
  done. `getDesign()` / `getImageAsset()` with the temporary
  id poll the job, and `listGeneratedDesigns()` / `listBackgroundRemovals()` list every job with
  its status. Jobs expire on Canva after 24 hours. Both features are plan-gated; `getProfile()`
  reports `canGenerateDesigns` and `canRemoveBackgrounds`.
- **Reconnect after the `asset:write` scope was added.** Accounts connected before background
  removal existed hold a grant without `asset:write`, and Canva answers a background removal with
  403 until the user disconnects and reconnects Canva from the Connectors page.
- **Token rotation.** Canva access tokens are short-lived and refresh tokens are single-use. The
  account refreshes transparently; if a refresh is rejected the account is marked expired and the
  user is prompted to reconnect.
- **OAuth uses PKCE.** Canva requires the S256 code challenge on every authorization request.

## Troubleshooting

### "Canva Gatekeeper Not Configured" page during authorization

`CLIENT_ID` or `CLIENT_SECRET` is missing. Ensure `packages/gatekeeper-canva/.env` exists with both
values (or the root `.dev.vars` has `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET`), then restart the dev
server.

### "redirect_uri mismatch" or similar from Canva

The redirect URI sent doesn't exactly match one registered on the integration. Confirm the portal
has `http://127.0.0.1:8787/gatekeeper/canva/oauth` and that `BASE_URL` in `.env` is
`http://127.0.0.1:8787/gatekeeper/canva` (note `127.0.0.1`, not `localhost`; no trailing slash).

### Authorization succeeds but API calls return 403

The integration is missing a scope the gatekeeper requests. Re-check the **Scopes** list in the
portal against Step 1, then reconnect the account so a new grant is issued.
