export type WorkspaceConfiguratorValues = Record<string, never>;

export interface WorkspaceConfiguratorRpc {
  /** The canonical URL of the connected workspace, e.g. "https://app.slack.com/client/T012AB3CD". */
  getWorkspaceUrl(): Promise<string>;
}
