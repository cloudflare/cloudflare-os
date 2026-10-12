/**
 * Turns UniFi API responses into the shapes agents see (network-types.d.ts, protect-types.d.ts).
 *
 * Nothing here trusts a response's shape: a missing or mistyped required field is a `protocol`
 * error, and an optional one becomes `null`. Enumerations map onto small agent-facing sets with an
 * `"unknown"` fallback, so a firmware update that adds a state degrades instead of breaking.
 *
 * Pure: imported by the Node tests.
 */

import { UnifiError } from "./errors";
import type {
  UnifiClient, UnifiClientDetails, UnifiClientType, UnifiDevice, UnifiDeviceDetails,
  UnifiDevicePort, UnifiDeviceRadio, UnifiDeviceRole, UnifiDeviceState, UnifiDeviceStatistics,
  UnifiGuestAuthorization, UnifiLanNetwork, UnifiVoucher, UnifiWifiNetworkInfo,
  UnifiWifiNetworkSummary, UnifiWifiSecurity,
} from "./network-types";
import type {
  UnifiArmStatus, UnifiCameraInfo, UnifiDoorbellDisplay, UnifiLightInfo, UnifiLightMode,
  UnifiProtectDeviceState, UnifiSensorInfo, UnifiSmartDetectType,
} from "./protect-types";

// ---------------------------------------------------------------------------
// Field access

type Json = Record<string, unknown>;

function fail(what: string): never {
  throw new UnifiError({ kind: "protocol", message: `UniFi returned an unexpected ${what}.` });
}

/** The value as an object, or a protocol error naming `what`. */
export function asObject(value: unknown, what: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(what);
  return value as Json;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(what);
  return value;
}

function str(o: Json, key: string, what: string): string {
  const value = o[key];
  if (typeof value !== "string") fail(`${what} (no ${key})`);
  return value;
}

function optStr(o: Json, key: string): string | null {
  const value = o[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function num(o: Json, key: string, what: string): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what} (no ${key})`);
  return value;
}

function optNum(o: Json, key: string): number | null {
  const value = o[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(o: Json, key: string, fallback = false): boolean {
  const value = o[key];
  return typeof value === "boolean" ? value : fallback;
}

function optObject(o: Json, key: string): Json | null {
  const value = o[key];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function optArray(o: Json, key: string): unknown[] {
  const value = o[key];
  return Array.isArray(value) ? value : [];
}

function isoDate(o: Json, key: string): Date | null {
  const value = o[key];
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function epochDate(o: Json, key: string): Date | null {
  const value = o[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

/** A MAC address as lowercase colon-separated hex, from any common spelling. */
export function normalizeMac(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.length === 12 ? hex.match(/../g)!.join(":") : value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Pages

/** One page of a Network list endpoint. */
export type NetworkPage = { data: unknown[]; totalCount: number };

/** Parses a Network list response: `{offset, limit, count, totalCount, data}`. */
export function parseNetworkPage(body: unknown, what: string): NetworkPage {
  const o = asObject(body, what);
  const data = asArray(o.data, what);
  return { data, totalCount: optNum(o, "totalCount") ?? data.length };
}

// ---------------------------------------------------------------------------
// Network: application and sites

/** Parses `GET /v1/info`. */
export function parseNetworkInfo(body: unknown): { applicationVersion: string } {
  return { applicationVersion: str(asObject(body, "Network application info"), "applicationVersion", "Network application info") };
}

/** A site, as Network lists it. */
export type NetworkSite = { id: string; name: string; internalReference: string | null };

/** Parses one site from `GET /v1/sites`. */
export function parseSite(value: unknown): NetworkSite {
  const o = asObject(value, "site");
  return { id: str(o, "id", "site"), name: str(o, "name", "site"), internalReference: optStr(o, "internalReference") };
}

// ---------------------------------------------------------------------------
// Network: devices

const DEVICE_STATES: Record<string, UnifiDeviceState> = {
  ONLINE: "online",
  OFFLINE: "offline",
  GETTING_READY: "starting",
  UPDATING: "updating",
  ADOPTING: "adopting",
  PENDING_ADOPTION: "adopting",
  CONNECTION_INTERRUPTED: "disconnected",
  ISOLATED: "disconnected",
};

const DEVICE_ROLES: Record<string, UnifiDeviceRole> = {
  gateway: "gateway", switching: "switch", accessPoint: "accessPoint",
};

/**
 * A device's roles, from the device list's `features` names. Only the list says whether a device is
 * a gateway: the details' `features` are an object keyed by feature, with no key for one.
 */
function deviceRoles(features: unknown): UnifiDeviceRole[] {
  const names = Array.isArray(features) ? features.filter((name): name is string => typeof name === "string") : [];
  const order: UnifiDeviceRole[] = ["gateway", "switch", "accessPoint"];
  const roles = new Set(names.map(name => DEVICE_ROLES[name]).filter(role => role !== undefined));
  return order.filter(role => roles.has(role));
}

/** Parses one device from `GET /v1/sites/{siteId}/devices`. */
export function parseDevice(value: unknown): UnifiDevice {
  const o = asObject(value, "device");
  const state = o.state;
  return {
    id: str(o, "id", "device"),
    name: str(o, "name", "device"),
    model: str(o, "model", "device"),
    roles: deviceRoles(o.features),
    state: typeof state === "string" ? DEVICE_STATES[state] ?? "unknown" : "unknown",
    macAddress: normalizeMac(str(o, "macAddress", "device")),
    ipAddress: optStr(o, "ipAddress"),
    firmwareVersion: optStr(o, "firmwareVersion"),
    firmwareUpdateAvailable: bool(o, "firmwareUpdatable"),
  };
}

const POE_STATES: Record<string, boolean | "limited"> = { UP: true, DOWN: false, LIMITED: "limited" };

function parsePort(value: unknown): UnifiDevicePort {
  const o = asObject(value, "device port");
  const poe = optObject(o, "poe");
  const state = o.state;
  return {
    index: num(o, "idx", "device port"),
    state: state === "UP" ? "up" : state === "DOWN" ? "down" : "unknown",
    speedMbps: optNum(o, "speedMbps"),
    maxSpeedMbps: optNum(o, "maxSpeedMbps") ?? 0,
    connector: optStr(o, "connector") ?? "unknown",
    poe: poe === null ? null : {
      enabled: bool(poe, "enabled"),
      supplying: typeof poe.state === "string" ? POE_STATES[poe.state] ?? null : null,
      standard: optStr(poe, "standard") ?? "unknown",
    },
  };
}

function parseRadio(value: unknown): UnifiDeviceRadio {
  const o = asObject(value, "device radio");
  return {
    frequencyGHz: num(o, "frequencyGHz", "device radio"),
    channel: optNum(o, "channel"),
    channelWidthMHz: optNum(o, "channelWidthMHz") ?? 0,
    standard: optStr(o, "wlanStandard") ?? "unknown",
  };
}

/** Parses `GET /v1/sites/{siteId}/devices/{deviceId}`. */
export function parseDeviceDetails(value: unknown, roles: UnifiDeviceRole[]): UnifiDeviceDetails {
  const o = asObject(value, "device");
  const interfaces = optObject(o, "interfaces") ?? {};
  const uplink = optObject(o, "uplink");
  return {
    ...parseDevice(o),
    roles,
    adoptedAt: isoDate(o, "adoptedAt"),
    uplinkDeviceId: uplink ? optStr(uplink, "deviceId") : null,
    ports: optArray(interfaces, "ports").map(parsePort).toSorted((a, b) => a.index - b.index),
    radios: optArray(interfaces, "radios").map(parseRadio),
  };
}

/** Parses `GET /v1/sites/{siteId}/devices/{deviceId}/statistics/latest`. */
export function parseDeviceStatistics(value: unknown): UnifiDeviceStatistics {
  const o = asObject(value, "device statistics");
  const uplink = optObject(o, "uplink") ?? {};
  const interfaces = optObject(o, "interfaces") ?? {};
  return {
    uptimeSeconds: optNum(o, "uptimeSec"),
    cpuPercent: optNum(o, "cpuUtilizationPct"),
    memoryPercent: optNum(o, "memoryUtilizationPct"),
    uplinkRxBitsPerSecond: optNum(uplink, "rxRateBps"),
    uplinkTxBitsPerSecond: optNum(uplink, "txRateBps"),
    radios: optArray(interfaces, "radios").map(radio => {
      const r = asObject(radio, "radio statistics");
      return { frequencyGHz: num(r, "frequencyGHz", "radio statistics"), txRetriesPercent: optNum(r, "txRetriesPct") };
    }),
    lastSeenAt: isoDate(o, "lastHeartbeatAt"),
  };
}

// ---------------------------------------------------------------------------
// Network: clients

const CLIENT_TYPES: Record<string, UnifiClientType> = {
  WIRED: "wired", WIRELESS: "wireless", VPN: "vpn", TELEPORT: "teleport",
};

function clientBase(o: Json): Omit<UnifiClient, "guest"> {
  const type = o.type;
  const mac = optStr(o, "macAddress");
  return {
    id: str(o, "id", "client"),
    name: optStr(o, "name") ?? mac ?? str(o, "id", "client"),
    type: typeof type === "string" ? CLIENT_TYPES[type] ?? "wired" : "wired",
    ipAddress: optStr(o, "ipAddress"),
    macAddress: mac === null ? null : normalizeMac(mac),
    connectedAt: isoDate(o, "connectedAt"),
    uplinkDeviceId: optStr(o, "uplinkDeviceId"),
  };
}

/** Parses one client from `GET /v1/sites/{siteId}/clients`. */
export function parseClient(value: unknown): UnifiClient {
  const o = asObject(value, "client");
  const access = optObject(o, "access");
  const isGuest = access?.type === "GUEST";
  return { ...clientBase(o), guest: isGuest ? { authorized: bool(access!, "authorized") } : null };
}

/** Parses a guest authorization, from client details or a client action's response. */
export function parseGuestAuthorization(authorized: boolean, value: unknown): UnifiGuestAuthorization {
  const a = value === undefined || value === null ? {} : asObject(value, "guest authorization");
  const method = a.authorizationMethod;
  const usage = optObject(a, "usage");
  return {
    authorized,
    method: method === "VOUCHER" ? "voucher" : method === "API" ? "api" : method === "OTHER" ? "other" : null,
    authorizedAt: isoDate(a, "authorizedAt"),
    expiresAt: isoDate(a, "expiresAt"),
    dataLimitMB: optNum(a, "dataUsageLimitMBytes"),
    downloadLimitKbps: optNum(a, "rxRateLimitKbps"),
    uploadLimitKbps: optNum(a, "txRateLimitKbps"),
    bytesUsed: usage ? optNum(usage, "bytes") : null,
  };
}

/** Parses `GET /v1/sites/{siteId}/clients/{clientId}`. */
export function parseClientDetails(value: unknown): UnifiClientDetails {
  const o = asObject(value, "client");
  const access = optObject(o, "access");
  const guest = access?.type === "GUEST"
    ? parseGuestAuthorization(bool(access, "authorized"), access.authorization)
    : null;
  return { ...clientBase(o), guest };
}

// ---------------------------------------------------------------------------
// Network: networks and WiFi

/** Parses one network from `GET /v1/sites/{siteId}/networks`. */
export function parseLanNetwork(value: unknown): UnifiLanNetwork {
  const o = asObject(value, "network");
  const management = o.management;
  return {
    id: str(o, "id", "network"),
    name: str(o, "name", "network"),
    vlanId: num(o, "vlanId", "network"),
    enabled: bool(o, "enabled", true),
    isDefault: bool(o, "default"),
    managedBy: management === "GATEWAY" ? "gateway" : management === "SWITCH" ? "switch" : "unmanaged",
  };
}

const WIFI_SECURITY: Record<string, UnifiWifiSecurity> = {
  OPEN: "open",
  WPA2_PERSONAL: "wpa2",
  WPA3_PERSONAL: "wpa3",
  WPA2_WPA3_PERSONAL: "wpa2/wpa3",
  WPA2_ENTERPRISE: "wpa2-enterprise",
  WPA3_ENTERPRISE: "wpa3-enterprise",
  WPA2_WPA3_ENTERPRISE: "wpa2/wpa3-enterprise",
};

/** The security types whose passphrase `update()` may change. */
export const PERSONAL_SECURITY_TYPES = new Set(["WPA2_PERSONAL", "WPA3_PERSONAL", "WPA2_WPA3_PERSONAL"]);

/** Parses one WiFi network from `GET /v1/sites/{siteId}/wifi/broadcasts`. */
export function parseWifiSummary(value: unknown): UnifiWifiNetworkSummary {
  const o = asObject(value, "WiFi network");
  const security = optObject(o, "securityConfiguration");
  const network = optObject(o, "network");
  const hotspot = optObject(o, "hotspotConfiguration");
  const iot = o.type === "IOT_OPTIMIZED";
  const frequencies = optArray(o, "broadcastingFrequenciesGHz")
    .filter((band): band is number => typeof band === "number");
  return {
    id: str(o, "id", "WiFi network"),
    name: str(o, "name", "WiFi network"),
    enabled: bool(o, "enabled"),
    security: (typeof security?.type === "string" && WIFI_SECURITY[security.type]) || "open",
    // IoT-optimized networks broadcast on 2.4 GHz only and carry no band list.
    frequenciesGHz: frequencies.length > 0 ? frequencies : iot ? [2.4] : [],
    networkId: network?.type === "SPECIFIC" ? optStr(network, "networkId") : null,
    guestPortal: hotspot?.type === "CAPTIVE_PORTAL",
    kind: iot ? "iot" : "standard",
  };
}

/** Parses `GET /v1/sites/{siteId}/wifi/broadcasts/{wifiBroadcastId}`. */
export function parseWifiInfo(value: unknown): UnifiWifiNetworkInfo {
  const o = asObject(value, "WiFi network");
  return { ...parseWifiSummary(o), hidden: bool(o, "hideName"), clientIsolation: bool(o, "clientIsolationEnabled") };
}

/** The WiFi password in WiFi network details, or null for a network without a shared one. */
export function wifiPassphrase(value: unknown): string | null {
  const security = optObject(asObject(value, "WiFi network"), "securityConfiguration");
  return security && typeof security.type === "string" && PERSONAL_SECURITY_TYPES.has(security.type)
    ? optStr(security, "passphrase")
    : null;
}

// ---------------------------------------------------------------------------
// Network: hotspot vouchers

/** Parses one voucher from `GET /v1/sites/{siteId}/hotspot/vouchers`. */
export function parseVoucher(value: unknown): UnifiVoucher {
  const o = asObject(value, "voucher");
  return {
    id: str(o, "id", "voucher"),
    code: optStr(o, "code"),
    note: optStr(o, "name") ?? "",
    createdAt: isoDate(o, "createdAt") ?? fail("voucher (no createdAt)"),
    activatedAt: isoDate(o, "activatedAt"),
    expiresAt: isoDate(o, "expiresAt"),
    expired: bool(o, "expired"),
    durationMinutes: num(o, "timeLimitMinutes", "voucher"),
    guestLimit: optNum(o, "authorizedGuestLimit"),
    guestCount: optNum(o, "authorizedGuestCount") ?? 0,
    dataLimitMB: optNum(o, "dataUsageLimitMBytes"),
    downloadLimitKbps: optNum(o, "rxRateLimitKbps"),
    uploadLimitKbps: optNum(o, "txRateLimitKbps"),
  };
}

// ---------------------------------------------------------------------------
// Protect

/** Parses `GET /v1/meta/info`. */
export function parseProtectInfo(body: unknown): { applicationVersion: string } {
  return { applicationVersion: str(asObject(body, "Protect application info"), "applicationVersion", "Protect application info") };
}

/** The NVR, as Protect describes it. */
export type ProtectNvr = {
  id: string;
  name: string | null;
  macAddress: string;
  alarm: { status: UnifiArmStatus; armedAt: Date | null; breachDetectedAt: Date | null };
};

const ARM_STATUSES = new Set<UnifiArmStatus>(["disabled", "arming", "armed", "breach"]);

/** Parses `GET /v1/nvrs`. */
export function parseNvr(body: unknown): ProtectNvr {
  const o = asObject(body, "NVR");
  const arm = optObject(o, "armMode") ?? {};
  const status = arm.status;
  return {
    id: str(o, "id", "NVR"),
    name: optStr(o, "name"),
    macAddress: normalizeMac(str(o, "mac", "NVR")),
    alarm: {
      status: typeof status === "string" && ARM_STATUSES.has(status as UnifiArmStatus)
        ? status as UnifiArmStatus : "unknown",
      armedAt: epochDate(arm, "armedAt"),
      breachDetectedAt: epochDate(arm, "breachDetectedAt"),
    },
  };
}

function protectState(o: Json): UnifiProtectDeviceState {
  const state = o.state;
  return state === "CONNECTED" ? "connected" : state === "CONNECTING" ? "connecting" : "disconnected";
}

const SMART_DETECT_TYPES = new Set<UnifiSmartDetectType>(
  ["person", "vehicle", "package", "licensePlate", "face", "animal"]);

function smartDetectTypes(value: unknown): UnifiSmartDetectType[] {
  return Array.isArray(value)
    ? value.filter((type): type is UnifiSmartDetectType => SMART_DETECT_TYPES.has(type as UnifiSmartDetectType))
    : [];
}

function doorbellDisplay(value: unknown): UnifiDoorbellDisplay | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Json;
  const until = epochDate(o, "resetAt");
  switch (o.type) {
    case "LEAVE_PACKAGE_AT_DOOR": return { kind: "leavePackageAtDoor", until };
    case "DO_NOT_DISTURB": return { kind: "doNotDisturb", until };
    case "CUSTOM_MESSAGE": return { kind: "text", text: optStr(o, "text") ?? "", until };
    case "IMAGE": return { kind: "image", until };
    default: return null;
  }
}

/** Parses one camera from `GET /v1/cameras`. */
export function parseCamera(value: unknown): UnifiCameraInfo {
  const o = asObject(value, "camera");
  const features = optObject(o, "featureFlags") ?? {};
  const led = optObject(o, "ledSettings");
  const settings = optObject(o, "smartDetectSettings") ?? {};
  const hasMicrophone = bool(features, "hasMic");
  const model = optStr(o, "type");
  return {
    id: str(o, "id", "camera"),
    name: optStr(o, "name") ?? model ?? "Camera",
    model,
    state: protectState(o),
    macAddress: normalizeMac(str(o, "mac", "camera")),
    smartDetectTypes: smartDetectTypes(features.smartDetectTypes),
    enabledSmartDetectTypes: smartDetectTypes(settings.objectTypes),
    hasPackageCamera: bool(o, "hasPackageCamera"),
    hasMicrophone,
    hasSpeaker: bool(features, "hasSpeaker"),
    statusLight: bool(features, "hasLedStatus") && led ? bool(led, "isEnabled") : null,
    micVolume: hasMicrophone ? optNum(o, "micVolume") : null,
    doorbellDisplay: doorbellDisplay(o.lcdMessage),
    activePatrol: optNum(o, "activePatrolSlot"),
  };
}

function statValue(stats: Json, key: string): number | null {
  const stat = optObject(stats, key);
  return stat ? optNum(stat, "value") : null;
}

const MOUNT_TYPES = new Set(["door", "window", "garage", "leak"]);

/** Parses one sensor from `GET /v1/sensors`. */
export function parseSensor(value: unknown): UnifiSensorInfo {
  const o = asObject(value, "sensor");
  const stats = optObject(o, "stats") ?? {};
  const battery = optObject(optObject(o, "wirelessConnectionState") ?? {}, "batteryStatus")
    ?? optObject(o, "batteryStatus") ?? {};
  const mountType = o.mountType;
  const model = optStr(o, "type");
  return {
    id: str(o, "id", "sensor"),
    name: optStr(o, "name") ?? model ?? "Sensor",
    model,
    state: protectState(o),
    mountType: typeof mountType === "string" && MOUNT_TYPES.has(mountType)
      ? mountType as UnifiSensorInfo["mountType"] : "none",
    isOpen: typeof o.isOpened === "boolean" ? o.isOpened : null,
    openChangedAt: epochDate(o, "openStatusChangedAt"),
    motionDetected: bool(o, "isMotionDetected"),
    motionDetectedAt: epochDate(o, "motionDetectedAt"),
    temperatureC: statValue(stats, "temperature"),
    humidityPercent: statValue(stats, "humidity"),
    lightLux: statValue(stats, "light"),
    leakDetectedAt: epochDate(o, "leakDetectedAt") ?? epochDate(o, "externalLeakDetectedAt"),
    alarmTriggeredAt: epochDate(o, "alarmTriggeredAt"),
    tamperingDetectedAt: epochDate(o, "tamperingDetectedAt"),
    batteryPercent: optNum(battery, "percentage"),
    batteryLow: bool(battery, "isLow"),
  };
}

const LIGHT_MODES = new Set<UnifiLightMode>(["always", "motion", "off"]);

/** Parses one floodlight from `GET /v1/lights`. */
export function parseLight(value: unknown): UnifiLightInfo {
  const o = asObject(value, "floodlight");
  const mode = optObject(o, "lightModeSettings") ?? {};
  const device = optObject(o, "lightDeviceSettings") ?? {};
  const model = optStr(o, "type");
  return {
    id: str(o, "id", "floodlight"),
    name: optStr(o, "name") ?? model ?? "Floodlight",
    model,
    state: protectState(o),
    isOn: bool(o, "isLightOn"),
    forcedOn: bool(o, "isLightForceEnabled"),
    mode: LIGHT_MODES.has(mode.mode as UnifiLightMode) ? mode.mode as UnifiLightMode : "off",
    activeWhen: mode.enableAt === "dark" ? "dark" : "always",
    brightness: optNum(device, "ledLevel") ?? 1,
    isDark: bool(o, "isDark"),
    lastMotionAt: epochDate(o, "lastMotion"),
    pairedCameraId: optStr(o, "camera"),
  };
}

// ---------------------------------------------------------------------------
// Site Manager

/** A console a cloud connection can reach, as Site Manager lists it. */
export type SiteManagerConsole = {
  /** The host ID, which the Cloud Connector and resource URLs use. */
  id: string;
  /** A display name. */
  name: string;
  /** Whether this account owns the console; only owned consoles answer the Cloud Connector. */
  owner: boolean;
  /** Which applications the console runs, as far as Site Manager knows. */
  apps: { network: boolean; protect: boolean };
  /** Whether this account's role grants each application. */
  permissions: { network: boolean; protect: boolean };
  /** The console's MAC addresses, which identify it across connection modes. */
  macs: string[];
  /** The account's email, as Site Manager reports it on the console. */
  email: string | null;
  /** The account's name, as Site Manager reports it on the console. */
  fullName: string | null;
};

/** Parses one host from Site Manager's `GET /v1/hosts`. */
export function parseSiteManagerHost(value: unknown): SiteManagerConsole {
  const o = asObject(value, "Site Manager host");
  const id = str(o, "id", "Site Manager host");
  const user = optObject(o, "userData") ?? {};
  const reported = optObject(o, "reportedState");
  const macs = new Set<string>();
  const prefix = id.slice(0, 12);
  if (/^[0-9A-Fa-f]{12}$/.test(prefix)) macs.add(normalizeMac(prefix));
  for (const member of optArray(user, "consoleGroupMembers")) {
    const mac = member && typeof member === "object" ? (member as Json).mac : undefined;
    if (typeof mac === "string") macs.add(normalizeMac(mac));
  }
  if (reported && typeof reported.mac === "string") macs.add(normalizeMac(reported.mac));

  // reportedState lists the installed applications; userData only those the console supports.
  const reportedApps = reported ? optArray(reported, "controllers")
    .map(controller => controller && typeof controller === "object" ? (controller as Json).name : controller)
    .filter((name): name is string => typeof name === "string") : [];
  const apps = reportedApps.length > 0
    ? reportedApps
    : optArray(user, "controllers").filter((name): name is string => typeof name === "string");

  const permissions = optObject(user, "permissions") ?? {};
  const grants = (app: string) => Object.entries(permissions).some(([key, roles]) =>
    key.startsWith(`${app}.`) && Array.isArray(roles) && roles.length > 0);
  const owner = bool(o, "owner");
  return {
    id,
    name: (reported && (optStr(reported, "name") ?? optStr(reported, "hostname"))) ?? `Console ${prefix}`,
    owner,
    apps: { network: apps.includes("network"), protect: apps.includes("protect") },
    permissions: {
      network: owner || user.role === "owner" || grants("network"),
      protect: owner || user.role === "owner" || grants("protect"),
    },
    macs: [...macs],
    email: optStr(user, "email"),
    fullName: optStr(user, "fullName"),
  };
}

/** Parses a Site Manager list response: `{data, httpStatusCode, traceId, nextToken?}`. */
export function parseSiteManagerList(body: unknown): { data: unknown[]; nextToken: string | null } {
  const o = asObject(body, "Site Manager response");
  return { data: asArray(o.data, "Site Manager response"), nextToken: optStr(o, "nextToken") };
}
