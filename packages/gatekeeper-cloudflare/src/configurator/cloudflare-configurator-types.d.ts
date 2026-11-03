import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

export type CloudflareAccountConfiguratorValues = {
  accountId?: string | null;
};

export type CloudflareWorkerConfiguratorValues = {
  accountId?: string | null;
  workerName?: string | null;
};

export interface CloudflareAccountConfiguratorRpc {
  listAccounts(query: string): Promise<ConfiguratorUIOption[]>;
}

export interface CloudflareWorkerConfiguratorRpc extends CloudflareAccountConfiguratorRpc {
  listWorkers(accountId: string, query: string): Promise<ConfiguratorUIOption[]>;
}

export type CloudflareNotificationsConfiguratorValues = CloudflareAccountConfiguratorValues & {
  status?: string | null;
  statusDetails?: string | null;
};
export type CloudflareNotificationsSetupStatus = {
  summary: string;
  details?: string;
};

export interface CloudflareNotificationsConfiguratorRpc extends CloudflareAccountConfiguratorRpc {
  getSetupStatus(accountId: string): Promise<CloudflareNotificationsSetupStatus>;
}
