// The instance binding's gatekeeper Durable Object: one per (account, instance) binding, offered
// only with GITLAB_INSTANCE_CODE_SEARCH (see supportedResources). It is read-only -- code search
// across every project the account can read, and the repositories it opens (gitlab-code-sessions.ts)
// -- so it queues no actions and has no `gitPull`. Every read reports what it depends on
// (`instance/<host>`, `repository/<id>`, and `project/<id>` for metadata of a project whose
// repository is disabled), and observers are admitted through the same verifier as a project
// binding's (see verifyProjectAccess).

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CodeCaches, type CodeReadContext } from "./gitlab-code";
import { GitLabInstanceSessionImpl } from "./gitlab-code-sessions";
import {
  instanceHost,
  instanceUrl as instanceUrlOf,
  withAccountApi,
  type Env,
  type GitLabInstanceGatekeeperProps,
} from "./gitlab-env";
import { verifyProjectAccess } from "./gitlab-gatekeeper";
import { parseGitLabSubresource } from "./project-subresources";
import type { GitLabInstance } from "./types";
import TYPES_CODE from "./types.txt";

const NO_ACTIONS = "The GitLab instance connection is read-only and implements no actions.";

@validateRpc()
export class GitLabInstanceGatekeeperImpl extends DurableObject<Env, GitLabInstanceGatekeeperProps>
  implements Gatekeeper<GitLabInstance> {

  readonly #codeCaches = new CodeCaches(this.ctx.storage.kv);

  #userAccount() {
    const accounts = this.ctx.exports.UserAccount;
    return accounts.get(accounts.idFromString(this.ctx.props.userObjectId));
  }

  /**
   * GitLab as the binding's account, for replay-safe reads only (so a token a refresh replaced in
   * flight reruns the read once instead of failing), with the binding's code caches.
   */
  #codeContext(): CodeReadContext {
    return {
      read: fn => withAccountApi(this.env, this.#userAccount(), fn, { replayable: true }),
      caches: this.#codeCaches,
      instanceUrl: instanceUrlOf(this.env),
      host: instanceHost(this.env),
    };
  }

  async describe(): Promise<ResourceDescription> {
    const host = instanceHost(this.env);
    return {
      url: `${instanceUrlOf(this.env)}/`,
      title: `GitLab code on ${host}`,
      snippet: `Search and read code in every project you can read on ${host}.`,
      suggestedBindingName: "GITLAB_INSTANCE",
      tsType: "GitLabInstance",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GitLabInstance> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new GitLabInstanceSessionImpl(this.#codeContext(), approvalQueue.dup());
  }

  /** No reads predate reporting subresources: the binding has reported them from the start. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /** Every read reports its subresources, which verifyObserverAccess checks; nothing to admit. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  /**
   * Admits the observers whose own account can read every subresource: each repository a read
   * reported, the instance, and the project whose metadata a read of a repository-disabled
   * project reported (membership, see metadataSubresourceId). Refuses any other ID: none of this
   * binding's reads reports a role.
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    for (const subresource of subresources) {
      const parsed = parseGitLabSubresource(subresource);
      if (parsed.kind === "project" && parsed.minAccessLevel !== undefined) {
        throw new Error(`The GitLab instance connection reports no subresource like ${subresource}.`);
      }
    }
    return await verifyProjectAccess(observers, subresources);
  }

  applyAction(_action: number): Promise<void> {
    throw new Error(NO_ACTIONS);
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error(NO_ACTIONS);
  }

  revertAction(_action: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error(NO_ACTIONS);
  }
}
