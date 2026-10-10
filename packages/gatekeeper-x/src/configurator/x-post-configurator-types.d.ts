export type XPostConfiguratorValues = {
  /** The post link or ID as typed; parsed in the frame, since a preview would cost a read. */
  postUrl?: string | null;
};

/** The post configurator asks nothing of the gatekeeper. */
export interface XPostConfiguratorRpc {}
