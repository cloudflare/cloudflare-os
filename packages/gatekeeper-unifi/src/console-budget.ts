/**
 * The Cloud Connector's request budget for one console, shared by every connection in the
 * deployment that reaches it through the cloud. The connector allows each console 100 requests a
 * minute whoever sends them, so two people's connections pacing themselves apart would still trip
 * it together, and one's 429 would go unheeded by the other. Keyed by the console's Site Manager
 * host ID, which every cloud connection names it by. It hands out permits only: requests still go
 * out from each connection's own account, with its own key.
 */

import { DurableObject } from "cloudflare:workers";
import { CLOUD_CONSOLE_BUDGET, TokenBucket } from "./egress";
import type { UnifiEnv } from "./env";

/** The budget for one console. */
export class UnifiConsoleBudget extends DurableObject<UnifiEnv> {
  readonly #bucket = new TokenBucket(CLOUD_CONSOLE_BUDGET);

  /**
   * Waits for a permit, up to `maxWaitMs`.
   * @returns 0 once a permit is taken, or how long the caller would have had to wait.
   */
  async take(maxWaitMs: number): Promise<number> {
    return await this.#bucket.take(maxWaitMs, ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Hands out no permits until `until`, as the connector asked after a 429. */
  async block(until: number): Promise<void> {
    this.#bucket.block(until);
  }
}
