// Response parsing: what agents see for each kind of UniFi object, and how unexpected shapes from
// newer or odder firmware degrade instead of breaking.

import { describe, expect, it } from "vitest";
import { UnifiError } from "../src/errors";
import {
  normalizeMac, parseCamera, parseClient, parseClientDetails, parseDevice, parseDeviceDetails,
  parseDeviceStatistics, parseLight, parseNvr, parseSensor, parseSiteManagerHost, parseVoucher,
  parseWifiInfo, parseWifiSummary, wifiPassphrase,
} from "../src/parse";
import {
  homeConsole, HOME, rawCamera, rawClient, rawDevice, rawLight, rawNvr, rawSensor, rawWifi, wifiOverview,
} from "./fake-unifi";

const home = homeConsole();
const site = home.network!.sites[0]!;

describe("devices", () => {
  it("summarizes a device, mapping features to roles", () => {
    const gateway = parseDevice(site.devices[0]!.overview);
    expect(gateway).toEqual({
      id: HOME.gatewayId, name: "UDM Pro", model: "UDMPRO", roles: ["gateway", "switch"], state: "online",
      macAddress: "70:a7:41:97:83:ed", ipAddress: "192.168.1.1", firmwareVersion: "4.3.21",
      firmwareUpdateAvailable: false,
    });
  });

  it("details ports with PoE, radios, and the uplink", () => {
    const sw = parseDeviceDetails(site.devices[1]!.details, ["switch"]);
    expect(sw.roles).toEqual(["switch"]);
    expect(sw.uplinkDeviceId).toBe(HOME.gatewayId);
    expect(sw.ports.map(p => [p.index, p.state, p.poe?.enabled ?? null])).toEqual([
      [1, "up", null], [2, "up", true], [3, "up", false], [4, "down", null],
    ]);
    expect(sw.ports[1]!.poe).toEqual({ enabled: true, supplying: true, standard: "802.3at" });
    expect(sw.ports[3]!.speedMbps).toBeNull();
    const ap = parseDeviceDetails(site.devices[2]!.details, ["accessPoint"]);
    expect(ap.radios).toEqual([
      { frequencyGHz: 2.4, channel: 6, channelWidthMHz: 20, standard: "802.11ax" },
      { frequencyGHz: 5, channel: 36, channelWidthMHz: 80, standard: "802.11ax" },
    ]);
    expect(ap.adoptedAt).toEqual(new Date("2026-01-02T03:04:05Z"));
  });

  it.each([
    ["ONLINE", "online"], ["OFFLINE", "offline"], ["GETTING_READY", "starting"], ["UPDATING", "updating"],
    ["PENDING_ADOPTION", "adopting"], ["CONNECTION_INTERRUPTED", "disconnected"], ["ISOLATED", "disconnected"],
    ["SOMETHING_NEW_IN_FIRMWARE_11", "unknown"],
  ])("maps state %s to %s", (raw, state) => {
    expect(parseDevice({ ...site.devices[0]!.overview, state: raw }).state).toBe(state);
  });

  it("reads statistics, with missing figures as null", () => {
    const stats = parseDeviceStatistics(site.devices[2]!.statistics);
    expect(stats).toMatchObject({ uptimeSeconds: 86_400, cpuPercent: 12.5, uplinkRxBitsPerSecond: 9_800_000 });
    expect(stats.radios).toEqual([{ frequencyGHz: 2.4, txRetriesPercent: 3.2 }, { frequencyGHz: 5, txRetriesPercent: 3.2 }]);
    expect(parseDeviceStatistics({ interfaces: {} })).toEqual({
      uptimeSeconds: null, cpuPercent: null, memoryPercent: null, uplinkRxBitsPerSecond: null,
      uplinkTxBitsPerSecond: null, radios: [], lastSeenAt: null,
    });
  });

  it("is a protocol error, not a crash, when a required field is missing", () => {
    const { name: _name, ...nameless } = site.devices[0]!.overview;
    expect(() => parseDevice(nameless)).toThrow(UnifiError);
    expect(() => parseDevice("not an object")).toThrow(/unexpected device/);
  });
});

describe("clients", () => {
  it("lists a guest with its authorization flag and others with none", () => {
    expect(parseClient(site.clients[0]!.overview)).toMatchObject({ name: "Work Laptop", type: "wired", guest: null });
    expect(parseClient(site.clients[2]!.overview)).toMatchObject({ name: "Visitor Pixel", guest: { authorized: false } });
  });

  it("details a guest's authorization", () => {
    const { details } = rawClient({
      id: "c", name: "Guest", type: "WIRELESS", mac: "AA-BB-CC-DD-EE-FF", ip: "10.0.0.2", uplinkDeviceId: HOME.apId,
      guest: { authorized: true, expiresAt: "2026-10-02T09:05:00Z" },
    });
    expect(parseClientDetails(details)).toMatchObject({
      macAddress: "aa:bb:cc:dd:ee:ff",
      guest: {
        authorized: true, method: "voucher", expiresAt: new Date("2026-10-02T09:05:00Z"), bytesUsed: 1500,
        dataLimitMB: null, downloadLimitKbps: null, uploadLimitKbps: null,
      },
    });
  });
});

describe("WiFi", () => {
  it("summarizes networks from the list's partial objects", () => {
    expect(parseWifiSummary(wifiOverview(site.wifi[1]!))).toEqual({
      id: HOME.guestWifiId, name: "Guest", enabled: true, security: "wpa2", frequenciesGHz: [2.4, 5],
      networkId: HOME.guestNetworkId, guestPortal: true, kind: "standard",
    });
    expect(parseWifiSummary(wifiOverview(site.wifi[0]!))).toMatchObject({ security: "wpa2/wpa3", networkId: null });
    // IoT-optimized networks list no bands; they are 2.4 GHz only.
    expect(parseWifiSummary(wifiOverview(site.wifi[2]!))).toMatchObject({ kind: "iot", frequenciesGHz: [2.4] });
  });

  it("reads full settings and the password only from details", () => {
    expect(parseWifiInfo(site.wifi[1]!)).toMatchObject({ hidden: false, clientIsolation: true });
    expect(wifiPassphrase(site.wifi[1]!)).toBe("welcome-guests");
    expect(wifiPassphrase(rawWifi({ id: "x", name: "Open", security: "OPEN" }))).toBeNull();
    expect(wifiPassphrase(rawWifi({ id: "x", name: "Corp", security: "WPA2_ENTERPRISE" }))).toBeNull();
  });
});

describe("vouchers", () => {
  it("reads a voucher", () => {
    expect(parseVoucher(site.vouchers[0]!)).toMatchObject({
      id: HOME.voucherId, code: "1234567890", note: "Book club", durationMinutes: 1440, guestLimit: 1, guestCount: 0,
      createdAt: new Date("2026-09-30T18:00:00Z"), expired: false, dataLimitMB: null,
    });
  });
});

describe("Protect", () => {
  it("reads a doorbell, including its screen", () => {
    const doorbell = parseCamera(rawCamera({
      id: "d", name: "Front Door", type: "G4 Doorbell Pro", mac: "F4E2C6000001", doorbell: true, packageCamera: true,
    }));
    expect(doorbell).toMatchObject({
      name: "Front Door", model: "G4 Doorbell Pro", macAddress: "f4:e2:c6:00:00:01", state: "connected",
      hasPackageCamera: true, hasSpeaker: true, statusLight: true, micVolume: 80,
      smartDetectTypes: ["person", "vehicle", "package"], enabledSmartDetectTypes: ["person", "package"],
      doorbellDisplay: { kind: "text", text: "Welcome", until: null }, activePatrol: null,
    });
  });

  it("reports no status light or volume for a camera without them, and no screen for a non-doorbell", () => {
    const camera = parseCamera(rawCamera({ id: "c", name: "Driveway", type: "G5 PTZ", mac: "F4E2C6000002", led: false, mic: false }));
    expect(camera).toMatchObject({ statusLight: null, micVolume: null, doorbellDisplay: null, hasMicrophone: false });
  });

  it("drops smart-detect types it doesn't know", () => {
    const raw = rawCamera({ id: "c", name: "Cam", type: "G6", mac: "F4E2C6000009" });
    raw.featureFlags.smartDetectTypes = ["person", "drone"];
    expect(parseCamera(raw).smartDetectTypes).toEqual(["person"]);
  });

  it("reads a sensor's readings and battery", () => {
    expect(parseSensor(rawSensor("s", "Garage Door", "F4E2C6000003", true))).toMatchObject({
      mountType: "door", isOpen: true, openChangedAt: new Date(1_727_784_000_000), temperatureC: 21.5,
      humidityPercent: 45, lightLux: 120, batteryPercent: 87, batteryLow: false, motionDetected: false,
    });
  });

  it("reads a floodlight", () => {
    expect(parseLight(rawLight("l", "Backyard", "F4E2C6000004", "cam"))).toMatchObject({
      isOn: false, forcedOn: false, mode: "motion", activeWhen: "dark", brightness: 3, pairedCameraId: "cam",
    });
  });

  it("reads the alarm from the NVR", () => {
    expect(parseNvr(rawNvr("n", "UDM Pro", "70A7419783ED", "armed")).alarm).toEqual({
      status: "armed", armedAt: new Date(1_727_780_000_000), breachDetectedAt: null,
    });
    expect(parseNvr(rawNvr("n", "UDM Pro", "70A7419783ED", "quantum")).alarm.status).toBe("unknown");
  });
});

describe("Site Manager hosts", () => {
  const host = {
    id: HOME.hostId, type: "console", owner: false,
    userData: {
      email: "dan@example.com", fullName: "Dan", role: "admin", controllers: ["network", "protect"],
      permissions: { "network.management": ["admin"], "protect.management": [] },
      consoleGroupMembers: [{ mac: "70A7419783ED" }],
    },
    reportedState: { name: "Home", controllers: [{ name: "network" }] },
  };

  it("reads a console's name, apps, permissions, and MACs", () => {
    expect(parseSiteManagerHost(host)).toEqual({
      id: HOME.hostId, name: "Home", owner: false,
      // reportedState lists what is installed, which wins over what userData says is supported.
      apps: { network: true, protect: false },
      permissions: { network: true, protect: false },
      macs: ["70:a7:41:97:83:ed"],
      email: "dan@example.com", fullName: "Dan",
    });
  });

  it("grants an owner every application", () => {
    expect(parseSiteManagerHost({ ...host, owner: true }).permissions).toEqual({ network: true, protect: true });
  });

  it("falls back to a name made from the MAC", () => {
    expect(parseSiteManagerHost({ id: HOME.hostId, reportedState: null }).name).toBe("Console 70A7419783ED");
  });
});

describe("MAC addresses", () => {
  it.each([["70A7419783ED", "70:a7:41:97:83:ed"], ["70-a7-41-97-83-ed", "70:a7:41:97:83:ed"], ["oops", "oops"]])(
    "normalizes %s", (raw, normalized) => {
      expect(normalizeMac(raw)).toBe(normalized);
    });
});

describe("devices without optional parts", () => {
  it("handles a device with neither ports nor radios", () => {
    const bare = rawDevice({ id: "x", name: "Bridge", model: "UBB", mac: "00:11:22:33:44:55", ip: "", roles: [] });
    expect(parseDeviceDetails(bare.details, [])).toMatchObject({ roles: [], ports: [], radios: [], ipAddress: null, uplinkDeviceId: null });
  });
});
