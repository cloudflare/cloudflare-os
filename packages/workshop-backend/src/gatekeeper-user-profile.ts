import { validateRpc } from "capnweb-validate";
import type { GatekeeperUserProfile } from "@gadgets/workshop-shared/gatekeeper";
import { WorkerEntrypoint } from "cloudflare:workers";

type GatekeeperUserProfileProps = {
  userId: string;
};

/**
 * Workshop-owned presentation capability for one user, handed to a gatekeeper alongside the picked
 * user's verifier (see AuthenticatedApi.selectGatekeeperUser).
 */
@validateRpc()
export class GatekeeperUserProfileImpl
  extends WorkerEntrypoint<Cloudflare.Env, GatekeeperUserProfileProps>
  implements GatekeeperUserProfile {

  async getDisplayName(): Promise<string | null> {
    let profile = await this.ctx.exports.UserDurableObject.getByName(this.ctx.props.userId).whoamiIfExists();
    return profile ? profile.name : null;
  }
}
