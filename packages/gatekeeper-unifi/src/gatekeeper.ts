/**
 * The per-binding gatekeeper: a Durable Object facet of the workspace's overseer, one class for
 * every resource kind. It starts sessions over the bound resource, keeps the binding's action
 * journal, applies and rejects actions once the user decides, and checks collaborators against
 * what its reads report (observer strategies B and C): the site data, WiFi settings, voucher
 * codes, NVR or Protect devices a read disclosed, by the endpoint it came from (see subresources.ts).
 */

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { UNIFI_ACTIONS, ACTION_KINDS_BY_RESOURCE, type UnifiAction } from "./actions";
import { UnifiApi } from "./api";
import { UnifiError } from "./errors";
import type { UnifiAccount } from "./account";
import type { UnifiEnv } from "./env";
import { NetworkDeviceSession, NetworkSiteSession, HotspotSession, WifiNetworkSession } from "./network-session";
import { CameraSession, LightSession, ProtectSession, SensorSession } from "./protect-session";
import { resourceApp, type UnifiResource, type UnifiResourceKind } from "./resources";
import { SessionContext, type SessionShared } from "./session-context";
import { parseRequirement, requirementId, type UnifiRequirement } from "./subresources";
import type { UnifiVerifierApi } from "./verifier";
import NETWORK_TYPES from "./network-types.txt";
import PROTECT_TYPES from "./protect-types.txt";

/** A binding: the account it reads through and the resource it is bound to. */
export type UnifiGatekeeperProps = { accountId: string; resource: UnifiResource };

/** The session object a binding hands out, whichever kind it is. */
export type UnifiSession =
  | NetworkSiteSession | NetworkDeviceSession | WifiNetworkSession | HotspotSession
  | ProtectSession | CameraSession | SensorSession | LightSession;

/** How each kind of binding presents itself in the Workshop. */
const PRESENTATION: Record<UnifiResourceKind, { tsType: string; binding: string; title: string; snippet: string }> = {
  site: { tsType: "UnifiNetworkSite", binding: "UNIFI_NETWORK_SITE", title: "UniFi site", snippet: "A UniFi Network site: devices, clients, WiFi, and guest hotspot." },
  device: { tsType: "UnifiNetworkDevice", binding: "UNIFI_DEVICE", title: "UniFi device", snippet: "One UniFi gateway, switch, or access point." },
  wifi: { tsType: "UnifiWifiNetwork", binding: "UNIFI_WIFI_NETWORK", title: "UniFi WiFi network", snippet: "One WiFi network's settings and password." },
  hotspot: { tsType: "UnifiHotspot", binding: "UNIFI_HOTSPOT", title: "UniFi guest hotspot", snippet: "Guest vouchers and guest access, nothing else." },
  protect: { tsType: "UnifiProtect", binding: "UNIFI_PROTECT", title: "UniFi Protect", snippet: "Cameras, doorbells, sensors, floodlights, and the alarm's state." },
  camera: { tsType: "UnifiCamera", binding: "UNIFI_CAMERA", title: "UniFi camera", snippet: "One camera or doorbell: snapshots and settings." },
  sensor: { tsType: "UnifiSensor", binding: "UNIFI_SENSOR", title: "UniFi sensor", snippet: "One sensor's readings." },
  light: { tsType: "UnifiLight", binding: "UNIFI_LIGHT", title: "UniFi floodlight", snippet: "One floodlight: its state and settings." },
};


/** One binding to a UniFi resource. */
@validateRpc()
export class UnifiGatekeeper extends DurableObject<UnifiEnv, UnifiGatekeeperProps> implements Gatekeeper<UnifiSession> {
  readonly #api = new UnifiApi(request => this.#account().request(request), this.ctx.props.resource.consoleId);
  readonly #journal = new ActionJournal<UnifiAction>(this.ctx.storage.kv, { namespace: "unifi" });
  readonly #actions = UNIFI_ACTIONS.bind(this.#journal, {
    api: this.#api,
    updateWifi: async (siteId, wifiNetworkId, changes) => {
      const failure = await this.#account().updateWifi(this.ctx.props.resource.consoleId, siteId, wifiNetworkId, changes);
      if (failure) throw new UnifiError(failure);
    },
  });

  #account(): DurableObjectStub<UnifiAccount> {
    return this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(this.ctx.props.accountId));
  }

  /**
   * The Workshop stores this and shows it to every collaborator without an observation check, so
   * the title names the kind of resource, never what UniFi calls it: a camera's or site's name is
   * for the authorized session reads.
   */
  async describe(): Promise<ResourceDescription> {
    const { resource } = this.ctx.props;
    const presentation = PRESENTATION[resource.kind];
    return {
      url: await this.#uiUrl().catch(() => "https://unifi.ui.com"),
      title: presentation.title, snippet: presentation.snippet,
      suggestedBindingName: presentation.binding, tsType: presentation.tsType,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return resourceApp(this.ctx.props.resource.kind) === "protect" ? PROTECT_TYPES : NETWORK_TYPES;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const offered = new Set(ACTION_KINDS_BY_RESOURCE[this.ctx.props.resource.kind]);
    return this.#actions.autoApprovableKinds().filter(kind => offered.has(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<UnifiSession> {
    const shared: SessionShared = {
      api: this.#api,
      actions: this.#actions,
      pending: () => this.#journal.listPending(),
      consoleName: () => this.#consoleName(),
      now: () => Date.now(),
      subresource: requirement => requirementId(this.ctx.props.resource, requirement),
    };
    const ctx = new SessionContext(shared, approvalQueue.dup());
    const resource = this.ctx.props.resource;
    switch (resource.kind) {
      case "site": return new NetworkSiteSession(ctx, resource.siteId);
      case "device": return new NetworkDeviceSession(ctx, resource.siteId, resource.deviceId, resource.clients);
      case "wifi": return new WifiNetworkSession(ctx, resource.siteId, resource.wifiNetworkId);
      case "hotspot": return new HotspotSession(ctx, resource.siteId);
      case "protect": return new ProtectSession(ctx);
      case "camera": return new CameraSession(ctx, resource.cameraId);
      case "sensor": return new SensorSession(ctx, resource.sensorId);
      case "light": return new LightSession(ctx, resource.lightId);
    }
  }

  /** `_cache` is unused (nothing here touches git) but declared to match the `Gatekeeper` interface. */
  async applyAction(action: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#actions.apply(action);
  }

  async rejectAction(action: number): Promise<void> {
    await this.#actions.reject(action);
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("UniFi changes can't be reverted automatically.");
  }

  /**
   * Admits the observers whose own UniFi connection can read everything `subresources` names (see
   * `UnifiAccount.canObserve`). Any ID this binding doesn't report fails the whole call, which
   * denies everyone in it.
   * @throws when the binding's own connection no longer reaches its console, since there is then
   * nothing to match a collaborator's console against.
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    const { resource } = this.ctx.props;
    const requirements = new Map<string, UnifiRequirement>(subresources.map(id => [id, parseRequirement(resource, id)]));
    const target = await this.#account().observeTarget(resource.consoleId, resourceApp(resource.kind));
    if (!target) throw new Error("This binding's UniFi connection can no longer see its console, so collaborators can't be checked against it.");
    const verify = observerAccessVerifier<Fetcher<UnifiVerifierApi>>({
      hasCollectionAccess: (verifier, ids) => verifier.canObserve(target, ids.map(id => requirements.get(id)!)),
    });
    return await verify(observers, subresources);
  }

  /** Every read has reported its subresources since this gatekeeper was added: no history to export. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /** Nothing to do: `verifyObserverAccess` checks every requirement reads report. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async #consoleName(): Promise<string> {
    const consoles = await this.#account().listConsoles();
    return consoles.find(c => c.id === this.ctx.props.resource.consoleId)?.name ?? "the UniFi console";
  }

  async #uiUrl(): Promise<string> {
    const resource = this.ctx.props.resource;
    const base = await this.#account().consoleWebUrl(resource.consoleId);
    if (resourceApp(resource.kind) === "protect") return `${base}/protect/dashboard`;
    const site = await this.#api.getSite((resource as { siteId: string }).siteId).catch(() => null);
    return `${base}/network/${encodeURIComponent(site?.internalReference ?? "default")}/dashboard`;
  }
}
