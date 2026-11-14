export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitLabIssueConfiguratorValues = {
  projectPath?: string | null;
  issueIid?: string | null;
}

export interface GitLabIssueConfiguratorRpc {
  instanceUrl(): Promise<string>;
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  listIssues(projectPath: string | null | undefined, query: string): Promise<ConfiguratorOption[]>;
}
