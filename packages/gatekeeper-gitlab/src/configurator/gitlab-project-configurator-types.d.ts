export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type GitLabProjectConfiguratorValues = {
  projectPath?: string | null;
}

export interface GitLabProjectConfiguratorRpc {
  /** The browser-facing instance origin, e.g. `https://gitlab.com`. */
  instanceUrl(): Promise<string>;
  listProjects(query: string): Promise<ConfiguratorOption[]>;
}
