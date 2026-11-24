/**
 * What a read depends on, for observer verification: the data it returned, named by the UniFi
 * endpoint a key needs to read that data. A collaborator passes only for what their own key can
 * read at the same endpoint, since UniFi roles differ in what they can see: a Network role can be
 * limited to some sites, and a Protect role to some cameras.
 *
 * IDs start `console/<consoleId>/app/<network|protect>`, the console ID being the one in the
 * binding's resource URL, which never changes for a binding; alone, that names the application's
 * own information, such as its version. Then, in Network, a site's own details
 * are `/site/<siteId>`; its devices, clients, LAN networks, WiFi network list and voucher codes are
 * `/devices/<siteId>`, `/clients/<siteId>`, `/networks/<siteId>`, `/wifiNetworks/<siteId>` and
 * `/vouchers/<siteId>`, with `/site/<siteId>/voucherCode/<id>` for each voucher whose working code a
 * read returned, which a key passes only if it finds that voucher with its code; one WiFi network's settings, password included, are
 * `/site/<siteId>/wifi/<wifiNetworkId>`, and its password `/site/<siteId>/wifiPassword/<id>`, which
 * a key passes only if the settings it reads include the password; one device's details, its
 * statistics and one client's details are `/site/<siteId>/device/<id>`,
 * `/site/<siteId>/deviceStatistics/<id>` and `/site/<siteId>/client/<id>`, since a route can be
 * allowed apart from the list it's under. In Protect, the NVR and its alarm are `/nvr/<id>`, each
 * device `/camera/<id>`, `/sensor/<id>` or `/light/<id>`, a camera's images `/snapshot/<id>` and
 * `/packageSnapshot/<id>` (its package camera), which can be allowed apart from its details, and a
 * list of them `/list/<cameras|sensors|lights>`, reported by every listing, an empty one included:
 * a key can be allowed to open each device and refused the list, or the other way round.
 *
 * Pure: imported by the Node tests.
 */

import { formatSubresourceId, parseSubresourceId, type SubresourceFragment } from "@gadgets/gatekeeper-kit/subresource-ids";
import { UnifiError } from "./errors";
import {
  parseCamera, parseClient, parseClientDetails, parseDevice, parseDeviceDetails, parseDeviceStatistics, parseLanNetwork,
  parseLight, parseNetworkInfo, parseNetworkPage, parseNvr, parseProtectInfo, parseSensor, parseVoucher, parseWifiInfo,
  parseWifiSummary, wifiPassphrase,
} from "./parse";
import { isValidId, resourceApp, type UnifiResource } from "./resources";
import type { UnifiApp } from "./transport";

/**
 * One thing a read depends on, within the bound console's application. A Protect requirement names
 * a device, a Network one a site (and, for a WiFi network's settings, the network).
 */
export type UnifiRequirement =
  | { kind: "app" }
  | { kind: "list"; id: "cameras" | "sensors" | "lights" }
  | { kind: "nvr"; id: string }
  | { kind: "camera"; id: string }
  | { kind: "sensor"; id: string }
  | { kind: "light"; id: string }
  | { kind: "snapshot"; id: string }
  | { kind: "packageSnapshot"; id: string }
  | { kind: "site"; siteId: string }
  | { kind: "devices"; siteId: string }
  | { kind: "clients"; siteId: string }
  | { kind: "networks"; siteId: string }
  | { kind: "wifiNetworks"; siteId: string }
  | { kind: "vouchers"; siteId: string }

  | { kind: "wifi"; siteId: string; wifiNetworkId: string }
  | { kind: "wifiPassword"; siteId: string; wifiNetworkId: string }
  | { kind: "device"; siteId: string; deviceId: string }
  | { kind: "deviceStatistics"; siteId: string; deviceId: string }
  | { kind: "client"; siteId: string; clientId: string }
  | { kind: "voucherCode"; siteId: string; voucherId: string };

/** The parts of a Network site that UniFi serves from separate endpoints. */
const SITE_DATA = ["site", "devices", "clients", "networks", "wifiNetworks", "vouchers"] as const;
const PROTECT_ITEMS = ["nvr", "camera", "sensor", "light", "snapshot", "packageSnapshot"] as const;
const PROTECT_LISTS = ["cameras", "sensors", "lights"] as const;


/** The subresource ID of `requirement` on the bound console's application. */
export function requirementId(resource: UnifiResource, requirement: UnifiRequirement): string {
  const fragments: SubresourceFragment[] = [
    { name: "console", id: resource.consoleId }, { name: "app", id: resourceApp(resource.kind) },
  ];
  const item = siteItem(requirement);
  if (item && "siteId" in requirement) {
    fragments.push({ name: "site", id: requirement.siteId }, { name: requirement.kind, id: item });
  } else if ("siteId" in requirement) {
    fragments.push({ name: requirement.kind, id: requirement.siteId });
  } else if ("id" in requirement) {
    fragments.push({ name: requirement.kind, id: requirement.id });
  }
  return formatSubresourceId({ fragments });
}

/**
 * The requirement a subresource ID names, if it is one a binding to `resource` reports.
 * @throws Error for any other ID: one for another console, application or resource, or malformed.
 */
export function parseRequirement(resource: UnifiResource, id: string): UnifiRequirement {
  const requirement = decode(id);
  if (!requirement || requirementId(resource, requirement) !== id || !reports(resource, requirement)) {
    throw new Error("That isn't a subresource this UniFi binding reports.");
  }
  return requirement;
}

function decode(id: string): UnifiRequirement | null {
  let fragments: readonly SubresourceFragment[];
  try {
    ({ fragments } = parseSubresourceId(id));
  } catch {
    return null;
  }
  const [consoleFragment, app, ...rest] = fragments;
  if (consoleFragment?.name !== "console" || app?.name !== "app") return null;
  if (!rest.every(f => isValidId(f.id))) return null;
  const [first, second] = rest;
  if (!first) return { kind: "app" };
  if (second) {
    if (rest.length !== 2 || first.name !== "site") return null;
    switch (second.name) {
      case "wifi": case "wifiPassword": return { kind: second.name, siteId: first.id, wifiNetworkId: second.id };
      case "device": case "deviceStatistics": return { kind: second.name, siteId: first.id, deviceId: second.id };
      case "client": return { kind: "client", siteId: first.id, clientId: second.id };
      case "voucherCode": return { kind: "voucherCode", siteId: first.id, voucherId: second.id };
      default: return null;
    }
  }
  const name = first.name;
  if (name === "list") return isOneOf(first.id, PROTECT_LISTS) ? { kind: "list", id: first.id } : null;
  if (isOneOf(name, PROTECT_ITEMS)) return { kind: name, id: first.id };
  if (isOneOf(name, SITE_DATA)) return { kind: name, siteId: first.id };
  return null;
}

/** The ID of the one item within a site a requirement names, if it names one. */
function siteItem(requirement: UnifiRequirement): string | null {
  switch (requirement.kind) {
    case "wifi": case "wifiPassword": return requirement.wifiNetworkId;
    case "device": case "deviceStatistics": return requirement.deviceId;
    case "client": return requirement.clientId;
    case "voucherCode": return requirement.voucherId;
    default: return null;
  }
}

function isOneOf<T extends string>(value: string, options: readonly T[]): value is T {
  return (options as readonly string[]).includes(value);
}

/** Whether a binding to `resource` reports `requirement`: nothing outside what it can read. */
function reports(resource: UnifiResource, requirement: UnifiRequirement): boolean {
  const inSite = "siteId" in resource && "siteId" in requirement && requirement.siteId === resource.siteId;
  switch (resource.kind) {
    case "site": return inSite || requirement.kind === "app";
    case "device":
      return inSite && (requirement.kind === "devices" || requirement.kind === "clients" ||
        (requirement.kind === "device" || requirement.kind === "deviceStatistics") && requirement.deviceId === resource.deviceId);
    case "wifi":
      return (requirement.kind === "wifi" || requirement.kind === "wifiPassword") && inSite &&
        requirement.wifiNetworkId === resource.wifiNetworkId;
    case "hotspot":
      return inSite && (requirement.kind === "clients" || requirement.kind === "client" || requirement.kind === "vouchers" ||
        requirement.kind === "voucherCode");
    case "protect": return requirement.kind === "app" || requirement.kind === "list" || isOneOf(requirement.kind, PROTECT_ITEMS);
    case "camera":
      return (requirement.kind === "camera" || requirement.kind === "snapshot" || requirement.kind === "packageSnapshot") &&
        requirement.id === resource.cameraId;
    case "sensor": return requirement.kind === "sensor" && requirement.id === resource.sensorId;
    case "light": return requirement.kind === "light" && requirement.id === resource.lightId;
  }
}

/**
 * A requirement one request can check. A site's details are looked up through the whole site list,
 * and voucher codes all at once, by ID (`UnifiAccount.canObserve`).
 */
export type ProbedRequirement = Exclude<UnifiRequirement, { kind: "site" | "voucherCode" }>;

/**
 * The request that shows whether a key may read what `requirement` covers: the endpoint a read of
 * it calls, so whatever a role is refused there is refused here. A successful answer must also
 * satisfy `probeConfirms`.
 */
export function probeFor(
  requirement: ProbedRequirement, app: UnifiApp,
): { path: string; query?: Record<string, string>; accept?: "jpeg" } {
  const at = encodeURIComponent;
  const first = { limit: "1" };
  switch (requirement.kind) {
    case "app": return { path: app === "network" ? "/v1/info" : "/v1/meta/info" };
    case "list": return { path: `/v1/${requirement.id}` };
    case "nvr": return { path: "/v1/nvrs" };
    case "camera": return { path: `/v1/cameras/${at(requirement.id)}` };
    case "sensor": return { path: `/v1/sensors/${at(requirement.id)}` };
    case "light": return { path: `/v1/lights/${at(requirement.id)}` };
    case "snapshot":
      return { path: `/v1/cameras/${at(requirement.id)}/snapshot`, query: { highQuality: "false" }, accept: "jpeg" };
    case "packageSnapshot":
      return { path: `/v1/cameras/${at(requirement.id)}/snapshot`, query: { highQuality: "false", channel: "package" }, accept: "jpeg" };
    case "devices": return { path: `/v1/sites/${at(requirement.siteId)}/devices`, query: first };
    case "clients": return { path: `/v1/sites/${at(requirement.siteId)}/clients`, query: first };
    case "networks": return { path: `/v1/sites/${at(requirement.siteId)}/networks`, query: first };
    case "wifiNetworks": return { path: `/v1/sites/${at(requirement.siteId)}/wifi/broadcasts`, query: first };
    case "vouchers": return { path: `/v1/sites/${at(requirement.siteId)}/hotspot/vouchers`, query: first };
    case "wifi": case "wifiPassword":
      return { path: `/v1/sites/${at(requirement.siteId)}/wifi/broadcasts/${at(requirement.wifiNetworkId)}` };
    case "device": return { path: `/v1/sites/${at(requirement.siteId)}/devices/${at(requirement.deviceId)}` };
    case "deviceStatistics":
      return { path: `/v1/sites/${at(requirement.siteId)}/devices/${at(requirement.deviceId)}/statistics/latest` };
    case "client": return { path: `/v1/sites/${at(requirement.siteId)}/clients/${at(requirement.clientId)}` };
  }
}

/**
 * Whether a successful probe's answer shows what the requirement needs, beyond the key being let
 * in: the application's information must carry the version a read returns; the NVR must be the one the binding read, not
 * one a console that has since replaced it at the same URL reports; and the WiFi settings must
 * include the password, which UniFi may leave out for a role that can't read it. Every answer must also parse as the read's would, an item answer naming
 * the same item: an empty or substituted one, from a proxy say, proves nothing.
 * @throws UnifiError for an answer that isn't what the endpoint returns, which proves nothing.
 */
export function probeConfirms(requirement: ProbedRequirement, body: unknown, app: UnifiApp): boolean {
  const page = <T>(what: string, parse: (item: unknown) => T): T[] => parseNetworkPage(body, what).data.map(parse);
  switch (requirement.kind) {
    case "app": return (app === "network" ? parseNetworkInfo(body) : parseProtectInfo(body)).applicationVersion !== "";
    case "list": protectList(body, requirement.id).forEach(listParser[requirement.id]); return true;
    case "nvr": return parseNvr(body).id === requirement.id;
    case "camera": return parseCamera(body).id === requirement.id;
    case "sensor": return parseSensor(body).id === requirement.id;
    case "light": return parseLight(body).id === requirement.id;
    case "snapshot": case "packageSnapshot":
      // The transport passes only a JPEG as bytes; anything else is no image at all.
      if (!(body instanceof ArrayBuffer) || body.byteLength === 0) throw unexpected("snapshot");
      return true;
    // A list answers by parsing as one, whatever it holds.
    case "devices": page("device list", parseDevice); return true;
    case "clients": page("client list", parseClient); return true;
    case "networks": page("network list", parseLanNetwork); return true;
    case "wifiNetworks": page("WiFi network list", parseWifiSummary); return true;
    case "vouchers": page("voucher list", parseVoucher); return true;
    case "wifi": return same(parseWifiInfo(body).id, requirement.wifiNetworkId);
    case "wifiPassword": return same(parseWifiInfo(body).id, requirement.wifiNetworkId) && (wifiPassphrase(body) ?? "") !== "";
    case "device": return same(parseDeviceDetails(body, []).id, requirement.deviceId);
    case "deviceStatistics": parseDeviceStatistics(body); return true;
    case "client": return same(parseClientDetails(body).id, requirement.clientId);
  }
}

/** Whether two IDs name the same item; UUIDs may be written in either case. */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const listParser: Record<"cameras" | "sensors" | "lights", (item: unknown) => unknown> = {
  cameras: parseCamera, sensors: parseSensor, lights: parseLight,
};

function protectList(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) throw unexpected(`${what} list`);
  return body;
}

function unexpected(what: string): UnifiError {
  return new UnifiError({ kind: "protocol", message: `UniFi returned an unexpected ${what}.` });
}
