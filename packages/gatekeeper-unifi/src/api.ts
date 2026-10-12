/**
 * Typed access to one console's Network and Protect integration APIs, over whatever `send` it is
 * given -- the account's egress in production, a fake in tests. Every ID that reaches a path is
 * validated first, every list is paged to a bound, and every answer is parsed (parse.ts) rather
 * than cast.
 *
 * Pure apart from `send`: imported by the Node tests.
 */

import { jsonOf, type UnifiSend } from "./consoles";
import { UnifiError } from "./errors";
import {
  asObject, parseCamera, parseClient, parseClientDetails, parseDevice, parseDeviceDetails,
  parseDeviceStatistics, parseLanNetwork, parseLight, parseNetworkInfo, parseNetworkPage, parseNvr,
  parseProtectInfo, parseSensor, parseSite, parseVoucher, parseWifiInfo, parseWifiSummary,
  type NetworkSite, type ProtectNvr,
} from "./parse";
import { isValidId } from "./resources";
import type { UnifiApp, UnifiMethod, UnifiRequest } from "./transport";
import type {
  UnifiClient, UnifiClientDetails, UnifiDevice, UnifiDeviceDetails, UnifiDeviceStatistics,
  UnifiLanNetwork, UnifiVoucher, UnifiWifiNetworkInfo, UnifiWifiNetworkSummary,
} from "./network-types";
import type { UnifiCameraInfo, UnifiLightInfo, UnifiSensorInfo } from "./protect-types";

/** The most items a list returns, matching the agent-facing documentation. */
export const MAX_LIST_ITEMS = 1000;
const PAGE_SIZE = 200;

/** Guest access limits as the Network API names them. */
export type GuestLimitsBody = {
  timeLimitMinutes?: number;
  dataUsageLimitMBytes?: number;
  rxRateLimitKbps?: number;
  txRateLimitKbps?: number;
};

/** A voucher request as the Network API names it. */
export type VoucherBody = GuestLimitsBody & {
  count: number;
  name: string;
  timeLimitMinutes: number;
  authorizedGuestLimit?: number;
};

/** A camera settings change, as Protect names it. */
export type CameraPatch = {
  name?: string;
  ledSettings?: { isEnabled: boolean };
  micVolume?: number;
  /** `resetAt` is never `null`, which Protect reads as "forever". */
  lcdMessage?:
    | { type: "LEAVE_PACKAGE_AT_DOOR" | "DO_NOT_DISTURB"; resetAt?: number }
    | { type: "CUSTOM_MESSAGE"; text: string; resetAt?: number };
};

/** A floodlight settings change, as Protect names it. */
export type LightPatch = {
  isLightForceEnabled?: boolean;
  lightModeSettings?: { mode?: "always" | "motion" | "off"; enableAt?: "fulltime" | "dark" };
  lightDeviceSettings?: { ledLevel?: number };
};

/** A camera snapshot's bytes. */
export type SnapshotBytes = { bytes: ArrayBuffer; contentType: string };

/** One console's applications. */
export class UnifiApi {
  readonly #send: UnifiSend;
  readonly consoleId: string;

  constructor(send: UnifiSend, consoleId: string) {
    this.#send = send;
    this.consoleId = consoleId;
  }

  // -------------------------------------------------------------------------
  // Network

  /** `GET /v1/info`. */
  async networkInfo(): Promise<{ applicationVersion: string }> {
    return parseNetworkInfo(await this.#json("network", "GET", "/v1/info"));
  }

  /** Every site, up to the list bound. */
  async listSites(): Promise<NetworkSite[]> {
    return (await this.#list("network", "/v1/sites", "site list")).map(parseSite);
  }

  /** One site, or a `notFound` error. */
  async getSite(siteId: string): Promise<NetworkSite> {
    id(siteId, "site");
    const site = (await this.listSites()).find(s => s.id === siteId);
    if (!site) throw new UnifiError({ kind: "notFound", message: "That site isn't on this console." });
    return site;
  }

  /** A site's adopted devices. */
  async listDevices(siteId: string): Promise<UnifiDevice[]> {
    return (await this.#list("network", `/v1/sites/${id(siteId, "site")}/devices`, "device list")).map(parseDevice);
  }

  /**
   * One device's details, with its roles from the device list: the details can't say whether a
   * device is a gateway, and that decides how restarting it is approved. The whole list is read
   * rather than filtered to this device, because the cache then shares it with `listDevices` and
   * every other device read for a few seconds, which costs fewer requests than a filtered query per
   * device unless a site has hundreds of devices.
   */
  async getDevice(siteId: string, deviceId: string): Promise<UnifiDeviceDetails> {
    const [details, devices] = await Promise.all([
      this.#json("network", "GET", `/v1/sites/${id(siteId, "site")}/devices/${id(deviceId, "device")}`),
      this.listDevices(siteId),
    ]);
    const listed = devices.find(device => device.id === deviceId);
    if (!listed) throw new UnifiError({ kind: "notFound", message: "That device isn't on this site." });
    return parseDeviceDetails(details, listed.roles);
  }

  /** One device's latest statistics. */
  async getDeviceStatistics(siteId: string, deviceId: string): Promise<UnifiDeviceStatistics> {
    return parseDeviceStatistics(await this.#json("network", "GET",
      `/v1/sites/${id(siteId, "site")}/devices/${id(deviceId, "device")}/statistics/latest`));
  }

  /** Restarts a device. */
  async restartDevice(siteId: string, deviceId: string): Promise<void> {
    await this.#json("network", "POST",
      `/v1/sites/${id(siteId, "site")}/devices/${id(deviceId, "device")}/actions`, { action: "RESTART" });
  }

  /** Power-cycles a PoE port. */
  async powerCyclePort(siteId: string, deviceId: string, portIndex: number): Promise<void> {
    if (!Number.isInteger(portIndex) || portIndex < 1) throw badRequest("Port numbers start at 1.");
    await this.#json("network", "POST",
      `/v1/sites/${id(siteId, "site")}/devices/${id(deviceId, "device")}/interfaces/ports/${portIndex}/actions`,
      { action: "POWER_CYCLE" });
  }

  /** A site's connected clients, optionally narrowed by a Network filter expression. */
  async listClients(siteId: string, filter?: string): Promise<UnifiClient[]> {
    return (await this.#list("network", `/v1/sites/${id(siteId, "site")}/clients`, "client list",
      filter ? { filter } : undefined)).map(parseClient);
  }

  /** One connected client's details. */
  async getClient(siteId: string, clientId: string): Promise<UnifiClientDetails> {
    return parseClientDetails(await this.#json("network", "GET",
      `/v1/sites/${id(siteId, "site")}/clients/${id(clientId, "client")}`));
  }

  /** Authorizes a guest client. */
  async authorizeGuest(siteId: string, clientId: string, limits: GuestLimitsBody): Promise<void> {
    await this.#json("network", "POST", `/v1/sites/${id(siteId, "site")}/clients/${id(clientId, "client")}/actions`,
      { action: "AUTHORIZE_GUEST_ACCESS", ...limits });
  }

  /** Ends a guest client's authorization. */
  async revokeGuest(siteId: string, clientId: string): Promise<void> {
    await this.#json("network", "POST", `/v1/sites/${id(siteId, "site")}/clients/${id(clientId, "client")}/actions`,
      { action: "UNAUTHORIZE_GUEST_ACCESS" });
  }

  /** A site's networks (VLANs). */
  async listLanNetworks(siteId: string): Promise<UnifiLanNetwork[]> {
    return (await this.#list("network", `/v1/sites/${id(siteId, "site")}/networks`, "network list")).map(parseLanNetwork);
  }

  /** A site's WiFi networks. */
  async listWifiNetworks(siteId: string): Promise<UnifiWifiNetworkSummary[]> {
    return (await this.#list("network", `/v1/sites/${id(siteId, "site")}/wifi/broadcasts`, "WiFi network list"))
      .map(parseWifiSummary);
  }

  /** One WiFi network's settings, as UniFi returns them, for reading or for `putWifi`. */
  async getWifiRaw(siteId: string, wifiNetworkId: string): Promise<Record<string, unknown>> {
    return asObject(await this.#json("network", "GET",
      `/v1/sites/${id(siteId, "site")}/wifi/broadcasts/${id(wifiNetworkId, "WiFi network")}`), "WiFi network");
  }

  /** One WiFi network's settings, parsed. */
  async getWifi(siteId: string, wifiNetworkId: string): Promise<UnifiWifiNetworkInfo> {
    return parseWifiInfo(await this.getWifiRaw(siteId, wifiNetworkId));
  }

  /** Replaces a WiFi network's settings. `body` is a full settings object, from `getWifiRaw`. */
  async putWifi(siteId: string, wifiNetworkId: string, body: Record<string, unknown>): Promise<void> {
    await this.#json("network", "PUT",
      `/v1/sites/${id(siteId, "site")}/wifi/broadcasts/${id(wifiNetworkId, "WiFi network")}`, body);
  }

  /** A site's hotspot vouchers, newest first. */
  async listVouchers(siteId: string): Promise<UnifiVoucher[]> {
    const vouchers = (await this.#list("network", `/v1/sites/${id(siteId, "site")}/hotspot/vouchers`,
      "voucher list")).map(parseVoucher);
    return vouchers.toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Creates hotspot vouchers, returning those UniFi created. */
  async createVouchers(siteId: string, body: VoucherBody): Promise<UnifiVoucher[]> {
    const created = asObject(await this.#json("network", "POST",
      `/v1/sites/${id(siteId, "site")}/hotspot/vouchers`, body), "voucher creation");
    return Array.isArray(created.vouchers) ? created.vouchers.map(parseVoucher) : [];
  }

  /** Deletes a hotspot voucher. */
  async deleteVoucher(siteId: string, voucherId: string): Promise<void> {
    await this.#json("network", "DELETE",
      `/v1/sites/${id(siteId, "site")}/hotspot/vouchers/${id(voucherId, "voucher")}`);
  }

  // -------------------------------------------------------------------------
  // Protect

  /** `GET /v1/meta/info`. */
  async protectInfo(): Promise<{ applicationVersion: string }> {
    return parseProtectInfo(await this.#json("protect", "GET", "/v1/meta/info"));
  }

  /** The NVR, which carries the alarm state. */
  async getNvr(): Promise<ProtectNvr> {
    return parseNvr(await this.#json("protect", "GET", "/v1/nvrs"));
  }

  /** Every camera. */
  async listCameras(): Promise<UnifiCameraInfo[]> {
    return protectList(await this.#json("protect", "GET", "/v1/cameras"), "camera list").map(parseCamera);
  }

  /** One camera. */
  async getCamera(cameraId: string): Promise<UnifiCameraInfo> {
    return parseCamera(await this.#json("protect", "GET", `/v1/cameras/${id(cameraId, "camera")}`));
  }

  /** Changes a camera's settings. */
  async patchCamera(cameraId: string, patch: CameraPatch): Promise<void> {
    await this.#json("protect", "PATCH", `/v1/cameras/${id(cameraId, "camera")}`, patch);
  }

  /** Captures a snapshot. */
  async snapshot(cameraId: string, options: { highQuality: boolean; packageCamera: boolean }): Promise<SnapshotBytes> {
    const query: Record<string, string> = { highQuality: options.highQuality ? "true" : "false" };
    if (options.packageCamera) query.channel = "package";
    const response = await this.#send({
      target: this.#target("protect"), method: "GET", path: `/v1/cameras/${id(cameraId, "camera")}/snapshot`,
      query, accept: "jpeg",
    });
    if (!response.ok) {
      if (response.failure.status === 503) {
        throw new UnifiError({ ...response.failure, message: "The camera is offline or not reachable." });
      }
      throw new UnifiError(response.failure);
    }
    if (!("bytes" in response)) throw new UnifiError({ kind: "protocol", message: "UniFi returned data where an image was expected." });
    return { bytes: response.bytes, contentType: response.contentType };
  }

  /** Turns a PTZ camera to a preset; `-1` is home. */
  async ptzGoTo(cameraId: string, slot: number): Promise<void> {
    await this.#json("protect", "POST", `/v1/cameras/${id(cameraId, "camera")}/ptz/goto/${slot}`);
  }

  /** Starts a PTZ patrol. */
  async ptzStartPatrol(cameraId: string, slot: number): Promise<void> {
    await this.#json("protect", "POST", `/v1/cameras/${id(cameraId, "camera")}/ptz/patrol/start/${slot}`);
  }

  /** Stops a PTZ patrol. */
  async ptzStopPatrol(cameraId: string): Promise<void> {
    await this.#json("protect", "POST", `/v1/cameras/${id(cameraId, "camera")}/ptz/patrol/stop`);
  }

  /** Every sensor. */
  async listSensors(): Promise<UnifiSensorInfo[]> {
    return protectList(await this.#json("protect", "GET", "/v1/sensors"), "sensor list").map(parseSensor);
  }

  /** One sensor. */
  async getSensor(sensorId: string): Promise<UnifiSensorInfo> {
    return parseSensor(await this.#json("protect", "GET", `/v1/sensors/${id(sensorId, "sensor")}`));
  }

  /** Every floodlight. */
  async listLights(): Promise<UnifiLightInfo[]> {
    return protectList(await this.#json("protect", "GET", "/v1/lights"), "floodlight list").map(parseLight);
  }

  /** One floodlight. */
  async getLight(lightId: string): Promise<UnifiLightInfo> {
    return parseLight(await this.#json("protect", "GET", `/v1/lights/${id(lightId, "floodlight")}`));
  }

  /** Changes a floodlight's settings. */
  async patchLight(lightId: string, patch: LightPatch): Promise<void> {
    await this.#json("protect", "PATCH", `/v1/lights/${id(lightId, "floodlight")}`, patch);
  }

  // -------------------------------------------------------------------------

  #target(app: UnifiApp): UnifiRequest["target"] {
    return { kind: "app", app, consoleId: this.consoleId };
  }

  async #json(app: UnifiApp, method: UnifiMethod, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
    return jsonOf(await this.#send({
      target: this.#target(app), method, path,
      ...(body !== undefined && { body }), ...(query && { query }),
    }));
  }

  async #list(app: UnifiApp, path: string, what: string, extra?: Record<string, string>): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let offset = 0; offset < MAX_LIST_ITEMS; offset += PAGE_SIZE) {
      const page = parseNetworkPage(await this.#json(app, "GET", path, undefined,
        { ...extra, offset: String(offset), limit: String(PAGE_SIZE) }), what);
      items.push(...page.data);
      if (page.data.length < PAGE_SIZE || items.length >= page.totalCount) break;
    }
    return items.slice(0, MAX_LIST_ITEMS);
  }
}

function protectList(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) throw new UnifiError({ kind: "protocol", message: `UniFi returned an unexpected ${what}.` });
  return body;
}

function badRequest(message: string): UnifiError {
  return new UnifiError({ kind: "badRequest", message });
}

function id(value: string, what: string): string {
  if (!isValidId(value)) throw badRequest(`That isn't a valid UniFi ${what} ID: ${JSON.stringify(value)}`);
  return value;
}
