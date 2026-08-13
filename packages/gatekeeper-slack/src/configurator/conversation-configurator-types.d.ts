export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type ConversationConfiguratorValues = {
  conversationId?: string | null;
};

export interface ConversationConfiguratorRpc {
  /** The connected workspace's team ID, used to build the canonical conversation URL. */
  getTeamId(): Promise<string>;
  /** Search the channels and direct messages the connected user can access. */
  listConversations(query: string): Promise<ConfiguratorOption[]>;
}
