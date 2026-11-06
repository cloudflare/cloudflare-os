export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitHubIssueConfiguratorValues = {
  repoFullName?: string | null;
  issueNumber?: string | null;
}

export interface GitHubIssueConfiguratorRpc {
  instanceUrl(): Promise<string>;
  listRepos(query: string): Promise<ConfiguratorOption[]>;
  listIssues(repoFullName: string | null | undefined, query: string): Promise<ConfiguratorOption[]>;
}
