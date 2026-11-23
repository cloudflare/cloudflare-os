// The Network bindings, driven the way the overseer drives them: every read is authorized before it
// returns, every change is submitted for approval and shown in later reads until it is decided,
// approving carries it out against the console, and each kind of binding reaches only what it was
// granted.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import {
  account, binding, CLOUD_KEY, connectCloud, connectDirect, CONSOLE_URL, holdRequestsWith, hooks, installFake, LOCAL_KEY,
  reconnectCloud, RESOURCES,
} from "./helpers.js";

const NEW_CLOUD_KEY = "replacement-cloud-key-0123456789ab";
import { HOME, rawVoucher } from "../fake-unifi.js";
import type { Step } from "../worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A binding to the guest WiFi network through a direct connection. */
async function guestWifiOf(accountId: string, spell = (id: string) => id) {
  const identity = await account(accountId).identity() as { consoleId: string };
  return binding(accountId, {
    kind: "wifi", consoleId: identity.consoleId, siteId: spell(HOME.siteId), wifiNetworkId: spell(HOME.guestWifiId),
  });
}

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
  const item = (kind: string, id: string) => `${NETWORK}/site/${HOME.siteId}/${kind}/${id}`;
  const ap = item("device", HOME.apId);
  // [read, step, what it reports, whether it returns a credential that works]
  const reads: [string, Step, string[], boolean?][] = [
    ["describe", { call: "describe" }, [ofSite("site"), NETWORK]],
    ["listDevices", { call: "listDevices" }, [ofSite("devices")]],
    ["listClients", { call: "listClients" }, [ofSite("clients")]],
    ["getClient", { call: "getClient", args: [HOME.phoneId] }, [item("client", HOME.phoneId)]],
    ["listNetworks", { call: "listNetworks" }, [ofSite("networks")]],
    ["listWifiNetworks", { call: "listWifiNetworks" }, [ofSite("wifiNetworks")]],
    ["device.describe", { via: [["getDevice", HOME.apId]], call: "describe" }, [ofSite("devices"), ap]],
    ["device.getStatistics", { via: [["getDevice", HOME.apId]], call: "getStatistics" },
      [ofSite("devices"), ap, item("deviceStatistics", HOME.apId)]],
    ["device.listClients", { via: [["getDevice", HOME.apId]], call: "listClients" }, [ofSite("clients"), ofSite("devices"), ap]],
    ["wifi.describe", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "describe" }, [guestWifi]],
    ["wifi.getPassphrase", { via: [["getWifiNetwork", HOME.guestWifiId]], call: "getPassphrase" },
      [guestWifi, item("wifiPassword", HOME.guestWifiId)], true],
    ["hotspot.listGuests", { via: [["getHotspot"]], call: "listGuests" }, [ofSite("clients")]],
    ["hotspot.getGuest", { via: [["getHotspot"]], call: "getGuest", args: [HOME.guestId] }, [item("client", HOME.guestId)]],
    ["hotspot.listVouchers", { via: [["getHotspot"]], call: "listVouchers" }, [ofSite("vouchers"), ofSite("voucherCodes")], true],
  ];
  it.each(reads)("%s records exactly one observation, of what it disclosed", async (_name, step, subresources, restricted) => {
    installFake();
    const accountId = await connectCloud();
    const site = binding(accountId, RESOURCES.site);
    const [result] = await hooks().run(site.name, site.props, [step]);
    expect(result).toHaveProperty("ok");
    const { observations, submitted } = await site.queue();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.title).toMatch(/UniFi/);
    expect(observations[0]!.subresources).toEqual(subresources);
    expect(observations[0]!.containsRestrictedData).toBe(restricted);
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
      subresources: [
        `console/${encodeURIComponent(HOME.hostId)}/app/network/site/${HOME.siteId}/wifi/${HOME.guestWifiId}`,
        `console/${encodeURIComponent(HOME.hostId)}/app/network/site/${HOME.siteId}/wifiPassword/${HOME.guestWifiId}`,
      ],
      // A password that works, which the Workshop then keeps from leaving the workspace.
      containsRestrictedData: true,
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
    // A kind of its own, so it can't share the auto-approval a user granted for restarting devices.
    expect(description.actionKind?.tag).toBe("unifi.restartGateway");
    expect(description.autoApprovable).toBe(false);
    const kinds = (await hooks().autoApprovable(gateway.name, gateway.props)) as { ok: { tag: string }[] };
    expect(kinds.ok.map(k => k.tag).toSorted()).toEqual(["unifi.powerCyclePort", "unifi.restartDevice"]);
  });

  it("doesn't send a restart that was waiting its turn when the connection was removed", async () => {
    const { console } = installFake();
    const accountId = await connectCloud();
    const target = { kind: "app" as const, app: "network" as const, consoleId: HOME.hostId };
    // Use up the console's request budget, so the next request has to wait for a token.
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      account(accountId).request({ target, method: "GET", path: "/v1/sites", query: { offset: String(i) } })));
    const waiting = account(accountId).request({
      target, method: "POST", path: `/v1/sites/${HOME.siteId}/devices/${HOME.apId}/actions`, body: { action: "RESTART" },
    });
    await account(accountId).revoke();
    expect(await waiting).toMatchObject({ ok: false, failure: { kind: "auth" } });
    expect(console.writes()).toEqual([]);
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
    expect(description).toMatchObject({ title: "Change WiFi network “Guest”", autoApprovable: false });
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

  it("writes changes approved through two people's connections to one console one after the other", async () => {
    // Separate keys mean separate accounts, but the same network: their writes still take turns.
    const { unifi, console } = installFake();
    const SECOND_KEY = "second-local-key-0123456789abcdef";
    unifi.direct.get(CONSOLE_URL)!.keys.add(SECOND_KEY);
    const mine = await guestWifiOf(await connectDirect());
    // Their IDs spelled in uppercase, which names the same network.
    const theirs = await guestWifiOf(await connectDirect({ localApiKey: SECOND_KEY }), (id: string) => id.toUpperCase());
    await mine.call("update", { passphrase: "brand-new-pass" });
    await theirs.call("update", { hidden: true });
    // Staged under the ID as UniFi spells it, so their own reads show it before approval.
    expect(await theirs.call("describe")).toMatchObject({ hidden: true });
    // Hold my write until their read has gone out, or a moment has passed: without the shared lane
    // they'd read the old settings and write them back over mine.
    const { promise: theyRead, resolve: sawTheirRead } = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = new Request(input, init);
      const key = sent.headers.get("x-api-key");
      if (key === SECOND_KEY && sent.method === "GET" && sent.url.includes("/wifi/broadcasts/")) sawTheirRead();
      if (key === LOCAL_KEY && sent.method === "PUT") await Promise.race([theyRead, new Promise(resolve => setTimeout(resolve, 300))]);
      return unifi.fetch(sent);
    });
    await Promise.all([mine.apply(lastSubmitted(await mine.queue()).actionId), theirs.apply(lastSubmitted(await theirs.queue()).actionId)]);
    const puts = console.writes().filter(call => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toMatchObject({ securityConfiguration: { passphrase: "brand-new-pass" } });
    expect(puts[1]!.body).toMatchObject({ hideName: true });
  });

  it("doesn't write settings one key read with another that a reconnect put in its place", async () => {
    const { unifi, console } = installFake();
    const accountId = await connectCloud();
    const guest = binding(accountId, RESOURCES.wifi(HOME.guestWifiId));
    await guest.call("update", { hidden: true });
    const { actionId } = lastSubmitted(await guest.queue());
    const release = holdRequestsWith(unifi, CLOUD_KEY);
    const applying = guest.applyOutcome(actionId);
    unifi.addCloudKey(NEW_CLOUD_KEY, { ...unifi.cloud.get(CLOUD_KEY)! });
    await reconnectCloud(accountId, NEW_CLOUD_KEY);
    release();
    expect(await applying).toMatchObject({ error: expect.stringMatching(/reconnected/) });
    expect(console.writes()).toEqual([]);
    // Still pending, so it can be applied again, reading afresh with the new key.
    await guest.apply(actionId);
    expect(console.writes()).toHaveLength(1);
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
      title: "Let guest “Visitor Pixel” use the WiFi", autoApprovable: false, actionKind: { tag: "unifi.guestAccess" },
    });
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

  it("finds the vouchers one call created, before and after approval", async () => {
    installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    const batch = await hotspot.call<string>("createVouchers", { note: "Party", durationMinutes: 240, count: 2 });
    await hotspot.call("createVouchers", { note: "Party", durationMinutes: 60 });
    const queued = await hotspot.call<{ code: string | null }[]>("getVoucherBatch", batch);
    expect(queued.map(v => v.code)).toEqual([null, null]);

    const [first] = (await hotspot.queue()).submitted;
    await hotspot.apply(first!.actionId);
    const created = await hotspot.call<{ code: string | null; note: string }[]>("getVoucherBatch", batch);
    expect(created).toHaveLength(2);
    expect(created.every(v => typeof v.code === "string" && v.note === "Party")).toBe(true);
    // Working codes, which the Workshop keeps from leaving the workspace.
    expect((await hotspot.queue()).observations.at(-1)).toMatchObject({ containsRestrictedData: true });
    expect(await hotspot.failure("getVoucherBatch", "not-a-batch")).toMatch(/isn't a voucher batch ID/);
  });

  it("tells a declined batch, which created nothing, from one it can't look up", async () => {
    installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    const batch = await hotspot.call<string>("createVouchers", { note: "Party", durationMinutes: 240 });
    await hotspot.reject(lastSubmitted(await hotspot.queue()).actionId);
    expect(await hotspot.call("getVoucherBatch", batch)).toEqual([]);
    // One it never recorded, as for a batch older than the most recent it keeps.
    expect(await hotspot.failure("getVoucherBatch", crypto.randomUUID())).toMatch(/can't be looked up/);
  });

  it("finds a batch's vouchers on a site with more than listVouchers() returns", async () => {
    const { console } = installFake();
    const older = Array.from({ length: 1000 }, (_, i) =>
      rawVoucher(`5f0ee1aa-0000-4000-9000-${String(i).padStart(12, "0")}`, "Old", String(2_000_000_000 + i), "2026-01-01T00:00:00Z"));
    console.network!.sites[0]!.vouchers.push(...older);
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    const batch = await hotspot.call<string>("createVouchers", { note: "Party", durationMinutes: 240 });
    await hotspot.apply(lastSubmitted(await hotspot.queue()).actionId);
    const listed = await hotspot.call<{ note: string }[]>("listVouchers");
    expect(listed.some(v => v.note === "Party")).toBe(false);
    const [voucher] = await hotspot.call<{ id: string; code: string | null; note: string }[]>("getVoucherBatch", batch);
    expect(voucher).toMatchObject({ note: "Party", code: expect.any(String) });
    expect(console.calls.at(-1)?.query.filter).toBe(`id.in(${voucher!.id})`);

    // Deleting it finds it the same way, and once it's gone the batch no longer shows its code.
    await hotspot.call("deleteVoucher", voucher!.id);
    await hotspot.apply(lastSubmitted(await hotspot.queue()).actionId);
    expect(await hotspot.call("getVoucherBatch", batch)).toEqual([]);
  });

  it("reads every page to find a batch when a console ignores the id filter", async () => {
    // Its first 1,000 vouchers are older ones, so stopping there would call the new one gone.
    const { console } = installFake();
    const older = Array.from({ length: 1000 }, (_, i) =>
      rawVoucher(`5f0ee1aa-0000-4000-9000-${String(i).padStart(12, "0")}`, "Old", String(2_000_000_000 + i), "2026-01-01T00:00:00Z"));
    console.network!.sites[0]!.vouchers.push(...older);
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    const batch = await hotspot.call<string>("createVouchers", { note: "Party", durationMinutes: 240 });
    await hotspot.apply(lastSubmitted(await hotspot.queue()).actionId);
    console.honorsFilters = false;
    const [voucher] = await hotspot.call<{ id: string; code: string | null; note: string }[]>("getVoucherBatch", batch);
    expect(voucher).toMatchObject({ note: "Party", code: expect.any(String) });
    await hotspot.call("deleteVoucher", voucher!.id);
  });

  it("asks for the whole voucher list when a console refuses the id filter", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    const refuseFilter = console.handle.bind(console);
    console.handle = (app, method, path, query, body) => query.filter?.startsWith("id.in(")
      ? new Response(JSON.stringify({ message: "bad filter" }), { status: 400, headers: { "Content-Type": "application/json" } })
      : refuseFilter(app, method, path, query, body);
    await hotspot.call("deleteVoucher", HOME.voucherId);
    expect(lastSubmitted(await hotspot.queue()).description.title).toBe("Delete guest WiFi voucher “Book club”");
  });

  it("deletes a voucher, hiding it until approved, and treats one already gone as done", async () => {
    const { console } = installFake();
    const hotspot = binding(await connectCloud(), RESOURCES.hotspot);
    await hotspot.call("deleteVoucher", HOME.voucherId);
    expect(await hotspot.call("listVouchers")).toEqual([]);
    const { actionId, description } = lastSubmitted(await hotspot.queue());
    expect(description.title).toBe("Delete guest WiFi voucher “Book club”");
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
