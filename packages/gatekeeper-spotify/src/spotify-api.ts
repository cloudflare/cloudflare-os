import "cloudflare:workers";

// ---------------------------------------------------------------------------
// OAuth + HTTP wrapper around the Spotify Web API.
//
// Auth is OAuth 2.0 Authorization Code flow:
//   - exchangeAuthCode() trades the redirect `code` for access + refresh tokens.
//   - refreshAccessToken() trades the refresh token for a fresh access token.
//   - Spotify provides no token-revocation endpoint, so "revoke" just drops local tokens.

const ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
const API_BASE_URL = "https://api.spotify.com";
const REQUEST_TIMEOUT_MS = 30_000;
// The generic /me/library endpoints accept fewer URIs per request than the old per-type endpoints,
// so we chunk conservatively and stitch results back together.
const LIBRARY_CHUNK = 20;

export type SpotifyTokenGrant = {
  accessToken: string;
  /** Present on initial exchange; on refresh Spotify may omit it (reuse the previous one). */
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Granted scopes. */
  scopes: string[];
};

export class SpotifyApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.details = details;
    // 401 = expired/invalid token. (403 is usually a scope/Premium problem, not an auth failure.)
    this.isAuthError = status === 401;
  }
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }
  return await response.text();
}

async function tokenRequest(
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<SpotifyTokenGrant> {
  const response = await fetch(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (parsed && typeof parsed === "object") {
      const details = parsed as { error?: string; error_description?: string };
      message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
    }
    throw new SpotifyApiError(response.status, message, parsed);
  }

  const result = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!result.access_token) {
    throw new SpotifyApiError(400, "Spotify token exchange did not return an access token.", parsed);
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresIn: result.expires_in ?? 3600,
    scopes: result.scope ? result.scope.split(" ").filter(Boolean) : [],
  };
}

export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<SpotifyTokenGrant> {
  return await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    clientId,
    clientSecret,
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<SpotifyTokenGrant> {
  return await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    clientId,
    clientSecret,
  );
}

// ---------------------------------------------------------------------------
// Raw Spotify Web API response shapes (only the fields we consume).

export type SpotifyImageResponse = { url: string; width: number | null; height: number | null };

export type SpotifyArtistResponse = {
  id: string;
  name: string;
  uri: string;
  external_urls?: { spotify?: string };
  images?: SpotifyImageResponse[];
  followers?: { total?: number };
};

export type SpotifyAlbumResponse = {
  id: string;
  name: string;
  uri: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  external_urls?: { spotify?: string };
  images?: SpotifyImageResponse[];
  artists?: SpotifyArtistResponse[];
};

export type SpotifyTrackResponse = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  popularity?: number;
  disc_number?: number;
  track_number?: number;
  is_local?: boolean;
  external_urls?: { spotify?: string };
  artists: SpotifyArtistResponse[];
  album: SpotifyAlbumResponse;
};

export type SpotifyUserResponse = {
  id: string;
  display_name?: string | null;
  uri: string;
  email?: string;
  product?: string;
  country?: string;
  external_urls?: { spotify?: string };
  followers?: { total?: number };
  images?: SpotifyImageResponse[];
};

export type SpotifyPlaylistResponse = {
  id: string;
  name: string;
  uri: string;
  description?: string | null;
  collaborative?: boolean;
  public?: boolean | null;
  snapshot_id: string;
  external_urls?: { spotify?: string };
  images?: SpotifyImageResponse[];
  owner: SpotifyUserResponse;
  /**
   * The track-count container. Feb 2026 renamed `tracks` -> `items`; we read whichever is present.
   * For playlists the user doesn't own, this may be absent entirely (contents are withheld).
   */
  items?: { total?: number };
  tracks?: { total?: number };
};

export type SpotifyPlaylistItemResponse = {
  added_at?: string | null;
  added_by?: SpotifyUserResponse | null;
  /** Feb 2026 renamed the per-item track field `track` -> `item`; we read whichever is present. */
  item?: SpotifyTrackResponse | null;
  track?: SpotifyTrackResponse | null;
};

export type SpotifyDeviceResponse = {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
};

export type SpotifyPlaybackStateResponse = {
  is_playing: boolean;
  progress_ms: number | null;
  shuffle_state?: boolean;
  repeat_state?: string;
  device?: SpotifyDeviceResponse | null;
  item?: SpotifyTrackResponse | null;
  context?: { uri?: string } | null;
};

export type SpotifyPaging<T> = {
  items: T[];
  next?: string | null;
  total?: number;
};

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  okStatuses?: number[];
};

export class SpotifyApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path, API_BASE_URL);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ Authorization: `Bearer ${await this.#getToken()}` });
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok && !(options.okStatuses ?? []).includes(response.status)) {
      const parsed = await parseBody(response);
      let message = `${response.status} ${response.statusText}`;
      if (parsed && typeof parsed === "object") {
        const errorObj = (parsed as { error?: { message?: string } | string }).error;
        if (typeof errorObj === "string") message = errorObj;
        else if (errorObj?.message) message = errorObj.message;
      } else if (typeof parsed === "string" && parsed.length > 0) {
        message = parsed;
      }
      throw new SpotifyApiError(response.status, message, parsed);
    }

    return (await parseBody(response)) as T;
  }

  // --- Profile / catalog ---

  getCurrentUser(): Promise<SpotifyUserResponse> {
    return this.#request<SpotifyUserResponse>("GET", "/v1/me");
  }

  getTrack(trackId: string): Promise<SpotifyTrackResponse> {
    return this.#request<SpotifyTrackResponse>("GET", `/v1/tracks/${encodeURIComponent(trackId)}`);
  }

  getAlbum(albumId: string): Promise<SpotifyAlbumResponse> {
    return this.#request<SpotifyAlbumResponse>("GET", `/v1/albums/${encodeURIComponent(albumId)}`);
  }

  /**
   * The Feb 2026 dev-mode changes removed the batch /tracks and /albums endpoints, so we fetch
   * each item individually. Unknown/unavailable ids resolve to null rather than failing the batch.
   */
  async getTracks(trackIds: string[]): Promise<(SpotifyTrackResponse | null)[]> {
    return Promise.all(trackIds.map(id => this.getTrack(id).then(track => track, () => null)));
  }

  async getAlbums(albumIds: string[]): Promise<(SpotifyAlbumResponse | null)[]> {
    return Promise.all(albumIds.map(id => this.getAlbum(id).then(album => album, () => null)));
  }

  search(query: string, types: string[], limit: number): Promise<{
    tracks?: SpotifyPaging<SpotifyTrackResponse>;
    artists?: SpotifyPaging<SpotifyArtistResponse>;
    albums?: SpotifyPaging<SpotifyAlbumResponse>;
    playlists?: SpotifyPaging<SpotifyPlaylistResponse>;
  }> {
    return this.#request("GET", "/v1/search", {
      query: { q: query, type: types.join(","), limit },
    });
  }

  // --- Library ---

  listSavedTracks(limit: number, offset: number): Promise<SpotifyPaging<{ track: SpotifyTrackResponse }>> {
    return this.#request("GET", "/v1/me/tracks", { query: { limit, offset } });
  }

  listSavedAlbums(limit: number, offset: number): Promise<SpotifyPaging<{ album: SpotifyAlbumResponse }>> {
    return this.#request("GET", "/v1/me/albums", { query: { limit, offset } });
  }

  getTopTracks(timeRange: string, limit: number): Promise<SpotifyPaging<SpotifyTrackResponse>> {
    return this.#request("GET", "/v1/me/top/tracks", { query: { time_range: timeRange, limit } });
  }

  getTopArtists(timeRange: string, limit: number): Promise<SpotifyPaging<SpotifyArtistResponse>> {
    return this.#request("GET", "/v1/me/top/artists", { query: { time_range: timeRange, limit } });
  }

  // --- Generic library (Feb 2026) ---
  //
  // The entity-specific save/remove/follow/unfollow and "contains" endpoints were replaced by a
  // single library endpoint keyed on Spotify URIs. Callers pass URIs like "spotify:track:...",
  // "spotify:album:...", "spotify:artist:...", or "spotify:playlist:..." (following a playlist).

  /**
   * The /me/library write endpoints read `uris` from the query string (same as /me/library/contains).
   * We also send it in the body as a harmless hedge in case the contract accepts either.
   */
  async saveToLibrary(uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
      const chunk = uris.slice(i, i + LIBRARY_CHUNK);
      await this.#request("PUT", "/v1/me/library", { query: { uris: chunk.join(",") }, body: { uris: chunk } });
    }
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
      const chunk = uris.slice(i, i + LIBRARY_CHUNK);
      await this.#request("DELETE", "/v1/me/library", { query: { uris: chunk.join(",") }, body: { uris: chunk } });
    }
  }

  async libraryContains(uris: string[]): Promise<boolean[]> {
    const result: boolean[] = [];
    for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
      const chunk = uris.slice(i, i + LIBRARY_CHUNK);
      const part = await this.#request<boolean[]>("GET", "/v1/me/library/contains", {
        query: { uris: chunk.join(",") },
      });
      result.push(...(part ?? []));
    }
    return result;
  }

  // --- Playlists ---

  listMyPlaylists(limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylistResponse>> {
    return this.#request("GET", "/v1/me/playlists", { query: { limit, offset } });
  }

  getPlaylist(playlistId: string): Promise<SpotifyPlaylistResponse> {
    return this.#request("GET", `/v1/playlists/${encodeURIComponent(playlistId)}`);
  }

  /**
   * GET /playlists/{id}/items only returns contents for playlists the user owns or collaborates on;
   * for others Spotify withholds items (returns metadata only).
   */
  listPlaylistItems(playlistId: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylistItemResponse>> {
    return this.#request("GET", `/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      query: { limit, offset },
    });
  }

  createPlaylist(
    body: { name: string; description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<SpotifyPlaylistResponse> {
    return this.#request("POST", "/v1/me/playlists", { body });
  }

  async addPlaylistItems(playlistId: string, uris: string[], position?: number): Promise<void> {
    await this.#request("POST", `/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      body: position === undefined ? { uris } : { uris, position },
    });
  }

  async removePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    await this.#request("DELETE", `/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      body: { items: uris.map(uri => ({ uri })) },
    });
  }

  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    await this.#request("PUT", `/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      body: { uris },
    });
  }

  async reorderPlaylistItems(
    playlistId: string,
    rangeStart: number,
    insertBefore: number,
    rangeLength: number,
  ): Promise<void> {
    await this.#request("PUT", `/v1/playlists/${encodeURIComponent(playlistId)}/items`, {
      body: { range_start: rangeStart, insert_before: insertBefore, range_length: rangeLength },
    });
  }

  async changePlaylistDetails(
    playlistId: string,
    body: { name?: string; description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<void> {
    await this.#request("PUT", `/v1/playlists/${encodeURIComponent(playlistId)}`, { body });
  }

  // --- Player ---

  getPlaybackState(): Promise<SpotifyPlaybackStateResponse | undefined> {
    // Spotify returns 204 (no content) when no active device — modeled as undefined.
    return this.#request<SpotifyPlaybackStateResponse | undefined>("GET", "/v1/me/player", {
      okStatuses: [204],
    });
  }

  async getDevices(): Promise<SpotifyDeviceResponse[]> {
    const result = await this.#request<{ devices: SpotifyDeviceResponse[] }>("GET", "/v1/me/player/devices");
    return result.devices ?? [];
  }

  getQueue(): Promise<{ currently_playing: SpotifyTrackResponse | null; queue: SpotifyTrackResponse[] } | undefined> {
    // 204 (no active device/session) yields an empty body, modeled as undefined.
    return this.#request("GET", "/v1/me/player/queue", { okStatuses: [204] });
  }

  getRecentlyPlayed(limit: number): Promise<SpotifyPaging<{
    track: SpotifyTrackResponse;
    played_at: string;
    context?: { uri?: string } | null;
  }>> {
    return this.#request("GET", "/v1/me/player/recently-played", { query: { limit } });
  }

  async play(deviceId: string | undefined, body: Record<string, unknown>): Promise<void> {
    await this.#request("PUT", "/v1/me/player/play", {
      query: { device_id: deviceId },
      body: Object.keys(body).length > 0 ? body : undefined,
      okStatuses: [202, 204],
    });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.#request("PUT", "/v1/me/player/pause", { query: { device_id: deviceId }, okStatuses: [202, 204] });
  }

  async next(deviceId?: string): Promise<void> {
    await this.#request("POST", "/v1/me/player/next", { query: { device_id: deviceId }, okStatuses: [202, 204] });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.#request("POST", "/v1/me/player/previous", { query: { device_id: deviceId }, okStatuses: [202, 204] });
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    await this.#request("PUT", "/v1/me/player/seek", {
      query: { position_ms: positionMs, device_id: deviceId },
      okStatuses: [202, 204],
    });
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    await this.#request("PUT", "/v1/me/player/volume", {
      query: { volume_percent: volumePercent, device_id: deviceId },
      okStatuses: [202, 204],
    });
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<void> {
    await this.#request("PUT", "/v1/me/player/shuffle", {
      query: { state, device_id: deviceId },
      okStatuses: [202, 204],
    });
  }

  async setRepeat(state: string, deviceId?: string): Promise<void> {
    await this.#request("PUT", "/v1/me/player/repeat", {
      query: { state, device_id: deviceId },
      okStatuses: [202, 204],
    });
  }

  async transfer(deviceId: string, play: boolean): Promise<void> {
    await this.#request("PUT", "/v1/me/player", { body: { device_ids: [deviceId], play }, okStatuses: [202, 204] });
  }

  async addToQueue(uri: string, deviceId?: string): Promise<void> {
    await this.#request("POST", "/v1/me/player/queue", {
      query: { uri, device_id: deviceId },
      okStatuses: [202, 204],
    });
  }
}
