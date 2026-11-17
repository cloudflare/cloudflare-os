// The admin gatekeeper's contract with the Workshop: what extends the generic Gatekeeper contract
// for this one vendor (ADMIN_GATEKEEPER_VENDOR_ID), kept here so that nothing generic carries it.
//
// The gatekeeper holds no power of its own, neither a standing credential nor an Admin API
// binding. For each session the Workshop lends it the Admin API of the workspace's owner, and for
// each approved action one call of it; the Workshop checks and records every call where it lands.
// Only the Workshop calls or hands over what is declared here.

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { AdminApi, IssueReportPriority, IssueReportStatus } from "./api.js";
import type { ApprovalQueue, Gatekeeper, GatekeeperVendor } from "./gatekeeper.js";
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
   * false ("issue-report-reply", "content-access-request"), and an auto-approval in a
   * workspace marked as holding restricted data of a kind that is not
   * `autoApprovableWhileRestricted`, or where another connection's restricted data was read,
   * never reaches it. The tests read the tag the gatekeeper declared on the action and what
   * the Workshop recorded of each connection's restricted observations: they bind the agents
   * and gadgets that use the gatekeeper, not the gatekeeper.
   *
   * The second of those is asked again as `admin` makes the action's call, since another
   * connection's restricted data can be read after this method was called. The call is then
   * refused `needsPerson` (ADMIN_ACCESS_ERROR_CODES) with nothing done, and the gatekeeper
   * rejects this method leaving the action as it was, to be applied once a person approves it.
   */
  applyAdminAction(action: number, admin: RpcStub<AdminAgentApi>): Promise<void>;
}

/**
 * What a write to an issue report was, on the event that tells of it (IssueReportEvent,
 * "changed"):
 *   - "status":     its status was set (AdminApi.setIssueReportStatus());
 *   - "assignment": it was claimed, taken over or released;
 *   - "reply":      a public entry was added to its thread, by its reporter or by an admin;
 *   - "note":       an entry for admins alone was added to its thread;
 *   - "links":      its links were replaced.
 */
export const ISSUE_REPORT_CHANGES = ["status", "assignment", "reply", "note", "links"] as const;

/** One of ISSUE_REPORT_CHANGES. */
export type IssueReportChange = typeof ISSUE_REPORT_CHANGES[number];

/**
 * What the issue report store tells the admin gatekeeper: ids and labels, never a report's text,
 * reporter or thread. A subscriber reads the report through its own binding.
 *   - "reported": a report was filed. Its images, and the grant its reporter may give with
 *     it, are attached by later calls: a subscriber that reads at once may find neither yet.
 *   - "investigationComplete": an admin moved a report from "investigating" to `status`.
 *   - "changed": a report was written to after it was filed, by an admin, by an agent or a
 *     gadget acting for one, or by its reporter: one event for each write that changed it.
 *     `change` says what the write was, and `status` is the status it set, as admins read it,
 *     when it set one: on every "status", and on the reporter's "reply" that moved the report
 *     to "withAdmin". A write that changed nothing (a status the report had, a claim by its
 *     holder, links replaced by the same links) and a refused one send none. It carries
 *     neither the text nor a name nor who made the write. What a reporter attaches to their
 *     report (an image, a grant) is no write to it and sends none, whenever it arrives. A
 *     report that leaves "investigating" sends this and "investigationComplete", two events
 *     with an id each.
 * `id` is the event's own, and what a hook's subscriber tells events apart by: random, so that
 * it says nothing of how many events the deployment has had, the same each time the event is
 * sent, and never another event's. `at` would not do: a report's investigation can end twice
 * in one millisecond, with the same status.
 */
export type IssueReportEvent =
  | { kind: "reported"; id: string; reportId: string; priority: IssueReportPriority; at: Date }
  | {
    kind: "investigationComplete";
    id: string;
    reportId: string;
    status: Exclude<IssueReportStatus, "new" | "investigating">;
    at: Date;
  }
  | {
    kind: "changed";
    id: string;
    reportId: string;
    change: IssueReportChange;
    status?: IssueReportStatus;
    at: Date;
  };

/** The admin gatekeeper's vendor entrypoint, as the Workshop's issue report store calls it. */
export interface AdminGatekeeperVendor extends GatekeeperVendor {
  /**
   * Take `events`, oldest first, for the hooks subscribed to them. Resolving means every event
   * is stored for delivery (or has no subscriber): the store then forgets them. A rejection
   * makes the store send them again, so an event can arrive more than once, with the same `id`.
   * The store sends one call's events again until all are taken, so the gatekeeper takes and
   * drops an event whose kind or label it does not know (one a store released after it sends)
   * rather than reject the call, which would hold back every event behind it.
   */
  issueReportEvents(events: IssueReportEvent[]): Promise<void>;
}
