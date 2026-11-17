export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitLabProjectConfiguratorValues = {
  projectPath?: string | null;
  /** `"full"` (the default): the whole project. `"contributor"`: push under a branch prefix and open merge requests only. */
  access?: "full" | "contributor" | null;
  /** The contributor binding's branch namespace, ending with `/`. */
  branchPrefix?: string | null;
  /** `"true"` lets the contributor binding write to the project while it is public. */
  allowPublic?: "true" | "false" | null;
}

export interface GitLabProjectConfiguratorRpc {
  /** The browser-facing instance origin, e.g. `https://gitlab.com`. */
  instanceUrl(): Promise<string>;
  listProjects(query: string): Promise<ConfiguratorOption[]>;
}
