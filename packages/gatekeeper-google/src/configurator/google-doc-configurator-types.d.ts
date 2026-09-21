import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type GoogleDocConfiguratorValues = {
  docId?: string | null;
}

export interface GoogleDocConfiguratorRpc {
  listDocs(query: string): Promise<ConfiguratorOption[]>;
}
