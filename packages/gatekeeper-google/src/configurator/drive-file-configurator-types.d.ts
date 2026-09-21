import type { ConfiguratorOption } from "./configurator-option";

export type DriveFileConfiguratorValues = { fileId?: string | null };

export interface DriveFileConfiguratorRpc {
  listDriveFiles(query: string): Promise<ConfiguratorOption[]>;
}
