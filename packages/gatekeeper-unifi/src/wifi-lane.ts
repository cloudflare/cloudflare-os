/**
 * Writes WiFi changes one at a time per network, across every UniFi connection in the deployment.
 * UniFi takes only a network's whole settings, so each change is a fresh read, a merge and a write;
 * two connections reaching the same console with different keys -- two people's direct keys, say --
 * would otherwise each read the settings, and the later write would put back what the earlier one
 * changed, such as a new password. Keyed by site and network ID, which the console assigns as
 * UUIDs, so every connection that reaches the network names it the same way.
 */

import { DurableObject } from "cloudflare:workers";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type { UnifiFailure } from "./errors";
import type { UnifiEnv } from "./env";
import type { UnifiWifiNetworkChanges } from "./network-types";

/** The lane for one WiFi network. */
export class UnifiWifiLane extends DurableObject<UnifiEnv> {
  readonly #queue = new SerialTaskQueue();

  /**
   * Has the account write a change, after any change already waiting for this network. Each write
   * goes out with its own connection's credentials.
   * @returns The failure, or null once the change is written.
   */
  async write(
    accountId: string, consoleId: string, siteId: string, wifiNetworkId: string, changes: UnifiWifiNetworkChanges,
  ): Promise<UnifiFailure | null> {
    return await this.#queue.run(() => {
      const account = this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(accountId));
      return account.writeWifi(consoleId, siteId, wifiNetworkId, changes);
    });
  }
}
