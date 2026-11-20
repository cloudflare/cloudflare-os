// What an admin's agent may do with the Admin API through the admin gatekeeper: the kind of every
// AdminApi method.
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
 * observation it makes through the admin binding: each read of the binding and each call on a
 * view the binding opened. A workspace treats every other subresource id as opaque; this one it
 * reads: an observation that names it and says its read holds restricted data keeps the
 * workspace to deployment admins for good.
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
 *   - "omitted": absent from the agent's declarations and refused.
 */
export type AdminAgentKind = "read" | "omitted";

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
 * deploy flow; isBlueprintFeatured(), which repairs the featured catalog's mirror as it reads.
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
  listAdminAudit: "read", getAdminAuditStats: "read",
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
  setAdminAuditRetentionDays: "omitted",
} as const satisfies Record<string, AdminAgentKind>;
