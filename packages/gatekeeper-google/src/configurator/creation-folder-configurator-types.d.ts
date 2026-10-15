import type { ConfiguratorOption } from "./configurator-option";

export type CreationFolderConfiguratorValues = {
  location?: "myDrive" | "folder";
  folderId?: string | null;
};

export interface CreationFolderConfiguratorRpc {
  listCreationFolders(query: string): Promise<ConfiguratorOption[]>;
}
