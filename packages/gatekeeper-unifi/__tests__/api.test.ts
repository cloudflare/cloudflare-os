// The typed API client against the fake console: what each call requests, what it returns, how it
// pages, and how it refuses IDs that could escape their place.

import { describe, expect, it } from "vitest";
import { MAX_LIST_ITEMS, UnifiApi } from "../src/api";
import { cameraPatch, guestLimitsBody, wifiPutBody } from "../src/actions";
import { sendUnifiRequest, type UnifiCredentials } from "../src/transport";
import { FakeUnifi, HOME, homeConsole, rawClient, SNAPSHOT_BYTES } from "./fake-unifi";

const CLOUD: UnifiCredentials = { mode: "cloud", apiKey: "cloud-key-0123456789abcdef" };

function setup() {
  const unifi = new FakeUnifi();
  const console = homeConsole();
  unifi.addCloudKey(CLOUD.apiKey, { email: "dan@example.com", fullName: "Dan", owned: [console] });
  const api = new UnifiApi(request => sendUnifiRequest(CLOUD, request, unifi.fetch), HOME.hostId);
  return { unifi, console, api };
}

describe("reads", () => {
  it("reads a site's devices, clients, networks, WiFi, and vouchers", async () => {
    const { api } = setup();
    expect((await api.listSites()).map(s => s.name)).toEqual(["Default"]);
    expect((await api.listDevices(HOME.siteId)).map(d => d.name)).toEqual(["UDM Pro", "Garage Switch", "Living Room AP"]);
    expect((await api.listClients(HOME.siteId)).map(c => c.name)).toEqual(["Work Laptop", "Dan's iPhone", "Visitor Pixel"]);
    expect((await api.listLanNetworks(HOME.siteId)).map(n => n.vlanId)).toEqual([1, 20]);
    expect((await api.listWifiNetworks(HOME.siteId)).map(w => w.name)).toEqual(["Home", "Guest", "Things"]);
    expect((await api.listVouchers(HOME.siteId)).map(v => v.code)).toEqual(["1234567890"]);
    expect((await api.getDevice(HOME.siteId, HOME.switchId)).ports).toHaveLength(4);
    expect((await api.getDeviceStatistics(HOME.siteId, HOME.apId)).cpuPercent).toBe(12.5);
  });

  it("says a gateway is one, which only the device list reports", async () => {
    const { api, console } = setup();
    const gateway = console.network!.sites[0]!.devices[0]!;
    expect(Object.keys(gateway.details.features as object)).not.toContain("gateway");
    expect((await api.getDevice(HOME.siteId, HOME.gatewayId)).roles).toEqual(["gateway", "switch"]);
    expect((await api.getDevice(HOME.siteId, HOME.apId)).roles).toEqual(["accessPoint"]);
  });

  it("treats a device missing from the site's device list as not there", async () => {
    const { api, console } = setup();
    const site = console.network!.sites[0]!;
    // Its details still answer, as a device being removed might, but the list no longer has it.
    const handle = console.handle.bind(console);
    console.handle = (app, method, path, query, body) => {
      if (!path.endsWith("/devices")) return handle(app, method, path, query, body);
      const all = site.devices;
      site.devices = all.filter(device => device.overview.id !== HOME.apId);
      try {
        return handle(app, method, path, query, body);
      } finally {
        site.devices = all;
      }
    };
    await expect(api.getDevice(HOME.siteId, HOME.apId)).rejects.toMatchObject({ kind: "notFound" });
  });

  it("narrows clients with a filter", async () => {
    const { api, console } = setup();
    expect((await api.listClients(HOME.siteId, "access.type.eq('GUEST')")).map(c => c.name)).toEqual(["Visitor Pixel"]);
    expect(console.calls.at(-1)!.query.filter).toBe("access.type.eq('GUEST')");
  });

  it("pages through long lists, and stops at the documented bound", async () => {
    const { api, console } = setup();
    const site = console.network!.sites[0]!;
    site.clients = Array.from({ length: 1300 }, (_, i) =>
      rawClient({ id: `c-${i}`, name: `Client ${i}`, type: "WIRED", mac: "aa:bb:cc:00:00:00", ip: "10.0.0.1", uplinkDeviceId: HOME.switchId }));
    const clients = await api.listClients(HOME.siteId);
    expect(clients).toHaveLength(MAX_LIST_ITEMS);
    expect(console.calls.filter(c => c.path.endsWith("/clients")).map(c => c.query.offset)).toEqual(["0", "200", "400", "600", "800"]);
  });

  it("reads Protect cameras, sensors, floodlights, the NVR, and a snapshot", async () => {
    const { api } = setup();
    expect((await api.listCameras()).map(c => c.name)).toEqual(["Front Door", "Driveway"]);
    expect((await api.listSensors()).map(s => s.isOpen)).toEqual([false]);
    expect((await api.listLights()).map(l => l.mode)).toEqual(["motion"]);
    expect((await api.getNvr()).alarm.status).toBe("disabled");
    const snapshot = await api.snapshot(HOME.doorbellId, { highQuality: true, packageCamera: true });
    expect(new Uint8Array(snapshot.bytes)).toEqual(SNAPSHOT_BYTES);
  });

  it("explains an offline camera's snapshot failure", async () => {
    const { api, console } = setup();
    console.protect!.cameras[0]!.state = "DISCONNECTED";
    await expect(api.snapshot(HOME.doorbellId, { highQuality: false, packageCamera: false }))
      .rejects.toThrow("The camera is offline or not reachable.");
  });

  it("refuses IDs that aren't IDs before anything is requested", async () => {
    const { api, unifi } = setup();
    await expect(api.getDevice(HOME.siteId, "..")).rejects.toMatchObject({ kind: "badRequest" });
    await expect(api.getCamera("a/b")).rejects.toMatchObject({ kind: "badRequest" });
    await expect(api.getSite("-")).rejects.toMatchObject({ kind: "badRequest" });
    expect(unifi.calls).toHaveLength(0);
  });
});

describe("request bodies", () => {
  it("names guest limits as the Network API does", () => {
    expect(guestLimitsBody({ durationMinutes: 60, dataLimitMB: 100, downloadLimitKbps: 2000, uploadLimitKbps: 500 }))
      .toEqual({ timeLimitMinutes: 60, dataUsageLimitMBytes: 100, rxRateLimitKbps: 2000, txRateLimitKbps: 500 });
    expect(guestLimitsBody({})).toEqual({});
  });

  it("builds a WiFi update from the full settings, without the read-only fields", () => {
    const raw = homeConsole().network!.sites[0]!.wifi[1]!;
    const body = wifiPutBody(raw, { name: "Visitors", enabled: false, hidden: true, passphrase: "brand-new-pass" });
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("metadata");
    expect(body).toMatchObject({ name: "Visitors", enabled: false, hideName: true, clientIsolationEnabled: true });
    expect(body.securityConfiguration).toMatchObject({ type: "WPA2_PERSONAL", passphrase: "brand-new-pass", pmfMode: "OPTIONAL" });
  });

  it("refuses a password for a network that has none", () => {
    const raw = { ...homeConsole().network!.sites[0]!.wifi[1]!, securityConfiguration: { type: "WPA2_ENTERPRISE" } };
    expect(() => wifiPutBody(raw, { passphrase: "brand-new-pass" })).toThrow(/WPA2 or WPA3 Personal/);
  });

  it("leaves a doorbell message's reset time out unless one was given, since null means forever", () => {
    expect(cameraPatch({ doorbellMessage: { kind: "doNotDisturb" }, until: null }))
      .toEqual({ lcdMessage: { type: "DO_NOT_DISTURB" } });
    expect(cameraPatch({ doorbellMessage: { kind: "text", text: "Back soon" }, until: 1_900_000_000_000 }))
      .toEqual({ lcdMessage: { type: "CUSTOM_MESSAGE", text: "Back soon", resetAt: 1_900_000_000_000 } });
  });
});
