import { describe, expect, it } from "vitest";
import { parseRequirement, probeConfirms, probeFor, requirementId, type UnifiRequirement } from "../src/subresources";
import type { UnifiResource } from "../src/resources";
import { rawNvr } from "./fake-unifi";

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
const voucherPage = (vouchers: object[]) =>
  ({ offset: 0, limit: 1, count: vouchers.length, totalCount: vouchers.length, data: vouchers.map(v => ({ id: SITE, ...v })) });
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
    [hotspot, { kind: "voucherCodes", siteId: SITE }, `${NETWORK}/voucherCodes/${SITE}`],
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
    // A voucher list must be one, and for codes, carry them.
    const codes = { kind: "voucherCodes", siteId: SITE } as const;
    expect(probeConfirms(codes, voucherPage([{ code: "1234567890" }]), "network")).toBe(true);
    expect(probeConfirms(codes, voucherPage([{}]), "network")).toBe(false);
    expect(probeConfirms(codes, voucherPage([]), "network")).toBe(false);
    expect(probeConfirms({ kind: "vouchers", siteId: SITE }, voucherPage([]), "network")).toBe(true);
    expect(() => probeConfirms({ kind: "vouchers", siteId: SITE }, undefined, "network")).toThrow();
    // The NVR must be the one the binding read, not a replacement's at the same URL.
    expect(probeConfirms({ kind: "nvr", id: NVR }, nvr(NVR), "protect")).toBe(true);
    expect(probeConfirms({ kind: "nvr", id: NVR }, nvr(CAMERA), "protect")).toBe(false);
    // Settings that leave the password out don't show it can be read.
    const wifi = (security: object) => ({ id: WIFI, name: "Guest", securityConfiguration: security });
    const password = { kind: "wifiPassword", siteId: SITE, wifiNetworkId: WIFI } as const;
    expect(probeConfirms(password, wifi({ type: "WPA2_PERSONAL", passphrase: "secret-pass" }), "network")).toBe(true);
    expect(probeConfirms(password, wifi({ type: "WPA2_PERSONAL" }), "network")).toBe(false);
    expect(probeConfirms({ kind: "wifi", siteId: SITE, wifiNetworkId: WIFI }, wifi({ type: "WPA2_PERSONAL" }), "network")).toBe(true);
    // The application's information must carry its version; an empty or unrelated answer proves nothing.
    expect(probeConfirms({ kind: "app" }, { applicationVersion: "10.0.160" }, "network")).toBe(true);
    expect(() => probeConfirms({ kind: "app" }, undefined, "network")).toThrow();
    expect(() => probeConfirms({ kind: "app" }, { hello: "proxy" }, "protect")).toThrow();
  });
});
