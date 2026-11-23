// What an admin's agent may do with the Admin API through this gatekeeper: the kind of every
// AdminApi method.
//
// This module imports nothing, not even a type, and uses erasable syntax only (no enum, namespace
// or parameter property): scripts/generate-schema.ts loads it (through subset.ts) under plain
// `node`, which strips types, and it is type-checked there with Node's types alone. What ties the
// table to AdminApi is in surface.ts, which may import.

/**
 * What an admin's agent may do with one AdminApi method through this gatekeeper:
 *   - "read":    runs at once and returns its result. A view it returns (inspectWorkspace(),
 *                inspectUser()) answers every method of that view, each under the checks the view
 *                makes itself.
 *   - "omitted": absent from the agent's declarations and from the sessions, so it cannot be
 *                called.
 */
export type AdminAgentKind = "read" | "omitted";

/**
 * The kind of every AdminApi method. THE one table: the "omitted" methods are left out of
 * the schema this Worker bundles (subset.ts), and the sessions and the agent's declarations are
 * built from what is left. A method added to AdminApi does not compile until it has an entry
 * here (see the check in surface.ts). When in doubt, "omitted": a method an agent lacks can be
 * added, a call it made cannot be taken back.
 *
 * Omitted, by rule: every setter and every other method that changes a deployment setting or a
 * workspace; the gateway tests, which send requests the deployment pays for; checkForUpdates(),
 * which calls out and stores what it learns, and getUpdateStatus(), whose answer holds the link
 * that opens the deploy flow; isBlueprintFeatured(), which repairs the featured catalog's mirror
 * as it reads.
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
  setAdminAuditRetentionDays: "omitted", writeWorkspace: "omitted",
} as const satisfies Record<string, AdminAgentKind>;
