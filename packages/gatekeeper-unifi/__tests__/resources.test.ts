// The resource URL grammar is the permanent identity of every grant, so its round trips, its
// refusals, and how the Workshop matches URLs to resource types are pinned here.

import { describe, expect, it } from "vitest";
import { matchesResourceUrlPattern, resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import {
  buildResourceUrl, isValidId, parseResourceUrl, resourceApp, resourceKindForPattern, UNIFI_RESOURCES,
  UNIFI_SUPPORTED_RESOURCES, UnifiResourceUrlError, type UnifiResource,
} from "../src/resources";

const CONSOLE = "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302";
const SITE = "88f7af54-98f8-306a-a1c7-c9349722b1f6";

const EXAMPLES: UnifiResource[] = [
  { kind: "site", consoleId: CONSOLE, siteId: SITE },
  { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "0f4c5f5a-1111", clients: false },
  { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "0f4c5f5a-1111", clients: true },
  { kind: "wifi", consoleId: CONSOLE, siteId: SITE, wifiNetworkId: "aa11" },
  { kind: "hotspot", consoleId: CONSOLE, siteId: SITE },
  { kind: "protect", consoleId: "local-0123456789abcdef" },
  { kind: "camera", consoleId: CONSOLE, cameraId: "66d025b30096e903e4000500" },
  { kind: "sensor", consoleId: CONSOLE, sensorId: "66d025b30096e903e4000600" },
  { kind: "light", consoleId: CONSOLE, lightId: "66d025b30096e903e4000700" },
];

describe("resource URLs", () => {
  it.each(EXAMPLES.map(resource => [resource.kind, resource] as const))("round-trip a %s", (_kind, resource) => {
    const url = buildResourceUrl(resource);
    expect(parseResourceUrl(url)).toEqual(resource);
    // The Workshop matches the URL to exactly this kind's pattern, and to no other.
    const matching = UNIFI_SUPPORTED_RESOURCES.filter(r => matchesResourceUrlPattern(r.urlPattern, url));
    expect(matching).toEqual([UNIFI_RESOURCES[resource.kind]]);
    expect(resolveRequestedResource(UNIFI_SUPPORTED_RESOURCES, url)).toEqual({ ok: true, resource: UNIFI_RESOURCES[resource.kind] });
  });

  it("keeps a host ID's colon unescaped, and accepts it escaped", () => {
    const url = buildResourceUrl({ kind: "protect", consoleId: CONSOLE });
    expect(url).toBe(`https://unifi.ui.com/consoles/${CONSOLE}/protect`);
    expect(parseResourceUrl(url.replace(":1261206302", "%3A1261206302"))).toEqual({ kind: "protect", consoleId: CONSOLE });
  });

  it("tolerates a trailing slash, as the Workshop's matcher does", () => {
    expect(parseResourceUrl(`https://unifi.ui.com/consoles/${CONSOLE}/network/sites/${SITE}/`))
      .toEqual({ kind: "site", consoleId: CONSOLE, siteId: SITE });
  });

  it("refuses an agent's `-` placeholder with a message about choosing", () => {
    expect(() => parseResourceUrl("https://unifi.ui.com/consoles/-/protect/cameras/-"))
      .toThrow(/doesn't say which console/);
    expect(() => parseResourceUrl(`https://unifi.ui.com/consoles/${CONSOLE}/network/sites/-`))
      .toThrow(/doesn't say which site/);
    // ... while the placeholder URL still selects the right resource type for the picker.
    expect(resolveRequestedResource(UNIFI_SUPPORTED_RESOURCES, "https://unifi.ui.com/consoles/-/protect/cameras/-"))
      .toEqual({ ok: true, resource: UNIFI_RESOURCES.camera });
  });

  it.each([
    ["another origin", `https://example.com/consoles/${CONSOLE}/protect`],
    ["an unknown application", `https://unifi.ui.com/consoles/${CONSOLE}/access`],
    ["an unknown sub-resource", `https://unifi.ui.com/consoles/${CONSOLE}/protect/chimes/abc`],
    ["extra segments", `https://unifi.ui.com/consoles/${CONSOLE}/protect/cameras/abc/def`],
    ["an ID with a slash smuggled in", `https://unifi.ui.com/consoles/${CONSOLE}/protect/cameras/a%2Fb`],
    ["not a URL", "unifi console"],
  ])("refuses %s", (_what, url) => {
    expect(() => parseResourceUrl(url)).toThrow(UnifiResourceUrlError);
  });

  it("names each kind's application and finds kinds by pattern", () => {
    expect(resourceApp("site")).toBe("network");
    expect(resourceApp("hotspot")).toBe("network");
    expect(resourceApp("camera")).toBe("protect");
    expect(resourceApp("light")).toBe("protect");
    for (const [kind, resource] of Object.entries(UNIFI_RESOURCES)) {
      expect(resourceKindForPattern(resource.urlPattern)).toBe(kind);
    }
    expect(resourceKindForPattern("https://*")).toBeNull();
  });

  it.each([
    `https://unifi.ui.com/consoles/${CONSOLE}/protect/cameras/%2E%2E`,
    `https://unifi.ui.com/consoles/${CONSOLE}/protect/cameras/../sensors/abc`,
    `https://unifi.ui.com/consoles/${CONSOLE}/protect/./cameras/abc`,
    `https://unifi.ui.com/consoles/${CONSOLE}/network/sites/abc/%2e/hotspot`,
  ])("refuses dot segments, which URL parsing would resolve into a broader resource: %s", url => {
    // The Workshop's matcher sees no resource in these at all; resolving them here would grant one.
    expect(() => parseResourceUrl(url)).toThrow(/`\.` or `\.\.` segments/);
  });

  it("refuses IDs made only of dots, which a path would resolve away", () => {
    expect(isValidId("..")).toBe(false);
    expect(isValidId(".")).toBe(false);
    expect(isValidId("-")).toBe(false);
    expect(isValidId("a.b")).toBe(true);
    expect(isValidId(CONSOLE)).toBe(true);
  });

  it("offers no whole-instance catch-all, so an agent must name a resource type", () => {
    expect(UNIFI_SUPPORTED_RESOURCES.some(r => r.urlPattern === "https://*")).toBe(false);
    expect(resolveRequestedResource(UNIFI_SUPPORTED_RESOURCES, undefined).ok).toBe(false);
  });
});
