/**
 * Observer verification. The overseer mints a verifier for each collaborator's UniFi connection
 * and only ever hands it back to a UniFi gatekeeper, which asks it whether that collaborator can
 * read what a binding's reads disclosed, with their own credentials.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ObserveTarget } from "./consoles";
import { logger, type UnifiEnv } from "./env";
import type { UnifiRequirement } from "./subresources";

/** The verifier's vendor-specific method, trusted only after the overseer's same-vendor handoff. */
export interface UnifiVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether this connection can read each requirement, within `target.app` on the console `target`
   * identifies, by calling the endpoint each one's read calls with its own key. A direct connection
   * vouches only for a binding read through its own console URL.
   * @returns One answer per requirement, false for no access; throws when a check itself failed.
   */
  canObserve(target: ObserveTarget, requirements: UnifiRequirement[]): Promise<boolean[]>;
}

/** A collaborator's UniFi connection, as a verifier. */
@validateRpc()
export class UnifiVerifier extends WorkerEntrypoint<UnifiEnv, { accountId: string }> implements UnifiVerifierApi {
  async canObserve(target: ObserveTarget, requirements: UnifiRequirement[]): Promise<boolean[]> {
    const account = this.ctx.exports.UnifiAccount.get(this.ctx.exports.UnifiAccount.idFromString(this.ctx.props.accountId));
    const allowed = await account.canObserve(target, requirements);
    if (allowed.includes(false)) logger.info("observer denied", { event: "observer.denied", kind: target.app });
    return allowed;
  }
}
