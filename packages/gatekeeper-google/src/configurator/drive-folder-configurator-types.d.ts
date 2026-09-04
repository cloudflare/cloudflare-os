import type { ConfiguratorOption } from "./configurator-option";

export type DriveFolderConfiguratorValues = { folderId?: string | null };

export interface DriveFolderConfiguratorRpc {
  listDriveFolders(query: string): Promise<ConfiguratorOption[]>;
}
