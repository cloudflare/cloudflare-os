/**
 * A fake of everything the gatekeeper talks to: Site Manager (`api.ui.com/v1/hosts`), its Cloud
 * Connector, and consoles reached directly. Each console holds mutable Network and Protect state
 * whose shapes follow Ubiquiti's published OpenAPI documents -- openapi-contract.test.ts checks the
 * fixtures against the vendored schemas -- and requests change that state the way a console would,
 * so a test can apply an action and read the result back.
 *
 * Use `fake.fetch` wherever the code under test fetches: pass it to `sendUnifiRequest`, or install
 * it with `vi.stubGlobal("fetch", fake.fetch)`.
 */

type Raw = Record<string, any>;

/** A request the fake received. */
export type FakeCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

/** One request an integration API handled, as a console saw it. */
export type ConsoleCall = { app: "network" | "protect"; method: string; path: string; query: Record<string, string>; body?: unknown };

/** The JPEG bytes every snapshot returns: a minimal SOI/APP0/EOI frame. */
export const SNAPSHOT_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const TIMESTAMP = "2026-10-01T12:00:00Z";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });
}

function networkError(status: number, statusName: string, message: string, path: string): Response {
  return json(status, { statusCode: status, statusName, code: `api.${statusName.toLowerCase()}`, message, timestamp: TIMESTAMP, requestPath: path });
}

function connectorError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { code, httpStatusCode: status, message, traceId: "a7dc15e0eb4527142d7823515b15f87d" }, headers);
}

// ---------------------------------------------------------------------------
// Fixture builders: raw API objects as a console returns them

/** A site. */
export function rawSite(id: string, name: string, internalReference = name.toLowerCase()): Raw {
  return { id, internalReference, name };
}

/** A device's overview and details, from its parts. */
export function rawDevice(options: {
  id: string; name: string; model: string; mac: string; ip: string;
  roles: ("gateway" | "switching" | "accessPoint")[];
  state?: string; uplinkDeviceId?: string;
  ports?: Raw[]; radios?: Raw[];
}): { overview: Raw; details: Raw; statistics: Raw } {
  const interfaceNames = [...(options.ports ? ["ports"] : []), ...(options.radios ? ["radios"] : [])];
  const overview = {
    id: options.id, name: options.name, model: options.model, macAddress: options.mac, ipAddress: options.ip,
    state: options.state ?? "ONLINE", supported: true, firmwareVersion: "4.3.21", firmwareUpdatable: false,
    features: options.roles, interfaces: interfaceNames,
  };
  const features: Raw = {};
  if (options.roles.includes("switching")) features.switching = { lags: [] };
  if (options.roles.includes("accessPoint")) features.accessPoint = {};
  const interfaces: Raw = {};
  if (options.ports) interfaces.ports = options.ports;
  if (options.radios) interfaces.radios = options.radios;
  const details = {
    ...overview, features, interfaces, configurationId: "7596498d2f367dc2", adoptedAt: "2026-01-02T03:04:05Z",
    provisionedAt: "2026-09-30T08:00:00Z",
    ...(options.uplinkDeviceId && { uplink: { deviceId: options.uplinkDeviceId } }),
  };
  const statistics = {
    uptimeSec: 86_400, lastHeartbeatAt: "2026-10-01T11:59:30Z", nextHeartbeatAt: "2026-10-01T12:00:00Z",
    loadAverage1Min: 0.4, loadAverage5Min: 0.3, loadAverage15Min: 0.2, cpuUtilizationPct: 12.5, memoryUtilizationPct: 41.0,
    uplink: { txRateBps: 1_250_000, rxRateBps: 9_800_000 },
    interfaces: { radios: (options.radios ?? []).map(radio => ({ frequencyGHz: radio.frequencyGHz, txRetriesPct: 3.2 })) },
  };
  return { overview, details, statistics };
}

/** A port. */
export function rawPort(idx: number, options: { up?: boolean; poe?: boolean; poeEnabled?: boolean } = {}): Raw {
  return {
    idx, state: options.up === false ? "DOWN" : "UP", connector: "RJ45", maxSpeedMbps: 1000,
    ...(options.up !== false && { speedMbps: 1000 }),
    ...(options.poe && { poe: { standard: "802.3at", type: 2, enabled: options.poeEnabled ?? true, state: "UP" } }),
  };
}

/** A radio. */
export function rawRadio(frequencyGHz: number, channel: number): Raw {
  return { wlanStandard: "802.11ax", frequencyGHz, channelWidthMHz: frequencyGHz === 2.4 ? 20 : 80, channel };
}

/** A connected client, as listed, and its details. */
export function rawClient(options: {
  id: string; name: string; type: "WIRED" | "WIRELESS"; mac: string; ip: string; uplinkDeviceId: string;
  guest?: { authorized: boolean; expiresAt?: string };
}): { overview: Raw; details: Raw } {
  const base = {
    type: options.type, id: options.id, name: options.name, connectedAt: "2026-10-01T09:00:00Z",
    ipAddress: options.ip, macAddress: options.mac, uplinkDeviceId: options.uplinkDeviceId,
  };
  if (!options.guest) return { overview: { ...base, access: { type: "DEFAULT" } }, details: { ...base, access: { type: "DEFAULT" } } };
  const authorization = options.guest.authorized ? {
    authorizationMethod: "VOUCHER", authorizedAt: "2026-10-01T09:05:00Z",
    expiresAt: options.guest.expiresAt ?? "2026-10-02T09:05:00Z",
    usage: { durationSec: 3600, rxBytes: 1000, txBytes: 500, bytes: 1500 },
  } : undefined;
  return {
    overview: { ...base, access: { type: "GUEST", authorized: options.guest.authorized } },
    details: { ...base, access: { type: "GUEST", authorized: options.guest.authorized, ...(authorization && { authorization }) } },
  };
}

/** A network (VLAN). */
export function rawLanNetwork(id: string, name: string, vlanId: number, isDefault = false): Raw {
  return {
    management: "GATEWAY", id, name, enabled: true, vlanId, default: isDefault,
    metadata: { origin: isDefault ? "SYSTEM_DEFINED" : "USER_DEFINED" },
  };
}

/** A WiFi network's full settings, as its details endpoint returns them. */
export function rawWifi(options: {
  id: string; name: string; security: "WPA2_PERSONAL" | "WPA2_WPA3_PERSONAL" | "OPEN" | "WPA2_ENTERPRISE";
  passphrase?: string; networkId?: string; guestPortal?: boolean; iot?: boolean; enabled?: boolean; hidden?: boolean;
}): Raw {
  const security: Raw = { type: options.security };
  if (options.security === "WPA2_PERSONAL") Object.assign(security, { passphrase: options.passphrase, pmfMode: "OPTIONAL", fastRoamingEnabled: false });
  if (options.security === "WPA2_WPA3_PERSONAL") {
    Object.assign(security, {
      passphrase: options.passphrase, pmfMode: "OPTIONAL", fastRoamingEnabled: false, wpa3FastRoamingEnabled: false,
      saeConfiguration: { anticloggingThresholdSeconds: 5, syncTimeSeconds: 5 },
    });
  }
  return {
    type: options.iot ? "IOT_OPTIMIZED" : "STANDARD",
    id: options.id, name: options.name, enabled: options.enabled ?? true, metadata: { origin: "USER_DEFINED" },
    network: options.networkId ? { type: "SPECIFIC", networkId: options.networkId } : { type: "NATIVE" },
    securityConfiguration: security,
    ...(options.iot ? {} : {
      broadcastingFrequenciesGHz: [2.4, 5], advertiseDeviceName: false, arpProxyEnabled: false, bssTransitionEnabled: true,
      ...(options.guestPortal && { hotspotConfiguration: { type: "CAPTIVE_PORTAL" } }),
    }),
    channel2gLockedTo6: false, clientIsolationEnabled: options.guestPortal === true, dtimPeriod2gLockedTo3: false,
    hideName: options.hidden ?? false, multicastToUnicastConversionEnabled: false, uapsdEnabled: false,
  };
}

/** The overview a WiFi list returns for one network's full settings. */
export function wifiOverview(full: Raw): Raw {
  const security = full.securityConfiguration as Raw;
  return {
    type: full.type, id: full.id, name: full.name, enabled: full.enabled, metadata: full.metadata, network: full.network,
    securityConfiguration: { type: security.type },
    ...(full.broadcastingFrequenciesGHz && { broadcastingFrequenciesGHz: full.broadcastingFrequenciesGHz }),
    ...(full.hotspotConfiguration && { hotspotConfiguration: full.hotspotConfiguration }),
  };
}

/** A hotspot voucher. */
export function rawVoucher(id: string, name: string, code: string, createdAt: string, options: Partial<Raw> = {}): Raw {
  return { id, createdAt, name, code, authorizedGuestLimit: 1, authorizedGuestCount: 0, expired: false, timeLimitMinutes: 1440, ...options };
}

/** A camera. */
export function rawCamera(options: {
  id: string; name: string; type: string; mac: string; doorbell?: boolean; packageCamera?: boolean; led?: boolean;
  mic?: boolean; state?: string; activePatrolSlot?: number | null;
}): Raw {
  return {
    id: options.id, modelKey: "camera", state: options.state ?? "CONNECTED", name: options.name, type: options.type,
    guid: null, mac: options.mac, isMicEnabled: options.mic ?? true,
    osdSettings: { isNameEnabled: true, isDateEnabled: true, isLogoEnabled: false, isDebugEnabled: false, overlayLocation: "topLeft" },
    ledSettings: { isEnabled: true, welcomeLed: false, floodLed: false },
    lcdMessage: options.doorbell ? { type: "CUSTOM_MESSAGE", text: "Welcome", resetAt: null } : {},
    micVolume: 80, activePatrolSlot: options.activePatrolSlot ?? null, videoMode: "default", hdrType: "auto",
    featureFlags: {
      supportFullHdSnapshot: true, hasHdr: true, smartDetectTypes: ["person", "vehicle", "package"],
      smartDetectAudioTypes: [], videoModes: ["default"], hasMic: options.mic ?? true, hasLedStatus: options.led ?? true,
      hasSpeaker: options.doorbell === true,
    },
    smartDetectSettings: { objectTypes: ["person", "package"], audioTypes: [] },
    hasPackageCamera: options.packageCamera === true,
  };
}

/** A contact sensor. */
export function rawSensor(id: string, name: string, mac: string, isOpened: boolean): Raw {
  return {
    id, modelKey: "sensor", state: "CONNECTED", name, type: "UP-Sense", guid: null, mac, mountType: "door",
    batteryStatus: { percentage: 87, isLow: false },
    stats: { light: { value: 120, status: "neutral" }, humidity: { value: 45, status: "safe" }, temperature: { value: 21.5, status: "safe" } },
    lightSettings: { isEnabled: true }, humiditySettings: { isEnabled: true }, temperatureSettings: { isEnabled: true },
    isOpened, openStatusChangedAt: 1_727_784_000_000, isMotionDetected: false, motionDetectedAt: null,
    motionSettings: { isEnabled: true, sensitivity: 50 }, glassBreakSettings: { isEnabled: false },
    scheduleMode: "always", armProfileIds: null, hasCustomSensitivityWhenArmed: false,
    alarmTriggeredAt: null, alarmSettings: { isEnabled: false }, leakDetectedAt: null, externalLeakDetectedAt: null,
    leakSettings: { isInternalEnabled: false, isExternalEnabled: false }, tamperingDetectedAt: null,
    wirelessConnectionState: { signalState: { signalQuality: 90, signalStrength: -55 }, batteryStatus: { percentage: 87, isLow: false }, bridge: null },
  };
}

/** A floodlight. */
export function rawLight(id: string, name: string, mac: string, cameraId: string | null): Raw {
  return {
    id, modelKey: "light", state: "CONNECTED", name, type: "UP FloodLight", guid: null, mac,
    lightModeSettings: { mode: "motion", enableAt: "dark" },
    lightDeviceSettings: { isIndicatorEnabled: true, pirDuration: 15_000, pirSensitivity: 50, ledLevel: 3 },
    isDark: true, isLightOn: false, isLightForceEnabled: false, lastMotion: 1_727_784_100_000, isPirMotionDetected: false,
    camera: cameraId,
  };
}

/** An NVR. */
export function rawNvr(id: string, name: string, mac: string, armStatus = "disabled"): Raw {
  return {
    id, modelKey: "nvr", name, type: "UDM Pro", guid: null, mac,
    doorbellSettings: { defaultMessageText: "Welcome", defaultMessageResetTimeoutMs: 60_000, customMessages: [], customImages: [] },
    armMode: {
      status: armStatus, armProfileId: null, armedAt: armStatus === "armed" ? 1_727_780_000_000 : null,
      willBeArmedAt: null, breachDetectedAt: null, breachEventCount: 0, breachTriggerEventId: null, breachEventId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// A console

type FakeSite = {
  site: Raw;
  devices: { overview: Raw; details: Raw; statistics: Raw }[];
  clients: { overview: Raw; details: Raw }[];
  networks: Raw[];
  wifi: Raw[];
  vouchers: Raw[];
};

/** One console's applications and state. */
export class FakeConsole {
  name: string;
  hostId: string;
  /** Uppercase hex, as Site Manager writes it. */
  mac: string;
  offline = false;
  /** Whether list endpoints honor `filter`; a console that ignored it must not leak data. */
  honorsFilters = true;
  network: { version: string; sites: FakeSite[] } | null = null;
  protect: { version: string; nvr: Raw; cameras: Raw[]; sensors: Raw[]; lights: Raw[] } | null = null;
  readonly calls: ConsoleCall[] = [];
  #nextVoucher = 1;

  constructor(name: string, hostId: string, mac: string) {
    this.name = name;
    this.hostId = hostId;
    this.mac = mac;
  }

  /** The requests that changed something. */
  writes(): ConsoleCall[] {
    return this.calls.filter(call => call.method !== "GET");
  }

  /** Handles a request to one of the console's integration APIs. */
  handle(app: "network" | "protect", method: string, path: string, query: Record<string, string>, body: unknown): Response {
    this.calls.push({ app, method, path, query, ...(body !== undefined && { body }) });
    return app === "network" ? this.#network(method, path, query, body) : this.#protect(method, path, body);
  }

  #network(method: string, path: string, query: Record<string, string>, body: unknown): Response {
    const network = this.network;
    if (!network) return networkError(404, "NOT_FOUND", "Application not installed", path);
    const notFound = () => networkError(404, "NOT_FOUND", "Not found", path);
    const page = (items: Raw[]) => {
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? 25);
      const data = items.slice(offset, offset + limit);
      return json(200, { offset, limit, count: data.length, totalCount: items.length, data });
    };
    if (method === "GET" && path === "/v1/info") return json(200, { applicationVersion: network.version });
    if (method === "GET" && path === "/v1/sites") return page(network.sites.map(s => s.site));

    const siteMatch = /^\/v1\/sites\/([^/]+)(\/.*)$/.exec(path);
    if (!siteMatch) return notFound();
    const site = network.sites.find(s => s.site.id === siteMatch[1]);
    if (!site) return notFound();
    const rest = siteMatch[2]!;
    let m: RegExpExecArray | null;

    if (method === "GET" && rest === "/devices") return page(site.devices.map(d => d.overview));
    if ((m = /^\/devices\/([^/]+)$/.exec(rest)) && method === "GET") {
      const device = site.devices.find(d => d.overview.id === m![1]);
      return device ? json(200, device.details) : notFound();
    }
    if ((m = /^\/devices\/([^/]+)\/statistics\/latest$/.exec(rest)) && method === "GET") {
      const device = site.devices.find(d => d.overview.id === m![1]);
      return device ? json(200, device.statistics) : notFound();
    }
    if ((m = /^\/devices\/([^/]+)\/actions$/.exec(rest)) && method === "POST") {
      const device = site.devices.find(d => d.overview.id === m![1]);
      if (!device) return notFound();
      if ((body as Raw)?.action !== "RESTART") return networkError(400, "BAD_REQUEST", "Unknown action", path);
      return json(200, undefined);
    }
    if ((m = /^\/devices\/([^/]+)\/interfaces\/ports\/(\d+)\/actions$/.exec(rest)) && method === "POST") {
      const device = site.devices.find(d => d.overview.id === m![1]);
      const port = (device?.details.interfaces.ports as Raw[] | undefined)?.find(p => p.idx === Number(m![2]));
      if (!device || !port) return notFound();
      if (!port.poe?.enabled) return networkError(400, "BAD_REQUEST", "Port does not supply PoE", path);
      return json(200, undefined);
    }

    if (method === "GET" && rest === "/clients") {
      const guestOnly = this.honorsFilters && query.filter === "access.type.eq('GUEST')";
      return page(site.clients.map(c => c.overview).filter(c => !guestOnly || c.access.type === "GUEST"));
    }
    if ((m = /^\/clients\/([^/]+)$/.exec(rest)) && method === "GET") {
      const client = site.clients.find(c => c.overview.id === m![1]);
      return client ? json(200, client.details) : notFound();
    }
    if ((m = /^\/clients\/([^/]+)\/actions$/.exec(rest)) && method === "POST") {
      const client = site.clients.find(c => c.overview.id === m![1]);
      if (!client) return notFound();
      if (client.overview.access.type !== "GUEST") return networkError(400, "BAD_REQUEST", "Client is not a guest", path);
      const request = body as Raw;
      if (request.action === "AUTHORIZE_GUEST_ACCESS") {
        const now = Date.parse(TIMESTAMP);
        const authorization = {
          authorizationMethod: "API", authorizedAt: TIMESTAMP,
          expiresAt: new Date(now + (request.timeLimitMinutes ?? 480) * 60_000).toISOString(),
          ...(request.dataUsageLimitMBytes !== undefined && { dataUsageLimitMBytes: request.dataUsageLimitMBytes }),
          ...(request.rxRateLimitKbps !== undefined && { rxRateLimitKbps: request.rxRateLimitKbps }),
          ...(request.txRateLimitKbps !== undefined && { txRateLimitKbps: request.txRateLimitKbps }),
          usage: { durationSec: 0, rxBytes: 0, txBytes: 0, bytes: 0 },
        };
        client.overview.access = { type: "GUEST", authorized: true };
        client.details.access = { type: "GUEST", authorized: true, authorization };
        return json(200, { action: "AUTHORIZE_GUEST_ACCESS", grantedAuthorization: authorization });
      }
      if (request.action === "UNAUTHORIZE_GUEST_ACCESS") {
        const revoked = client.details.access.authorization ?? {
          authorizationMethod: "OTHER", authorizedAt: TIMESTAMP, expiresAt: TIMESTAMP,
        };
        client.overview.access = { type: "GUEST", authorized: false };
        client.details.access = { type: "GUEST", authorized: false };
        return json(200, { action: "UNAUTHORIZE_GUEST_ACCESS", revokedAuthorization: revoked });
      }
      return networkError(400, "BAD_REQUEST", "Unknown action", path);
    }

    if (method === "GET" && rest === "/networks") return page(site.networks);
    if (method === "GET" && rest === "/wifi/broadcasts") return page(site.wifi.map(wifiOverview));
    if ((m = /^\/wifi\/broadcasts\/([^/]+)$/.exec(rest))) {
      const index = site.wifi.findIndex(w => w.id === m![1]);
      if (index === -1) return notFound();
      if (method === "GET") return json(200, site.wifi[index]);
      if (method === "PUT") {
        const update = body as Raw;
        if ("id" in update || "metadata" in update) return networkError(400, "BAD_REQUEST", "Read-only field in update", path);
        site.wifi[index] = { ...update, id: site.wifi[index]!.id, metadata: site.wifi[index]!.metadata };
        return json(200, site.wifi[index]);
      }
    }

    if (method === "GET" && rest === "/hotspot/vouchers") return page(site.vouchers);
    if (method === "POST" && rest === "/hotspot/vouchers") {
      const request = body as Raw;
      if (typeof request.name !== "string" || typeof request.timeLimitMinutes !== "number") {
        return networkError(400, "BAD_REQUEST", "name and timeLimitMinutes are required", path);
      }
      const created = Array.from({ length: request.count ?? 1 }, () => {
        const n = this.#nextVoucher++;
        return rawVoucher(`5f0ee1aa-0000-4000-8000-${String(n).padStart(12, "0")}`, request.name, String(4_000_000_000 + n), TIMESTAMP, {
          authorizedGuestLimit: request.authorizedGuestLimit, timeLimitMinutes: request.timeLimitMinutes,
          ...(request.dataUsageLimitMBytes !== undefined && { dataUsageLimitMBytes: request.dataUsageLimitMBytes }),
        });
      });
      site.vouchers.push(...created);
      return json(201, { vouchers: created });
    }
    if ((m = /^\/hotspot\/vouchers\/([^/]+)$/.exec(rest)) && method === "DELETE") {
      const index = site.vouchers.findIndex(v => v.id === m![1]);
      if (index === -1) return notFound();
      site.vouchers.splice(index, 1);
      return json(200, { vouchersDeleted: 1 });
    }
    return notFound();
  }

  #protect(method: string, path: string, body: unknown): Response {
    const protect = this.protect;
    const notFound = () => json(404, { error: "Not found" });
    if (!protect) return notFound();
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/v1/meta/info") return json(200, { applicationVersion: protect.version });
    if (method === "GET" && path === "/v1/nvrs") return json(200, protect.nvr);
    if (method === "GET" && path === "/v1/cameras") return json(200, protect.cameras);
    if (method === "GET" && path === "/v1/sensors") return json(200, protect.sensors);
    if (method === "GET" && path === "/v1/lights") return json(200, protect.lights);
    if ((m = /^\/v1\/cameras\/([^/]+)$/.exec(path))) {
      const camera = protect.cameras.find(c => c.id === m![1]);
      if (!camera) return notFound();
      if (method === "GET") return json(200, camera);
      if (method === "PATCH") {
        const patch = body as Raw;
        if (patch.name !== undefined) camera.name = patch.name;
        if (patch.ledSettings) camera.ledSettings = { ...camera.ledSettings, ...patch.ledSettings };
        if (patch.micVolume !== undefined) camera.micVolume = patch.micVolume;
        if (patch.lcdMessage) {
          // As documented: no `resetAt` means the NVR's default timeout, and `null` means forever.
          const message = patch.lcdMessage as Raw;
          const timeout = (protect.nvr.doorbellSettings as Raw).defaultMessageResetTimeoutMs as number;
          camera.lcdMessage = "resetAt" in message ? message : { ...message, resetAt: Date.now() + timeout };
        }
        return json(200, camera);
      }
    }
    if ((m = /^\/v1\/cameras\/([^/]+)\/snapshot$/.exec(path)) && method === "GET") {
      const camera = protect.cameras.find(c => c.id === m![1]);
      if (!camera) return notFound();
      if (camera.state !== "CONNECTED") return new Response(null, { status: 503 });
      return new Response(SNAPSHOT_BYTES, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    if ((m = /^\/v1\/cameras\/([^/]+)\/ptz\/(goto\/-?\d+|patrol\/start\/\d+|patrol\/stop)$/.exec(path)) && method === "POST") {
      const camera = protect.cameras.find(c => c.id === m![1]);
      if (!camera) return notFound();
      if (!String(camera.type).includes("PTZ")) return json(400, { error: "Camera does not support PTZ" });
      const command = m[2]!;
      if (command.startsWith("patrol/start/")) camera.activePatrolSlot = Number(command.split("/")[2]);
      else camera.activePatrolSlot = null;
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/v1\/sensors\/([^/]+)$/.exec(path)) && method === "GET") {
      const sensor = protect.sensors.find(s => s.id === m![1]);
      return sensor ? json(200, sensor) : notFound();
    }
    if ((m = /^\/v1\/lights\/([^/]+)$/.exec(path))) {
      const light = protect.lights.find(l => l.id === m![1]);
      if (!light) return notFound();
      if (method === "GET") return json(200, light);
      if (method === "PATCH") {
        const patch = body as Raw;
        if (patch.isLightForceEnabled !== undefined) {
          light.isLightForceEnabled = patch.isLightForceEnabled;
          light.isLightOn = patch.isLightForceEnabled || light.lightModeSettings.mode === "always";
        }
        if (patch.lightModeSettings) light.lightModeSettings = { ...light.lightModeSettings, ...patch.lightModeSettings };
        if (patch.lightDeviceSettings) light.lightDeviceSettings = { ...light.lightDeviceSettings, ...patch.lightDeviceSettings };
        return json(200, light);
      }
    }
    return notFound();
  }
}

/** IDs used by `homeConsole()`, for tests to refer to. */
export const HOME = {
  hostId: "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302",
  mac: "70A7419783ED",
  siteId: "88f7af54-98f8-306a-a1c7-c9349722b1f6",
  gatewayId: "0f4c5f5a-1111-4b6e-9e1d-000000000001",
  switchId: "0f4c5f5a-2222-4b6e-9e1d-000000000002",
  apId: "0f4c5f5a-3333-4b6e-9e1d-000000000003",
  laptopId: "c1a0b2d3-0000-4000-8000-000000000001",
  phoneId: "c1a0b2d3-0000-4000-8000-000000000002",
  guestId: "c1a0b2d3-0000-4000-8000-000000000003",
  homeWifiId: "aa110000-0000-4000-8000-000000000001",
  guestWifiId: "aa110000-0000-4000-8000-000000000002",
  iotWifiId: "aa110000-0000-4000-8000-000000000003",
  defaultNetworkId: "bb220000-0000-4000-8000-000000000001",
  guestNetworkId: "bb220000-0000-4000-8000-000000000002",
  voucherId: "5f0ee1aa-0000-4000-8000-100000000001",
  doorbellId: "66d025b30096e903e4000500",
  ptzId: "66d025b30096e903e4000501",
  sensorId: "66d025b30096e903e4000600",
  lightId: "66d025b30096e903e4000700",
  nvrId: "66d025b30096e903e4000000",
} as const;

/** A typical home console: a Dream Machine Pro running Network and Protect. */
export function homeConsole(): FakeConsole {
  const console = new FakeConsole("Dream Machine Pro", HOME.hostId, HOME.mac);
  const gateway = rawDevice({
    id: HOME.gatewayId, name: "UDM Pro", model: "UDMPRO", mac: "70:a7:41:97:83:ed", ip: "192.168.1.1",
    roles: ["gateway", "switching"], ports: [rawPort(1), rawPort(2, { up: false })],
  });
  const switchDevice = rawDevice({
    id: HOME.switchId, name: "Garage Switch", model: "USWLITE8POE", mac: "e4:38:83:00:00:02", ip: "192.168.1.20",
    roles: ["switching"], uplinkDeviceId: HOME.gatewayId,
    ports: [rawPort(1), rawPort(2, { poe: true }), rawPort(3, { poe: true, poeEnabled: false }), rawPort(4, { up: false })],
  });
  const ap = rawDevice({
    id: HOME.apId, name: "Living Room AP", model: "U7PRO", mac: "e4:38:83:00:00:03", ip: "192.168.1.30",
    roles: ["accessPoint"], uplinkDeviceId: HOME.switchId, radios: [rawRadio(2.4, 6), rawRadio(5, 36)],
  });
  const homeWifi = rawWifi({ id: HOME.homeWifiId, name: "Home", security: "WPA2_WPA3_PERSONAL", passphrase: "correct horse battery" });
  const guestWifi = rawWifi({
    id: HOME.guestWifiId, name: "Guest", security: "WPA2_PERSONAL", passphrase: "welcome-guests",
    networkId: HOME.guestNetworkId, guestPortal: true,
  });
  const iotWifi = rawWifi({ id: HOME.iotWifiId, name: "Things", security: "WPA2_PERSONAL", passphrase: "lightbulbs!", iot: true });
  console.network = {
    version: "10.6.106",
    sites: [{
      site: rawSite(HOME.siteId, "Default", "default"),
      devices: [gateway, switchDevice, ap],
      clients: [
        rawClient({ id: HOME.laptopId, name: "Work Laptop", type: "WIRED", mac: "a4:83:e7:00:00:01", ip: "192.168.1.101", uplinkDeviceId: HOME.switchId }),
        rawClient({ id: HOME.phoneId, name: "Dan's iPhone", type: "WIRELESS", mac: "a4:83:e7:00:00:02", ip: "192.168.1.102", uplinkDeviceId: HOME.apId }),
        rawClient({
          id: HOME.guestId, name: "Visitor Pixel", type: "WIRELESS", mac: "a4:83:e7:00:00:03", ip: "192.168.2.50",
          uplinkDeviceId: HOME.apId, guest: { authorized: false },
        }),
      ],
      networks: [rawLanNetwork(HOME.defaultNetworkId, "Default", 1, true), rawLanNetwork(HOME.guestNetworkId, "Guest", 20)],
      wifi: [homeWifi, guestWifi, iotWifi],
      vouchers: [rawVoucher(HOME.voucherId, "Book club", "1234567890", "2026-09-30T18:00:00Z")],
    }],
  };
  console.protect = {
    version: "7.3.70",
    nvr: rawNvr(HOME.nvrId, "Dream Machine Pro", HOME.mac),
    cameras: [
      rawCamera({ id: HOME.doorbellId, name: "Front Door", type: "G4 Doorbell Pro", mac: "F4E2C6000001", doorbell: true, packageCamera: true }),
      rawCamera({ id: HOME.ptzId, name: "Driveway", type: "G5 PTZ", mac: "F4E2C6000002", led: false }),
    ],
    sensors: [rawSensor(HOME.sensorId, "Garage Door", "F4E2C6000003", false)],
    lights: [rawLight(HOME.lightId, "Backyard Floodlight", "F4E2C6000004", HOME.ptzId)],
  };
  return console;
}

// ---------------------------------------------------------------------------
// UniFi as a whole

type CloudAccount = {
  email: string;
  fullName: string;
  /** Consoles the account owns, which the Cloud Connector proxies to. */
  owned: FakeConsole[];
  /** Consoles the account administers without owning; listed, but the connector refuses them. */
  administered?: { console: FakeConsole; permissions: Record<string, string[]> }[];
  /**
   * The status the connector refuses changes with, for a key that may only read; Site Manager has
   * documented its keys as read-only, without saying how a change is refused.
   */
  writesRefusedWith?: 401 | 403;
};

type DirectConsole = {
  console: FakeConsole;
  keys: Set<string>;
  access?: { clientId: string; clientSecret: string };
  /** Simulates an untrusted self-signed certificate. */
  untrustedCertificate?: boolean;
};

/** Everything the gatekeeper can reach. */
export class FakeUnifi {
  readonly calls: FakeCall[] = [];
  readonly cloud = new Map<string, CloudAccount>();
  readonly direct = new Map<string, DirectConsole>();
  /** Requests the Cloud Connector allows each console per minute. */
  connectorLimit = 100;
  #connectorCounts = new Map<string, number>();

  /** Registers a cloud API key. */
  addCloudKey(key: string, account: CloudAccount): this {
    this.cloud.set(key, account);
    return this;
  }

  /** Makes a console reachable directly at `origin`, accepting `key`. */
  addDirectConsole(origin: string, console: FakeConsole, key: string, options: Omit<DirectConsole, "console" | "keys"> = {}): this {
    this.direct.set(origin, { console, keys: new Set([key]), ...options });
    return this;
  }

  /** Forgets how many connector requests each console has had, as a new minute would. */
  resetRateLimits(): void {
    this.#connectorCounts.clear();
  }

  /** The `fetch` the code under test should use. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const body = text === "" ? undefined : JSON.parse(text);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    this.calls.push({ method: request.method, url: request.url, headers, ...(body !== undefined && { body }) });
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams);
    const key = request.headers.get("x-api-key") ?? "";

    if (url.origin === "https://api.ui.com") {
      const account = this.cloud.get(key);
      if (!account) return connectorError(401, "unauthorized", "unauthorized");
      if (request.method === "GET" && url.pathname === "/v1/hosts") return this.#hosts(account, query);
      const m = /^\/v1\/connector\/consoles\/([^/]+)\/proxy\/(network|protect)\/integration(\/.*)$/.exec(url.pathname);
      if (!m) return connectorError(404, "not_found", "not found");
      const console = account.owned.find(c => c.hostId === decodeURIComponent(m[1]!));
      if (!console) {
        const administered = account.administered?.some(a => a.console.hostId === decodeURIComponent(m[1]!));
        return administered
          ? connectorError(403, "forbidden", "API key can only access consoles owned by its account")
          : connectorError(404, "not_found", "console not found");
      }
      if (console.offline) return connectorError(408, "DeviceTimeout", "Device connection timeout");
      if (account.writesRefusedWith && request.method !== "GET") {
        return connectorError(account.writesRefusedWith, "forbidden", "API key does not have write access");
      }
      const count = (this.#connectorCounts.get(console.hostId) ?? 0) + 1;
      this.#connectorCounts.set(console.hostId, count);
      if (count > this.connectorLimit) return connectorError(429, "rate_limit", "rate limit exceeded, retry after 5.372786998s");
      return console.handle(m[2] as "network" | "protect", request.method, m[3]!, query, body);
    }

    const direct = this.direct.get(url.origin);
    if (!direct) throw new TypeError("Network connection lost.");
    if (direct.untrustedCertificate) throw new TypeError("TLS peer's certificate is not trusted; reason = self-signed certificate");
    if (direct.access && (request.headers.get("cf-access-client-id") !== direct.access.clientId ||
        request.headers.get("cf-access-client-secret") !== direct.access.clientSecret)) {
      return new Response(null, { status: 302, headers: { Location: `${url.origin}/cdn-cgi/access/login` } });
    }
    const m = /^\/proxy\/(network|protect)\/integration(\/.*)$/.exec(url.pathname);
    if (!m) return new Response("<html>Not Found</html>", { status: 404, headers: { "Content-Type": "text/html" } });
    if (!direct.keys.has(key)) return json(401, { message: "Unauthorized" });
    if (direct.console.offline) throw new TypeError("Network connection lost.");
    return direct.console.handle(m[1] as "network" | "protect", request.method, m[2]!, query, body);
  };

  #hosts(account: CloudAccount, query: Record<string, string>): Response {
    const host = (console: FakeConsole, owner: boolean, permissions: Record<string, string[]>) => ({
      id: console.hostId, hardwareId: "e5bf13cd-98a7-5a96-9463-0d65d78cd3a4", type: "console", ipAddress: "203.0.113.10",
      owner, isBlocked: false, registrationTime: "", lastConnectionStateChange: TIMESTAMP, latestBackupTime: "",
      userData: {
        apps: ["users"], email: account.email, fullName: account.fullName, role: owner ? "owner" : "admin",
        permissions,
        controllers: [...(console.network ? ["network"] : []), ...(console.protect ? ["protect"] : [])],
        consoleGroupMembers: [{ mac: console.mac, role: "PRIMARY" }],
      },
      reportedState: {
        name: console.name, hostname: console.name.toLowerCase().replace(/\s+/g, "-"),
        controllers: [
          ...(console.network ? [{ name: "network", version: console.network.version, state: "active" }] : []),
          ...(console.protect ? [{ name: "protect", version: console.protect.version, state: "active" }] : []),
        ],
      },
    });
    const all = [
      ...account.owned.map(c => host(c, true, { "network.management": ["admin"], "protect.management": ["admin"] })),
      ...(account.administered ?? []).map(a => host(a.console, false, a.permissions)),
    ];
    const pageSize = Number(query.pageSize ?? 25);
    const start = query.nextToken ? Number(query.nextToken) : 0;
    const data = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
    return json(200, { data, httpStatusCode: 200, traceId: "trace", ...(next && { nextToken: next }) });
  }
}
