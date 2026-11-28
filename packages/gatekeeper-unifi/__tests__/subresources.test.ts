import { describe, expect, it } from "vitest";
import { parseRequirement, probeConfirms, probeFor, requirementId, type UnifiRequirement } from "../src/subresources";
import type { UnifiResource } from "../src/resources";
import { homeConsole, rawNvr } from "./fake-unifi";

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

/** A page of the voucher list as the Network API returns it. */
const voucherPage = (vouchers: object[]) => ({ offset: 0, limit: 1, count: vouchers.length, totalCount: vouchers.length, data: vouchers });
const nvr = (id: string) => rawNvr(id, "NVR", "70A7419783ED");

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
    [hotspot, { kind: "voucherCode", siteId: SITE, voucherId: "v" }, `${NETWORK}/site/${SITE}/voucherCode/v`],
    [protect, { kind: "list", id: "cameras" }, `${PROTECT}/list/cameras`],
    [protect, { kind: "app" }, PROTECT],
    [site, { kind: "app" }, NETWORK],
    [site, { kind: "wifiPassword", siteId: SITE, wifiNetworkId: WIFI }, `${NETWORK}/site/${SITE}/wifiPassword/${WIFI}`],
    [protect, { kind: "nvr", id: NVR }, `${PROTECT}/nvr/${NVR}`],
    [protect, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
    [camera, { kind: "camera", id: CAMERA }, `${PROTECT}/camera/${CAMERA}`],
  ])("spells and reads back what a binding reports", (resource, requirement, id) => {
    expect(requirementId(resource, requirement)).toBe(id);
    expect(parseRequirement(resource, id)).toEqual(requirement);
  });

  it.each<[string, UnifiResource, string]>([
    ["another application", site, PROTECT],
    ["the application, from a device binding", device, NETWORK],
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
    ["an unknown list", protect, `${PROTECT}/list/doorlocks`],
    ["the global requirement", site, "global"],
  ])("refuses %s", (_name, resource, id) => {
    expect(() => parseRequirement(resource, id)).toThrow(/isn't a subresource this UniFi binding reports/);
  });

  it("checks each requirement at the endpoint its read calls", () => {
    expect(probeFor({ kind: "camera", id: CAMERA }, "protect")).toEqual({ path: `/v1/cameras/${CAMERA}` });
    expect(probeFor({ kind: "nvr", id: NVR }, "protect")).toEqual({ path: "/v1/nvrs" });
    expect(probeFor({ kind: "clients", siteId: SITE }, "network")).toEqual({ path: `/v1/sites/${SITE}/clients`, query: { limit: "1" } });
    expect(probeFor({ kind: "deviceStatistics", siteId: SITE, deviceId: "d" }, "network"))
      .toEqual({ path: `/v1/sites/${SITE}/devices/d/statistics/latest` });
    expect(probeFor({ kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }, "network"))
      .toEqual({ path: `/v1/sites/${SITE}/wifi/broadcasts/${WIFI}` });
    expect(probeFor({ kind: "list", id: "cameras" }, "protect")).toEqual({ path: "/v1/cameras" });
    expect(probeFor({ kind: "app" }, "protect")).toEqual({ path: "/v1/meta/info" });
  });

  it("passes a probe only when its answer shows what the requirement needs", () => {
    const home = homeConsole();
    const { wifi, vouchers } = home.network!.sites[0]!;
    const guestWifi = wifi.find(w => w.id === WIFI)!;
    const doorbell = home.protect!.cameras[0]!;
    // The NVR must be the one the binding read, not a replacement's at the same URL.
    expect(probeConfirms({ kind: "nvr", id: NVR }, nvr(NVR), "protect")).toBe(true);
    expect(probeConfirms({ kind: "nvr", id: NVR }, nvr(CAMERA), "protect")).toBe(false);
    // An item answer must name the same item, in either case for a UUID.
    expect(probeConfirms({ kind: "camera", id: doorbell.id as string }, doorbell, "protect")).toBe(true);
    expect(probeConfirms({ kind: "camera", id: "66d025b30096e903e4000599" }, doorbell, "protect")).toBe(false);
    expect(probeConfirms({ kind: "wifi", siteId: SITE, wifiNetworkId: WIFI.toUpperCase() }, guestWifi, "network")).toBe(true);
    // Settings that leave the password out don't show it can be read.
    const password = { kind: "wifiPassword", siteId: SITE, wifiNetworkId: WIFI } as const;
    expect(probeConfirms(password, guestWifi, "network")).toBe(true);
    const withoutPassword = { ...guestWifi, securityConfiguration: { type: "WPA2_PERSONAL" } };
    expect(probeConfirms(password, withoutPassword, "network")).toBe(false);
    // A voucher list must be one.
    expect(probeConfirms({ kind: "vouchers", siteId: SITE }, voucherPage(vouchers), "network")).toBe(true);
    expect(probeConfirms({ kind: "vouchers", siteId: SITE }, voucherPage([]), "network")).toBe(true);
    // The application's information must carry its version.
    expect(probeConfirms({ kind: "app" }, { applicationVersion: "10.0.160" }, "network")).toBe(true);
    // An empty or substituted answer, from a proxy say, proves nothing either way.
    for (const requirement of [
      { kind: "app" }, { kind: "camera", id: CAMERA }, { kind: "list", id: "cameras" }, { kind: "vouchers", siteId: SITE },
      { kind: "snapshot", id: CAMERA }, { kind: "client", siteId: SITE, clientId: "c" },
      { kind: "deviceStatistics", siteId: SITE, deviceId: "d" },
    ] as const) {
      expect(() => probeConfirms(requirement, undefined, "protect"), requirement.kind).toThrow();
      expect(() => probeConfirms(requirement, { hello: "proxy" }, "protect"), requirement.kind).toThrow();
    }
    expect(probeConfirms({ kind: "snapshot", id: CAMERA }, new Uint8Array([0xff, 0xd8, 0xff]).buffer, "protect")).toBe(true);
  });
});
