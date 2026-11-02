// The capability through which a connected account runs one space-sync job (see
// AuthenticatedApi.startSpaceSync): the account receives a stub of it with
// GatekeeperUser.startSpaceSync and may store it for the job's lifetime.
//
// It holds no authority of its own. Its props name the job, the user and the account, and are set
// by the user's User DO when it mints the stub, so the account can neither forge nor widen them.
// Every call goes to that User DO, which checks the props against its job record anew (see
// UserDurableObject.reportSpaceSyncProgress), so that ending the job there, by cancelling it or
// disconnecting the account, revokes every stub of it at once. The User DO also does whatever a
// call writes, so no stub of a workspace or its gadget ever reaches the account.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  SpaceSyncItem, SpaceSyncProgress, SpaceSyncTarget, SpaceSyncWrite,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * Whom a `SpaceSyncLoopback` acts for: job `jobId` of the user whose User DO has the id `userId`,
 * run through their connected account `accountId`.
 */
export type SpaceSyncLoopbackProps = { userId: string; accountId: number; jobId: string };

/**
 * The `SpaceSyncTarget` of one space-sync job. Never rename this class: accounts store stubs of
 * it, which name it.
 */
@validateRpc()
export class SpaceSyncLoopback extends WorkerEntrypoint<Cloudflare.Env, SpaceSyncLoopbackProps>
    implements SpaceSyncTarget {
  reportProgress(progress: SpaceSyncProgress): Promise<void> {
    let { accountId, jobId } = this.ctx.props;
    return this.#user.reportSpaceSyncProgress(accountId, jobId, progress);
  }

  async ensureWorkspace({ sourceUrl, title, parentId }: SpaceSyncItem)
      : Promise<{ workspaceId: string }> {
    let { accountId, jobId } = this.ctx.props;
    return this.#user.ensureSyncedWorkspace(accountId, jobId, { sourceUrl, title, parentId });
  }

  writeWorkspace(workspaceId: string, { method, args }: SpaceSyncWrite): Promise<void> {
    let { accountId, jobId } = this.ctx.props;
    return this.#user.writeSyncedWorkspace(accountId, jobId, workspaceId, { method, args });
  }

  setWorkspaceTitle(workspaceId: string, title: string): Promise<void> {
    let { accountId, jobId } = this.ctx.props;
    return this.#user.setSyncedWorkspaceTitle(accountId, jobId, workspaceId, title);
  }

  get #user() {
    let users = this.ctx.exports.UserDurableObject;
    return users.get(users.idFromString(this.ctx.props.userId));
  }
}
