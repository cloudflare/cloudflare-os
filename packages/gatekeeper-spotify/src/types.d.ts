// TypeScript API exposed to Gadgets by the Spotify gatekeeper.
//
// Two resource granularities are offered (see getGatekeeperClassFor / getSupportedResources):
//
//   1. Spotify Account (whole-instance, `https://*`) -> `SpotifyAccountSession`.
//      Broad access to the connected account: profile, catalog search, the user's library,
//      playback control (Spotify Connect), and all of the user's playlists.
//
//   2. Spotify Playlist (`https://open.spotify.com/playlist/:playlistId`) -> `SpotifyPlaylist`.
//      Scoped access to a single playlist. Hand this out when a Gadget should only be able to
//      read and edit one playlist, not the whole account.
//
// Capability design: the account session is a directory that mints narrower capabilities
// (`getPlayer()`, `getPlaylist()`, `createPlaylist()`). The per-playlist grant returns the exact
// same `SpotifyPlaylist` interface, so playlist logic is identical whether reached broadly or via
// a fine-grained grant.
//
// NOTE: This API intentionally covers music tracks, albums, artists, and playlists. Podcasts
// (shows/episodes/audiobooks) and Spotify endpoints deprecated for new apps in late 2024
// (audio-features, audio-analysis, recommendations, related artists, 30s previews) are not exposed.

// ---------------------------------------------------------------------------
// Shared value types

/** An image (album/playlist/artist art) at a particular size. Largest is usually listed first. */
export type SpotifyImage = {
  /** Source URL of the image. */
  url: string;
  /** Width in pixels, if known. */
  width: number | null;
  /** Height in pixels, if known. */
  height: number | null;
};

/** A reference to an artist, with enough info to display or look up. */
export type SpotifyArtistRef = {
  /** Spotify artist ID, e.g. "0OdUWJ0sBjDrqHygGUXeCF". */
  id: string;
  /** Artist name. */
  name: string;
  /** Spotify URI, e.g. "spotify:artist:0OdUWJ0sBjDrqHygGUXeCF". */
  uri: string;
  /** Web URL that opens the artist in Spotify. */
  url: string;
};

/** A reference to an album, as it appears on a track or in search results. */
export type SpotifyAlbumRef = {
  /** Spotify album ID. */
  id: string;
  /** Album name. */
  name: string;
  /** Spotify URI. */
  uri: string;
  /** Web URL that opens the album in Spotify. */
  url: string;
  /** Album type: "album", "single", or "compilation". */
  albumType: string;
  /** Release date, e.g. "2019-03-25" or "2019" depending on precision. */
  releaseDate: string;
  /** Total number of tracks on the album. */
  totalTracks: number;
  /** Cover art in various sizes. */
  images: SpotifyImage[];
  /** Album artists. */
  artists: SpotifyArtistRef[];
};

/** A reference to a Spotify user (playlist owner, track adder, etc.). */
export type SpotifyUserRef = {
  /** Spotify user ID. */
  id: string;
  /** Display name, if the user has one. */
  displayName: string | null;
  /** Spotify URI. */
  uri: string;
  /** Web URL that opens the user's profile in Spotify. */
  url: string;
};

/** A music track. */
export type SpotifyTrack = {
  /** Spotify track ID. */
  id: string;
  /** Track title. */
  name: string;
  /** Spotify URI, e.g. "spotify:track:11dFghVXANMlKmJXsNCbNl". Use this with player/queue methods. */
  uri: string;
  /** Web URL that opens the track in Spotify. */
  url: string;
  /** Performing artists. */
  artists: SpotifyArtistRef[];
  /** Album the track appears on. */
  album: SpotifyAlbumRef;
  /** Duration in milliseconds. */
  durationMs: number;
  /** True if the track is flagged as explicit. */
  explicit: boolean;
  /**
   * Popularity score 0-100, or null. NOTE: Spotify removed this field for development-mode apps
   * (Feb 2026), so it is `null` for most newer apps.
   */
  popularity: number | null;
  /** Disc number (usually 1). */
  discNumber: number;
  /** 1-based position of the track on its disc. */
  trackNumber: number;
  /** True for a user's local (non-catalog) file; such tracks have limited functionality. */
  isLocal: boolean;
};

/** The connected user's profile. */
export type SpotifyProfile = {
  /** Spotify user ID. */
  id: string;
  /** Display name, if set. */
  displayName: string | null;
  /** Profile email. Present only if the account granted email access. */
  email: string | null;
  /** Subscription level: "premium", "free", or "open", if known. Playback control needs premium. */
  product: string | null;
  /** ISO 3166-1 alpha-2 country code, if known. */
  country: string | null;
  /** Number of followers. */
  followerCount: number;
  /** Spotify URI. */
  uri: string;
  /** Web URL that opens the profile in Spotify. */
  url: string;
  /** Profile images. */
  images: SpotifyImage[];
};

/** Summary of a playlist as it appears in listings (no track contents). */
export type SpotifyPlaylistSummary = {
  /** Spotify playlist ID. */
  id: string;
  /** Playlist name. */
  name: string;
  /** Spotify URI. */
  uri: string;
  /** Web URL that opens the playlist in Spotify. */
  url: string;
  /** Playlist description (may contain basic HTML), or null. */
  description: string | null;
  /** The playlist's owner. */
  owner: SpotifyUserRef;
  /** Whether the playlist is public. May be null if not exposed. */
  public: boolean | null;
  /** Whether the playlist is collaborative. */
  collaborative: boolean;
  /**
   * Number of tracks in the playlist. NOTE: Spotify only exposes track info for playlists the
   * connected user owns or collaborates on; for other playlists this may be 0.
   */
  trackCount: number;
  /** Cover images. */
  images: SpotifyImage[];
  /** Opaque version identifier; changes whenever the playlist is edited. */
  snapshotId: string;
};

/** A track as it sits inside a playlist, with the metadata of when/who added it. */
export type SpotifyPlaylistTrack = {
  /** 0-based position of this item in the playlist at fetch time. */
  position: number;
  /** When the item was added to the playlist, if known. */
  addedAt: Date | null;
  /** Who added the item, if known. */
  addedBy: SpotifyUserRef | null;
  /** The track itself. Null for unavailable items (e.g. removed from catalog). */
  track: SpotifyTrack | null;
};

/** A Spotify Connect playback device. */
export type SpotifyDevice = {
  /** Device ID, or null if the device is restricted and cannot be targeted. */
  id: string | null;
  /** Human-readable device name, e.g. "Living Room Speaker". */
  name: string;
  /** Device type, e.g. "Computer", "Smartphone", "Speaker". */
  type: string;
  /** Whether this device is the currently active playback device. */
  isActive: boolean;
  /** Current volume 0-100, or null if volume cannot be read. */
  volumePercent: number | null;
  /** Whether this device supports setting volume via the API. */
  supportsVolume: boolean;
};

/** Repeat mode for playback. */
export type SpotifyRepeatMode = "off" | "track" | "context";

/** Snapshot of the user's current playback state across Spotify Connect. */
export type SpotifyPlaybackState = {
  /** Whether something is currently playing. */
  isPlaying: boolean;
  /** The active device, or null if playback is idle / no active device. */
  device: SpotifyDevice | null;
  /** The currently playing track, or null if nothing is playing or it is not a music track. */
  track: SpotifyTrack | null;
  /** Playback position within the current track, in ms, or null. */
  progressMs: number | null;
  /** Whether shuffle is on. */
  shuffle: boolean;
  /** Current repeat mode. */
  repeat: SpotifyRepeatMode;
  /** The Spotify URI of the context being played (album/playlist/artist), or null. */
  contextUri: string | null;
};

/** An entry in the user's listening history. */
export type SpotifyPlayHistoryEntry = {
  /** The track that was played. */
  track: SpotifyTrack;
  /** When the track was played. */
  playedAt: Date;
  /** The Spotify URI of the context it was played from, or null. */
  contextUri: string | null;
};

/** Time window for "top items" requests. */
export type SpotifyTopTimeRange = "short_term" | "medium_term" | "long_term";

/** The kinds of catalog items a search can return. */
export type SpotifySearchType = "track" | "artist" | "album" | "playlist";

/** Results of a catalog search. Only the requested categories are populated. */
export type SpotifySearchResults = {
  tracks: SpotifyTrack[];
  artists: SpotifyArtistRef[];
  albums: SpotifyAlbumRef[];
  playlists: SpotifyPlaylistSummary[];
};

/** Options when starting/resuming playback. */
export type SpotifyPlayOptions = {
  /**
   * Spotify URI of a context to play (album, playlist, or artist), e.g.
   * "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M". Mutually exclusive with `trackUris`.
   */
  contextUri?: string;
  /** Explicit list of "spotify:track:" URIs to play. Mutually exclusive with `contextUri`. */
  trackUris?: string[];
  /** Where to start within the context: 0-based track offset. */
  offsetPosition?: number;
  /** Position within the first track to start at, in ms. */
  positionMs?: number;
  /** Target device ID. Defaults to the user's currently active device. */
  deviceId?: string;
};

/** Fields that can be changed on a playlist. All optional; omitted fields are left unchanged. */
export type SpotifyPlaylistDetailsUpdate = {
  /** New playlist name. */
  name?: string;
  /** New description. */
  description?: string;
  /** Whether the playlist should be public. */
  public?: boolean;
  /** Whether the playlist should be collaborative (only valid for private playlists). */
  collaborative?: boolean;
};

// ---------------------------------------------------------------------------
// Player capability (Spotify Connect)

/**
 * Controls playback on the user's Spotify Connect devices. Obtained from
 * `SpotifyAccountSession.getPlayer()`.
 *
 * Playback control requires a Spotify Premium account; methods will fail for free accounts.
 *
 * Reads such as `getState()` reflect Spotify's actual current device/playback state.
 *
 * Dispose this stub when done.
 */
export interface SpotifyPlayer {
  /** Read the current playback state. Observation. */
  getState(): Promise<SpotifyPlaybackState>;

  /**
   * List the user's available Spotify Connect devices. Observation.
   * NOTE: Spotify's API can omit some third-party Connect endpoints (e.g. Music Assistant) even
   * when they're actively playing, and `getState().device` may misidentify the active device in
   * that situation. First-party Spotify apps are reported reliably.
   */
  getDevices(): Promise<SpotifyDevice[]>;

  /** Read the upcoming playback queue (currently playing plus what's next). Observation. */
  getQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }>;

  /** Read recently played tracks, most recent first (max 50). Observation. */
  getRecentlyPlayed(limit?: number): Promise<SpotifyPlayHistoryEntry[]>;

  /** Start or resume playback. Action. With no options, resumes the current device. */
  play(options?: SpotifyPlayOptions): Promise<void>;

  /** Pause playback. Action. */
  pause(deviceId?: string): Promise<void>;

  /** Skip to the next track. Action. */
  next(deviceId?: string): Promise<void>;

  /** Skip to the previous track. Action. */
  previous(deviceId?: string): Promise<void>;

  /** Seek to a position (ms) within the current track. Action. */
  seek(positionMs: number, deviceId?: string): Promise<void>;

  /** Set the playback volume, 0-100. Action. Not supported on all devices. */
  setVolume(volumePercent: number, deviceId?: string): Promise<void>;

  /** Turn shuffle on or off. Action. */
  setShuffle(shuffle: boolean, deviceId?: string): Promise<void>;

  /** Set the repeat mode. Action. */
  setRepeat(mode: SpotifyRepeatMode, deviceId?: string): Promise<void>;

  /**
   * Move playback to a specific device. Action. `play` controls whether it resumes immediately.
   * Device validity isn't checked up front (devices come and go); use `getDevices()` for a current
   * id. NOTE: transferring to a stale/unavailable device can fail silently (Spotify accepts the
   * request but playback doesn't move), and some third-party Connect endpoints can't be targeted
   * reliably — confirm with a follow-up `getState()`.
   */
  transferTo(deviceId: string, play?: boolean): Promise<void>;

  /** Append a track to the end of the queue. Action. `uri` must be a "spotify:track:" URI. */
  addToQueue(uri: string, deviceId?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Playlist capability

/**
 * Read and edit a single playlist. Obtained from `SpotifyAccountSession.getPlaylist()` /
 * `createPlaylist()`, or granted directly as the fine-grained "Spotify Playlist" resource.
 *
 * Editing a playlist requires that the connected user owns it (or that it is collaborative).
 *
 * Dispose this stub when done.
 */
export interface SpotifyPlaylist {
  /** Read playlist metadata (name, owner, counts, etc.). Observation. */
  getDetails(): Promise<SpotifyPlaylistSummary>;

  /**
   * Read tracks in the playlist, in order. Observation.
   * NOTE: Spotify only returns track contents for playlists the connected user owns or
   * collaborates on; for other playlists this returns an empty list (only metadata is available
   * via getDetails()).
   * @param limit Max items to return (default 50, max 50).
   * @param offset 0-based index to start from.
   */
  listTracks(limit?: number, offset?: number): Promise<SpotifyPlaylistTrack[]>;

  /**
   * Add tracks to the playlist. Action. At most 100 URIs per call.
   * @param trackUris Spotify track URIs to add.
   * @param position 0-based insert position; appends to the end if omitted.
   */
  addTracks(trackUris: string[], position?: number): Promise<void>;

  /** Remove all occurrences of the given track URIs from the playlist. Action. */
  removeTracks(trackUris: string[]): Promise<void>;

  /**
   * Move a contiguous block of tracks to a new position. Action.
   * @param rangeStart 0-based index of the first track to move.
   * @param insertBefore 0-based index to insert the moved block before.
   * @param rangeLength Number of tracks to move (default 1).
   */
  reorderTracks(rangeStart: number, insertBefore: number, rangeLength?: number): Promise<void>;

  /** Replace the playlist's entire track list with the given URIs (in order). Action. Max 100 URIs. */
  replaceTracks(trackUris: string[]): Promise<void>;

  /** Change playlist name/description/visibility. Action. */
  changeDetails(update: SpotifyPlaylistDetailsUpdate): Promise<void>;

  /**
   * Remove this playlist from the connected user's library. Action. For a playlist the user owns,
   * this is how Spotify "deletes" it; for a followed playlist, it unfollows.
   */
  unfollow(): Promise<void>;

  /** Add this playlist to the connected user's library (follow it). Action. */
  follow(): Promise<void>;

  /** Whether this playlist is currently in the user's library (followed). Observation. */
  isFollowing(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Account session (whole-instance grant)

/**
 * Broad access to the connected Spotify account. Granted as the whole-instance "Spotify Account"
 * resource. Acts as a directory that hands out narrower `SpotifyPlayer` and `SpotifyPlaylist`
 * capabilities.
 */
export interface SpotifyAccountSession {
  /** Read the connected user's profile. Observation. */
  getProfile(): Promise<SpotifyProfile>;

  /**
   * Search the Spotify catalog. Observation.
   * @param query Search string (supports Spotify field filters like "artist:" and "year:").
   * @param types Which item kinds to search for.
   * @param limit Max results per type (default 10, max 10; Spotify lowered this cap in Feb 2026).
   */
  search(query: string, types: SpotifySearchType[], limit?: number): Promise<SpotifySearchResults>;

  /** Get full details for a track by ID. Observation. */
  getTrack(trackId: string): Promise<SpotifyTrack>;

  // --- Library (Your Music) ---

  /**
   * List the user's saved tracks, most recently saved first. Observation. (max limit 50)
   * A page may contain fewer than `limit` items even when more exist; don't treat a short page as
   * the end of the library. Paginate by `offset` until a page comes back empty.
   */
  listSavedTracks(limit?: number, offset?: number): Promise<SpotifyTrack[]>;

  /**
   * List the user's saved albums, most recently saved first. Observation. (max limit 50)
   * A page may contain fewer than `limit` items even when more exist; don't treat a short page as
   * the end of the library. Paginate by `offset` until a page comes back empty.
   */
  listSavedAlbums(limit?: number, offset?: number): Promise<SpotifyAlbumRef[]>;

  /** Check whether each given track ID is saved in the user's library. Observation. */
  areTracksSaved(trackIds: string[]): Promise<boolean[]>;

  /** Check whether each given album ID is saved in the user's library. Observation. */
  areAlbumsSaved(albumIds: string[]): Promise<boolean[]>;

  /** Get the user's top tracks for a time range. Observation. (max limit 50) */
  getTopTracks(timeRange?: SpotifyTopTimeRange, limit?: number): Promise<SpotifyTrack[]>;

  /** Get the user's top artists for a time range. Observation. (max limit 50) */
  getTopArtists(timeRange?: SpotifyTopTimeRange, limit?: number): Promise<SpotifyArtistRef[]>;

  /** Save tracks to the user's library. Action. */
  saveTracks(trackIds: string[]): Promise<void>;

  /** Remove tracks from the user's library. Action. */
  removeSavedTracks(trackIds: string[]): Promise<void>;

  /** Save albums to the user's library. Action. */
  saveAlbums(albumIds: string[]): Promise<void>;

  /** Remove albums from the user's library. Action. */
  removeSavedAlbums(albumIds: string[]): Promise<void>;

  // --- Following ---

  /** Follow artists. Action. */
  followArtists(artistIds: string[]): Promise<void>;

  /** Unfollow artists. Action. */
  unfollowArtists(artistIds: string[]): Promise<void>;

  /** Check whether each given artist ID is currently followed by the user. Observation. */
  isFollowingArtists(artistIds: string[]): Promise<boolean[]>;

  // --- Playlists ---

  /**
   * List the connected user's playlists (owned and followed). Observation. (max limit 50)
   * Page size is approximate: the first page (offset 0) may return more than `limit` items, and any
   * page may return fewer than `limit` even when more exist. Don't treat a short page as the end of
   * the list; paginate by `offset` until a page comes back empty.
   */
  listPlaylists(limit?: number, offset?: number): Promise<SpotifyPlaylistSummary[]>;

  /**
   * Get a capability for an existing playlist. Does not fetch anything until used.
   * Dispose the returned stub when done.
   */
  getPlaylist(playlistId: string): SpotifyPlaylist;

  /**
   * Create a new playlist owned by the connected user and return a capability for it. Action.
   * Dispose the returned stub when done. `public` defaults to true, as at Spotify, unless
   * `collaborative` is true: a collaborative playlist must be private.
   */
  createPlaylist(
    name: string,
    options?: { description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<SpotifyPlaylist>;

  /**
   * Get the playback control capability for this account (Spotify Connect). Requires Premium.
   * Dispose the returned stub when done.
   */
  getPlayer(): SpotifyPlayer;
}
