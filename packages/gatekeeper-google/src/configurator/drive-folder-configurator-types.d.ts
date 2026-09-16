import type { ConfiguratorOption } from "./configurator-option";

export type DriveFolderConfiguratorValues = {
  source?: "folders" | "sharedDrives" | null;
  folderId?: string | null;
};

export interface DriveFolderConfiguratorRpc {
  listDriveFolders(query: string): Promise<ConfiguratorOption[]>;
  listSharedDrives(query: string): Promise<ConfiguratorOption[]>;
}
