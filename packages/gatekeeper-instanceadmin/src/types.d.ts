/**
 * This deployment's Admin API, as the owner of this workspace (the generated declarations above
 * say what each method does and which only queue an action).
 *
 * A write request you file is not returned to you: requestWorkspaceWrite() resolves to
 * undefined, and the request exists only once its action has been approved. To follow it,
 * read listAdminAudit({ kind: "write", workspace: <the workspace you named> }): the record
 * whose `event` is "requested" and whose `agent.workspaceId` is this workspace carries the
 * `requestId`, which getWorkspaceWrite() takes. A human admin approves the request with a
 * passkey; you cannot.
 */
export interface AdminBinding extends AdminApi {
  /**
   * A session limited to one issue report (see IssueReportSession). Opening it reads nothing: a
   * report that does not exist is refused by the session's first call.
   *
   * To hand one to a spawned agent, a gadget passes a persistent stub minted from a random token
   * it stored with the report id, never from the report id: any code whose env names the gadget
   * can restore a stub from params it chooses. It forgets the token when the triage ends. The
   * spawner's env names neither this binding nor that gadget, and no other connection: the
   * session is all a triage agent holds.
   *
   *   // In the gadget, when its own code decides to triage `reportId`:
   *   const token = crypto.randomUUID();
   *   await this.ctx.storage.put(`triage:${token}`, reportId);
   *   const session = this.ctx.restore({ token });  // passed to the spawned agent
   *   // Its [restore]({ token }) opens a session only for a token it stored:
   *   //   const reportId = await this.ctx.storage.get(`triage:${token}`);
   *   //   if (!reportId) throw new Error("No such triage.");
   *   //   return this.env.ADMIN.openIssueReport(reportId);
   */
  openIssueReport(reportId: string): Promise<IssueReportSession>;
}

/**
 * One issue report and nothing else: the report as its reporter reads it, its images, a reply in
 * its public thread, and its reporter's workspace as the reporter chose to show it. It reaches
 * no other report, no admins-only entry, no listing, no audit log, no setting and no write
 * request, and it cannot be widened.
 */
export interface IssueReportSession {
  /** The report as its reporter reads it: no links, no admins-only entry, no admin's id. */
  get(): Promise<ScopedIssueReport>;

  /** One image of the report, as a stream of its bytes. */
  readImage(imageId: string): Promise<ReadableStream<Uint8Array>>;

  /**
   * Queue a public reply in the report's thread: non-blank text of at most 2000 characters. It
   * resolves to undefined, and the reply is posted once its action is approved. This is its own
   * kind of action ("Reply to a reporter from a session limited to their report"), which a
   * workspace's rule may approve; a public reply through AdminBinding never is.
   */
  reply(text: string): Promise<void>;

  /**
   * An audited view of the workspace the report names, when its reporter owns it: metadata,
   * and content only while the grant the reporter gave with this report, or the reporter's
   * account-wide grant, is live. Its description lists no other grant. Throws when the report
   * names no workspace or one its reporter does not own. When that workspace holds restricted
   * data, every answer of the view marks THIS workspace as holding restricted data too: from
   * the first one on, nothing here is applied without a person (a reply through this session
   * included) and web fetches reach only trusted hosts. The report itself, its images and its
   * thread never mark.
   */
  inspectWorkspace(reason: string): Promise<AdminWorkspaceView>;
}

/** An issue report as its reporter reads it, with the public entries of its thread. */
export interface ScopedIssueReport {
  /** Random and opaque. */
  id: string;
  /** When it was filed. */
  filedAt: Date;
  /** Who filed it. */
  reporter: { id: string; name: string };
  /** What went wrong, in the reporter's words. */
  text: string;
  /** How urgent the reporter said it is. */
  priority: "low" | "medium" | "high";
  /** Where the reporter was, as ids: each is absent when the report names none. */
  context: { workspaceId?: string; chatId?: number; gadgetId?: number; appVersion?: string };
  /** Where it stands. */
  status: "new" | "investigating" | "answered" | "waitingOnReporter" | "withAdmin" | "closed";
  /** Its images, in the order they were added. Read one with readImage(). */
  images: { id: string; type: "image/png" | "image/jpeg" | "image/webp"; byteLength: number }[];
  /** The grant the reporter gave with it, if any: whether it covers the report's workspace or
   * every workspace the reporter owns, when it ends, and when the reporter ended it early. */
  grant?: { id: string; scope: "workspace" | "account"; expiresAt: Date; endedAt?: Date };
  /** The public entries of its thread, oldest first: replies, and bare changes of status. */
  entries: {
    id: string;
    /** When it was written. */
    at: Date;
    /** Who wrote it. The id is present on the reporter's own entries only. */
    author: { id?: string; name: string };
    visibility: "public";
    /** Absent on the reporter's entries. On an admin's: how it reached the deployment, with
     * "gatekeeper" for one an agent wrote for that admin. */
    via?: "api" | "cli" | "gatekeeper";
    /** Its text: "" for a bare change of status. */
    text: string;
    /** The status this entry set, when it set one. */
    status?: "new" | "investigating" | "answered" | "waitingOnReporter" | "withAdmin" | "closed";
  }[];
}
