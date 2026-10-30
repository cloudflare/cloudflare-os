import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AgentContext, AgentTurnInfo, WorktreeMount } from "@gadgets/workshop-shared/agent-integration";
import type { OverseerDurableObject } from "./overseer";
import type { AgentIntegrationOrigin } from "./storage-schema/overseer-storage";

/** Replica access requires an explicit deployment grant, never a gatekeeper assertion. */
export function agentIntegrationReplicaGrant(config: string | undefined, vendor: string): boolean {
  try { return JSON.parse(config ?? "null")?.[vendor]?.worktreeReplica === true; }
  catch { return false; }
}

/** An ephemeral session context; only the scoped replica endpoint may be persisted. */
@validateRpc()
export class AgentContextImpl extends RpcTarget implements AgentContext {
  constructor(private impl: OverseerDurableObject["impl"], private gatekeeperId: number,
      private origin: AgentIntegrationOrigin) { super(); }

  async getTurn(): Promise<AgentTurnInfo> {
    return this.impl.checkAgentContext(this.gatekeeperId, this.origin);
  }

  async mountWorktree(binding: string): Promise<WorktreeMount> {
    return this.impl.mountWorktree(this.gatekeeperId, this.origin, binding);
  }
}
