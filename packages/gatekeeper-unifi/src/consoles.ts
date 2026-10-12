/**
 * What a connection can reach: the consoles a cloud key's account owns or administers (from Site
 * Manager), or the one console a direct connection talks to. Used when connecting, to prove the key
 * works and learn who it belongs to; by the resource pickers; and by observer verification.
 *
 * Every function takes the `send` to use, so the connect flow can probe credentials it hasn't
 * stored yet and the Node tests can run these against a fake.
 *
 * Pure apart from `send`.
 */

import { UnifiError, type UnifiFailure } from "./errors";
import {
  asObject, normalizeMac, parseDevice, parseNetworkInfo, parseNetworkPage, parseNvr,
  parseProtectInfo, parseSite, parseSiteManagerHost, parseSiteManagerList, type SiteManagerConsole,
} from "./parse";
import type { UnifiApp, UnifiRequest, UnifiResponse } from "./transport";

/** Sends one request: `sendUnifiRequest` bound to credentials, or the account's egress. */
export type UnifiSend = (request: UnifiRequest) => Promise<UnifiResponse>;

/** A console a connection reaches, in the form the pickers and the verifier use. */
export type ConsoleSummary = {
  id: string;
  name: string;
  /** Applications the console runs. */
  apps: { network: boolean; protect: boolean };
  /** Applications this connection's account may use there. */
  permissions: { network: boolean; protect: boolean };
  /** Whether requests to the console's applications can be made from this connection. */
  reachable: boolean;
  /** The console's MAC addresses. */
  macs: string[];
};

/** What a collaborator must be able to see to observe a binding: one application on one console. */
export type ObserveTarget = {
  app: UnifiApp;
  /** The console's ID in the binding owner's connection. */
  consoleId: string;
  /** The console's MAC addresses, which a cloud collaborator's Site Manager list is matched by. */
  macs: string[];
  /** The console URL the binding reads through, when its owner connected directly. */
  baseUrl?: string;
};

/** The successful JSON body of a response, or the failure thrown as a `UnifiError`. */
export function jsonOf(response: UnifiResponse): unknown {
  if (!response.ok) throw new UnifiError(response.failure);
  if (!("json" in response)) {
    throw new UnifiError({ kind: "protocol", message: "UniFi returned an image where data was expected." });
  }
  return response.json;
}

/** Every page of Site Manager's hosts. Stops after 20 pages of 100, far beyond any account. */
export async function listSiteManagerConsoles(send: UnifiSend): Promise<SiteManagerConsole[]> {
  const consoles: SiteManagerConsole[] = [];
  let nextToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { pageSize: "100" };
    if (nextToken) query.nextToken = nextToken;
    const list = parseSiteManagerList(jsonOf(await send({
      target: { kind: "siteManager" }, method: "GET", path: "/v1/hosts", query,
    })));
    for (const host of list.data) {
      // A network server (self-hosted Network application) isn't a console the connector proxies.
      const type = asObject(host, "Site Manager host").type;
      if (type === "network-server") continue;
      consoles.push(parseSiteManagerHost(host));
    }
    nextToken = list.nextToken;
    if (!nextToken || list.data.length === 0) break;
  }
  return consoles;
}

/** A cloud console as a picker or verifier sees it. Only owned consoles answer the connector. */
export function cloudConsoleSummary(host: SiteManagerConsole): ConsoleSummary {
  return {
    id: host.id, name: host.name, apps: host.apps, permissions: host.permissions,
    reachable: host.owner, macs: host.macs,
  };
}

/** What a direct connection learns about its console when connecting. */
export type DirectConsoleFacts = {
  name: string;
  apps: { network: boolean; protect: boolean };
  macs: string[];
  networkVersion: string | null;
  protectVersion: string | null;
};

/** A probe of one application. The direct transport ignores the console ID. */
function probeRequest(app: UnifiApp, path: string): UnifiRequest {
  return { target: { kind: "app", app, consoleId: "direct" }, method: "GET", path };
}

/**
 * Probes a console's applications with a direct connection's credentials and learns its name and
 * MAC addresses. The console ID in the requests is ignored by the direct transport.
 * @param send Bound to the direct credentials being tried.
 * @returns What the console revealed.
 * @throws UnifiError when neither application answers; the most telling failure wins.
 */
export async function probeDirectConsole(send: UnifiSend): Promise<DirectConsoleFacts> {
  const [network, protect] = await Promise.all([
    send(probeRequest("network", "/v1/info")), send(probeRequest("protect", "/v1/meta/info")),
  ]);
  if (!network.ok && !protect.ok) throw new UnifiError(mostTelling(network.failure, protect.failure));

  const macs = new Set<string>();
  let name: string | null = null;
  let protectVersion: string | null = null;
  let networkVersion: string | null = null;
  if (protect.ok) {
    protectVersion = parseProtectInfo(jsonOf(protect)).applicationVersion;
    const nvr = await send(probeRequest("protect", "/v1/nvrs"));
    if (nvr.ok) {
      const parsed = parseNvr(jsonOf(nvr));
      macs.add(parsed.macAddress);
      name = parsed.name;
    }
  }
  if (network.ok) {
    networkVersion = parseNetworkInfo(jsonOf(network)).applicationVersion;
    // The gateway's MAC identifies the installation when Protect doesn't run here. Only the first
    // site is consulted: a gateway belongs to one site, and this is identification, not inventory.
    const sites = await send({ ...probeRequest("network", "/v1/sites"), query: { limit: "1" } });
    const site = sites.ok ? parseNetworkPage(jsonOf(sites), "site list").data.map(parseSite)[0] : undefined;
    if (site) {
      const devices = await send({
        ...probeRequest("network", `/v1/sites/${encodeURIComponent(site.id)}/devices`), query: { limit: "200" },
      });
      if (devices.ok) {
        for (const device of parseNetworkPage(jsonOf(devices), "device list").data.map(parseDevice)) {
          if (!device.roles.includes("gateway")) continue;
          macs.add(device.macAddress);
          name ??= device.name;
        }
      }
    }
  }
  return {
    name: name ?? "UniFi console",
    apps: { network: network.ok, protect: protect.ok },
    macs: [...macs],
    networkVersion,
    protectVersion,
  };
}

/** The more useful of two failures to show someone connecting: a key problem beats the rest. */
function mostTelling(a: UnifiFailure, b: UnifiFailure): UnifiFailure {
  const rank = ["auth", "tls", "redirect", "forbidden", "rateLimited", "unreachable", "timeout"];
  const score = (kind: string) => { const i = rank.indexOf(kind); return i === -1 ? rank.length : i; };
  return score(a.kind) <= score(b.kind) ? a : b;
}

/** Whether two consoles are the same hardware, judged by their MAC addresses. */
export function sameConsole(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map(normalizeMac));
  return b.some(mac => set.has(normalizeMac(mac)));
}
