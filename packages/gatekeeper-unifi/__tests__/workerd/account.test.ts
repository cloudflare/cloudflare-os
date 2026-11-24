// The account as the Workshop holds it: which resources it will mint a gatekeeper for, which
// collaborators a binding lets see what it read, what its resource pickers list, and how its one egress
// shares a console's request budget and cache between every binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  account, appSubresource, binding, connectCloud, connectDirect, CONSOLE_URL, describeSubresource, holdRequestsWith, hooks,
  installFake, LOCAL_KEY, RESOURCES, reconnectCloud,
} from "./helpers.js";
import { FakeConsole, HOME, homeConsole, type FakeUnifi } from "../fake-unifi.js";
import { UNIFI_RESOURCES } from "../../src/resources.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_URL = "https://unifi.ui.com/consoles";
const OFFICE_HOST = "AABBCCDDEEFF0000000006797F060000000006C719490000000062ABD4EB:1261206303";
const ALLOWED = { ok: { allowedObserverIds: ["observer-1"] } };
const DENIED = { ok: { allowedObserverIds: [] } };

/** `verifyObserverAccess` for `observer`, about what `b`'s `describe()` reports unless told otherwise. */
async function verify(b: ReturnType<typeof binding>, observer: string, subresources = [describeSubresource(b.props.resource)]) {
  return await hooks().verifyObserver(b.name, b.props, observer, subresources);
}

/** A console the cloud account administers but doesn't own. */
function office(): FakeConsole {
  const console = new FakeConsole("Office", OFFICE_HOST, "AABBCCDDEEFF");
  console.network = { version: "10.6.106", sites: [] };
  return console;
}

async function directConsoleId(accountId: string): Promise<string> {
  const identity = await account(accountId).identity();
  if (identity?.mode !== "direct") throw new Error("not a direct connection");
  return identity.consoleId;
}

describe("the account", () => {
  it("names a cloud connection after its UniFi account", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().user(accountId, "describe")).toMatchObject({ ok: { displayName: "Dan Carter", uniqueName: "dan@example.com" } });
  });

  it("names a direct connection after its console, told apart by its full URL", async () => {
    // Not the console's name and host: two same-named consoles can share a host under different paths.
    installFake();
    const accountId = await connectDirect();
    expect(await hooks().user(accountId, "describe"))
      .toMatchObject({ ok: { displayName: "Dream Machine Pro", uniqueName: CONSOLE_URL } });
  });

  it("leaves a cloud account's unique name out when UniFi doesn't report its email", async () => {
    // The Workshop treats two accounts with one unique name as one, so a made-up one would merge them.
    const { unifi, console } = installFake();
    unifi.addCloudKey("unnamed-key-0123456789abcdefABCD", { email: null, fullName: "Someone", owned: [console] });
    const accountId = await connectCloud("unnamed-key-0123456789abcdefABCD");
    const described = await hooks().user(accountId, "describe") as { ok: Record<string, unknown> };
    expect(described.ok).toMatchObject({ displayName: "Someone" });
    expect(described.ok).not.toHaveProperty("uniqueName");
  });

  it("offers every kind of resource", async () => {
    installFake();
    const accountId = await connectCloud();
    const result = await hooks().user(accountId, "getSupportedResources") as { ok: { urlPattern: string }[] };
    expect(result.ok.map(r => r.urlPattern)).toEqual(Object.values(UNIFI_RESOURCES).map(r => r.urlPattern));
  });

  it("starts a reconnect at a fresh link of its own", async () => {
    installFake();
    const accountId = await connectCloud();
    const result = await hooks().user(accountId, "reconnect") as { ok: { url: string } };
    expect(result.ok.url).toMatch(new RegExp(`^https://gadgets\\.example/gatekeeper/unifi/${accountId}/[0-9a-f]{64}$`));
  });
});

describe("minting a gatekeeper for a resource URL", () => {
  const site = `${BASE_URL}/${HOME.hostId}/network/sites/${HOME.siteId}`;
  const cases: [string, string][] = [
    ["site", site],
    ["device", `${site}/devices/${HOME.apId}?clients=1`],
    ["wifi", `${site}/wifi/${HOME.guestWifiId}`],
    ["hotspot", `${site}/hotspot`],
    ["protect", `${BASE_URL}/${HOME.hostId}/protect`],
    ["camera", `${BASE_URL}/${HOME.hostId}/protect/cameras/${HOME.doorbellId}`],
    ["sensor", `${BASE_URL}/${HOME.hostId}/protect/sensors/${HOME.sensorId}`],
    ["light", `${BASE_URL}/${HOME.hostId}/protect/lights/${HOME.lightId}`],
  ];

  it.each(cases)("mints a %s", async (kind, url) => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [url]))
      .toEqual({ ok: UNIFI_RESOURCES[kind as keyof typeof UNIFI_RESOURCES] });
  });

  it("refuses a console the connection doesn't reach", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${OFFICE_HOST}/protect`]))
      .toEqual({ error: "This UniFi connection doesn't reach that console." });
  });

  it("refuses a console the account administers, which the Cloud Connector won't proxy to", async () => {
    const { unifi } = installFake();
    unifi.cloud.get([...unifi.cloud.keys()][0]!)!.administered = [{ console: office(), permissions: { "network.management": ["admin"] } }];
    const accountId = await connectCloud();
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${OFFICE_HOST}/network/sites/${HOME.siteId}`]))
      .toEqual({ error: "UniFi only lets a console's owner reach it through the cloud. Connect it directly instead." });
  });

  it("refuses an application the console doesn't run", async () => {
    const { unifi } = installFake();
    const networkOnly = homeConsole();
    networkOnly.protect = null;
    unifi.addDirectConsole("https://gateway.home.example", networkOnly, LOCAL_KEY);
    const accountId = await connectDirect({ consoleUrl: "https://gateway.home.example" });
    const consoleId = await directConsoleId(accountId);
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${consoleId}/protect`]))
      .toEqual({ error: "This UniFi connection can't use UniFi Protect on that console." });
  });

  it("asks a console whose installed apps Site Manager doesn't list whether it runs one", async () => {
    // Its supported list says Network only, but that's what could run, not what does: still offered, then asked.
    const { unifi } = installFake();
    const networkOnly = homeConsole();
    networkOnly.protect = null;
    unifi.cloud.get([...unifi.cloud.keys()][0]!)!.owned = [networkOnly];
    unifi.hidesInstalledApps = true;
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.protect.id, "listConsoles", [""])).toMatchObject({ ok: [{ value: HOME.hostId }] });
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${HOME.hostId}/protect`]))
      .toEqual({ error: "That console doesn't run UniFi Protect." });
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${HOME.hostId}/network/sites/${HOME.siteId}`]))
      .toMatchObject({ ok: { id: "site" } });
  });

  it("doesn't offer or connect an owned cloud console's application it doesn't run", async () => {
    // Owning a console grants every application, including ones it doesn't run.
    const { unifi } = installFake();
    const networkOnly = homeConsole();
    networkOnly.protect = null;
    unifi.cloud.get([...unifi.cloud.keys()][0]!)!.owned = [networkOnly];
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.protect.id, "listConsoles", [""])).toEqual({ ok: [] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.id, "listConsoles", [""]))
      .toMatchObject({ ok: [{ value: HOME.hostId }] });
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/${HOME.hostId}/protect`]))
      .toEqual({ error: "That console doesn't run UniFi Protect." });
  });

  it("refuses a URL that leaves an ID for the user to choose", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${BASE_URL}/-/protect`]))
      .toEqual({ error: "This URL doesn't say which console to use; choose one when connecting." });
    expect(await hooks().user(accountId, "getGatekeeperClassFor", [`${site}/devices/-`]))
      .toEqual({ error: "This URL doesn't say which device to use; choose one when connecting." });
  });

  it("refuses what isn't a UniFi resource URL", async () => {
    installFake();
    const accountId = await connectCloud();
    const result = await hooks().user(accountId, "getGatekeeperClassFor", ["https://example.com/consoles/x/protect"]);
    expect(result).toEqual({ error: "UniFi resource URLs start with https://unifi.ui.com." });
  });
});

/** Registers a cloud collaborator who administers the home console with `permissions`. */
function addAdmin(unifi: FakeUnifi, key: string, permissions: Record<string, string[]>): void {
  unifi.addCloudKey(key, {
    email: "alex@example.com", fullName: "Alex", owned: [],
    administered: [{ console: [...unifi.cloud.values()][0]!.owned[0]!, permissions }],
  });
}

describe("checking collaborators", () => {
  const ALEX_KEY = "alex-key-0123456789abcdefABCDEF";
  const SAM_KEY = "sam-key-0123456789abcdefABCDEF";
  const ALEX_NEW_KEY = "alex-new-key-0123456789abcdefAB";

  /** The home console reached directly by its owner, and by Sam with a key of Sam's own. */
  async function ownerAndSamDirect(unifi: FakeUnifi) {
    unifi.direct.get(CONSOLE_URL)!.keys.add(SAM_KEY);
    const owner = await connectDirect();
    const sam = await connectDirect({ localApiKey: SAM_KEY });
    return { owner, sam, consoleId: await directConsoleId(owner) };
  }

  it("admits nothing for a collaborator who only administers the console through the cloud", async () => {
    // Site Manager says their role grants the application, but not which sites or cameras it
    // covers, and the Cloud Connector won't let a console's administrator ask the console.
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"], "protect.management": ["admin"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    expect(await verify(binding(owner, RESOURCES.site), alex)).toEqual(DENIED);
    expect(await verify(binding(owner, RESOURCES.protect), alex)).toEqual(DENIED);
    expect(await verify(binding(owner, RESOURCES.camera(HOME.doorbellId)), alex)).toEqual(DENIED);
  });

  it("refuses a collaborator whose UniFi account can't see the console", async () => {
    const { unifi } = installFake();
    unifi.addCloudKey(SAM_KEY, { email: "sam@example.com", fullName: "Sam", owned: [office()] });
    const owner = await connectCloud();
    const sam = await connectCloud(SAM_KEY);
    const site = binding(owner, RESOURCES.site);
    expect(await verify(site, sam)).toEqual(DENIED);
  });

  it("admits a collaborator who owns a console its owner connected directly, matching it by MAC", async () => {
    const { unifi, console } = installFake();
    unifi.addCloudKey(ALEX_KEY, { email: "alex@example.com", fullName: "Alex", owned: [console] });
    const owner = await connectDirect();
    const alex = await connectCloud(ALEX_KEY);
    const consoleId = await directConsoleId(owner);
    expect(await verify(binding(owner, { kind: "protect", consoleId }), alex)).toEqual(ALLOWED);
    expect(await verify(binding(owner, { kind: "site", consoleId, siteId: HOME.siteId }), alex)).toEqual(ALLOWED);
  });

  it("admits a collaborator who owns the console, through the cloud, to each camera their key can open", async () => {
    const { unifi, console } = installFake();
    unifi.addCloudKey(ALEX_KEY, { email: "alex@example.com", fullName: "Alex", owned: [console] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    const before = unifi.calls.length;
    expect(await verify(binding(owner, RESOURCES.camera(HOME.doorbellId)), alex)).toEqual(ALLOWED);
    const probe = unifi.calls.slice(before).find(call => call.headers["x-api-key"] === ALEX_KEY && call.url.includes("/cameras/"));
    expect(probe?.url).toBe(`https://api.ui.com/v1/connector/consoles/${HOME.hostId}/proxy/protect/integration/v1/cameras/${HOME.doorbellId}`);
  });

  it("refuses a direct collaborator a camera their own role can't see, and any listing that showed it", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, [`/v1/cameras/${HOME.doorbellId}`]]]);
    const protect = binding(owner, { kind: "protect", consoleId });
    const camera = (id: string) => `${appSubresource(protect.props.resource)}/camera/${id}`;
    expect(await verify(protect, sam, [camera(HOME.ptzId)])).toEqual(ALLOWED);
    expect(await verify(protect, sam, [camera(HOME.doorbellId)])).toEqual(DENIED);
    expect(await verify(protect, sam, [camera(HOME.doorbellId), camera(HOME.ptzId)])).toEqual(DENIED);
    expect(await verify(binding(owner, { kind: "camera", consoleId, cameraId: HOME.doorbellId }), sam)).toEqual(DENIED);
  });

  it("checks a Protect listing's list apart from the devices it shows, which can be allowed separately", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, ["/v1/cameras"]]]);
    const protect = binding(owner, { kind: "protect", consoleId });
    const app = appSubresource(protect.props.resource);
    expect(await verify(protect, sam, [`${app}/camera/${HOME.doorbellId}`])).toEqual(ALLOWED);
    expect(await verify(protect, sam, [`${app}/list/cameras`, `${app}/camera/${HOME.doorbellId}`])).toEqual(DENIED);
    expect(await verify(protect, sam, [`${app}/list/sensors`])).toEqual(ALLOWED);
  });

  it("checks the application's own information, such as its version, at its info endpoint", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, ["/v1/meta/info"]]]);
    const protect = binding(owner, { kind: "protect", consoleId });
    const app = appSubresource(protect.props.resource);
    expect(await verify(protect, sam, [`${app}/nvr/${HOME.nvrId}`])).toEqual(ALLOWED);
    expect(await verify(protect, sam, [`${app}/nvr/${HOME.nvrId}`, app])).toEqual(DENIED);
  });

  it("checks a camera's images apart from its details, which can be allowed separately", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, [`/v1/cameras/${HOME.doorbellId}/snapshot`]]]);
    const doorbell = binding(owner, { kind: "camera", consoleId, cameraId: HOME.doorbellId });
    const at = (kind: string) => `${appSubresource(doorbell.props.resource)}/${kind}/${HOME.doorbellId}`;
    expect(await verify(doorbell, sam, [at("camera")])).toEqual(ALLOWED);
    expect(await verify(doorbell, sam, [at("camera"), at("snapshot")])).toEqual(DENIED);
    expect(await verify(doorbell, sam, [at("packageSnapshot")])).toEqual(DENIED);
  });

  it("checks a WiFi password and voucher codes against what the collaborator's own key can read", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, [`/v1/sites/${HOME.siteId}/wifi/broadcasts/${HOME.guestWifiId}`]]]);
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    const app = appSubresource(site.props.resource);
    expect(await verify(site, sam)).toEqual(ALLOWED);
    expect(await verify(site, sam, [`${app}/site/${HOME.siteId}/wifi/${HOME.guestWifiId}`])).toEqual(DENIED);
    expect(await verify(site, sam, [`${app}/site/${HOME.siteId}/wifi/${HOME.homeWifiId}`])).toEqual(ALLOWED);
    expect(await verify(site, sam, [`${app}/vouchers/${HOME.siteId}`])).toEqual(ALLOWED);
  });

  it("checks each kind of site data against what the collaborator's own key can read there", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.refused = new Map([[SAM_KEY, [
      `/v1/sites/${HOME.siteId}/clients`, `/v1/sites/${HOME.siteId}/devices/${HOME.apId}/statistics/latest`,
    ]]]);
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    const app = appSubresource(site.props.resource);
    expect(await verify(site, sam, [`${app}/devices/${HOME.siteId}`])).toEqual(ALLOWED);
    expect(await verify(site, sam, [`${app}/clients/${HOME.siteId}`])).toEqual(DENIED);
    // A device's details and its statistics are routes of their own, allowed apart from the list.
    expect(await verify(site, sam, [`${app}/site/${HOME.siteId}/device/${HOME.apId}`])).toEqual(ALLOWED);
    expect(await verify(site, sam, [`${app}/site/${HOME.siteId}/deviceStatistics/${HOME.apId}`])).toEqual(DENIED);
    // A site past the first page of their site list still counts.
    const crowd = Array.from({ length: 250 }, (_, i) => ({
      ...homeConsole().network!.sites[0]!, site: { id: `88f7af54-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Site ${i}`, internalReference: `s${i}` },
    }));
    unifi.direct.get(CONSOLE_URL)!.console.network!.sites.unshift(...crowd);
    expect(await verify(site, sam)).toEqual(ALLOWED);
    // A site the collaborator's key doesn't list is one their role doesn't cover.
    const elsewhere = binding(owner, { kind: "site", consoleId, siteId: "5f0ee1aa-0000-4000-8000-ffffffffffff" });
    expect(await verify(elsewhere, sam)).toEqual(DENIED);
  });

  it("admits a direct collaborator at the owner's console URL, proving access with their own key", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    const camera = binding(owner, { kind: "camera", consoleId, cameraId: HOME.doorbellId });
    const before = unifi.calls.length;
    expect(await verify(camera, sam)).toEqual(ALLOWED);
    const probe = unifi.calls.slice(before).find(call => call.headers["x-api-key"] === SAM_KEY);
    expect(probe?.url).toBe(`${CONSOLE_URL}/proxy/protect/integration/v1/cameras/${HOME.doorbellId}`);
  });

  it("refuses a direct collaborator whose server only claims to be the console", async () => {
    // A server the collaborator runs can report any MAC address, and a console's is no secret:
    // it opens the console's host ID, which every cloud resource URL contains.
    const { unifi } = installFake();
    unifi.addDirectConsole("https://impostor.example", homeConsole(), SAM_KEY);
    const cloudOwner = await connectCloud();
    const { owner: directOwner, consoleId } = await ownerAndSamDirect(unifi);
    const impostor = await connectDirect({ consoleUrl: "https://impostor.example", localApiKey: SAM_KEY });
    expect((await account(impostor).identity() as { macs: string[] }).macs).toContain("70:a7:41:97:83:ed");
    const viaCloud = binding(cloudOwner, RESOURCES.site);
    expect(await verify(viaCloud, impostor)).toEqual(DENIED);
    const viaDirect = binding(directOwner, { kind: "site", consoleId, siteId: HOME.siteId });
    expect(await verify(viaDirect, impostor)).toEqual(DENIED);
  });

  it("refuses a direct collaborator to a binding made through the cloud, which no URL ties it to", async () => {
    installFake();
    const owner = await connectCloud();
    const direct = await connectDirect();
    const site = binding(owner, RESOURCES.site);
    expect(await verify(site, direct)).toEqual(DENIED);
  });

  it("can't check a collaborator whose key the console no longer accepts, rather than calling it no access", async () => {
    // An expired or revoked key says nothing about what its account may read.
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.keys.delete(SAM_KEY);
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    expect(await verify(site, sam)).toHaveProperty("error");
    expect(await verify(binding(owner, { kind: "camera", consoleId, cameraId: HOME.doorbellId }), sam)).toHaveProperty("error");
  });

  it("checks each voucher code by finding that voucher, not any code on the site", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    const hotspot = binding(owner, { kind: "hotspot", consoleId, siteId: HOME.siteId });
    const code = (voucherId: string) => `${appSubresource(hotspot.props.resource)}/site/${HOME.siteId}/voucherCode/${voucherId}`;
    expect(await verify(hotspot, sam, [code(HOME.voucherId)])).toEqual(ALLOWED);
    // One the collaborator's key doesn't find, though another voucher's code is on the site.
    expect(await verify(hotspot, sam, [code(HOME.voucherId), code("5f0ee1aa-0000-4000-8000-ffffffffffff")])).toEqual(DENIED);
  });

  it("reports a check that couldn't be made, rather than calling it a refusal", async () => {
    const { unifi, console } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    console.offline = true;
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    const result = await verify(site, sam) as { error: string };
    expect(result.error).toMatch(/reach|respond|offline/i);
  });

  it("refuses a collaborator whose connection was removed", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    await account(alex).revoke();
    const site = binding(owner, RESOURCES.site);
    expect(await verify(site, alex)).toEqual(DENIED);
  });

  it("refuses to check anything but what the binding's reads report", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"], "protect.management": ["viewer"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    const site = binding(owner, RESOURCES.site);
    const app = appSubresource(RESOURCES.site);
    expect(await verify(site, alex, [app, appSubresource(RESOURCES.protect)])).toHaveProperty("error");
    expect(await verify(site, alex, [`console/${encodeURIComponent(OFFICE_HOST)}/app/network`])).toHaveProperty("error");
    expect(await verify(site, alex, [`${app}/site/another-site/wifi/${HOME.guestWifiId}`])).toHaveProperty("error");
    expect(await verify(site, alex, [`${app}/camera/${HOME.doorbellId}`])).toHaveProperty("error");
    const doorbell = binding(owner, RESOURCES.camera(HOME.doorbellId));
    expect(await verify(doorbell, alex, [describeSubresource(RESOURCES.camera(HOME.ptzId))])).toHaveProperty("error");
    expect(await verify(doorbell, alex, [appSubresource(RESOURCES.protect)])).toHaveProperty("error");
  });

  it("answers for no one when the collaborator reconnects with another key during the check", async () => {
    // Each probe's answer has to come from the same key, or two keys that each see part of what
    // was read would together pass for one that sees all of it.
    const { unifi, console } = installFake();
    unifi.addCloudKey(ALEX_KEY, { email: "alex@example.com", fullName: "Alex", owned: [console] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    const release = holdRequestsWith(unifi, ALEX_KEY);
    const checking = verify(binding(owner, RESOURCES.camera(HOME.doorbellId)), alex);
    unifi.addCloudKey(ALEX_NEW_KEY, { ...unifi.cloud.get(ALEX_KEY)! });
    await reconnectCloud(alex, ALEX_NEW_KEY);
    release();
    expect(await checking).toMatchObject({ error: expect.stringMatching(/reconnected/) });
  });

  it("sends nothing more with a replaced key once a reconnect lands, so nothing it loads is cached for the new one", async () => {
    const { unifi, console } = installFake();
    unifi.addCloudKey(ALEX_KEY, { email: "alex@example.com", fullName: "Alex", owned: [console] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    const protect = binding(owner, RESOURCES.protect);
    const cameras = ["a", "b", "c", "d", "e", "f", "g"].map(n => `${appSubresource(RESOURCES.protect)}/camera/66d025b30096e903e40005a${n}`);
    const release = holdRequestsWith(unifi, ALEX_KEY);
    const checking = verify(protect, alex, cameras);
    unifi.addCloudKey(ALEX_NEW_KEY, { ...unifi.cloud.get(ALEX_KEY)! });
    await reconnectCloud(alex, ALEX_NEW_KEY);
    const before = unifi.calls.length;
    release();
    expect(await checking).toMatchObject({ error: expect.stringMatching(/reconnected/) });
    // Only the Site Manager lookup that was already on its way went out with the old key.
    expect(unifi.calls.slice(before).filter(call => call.headers["x-api-key"] === ALEX_KEY)).toHaveLength(1);
  });

  it("can't check anyone once the owner's connection no longer reaches the console", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    await account(owner).revoke();
    const site = binding(owner, RESOURCES.site);
    expect(await verify(site, alex)).toMatchObject({ error: expect.stringMatching(/can no longer see its console/) });
  });

  it("leaves admission to those checks: adding an observer checks nothing", async () => {
    const { unifi } = installFake();
    unifi.addCloudKey(SAM_KEY, { email: "sam@example.com", fullName: "Sam", owned: [office()] });
    const owner = await connectCloud();
    const sam = await connectCloud(SAM_KEY);
    const site = binding(owner, RESOURCES.site);
    const before = unifi.calls.length;
    expect(await hooks().addObserver(site.name, site.props, sam)).toEqual({ ok: undefined });
    expect(unifi.calls.length).toBe(before);
  });
});

describe("the resource pickers", () => {
  it("offers only consoles the connection can reach with the application", async () => {
    const { unifi } = installFake();
    unifi.cloud.get([...unifi.cloud.keys()][0]!)!.administered = [{ console: office(), permissions: { "network.management": ["admin"] } }];
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.id, "listConsoles", [""]))
      .toEqual({ ok: [{ value: HOME.hostId, title: "Dream Machine Pro", subtitle: "Network and Protect" }] });
    // A Workshop that predates resource type IDs names the type by its URL pattern.
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.urlPattern, "listConsoles", [""]))
      .toEqual(await hooks().pick(accountId, UNIFI_RESOURCES.site.id, "listConsoles", [""]));
  });

  it("lists a site's devices and WiFi networks, filtered by what the user typed", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.id, "listSites", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.siteId, title: "Default", meta: "default" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.device.id, "listDevices", [HOME.hostId, HOME.siteId, "garage"]))
      .toEqual({ ok: [{ value: HOME.switchId, title: "Garage Switch", subtitle: "USWLITE8POE", meta: "online" }] });
    const wifi = await hooks().pick(accountId, UNIFI_RESOURCES.wifi.id, "listWifiNetworks", [HOME.hostId, HOME.siteId, ""]) as { ok: { title: string }[] };
    expect(wifi.ok.map(w => w.title)).toEqual(["Home", "Guest", "Things"]);
  });

  it("lists cameras, sensors, and floodlights", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.camera.id, "listCameras", [HOME.hostId, "drive"]))
      .toEqual({ ok: [{ value: HOME.ptzId, title: "Driveway", subtitle: "G5 PTZ", meta: "connected" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.sensor.id, "listSensors", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.sensorId, title: "Garage Door", subtitle: "door", meta: "connected" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.light.id, "listLights", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.lightId, title: "Backyard Floodlight", subtitle: "UP FloodLight", meta: "connected" }] });
  });

  it("asks for a console before listing anything in one", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.camera.id, "listCameras", ["-", ""]))
      .toEqual({ error: "Choose a console first." });
  });
});

describe("the account's egress", () => {
  it.each([401, 403] as const)(
    "explains a change refused with %i to a key that may only read, without calling the key expired",
    async status => {
      const { unifi } = installFake();
      const accountId = await connectCloud();
      [...unifi.cloud.values()][0]!.writesRefusedWith = status;
      const ap = binding(accountId, RESOURCES.device(HOME.apId));
      await ap.call("restart");
      const { actionId } = (await ap.queue()).submitted[0]!;
      const refusal = await ap.applyOutcome(actionId) as { error: string };
      expect(refusal.error).toMatch(/^UniFi didn't let this API key make the change\. Site Manager API keys can be read-only/);
      // Still pending, so it can be approved again once the key can make changes.
      expect(await ap.applyOutcome(actionId)).toEqual(refusal);
      expect((await hooks().callbackLog(accountId)).expired).toBe(0);
      expect(await ap.call("describe")).toMatchObject({ name: "Living Room AP" });
    });

  it("shares one cache between bindings to the same console", async () => {
    const { console } = installFake();
    const accountId = await connectCloud();
    await binding(accountId, RESOURCES.site).call("listDevices");
    await binding(accountId, RESOURCES.site).call("listDevices");
    expect(console.calls.filter(c => c.path.endsWith("/devices"))).toHaveLength(1);
  });

  it("stops sending to a console the Cloud Connector has rate limited, until it says to retry", async () => {
    const { unifi } = installFake();
    const accountId = await connectCloud();
    unifi.connectorLimit = 0;
    const site = binding(accountId, RESOURCES.site);
    expect(await site.failure("listDevices")).toBe("The UniFi console is getting too many requests; retry in 6 seconds.");
    const sent = unifi.calls.length;
    expect(await site.failure("listClients")).toMatch(/^The UniFi console is getting too many requests; retry in \d seconds\.$/);
    expect(unifi.calls.length).toBe(sent);
  });
});
