/**
 * The capabilities the resource pickers' iframes get: narrow, read-only listings of what the
 * connection can reach, for choosing a resource. They never hold the API key: requests go through
 * the account's egress, which each picker holds in a private field, out of RPC's reach.
 *
 * A picker calls these on every focus and keystroke, so each instance caches the lists it fetched
 * for the life of the picker, on top of the account's own short cache.
 */

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { UnifiApi } from "./api";
import type { ConsoleSummary, UnifiSend } from "./consoles";
import { isValidId } from "./resources";
import type {
  NetworkPickerRpc, PickerOption, ProtectPickerRpc,
} from "./configurator/unifi-configurator-types";

/** Where a picker's data comes from. */
export type PickerSource = {
  listConsoles(): Promise<ConsoleSummary[]>;
  send: UnifiSend;
};

const MAX_OPTIONS = 200;

function matches(option: PickerOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || option.title.toLowerCase().includes(q) || option.value.toLowerCase().includes(q);
}

/** What both pickers share: where their data comes from, and the lists they have loaded. */
class PickerLists {
  readonly #source: PickerSource;
  readonly #loaded = new Map<string, Promise<PickerOption[]>>();

  constructor(source: PickerSource) {
    this.#source = source;
  }

  /** Options for `key`, loaded once, filtered by what the user typed. */
  async options(key: string, query: string, load: () => Promise<PickerOption[]>): Promise<PickerOption[]> {
    let loaded = this.#loaded.get(key);
    if (!loaded) {
      loaded = load();
      this.#loaded.set(key, loaded);
      loaded.catch(() => this.#loaded.delete(key));
    }
    return (await loaded).filter(option => matches(option, query)).slice(0, MAX_OPTIONS);
  }

  /** The consoles where this connection can use `app`. */
  consoles(query: string, app: "network" | "protect"): Promise<PickerOption[]> {
    return this.options(`consoles:${app}`, query, async () =>
      (await this.#source.listConsoles())
        .filter(c => c.reachable && c.permissions[app])
        .map(c => ({ value: c.id, title: c.name, ...(c.apps.network && c.apps.protect && { subtitle: "Network and Protect" }) })));
  }

  /** The applications of the console the user chose. */
  api(consoleId: string): UnifiApi {
    if (!isValidId(consoleId)) throw new Error("Choose a console first.");
    return new UnifiApi(this.#source.send, consoleId);
  }
}

/** Lists for the site, device, WiFi network, and hotspot pickers. */
@validateRpc()
export class NetworkPickerUI extends RpcTarget implements NetworkPickerRpc {
  readonly #lists: PickerLists;

  constructor(source: PickerSource) {
    super();
    this.#lists = new PickerLists(source);
  }

  async listConsoles(query: string): Promise<PickerOption[]> {
    return this.#lists.consoles(query, "network");
  }

  async listSites(consoleId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`sites:${consoleId}`, query, async () =>
      (await this.#lists.api(consoleId).listSites()).map(site => ({
        value: site.id, title: site.name, ...(site.internalReference && { meta: site.internalReference }),
      })));
  }

  async listDevices(consoleId: string, siteId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`devices:${consoleId}:${siteId}`, query, async () =>
      (await this.#lists.api(consoleId).listDevices(siteId)).map(device => ({
        value: device.id, title: device.name, subtitle: device.model, meta: device.state,
      })));
  }

  async listWifiNetworks(consoleId: string, siteId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`wifi:${consoleId}:${siteId}`, query, async () =>
      (await this.#lists.api(consoleId).listWifiNetworks(siteId)).map(network => ({
        value: network.id, title: network.name, subtitle: network.security, meta: network.enabled ? "on" : "off",
      })));
  }
}

/** Lists for the Protect, camera, sensor, and floodlight pickers. */
@validateRpc()
export class ProtectPickerUI extends RpcTarget implements ProtectPickerRpc {
  readonly #lists: PickerLists;

  constructor(source: PickerSource) {
    super();
    this.#lists = new PickerLists(source);
  }

  async listConsoles(query: string): Promise<PickerOption[]> {
    return this.#lists.consoles(query, "protect");
  }

  async listCameras(consoleId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`cameras:${consoleId}`, query, async () =>
      (await this.#lists.api(consoleId).listCameras()).map(camera => ({
        value: camera.id, title: camera.name, ...(camera.model && { subtitle: camera.model }), meta: camera.state,
      })));
  }

  async listSensors(consoleId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`sensors:${consoleId}`, query, async () =>
      (await this.#lists.api(consoleId).listSensors()).map(sensor => ({
        value: sensor.id, title: sensor.name, subtitle: sensor.mountType === "none" ? sensor.model ?? "Sensor" : sensor.mountType,
        meta: sensor.state,
      })));
  }

  async listLights(consoleId: string, query: string): Promise<PickerOption[]> {
    return this.#lists.options(`lights:${consoleId}`, query, async () =>
      (await this.#lists.api(consoleId).listLights()).map(light => ({
        value: light.id, title: light.name, ...(light.model && { subtitle: light.model }), meta: light.state,
      })));
  }
}
