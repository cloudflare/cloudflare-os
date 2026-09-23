export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitLabMergeRequestConfiguratorValues = {
  projectPath?: string | null;
  mergeRequestIid?: string | null;
}

export interface GitLabMergeRequestConfiguratorRpc {
  instanceUrl(): Promise<string>;
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  listMergeRequests(projectPath: string | null | undefined, query: string): Promise<ConfiguratorOption[]>;
}
