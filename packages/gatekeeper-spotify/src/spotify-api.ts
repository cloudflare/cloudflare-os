import "cloudflare:workers";
import type { CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import {
  SPOTIFY_ACCOUNTS_ORIGIN, SPOTIFY_API_ORIGIN, spotifyUpstream, type TokenOperation,
} from "./spotify-upstream";

// ---------------------------------------------------------------------------
// OAuth + HTTP wrapper around the Spotify Web API.
//
// Auth is OAuth 2.0 Authorization Code flow:
//   - exchangeAuthCode() trades the redirect `code` for access + refresh tokens.
//   - refreshAccessToken() trades the refresh token for a fresh access token.
//   - Spotify provides no token-revocation endpoint, so "revoke" just drops local tokens.
//
// Every request goes through `spotifyUpstream`, which owns its timeout, the retry of a read, the
// redirect mode and its metric point.

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

/**
 * Thrown where Spotify answered a creation with a success that does not name what it created.
 * Whether it created anything is not known: the request was sent, and a second send may create a
 * second.
 */
export class SpotifyUnnamedCreationError extends SpotifyApiError {}

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

// One answer of the token endpoint: the grant it holds, or the error it is thrown as. A rejection
// is returned, not thrown, so that the upstream counts the answer by what was read.
type TokenAnswer =
  | { grant: SpotifyTokenGrant }
  | { rejection: SpotifyApiError; status: number };

// Reads one answer of the token endpoint. What reading the body throws propagates.
async function readTokenAnswer(response: Response): Promise<TokenAnswer> {
  const { status } = response;
  const parsed = await parseBody(response);
  if (!response.ok) {
    let message = `${status} ${response.statusText}`;
    if (parsed && typeof parsed === "object") {
      const details = parsed as { error?: string; error_description?: string };
      message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
    }
    return { rejection: new SpotifyApiError(status, message, parsed), status };
  }

  const result = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!result.access_token) {
    return {
      rejection: new SpotifyApiError(400, "Spotify token exchange did not return an access token.", parsed),
      status,
    };
  }

  return {
    grant: {
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? null,
      expiresIn: result.expires_in ?? 3600,
      scopes: result.scope ? result.scope.split(" ").filter(Boolean) : [],
    },
  };
}

/**
 * Whether a grant's refresh token is one. A code's exchange is sent for a refresh token: its
 * answer is counted as an error of the call where this says it holds none, and the connect flow
 * refuses that grant by this same check. A refresh may hold none.
 * @param refreshToken The refresh token of a grant.
 * @returns Whether the grant holds a refresh token.
 */
export function isRefreshToken(refreshToken: string | null): refreshToken is string {
  return Boolean(refreshToken);
}

// How the upstream counts an answer of the token endpoint that its status does not describe: a
// success that holds no access token is an error of the call, and so is the success of a code's
// exchange that holds no refresh token.
function tokenAnswerCountedAs(operation: TokenOperation, answer: TokenAnswer): CallAnswer | undefined {
  const rejected = "rejection" in answer
    ? answer.status >= 200 && answer.status < 300
    : operation === "token.exchange" && !isRefreshToken(answer.grant.refreshToken);
  return rejected ? { outcome: "error", reason: "api" } : undefined;
}

async function tokenRequest(
  operation: TokenOperation,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<SpotifyTokenGrant> {
  const answer = await spotifyUpstream.read(`${SPOTIFY_ACCOUNTS_ORIGIN}/api/token`, {
    operation,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
    },
    body: body.toString(),
  }, readTokenAnswer, answered => tokenAnswerCountedAs(operation, answered));
  if ("rejection" in answer) throw answer.rejection;
  return answer.grant;
}

export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<SpotifyTokenGrant> {
  return await tokenRequest(
    "token.exchange",
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
    "token.refresh",
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

/** One track the user played, as the history of recent plays lists it. */
export type SpotifyPlayHistoryResponse = {
  track: SpotifyTrackResponse;
  played_at: string;
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

// What a method's `read` made of the body of a success, or what it threw.
type Read<T> = { value: T } | { thrown: unknown };

// A success whose body the method that asked for it refused: an error of the API.
const UNREAD: CallAnswer = { outcome: "error", reason: "api" };

// Whether a body is a list of booleans, which is what a membership check answers.
function isMembership(body: unknown): body is boolean[] {
  return Array.isArray(body) && body.every(entry => typeof entry === "boolean");
}

// Reads the answer to a membership check of `asked` URIs: one boolean for each, in their order.
// A body that is no such list, one with fewer or more answers than URIs included, is refused
// here, within the request, so that it is counted an error and no answer is read for the wrong
// URI.
const membership = (asked: number) => (body: unknown): boolean[] => {
  if (!isMembership(body) || body.length !== asked) {
    throw new SpotifyApiError(502, "Spotify answered a membership check with no answer for each item.");
  }
  return body;
};

// Whether a body names a playlist: an object whose `id` is a string that is not empty.
function namesPlaylist(body: unknown): body is SpotifyPlaylistResponse {
  return typeof body === "object" && body !== null && "id" in body
    && typeof body.id === "string" && body.id !== "";
}

// Reads the answer to a playlist's creation: the playlist, named by its id. What follows a
// creation and what undoes it both need that id, so a body that names no playlist is refused
// here, within the request, and the request is counted an error.
// Nor does a success whose body could not be read or decoded name one: the creation was sent all
// the same, and may have been made.
const createdPlaylist: Reader<SpotifyPlaylistResponse> = Object.assign((body: unknown): SpotifyPlaylistResponse => {
  if (!namesPlaylist(body)) {
    throw new SpotifyUnnamedCreationError(502, "Spotify did not name the playlist it created.");
  }
  return body;
}, {
  undecoded: (cause: unknown): Error => {
    const error = new SpotifyUnnamedCreationError(502, "Spotify did not name the playlist it created.");
    error.cause = cause;
    return error;
  },
});

// A reader of the body of a success, which may say what a success whose body could not be read
// or decoded is thrown as.
type Reader<T> = ((body: unknown) => T) & { undecoded?: (cause: unknown) => Error };

// Reads a page of a listing: its items, which may be none, and where the listing goes on. A body
// with no list of items is refused here, within the request, so that it is counted an error and
// no reader takes it for an empty page: a playlist read so would give an undo nothing to restore.
// Spotify withholds a playlist's items with a 403, not with a page that holds none.
function paged<T>(body: unknown): SpotifyPaging<T> {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { items?: unknown }).items)) {
    throw new SpotifyApiError(502, "Spotify answered a listing with no list of items.");
  }
  return body as SpotifyPaging<T>;
}

export class SpotifyApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  // Sends one request and answers the body of a success: as it is, or what `read` makes of it
  // where a method gives one. `read` runs within the request: a body it throws on is counted as
  // an error of the API, the request is not sent again for it, and what it threw is thrown.
  async #request<T>(
    method: string, path: string, options: RequestOptions = {}, read?: Reader<T>,
  ): Promise<T> {
    const url = new URL(path, SPOTIFY_API_ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers();
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const made = await spotifyUpstream.read(url.toString(), {
      method,
      headers,
      body,
      // Asked before every send, so that a read sent again carries a token that is still valid.
      authorize: async () => ({ Authorization: `Bearer ${await this.#getToken()}` }),
    }, async (response): Promise<Read<T>> => {
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

      let parsed: unknown;
      try {
        parsed = await parseBody(response);
      } catch (cause) {
        // A success whose body cannot be read is thrown as what the reading threw, and counted by
        // the client, except where `read` says what such a success is: a creation's.
        throw read?.undecoded?.(cause) ?? cause;
      }
      if (!read) return { value: parsed as T };
      try {
        return { value: read(parsed) };
      } catch (thrown) {
        return { thrown };
      }
    }, answer => "thrown" in answer ? UNREAD : undefined);
    if ("thrown" in made) throw made.thrown;
    return made.value;
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
   * One request for each id: their calls are summed.
   */
  async getTracks(trackIds: string[]): Promise<(SpotifyTrackResponse | null)[]> {
    return await spotifyUpstream.summed(() =>
      Promise.all(trackIds.map(id => this.getTrack(id).then(track => track, () => null))));
  }

  async getAlbums(albumIds: string[]): Promise<(SpotifyAlbumResponse | null)[]> {
    return await spotifyUpstream.summed(() =>
      Promise.all(albumIds.map(id => this.getAlbum(id).then(album => album, () => null))));
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
    return this.#request("GET", "/v1/me/tracks", { query: { limit, offset } }, paged<{ track: SpotifyTrackResponse }>);
  }

  listSavedAlbums(limit: number, offset: number): Promise<SpotifyPaging<{ album: SpotifyAlbumResponse }>> {
    return this.#request("GET", "/v1/me/albums", { query: { limit, offset } }, paged<{ album: SpotifyAlbumResponse }>);
  }

  getTopTracks(timeRange: string, limit: number): Promise<SpotifyPaging<SpotifyTrackResponse>> {
    return this.#request("GET", "/v1/me/top/tracks", { query: { time_range: timeRange, limit } }, paged<SpotifyTrackResponse>);
  }

  getTopArtists(timeRange: string, limit: number): Promise<SpotifyPaging<SpotifyArtistResponse>> {
    return this.#request("GET", "/v1/me/top/artists", { query: { time_range: timeRange, limit } }, paged<SpotifyArtistResponse>);
  }

  // --- Generic library (Feb 2026) ---
  //
  // The entity-specific save/remove/follow/unfollow and "contains" endpoints were replaced by a
  // single library endpoint keyed on Spotify URIs. Callers pass URIs like "spotify:track:...",
  // "spotify:album:...", "spotify:artist:...", or "spotify:playlist:..." (following a playlist).

  /**
   * The /me/library write endpoints read `uris` from the query string (same as /me/library/contains).
   * We also send it in the body as a harmless hedge in case the contract accepts either.
   * One request for each chunk of URIs, here and in the two methods below: their calls are summed.
   */
  async saveToLibrary(uris: string[]): Promise<void> {
    await spotifyUpstream.summed(async () => {
      for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
        const chunk = uris.slice(i, i + LIBRARY_CHUNK);
        await this.#request("PUT", "/v1/me/library", { query: { uris: chunk.join(",") }, body: { uris: chunk } });
      }
    });
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    await spotifyUpstream.summed(async () => {
      for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
        const chunk = uris.slice(i, i + LIBRARY_CHUNK);
        await this.#request("DELETE", "/v1/me/library", { query: { uris: chunk.join(",") }, body: { uris: chunk } });
      }
    });
  }

  async libraryContains(uris: string[]): Promise<boolean[]> {
    return await spotifyUpstream.summed(async () => {
      const result: boolean[] = [];
      for (let i = 0; i < uris.length; i += LIBRARY_CHUNK) {
        const chunk = uris.slice(i, i + LIBRARY_CHUNK);
        result.push(...await this.#request("GET", "/v1/me/library/contains", {
          query: { uris: chunk.join(",") },
        }, membership(chunk.length)));
      }
      return result;
    });
  }

  // --- Playlists ---

  listMyPlaylists(limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylistResponse>> {
    return this.#request("GET", "/v1/me/playlists", { query: { limit, offset } }, paged<SpotifyPlaylistResponse>);
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
    }, paged<SpotifyPlaylistItemResponse>);
  }

  /**
   * Creates a playlist, with one request. A success that names no playlist is thrown as a
   * `SpotifyUnnamedCreationError`: its caller cannot tell from it whether Spotify created one.
   */
  createPlaylist(
    body: { name: string; description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<SpotifyPlaylistResponse> {
    return this.#request("POST", "/v1/me/playlists", { body }, createdPlaylist);
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

  getRecentlyPlayed(limit: number): Promise<SpotifyPaging<SpotifyPlayHistoryResponse>> {
    return this.#request("GET", "/v1/me/player/recently-played", { query: { limit } }, paged<SpotifyPlayHistoryResponse>);
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
