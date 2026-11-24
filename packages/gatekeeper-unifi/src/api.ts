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
  parseDeviceStatistics, parseGuestAuthorization, parseLanNetwork, parseLight, parseNetworkInfo, parseNetworkPage, parseNvr,
  parseProtectInfo, parseSensor, parseSite, parseVoucher, parseWifiInfo, parseWifiSummary, listedAsGateway,
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
/** The most vouchers read looking for some by ID when a console doesn't apply the `id` filter. */
const MAX_VOUCHER_SCAN = 10_000;
/** The most clients read looking for one device's. */
const MAX_CLIENT_SCAN = 10_000;

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
    const site = (await this.listSites()).find(s => sameId(s.id, siteId));
    if (!site) throw new UnifiError({ kind: "notFound", message: "That site isn't on this console." });
    return site;
  }

  /** A site's adopted devices. */
  async listDevices(siteId: string): Promise<UnifiDevice[]> {
    return (await this.#list("network", `/v1/sites/${id(siteId, "site")}/devices`, "device list")).map(parseDevice);
  }

  /** Whether a device is the site's gateway, from the device list; null when the list doesn't say. */
  async isGateway(siteId: string, deviceId: string): Promise<boolean | null> {
    const listed = (await this.#list("network", `/v1/sites/${id(siteId, "site")}/devices`, "device list"))
      .find(device => sameId(String(asObject(device, "device").id), deviceId));
    if (!listed) throw new UnifiError({ kind: "notFound", message: "That device isn't on this site." });
    return listedAsGateway(listed);
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
    const listed = devices.find(device => sameId(device.id, deviceId));
    if (!listed) throw new UnifiError({ kind: "notFound", message: "That device isn't on this site." });
    return answering(parseDeviceDetails(details, listed.roles), deviceId, "device");
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

  /** The clients connected through one device, up to `MAX_LIST_ITEMS` (see `#scanClients`). */
  async listClientsOf(siteId: string, deviceId: string): Promise<UnifiClient[]> {
    return await this.#scanClients(siteId, "the device's",
      client => client.uplinkDeviceId !== null && sameId(client.uplinkDeviceId, deviceId));
  }

  /**
   * The site's guest clients, up to `MAX_LIST_ITEMS`. UniFi is asked for guests only, and they're
   * checked here too, since a console that ignored the filter would list every client.
   */
  async listGuests(siteId: string): Promise<UnifiClient[]> {
    return await this.#scanClients(siteId, "its guests", client => client.guest !== null, "access.type.eq('GUEST')");
  }

  /**
   * The clients `matches` picks, up to `MAX_LIST_ITEMS`, read page by page until the list ends or
   * that many are found: cut at the site's first 1,000 clients, the list could leave out every one.
   * @throws UnifiError when that would take more than `MAX_CLIENT_SCAN` clients, rather than
   * answering with what might look like all of them.
   */
  async #scanClients(siteId: string, which: string, matches: (client: UnifiClient) => boolean, filter?: string): Promise<UnifiClient[]> {
    const path = `/v1/sites/${id(siteId, "site")}/clients`;
    const found: UnifiClient[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (offset >= MAX_CLIENT_SCAN) {
        throw new UnifiError({
          kind: "protocol", message: `This site has more than ${MAX_CLIENT_SCAN} clients, so ${which} couldn't all be found.`,
        });
      }
      const page = parseNetworkPage(await this.#json("network", "GET", path, undefined,
        { offset: String(offset), limit: String(PAGE_SIZE), ...(filter && { filter }) }), "client list");
      found.push(...page.data.map(parseClient).filter(matches));
      if (found.length >= MAX_LIST_ITEMS) return found.slice(0, MAX_LIST_ITEMS);
      if (page.data.length < PAGE_SIZE || offset + page.data.length >= page.totalCount) return found;
    }
  }

  /** One connected client's details. */
  async getClient(siteId: string, clientId: string): Promise<UnifiClientDetails> {
    return answering(parseClientDetails(await this.#json("network", "GET",
      `/v1/sites/${id(siteId, "site")}/clients/${id(clientId, "client")}`)), clientId, "client");
  }

  /** Authorizes a guest client. */
  /**
   * Authorizes a guest client.
   * @throws UnifiError (protocol) unless UniFi answers with the grant it made: a bare success, from
   * a proxy say, doesn't show the guest was let on.
   */
  async authorizeGuest(siteId: string, clientId: string, limits: GuestLimitsBody): Promise<void> {
    const receipt = await this.#json("network", "POST", `/v1/sites/${id(siteId, "site")}/clients/${id(clientId, "client")}/actions`,
      { action: "AUTHORIZE_GUEST_ACCESS", ...limits });
    const granted = receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>).grantedAuthorization : undefined;
    if (!granted) throw new UnifiError({ kind: "protocol", message: "UniFi's answer didn't include the guest's new access." });
    parseGuestAuthorization(true, granted);
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

  /**
   * `findVouchers` through the `id` filter, a hundred IDs a request to keep URLs short; null when
   * the console refuses the filter, or ignores it by answering with vouchers that weren't asked for.
   */
  async #findVouchersFiltered(
    path: string, ids: readonly string[], isWanted: (raw: unknown) => boolean,
  ): Promise<UnifiVoucher[] | null> {
    const found: UnifiVoucher[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      let page;
      try {
        page = parseNetworkPage(await this.#json("network", "GET", path, undefined,
          { filter: `id.in(${chunk.join(",")})`, offset: "0", limit: String(PAGE_SIZE) }), "voucher list");
      } catch (error) {
        if (error instanceof UnifiError && error.kind === "badRequest") return null;
        throw error;
      }
      // A console that applied the filter answered with these vouchers alone.
      if (page.totalCount > chunk.length || !page.data.every(isWanted)) return null;
      found.push(...page.data.map(parseVoucher));
    }
    return found;
  }

  /** One WiFi network's settings, as UniFi returns them, for reading or for `putWifi`. */
  async getWifiRaw(siteId: string, wifiNetworkId: string): Promise<Record<string, unknown>> {
    const raw = asObject(await this.#json("network", "GET",
      `/v1/sites/${id(siteId, "site")}/wifi/broadcasts/${id(wifiNetworkId, "WiFi network")}`), "WiFi network");
    answering({ id: String(raw.id) }, wifiNetworkId, "WiFi network");
    return raw;
  }

  /** One WiFi network's settings, parsed. */
  async getWifi(siteId: string, wifiNetworkId: string): Promise<UnifiWifiNetworkInfo> {
    return parseWifiInfo(await this.getWifiRaw(siteId, wifiNetworkId));
  }

  /**
   * Replaces a WiFi network's settings. `body` is a full settings object, from `getWifiRaw`.
   * @throws UnifiError (protocol) unless UniFi answers with the network's settings as written: a bare
   * success, from a proxy say, or settings that contradict the change, don't show it was made. The
   * error never quotes a value, which may be a password.
   */
  async putWifi(siteId: string, wifiNetworkId: string, body: Record<string, unknown>): Promise<void> {
    const updated = await this.#json("network", "PUT",
      `/v1/sites/${id(siteId, "site")}/wifi/broadcasts/${id(wifiNetworkId, "WiFi network")}`, body);
    answering(parseWifiInfo(updated), wifiNetworkId, "WiFi network");
    const receipt = asObject(updated, "WiFi network");
    // A field the answer leaves out is no contradiction; one it shows differently is.
    const contradicts = ["name", "enabled", "hideName"].some(key => key in receipt && receipt[key] !== body[key]) ||
      (passphrase(receipt) !== undefined && passphrase(receipt) !== passphrase(body));
    if (contradicts) {
      throw new UnifiError({ kind: "protocol", message: "UniFi's answer doesn't show the WiFi network's new settings." });
    }
  }

  /** A site's hotspot vouchers, newest first. */
  async listVouchers(siteId: string): Promise<UnifiVoucher[]> {
    const vouchers = (await this.#list("network", `/v1/sites/${id(siteId, "site")}/hotspot/vouchers`,
      "voucher list")).map(parseVoucher);
    return vouchers.toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /**
   * The vouchers with these IDs that still exist, however many others the site has, through the
   * voucher list's documented `id` filter. A console that refuses or ignores the filter is read
   * page by page until all of them turn up or the list ends; one missing then is gone.
   * @throws UnifiError when that would take more than `MAX_VOUCHER_SCAN` vouchers, rather than
   * calling the rest gone.
   */
  async findVouchers(siteId: string, ids: readonly string[]): Promise<UnifiVoucher[]> {
    if (ids.length === 0) return [];
    for (const voucherId of ids) id(voucherId, "voucher");
    const path = `/v1/sites/${id(siteId, "site")}/hotspot/vouchers`;
    const wanted = new Set(ids.map(voucherId => voucherId.toLowerCase()));
    const isWanted = (raw: unknown) => wanted.has(String(asObject(raw, "voucher").id).toLowerCase());
    const filteredFinds = await this.#findVouchersFiltered(path, ids, isWanted);
    if (filteredFinds) return filteredFinds;
    const found = new Map<string, UnifiVoucher>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (offset >= MAX_VOUCHER_SCAN) {
        throw new UnifiError({
          kind: "protocol",
          message: `This console doesn't apply UniFi's voucher filter, and its site has more than ${MAX_VOUCHER_SCAN} ` +
            "vouchers, so these couldn't all be looked for.",
        });
      }
      const page = parseNetworkPage(await this.#json("network", "GET", path, undefined,
        { offset: String(offset), limit: String(PAGE_SIZE) }), "voucher list");
      for (const raw of page.data.filter(isWanted)) {
        const voucher = parseVoucher(raw);
        found.set(voucher.id, voucher);
      }
      if (found.size === wanted.size || page.data.length < PAGE_SIZE || offset + page.data.length >= page.totalCount) break;
    }
    return [...found.values()];
  }

  /** Creates hotspot vouchers, returning those UniFi created. */
  /**
   * Creates vouchers.
   * @throws UnifiError (protocol) when the receipt doesn't list as many distinct vouchers as were
   * asked for: the console may have issued them, so this can't be called a batch of none.
   */
  async createVouchers(siteId: string, body: VoucherBody): Promise<UnifiVoucher[]> {
    const created = asObject(await this.#json("network", "POST",
      `/v1/sites/${id(siteId, "site")}/hotspot/vouchers`, body), "voucher creation");
    const vouchers = Array.isArray(created.vouchers) ? created.vouchers.map(parseVoucher) : [];
    if (new Set(vouchers.map(voucher => voucher.id)).size !== body.count) {
      throw new UnifiError({ kind: "protocol", message: "UniFi's reply didn't list the vouchers it created." });
    }
    return vouchers;
  }

  /** Deletes a hotspot voucher. */
  /**
   * Deletes a voucher, done once UniFi reports it deleted or, failing that, once it can no longer
   * be found: a bare success or a 404, from a proxy's missing route say, doesn't show the code stopped working.
   * @throws UnifiError (protocol) when the voucher is still there.
   */
  async deleteVoucher(siteId: string, voucherId: string): Promise<void> {
    let deleted = 0;
    try {
      const receipt = await this.#json("network", "DELETE",
        `/v1/sites/${id(siteId, "site")}/hotspot/vouchers/${id(voucherId, "voucher")}`);
      const count = receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>).vouchersDeleted : undefined;
      deleted = typeof count === "number" ? count : 0;
    } catch (error) {
      if (!(error instanceof UnifiError && error.kind === "notFound")) throw error;
    }
    if (deleted > 0) return;
    if ((await this.findVouchers(siteId, [voucherId])).length > 0) {
      throw new UnifiError({ kind: "protocol", message: "UniFi didn't confirm the voucher was deleted, and it's still there." });
    }
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
    return answering(parseCamera(await this.#json("protect", "GET", `/v1/cameras/${id(cameraId, "camera")}`)), cameraId, "camera");
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
    return answering(parseSensor(await this.#json("protect", "GET", `/v1/sensors/${id(sensorId, "sensor")}`)), sensorId, "sensor");
  }

  /** Every floodlight. */
  async listLights(): Promise<UnifiLightInfo[]> {
    return protectList(await this.#json("protect", "GET", "/v1/lights"), "floodlight list").map(parseLight);
  }

  /** One floodlight. */
  async getLight(lightId: string): Promise<UnifiLightInfo> {
    return answering(parseLight(await this.#json("protect", "GET", `/v1/lights/${id(lightId, "floodlight")}`)), lightId, "floodlight");
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

/** A WiFi settings object's password, if it shows one. */
function passphrase(settings: Record<string, unknown>): unknown {
  return (settings.securityConfiguration as Record<string, unknown> | undefined)?.passphrase;
}

/** Whether two IDs name the same item: UniFi's are UUIDs or hex, which may be written in either case. */
export function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * An item's details, checked to be the item asked for: a misrouted answer, from a proxy say, would
 * otherwise be read, or changed, as the bound one.
 */
function answering<T extends { id: string }>(item: T, requested: string, what: string): T {
  if (!sameId(item.id, requested)) {
    throw new UnifiError({ kind: "protocol", message: `UniFi answered with a different ${what} than was asked for.` });
  }
  return item;
}

function id(value: string, what: string): string {
  if (!isValidId(value)) throw badRequest(`That isn't a valid UniFi ${what} ID: ${JSON.stringify(value)}`);
  return value;
}
