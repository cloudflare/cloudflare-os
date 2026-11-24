// Discovering what a connection reaches: a cloud key's consoles, and a direct connection's console,
// whose MAC addresses match it across connections.

import { describe, expect, it } from "vitest";
import {
  cloudConsoleSummary, listSiteManagerConsoles, probeDirectConsole, sameConsole,
} from "../src/consoles";
import { UnifiError } from "../src/errors";
import { sendUnifiRequest, type UnifiCredentials } from "../src/transport";
import { FakeConsole, FakeUnifi, HOME, homeConsole } from "./fake-unifi";

const CLOUD: UnifiCredentials = { mode: "cloud", apiKey: "cloud-key-0123456789abcdef" };
const DIRECT: UnifiCredentials = { mode: "direct", baseUrl: "https://192.168.1.1", apiKey: "local-key-0123456789abcdef" };

describe("Site Manager consoles", () => {
  it("lists every page of a cloud account's consoles, owned and administered", async () => {
    const unifi = new FakeUnifi();
    const owned = Array.from({ length: 130 }, (_, i) => {
      const console = new FakeConsole(`Console ${i}`, `${(0xa00000000000 + i).toString(16).toUpperCase()}000000:${i}`, (0xa00000000000 + i).toString(16));
      console.network = { version: "10.6.106", sites: [] };
      return console;
    });
    const administered = homeConsole();
    unifi.addCloudKey(CLOUD.apiKey, {
      email: "dan@example.com", fullName: "Dan", owned,
      administered: [{ console: administered, permissions: { "protect.management": ["viewer"] } }],
    });
    const consoles = await listSiteManagerConsoles(request => sendUnifiRequest(CLOUD, request, unifi.fetch));
    expect(consoles).toHaveLength(131);
    expect(unifi.calls.filter(call => call.url.includes("/v1/hosts"))).toHaveLength(2);
    const summary = cloudConsoleSummary(consoles.at(-1)!);
    expect(summary).toEqual({
      id: HOME.hostId, name: "Dream Machine Pro", apps: { network: true, protect: true }, appsKnown: true,
      permissions: { network: false, protect: true }, reachable: false, macs: ["70:a7:41:97:83:ed"],
    });
  });

  it("raises a rejected key as an auth error", async () => {
    const unifi = new FakeUnifi();
    await expect(listSiteManagerConsoles(request => sendUnifiRequest(CLOUD, request, unifi.fetch)))
      .rejects.toMatchObject({ kind: "auth" });
  });
});

describe("probing a console directly", () => {
  it("learns the console's apps, name, and MACs from Protect and the Network gateway", async () => {
    const unifi = new FakeUnifi().addDirectConsole("https://192.168.1.1", homeConsole(), DIRECT.apiKey);
    const facts = await probeDirectConsole(request => sendUnifiRequest(DIRECT, request, unifi.fetch));
    expect(facts).toEqual({
      name: "Dream Machine Pro", apps: { network: true, protect: true }, macs: ["70:a7:41:97:83:ed"],
      // Each application's own identity: the NVR for Protect, the gateway for Network.
      appMacs: { network: ["70:a7:41:97:83:ed"], protect: ["70:a7:41:97:83:ed"] },
      networkVersion: "10.6.106", protectVersion: "7.3.70",
    });
  });

  it("names a Network-only console after its gateway", async () => {
    const console = homeConsole();
    console.protect = null;
    const unifi = new FakeUnifi().addDirectConsole("https://192.168.1.1", console, DIRECT.apiKey);
    const facts = await probeDirectConsole(request => sendUnifiRequest(DIRECT, request, unifi.fetch));
    expect(facts).toMatchObject({ name: "UDM Pro", apps: { network: true, protect: false }, macs: ["70:a7:41:97:83:ed"] });
  });

  it("reports the most telling failure when nothing answers", async () => {
    const unifi = new FakeUnifi().addDirectConsole("https://192.168.1.1", homeConsole(), "another-key-0123456789");
    await expect(probeDirectConsole(request => sendUnifiRequest(DIRECT, request, unifi.fetch)))
      .rejects.toSatisfy(error => error instanceof UnifiError && error.kind === "auth");
    await expect(probeDirectConsole(request => sendUnifiRequest({ ...DIRECT, baseUrl: "https://nowhere.example" }, request, unifi.fetch)))
      .rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("matching consoles", () => {
  it("matches by any shared MAC, however it is spelled", () => {
    expect(sameConsole(["70A7419783ED"], ["aa:bb:cc:dd:ee:ff", "70:a7:41:97:83:ed"])).toBe(true);
    expect(sameConsole(["70A7419783ED"], ["70:a7:41:97:83:ee"])).toBe(false);
    expect(sameConsole([], ["70:a7:41:97:83:ed"])).toBe(false);
  });
});

describe("console identity", () => {
  it("is proven only by a MAC address that names hardware", () => {
    expect(sameConsole(["70:a7:41:97:83:ed"], ["70A7419783ED"])).toBe(true);
    // Blank or placeholder addresses, which a console without one or a proxy gives, prove nothing.
    expect(sameConsole([""], [""])).toBe(false);
    expect(sameConsole(["00:00:00:00:00:00"], ["000000000000"])).toBe(false);
    expect(sameConsole(["not-a-mac"], ["not-a-mac"])).toBe(false);
  });

  it("leaves a blank NVR address out of what a direct console is known by", async () => {
    const console = homeConsole();
    console.protect!.nvr.mac = "";
    console.network = null;
    const unifi = new FakeUnifi().addDirectConsole("https://blank.example", console, "k-0123456789abcdef0123");
    const facts = await probeDirectConsole(request =>
      sendUnifiRequest({ mode: "direct", baseUrl: "https://blank.example", apiKey: "k-0123456789abcdef0123" }, request, unifi.fetch));
    expect(facts.macs).toEqual([]);
  });
});
