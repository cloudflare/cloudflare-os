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
  const NETWORK = `console/${encodeURIComponent(HOME.hostId)}/app/network`;
  const ofSite = (part: string) => `${NETWORK}/${part}/${HOME.siteId}`;
  const guestWifi = `${NETWORK}/site/${HOME.siteId}/wifi/${HOME.guestWifiId}`;
  // What each read reports: the endpoints its data came from, so a role limited to other sites,
  // or one that can't read passwords, isn't shown it.
  const reads: [string, Step, string[]][] = [
    ["describe", { call: "describe" }, [ofSite("site")]],
    ["listDevices", { call: "listDevices" }, [ofSite("devices")]],
    ["listClients", { call: "listClients" }, [ofSite("clients")]],
    ["getClient", { call: "getClient", args: [HOME.phoneId] }, [ofSite("clients")]],
    ["listNetworks", { call: "listNetworks" }, [ofSite("networks")]],
    ["listWifiNetworks", { call: "listWifiNetworks" }, [ofSite("wifiNetworks")]],
    ["device.describe", { via: [["getDevice", HOME.apId]], call: "describe" }, [ofSite("devices")]],
    ["device.getStatistics", { via: [["getDevice", HOME.apId]], call: "getStatistics" }, [ofSite("devices")]],
    ["device.listClients", { via: [["getDevice", HOME.apId]], call: "listClients" }, [ofSite("clients"), ofSite("devices")]],
    ["wifi.describe", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "describe" }, [guestWifi]],
    ["wifi.getPassphrase", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "getPassphrase" }, [guestWifi]],
    ["hotspot.listGuests", { via: [["getHotspot"]], call: "listGuests" }, [ofSite("clients")]],
    ["hotspot.getGuest", { via: [["getHotspot"]], call: "getGuest", args: [HOME.guestId] }, [ofSite("clients")]],
    ["hotspot.listVouchers", { via: [["getHotspot"]], call: "listVouchers" }, [ofSite("vouchers")]],
  ];
  it.each(reads)("%s records exactly one observation, of what it disclosed", async (_name, step, subresources) => {
    installFake();
    const accountId = await connectCloud();
    const site = binding(accountId, RESOURCES.site);
    const [result] = await hooks().run(site.name, site.props, [step]);
    expect(result).toHaveProperty("ok");
    const { observations, submitted } = await site.queue();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.title).toMatch(/UniFi/);
    expect(observations[0]!.subresources).toEqual(subresources);
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
      subresources: [`console/${encodeURIComponent(HOME.hostId)}/app/network/site/${HOME.siteId}/wifi/${HOME.guestWifiId}`],
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
  it("won't restart a device the device list doesn't classify, since it might be the gateway", async () => {
    const { console } = installFake();
    delete console.network!.sites[0]!.devices.find(d => d.overview.id === HOME.apId)!.overview.features;
    const ap = binding(await connectCloud(), RESOURCES.device(HOME.apId));
    expect(await ap.failure("restart")).toMatch(/didn't say what Living Room AP does/);
    expect((await ap.queue()).submitted).toEqual([]);
  });

  it("restarts an access point only once approved, as an auto-approvable kind", async () => {
    const { console } = installFake();
    const ap = binding(await connectCloud(), RESOURCES.device(HOME.apId));
    await ap.call("restart");
    expect(console.writes()).toEqual([]);
    const { actionId, description } = lastSubmitted(await ap.queue());
    expect(description).toMatchObject({
      title: "Restart a UniFi device", implementsRevert: false, awaitDecision: true, autoApprovable: true,
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
    expect(description.title).toBe("Restart the UniFi gateway");
    expect(JSON.stringify(description)).not.toContain("UDM Pro");
    expect(description.description).toMatch(/whole network and its internet connection go down/);
    // A kind of its own, so it can't share the auto-approval a user granted for restarting devices.
    expect(description.actionKind?.tag).toBe("unifi.restartGateway");
    expect(description.autoApprovable).toBe(false);
    const kinds = (await hooks().autoApprovable(gateway.name, gateway.props)) as { ok: { tag: string }[] };
    expect(kinds.ok.map(k => k.tag).toSorted()).toEqual(["unifi.powerCyclePort", "unifi.restartDevice"]);
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
    expect(description).toMatchObject({ title: "Power-cycle port 2 on a UniFi device", awaitDecision: true });
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
    expect(description).toMatchObject({ title: "Change a UniFi WiFi network", autoApprovable: false });
    // Action history reaches every collaborator, so a password that will work isn't written into it.
    expect(description.description).toMatch(/Sets a new password/);
    expect(JSON.stringify(description)).not.toContain("brand-new-pass");
    expect(description.descriptionIsComplete).toBeUndefined();

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

  it("writes changes approved through two bindings at once one after the other, keeping both", async () => {
    const { console } = installFake();
    const accountId = await connectCloud();
    const guest = binding(accountId, RESOURCES.wifi(HOME.guestWifiId));
    const site = binding(accountId, RESOURCES.site);
    await guest.call("update", { passphrase: "brand-new-pass" });
    const { actionId: passwordChange } = lastSubmitted(await guest.queue());
    await site.callVia([["getWifiNetwork", HOME.guestWifiId]], "update", { hidden: true });
    const { actionId: hide } = lastSubmitted(await site.queue());
    await Promise.all([guest.apply(passwordChange), site.apply(hide)]);
    const puts = console.writes().filter(call => call.method === "PUT");
    expect(puts).toHaveLength(2);
    // The second write read the settings the first one wrote, rather than restoring the old password.
    expect(puts[1]!.body).toMatchObject({ hideName: true, securityConfiguration: { passphrase: "brand-new-pass" } });
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
      title: "Let a guest use the WiFi", autoApprovable: false, actionKind: { tag: "unifi.guestAccess" },
    });
    expect(JSON.stringify(description)).not.toContain("Visitor Pixel");
    expect(description.awaitDecision).toBeUndefined();
    expect(await hotspot.call("getGuest", HOME.guestId)).toMatchObject({ guest: { authorized: true, dataLimitMB: 500 } });
    await hotspot.apply(actionId);
    expect(console.writes()[0]!.body).toEqual({ action: "AUTHORIZE_GUEST_ACCESS", timeLimitMinutes: 120, dataUsageLimitMBytes: 500 });
    expect(await hotspot.call("getGuest", HOME.guestId)).toMatchObject({ guest: { authorized: true, method: "api" } });
  });

  it("never sends a guest grant again after an interrupted one, since a second would reset its allowance", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("authorizeGuest", HOME.guestId, { durationMinutes: 120 });
    const { actionId } = lastSubmitted(await hotspot.queue());
    console.offline = true;
    expect(await hotspot.applyOutcome(actionId)).toEqual({ error: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    console.offline = false;
    expect(await hotspot.applyOutcome(actionId)).toEqual({ error: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    expect(console.writes()).toEqual([]);
  });

  it("creates vouchers once approved, listing them without codes until then", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("createVouchers", { note: "Party", durationMinutes: 240, count: 2 });
    const { actionId, description } = lastSubmitted(await hotspot.queue());
    expect(description).toMatchObject({ title: "Create 2 guest WiFi vouchers", awaitDecision: true, autoApprovable: false });
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
    expect(description.title).toBe("Delete a guest WiFi voucher");
    expect(JSON.stringify(description)).not.toContain("Book club");
    // The code still works until the deletion is approved, so it isn't written into history.
    expect(JSON.stringify(description)).not.toContain("1234567890");
    console.network!.sites[0]!.vouchers = [];
    await hotspot.apply(actionId);
    expect(await hotspot.failure("deleteVoucher", "5f0ee1aa-0000-4000-8000-ffffffffffff")).toMatch(/no voucher with that ID/);
  });

  it("offers to auto-approve nothing a hotspot can ask for, since all of it changes who can join", async () => {
    installFake();
    const accountId = await connectCloud();
    const hotspot = binding(accountId, RESOURCES.hotspot);
    expect(await hooks().autoApprovable(hotspot.name, hotspot.props)).toEqual({ ok: [] });
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
  it("presents itself by its kind of resource, never UniFi's names, and links into UniFi", async () => {
    // Every collaborator sees this, unchecked, so it names nothing a UniFi role might hide.
    installFake();
    const accountId = await connectCloud();
    const ap = await binding(accountId, RESOURCES.device(HOME.apId)).describe();
    expect(ap).toMatchObject({
      title: "UniFi device", tsType: "UnifiNetworkDevice", suggestedBindingName: "UNIFI_DEVICE",
      url: `https://unifi.ui.com/consoles/${HOME.hostId}/network/default/dashboard`,
    });
    expect(JSON.stringify(ap)).not.toContain("Living Room AP");
    expect(await binding(accountId, RESOURCES.hotspot).describe()).toMatchObject({
      title: "UniFi guest hotspot", tsType: "UnifiHotspot",
    });
  });

  it("doesn't revert", async () => {
    installFake();
    const site = binding(await connectCloud(), RESOURCES.site);
    expect(await hooks().revert(site.name, site.props, 1)).toEqual({ error: "UniFi changes can't be reverted automatically." });
  });
});
