export type ChatAccountConfiguratorValues = {
  scope?: string | null;
};

/** The whole-account Chat resource needs nothing chosen, so the iframe gets no capability. */
export interface ChatAccountConfiguratorRpc {}
