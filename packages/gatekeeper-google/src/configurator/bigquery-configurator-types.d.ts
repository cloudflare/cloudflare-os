export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type BigQueryConfiguratorValues = {
  projectId?: string | null;
  datasetId?: string | null;
  tableId?: string | null;
}

/** Values of the "BigQuery Public Data" configurator, which names two projects, not one. */
export type BigQueryPublicConfiguratorValues = {
  /** One of the user's own projects; the query jobs are billed here. */
  billingProjectId?: string | null;
  /** An allowlisted public project; the only one whose data the connection can read. */
  dataProjectId?: string | null;
  datasetId?: string | null;
  tableId?: string | null;
}

export interface BigQueryConfiguratorRpc {
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  /** The public-data projects a "BigQuery Public Data" connection may be pointed at. */
  listPublicProjects(query: string): Promise<ConfiguratorOption[]>;
  listDatasets(projectId: string, query: string): Promise<ConfiguratorOption[]>;
  listTables(projectId: string, datasetId: string, query: string): Promise<ConfiguratorOption[]>;
}
