export type SpotifyAccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants whole-account access. A placeholder
   * field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface SpotifyAccountConfiguratorRpc {
  /** Returns the canonical resource URL for the connected account (the user's profile URL). */
  resourceUrl(): Promise<string>;
}
