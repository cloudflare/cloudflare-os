export type SpotifyConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type SpotifyPlaylistConfiguratorValues = {
  /**
   * The selected playlist's ID. Matches the `:playlistId` group of the resource URL pattern, so
   * the runtime can pre-fill it from a known resource URL automatically.
   */
  playlistId?: string | null;
};

export interface SpotifyPlaylistConfiguratorRpc {
  /**
   * Search the user's own playlists, a playlist URL/URI/ID, or the public catalog. Returns options
   * whose `value` is the playlist ID.
   */
  listPlaylists(query: string): Promise<SpotifyConfiguratorOption[]>;
}
