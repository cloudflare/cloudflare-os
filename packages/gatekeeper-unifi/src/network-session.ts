/**
 * The Network side of the agent API (network-types.d.ts): a site, a device, a WiFi network, and a
 * site's guest hotspot. Each object is bound to its IDs when it is made, every path it requests is
 * under its site, and every read is authorized before its data is returned.
 *
 * Reads made only to prepare an action -- the device's name for the approval text, a port's PoE
 * capability -- are not observations; what they reveal is in the action description.
 */

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { UnifiError } from "./errors";
import type { VoucherRequest } from "./actions";
import { parseWifiInfo, PERSONAL_SECURITY_TYPES, wifiPassphrase } from "./parse";
import {
  isPlaceholderVoucherId, simulateClientDetails, simulateClients, simulatePassphrase, simulateVouchers,
  simulateWifiInfo, simulateWifiSummaries,
} from "./simulation";
import { count, md, requireId, requireInteger, type SessionContext } from "./session-context";
import type {
  UnifiClient, UnifiClientDetails, UnifiDevice, UnifiDeviceDetails, UnifiDeviceStatistics,
  UnifiGuestLimits, UnifiHotspot, UnifiLanNetwork, UnifiNetworkDevice, UnifiNetworkSite,
  UnifiSiteInfo, UnifiVoucher, UnifiVoucherOptions, UnifiWifiNetwork, UnifiWifiNetworkChanges,
  UnifiWifiNetworkInfo, UnifiWifiNetworkSummary,
} from "./network-types";

const GUEST_FILTER = "access.type.eq('GUEST')";
const MAX_VOUCHERS_PER_REQUEST = 100;

function badRequest(message: string): UnifiError {
  return new UnifiError({ kind: "badRequest", message });
}

/** The site's display name, resolved once per object. */
class SiteLabel {
  readonly #ctx: SessionContext;
  readonly #siteId: string;
  #name: Promise<string> | undefined;

  constructor(ctx: SessionContext, siteId: string) {
    this.#ctx = ctx;
    this.#siteId = siteId;
  }

  get(): Promise<string> {
    return this.#name ??= this.#ctx.shared.api.getSite(this.#siteId).then(
      site => site.name, () => this.#siteId);
  }
}

/** One site. */
@validateRpc()
export class NetworkSiteSession extends RpcTarget implements UnifiNetworkSite {
  readonly #ctx: SessionContext;
  readonly #siteId: string;
  readonly #label: SiteLabel;

  constructor(ctx: SessionContext, siteId: string) {
    super();
    this.#ctx = ctx;
    this.#siteId = siteId;
    this.#label = new SiteLabel(ctx, siteId);
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiSiteInfo> {
    const { api } = this.#ctx.shared;
    const [site, info, consoleName] = await Promise.all([
      api.getSite(this.#siteId), api.networkInfo(), this.#ctx.shared.consoleName(),
    ]);
    await this.#ctx.observe("Read a UniFi site", `Read the name of UniFi site ${md(site.name)} on ${md(consoleName)}.`);
    return { consoleId: api.consoleId, consoleName, siteId: site.id, name: site.name, networkVersion: info.applicationVersion };
  }

  async listDevices(): Promise<UnifiDevice[]> {
    const devices = await this.#ctx.shared.api.listDevices(this.#siteId);
    await this.#ctx.observe("List UniFi devices",
      `Listed ${count(devices.length, "device")} on UniFi site ${md(await this.#label.get())}.`);
    return devices;
  }

  getDevice(deviceId: string): UnifiNetworkDevice {
    return new NetworkDeviceSession(this.#ctx.fork(), this.#siteId, requireId(deviceId, "device"), true);
  }

  async listClients(): Promise<UnifiClient[]> {
    const clients = simulateClients(
      await this.#ctx.shared.api.listClients(this.#siteId), this.#siteId, this.#ctx.shared.pending());
    await this.#ctx.observe("List UniFi clients",
      `Listed ${count(clients.length, "client")} connected to UniFi site ${md(await this.#label.get())}.`);
    return clients;
  }

  async getClient(clientId: string): Promise<UnifiClientDetails> {
    const { api, pending, now } = this.#ctx.shared;
    const client = simulateClientDetails(
      await api.getClient(this.#siteId, requireId(clientId, "client")), this.#siteId, pending(), now());
    await this.#ctx.observe("Read a UniFi client",
      `Read client ${md(client.name)} on UniFi site ${md(await this.#label.get())}.`);
    return client;
  }

  async listNetworks(): Promise<UnifiLanNetwork[]> {
    const networks = await this.#ctx.shared.api.listLanNetworks(this.#siteId);
    await this.#ctx.observe("List UniFi networks",
      `Listed ${count(networks.length, "network")} on UniFi site ${md(await this.#label.get())}.`);
    return networks;
  }

  async listWifiNetworks(): Promise<UnifiWifiNetworkSummary[]> {
    const networks = simulateWifiSummaries(
      await this.#ctx.shared.api.listWifiNetworks(this.#siteId), this.#siteId, this.#ctx.shared.pending());
    await this.#ctx.observe("List UniFi WiFi networks",
      `Listed ${count(networks.length, "WiFi network")} on UniFi site ${md(await this.#label.get())}.`);
    return networks;
  }

  getWifiNetwork(wifiNetworkId: string): UnifiWifiNetwork {
    return new WifiNetworkSession(this.#ctx.fork(), this.#siteId, requireId(wifiNetworkId, "WiFi network"));
  }

  getHotspot(): UnifiHotspot {
    return new HotspotSession(this.#ctx.fork(), this.#siteId);
  }
}

/** One gateway, switch, or access point. */
@validateRpc()
export class NetworkDeviceSession extends RpcTarget implements UnifiNetworkDevice {
  readonly #ctx: SessionContext;
  readonly #siteId: string;
  readonly #deviceId: string;
  readonly #clientsVisible: boolean;

  /**
   * @param clientsVisible Whether the device's clients may be listed: true when reached from a
   * site, and for a device binding only if the user granted its clients.
   */
  constructor(ctx: SessionContext, siteId: string, deviceId: string, clientsVisible: boolean) {
    super();
    this.#ctx = ctx;
    this.#siteId = siteId;
    this.#deviceId = deviceId;
    this.#clientsVisible = clientsVisible;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiDeviceDetails> {
    const device = await this.#ctx.shared.api.getDevice(this.#siteId, this.#deviceId);
    await this.#ctx.observe("Read a UniFi device", `Read the details of UniFi device ${md(device.name)}.`);
    return device;
  }

  async getStatistics(): Promise<UnifiDeviceStatistics> {
    const { api } = this.#ctx.shared;
    const [statistics, device] = await Promise.all([
      api.getDeviceStatistics(this.#siteId, this.#deviceId), api.getDevice(this.#siteId, this.#deviceId),
    ]);
    await this.#ctx.observe("Read UniFi device statistics", `Read the latest statistics of UniFi device ${md(device.name)}.`);
    return statistics;
  }

  async listClients(): Promise<UnifiClient[]> {
    if (!this.#clientsVisible) {
      throw new UnifiError({
        kind: "forbidden",
        message: "This connection doesn't include the device's clients. Ask the user to reconnect it with them.",
      });
    }
    const { api, pending } = this.#ctx.shared;
    const [all, device] = await Promise.all([
      api.listClients(this.#siteId), api.getDevice(this.#siteId, this.#deviceId),
    ]);
    const clients = simulateClients(all.filter(client => client.uplinkDeviceId === this.#deviceId), this.#siteId, pending());
    await this.#ctx.observe("List clients of a UniFi device",
      `Listed ${count(clients.length, "client")} connected through UniFi device ${md(device.name)}.`);
    return clients;
  }

  async restart(): Promise<void> {
    const device = await this.#ctx.shared.api.getDevice(this.#siteId, this.#deviceId);
    const payload = { siteId: this.#siteId, deviceId: this.#deviceId, deviceName: device.name, model: device.model };
    await this.#ctx.submit(device.roles.includes("gateway") ? "restartGateway" : "restartDevice", payload);
  }

  async powerCyclePort(portIndex: number): Promise<void> {
    requireInteger(portIndex, "The port number", 1, 1024);
    const device = await this.#ctx.shared.api.getDevice(this.#siteId, this.#deviceId);
    const port = device.ports.find(p => p.index === portIndex);
    if (!port) throw badRequest(`${device.name} has no port ${portIndex}.`);
    if (!port.poe) throw badRequest(`Port ${portIndex} on ${device.name} has no PoE.`);
    if (!port.poe.enabled) throw badRequest(`PoE is turned off on port ${portIndex} of ${device.name}.`);
    await this.#ctx.submit("powerCyclePort",
      { siteId: this.#siteId, deviceId: this.#deviceId, deviceName: device.name, portIndex });
  }
}

/** One WiFi network. */
@validateRpc()
export class WifiNetworkSession extends RpcTarget implements UnifiWifiNetwork {
  readonly #ctx: SessionContext;
  readonly #siteId: string;
  readonly #wifiNetworkId: string;

  constructor(ctx: SessionContext, siteId: string, wifiNetworkId: string) {
    super();
    this.#ctx = ctx;
    this.#siteId = siteId;
    this.#wifiNetworkId = wifiNetworkId;
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async describe(): Promise<UnifiWifiNetworkInfo> {
    const network = simulateWifiInfo(
      await this.#ctx.shared.api.getWifi(this.#siteId, this.#wifiNetworkId), this.#siteId, this.#ctx.shared.pending());
    await this.#ctx.observe("Read a UniFi WiFi network", `Read the settings of WiFi network ${md(network.name)}.`);
    return network;
  }

  async getPassphrase(): Promise<string | null> {
    const { api, pending } = this.#ctx.shared;
    const raw = await api.getWifiRaw(this.#siteId, this.#wifiNetworkId);
    const network = simulateWifiInfo(parseWifiInfo(raw), this.#siteId, pending());
    const passphrase = simulatePassphrase(wifiPassphrase(raw), this.#siteId, this.#wifiNetworkId, pending());
    await this.#ctx.observe("Read a UniFi WiFi password", `Read the password of WiFi network ${md(network.name)}.`);
    return passphrase;
  }

  async update(changes: UnifiWifiNetworkChanges): Promise<void> {
    const { name, enabled, hidden, passphrase } = changes;
    if (name === undefined && enabled === undefined && hidden === undefined && passphrase === undefined) {
      throw badRequest("Say what to change: name, enabled, hidden, or passphrase.");
    }
    if (name !== undefined && (name.length < 1 || new TextEncoder().encode(name).byteLength > 32)) {
      throw badRequest("A WiFi network name must be 1 to 32 bytes long.");
    }
    if (passphrase !== undefined && !/^[\x20-\x7e]{8,63}$/.test(passphrase)) {
      throw badRequest("A WiFi password must be 8 to 63 printable ASCII characters.");
    }
    const raw = await this.#ctx.shared.api.getWifiRaw(this.#siteId, this.#wifiNetworkId);
    if (passphrase !== undefined) {
      const security = raw.securityConfiguration as { type?: unknown } | undefined;
      if (typeof security?.type !== "string" || !PERSONAL_SECURITY_TYPES.has(security.type)) {
        throw badRequest("Only a WPA2 or WPA3 Personal network has a password to change.");
      }
    }
    const current = simulateWifiInfo(parseWifiInfo(raw), this.#siteId, this.#ctx.shared.pending());
    await this.#ctx.submit("updateWifi", {
      siteId: this.#siteId, wifiNetworkId: this.#wifiNetworkId, networkName: current.name,
      changes: {
        ...(name !== undefined && { name }), ...(enabled !== undefined && { enabled }),
        ...(hidden !== undefined && { hidden }), ...(passphrase !== undefined && { passphrase }),
      },
    });
  }
}

/** A site's guest hotspot. Never reveals a client that isn't a guest. */
@validateRpc()
export class HotspotSession extends RpcTarget implements UnifiHotspot {
  readonly #ctx: SessionContext;
  readonly #siteId: string;
  readonly #label: SiteLabel;

  constructor(ctx: SessionContext, siteId: string) {
    super();
    this.#ctx = ctx;
    this.#siteId = siteId;
    this.#label = new SiteLabel(ctx, siteId);
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }

  async listGuests(): Promise<UnifiClient[]> {
    const { api, pending } = this.#ctx.shared;
    // Filtered here as well as by UniFi: this capability must not reveal other clients even if a
    // console ignored the filter.
    const guests = simulateClients(
      (await api.listClients(this.#siteId, GUEST_FILTER)).filter(client => client.guest !== null),
      this.#siteId, pending());
    await this.#ctx.observe("List UniFi WiFi guests",
      `Listed ${count(guests.length, "guest")} connected to the guest hotspot of UniFi site ${md(await this.#label.get())}.`);
    return guests;
  }

  async getGuest(clientId: string): Promise<UnifiClientDetails> {
    const guest = await this.#guest(clientId);
    await this.#ctx.observe("Read a UniFi WiFi guest", `Read guest ${md(guest.name)}'s access to the guest hotspot.`);
    return guest;
  }

  async authorizeGuest(clientId: string, limits?: UnifiGuestLimits): Promise<void> {
    const checked = validateGuestLimits(limits ?? {});
    const guest = await this.#guest(clientId);
    await this.#ctx.submit("guestAccess", {
      siteId: this.#siteId, clientId: guest.id, clientName: guest.name, change: { authorize: true, limits: checked },
    });
  }

  async revokeGuest(clientId: string): Promise<void> {
    const guest = await this.#guest(clientId);
    await this.#ctx.submit("guestAccess", {
      siteId: this.#siteId, clientId: guest.id, clientName: guest.name, change: { authorize: false },
    });
  }

  async listVouchers(): Promise<UnifiVoucher[]> {
    const vouchers = simulateVouchers(
      await this.#ctx.shared.api.listVouchers(this.#siteId), this.#siteId, this.#ctx.shared.pending());
    await this.#ctx.observe("List UniFi hotspot vouchers",
      `Listed ${count(vouchers.length, "voucher")} for the guest hotspot of UniFi site ${md(await this.#label.get())}.`);
    return vouchers;
  }

  async createVouchers(options: UnifiVoucherOptions): Promise<void> {
    const request = validateVoucherOptions(options);
    const batch = crypto.randomUUID();
    const placeholderIds = Array.from({ length: request.count }, (_, i) => `pending-${batch}-${i + 1}`);
    await this.#ctx.submit("createVouchers",
      { siteId: this.#siteId, request, placeholderIds, submittedAt: this.#ctx.shared.now() });
  }

  async deleteVoucher(voucherId: string): Promise<void> {
    if (isPlaceholderVoucherId(voucherId)) {
      throw badRequest("That voucher hasn't been created yet, so it can't be deleted.");
    }
    requireId(voucherId, "voucher");
    const vouchers = simulateVouchers(
      await this.#ctx.shared.api.listVouchers(this.#siteId), this.#siteId, this.#ctx.shared.pending());
    const voucher = vouchers.find(v => v.id === voucherId);
    if (!voucher) throw new UnifiError({ kind: "notFound", message: "There's no voucher with that ID." });
    await this.#ctx.submit("deleteVoucher",
      { siteId: this.#siteId, voucherId, note: voucher.note, code: voucher.code });
  }

  /** The client, simulated, if it's a guest; the same error whether it isn't one or doesn't exist. */
  async #guest(clientId: string): Promise<UnifiClientDetails> {
    const { api, pending, now } = this.#ctx.shared;
    let client: UnifiClientDetails;
    try {
      client = await api.getClient(this.#siteId, requireId(clientId, "client"));
    } catch (error) {
      if (error instanceof UnifiError && error.kind === "notFound") throw notAGuest();
      throw error;
    }
    if (client.guest === null) throw notAGuest();
    return simulateClientDetails(client, this.#siteId, pending(), now());
  }
}

function notAGuest(): UnifiError {
  return new UnifiError({ kind: "notFound", message: "No guest with that ID is connected to the guest hotspot." });
}

function optionalInteger(value: number | undefined, what: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requireInteger(value, what, min, max);
}

/** Checks guest limits against the Network API's ranges. */
export function validateGuestLimits(limits: UnifiGuestLimits): UnifiGuestLimits {
  const durationMinutes = optionalInteger(limits.durationMinutes, "durationMinutes", 1, 1_000_000);
  const dataLimitMB = optionalInteger(limits.dataLimitMB, "dataLimitMB", 1, 1_048_576);
  const downloadLimitKbps = optionalInteger(limits.downloadLimitKbps, "downloadLimitKbps", 2, 100_000);
  const uploadLimitKbps = optionalInteger(limits.uploadLimitKbps, "uploadLimitKbps", 2, 100_000);
  return {
    ...(durationMinutes !== undefined && { durationMinutes }),
    ...(dataLimitMB !== undefined && { dataLimitMB }),
    ...(downloadLimitKbps !== undefined && { downloadLimitKbps }),
    ...(uploadLimitKbps !== undefined && { uploadLimitKbps }),
  };
}

/** Checks voucher options and fills in their defaults. */
export function validateVoucherOptions(options: UnifiVoucherOptions): VoucherRequest {
  const note = options.note.trim();
  if (note === "" || note.length > 128) throw badRequest("A voucher note must be 1 to 128 characters.");
  return {
    count: requireInteger(options.count ?? 1, "count", 1, MAX_VOUCHERS_PER_REQUEST),
    note,
    durationMinutes: requireInteger(options.durationMinutes, "durationMinutes", 1, 1_000_000),
    guestLimit: options.guestLimit === null ? null
      : requireInteger(options.guestLimit ?? 1, "guestLimit", 1, 1_000_000),
    dataLimitMB: optionalInteger(options.dataLimitMB, "dataLimitMB", 1, 1_048_576) ?? null,
    downloadLimitKbps: optionalInteger(options.downloadLimitKbps, "downloadLimitKbps", 2, 100_000) ?? null,
    uploadLimitKbps: optionalInteger(options.uploadLimitKbps, "uploadLimitKbps", 2, 100_000) ?? null,
  };
}
