/**
 * This deployment's Admin API, as the deployment admin whose account this connection was added
 * from (the generated declarations above say what each method does and which only queue an
 * action).
 *
 * A write or a content request is not returned to you: writeWorkspace() and
 * requestContentAccess() resolve to undefined, and the write runs, or the request exists, only
 * once its action has been approved. To follow a write, read
 * listAdminAudit({ kind: "write", workspace: <the workspace you named> }): its record's `via` is
 * "gatekeeper". To follow a request, listContentAccessRequests() lists it, with the same `via`;
 * another deployment admin approves it there, and the admin this connection acts as cannot.
 */
export interface AdminBinding extends AdminApi {}
