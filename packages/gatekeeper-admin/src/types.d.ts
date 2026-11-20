/**
 * This deployment's Admin API, as the owner of this workspace (the generated declarations above
 * say what each method does and which only queue an action).
 *
 * A write or a content request is not returned to you: writeWorkspace() and
 * requestContentAccess() resolve to undefined, and the write runs, or the request exists, only
 * once its action has been approved. To follow a write, read
 * listAdminAudit({ kind: "write", workspace: <the workspace you named> }): its record's
 * `agent.workspaceId` is this workspace. To follow a request, listContentAccessRequests() lists
 * it, with the same `agent.workspaceId`; another human admin approves it there, and nobody in
 * this workspace can.
 */
export interface AdminBinding extends AdminApi {}
