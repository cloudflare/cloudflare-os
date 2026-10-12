// The Network bindings, driven the way the overseer drives them: every read is authorized before it
// returns, every change is submitted for approval and shown in later reads until it is decided,
// approving carries it out against the console, and each kind of binding reaches only what it was
// granted.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import { account, binding, connectCloud, connectDirect, hooks, installFake, RESOURCES } from "./helpers.js";
import { HOME } from "../fake-unifi.js";
import type { Step } from "../worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastSubmitted(queue: { submitted: { actionId: number; description: ActionDescription }[] }) {
  const entry = queue.submitted.at(-1);
  if (!entry) throw new Error("nothing was submitted");
  return entry;
}

describe("every read is authorized before it returns", () => {
  const reads: [string, Step][] = [
    ["describe", { call: "describe" }],
    ["listDevices", { call: "listDevices" }],
    ["listClients", { call: "listClients" }],
    ["getClient", { call: "getClient", args: [HOME.phoneId] }],
    ["listNetworks", { call: "listNetworks" }],
    ["listWifiNetworks", { call: "listWifiNetworks" }],
    ["device.describe", { via: [["getDevice", HOME.apId]], call: "describe" }],
    ["device.getStatistics", { via: [["getDevice", HOME.apId]], call: "getStatistics" }],
    ["device.listClients", { via: [["getDevice", HOME.apId]], call: "listClients" }],
    ["wifi.describe", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "describe" }],
    ["wifi.getPassphrase", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "getPassphrase" }],
    ["hotspot.listGuests", { via: [["getHotspot"]], call: "listGuests" }],
    ["hotspot.getGuest", { via: [["getHotspot"]], call: "getGuest", args: [HOME.guestId] }],
    ["hotspot.listVouchers", { via: [["getHotspot"]], call: "listVouchers" }],
  ];

  it.each(reads)("%s records exactly one observation", async (_name, step) => {
    installFake();
    const accountId = await connectCloud();
    const site = binding(accountId, RESOURCES.site);
    const [result] = await hooks().run(site.name, site.props, [step]);
    expect(result).toHaveProperty("ok");
    const { observations, submitted } = await site.queue();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.title).toMatch(/UniFi/);
    expect(submitted).toEqual([]);
  });

  it("names what was read in the observation, with the console's text escaped", async () => {
    const { console } = installFake();
    console.network!.sites[0]!.wifi.find(w => w.id === HOME.guestWifiId)!.name = "[Guest](https://evil.example)\n# Free";
    const accountId = await connectCloud();
    const site = binding(accountId, RESOURCES.site);
    await site.callVia([["getWifiNetwork", HOME.guestWifiId]], "getPassphrase");
    expect((await site.queue()).observations).toEqual([{
      title: "Read a UniFi WiFi password",
      description: "Read the password of WiFi network \\[Guest\\]\\(https://evil\\.example\\) \\# Free.",
    }]);
  });
});

describe("a site", () => {
  it("describes itself, with the IDs a narrower connection needs", async () => {
    installFake();
    const site = binding(await connectCloud(), RESOURCES.site);
    expect(await site.call("describe")).toEqual({
      consoleId: HOME.hostId, consoleName: "Dream Machine Pro", siteId: HOME.siteId, name: "Default", networkVersion: "10.6.106",
    });
  });

  it("lists devices, clients, networks, and WiFi networks, without passwords", async () => {
    installFake();
    const site = binding(await connectCloud(), RESOURCES.site);
    expect((await site.call<{ name: string }[]>("listDevices")).map(d => d.name)).toEqual(["UDM Pro", "Garage Switch", "Living Room AP"]);
    expect((await site.call<{ name: string }[]>("listClients")).map(c => c.name)).toEqual(["Work Laptop", "Dan's iPhone", "Visitor Pixel"]);
    expect((await site.call<{ vlanId: number }[]>("listNetworks")).map(n => n.vlanId)).toEqual([1, 20]);
    const wifi = await site.call<Record<string, unknown>[]>("listWifiNetworks");
    expect(wifi.map(w => w.name)).toEqual(["Home", "Guest", "Things"]);
    expect(JSON.stringify(wifi)).not.toContain("welcome-guests");
  });

  it("refuses IDs that aren't IDs before any request", async () => {
    const { unifi } = installFake();
    const site = binding(await connectCloud(), RESOURCES.site);
    const before = unifi.calls.length;
    expect(await site.failure("getClient", "..")).toMatch(/isn't a valid client ID/);
    expect(unifi.calls.length).toBe(before);
  });

  it("works the same through a direct connection", async () => {
    installFake();
    const accountId = await connectDirect();
    const identity = await account(accountId).identity();
    const consoleId = identity?.mode === "direct" ? identity.consoleId : "";
    const site = binding(accountId, { kind: "site", consoleId, siteId: HOME.siteId });
    expect(await site.call("describe")).toMatchObject({ consoleId, consoleName: "Dream Machine Pro", name: "Default" });
    // A direct connection reaches only its own console.
    const elsewhere = binding(accountId, RESOURCES.site);
    expect(await elsewhere.failure("listDevices")).toMatch(/doesn't reach that console/);
  });
});

describe("a device", () => {
  it("restarts an access point only once approved, as an auto-approvable kind", async () => {
    const { console } = installFake();
    const ap = binding(await connectCloud(), RESOURCES.device(HOME.apId));
    await ap.call("restart");
    expect(console.writes()).toEqual([]);
    const { actionId, description } = lastSubmitted(await ap.queue());
    expect(description).toMatchObject({
      title: "Restart “Living Room AP”", implementsRevert: false, awaitDecision: true, autoApprovable: true,
      actionKind: { tag: "unifi.restartDevice" }, descriptionIsComplete: true,
    });
    await ap.apply(actionId);
    expect(console.writes()).toEqual([
      { app: "network", method: "POST", path: `/v1/sites/${HOME.siteId}/devices/${HOME.apId}/actions`, query: {}, body: { action: "RESTART" } },
    ]);
    // Applying again (a retry) doesn't restart it twice.
    await ap.apply(actionId);
    expect(console.writes()).toHaveLength(1);
  });

  it("warns that restarting the gateway takes the network down, and never auto-approves it", async () => {
    installFake();
    const gateway = binding(await connectCloud(), RESOURCES.device(HOME.gatewayId));
    await gateway.call("restart");
    const { description } = lastSubmitted(await gateway.queue());
    expect(description.title).toBe("Restart the gateway “UDM Pro”");
    expect(description.description).toMatch(/whole network and its internet connection go down/);
    // No kind, so it can't share the auto-approval a user granted for restarting devices.
    expect(description.actionKind).toBeUndefined();
    expect(description.autoApprovable).toBe(false);
  });

  it("reports an unknown outcome, never a retry, when the console stops answering mid-restart", async () => {
    const { console } = installFake();
    const ap = binding(await connectCloud(), RESOURCES.device(HOME.apId));
    await ap.call("restart");
    const { actionId } = lastSubmitted(await ap.queue());
    console.offline = true;
    expect(await ap.applyOutcome(actionId)).toEqual({ error: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    console.offline = false;
    // Terminal: the stored message comes back, and nothing is sent again.
    expect(await ap.applyOutcome(actionId)).toEqual({ error: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    expect(console.writes()).toEqual([]);
  });

  it("power-cycles a PoE port, refusing ports that can't be", async () => {
    const { console } = installFake();
    const sw = binding(await connectCloud(), RESOURCES.device(HOME.switchId));
    expect(await sw.failure("powerCyclePort", 1)).toMatch(/Port 1 on Garage Switch has no PoE/);
    expect(await sw.failure("powerCyclePort", 3)).toMatch(/PoE is turned off on port 3/);
    expect(await sw.failure("powerCyclePort", 9)).toMatch(/has no port 9/);
    expect(await sw.failure("powerCyclePort", 1.5)).toMatch(/whole number/);
    await sw.call("powerCyclePort", 2);
    const { actionId, description } = lastSubmitted(await sw.queue());
    expect(description).toMatchObject({ title: "Power-cycle port 2 on “Garage Switch”", awaitDecision: true });
    await sw.apply(actionId);
    expect(console.writes().map(w => [w.path, w.body])).toEqual([
      [`/v1/sites/${HOME.siteId}/devices/${HOME.switchId}/interfaces/ports/2/actions`, { action: "POWER_CYCLE" }],
    ]);
  });

  it("lists its clients only when they were granted with it", async () => {
    installFake();
    const accountId = await connectCloud();
    const bare = binding(accountId, RESOURCES.device(HOME.apId, false));
    expect(await bare.failure("listClients")).toMatch(/doesn't include the device's clients/);
    const withClients = binding(accountId, RESOURCES.device(HOME.apId, true));
    expect((await withClients.call<{ name: string }[]>("listClients")).map(c => c.name)).toEqual(["Dan's iPhone", "Visitor Pixel"]);
  });
});

describe("a WiFi network", () => {
  it("changes its password once approved, showing the change before then", async () => {
    const { console } = installFake();
    const guest = binding(await connectCloud(), RESOURCES.wifi(HOME.guestWifiId));
    expect(await guest.call("getPassphrase")).toBe("welcome-guests");
    await guest.call("update", { passphrase: "brand-new-pass", name: "Visitors" });
    const { actionId, description } = lastSubmitted(await guest.queue());
    expect(description).toMatchObject({ title: "Change WiFi network “Guest”", descriptionIsComplete: true, autoApprovable: false });
    expect(JSON.stringify(description.fields)).toContain("brand-new-pass");

    // Reads show the change; the console doesn't have it yet.
    expect(await guest.call("getPassphrase")).toBe("brand-new-pass");
    expect(await guest.call("describe")).toMatchObject({ name: "Visitors" });
    expect(console.writes()).toEqual([]);

    await guest.apply(actionId);
    const put = console.writes()[0]!;
    expect(put.method).toBe("PUT");
    expect(put.body).toMatchObject({ name: "Visitors", securityConfiguration: { type: "WPA2_PERSONAL", passphrase: "brand-new-pass" } });
    expect(await guest.call("getPassphrase")).toBe("brand-new-pass");
  });

  it("forgets a rejected change", async () => {
    const { console } = installFake();
    const guest = binding(await connectCloud(), RESOURCES.wifi(HOME.guestWifiId));
    await guest.call("update", { enabled: false });
    expect(await guest.call("describe")).toMatchObject({ enabled: false });
    await guest.reject(lastSubmitted(await guest.queue()).actionId);
    expect(await guest.call("describe")).toMatchObject({ enabled: true });
    expect(console.writes()).toEqual([]);
  });

  it("refuses changes UniFi would refuse, before submitting them", async () => {
    installFake();
    const guest = binding(await connectCloud(), RESOURCES.wifi(HOME.guestWifiId));
    expect(await guest.failure("update", {})).toMatch(/Say what to change/);
    expect(await guest.failure("update", { passphrase: "short" })).toMatch(/8 to 63/);
    expect(await guest.failure("update", { name: "x".repeat(33) })).toMatch(/1 to 32 bytes/);
    expect((await guest.queue()).submitted).toEqual([]);
  });
});

describe("the guest hotspot", () => {
  it("never reveals a client that isn't a guest, even from a console that ignores the filter", async () => {
    const { console } = installFake();
    console.honorsFilters = false;
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    expect((await hotspot.call<{ name: string }[]>("listGuests")).map(g => g.name)).toEqual(["Visitor Pixel"]);
    expect(await hotspot.failure("getGuest", HOME.laptopId)).toBe("No guest with that ID is connected to the guest hotspot.");
    expect(await hotspot.failure("getGuest", "c1a0b2d3-0000-4000-8000-00000000ffff")).toBe("No guest with that ID is connected to the guest hotspot.");
    expect(await hotspot.failure("authorizeGuest", HOME.laptopId)).toMatch(/No guest with that ID/);
  });

  it("lets a guest on once approved, with limits, showing it before then", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("authorizeGuest", HOME.guestId, { durationMinutes: 120, dataLimitMB: 500 });
    const { actionId, description } = lastSubmitted(await hotspot.queue());
    expect(description).toMatchObject({
      title: "Let guest “Visitor Pixel” use the WiFi", autoApprovable: true, actionKind: { tag: "unifi.guestAccess" },
    });
    expect(description.awaitDecision).toBeUndefined();
    expect(await hotspot.call("getGuest", HOME.guestId)).toMatchObject({ guest: { authorized: true, dataLimitMB: 500 } });
    await hotspot.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ action: "AUTHORIZE_GUEST_ACCESS", timeLimitMinutes: 120, dataUsageLimitMBytes: 500 });
    expect(await hotspot.call("getGuest", HOME.guestId)).toMatchObject({ guest: { authorized: true, method: "api" } });
  });

  it("creates vouchers once approved, listing them without codes until then", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("createVouchers", { note: "Party", durationMinutes: 240, count: 2 });
    const { actionId, description } = lastSubmitted(await hotspot.queue());
    expect(description).toMatchObject({ title: "Create 2 guest WiFi vouchers", awaitDecision: true, autoApprovable: true });
    const pending = await hotspot.call<{ id: string; code: string | null; guestLimit: number | null }[]>("listVouchers");
    expect(pending.slice(0, 2).map(v => [v.code, v.guestLimit])).toEqual([[null, 1], [null, 1]]);
    expect(await hotspot.failure("deleteVoucher", pending[0]!.id)).toMatch(/hasn't been created yet/);

    await hotspot.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ count: 2, name: "Party", timeLimitMinutes: 240, authorizedGuestLimit: 1 });
    const created = await hotspot.call<{ code: string | null; note: string }[]>("listVouchers");
    expect(created.filter(v => v.note === "Party").every(v => typeof v.code === "string")).toBe(true);
  });

  it("deletes a voucher, hiding it until approved, and treats one already gone as done", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("deleteVoucher", HOME.voucherId);
    expect(await hotspot.call("listVouchers")).toEqual([]);
    const { actionId, description } = lastSubmitted(await hotspot.queue());
    expect(description.title).toBe("Delete guest WiFi voucher “Book club”");
    console.network!.sites[0]!.vouchers = [];
    await hotspot.apply(actionId);
    expect(await hotspot.failure("deleteVoucher", "5f0ee1aa-0000-4000-8000-ffffffffffff")).toMatch(/no voucher with that ID/);
  });

  it("offers to auto-approve only what a hotspot can ask for", async () => {
    installFake();
    const accountId = await connectCloud();
    const hotspot = binding(accountId, RESOURCES.hotspot);
    const kinds = (await hooks().autoApprovable(hotspot.name, hotspot.props)) as { ok: { tag: string }[] };
    expect(kinds.ok.map(k => k.tag).toSorted()).toEqual(["unifi.createVouchers", "unifi.deleteVoucher", "unifi.guestAccess"]);
  });
});

describe("pending actions survive a restart", () => {
  it("still shows, and applies, an action submitted before the gatekeeper restarted", async () => {
    const { console } = installFake();
    const guest = binding(await connectCloud(), RESOURCES.wifi(HOME.guestWifiId));
    await guest.call("update", { hidden: true });
    const { actionId } = lastSubmitted(await guest.queue());
    await guest.restart();
    expect(await guest.call("describe")).toMatchObject({ hidden: true });
    await guest.apply(actionId);
    expect(console.writes()[0]!.body).toMatchObject({ hideName: true });
  });
});

describe("the binding", () => {
  it("presents itself with the resource's name and a link into UniFi", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await binding(accountId, RESOURCES.device(HOME.apId)).describe()).toMatchObject({
      title: "Living Room AP", tsType: "UnifiNetworkDevice", suggestedBindingName: "UNIFI_DEVICE",
      url: `https://unifi.ui.com/consoles/${HOME.hostId}/network/default/dashboard`,
    });
    expect(await binding(accountId, RESOURCES.hotspot).describe()).toMatchObject({
      title: "Guest hotspot · Default", tsType: "UnifiHotspot",
    });
  });

  it("doesn't revert", async () => {
    installFake();
    const site = binding(await connectCloud(), RESOURCES.site);
    expect(await hooks().revert(site.name, site.props, 1)).toEqual({ error: "UniFi changes can't be reverted automatically." });
  });
});
