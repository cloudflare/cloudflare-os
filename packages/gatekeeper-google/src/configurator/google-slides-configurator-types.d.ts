import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type GoogleSlidesConfiguratorValues = {
  presentationId?: string | null;
}

export interface GoogleSlidesConfiguratorRpc {
  listPresentations(query: string): Promise<ConfiguratorOption[]>;
}
