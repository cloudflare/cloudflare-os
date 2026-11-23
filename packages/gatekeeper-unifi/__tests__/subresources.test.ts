import { describe, expect, it } from "vitest";
import { parseRequirement, probeFor, requirementId, type UnifiRequirement } from "../src/subresources";
import type { UnifiResource } from "../src/resources";

const CONSOLE = "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302";
const SITE = "88f7af54-98f8-306a-a1c7-c9349722b1f6";
const OTHER_SITE = "88f7af54-98f8-306a-a1c7-c9349722b1f7";
const WIFI = "aa110000-0000-4000-8000-000000000002";
const CAMERA = "66d025b30096e903e4000500";
const NVR = "66d025b30096e903e4000000";

const site: UnifiResource = { kind: "site", consoleId: CONSOLE, siteId: SITE };
const device: UnifiResource = { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "d", clients: false };
const hotspot: UnifiResource = { kind: "hotspot", consoleId: CONSOLE, siteId: SITE };
const protect: UnifiResource = { kind: "protect", consoleId: CONSOLE };
const camera: UnifiResource = { kind: "camera", consoleId: CONSOLE, cameraId: CAMERA };
const NETWORK = `console/${encodeURIComponent(CONSOLE)}/app/network`;
const PROTECT = `console/${encodeURIComponent(CONSOLE)}/app/protect`;

describe("subresource IDs", () => {
  it.each<[UnifiResource, UnifiRequirement, string]>([
    [site, { kind: "site", siteId: SITE }, `${NETWORK}/site/${SITE}`],
    [site, { kind: "clients", siteId: SITE }, `${NETWORK}/clients/${SITE}`],
    [site, { kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }, `${NETWORK}/site/${SITE}/wifi/${WIFI}`],
    [device, { kind: "devices", siteId: SITE }, `${NETWORK}/devices/${SITE}`],
    [device, { kind: "device", siteId: SITE, deviceId: "d" }, `${NETWORK}/site/${SITE}/device/d`],
    [device, { kind: "deviceStatistics", siteId: SITE, deviceId: "d" }, `${NETWORK}/site/${SITE}/deviceStatistics/d`],
    [hotspot, { kind: "client", siteId: SITE, clientId: "c" }, `${NETWORK}/site/${SITE}/client/c`],
    [hotspot, { kind: "vouchers", siteId: SITE }, `${NETWORK}/vouchers/${SITE}`],
    [protect, { kind: "app" }, PROTECT],
    [protect, { kind: "nvr", id: NVR }, `${PROTECT}/nvr/${NVR}`],
    [protect, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
    [camera, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
  ])("spells and reads back what a binding reports", (resource, requirement, id) => {
    expect(requirementId(resource, requirement)).toBe(id);
    expect(parseRequirement(resource, id)).toEqual(requirement);
  });

  it.each<[string, UnifiResource, string]>([
    ["another application", site, PROTECT],
    ["the Network application alone, which no Network read reports", site, NETWORK],
    ["another console", site, `console/other/app/network/site/${SITE}`],
    ["another site's data", site, `${NETWORK}/devices/${OTHER_SITE}`],
    ["another site's password", site, `${NETWORK}/site/${OTHER_SITE}/wifi/${WIFI}`],
    ["voucher codes, from a device binding", device, `${NETWORK}/vouchers/${SITE}`],
    ["the site's devices, from a hotspot binding", hotspot, `${NETWORK}/devices/${SITE}`],
    ["another device's statistics, from a device binding", device, `${NETWORK}/site/${SITE}/deviceStatistics/e`],
    ["a client's details, from a device binding", device, `${NETWORK}/site/${SITE}/client/c`],
    ["another camera", camera, `${PROTECT}/camera/${CAMERA.replace("5", "6")}`],
    ["the NVR, from a camera binding", camera, `${PROTECT}/nvr/${NVR}`],
    ["a non-canonical spelling", site, `console/${CONSOLE}/app/network/site/${SITE}`],
    ["an unknown kind", protect, `${PROTECT}/doorlock/${CAMERA}`],
    ["the global requirement", site, "global"],
  ])("refuses %s", (_name, resource, id) => {
    expect(() => parseRequirement(resource, id)).toThrow(/isn't a subresource this UniFi binding reports/);
  });

  it("checks each requirement at the endpoint its read calls", () => {
    expect(probeFor("protect", { kind: "camera", id: CAMERA })).toEqual({ path: `/v1/cameras/${CAMERA}` });
    expect(probeFor("protect", { kind: "nvr", id: NVR })).toEqual({ path: "/v1/nvrs" });
    expect(probeFor("network", { kind: "clients", siteId: SITE })).toEqual({ path: `/v1/sites/${SITE}/clients`, query: { limit: "1" } });
    expect(probeFor("network", { kind: "deviceStatistics", siteId: SITE, deviceId: "d" }))
      .toEqual({ path: `/v1/sites/${SITE}/devices/d/statistics/latest` });
    expect(probeFor("network", { kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }))
      .toEqual({ path: `/v1/sites/${SITE}/wifi/broadcasts/${WIFI}` });
    // The site list shows a key only its own sites, so the site has to be in the answer.
    expect(probeFor("network", { kind: "site", siteId: SITE })).toEqual({ path: "/v1/sites", query: { limit: "200" }, listsSite: SITE });
  });
});
