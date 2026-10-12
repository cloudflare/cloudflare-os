/**
 * Observer verification (strategy B). The overseer mints a verifier for each collaborator's UniFi
 * connection and only ever hands it back to a UniFi gatekeeper, which asks it whether that
 * collaborator can see the bound console's application with their own credentials.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ObserveTarget } from "./consoles";
import { logger, type UnifiEnv } from "./env";

/** The verifier's vendor-specific method, trusted only after the overseer's same-vendor handoff. */
export interface UnifiVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether this connection can see `target.app` on the console `target` identifies. A direct
   * connection vouches only for a binding read through its own console URL.
   * @returns false for no access; throws when the check itself failed.
   */
  canObserve(target: ObserveTarget): Promise<boolean>;
}

/** A collaborator's UniFi connection, as a verifier. */
@validateRpc()
export class UnifiVerifier extends WorkerEntrypoint<UnifiEnv, { accountId: string }> implements UnifiVerifierApi {
  async canObserve(target: ObserveTarget): Promise<boolean> {
    const account = this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(this.ctx.props.accountId));
    const allowed = await account.canObserve(target);
    if (!allowed) logger.info("observer denied", { event: "observer.denied", kind: target.app });
    return allowed;
  }
}
