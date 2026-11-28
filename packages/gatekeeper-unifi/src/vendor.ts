/** The gatekeeper's top-level entrypoint, bound to the Workshop as `GATEKEEPER_UNIFI`. */

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperVendor as GatekeeperVendorIface,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { getBaseUrl, type UnifiEnv } from "./env";
import { UNIFI_LOGO_URL } from "./logo";
import { UNIFI_SUPPORTED_RESOURCES } from "./resources";
import NETWORK_TYPES from "./network-types.txt";
import PROTECT_TYPES from "./protect-types.txt";

/** UniFi, as a connector. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<UnifiEnv> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "UniFi",
      url: "https://ui.com",
      logo: { url: UNIFI_LOGO_URL },
      color: "#e6f0ff",
      tagline: "See and manage your UniFi network and cameras",
      description:
        "Connect your UniFi consoles, through your UniFi account or directly, so Gadgets can see " +
        "your network's devices, clients, and WiFi, and your Protect cameras, sensors, and " +
        "floodlights. Restarts, guest access, and WiFi and camera changes happen only with your approval.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    // API keys carry no scopes, so there is nothing to narrow by the requested resource types.
    const id = this.ctx.exports.UnifiAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UnifiAccount.get(id).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${id.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return UNIFI_SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return `${NETWORK_TYPES}\n${PROTECT_TYPES}`;
  }
}
