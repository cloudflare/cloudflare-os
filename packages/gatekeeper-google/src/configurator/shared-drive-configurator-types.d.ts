export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type SharedDriveConfiguratorValues = { driveId?: string | null };

export interface SharedDriveConfiguratorRpc {
  listSharedDrives(query: string): Promise<ConfiguratorOption[]>;
}
