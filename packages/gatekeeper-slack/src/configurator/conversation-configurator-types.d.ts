export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type ConversationConfiguratorValues = {
  teamId?: string | null;
  conversationId?: string | null;
};

export interface ConversationConfiguratorRpc {
  /** Workspaces granted to the app and joined by this user. */
  listWorkspaces(query: string): Promise<ConfiguratorOption[]>;
  /** Search the channels and direct messages the connected user can access. */
  listConversations(teamId: string, query: string): Promise<ConfiguratorOption[]>;
}
