export type WorkspaceConfiguratorValues = { teamId?: string | null };

export interface WorkspaceConfiguratorRpc {
  /** Workspaces granted to the app and joined by this user. */
  listWorkspaces(query: string): Promise<{ value: string; title: string; subtitle?: string }[]>;
}
