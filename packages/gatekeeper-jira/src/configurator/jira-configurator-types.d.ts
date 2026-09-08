/** Option shown by Jira setup and resource picker autocomplete controls. */
export type ConfiguratorOption = { value: string; title: string; subtitle?: string };

/** Persisted default Jira project shown in setup and used when project input is omitted. */
export type JiraDefaultProject = ConfiguratorOption | null;

/** Values owned by Jira setup and resource picker iframes. */
export type JiraConfiguratorValues = { siteUrl?: string; projectUrl?: string; issueUrl?: string; defaultProjectUrl?: string | null; defaultProjectLoadState?: "idle" | "pending" | "loaded" | "failed"; defaultProjectDirty?: "true" };

/** Narrow RPC surface exposed to Jira setup and resource picker iframes. */
export interface JiraConfiguratorRpc {
  /** Lists Jira Cloud sites granted to this connected account. */
  listSites(query: string): Promise<ConfiguratorOption[]>;
  /** Lists projects visible across granted Jira sites. */
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  /** Lists issues visible across granted Jira sites. */
  listIssues(query: string): Promise<ConfiguratorOption[]>;
  /** Reads the optional connected-account default Jira project. */
  getDefaultProject(): Promise<JiraDefaultProject>;
  /** Validates and stores the optional connected-account default Jira project; pass null to clear. */
  setDefaultProject(projectUrl: string | null): Promise<JiraDefaultProject>;
}
