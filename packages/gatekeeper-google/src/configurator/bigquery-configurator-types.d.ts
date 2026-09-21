import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type BigQueryConfiguratorValues = {
  projectId?: string | null;
  datasetId?: string | null;
  tableId?: string | null;
}

export interface BigQueryConfiguratorRpc {
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  listDatasets(projectId: string, query: string): Promise<ConfiguratorOption[]>;
  listTables(projectId: string, datasetId: string, query: string): Promise<ConfiguratorOption[]>;
}
