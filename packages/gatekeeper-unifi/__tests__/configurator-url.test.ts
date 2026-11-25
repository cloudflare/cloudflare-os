// Every picker copies the resource URL grammar from resources.ts, because each is compiled on its
// own and can't import it. These tests keep the copies in step with the parser that actually mints
// the capability: what a picker builds parses to what was chosen, what an agent requests prefills
// the picker, and an agent's `-` placeholder leaves the field (and everything under it) for the
// user to choose.

import { describe, expect, it } from "vitest";
import type { ConfiguratorUISpec } from "@gadgets/configurator-ui";
import { buildResourceUrl, parseResourceUrl, UNIFI_RESOURCES, type UnifiResource } from "../src/resources";
import site from "../src/configurator/unifi-site-configurator-ui.js";
import device from "../src/configurator/unifi-device-configurator-ui.js";
import wifi from "../src/configurator/unifi-wifi-configurator-ui.js";
import hotspot from "../src/configurator/unifi-hotspot-configurator-ui.js";
import protect from "../src/configurator/unifi-protect-configurator-ui.js";
import camera from "../src/configurator/unifi-camera-configurator-ui.js";
import sensor from "../src/configurator/unifi-sensor-configurator-ui.js";
import light from "../src/configurator/unifi-light-configurator-ui.js";

type Values = Record<string, string | null | undefined>;
type Picker = ConfiguratorUISpec<never, Values>;

const ui = new Proxy({}, { get() { throw new Error("URL handling must not call the ui capability"); } }) as never;
/** Lists whatever ID it's asked about, named after it: a gatekeeper that reaches every resource. */
const offering = (title: (id: string) => string | null = id => `Name of ${id}`) =>
  new Proxy({}, {
    get: () => async (...args: string[]) => {
      const id = args.at(-1)!;
      const name = title(id);
      return name === null ? [] : [{ value: id, title: name }];
    },
  }) as never;
const CONSOLE = "70A7419783ED0000000006797F060000000006C719490000000062ABD4EA:1261206302";
const SITE = "88f7af54-98f8-306a-a1c7-c9349722b1f6";

const CASES: [string, Picker, Values, UnifiResource][] = [
  ["site", site as Picker, { consoleId: CONSOLE, siteId: SITE },
    { kind: "site", consoleId: CONSOLE, siteId: SITE }],
  ["device", device as Picker, { consoleId: CONSOLE, siteId: SITE, deviceId: "dev-1", clients: null },
    { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "dev-1", clients: false }],
  ["device with clients", device as Picker, { consoleId: CONSOLE, siteId: SITE, deviceId: "dev-1", clients: "1" },
    { kind: "device", consoleId: CONSOLE, siteId: SITE, deviceId: "dev-1", clients: true }],
  ["wifi", wifi as Picker, { consoleId: CONSOLE, siteId: SITE, wifiNetworkId: "wifi-1" },
    { kind: "wifi", consoleId: CONSOLE, siteId: SITE, wifiNetworkId: "wifi-1" }],
  ["hotspot", hotspot as Picker, { consoleId: CONSOLE, siteId: SITE },
    { kind: "hotspot", consoleId: CONSOLE, siteId: SITE }],
  ["protect", protect as Picker, { consoleId: "local-0123456789abcdef" },
    { kind: "protect", consoleId: "local-0123456789abcdef" }],
  ["camera", camera as Picker, { consoleId: CONSOLE, cameraId: "66d025b30096e903e4000500" },
    { kind: "camera", consoleId: CONSOLE, cameraId: "66d025b30096e903e4000500" }],
  ["sensor", sensor as Picker, { consoleId: CONSOLE, sensorId: "66d025b30096e903e4000600" },
    { kind: "sensor", consoleId: CONSOLE, sensorId: "66d025b30096e903e4000600" }],
  ["light", light as Picker, { consoleId: CONSOLE, lightId: "66d025b30096e903e4000700" },
    { kind: "light", consoleId: CONSOLE, lightId: "66d025b30096e903e4000700" }],
];

function prefill(picker: Picker, resourceUrl: string, kind: UnifiResource["kind"], lists: never = offering()) {
  return picker.initialValuesFromResourceUrl!({ resourceUrl, resourceUrlPattern: UNIFI_RESOURCES[kind].urlPattern, ui: lists });
}

describe.each(CASES)("the %s picker", (_name, picker, values, resource) => {
  it("builds the URL resources.ts parses to the choice", async () => {
    const url = await picker.resourceUrl({ values, ui });
    expect(url).toBe(buildResourceUrl(resource));
    expect(parseResourceUrl(url)).toEqual(resource);
  });

  it("prefills from the URL an agent requested, naming what it filled in", async () => {
    const seeded = await prefill(picker, buildResourceUrl(resource), resource.kind);
    expect(seeded).toEqual({ ...values, prefilled: expect.stringContaining(`console “Name of ${values.consoleId}”`) });
    for (const [key, id] of Object.entries(values)) {
      if (key !== "clients") expect(seeded.prefilled).toContain(`“Name of ${id}”`);
    }
  });

  it("is ready only once everything is chosen", () => {
    expect(picker.isReady!({ values })).toBe(true);
    expect(picker.isReady!({ values: { ...values, consoleId: null } })).toBe(false);
  });

  it("refuses to build a URL with nothing chosen", async () => {
    expect(() => picker.resourceUrl({ values: picker.initial, ui })).toThrow(/Choose/);
  });

  it("leaves a `-` placeholder, and everything under it, for the user to choose", async () => {
    const placeholders = buildResourceUrl({
      ...resource, consoleId: "-",
      ...("siteId" in resource && { siteId: "x" }), ...("deviceId" in resource && { deviceId: "x" }),
    } as UnifiResource);
    const seeded = await prefill(picker, placeholders, resource.kind);
    for (const [key, value] of Object.entries(seeded)) {
      if (key !== "clients") expect(value, key).toBeNull();
    }
  });
});

describe("placeholders below a known console", () => {
  it("keeps the console and asks for the rest", async () => {
    expect(await prefill(device as Picker,
      `https://unifi.ui.com/consoles/${CONSOLE}/network/sites/${SITE}/devices/-?clients=1`, "device"))
      .toEqual({
        consoleId: CONSOLE, siteId: SITE, clients: "1",
        prefilled: `console “Name of ${CONSOLE}”, site “Name of ${SITE}”`,
      });
    expect(await prefill(camera as Picker, `https://unifi.ui.com/consoles/${CONSOLE}/protect/cameras/-`, "camera"))
      .toEqual({ consoleId: CONSOLE, prefilled: `console “Name of ${CONSOLE}”` });
  });

  it("leaves an ID its list doesn't offer, and everything under it, for the user to choose", async () => {
    // The form shows a pre-filled ID rather than its name, so one that can't be named isn't filled in.
    const url = `https://unifi.ui.com/consoles/${CONSOLE}/network/sites/${SITE}/devices/dev-1`;
    expect(await prefill(device as Picker, url, "device", offering(id => id === CONSOLE ? "Home" : null)))
      .toEqual({ consoleId: CONSOLE, clients: null, prefilled: "console “Home”" });
    const failing = new Proxy({}, { get: () => () => Promise.reject(new Error("offline")) }) as never;
    expect(await prefill(device as Picker, url, "device", failing)).toEqual({ clients: null });
  });

  it("fills in an ID as its list spells it", async () => {
    const lists = new Proxy({}, {
      get: () => async (...args: string[]) => {
        const id = args.at(-1)!;
        return [{ value: id.toLowerCase() === SITE ? SITE : id, title: "Default" }];
      },
    }) as never;
    const seeded = await prefill(site as Picker,
      `https://unifi.ui.com/consoles/${CONSOLE}/network/sites/${SITE.toUpperCase()}`, "site", lists);
    expect(seeded.siteId).toBe(SITE);
  });

  it("ignores a URL for another kind of resource", async () => {
    expect(await prefill(camera as Picker, `https://unifi.ui.com/consoles/${CONSOLE}/protect/sensors/abc`, "camera")).toEqual({});
  });
});
