export type ThreadConfiguratorValues = {
  permalink?: string | null;
};

export interface ThreadConfiguratorRpc {
  /** Placeholder required by the configurator UI capability contract. */
  ping(): Promise<void>;
}
