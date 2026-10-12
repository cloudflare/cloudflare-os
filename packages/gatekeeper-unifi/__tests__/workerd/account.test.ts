// The account as the Workshop holds it: which resources it will mint a gatekeeper for, which
// collaborators it admits as observers, what its resource pickers list, and how its one egress
// shares a console's request budget and cache between every binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { account, binding, connectCloud, connectDirect, CONSOLE_URL, hooks, installFake, LOCAL_KEY, RESOURCES } from "./helpers.js";
import { FakeConsole, HOME, homeConsole, type FakeUnifi } from "../fake-unifi.js";
import { UNIFI_RESOURCES } from "../../src/resources.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_URL = "https://unifi.ui.com/consoles";
const OFFICE_HOST = "AABBCCDDEEFF0000000006797F060000000006C719490000000062ABD4EB:1261206303";
const DENIED = "This collaborator's UniFi connection can't reach this console's application, so they can't see what this gadget read from it.";

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

  it("names a direct connection after its console and where it is", async () => {
    installFake();
    const accountId = await connectDirect();
    expect(await hooks().user(accountId, "describe"))
      .toMatchObject({ ok: { displayName: "Dream Machine Pro", uniqueName: "Dream Machine Pro at unifi.home.example" } });
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

describe("admitting observers", () => {
  const ALEX_KEY = "alex-key-0123456789abcdefABCDEF";
  const SAM_KEY = "sam-key-0123456789abcdefABCDEF";

  /** The home console reached directly by its owner, and by Sam with a key of Sam's own. */
  async function ownerAndSamDirect(unifi: FakeUnifi) {
    unifi.direct.get(CONSOLE_URL)!.keys.add(SAM_KEY);
    const owner = await connectDirect();
    const sam = await connectDirect({ localApiKey: SAM_KEY });
    return { owner, sam, consoleId: await directConsoleId(owner) };
  }

  it("admits a cloud collaborator to what their UniFi role covers, and nothing else", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    const site = binding(owner, RESOURCES.site);
    expect(await hooks().addObserver(site.name, site.props, alex)).not.toHaveProperty("error");
    const camera = binding(owner, RESOURCES.camera(HOME.doorbellId));
    expect(await hooks().addObserver(camera.name, camera.props, alex)).toEqual({ error: DENIED });
  });

  it("refuses a collaborator whose UniFi account can't see the console", async () => {
    const { unifi } = installFake();
    unifi.addCloudKey(SAM_KEY, { email: "sam@example.com", fullName: "Sam", owned: [office()] });
    const owner = await connectCloud();
    const sam = await connectCloud(SAM_KEY);
    const site = binding(owner, RESOURCES.site);
    expect(await hooks().addObserver(site.name, site.props, sam)).toEqual({ error: DENIED });
  });

  it("admits a cloud collaborator to a console the owner connected directly, matching it by MAC", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "protect.management": ["viewer"] });
    const owner = await connectDirect();
    const alex = await connectCloud(ALEX_KEY);
    const camera = binding(owner, { kind: "camera", consoleId: await directConsoleId(owner), cameraId: HOME.doorbellId });
    expect(await hooks().addObserver(camera.name, camera.props, alex)).not.toHaveProperty("error");
  });

  it("admits a direct collaborator at the owner's console URL, proving access with their own key", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    const camera = binding(owner, { kind: "camera", consoleId, cameraId: HOME.doorbellId });
    const before = unifi.calls.length;
    expect(await hooks().addObserver(camera.name, camera.props, sam)).not.toHaveProperty("error");
    const probe = unifi.calls.slice(before).find(call => call.headers["x-api-key"] === SAM_KEY);
    expect(probe?.url).toBe(`${CONSOLE_URL}/proxy/protect/integration/v1/meta/info`);
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
    expect(await hooks().addObserver(viaCloud.name, viaCloud.props, impostor)).toEqual({ error: DENIED });
    const viaDirect = binding(directOwner, { kind: "site", consoleId, siteId: HOME.siteId });
    expect(await hooks().addObserver(viaDirect.name, viaDirect.props, impostor)).toEqual({ error: DENIED });
  });

  it("refuses a direct collaborator to a binding made through the cloud, which no URL ties it to", async () => {
    installFake();
    const owner = await connectCloud();
    const direct = await connectDirect();
    const site = binding(owner, RESOURCES.site);
    expect(await hooks().addObserver(site.name, site.props, direct)).toEqual({ error: DENIED });
  });

  it("refuses a direct collaborator whose key the console no longer accepts", async () => {
    const { unifi } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    unifi.direct.get(CONSOLE_URL)!.keys.delete(SAM_KEY);
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    expect(await hooks().addObserver(site.name, site.props, sam)).toEqual({ error: DENIED });
  });

  it("reports a check that couldn't be made, rather than calling it a refusal", async () => {
    const { unifi, console } = installFake();
    const { owner, sam, consoleId } = await ownerAndSamDirect(unifi);
    console.offline = true;
    const site = binding(owner, { kind: "site", consoleId, siteId: HOME.siteId });
    const result = await hooks().addObserver(site.name, site.props, sam) as { error: string };
    expect(result.error).not.toBe(DENIED);
    expect(result.error).toMatch(/reach|respond|offline/i);
  });

  it("refuses a collaborator whose connection was removed", async () => {
    const { unifi } = installFake();
    addAdmin(unifi, ALEX_KEY, { "network.management": ["admin"] });
    const owner = await connectCloud();
    const alex = await connectCloud(ALEX_KEY);
    await account(alex).revoke();
    const site = binding(owner, RESOURCES.site);
    expect(await hooks().addObserver(site.name, site.props, alex)).toEqual({ error: DENIED });
  });
});

describe("the resource pickers", () => {
  it("offers only consoles the connection can reach with the application", async () => {
    const { unifi } = installFake();
    unifi.cloud.get([...unifi.cloud.keys()][0]!)!.administered = [{ console: office(), permissions: { "network.management": ["admin"] } }];
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.urlPattern, "listConsoles", [""]))
      .toEqual({ ok: [{ value: HOME.hostId, title: "Dream Machine Pro", subtitle: "Network and Protect" }] });
  });

  it("lists a site's devices and WiFi networks, filtered by what the user typed", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.site.urlPattern, "listSites", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.siteId, title: "Default", meta: "default" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.device.urlPattern, "listDevices", [HOME.hostId, HOME.siteId, "garage"]))
      .toEqual({ ok: [{ value: HOME.switchId, title: "Garage Switch", subtitle: "USWLITE8POE", meta: "online" }] });
    const wifi = await hooks().pick(accountId, UNIFI_RESOURCES.wifi.urlPattern, "listWifiNetworks", [HOME.hostId, HOME.siteId, ""]) as { ok: { title: string }[] };
    expect(wifi.ok.map(w => w.title)).toEqual(["Home", "Guest", "Things"]);
  });

  it("lists cameras, sensors, and floodlights", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.camera.urlPattern, "listCameras", [HOME.hostId, "drive"]))
      .toEqual({ ok: [{ value: HOME.ptzId, title: "Driveway", subtitle: "G5 PTZ", meta: "connected" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.sensor.urlPattern, "listSensors", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.sensorId, title: "Garage Door", subtitle: "door", meta: "connected" }] });
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.light.urlPattern, "listLights", [HOME.hostId, ""]))
      .toEqual({ ok: [{ value: HOME.lightId, title: "Backyard Floodlight", subtitle: "UP FloodLight", meta: "connected" }] });
  });

  it("asks for a console before listing anything in one", async () => {
    installFake();
    const accountId = await connectCloud();
    expect(await hooks().pick(accountId, UNIFI_RESOURCES.camera.urlPattern, "listCameras", ["-", ""]))
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
