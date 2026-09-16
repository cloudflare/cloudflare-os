/** Shared option shape for autocomplete dropdowns in the resource configurators. */
export type HomeAssistantConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

// Values & RPC interfaces for each per-resource configurator.

export type HomeAssistantAreaConfiguratorValues = {
  areaId?: string | null;
};
export interface HomeAssistantAreaConfiguratorRpc {
  listAreas(query: string): Promise<HomeAssistantConfiguratorOption[]>;
  resourceUrl(areaId: string | null | undefined): Promise<string>;
}

export type HomeAssistantLabelConfiguratorValues = {
  labelId?: string | null;
};
export interface HomeAssistantLabelConfiguratorRpc {
  listLabels(query: string): Promise<HomeAssistantConfiguratorOption[]>;
  resourceUrl(labelId: string | null | undefined): Promise<string>;
}

export type HomeAssistantDeviceConfiguratorValues = {
  deviceId?: string | null;
};
export interface HomeAssistantDeviceConfiguratorRpc {
  listDevices(query: string): Promise<HomeAssistantConfiguratorOption[]>;
  resourceUrl(deviceId: string | null | undefined): Promise<string>;
}

export type HomeAssistantEntityConfiguratorValues = {
  entityId?: string | null;
};
export interface HomeAssistantEntityConfiguratorRpc {
  listEntities(query: string): Promise<HomeAssistantConfiguratorOption[]>;
  resourceUrl(entityId: string | null | undefined): Promise<string>;
}
