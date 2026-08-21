export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type DriveFileConfiguratorValues = { fileId?: string | null };

export interface DriveFileConfiguratorRpc {
  listDriveFiles(query: string): Promise<ConfiguratorOption[]>;
}
