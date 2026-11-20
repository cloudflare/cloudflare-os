// The admin gatekeeper's contract with the Workshop: what extends the generic Gatekeeper contract
// for this one vendor (ADMIN_GATEKEEPER_VENDOR_ID), kept here so that nothing generic carries it.
//
// The gatekeeper holds no power of its own, neither a standing credential nor an Admin API
// binding. For each session the Workshop lends it the Admin API of the workspace's owner, and for
// each approved action one call of it; the Workshop checks and records every call where it lands.
// Only the Workshop calls or hands over what is declared here.

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { AdminApi } from "./api.js";
import type { ApprovalQueue, Gatekeeper } from "./gatekeeper.js";
import type { ADMIN_AGENT_KINDS, AdminAgentKind } from "./admin-agent.js";

type Kinds = typeof ADMIN_AGENT_KINDS;

// Neither line compiles while ADMIN_AGENT_KINDS and AdminApi differ: the error names the method
// to classify in admin-agent.ts, or the entry to delete from it.
const UNCLASSIFIED: Record<Exclude<keyof AdminApi, keyof Kinds>, never> = {};
const STALE: Record<Exclude<keyof Kinds, keyof AdminApi>, never> = {};
void UNCLASSIFIED;
void STALE;

/** The AdminApi methods of kind `K` (see ADMIN_AGENT_KINDS). */
export type AdminAgentMethod<K extends AdminAgentKind = Exclude<AdminAgentKind, "omitted">> =
    { [M in keyof Kinds]: Kinds[M] extends K ? M : never }[keyof Kinds];

/**
 * The Admin API as a workspace lends it to the admin gatekeeper: AdminApi itself, less the
 * methods ADMIN_AGENT_KINDS omits. It is the Admin API of the workspace's owner, and every call
 * is checked where it lands, by the Workshop: the owner must be a deployment admin at that
 * moment, the method must be one the lend is for (see AdminAgentQueue.getAdminApi() and
 * AdminGatekeeper.applyAdminAction()), and then everything AdminApi itself checks and records
 * applies, with the record's `via` "gatekeeper" and its AdminAgentOrigin. The gatekeeper adds
 * nothing to it and cannot widen it. AdminApi does not say it is an RpcTarget and a stub that
 * crosses between Workers must be of one, hence the intersection.
 */
export type AdminAgentApi = Pick<AdminApi, AdminAgentMethod> & RpcTarget;

/**
 * The approval queue the admin gatekeeper's sessions receive: an ApprovalQueue that also lends
 * the gatekeeper what it has none of, the Admin API of the workspace's owner.
 */
export interface AdminAgentQueue extends ApprovalQueue {
  /**
   * The owner's Admin API for this session: its "read" methods. An "act" method is refused here:
   * it runs only through AdminGatekeeper.applyAdminAction(). The capability, and every view it
   * returned, stops working when the session ends (an agent's code run settles or its turn is
   * stopped, or the connection is removed) and at the latest ADMIN_AGENT_LEND_SECONDS after this
   * queue was made, however often this is called. Each call through it is refused once the
   * owner is no longer a deployment admin or the deployment turned the gatekeeper off; in those
   * two cases this method itself is refused, with nothing lent. It is also refused for a
   * session a collaborator opened directly from the connection, outside any chat: every call
   * is recorded as the owner's, and only a chat, an action's decision or the owner's own
   * session says who was behind it. It returns no data, so the gatekeeper awaits it before
   * its first read's observation: a session that is lent nothing then marks its workspace
   * with nothing (an observation that says a read holds restricted data is never undone).
   * A view's `lifetimeSeconds` is capped at what is left of the lend.
   */
  getAdminApi(): Promise<RpcStub<AdminAgentApi>>;
}

/**
 * The admin gatekeeper's facet (ADMIN_GATEKEEPER_VENDOR_ID). The Workshop hands its sessions an
 * AdminAgentQueue, and applies its actions through applyAdminAction() rather than applyAction().
 */
export interface AdminGatekeeper<Session> extends Gatekeeper<Session> {
  /** As Gatekeeper.startSession(), over the queue that lends the session the owner's Admin API. */
  startSession(queue: RpcStub<AdminAgentQueue>): Promise<Session>;

  /**
   * Apply approved action `action`, which the gatekeeper queued with submitAction(). `admin` is
   * lent for this one action: it answers ONE call, the one the action's kind names (see
   * ADMIN_AGENT_ACTIONS), as the workspace's owner, recorded with the chat that queued the
   * action; a second call, and any call after this method returned, is refused. The Workshop
   * calls this in place of applyAction(), and only for an action whose tag is one of
   * ADMIN_AGENT_ACTIONS'; an auto-approval of an action tagged with a kind whose verdict is
   * false ("workspace-write-request", "content-access-request"), and any auto-approval in a
   * workspace marked as holding restricted data, never reaches it. Both tests read what the
   * gatekeeper itself declared (the action's tag, the flag on its observations): they bind the
   * agents and gadgets that use the gatekeeper, not the gatekeeper.
   */
  applyAdminAction(action: number, admin: RpcStub<AdminAgentApi>): Promise<void>;
}
