export type XProfileConfiguratorValues = {
  /**
   * The handle, "@handle", or profile link as typed. Named after the `:username` group of the
   * resource URL pattern, so the runtime pre-fills it from a known resource URL.
   */
  username?: string | null;
};

/** The profile configurator asks nothing of the gatekeeper. */
export interface XProfileConfiguratorRpc {}
