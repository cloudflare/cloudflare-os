/** One connected UniFi account, as the Workshop holds it. */

import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { getBaseUrl, type UnifiEnv } from "./env";
import { UNIFI_LOGO_URL } from "./logo";
import { NetworkPickerUI, ProtectPickerUI, type PickerSource } from "./pickers";
import {
  parseResourceUrl, resourceApp, resourceKindForPattern, UNIFI_RESOURCES, UNIFI_SUPPORTED_RESOURCES,
  type UnifiResourceKind,
} from "./resources";
import SITE_PICKER_HTML from "./generated/unifi-site-configurator-ui.txt";
import DEVICE_PICKER_HTML from "./generated/unifi-device-configurator-ui.txt";
import WIFI_PICKER_HTML from "./generated/unifi-wifi-configurator-ui.txt";
import HOTSPOT_PICKER_HTML from "./generated/unifi-hotspot-configurator-ui.txt";
import PROTECT_PICKER_HTML from "./generated/unifi-protect-configurator-ui.txt";
import CAMERA_PICKER_HTML from "./generated/unifi-camera-configurator-ui.txt";
import SENSOR_PICKER_HTML from "./generated/unifi-sensor-configurator-ui.txt";
import LIGHT_PICKER_HTML from "./generated/unifi-light-configurator-ui.txt";

const PICKER_HTML: Record<UnifiResourceKind, string> = {
  site: SITE_PICKER_HTML, device: DEVICE_PICKER_HTML, wifi: WIFI_PICKER_HTML, hotspot: HOTSPOT_PICKER_HTML,
  protect: PROTECT_PICKER_HTML, camera: CAMERA_PICKER_HTML, sensor: SENSOR_PICKER_HTML, light: LIGHT_PICKER_HTML,
};

/** A connected account. */
@validateRpc()
export class UnifiUser extends WorkerEntrypoint<UnifiEnv, { accountId: string }> implements GatekeeperUser {
  #account() {
    return this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(this.ctx.props.accountId));
  }

  async describe(): Promise<AccountDescription> {
    const summary = await this.#account().summary();
    return {
      displayName: summary?.displayName ?? "UniFi",
      uniqueName: summary?.uniqueName ?? "UniFi",
      avatar: { url: UNIFI_LOGO_URL },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return UNIFI_SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const resource = parseResourceUrl(url);
    const consoles = await this.#account().listConsoles();
    const target = consoles.find(c => c.id === resource.consoleId);
    if (!target) throw new Error("This UniFi connection doesn't reach that console.");
    if (!target.reachable) {
      throw new Error("UniFi only lets a console's owner reach it through the cloud. Connect it directly instead.");
    }
    const app = resourceApp(resource.kind);
    if (!target.permissions[app]) {
      throw new Error(`This UniFi connection can't use UniFi ${app === "network" ? "Network" : "Protect"} on that console.`);
    }
    return {
      class: this.ctx.exports.UnifiGatekeeper({ props: { accountId: this.ctx.props.accountId, resource } }),
      resource: UNIFI_RESOURCES[resource.kind],
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const kind = resourceKindForPattern(resourceUrlPattern);
    if (!kind) throw new Error(`Unsupported UniFi resource type: ${resourceUrlPattern}`);
    const account = this.#account();
    const source: PickerSource = {
      listConsoles: () => account.listConsoles(),
      send: request => account.request(request),
    };
    const ui = resourceApp(kind) === "network" ? new NetworkPickerUI(source) : new ProtectPickerUI(source);
    return { iframeHtml: PICKER_HTML[kind], ui: new RpcStub(ui) };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#account().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.accountId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Not a sign-in provider: the email Site Manager reports isn't a verified identity claim.
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // An API key's reach is fixed when it is created; there is nothing to widen.
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.UnifiVerifier({ props: { accountId: this.ctx.props.accountId } });
  }
}
