// The contract with Ubiquiti's published API, checked against the OpenAPI documents vendored in
// ./openapi (refresh them with scripts/vendor-openapi.ts):
//
// - every request the gatekeeper can make names an operation the API documents, with that method;
// - every body it sends -- including exactly the bodies its actions build -- matches the schema;
// - every answer the fake console gives matches the schema, so the fake the other suites trust
//   can't drift into fiction.

import { beforeAll, describe, expect, it } from "vitest";
import { cameraPatch, guestLimitsBody, lightPatch, voucherBody, wifiPutBody } from "../src/actions";
import { UnifiApi } from "../src/api";
import { listSiteManagerConsoles } from "../src/consoles";
import { sendUnifiRequest, type UnifiCredentials } from "../src/transport";
import { FakeUnifi, HOME, homeConsole } from "./fake-unifi";
import { checkSchema, matchTemplate, requestSchema, responseSchema } from "./schema-check";
import NETWORK from "./openapi/network.json";
import PROTECT from "./openapi/protect.json";
import SITE_MANAGER from "./openapi/site-manager.json";

type Spec = { paths: Record<string, Record<string, Record<string, unknown>>>; components?: { schemas?: Record<string, Record<string, unknown>> } };

const CLOUD: UnifiCredentials = { mode: "cloud", apiKey: "cloud-key-0123456789abcdef" };

type Exchange = { method: string; url: URL; body?: unknown; status: number; json?: unknown };

/** Every request the gatekeeper's API surface can make, with the answers the fake gave. */
async function exerciseEverything(): Promise<Exchange[]> {
  const unifi = new FakeUnifi();
  const console = homeConsole();
  unifi.addCloudKey(CLOUD.apiKey, { email: "dan@example.com", fullName: "Dan", owned: [console] });
  const exchanges: Exchange[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await unifi.fetch(input, init);
    const request = new Request(input, init);
    const text = response.headers.get("Content-Type")?.includes("json") ? await response.clone().text() : "";
    exchanges.push({
      method: request.method, url: new URL(request.url),
      ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }),
      status: response.status, ...(text && { json: JSON.parse(text) }),
    });
    return response;
  };
  const send = (request: Parameters<typeof sendUnifiRequest>[1]) => sendUnifiRequest(CLOUD, request, recordingFetch);
  const api = new UnifiApi(send, HOME.hostId);

  await listSiteManagerConsoles(send);

  await api.networkInfo();
  await api.listSites();
  await api.listDevices(HOME.siteId);
  await api.getDevice(HOME.siteId, HOME.switchId);
  await api.getDeviceStatistics(HOME.siteId, HOME.apId);
  await api.restartDevice(HOME.siteId, HOME.apId);
  await api.powerCyclePort(HOME.siteId, HOME.switchId, 2);
  await api.listClients(HOME.siteId);
  await api.listClients(HOME.siteId, "access.type.eq('GUEST')");
  await api.getClient(HOME.siteId, HOME.guestId);
  await api.authorizeGuest(HOME.siteId, HOME.guestId,
    guestLimitsBody({ durationMinutes: 120, dataLimitMB: 500, downloadLimitKbps: 4000, uploadLimitKbps: 1000 }));
  await api.getClient(HOME.siteId, HOME.guestId);
  await api.revokeGuest(HOME.siteId, HOME.guestId);
  await api.listLanNetworks(HOME.siteId);
  await api.listWifiNetworks(HOME.siteId);
  for (const id of [HOME.homeWifiId, HOME.guestWifiId, HOME.iotWifiId]) {
    const raw = await api.getWifiRaw(HOME.siteId, id);
    await api.putWifi(HOME.siteId, id, wifiPutBody(raw, { name: "Renamed", enabled: true, hidden: false, passphrase: "new-passphrase" }));
  }
  await api.listVouchers(HOME.siteId);
  await api.createVouchers(HOME.siteId, voucherBody({
    count: 2, note: "Party", durationMinutes: 240, guestLimit: 3, dataLimitMB: 1024, downloadLimitKbps: 5000, uploadLimitKbps: 1000,
  }));
  await api.createVouchers(HOME.siteId, voucherBody({
    count: 1, note: "Plain", durationMinutes: 60, guestLimit: null, dataLimitMB: null, downloadLimitKbps: null, uploadLimitKbps: null,
  }));
  await api.deleteVoucher(HOME.siteId, HOME.voucherId);

  await api.protectInfo();
  await api.getNvr();
  await api.listCameras();
  await api.getCamera(HOME.doorbellId);
  for (const change of [
    { name: "Porch" },
    { statusLight: false },
    { doorbellMessage: { kind: "text" as const, text: "Back soon" }, until: 1_900_000_000_000 },
    { doorbellMessage: { kind: "doNotDisturb" as const }, until: null },
    { doorbellMessage: { kind: "leavePackageAtDoor" as const }, until: null },
  ]) {
    await api.patchCamera(HOME.doorbellId, cameraPatch(change));
  }
  await api.patchCamera(HOME.doorbellId, { micVolume: 55 });
  await api.snapshot(HOME.doorbellId, { highQuality: true, packageCamera: true });
  await api.ptzGoTo(HOME.ptzId, -1);
  await api.ptzGoTo(HOME.ptzId, 2);
  await api.ptzStartPatrol(HOME.ptzId, 1);
  await api.ptzStopPatrol(HOME.ptzId);
  await api.listSensors();
  await api.getSensor(HOME.sensorId);
  await api.listLights();
  await api.getLight(HOME.lightId);
  for (const change of [{ forcedOn: true }, { mode: "always" as const, activeWhen: "dark" as const }, { brightness: 5 }]) {
    await api.patchLight(HOME.lightId, lightPatch(change));
  }
  return exchanges;
}

/** Which vendored document, and which path within it, a request URL addresses. */
function locate(url: URL): { spec: Spec; path: string } {
  if (url.pathname === "/v1/hosts") return { spec: SITE_MANAGER as unknown as Spec, path: "/v1/hosts" };
  const match = /\/proxy\/(network|protect)\/integration(\/.*)$/.exec(url.pathname);
  if (!match) throw new Error(`Not an integration API URL: ${url}`);
  return { spec: (match[1] === "network" ? NETWORK : PROTECT) as unknown as Spec, path: match[2]! };
}

let exchanges: Exchange[];
beforeAll(async () => {
  exchanges = await exerciseEverything();
});

describe("the OpenAPI contract", () => {
  it("covers every vendored operation", () => {
    const used = new Set(exchanges.map(exchange => {
      const { spec, path } = locate(exchange.url);
      return `${spec === (SITE_MANAGER as unknown) ? "site-manager" : spec === (NETWORK as unknown) ? "network" : "protect"} ${exchange.method} ${matchTemplate(spec.paths, exchange.method, path)}`;
    }));
    const vendored = [["network", NETWORK], ["protect", PROTECT], ["site-manager", SITE_MANAGER]].flatMap(([name, spec]) =>
      Object.entries((spec as Spec).paths).flatMap(([path, methods]) =>
        Object.keys(methods).map(method => `${name} ${method.toUpperCase()} ${path}`)));
    expect([...used].toSorted()).toEqual(vendored.toSorted());
  });

  it("makes only requests the API documents", () => {
    for (const exchange of exchanges) {
      const { spec, path } = locate(exchange.url);
      expect(matchTemplate(spec.paths, exchange.method, path), `${exchange.method} ${path}`).toBeDefined();
    }
  });

  it("sends bodies that match the documented request schemas", () => {
    for (const exchange of exchanges.filter(e => e.body !== undefined)) {
      const { spec, path } = locate(exchange.url);
      const template = matchTemplate(spec.paths, exchange.method, path)!;
      const schema = requestSchema(spec, exchange.method, template);
      expect(schema, `${exchange.method} ${template} takes a body`).toBeDefined();
      expect(checkSchema(spec, schema!, exchange.body), `${exchange.method} ${template}: ${JSON.stringify(exchange.body)}`).toEqual([]);
    }
  });

  it("gets answers from the fake that match the documented response schemas", () => {
    for (const exchange of exchanges.filter(e => e.json !== undefined && e.status < 300)) {
      const { spec, path } = locate(exchange.url);
      const template = matchTemplate(spec.paths, exchange.method, path)!;
      const schema = responseSchema(spec, exchange.method, template);
      if (!schema) continue;
      expect(checkSchema(spec, schema, exchange.json), `${exchange.method} ${template}`).toEqual([]);
    }
  });

  it("never sends the console's documented read-only fields back", () => {
    const puts = exchanges.filter(e => e.method === "PUT");
    expect(puts).toHaveLength(3);
    for (const put of puts) {
      expect(put.body).not.toHaveProperty("id");
      expect(put.body).not.toHaveProperty("metadata");
    }
  });
});

describe("the schema checker", () => {
  it("catches a misnamed field, a wrong type, and a bad enumeration value", () => {
    const schema = requestSchema(NETWORK as unknown as Spec, "POST", "/v1/sites/{siteId}/hotspot/vouchers")!;
    expect(checkSchema(NETWORK as unknown as Spec, schema, { name: "x", timeLimitMinutes: 60 })).toEqual([]);
    expect(checkSchema(NETWORK as unknown as Spec, schema, { name: "x" })).toContain("$: missing required timeLimitMinutes");
    expect(checkSchema(NETWORK as unknown as Spec, schema, { name: "x", timeLimitMinutes: "60" })).not.toEqual([]);
    const action = requestSchema(NETWORK as unknown as Spec, "POST", "/v1/sites/{siteId}/clients/{clientId}/actions")!;
    expect(checkSchema(NETWORK as unknown as Spec, action, { action: "KICK" })).not.toEqual([]);
  });
});
