# Gatekeeper Spotify

This package provides Spotify Web API integration for Gadgets. Connect a Spotify account and gadgets
can search the catalog, read and edit your library and playlists, manage follows, and control
playback on your Spotify Connect devices — all behind the approval queue.

It offers two resource granularities:

- **Spotify Account** (whole-instance): profile, catalog search, library (saved tracks/albums, top
  items, recently played), follows, playlists, and playback control via `getPlayer()`.
- **Spotify Playlist**: read / edit / follow / unfollow a single playlist.

This gatekeeper is **not** an authentication provider (`providesAuth: false`) — Spotify isn't offered
as a "Continue with…" sign-in method.

> **Targets Spotify's post-February-2026 development-mode API.** Library writes use the generic
> `PUT/DELETE /me/library`, playlist contents use `/playlists/{id}/items`, etc. Some fields Spotify
> removed in dev mode (e.g. track `popularity`, parts of the user profile) are returned as `null`.

## Setting up Spotify OAuth credentials

If you're running this project locally and want to use Spotify integration, you'll need to create
your own Spotify app.

### Step 1: Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click
   **Create app**.
2. Fill in a name and description (anything).
3. **Redirect URI**: add exactly

   ```
   http://127.0.0.1:8787/gatekeeper/spotify/oauth
   ```

   > Spotify **does not allow `localhost`** as a redirect URI for new apps — you must use the
   > loopback IP literal `127.0.0.1`. Replace host/port with your `BASE_URL` when not running
   > locally (production must use HTTPS).
4. Under **APIs used**, select **Web API**.
5. Save, then copy the **Client ID** and **Client secret**.

### Step 2: Configure your local environment

Create a `.env` file in this package's directory (`packages/gatekeeper-spotify/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
# Must match the redirect URI host you registered. Spotify rejects "localhost", so use 127.0.0.1.
BASE_URL=http://127.0.0.1:8787/gatekeeper/spotify
```

> **Note**: `.env` is gitignored and should never be committed. Because the redirect uses
> `127.0.0.1`, open the Workshop at `http://127.0.0.1:8787` (not `localhost`) so the OAuth popup
> stays on the same host.

### Step 3: Add yourself as a user (development mode)

A new Spotify app starts in **development mode**, which limits it to a small number of users you add
explicitly. In the dashboard, under **User Management**, add the Spotify account (name + email) you
intend to connect — otherwise authorization will fail. Lifting this limit requires requesting
extended quota from Spotify.

> **Playback control requires Spotify Premium.** Player write commands (play/pause/seek/volume/…)
> return 403 for free accounts.

### Step 4: Verify setup

1. Start the application in dev mode (see the root README.md).
2. Create or open a gadget and go to the **Connections** tab.
3. Click **+ New Connection** and choose a Spotify resource type (whole account, or a playlist).
4. If prompted, connect your Spotify account — you'll be redirected to Spotify's authorization page
   in a new tab; after granting access the tab closes and you're back in Gadgets.
5. For a playlist resource, use the picker to choose the playlist to connect.
6. Create the connection.

You can see and manage connected accounts in settings (via the account menu in the upper-right).

## Notes & limitations

- **Approvals & simulation.** Reads are logged and writes are queued for human approval; nothing is
  performed on Spotify until approved. Reads optimistically reflect your own pending edits (e.g. a
  pending playlist add shows in `listTracks`) so a gadget can keep working before approvals land.
  Playback commands are gated but **not** simulated — `getState()` always shows real device state.
- **Auto-approval.** A user may let some kinds of write apply without review: saving tracks, albums
  and playlists to the library, following artists, creating private playlists, adding and
  reordering playlist tracks, editing playlist names and descriptions, and playback control (which
  takes effect on the device at once and cannot be reverted). Removing anything from the library or
  a playlist, unfollowing or deleting a playlist, replacing a playlist's contents, and any change
  that makes a playlist public or collaborative, or undoes that, always need a manual approval.
- **Non-owned playlists.** Spotify withholds track contents for playlists you don't own/collaborate
  on, so `listTracks()` returns an empty list (metadata via `getDetails()` still works).
- **Spotify Connect quirks.** Some third-party Connect endpoints (e.g. Music Assistant) can be
  invisible to `getDevices()` and `getState().device` may misidentify the active device; confirm
  device transfers with a follow-up `getState()`.

## Troubleshooting

### "Spotify Gatekeeper Not Configured" page during authorization

`CLIENT_ID` or `CLIENT_SECRET` is missing. Ensure `packages/gatekeeper-spotify/.env` exists with both
values, then restart the dev server.

### "INVALID_CLIENT: Invalid redirect URI"

The redirect URI sent doesn't exactly match one registered on the app. Confirm the dashboard has
`http://127.0.0.1:8787/gatekeeper/spotify/oauth` and that `BASE_URL` in `.env` is
`http://127.0.0.1:8787/gatekeeper/spotify` (note `127.0.0.1`, not `localhost`; no trailing slash).

### Authorization fails with "User not registered in the Developer Dashboard"

The connecting Spotify account isn't on the app's **User Management** list (development-mode limit).
Add it in the dashboard and retry.
