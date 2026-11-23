import { describe, expect, it } from "vitest";
import { parseRequirement, probeFor, requirementId, type UnifiRequirement } from "../src/subresources";
import type { UnifiResource } from "../src/resources";

const CONSOLE = "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302";
const SITE = "88f7af54-98f8-306a-a1c7-c9349722b1f6";
const WIFI = "aa110000-0000-4000-8000-000000000002";
const CAMERA = "66d025b30096e903e4000500";

const site: UnifiResource = { kind: "site", consoleId: CONSOLE, siteId: SITE };
const protect: UnifiResource = { kind: "protect", consoleId: CONSOLE };
const camera: UnifiResource = { kind: "camera", consoleId: CONSOLE, cameraId: CAMERA };
const NETWORK = `console/${encodeURIComponent(CONSOLE)}/app/network`;
const PROTECT = `console/${encodeURIComponent(CONSOLE)}/app/protect`;

describe("subresource IDs", () => {
  it.each<[UnifiResource, UnifiRequirement, string]>([
    [site, { kind: "app" }, NETWORK],
    [site, { kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }, `${NETWORK}/site/${SITE}/wifi/${WIFI}`],
    [site, { kind: "vouchers", siteId: SITE }, `${NETWORK}/vouchers/${SITE}`],
    [protect, { kind: "app" }, PROTECT],
    [protect, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
    [camera, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
  ])("spells and reads back what a binding reports", (resource, requirement, id) => {
    expect(requirementId(resource, requirement)).toBe(id);
    expect(parseRequirement(resource, id)).toEqual(requirement);
  });

  it.each<[string, UnifiResource, string]>([
    ["another application", site, PROTECT],
    ["another console", site, `console/other/app/network`],
    ["another site's password", site, `${NETWORK}/site/${SITE.replace("8", "9")}/wifi/${WIFI}`],
    ["another camera", camera, `${PROTECT}/camera/${CAMERA.replace("5", "6")}`],
    ["the application, from a camera binding", camera, PROTECT],
    ["a requirement a device binding never reports", { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "d", clients: false }, `${NETWORK}/vouchers/${SITE}`],
    ["a non-canonical spelling", site, `console/${CONSOLE}/app/network`],
    ["an unknown kind", protect, `${PROTECT}/doorlock/${CAMERA}`],
    ["the global requirement", site, "global"],
  ])("refuses %s", (_name, resource, id) => {
    expect(() => parseRequirement(resource, id)).toThrow(/isn't a subresource this UniFi binding reports/);
  });

  it("checks each requirement at the endpoint its read calls", () => {
    expect(probeFor("protect", { kind: "camera", id: CAMERA })).toEqual({ path: `/v1/cameras/${CAMERA}` });
    expect(probeFor("network", { kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }))
      .toEqual({ path: `/v1/sites/${SITE}/wifi/broadcasts/${WIFI}` });
    expect(probeFor("network", { kind: "app" })).toEqual({ path: "/v1/info" });
  });
});
