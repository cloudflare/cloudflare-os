export type HomeAssistantInstanceConfiguratorValues = {
  /**
   * No user-selectable values: the configurator simply confirms the account.
   * We keep a placeholder field so that `isReady` has something to check.
   */
  confirmed?: string | null;
};

export interface HomeAssistantInstanceConfiguratorRpc {
  /** Returns the canonical resource URL (the connected account's HA base URL). */
  resourceUrl(): Promise<string>;

  /** Returns a human-readable name for the connected HA instance, to be shown in the picker. */
  describeInstance(): Promise<{ name: string; baseUrl: string }>;
}
