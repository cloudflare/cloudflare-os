export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
};

export type DriveFolderConfiguratorValues = {
  folderId?: string | null;
};

export interface DriveFolderConfiguratorRpc {
  listFolders(query: string): Promise<ConfiguratorOption[]>;
}
