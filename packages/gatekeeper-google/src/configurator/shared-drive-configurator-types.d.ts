import type { ConfiguratorOption } from "./configurator-option";

export type SharedDriveConfiguratorValues = { driveId?: string | null };

export interface SharedDriveConfiguratorRpc {
  listSharedDrives(query: string): Promise<ConfiguratorOption[]>;
}
