/** One choice in a picker's autocomplete. */
export type PickerOption = { value: string; title: string; subtitle?: string; meta?: string };

/** What the Network pickers can ask the gatekeeper. Every list filters by `query`, on name and ID. */
export interface NetworkPickerRpc {
  /** Consoles this connection can use UniFi Network on. */
  listConsoles(query: string): Promise<PickerOption[]>;
  /** A console's sites. */
  listSites(consoleId: string, query: string): Promise<PickerOption[]>;
  /** A site's devices. */
  listDevices(consoleId: string, siteId: string, query: string): Promise<PickerOption[]>;
  /** A site's WiFi networks. */
  listWifiNetworks(consoleId: string, siteId: string, query: string): Promise<PickerOption[]>;
}

/** What the Protect pickers can ask the gatekeeper. Every list filters by `query`, on name and ID. */
export interface ProtectPickerRpc {
  /** Consoles this connection can use UniFi Protect on. */
  listConsoles(query: string): Promise<PickerOption[]>;
  /** A console's cameras. */
  listCameras(consoleId: string, query: string): Promise<PickerOption[]>;
  /** A console's sensors. */
  listSensors(consoleId: string, query: string): Promise<PickerOption[]>;
  /** A console's floodlights. */
  listLights(consoleId: string, query: string): Promise<PickerOption[]>;
}

/** Values of the site and hotspot pickers. */
export type SiteValues = { consoleId?: string | null; siteId?: string | null };

/** Values of the device picker; `clients` is "1" when the device's clients are included. */
export type DeviceValues = SiteValues & { deviceId?: string | null; clients?: string | null };

/** Values of the WiFi network picker. */
export type WifiValues = SiteValues & { wifiNetworkId?: string | null };

/** Values of the Protect picker. */
export type ProtectValues = { consoleId?: string | null };

/** Values of the camera picker. */
export type CameraValues = ProtectValues & { cameraId?: string | null };

/** Values of the sensor picker. */
export type SensorValues = ProtectValues & { sensorId?: string | null };

/** Values of the floodlight picker. */
export type LightValues = ProtectValues & { lightId?: string | null };
