export type GitLabInstanceConfiguratorValues = Record<string, never>;

export interface GitLabInstanceConfiguratorRpc {
  /** The browser-facing instance origin, e.g. `https://gitlab.example.com`. */
  instanceUrl(): Promise<string>;
}
