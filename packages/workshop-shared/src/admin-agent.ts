// What an admin's agent may do with the Admin API through the admin gatekeeper: the kind of every
// AdminApi method, and the gatekeeper's action kinds.
//
// This module imports nothing, not even a type, and uses erasable syntax only (no enum, namespace
// or parameter property): the API schema generator loads it by relative path under plain `node`,
// which strips types and resolves no package, and type-checks it with Node's types alone. What
// ties the table to AdminApi is in admin-gatekeeper.ts, which may import.

/**
 * The vendor id of the admin gatekeeper: the Gatekeeper bound as GATEKEEPER_ADMIN, which
 * is packages/gatekeeper-admin wherever this repository's tooling builds the bindings (a
 * dev server, a release, the integration harness). A workspace lends its owner's Admin API to
 * whatever Worker answers to that binding, so the binding is trusted as the backend's own
 * configuration is, and the release build refuses any other package whose install slug folds to
 * this id.
 */
export const ADMIN_GATEKEEPER_VENDOR_ID = "admin";

/**
 * How long a workspace lends the admin gatekeeper its owner's Admin API for one session, in
 * seconds, counted from when the session's queue was made: 15 minutes, the default life of an
 * admin's view. Asking the queue again does not extend it; a caller that needs longer opens a
 * new session.
 */
export const ADMIN_AGENT_LEND_SECONDS = 15 * 60;

/**
 * The subresource id (ObservationDescription.subresources) the admin gatekeeper puts on every
 * observation it makes: each read of the binding, of a session limited to one issue report and
 * of a view either opened, and a hook's delivery. A workspace treats every other subresource id
 * as opaque; this one it reads: an observation that names it and says its read holds restricted
 * data keeps the workspace to deployment admins for good.
 */
export const ADMIN_BINDING_SUBRESOURCE = "admin:deployment";

/**
 * What an admin's agent may do with one AdminApi method through the admin gatekeeper:
 *   - "read":    runs at once and returns its result. A view it returns (inspectWorkspace(),
 *                inspectUser()) answers every method of that view, each under the checks the
 *                view makes itself.
 *                A "read" method that returns a view needs more than this kind: the Workshop
 *                answers a returned view's methods only by a table it keeps for the method that
 *                returned it, and does not compile while that table lacks the method.
 *   - "act":     never runs when called: it is queued as an action of the gatekeeper (see
 *                ADMIN_AGENT_ACTIONS) and runs only once that action is approved. A write to a
 *                workspace is one, and so is a request for content access, which a second admin
 *                must still approve once it is filed.
 *   - "omitted": absent from the agent's declarations and refused.
 */
export type AdminAgentKind = "read" | "act" | "omitted";

/**
 * The kind of every AdminApi method. THE one table: the Workshop refuses and routes each lent
 * call by it, the API schema generator leaves the "omitted" methods out of the gatekeeper's
 * schema, and the gatekeeper builds its sessions from what is left. A method added to AdminApi
 * does not compile until it has an entry here (see the check in admin-gatekeeper.ts). When in
 * doubt, "omitted": a method an agent lacks can be added, a call it made cannot be taken back.
 *
 * Omitted, by rule: every setter and every other method that changes a deployment setting; the
 * gateway tests, which send requests the deployment pays for; checkForUpdates(), which calls out
 * and stores what it learns, and getUpdateStatus(), whose answer holds the link that opens the
 * deploy flow; isBlueprintFeatured(), which repairs the featured catalog's mirror as it reads;
 * approving or denying a content access request and ending an admins' grant;
 * setting a report's links.
 *
 * A "read" method that returns a view (inspectWorkspace(), inspectUser()) also needs the
 * Workshop's table of what its view answers: see AdminAgentKind. A view of a user's account is a
 * read as a workspace's is: it answers with metadata alone, never a credential, and records each
 * call.
 */
export const ADMIN_AGENT_KINDS = {
  // Reads.
  getSettings: "read",
  listUsers: "read", listWorkspaces: "read", inspectWorkspace: "read", inspectUser: "read",
  listAdminAudit: "read", getAdminAuditStats: "read", listContentAccessRequests: "read",
  getContentAccessRequest: "read", listIssueReports: "read", getIssueReport: "read",
  readIssueReportImage: "read", whoami: "read",
  // Actions of the gatekeeper.
  addIssueReportEntry: "act", setIssueReportStatus: "act", writeWorkspace: "act",
  requestContentAccess: "act", claimIssueReport: "act", releaseIssueReport: "act",
  // Omitted.
  getUpdateStatus: "omitted", isBlueprintFeatured: "omitted",
  setSignupsEnabled: "omitted", setUserSearchEnabled: "omitted",
  setSnapshotSharingEnabled: "omitted", setSiteName: "omitted",
  setSiteLogo: "omitted", setInstanceInstructions: "omitted",
  setRestrictedWebFetchHosts: "omitted", setRestrictedWebFetchApprovals: "omitted",
  setResourceEnabled: "omitted", setGatekeeperMode: "omitted", setAnnouncement: "omitted",
  setBanner: "omitted", setAccentColor: "omitted", setBlueprintFeatured: "omitted",
  promoteFormat: "omitted", removeFormat: "omitted", updateFormat: "omitted",
  setFormatOrder: "omitted", setGatewayModelMode: "omitted", addGatewayModel: "omitted",
  removeGatewayModel: "omitted", setUserModelsEnabled: "omitted",
  setModelsDevSuggestions: "omitted", setGatewayModelSettings: "omitted",
  setDefaultReasoning: "omitted", setGatewayProviderEnabled: "omitted",
  setGatewayProviderOrder: "omitted", setGatewayModelOrder: "omitted",
  testGatewayProvider: "omitted", testGatewayModel: "omitted", testNewGatewayModel: "omitted",
  checkForUpdates: "omitted", setUpdateChecksEnabled: "omitted",
  setUpdateCheckIntervalMinutes: "omitted", setUpdateMinimumAgeHours: "omitted",
  setUpdateNoticeSnoozeHours: "omitted", setAdminWorkspaceAccess: "omitted",
  setAdminAuditRetentionDays: "omitted", setIssueReportRetentionDays: "omitted",
  setIssueReportLinks: "omitted", approveContentAccess: "omitted",
  denyContentAccess: "omitted", endWorkspaceGrant: "omitted",
} as const satisfies Record<string, AdminAgentKind>;

/**
 * The gatekeeper's action kinds: each "act" call is queued as one of them, and the Workshop lends
 * the gatekeeper the power to run an approved action of a kind only for that kind's call.
 *   - `method`, `visibility`: the one AdminApi call an approved action of the kind may make:
 *     addIssueReportEntry() with exactly that visibility, setIssueReportStatus(),
 *     claimIssueReport() or releaseIssueReport() (the one kind whose `method` names two),
 *     writeWorkspace() or requestContentAccess().
 *   - `autoApprovable`: the verdict every action of the kind carries
 *     (ActionDescription.autoApprovable). The Workshop refuses to lend to an auto-approval of
 *     an action whose TAG is that of a kind whose verdict is false, whatever verdict the
 *     action's own description claims.
 *   - `autoApprovableWhileRestricted`: whether a rule may still apply an action of the kind in
 *     a workspace marked as holding restricted data, where a rule applies no other action of
 *     any connection. It is the Workshop's own exception, read from this table and from nothing
 *     a gatekeeper declares, and it holds only while every observation that marked the
 *     workspace was made through the admin gatekeeper's connection: what an admins-only note,
 *     a status or an assignment can then carry is what admins can already read. True for those
 *     three kinds alone. A public reply, scoped or not, and both requests wait for a person
 *     there. Never true for a kind whose `autoApprovable` is false.
 *   - `kind`: what the action carries as ActionDescription.actionKind. Auto-approval rules are
 *     stored under the tag, so a tag is never renamed or reused, and a kind added here takes a
 *     tag no other kind has.
 *
 * A public reply has two kinds, told apart by the capability the call came through and by
 * nothing the caller says: "issueReportReply" through the admin binding, which reads what only
 * admins see, so its reply always waits for a person; "issueReportScopedReply" through a session
 * limited to one report (the gatekeeper's IssueReportSession), which reads nothing the reporter
 * could not, so its reply may be auto-approved where nothing restricted was read. They never
 * share a tag, so a rule for one never approves the other.
 *
 * Whom the split holds against: the agents and gadgets that call the gatekeeper, which choose
 * neither an action's tag nor whether a read marks its workspace. The gatekeeper Worker
 * chooses both (the tag it queues an action under, and the restricted-data flag of each
 * observation), as every gatekeeper does for its own actions and reads; the Workshop checks
 * the call an approved action makes against its tag, not which capability the agent called
 * through, which only the Worker knows. So the split is the Worker's to keep, and a Worker
 * that queued a reply drafted through the admin binding under the scoped tag, or left the
 * flag off a read, would get a rule's approval for it.
 *
 * A write to a workspace ("workspaceWriteRequest") and a request for content access
 * ("contentAccessRequest") always wait for a person. The write runs as soon as its action is
 * approved, as the owner's, with no other admin deciding: the person who approves the action is
 * the one check between an agent and another workspace. Whoever approves a content request's
 * filing is counted among the people who may not approve the request itself, which only a person
 * present can be.
 *
 * An assignment claims a report for the workspace's owner or releases one the owner holds,
 * whoever in the workspace asked: the call is the owner's, as every lent call is. It never
 * takes a report from another admin, which the report store refuses to a call made through
 * the gatekeeper.
 *
 * A verdict of true is a ceiling, not a promise: in a workspace marked as holding restricted
 * data, which everything read or received through the admin gatekeeper makes its workspace (a
 * session limited to one report and a hook's delivery included), a rule applies only the kinds
 * `autoApprovableWhileRestricted` names, and those only while no other connection's restricted
 * data was read there. Every other kind waits for a person.
 */
export const ADMIN_AGENT_ACTIONS = {
  issueReportReply: {
    method: "addIssueReportEntry", visibility: "public",
    // Rule 2: sends what an agent that reads what only admins see wrote to the reporter, a
    // person outside the workspace.
    autoApprovable: false,
    autoApprovableWhileRestricted: false,
    kind: { tag: "issue-report-reply", label: "Reply to an issue report's reporter" },
  },
  issueReportScopedReply: {
    method: "addIssueReportEntry", visibility: "public",
    autoApprovable: true,
    autoApprovableWhileRestricted: false,
    kind: {
      tag: "issue-report-scoped-reply",
      label: "Reply to a reporter from a session limited to their report",
    },
  },
  issueReportNote: {
    method: "addIssueReportEntry", visibility: "admins",
    autoApprovable: true,
    autoApprovableWhileRestricted: true,
    kind: { tag: "issue-report-note", label: "Add an admins-only note to an issue report" },
  },
  issueReportStatus: {
    method: "setIssueReportStatus", visibility: undefined,
    autoApprovable: true,
    autoApprovableWhileRestricted: true,
    kind: { tag: "issue-report-status", label: "Set an issue report's status" },
  },
  issueReportAssignment: {
    // One kind for the two calls: a rule for claiming is a rule for releasing.
    method: ["claimIssueReport", "releaseIssueReport"], visibility: undefined,
    autoApprovable: true,
    autoApprovableWhileRestricted: true,
    kind: { tag: "issue-report-assignment", label: "Claim or release an issue report" },
  },
  workspaceWriteRequest: {
    method: "writeWorkspace", visibility: undefined,
    // Runs a deployment admin's write in another workspace once approved, with no second check:
    // a person decides each one.
    autoApprovable: false,
    autoApprovableWhileRestricted: false,
    kind: { tag: "workspace-write-request", label: "Write to a workspace as a deployment admin" },
  },
  contentAccessRequest: {
    method: "requestContentAccess", visibility: undefined,
    // Rule 7: asks for access to a workspace's content, and the person who approves the filing
    // is one of those who may not approve the request.
    autoApprovable: false,
    autoApprovableWhileRestricted: false,
    kind: {
      tag: "content-access-request",
      label: "Ask the admins for access to a workspace's content",
    },
  },
} as const;

/** One of the gatekeeper's action kinds, by its name in ADMIN_AGENT_ACTIONS. */
export type AdminAgentAction = keyof typeof ADMIN_AGENT_ACTIONS;

/** The AdminApi methods an approved action of kind `action` may call: its kind's one method,
 * or the two of an assignment. */
export function adminAgentActionMethods(action: AdminAgentAction): readonly string[] {
  let { method } = ADMIN_AGENT_ACTIONS[action];
  return typeof method === "string" ? [method] : method;
}

/** The action kind an ActionKind tag names, or undefined for any other tag. */
export function adminAgentAction(tag: string | undefined): AdminAgentAction | undefined {
  // Each kind has a tag of its own (see ADMIN_AGENT_ACTIONS), so the first match is the only one.
  for (let name of Object.keys(ADMIN_AGENT_ACTIONS) as AdminAgentAction[]) {
    if (ADMIN_AGENT_ACTIONS[name].kind.tag === tag) return name;
  }
  return undefined;
}
