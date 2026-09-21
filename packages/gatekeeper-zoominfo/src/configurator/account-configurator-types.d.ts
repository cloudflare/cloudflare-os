export type ZoomInfoAccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants whole-account access. A placeholder
   * field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface ZoomInfoAccountConfiguratorRpc {
  /** Returns the canonical resource URL for the connected account. */
  resourceUrl(): Promise<string>;
}
