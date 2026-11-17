export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitHubRepoConfiguratorValues = {
  repoFullName?: string | null;
  /** `"full"` (the default): the whole repository. `"contributor"`: push under a branch prefix and open pull requests only. */
  access?: "full" | "contributor" | null;
  /** The contributor binding's branch namespace, ending with `/`. */
  branchPrefix?: string | null;
  /** `"true"` lets the contributor binding write to the repository while it is public. */
  allowPublic?: "true" | "false" | null;
}

export interface GitHubRepoConfiguratorRpc {
  listRepos(query: string): Promise<ConfiguratorOption[]>;
}
