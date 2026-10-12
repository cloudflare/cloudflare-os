// Simulation: reads show pending actions as if they had already been carried out, scoped to the
// item each action targets, in submission order.

import { describe, expect, it } from "vitest";
import type { UnifiAction } from "../src/actions";
import { parseCamera, parseClient, parseClientDetails, parseLight, parseVoucher, parseWifiInfo, parseWifiSummary, wifiPassphrase } from "../src/parse";
import {
  isPlaceholderVoucherId, simulateCamera, simulateClientDetails, simulateClients, simulateLight,
  simulatePassphrase, simulateVouchers, simulateWifiInfo, simulateWifiSummaries, type PendingAction,
} from "../src/simulation";
import { HOME, homeConsole, wifiOverview } from "./fake-unifi";

const site = homeConsole().network!.sites[0]!;
const protect = homeConsole().protect!;
const NOW = Date.parse("2026-10-01T12:00:00Z");

function pending(...actions: UnifiAction[]): PendingAction[] {
  return actions.map((action, i) => ({ id: i + 1, action }));
}

describe("guest access", () => {
  const guest = site.clients[2]!;
  const authorize: UnifiAction = {
    kind: "guestAccess",
    payload: { siteId: HOME.siteId, clientId: HOME.guestId, clientName: "Visitor Pixel", change: { authorize: true, limits: { durationMinutes: 60, dataLimitMB: 500 } } },
  };

  it("shows a pending authorization in lists and details", () => {
    const listed = simulateClients(site.clients.map(c => parseClient(c.overview)), HOME.siteId, pending(authorize));
    expect(listed.find(c => c.id === HOME.guestId)!.guest).toEqual({ authorized: true });
    expect(listed.find(c => c.id === HOME.laptopId)!.guest).toBeNull();

    const details = simulateClientDetails(parseClientDetails(guest.details), HOME.siteId, pending(authorize), NOW);
    expect(details.guest).toEqual({
      authorized: true, method: "api", authorizedAt: new Date(NOW), expiresAt: new Date(NOW + 60 * 60_000),
      dataLimitMB: 500, downloadLimitKbps: null, uploadLimitKbps: null, bytesUsed: 0,
    });
  });

  it("applies the latest change last, and ignores other sites", () => {
    const revoke: UnifiAction = { kind: "guestAccess", payload: { ...authorize.payload, change: { authorize: false } } } as UnifiAction;
    const details = simulateClientDetails(parseClientDetails(guest.details), HOME.siteId, pending(authorize, revoke), NOW);
    expect(details.guest?.authorized).toBe(false);
    const elsewhere = simulateClientDetails(parseClientDetails(guest.details), "another-site", pending(authorize), NOW);
    expect(elsewhere.guest?.authorized).toBe(false);
  });

  it("never turns a non-guest into a guest", () => {
    const strange: UnifiAction = { kind: "guestAccess", payload: { ...authorize.payload, clientId: HOME.laptopId } } as UnifiAction;
    const listed = simulateClients([parseClient(site.clients[0]!.overview)], HOME.siteId, pending(strange));
    expect(listed[0]!.guest).toBeNull();
  });
});

describe("WiFi", () => {
  const change: UnifiAction = {
    kind: "updateWifi",
    payload: { siteId: HOME.siteId, wifiNetworkId: HOME.guestWifiId, networkName: "Guest", changes: { name: "Visitors", hidden: true, passphrase: "new-password-1" } },
  };

  it("shows pending changes in the list, the details, and the password", () => {
    const listed = simulateWifiSummaries(site.wifi.map(w => parseWifiSummary(wifiOverview(w))), HOME.siteId, pending(change));
    expect(listed.map(w => w.name)).toEqual(["Home", "Visitors", "Things"]);
    expect(simulateWifiInfo(parseWifiInfo(site.wifi[1]!), HOME.siteId, pending(change))).toMatchObject({ name: "Visitors", hidden: true });
    expect(simulatePassphrase(wifiPassphrase(site.wifi[1]!), HOME.siteId, HOME.guestWifiId, pending(change))).toBe("new-password-1");
  });

  it("doesn't invent a password for a network without one", () => {
    expect(simulatePassphrase(null, HOME.siteId, HOME.guestWifiId, pending(change))).toBeNull();
  });
});

describe("vouchers", () => {
  const vouchers = site.vouchers.map(parseVoucher);
  const create: UnifiAction = {
    kind: "createVouchers",
    payload: {
      siteId: HOME.siteId, placeholderIds: ["pending-x-1", "pending-x-2"], submittedAt: NOW,
      request: { count: 2, note: "Party", durationMinutes: 240, guestLimit: 1, dataLimitMB: null, downloadLimitKbps: null, uploadLimitKbps: null },
    },
  };

  it("lists pending vouchers first, with no code yet", () => {
    const listed = simulateVouchers(vouchers, HOME.siteId, pending(create));
    expect(listed.map(v => [v.id, v.code])).toEqual([["pending-x-1", null], ["pending-x-2", null], [HOME.voucherId, "1234567890"]]);
    expect(listed[0]).toMatchObject({ note: "Party", durationMinutes: 240, guestLimit: 1, createdAt: new Date(NOW) });
    expect(isPlaceholderVoucherId("pending-x-1")).toBe(true);
    expect(isPlaceholderVoucherId(HOME.voucherId)).toBe(false);
  });

  it("hides a voucher pending deletion", () => {
    const remove: UnifiAction = { kind: "deleteVoucher", payload: { siteId: HOME.siteId, voucherId: HOME.voucherId, note: "Book club", code: "1234567890" } };
    expect(simulateVouchers(vouchers, HOME.siteId, pending(remove))).toEqual([]);
  });
});

describe("cameras", () => {
  const doorbell = parseCamera(protect.cameras[0]!);
  const ptz = parseCamera(protect.cameras[1]!);

  it("shows pending renames, status light, volume, and doorbell messages", () => {
    const until = NOW + 3_600_000;
    const result = simulateCamera(doorbell, pending(
      { kind: "cameraSettings", payload: { cameraId: HOME.doorbellId, cameraName: "Front Door", change: { name: "Porch" } } },
      { kind: "cameraSettings", payload: { cameraId: HOME.doorbellId, cameraName: "Porch", change: { statusLight: false } } },
      { kind: "cameraMicVolume", payload: { cameraId: HOME.doorbellId, cameraName: "Porch", volume: 40 } },
      { kind: "cameraSettings", payload: { cameraId: HOME.doorbellId, cameraName: "Porch", change: { doorbellMessage: { kind: "doNotDisturb" }, until } } },
    ));
    expect(result).toMatchObject({
      name: "Porch", statusLight: false, micVolume: 40, doorbellDisplay: { kind: "doNotDisturb", until: new Date(until) },
    });
  });

  it("shows a camera as it is while a PTZ command waits for its decision", () => {
    const start: UnifiAction = { kind: "cameraPtz", payload: { cameraId: HOME.ptzId, cameraName: "Driveway", command: { startPatrol: 2 } } };
    expect(simulateCamera(ptz, pending(start))).toEqual(ptz);
  });

  it("leaves a missing status light missing", () => {
    const result = simulateCamera(ptz, pending({ kind: "cameraSettings", payload: { cameraId: HOME.ptzId, cameraName: "Driveway", change: { statusLight: true } } }));
    expect(result.statusLight).toBeNull();
  });
});

function lightAction(change: Extract<UnifiAction, { kind: "lightSettings" }>["payload"]["change"]): UnifiAction {
  return { kind: "lightSettings", payload: { lightId: HOME.lightId, lightName: "Backyard Floodlight", change } };
}

describe("floodlights", () => {
  const light = parseLight(protect.lights[0]!);

  it("shows a light forced on, and released again", () => {
    expect(simulateLight(light, pending(lightAction({ forcedOn: true })))).toMatchObject({ forcedOn: true, isOn: true });
    expect(simulateLight(light, pending(lightAction({ forcedOn: true }), lightAction({ forcedOn: false })))).toMatchObject({ forcedOn: false, isOn: false });
  });

  it("shows mode and brightness changes", () => {
    expect(simulateLight(light, pending(lightAction({ mode: "always", activeWhen: "always" }), lightAction({ brightness: 6 }))))
      .toMatchObject({ mode: "always", activeWhen: "always", brightness: 6 });
  });
});
