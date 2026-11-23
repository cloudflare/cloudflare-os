/**
 * What a read depends on, for observer verification. A read of general data reports the console
 * application it came from. A read of something UniFi controls access to more finely reports that
 * resource instead: a Protect device, which a role can limit a viewer to some of, and a WiFi
 * password or the hotspot's voucher codes, which not every role that can see a site may read.
 *
 * IDs are `console/<consoleId>/app/<network|protect>`, followed by `/camera/<id>`, `/sensor/<id>`
 * or `/light/<id>` in Protect, and `/site/<siteId>/wifi/<wifiNetworkId>` (its password) or
 * `/vouchers/<siteId>` (their codes) in Network. The console ID is the one in the binding's
 * resource URL, which never changes for a binding.
 *
 * Pure: imported by the Node tests.
 */

import { formatSubresourceId, parseSubresourceId, type SubresourceFragment } from "@gadgets/gatekeeper-kit/subresource-ids";
import { isValidId, resourceApp, type UnifiResource } from "./resources";
import type { UnifiApp } from "./transport";

/** One thing a read depends on, within the bound console's application. */
export type UnifiRequirement =
  | { kind: "app" }
  | { kind: "camera" | "sensor" | "light"; id: string }
  | { kind: "wifi"; siteId: string; wifiNetworkId: string }
  | { kind: "vouchers"; siteId: string };

/** The requirement a read of general data reports. */
export const APP: UnifiRequirement = { kind: "app" };

/** The subresource ID of `requirement` on the bound console's application. */
export function requirementId(resource: UnifiResource, requirement: UnifiRequirement): string {
  const fragments: SubresourceFragment[] = [
    { name: "console", id: resource.consoleId }, { name: "app", id: resourceApp(resource.kind) },
  ];
  switch (requirement.kind) {
    case "app": break;
    case "camera": case "sensor": case "light": fragments.push({ name: requirement.kind, id: requirement.id }); break;
    case "wifi": fragments.push({ name: "site", id: requirement.siteId }, { name: "wifi", id: requirement.wifiNetworkId }); break;
    case "vouchers": fragments.push({ name: "vouchers", id: requirement.siteId }); break;
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
  if (rest.length === 0) return APP;
  const [first, second] = rest;
  if (rest.length === 1 && (first!.name === "camera" || first!.name === "sensor" || first!.name === "light")) {
    return { kind: first!.name, id: first!.id };
  }
  if (rest.length === 1 && first!.name === "vouchers") return { kind: "vouchers", siteId: first!.id };
  if (rest.length === 2 && first!.name === "site" && second!.name === "wifi") {
    return { kind: "wifi", siteId: first!.id, wifiNetworkId: second!.id };
  }
  return null;
}

/** Whether a binding to `resource` reports `requirement`: nothing outside what it can read. */
function reports(resource: UnifiResource, requirement: UnifiRequirement): boolean {
  switch (resource.kind) {
    case "site":
      return requirement.kind === "app" ||
        (requirement.kind === "wifi" || requirement.kind === "vouchers") && requirement.siteId === resource.siteId;
    case "device": return requirement.kind === "app";
    case "wifi":
      return requirement.kind === "app" || requirement.kind === "wifi" &&
        requirement.siteId === resource.siteId && requirement.wifiNetworkId === resource.wifiNetworkId;
    case "hotspot":
      return requirement.kind === "app" || requirement.kind === "vouchers" && requirement.siteId === resource.siteId;
    case "protect":
      return requirement.kind === "app" || requirement.kind === "camera" || requirement.kind === "sensor" ||
        requirement.kind === "light";
    case "camera": return requirement.kind === "camera" && requirement.id === resource.cameraId;
    case "sensor": return requirement.kind === "sensor" && requirement.id === resource.sensorId;
    case "light": return requirement.kind === "light" && requirement.id === resource.lightId;
  }
}

/**
 * The request that shows whether a key may read what `requirement` covers: the same endpoint a
 * read of it calls, so a role that can't see a camera, or read a password, is refused there too.
 */
export function probeFor(app: UnifiApp, requirement: UnifiRequirement): { path: string; query?: Record<string, string> } {
  const at = encodeURIComponent;
  switch (requirement.kind) {
    case "app": return { path: app === "network" ? "/v1/info" : "/v1/meta/info" };
    case "camera": return { path: `/v1/cameras/${at(requirement.id)}` };
    case "sensor": return { path: `/v1/sensors/${at(requirement.id)}` };
    case "light": return { path: `/v1/lights/${at(requirement.id)}` };
    case "wifi": return { path: `/v1/sites/${at(requirement.siteId)}/wifi/broadcasts/${at(requirement.wifiNetworkId)}` };
    case "vouchers": return { path: `/v1/sites/${at(requirement.siteId)}/hotspot/vouchers`, query: { limit: "1" } };
  }
}
