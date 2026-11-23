/**
 * What a read depends on, for observer verification: the data it returned, named by the UniFi
 * endpoint a key needs to read that data. A collaborator passes only for what their own key can
 * read at the same endpoint, since UniFi roles differ in what they can see: a Network role can be
 * limited to some sites, and a Protect role to some cameras.
 *
 * IDs start `console/<consoleId>/app/<network|protect>`, the console ID being the one in the
 * binding's resource URL, which never changes for a binding. Then, in Network, a site's own details
 * are `/site/<siteId>`; its devices, clients, LAN networks, WiFi network list and voucher codes are
 * `/devices/<siteId>`, `/clients/<siteId>`, `/networks/<siteId>`, `/wifiNetworks/<siteId>` and
 * `/vouchers/<siteId>`; one WiFi network's settings, password included, are
 * `/site/<siteId>/wifi/<wifiNetworkId>`. In Protect, the NVR and its alarm are `/nvr/<id>`, each
 * device `/camera/<id>`, `/sensor/<id>` or `/light/<id>`, and the application alone, for a listing
 * that found nothing, has no suffix.
 *
 * Pure: imported by the Node tests.
 */

import { formatSubresourceId, parseSubresourceId, type SubresourceFragment } from "@gadgets/gatekeeper-kit/subresource-ids";
import { isValidId, resourceApp, type UnifiResource } from "./resources";
import type { UnifiApp } from "./transport";

/**
 * One thing a read depends on, within the bound console's application. A Protect requirement names
 * a device, a Network one a site (and, for a WiFi network's settings, the network).
 */
export type UnifiRequirement =
  | { kind: "app" }
  | { kind: "nvr"; id: string }
  | { kind: "camera"; id: string }
  | { kind: "sensor"; id: string }
  | { kind: "light"; id: string }
  | { kind: "site"; siteId: string }
  | { kind: "devices"; siteId: string }
  | { kind: "clients"; siteId: string }
  | { kind: "networks"; siteId: string }
  | { kind: "wifiNetworks"; siteId: string }
  | { kind: "vouchers"; siteId: string }
  | { kind: "wifi"; siteId: string; wifiNetworkId: string };

/** The parts of a Network site that UniFi serves from separate endpoints. */
const SITE_DATA = ["site", "devices", "clients", "networks", "wifiNetworks", "vouchers"] as const;
const PROTECT_DEVICES = ["nvr", "camera", "sensor", "light"] as const;

/** What a Protect listing that found nothing requires: the application. */
export const APP: UnifiRequirement = { kind: "app" };

/** The subresource ID of `requirement` on the bound console's application. */
export function requirementId(resource: UnifiResource, requirement: UnifiRequirement): string {
  const fragments: SubresourceFragment[] = [
    { name: "console", id: resource.consoleId }, { name: "app", id: resourceApp(resource.kind) },
  ];
  if (requirement.kind === "wifi") {
    fragments.push({ name: "site", id: requirement.siteId }, { name: "wifi", id: requirement.wifiNetworkId });
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
  if (!first) return APP;
  if (second) {
    return rest.length === 2 && first.name === "site" && second.name === "wifi"
      ? { kind: "wifi", siteId: first.id, wifiNetworkId: second.id } : null;
  }
  const name = first.name;
  if (isOneOf(name, PROTECT_DEVICES)) return { kind: name, id: first.id };
  if (isOneOf(name, SITE_DATA)) return { kind: name, siteId: first.id };
  return null;
}

function isOneOf<T extends string>(value: string, options: readonly T[]): value is T {
  return (options as readonly string[]).includes(value);
}

/** Whether a binding to `resource` reports `requirement`: nothing outside what it can read. */
function reports(resource: UnifiResource, requirement: UnifiRequirement): boolean {
  const inSite = "siteId" in resource && "siteId" in requirement && requirement.siteId === resource.siteId;
  switch (resource.kind) {
    case "site": return inSite;
    case "device": return inSite && (requirement.kind === "devices" || requirement.kind === "clients");
    case "wifi":
      return requirement.kind === "wifi" && inSite && requirement.wifiNetworkId === resource.wifiNetworkId;
    case "hotspot": return inSite && (requirement.kind === "clients" || requirement.kind === "vouchers");
    case "protect": return requirement.kind === "app" || isOneOf(requirement.kind, PROTECT_DEVICES);
    case "camera": return requirement.kind === "camera" && requirement.id === resource.cameraId;
    case "sensor": return requirement.kind === "sensor" && requirement.id === resource.sensorId;
    case "light": return requirement.kind === "light" && requirement.id === resource.lightId;
  }
}

/**
 * The request that shows whether a key may read what `requirement` covers: the endpoint a read of
 * it calls, so whatever a role is refused there is refused here. A site's details come from the
 * site list, which shows a key only its own sites, so that probe also needs the site in the answer
 * (`listsSite`).
 */
export function probeFor(app: UnifiApp, requirement: UnifiRequirement): {
  path: string; query?: Record<string, string>; listsSite?: string;
} {
  const at = encodeURIComponent;
  const first = { limit: "1" };
  switch (requirement.kind) {
    case "app": return { path: app === "network" ? "/v1/info" : "/v1/meta/info" };
    case "nvr": return { path: "/v1/nvrs" };
    case "camera": return { path: `/v1/cameras/${at(requirement.id)}` };
    case "sensor": return { path: `/v1/sensors/${at(requirement.id)}` };
    case "light": return { path: `/v1/lights/${at(requirement.id)}` };
    case "site": return { path: "/v1/sites", query: { limit: "200" }, listsSite: requirement.siteId };
    case "devices": return { path: `/v1/sites/${at(requirement.siteId)}/devices`, query: first };
    case "clients": return { path: `/v1/sites/${at(requirement.siteId)}/clients`, query: first };
    case "networks": return { path: `/v1/sites/${at(requirement.siteId)}/networks`, query: first };
    case "wifiNetworks": return { path: `/v1/sites/${at(requirement.siteId)}/wifi/broadcasts`, query: first };
    case "vouchers": return { path: `/v1/sites/${at(requirement.siteId)}/hotspot/vouchers`, query: first };
    case "wifi": return { path: `/v1/sites/${at(requirement.siteId)}/wifi/broadcasts/${at(requirement.wifiNetworkId)}` };
  }
}
