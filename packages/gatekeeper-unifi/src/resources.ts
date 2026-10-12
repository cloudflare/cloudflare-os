/**
 * The resource URL grammar: one `SupportedResource` per grantable kind, and the parser and builder
 * that map between a resource URL and the resource it names. The URL patterns are permanent
 * identity -- blueprints record them -- so they never change once shipped; add new ones instead.
 *
 * The URLs live under `https://unifi.ui.com/consoles/...` whatever the connection's mode. They are
 * identifiers rather than links: a cloud connection's console ID is its Site Manager host ID, and a
 * direct connection's is one generated when it connected. `-` stands in for an ID an agent doesn't
 * know, which the resource picker then asks the user for; it never resolves to a resource.
 *
 * Pure: imported by the Node tests, and mirrored by every configurator module, which can't import
 * it (see `__tests__/configurator-url.test.ts`).
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** The origin every resource URL uses. */
export const UNIFI_RESOURCE_ORIGIN = "https://unifi.ui.com";

/** A resource a binding can be granted, as parsed from its URL. */
export type UnifiResource =
  | { kind: "site"; consoleId: string; siteId: string }
  | { kind: "device"; consoleId: string; siteId: string; deviceId: string; clients: boolean }
  | { kind: "wifi"; consoleId: string; siteId: string; wifiNetworkId: string }
  | { kind: "hotspot"; consoleId: string; siteId: string }
  | { kind: "protect"; consoleId: string }
  | { kind: "camera"; consoleId: string; cameraId: string }
  | { kind: "sensor"; consoleId: string; sensorId: string }
  | { kind: "light"; consoleId: string; lightId: string };

/** The kinds of resource, which name the `SupportedResource` each URL pattern belongs to. */
export type UnifiResourceKind = UnifiResource["kind"];

/** Which UniFi application serves a resource kind. */
export function resourceApp(kind: UnifiResourceKind): "network" | "protect" {
  return kind === "protect" || kind === "camera" || kind === "sensor" || kind === "light"
    ? "protect" : "network";
}

const SITE_PATH = "/consoles/:consoleId/network/sites/:siteId";
const PROTECT_PATH = "/consoles/:consoleId/protect";
const PLACEHOLDER_HINT = "Use `-` for an ID you don't know, and the user will choose it.";

/** Every grantable resource kind, keyed by kind. */
export const UNIFI_RESOURCES: Record<UnifiResourceKind, SupportedResource> = {
  site: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${SITE_PATH}`,
    title: "UniFi Network Site",
    description:
      "A UniFi Network site: its gateway, switches, access points, WiFi networks and their " +
      "passwords, connected clients, and guest hotspot. Restarts, guest access, and WiFi changes " +
      "need your approval. " +
      PLACEHOLDER_HINT,
  },
  device: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${SITE_PATH}/devices/:deviceId`,
    title: "UniFi Device",
    description:
      "One UniFi gateway, switch, or access point: its status, ports, and statistics, and with " +
      "your approval restarting it or power-cycling a PoE port. Add `?clients=1` to also ask for " +
      "the clients connected through it. " + PLACEHOLDER_HINT,
  },
  wifi: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${SITE_PATH}/wifi/:wifiNetworkId`,
    title: "UniFi WiFi Network",
    description:
      "One WiFi network (SSID): its settings and password, and with your approval changing its " +
      "name, password, or visibility, or turning it on or off. " + PLACEHOLDER_HINT,
  },
  hotspot: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${SITE_PATH}/hotspot`,
    title: "UniFi Guest Hotspot",
    description:
      "A site's guest hotspot only: listing and creating guest vouchers and managing guests' " +
      "access, without seeing the site's devices or other clients. " + PLACEHOLDER_HINT,
  },
  protect: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${PROTECT_PATH}`,
    title: "UniFi Protect",
    description:
      "Everything in UniFi Protect on one console: cameras and their snapshots, doorbells, " +
      "sensors, floodlights, and the alarm's state. Settings changes need your approval. " +
      PLACEHOLDER_HINT,
  },
  camera: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${PROTECT_PATH}/cameras/:cameraId`,
    title: "UniFi Camera",
    description:
      "One UniFi Protect camera or doorbell: its snapshots and settings, and with your approval " +
      "its status light, doorbell message, and PTZ position. " + PLACEHOLDER_HINT,
  },
  sensor: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${PROTECT_PATH}/sensors/:sensorId`,
    title: "UniFi Sensor",
    description:
      "One UniFi Protect sensor's readings: open or closed, motion, temperature, humidity, light, " +
      "leaks, and alarms. " + PLACEHOLDER_HINT,
  },
  light: {
    urlPattern: `${UNIFI_RESOURCE_ORIGIN}${PROTECT_PATH}/lights/:lightId`,
    title: "UniFi Floodlight",
    description:
      "One UniFi Protect floodlight: its state, and with your approval turning it on or off and " +
      "changing its mode and brightness. " + PLACEHOLDER_HINT,
  },
};

/** Every grantable resource, in the order the Workshop lists them. */
export const UNIFI_SUPPORTED_RESOURCES: SupportedResource[] = [
  UNIFI_RESOURCES.site,
  UNIFI_RESOURCES.device,
  UNIFI_RESOURCES.wifi,
  UNIFI_RESOURCES.hotspot,
  UNIFI_RESOURCES.protect,
  UNIFI_RESOURCES.camera,
  UNIFI_RESOURCES.sensor,
  UNIFI_RESOURCES.light,
];

/** The resource kind whose `SupportedResource` has `urlPattern`, or null. */
export function resourceKindForPattern(urlPattern: string): UnifiResourceKind | null {
  for (const [kind, resource] of Object.entries(UNIFI_RESOURCES)) {
    if (resource.urlPattern === urlPattern) return kind as UnifiResourceKind;
  }
  return null;
}

/** A resource URL that names no resource; its message is meant for the agent or user. */
export class UnifiResourceUrlError extends Error {
  override name = "UnifiResourceUrlError";
}

/**
 * Characters an ID may contain: Site Manager host IDs are hex with one colon. An ID made only of
 * dots is refused, since as a path segment it would climb out of where it was put.
 */
const ID_PATTERN = /^(?!\.+$)[A-Za-z0-9:._~-]{1,200}$/;

/**
 * Parses a resource URL.
 * @param url A URL matching one of `UNIFI_RESOURCES`' patterns.
 * @returns The resource it names.
 * @throws UnifiResourceUrlError if it names none, or uses `-` for an unknown ID.
 */
export function parseResourceUrl(url: string): UnifiResource {
  // URL parsing would resolve a dot segment -- `..` or `%2E%2E` -- into a different, broader
  // resource than the text names, where the Workshop's own matcher sees no resource at all.
  if (/(^|\/)(\.|%2e){1,2}(\/|$|[?#])/i.test(url.replace(/^[a-z]+:\/\/[^/]*/i, ""))) {
    throw new UnifiResourceUrlError("UniFi resource URLs can't contain `.` or `..` segments.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnifiResourceUrlError(`Not a URL: ${JSON.stringify(url)}`);
  }
  if (parsed.origin !== UNIFI_RESOURCE_ORIGIN) {
    throw new UnifiResourceUrlError(`UniFi resource URLs start with ${UNIFI_RESOURCE_ORIGIN}.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeSegment);
  const [consoles, consoleId, app, ...rest] = segments;
  if (consoles !== "consoles" || consoleId === undefined) throw unrecognized();
  if (app === "network") {
    const [sites, siteId, sub, subId, ...extra] = rest;
    if (sites !== "sites" || siteId === undefined) throw unrecognized();
    const site = { consoleId: id(consoleId, "console"), siteId: id(siteId, "site") };
    if (sub === undefined) return { kind: "site", ...site };
    if (sub === "hotspot" && subId === undefined) return { kind: "hotspot", ...site };
    if (subId === undefined || extra.length > 0) throw unrecognized();
    if (sub === "devices") {
      return {
        kind: "device", ...site, deviceId: id(subId, "device"),
        clients: parsed.searchParams.get("clients") === "1",
      };
    }
    if (sub === "wifi") return { kind: "wifi", ...site, wifiNetworkId: id(subId, "WiFi network") };
    throw unrecognized();
  }
  if (app === "protect") {
    const console = id(consoleId, "console");
    const [sub, subId, ...extra] = rest;
    if (sub === undefined) return { kind: "protect", consoleId: console };
    if (subId === undefined || extra.length > 0) throw unrecognized();
    if (sub === "cameras") return { kind: "camera", consoleId: console, cameraId: id(subId, "camera") };
    if (sub === "sensors") return { kind: "sensor", consoleId: console, sensorId: id(subId, "sensor") };
    if (sub === "lights") return { kind: "light", consoleId: console, lightId: id(subId, "floodlight") };
  }
  throw unrecognized();
}

/**
 * Builds the URL of a resource, the inverse of `parseResourceUrl`.
 * @param resource The resource.
 * @returns Its resource URL.
 */
export function buildResourceUrl(resource: UnifiResource): string {
  const consolePath = `${UNIFI_RESOURCE_ORIGIN}/consoles/${encodeSegment(resource.consoleId)}`;
  switch (resource.kind) {
    case "site":
      return `${consolePath}/network/sites/${encodeSegment(resource.siteId)}`;
    case "device":
      return `${consolePath}/network/sites/${encodeSegment(resource.siteId)}` +
        `/devices/${encodeSegment(resource.deviceId)}${resource.clients ? "?clients=1" : ""}`;
    case "wifi":
      return `${consolePath}/network/sites/${encodeSegment(resource.siteId)}` +
        `/wifi/${encodeSegment(resource.wifiNetworkId)}`;
    case "hotspot":
      return `${consolePath}/network/sites/${encodeSegment(resource.siteId)}/hotspot`;
    case "protect":
      return `${consolePath}/protect`;
    case "camera":
      return `${consolePath}/protect/cameras/${encodeSegment(resource.cameraId)}`;
    case "sensor":
      return `${consolePath}/protect/sensors/${encodeSegment(resource.sensorId)}`;
    case "light":
      return `${consolePath}/protect/lights/${encodeSegment(resource.lightId)}`;
  }
}

/** Whether `value` is safe to use as an ID in a resource URL and an API path. */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value) && value !== "-";
}

function id(value: string, what: string): string {
  if (value === "-") {
    throw new UnifiResourceUrlError(
      `This URL doesn't say which ${what} to use; choose one when connecting.`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new UnifiResourceUrlError(`That isn't a valid UniFi ${what} ID: ${JSON.stringify(value)}`);
  }
  return value;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new UnifiResourceUrlError("This URL has a malformed escape sequence.");
  }
}

// Colons are left as they are: Site Manager host IDs contain one, and a path segment may.
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":");
}

function unrecognized(): UnifiResourceUrlError {
  const patterns = UNIFI_SUPPORTED_RESOURCES.map(resource => `  * ${resource.urlPattern}`).join("\n");
  return new UnifiResourceUrlError(
    `That isn't a UniFi resource URL. UniFi resource URLs look like:\n${patterns}`);
}
