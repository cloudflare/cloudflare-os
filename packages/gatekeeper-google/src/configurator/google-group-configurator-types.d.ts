import type { ConfiguratorOption } from "./configurator-option";

export type GoogleGroupConfiguratorValues = {
  /** The group's email address. */
  email?: string | null;
};

export interface GoogleGroupConfiguratorRpc {
  /**
   * The groups this account belongs to, filtered by `query`, or the one group a typed email address
   * or pasted groups.google.com link names.
   */
  listGroups(query: string): Promise<ConfiguratorOption[]>;
}
