export type XAccountConfiguratorValues = {
  /**
   * No user-selectable values: the whole connected account is bound. A placeholder gives
   * `isReady` something to check.
   */
  confirmed?: string | null;
};

/** The account configurator asks nothing of the gatekeeper. */
export interface XAccountConfiguratorRpc {}
