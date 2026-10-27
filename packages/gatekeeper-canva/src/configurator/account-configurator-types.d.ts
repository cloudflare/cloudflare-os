export type CanvaAccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants whole-account access. A placeholder
   * field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface CanvaAccountConfiguratorRpc {
  /** Returns the canonical resource URL for the connected account (the user's Projects page). */
  resourceUrl(): Promise<string>;
}
