import type { ConfiguratorOption } from "./configurator-option";

export type ChatSpaceConfiguratorValues = {
  /** The Chat space id, without its `spaces/` prefix. */
  spaceId?: string | null;
};

export interface ChatSpaceConfiguratorRpc {
  /** Conversations this account has joined, filtered by `query`. */
  listChatSpaces(query: string): Promise<ConfiguratorOption[]>;
}
