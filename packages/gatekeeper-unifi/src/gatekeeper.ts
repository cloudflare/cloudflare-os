/**
 * The per-binding gatekeeper: a Durable Object facet of the workspace's overseer, one class for
 * every resource kind. It starts sessions over the bound resource, keeps the binding's action
 * journal, applies and rejects actions once the user decides, and admits collaborators who can see
 * the bound console's application themselves (observer strategy B).
 */

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { aclObservers, ObservationGate } from "@gadgets/gatekeeper-kit/observers";
import { UNIFI_ACTIONS, ACTION_KINDS_BY_RESOURCE, type UnifiAction } from "./actions";
import { UnifiApi } from "./api";
import type { UnifiAccount } from "./account";
import type { UnifiEnv } from "./env";
import { NetworkDeviceSession, NetworkSiteSession, HotspotSession, WifiNetworkSession } from "./network-session";
import { CameraSession, LightSession, ProtectSession, SensorSession } from "./protect-session";
import { resourceApp, type UnifiResource, type UnifiResourceKind } from "./resources";
import { SessionContext, type SessionShared } from "./session-context";
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
const PRESENTATION: Record<UnifiResourceKind, { tsType: string; binding: string; fallbackTitle: string; snippet: string }> = {
  site: { tsType: "UnifiNetworkSite", binding: "UNIFI_NETWORK_SITE", fallbackTitle: "UniFi site", snippet: "A UniFi Network site: devices, clients, WiFi, and guest hotspot." },
  device: { tsType: "UnifiNetworkDevice", binding: "UNIFI_DEVICE", fallbackTitle: "UniFi device", snippet: "One UniFi gateway, switch, or access point." },
  wifi: { tsType: "UnifiWifiNetwork", binding: "UNIFI_WIFI_NETWORK", fallbackTitle: "UniFi WiFi network", snippet: "One WiFi network's settings and password." },
  hotspot: { tsType: "UnifiHotspot", binding: "UNIFI_HOTSPOT", fallbackTitle: "UniFi guest hotspot", snippet: "Guest vouchers and guest access, nothing else." },
  protect: { tsType: "UnifiProtect", binding: "UNIFI_PROTECT", fallbackTitle: "UniFi Protect", snippet: "Cameras, doorbells, sensors, floodlights, and the alarm's state." },
  camera: { tsType: "UnifiCamera", binding: "UNIFI_CAMERA", fallbackTitle: "UniFi camera", snippet: "One camera or doorbell: snapshots and settings." },
  sensor: { tsType: "UnifiSensor", binding: "UNIFI_SENSOR", fallbackTitle: "UniFi sensor", snippet: "One sensor's readings." },
  light: { tsType: "UnifiLight", binding: "UNIFI_LIGHT", fallbackTitle: "UniFi floodlight", snippet: "One floodlight: its state and settings." },
};

const DENY_MESSAGE =
  "This collaborator's UniFi connection can't reach this console's application, so they can't see what this gadget read from it.";

/** One binding to a UniFi resource. */
@validateRpc()
export class UnifiGatekeeper extends DurableObject<UnifiEnv, UnifiGatekeeperProps> implements Gatekeeper<UnifiSession> {
  readonly #api = new UnifiApi(request => this.#account().request(request), this.ctx.props.resource.consoleId);
  readonly #journal = new ActionJournal<UnifiAction>(this.ctx.storage.kv, { namespace: "unifi" });
  readonly #actions = UNIFI_ACTIONS.bind(this.#journal, { api: this.#api });
  readonly #observers = aclObservers<Fetcher<UnifiVerifierApi>>({
    hasAccess: async verifier => {
      const { resource } = this.ctx.props;
      const target = await this.#account().observeTarget(resource.consoleId, resourceApp(resource.kind));
      // Without the console's identity there is nothing to match the collaborator against.
      return target !== null && await verifier.canObserve(target);
    },
    denyMessage: DENY_MESSAGE,
  });

  #account(): DurableObjectStub<UnifiAccount> {
    return this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(this.ctx.props.accountId));
  }

  async describe(): Promise<ResourceDescription> {
    const { resource } = this.ctx.props;
    const presentation = PRESENTATION[resource.kind];
    const [title, url] = await Promise.all([
      this.#title().catch(() => presentation.fallbackTitle),
      this.#uiUrl().catch(() => "https://unifi.ui.com"),
    ]);
    return {
      url, title, snippet: presentation.snippet,
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
    };
    const ctx = new SessionContext(shared, approvalQueue.dup(), new ObservationGate(approvalQueue.dup(), this.#observers));
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

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.#observers.removeObserver(id);
  }

  async #consoleName(): Promise<string> {
    const consoles = await this.#account().listConsoles();
    return consoles.find(c => c.id === this.ctx.props.resource.consoleId)?.name ?? "the UniFi console";
  }

  async #title(): Promise<string> {
    const resource = this.ctx.props.resource;
    const api = this.#api;
    switch (resource.kind) {
      case "site": return (await api.getSite(resource.siteId)).name;
      case "device": return (await api.getDevice(resource.siteId, resource.deviceId)).name;
      case "wifi": return (await api.getWifi(resource.siteId, resource.wifiNetworkId)).name;
      case "hotspot": return `Guest hotspot · ${(await api.getSite(resource.siteId)).name}`;
      case "protect": return `UniFi Protect · ${await this.#consoleName()}`;
      case "camera": return (await api.getCamera(resource.cameraId)).name;
      case "sensor": return (await api.getSensor(resource.sensorId)).name;
      case "light": return (await api.getLight(resource.lightId)).name;
    }
  }

  async #uiUrl(): Promise<string> {
    const resource = this.ctx.props.resource;
    const base = await this.#account().consoleWebUrl(resource.consoleId);
    if (resourceApp(resource.kind) === "protect") return `${base}/protect/dashboard`;
    const site = await this.#api.getSite((resource as { siteId: string }).siteId).catch(() => null);
    return `${base}/network/${encodeURIComponent(site?.internalReference ?? "default")}/dashboard`;
  }
}
