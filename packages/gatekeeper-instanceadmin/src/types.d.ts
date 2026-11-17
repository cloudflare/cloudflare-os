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

  /**
   * Call `hook` once for each issue report filed from now on, as it is filed: its images and
   * the grant its reporter may give with it are attached by later calls, so a subscriber that
   * reads at once may find no image and be refused content, and reads again later rather than
   * concluding there is none.
   *
   * `hook` is a persistent stub, made with ctx.restore() by the gadget whose [restore]()
   * returns the callback. Subscribing reads nothing: the hook is bound disabled, and delivers
   * once a person enables it.
   */
  subscribeIssueReported(hook: IssueReportedHook): Promise<void>;

  /**
   * Call `hook` each time an admin ends a report's investigation: its status leaves
   * "investigating" for any status but "new". `hook` is a persistent stub, as for
   * subscribeIssueReported().
   */
  subscribeInvestigationComplete(hook: InvestigationCompleteHook): Promise<void>;

  /**
   * Call `hook` each time an issue report is written to after it was filed: its status set,
   * a claim, a take-over or a release, an entry added to its thread (its reporter's reply, an
   * admin's reply or note, an agent's), or its links replaced. It fires for every such write,
   * whoever made it: an admin, the reporter, another admin's agents and gadgets, and YOUR OWN
   * agents and gadgets too. That is how code learns that an action it queued was applied: the
   * event arrives once the action is approved and has run. So a subscriber that writes to a
   * report on each event must not answer its own change: it reads the report, acts only where
   * something it is for has changed, and never writes merely because it was called. No event
   * comes for an action that changed nothing when it ran (a claim of a report this workspace's
   * owner already holds, a status the report already has), for one that was denied, or for
   * one refused where it lands (`assigned`, `threadFull`): code that waits to learn what
   * became of an action reads the report as well, and never waits on the event alone. `hook`
   * is a persistent stub, as for subscribeIssueReported().
   */
  subscribeIssueReportChanged(hook: IssueReportChangedHook): Promise<void>;
}

/**
 * The callback of subscribeIssueReported(). An event carries ids and labels only: read the
 * report through the binding the gadget holds. A callback can be called more than once for the
 * same event: key the work by `eventId`, which is the same each time one event is delivered and
 * differs between two events. A callback answers within 30 seconds: it starts long work (a call
 * to an agent is recorded and returns) and does not wait for it. One that takes longer counts
 * as failed and is called again later.
 */
export interface IssueReportedHook {
  /**
   * Called as the report is filed: its images and the grant its reporter may give with it are
   * attached by later calls, so a subscriber that reads at once may find no image and be
   * refused content, and reads again later rather than concluding there is none.
   */
  issueReported(event: {
    /** Random and opaque: this event's own id. */
    eventId: string;
    reportId: string;
    priority: "low" | "medium" | "high";
    filedAt: Date;
  }): void;
}

/**
 * The callback of subscribeInvestigationComplete(). An event carries ids and labels only. A
 * callback can be called more than once for the same event, and a report's investigation can
 * end more than once, with the same status and at the same `at` too: key the work by `eventId`,
 * which is the same each time one event is delivered and differs between two ends. It answers
 * within 30 seconds, as IssueReportedHook's does.
 */
export interface InvestigationCompleteHook {
  /** Called when an admin moved the report from "investigating" to `status`, at `at`. */
  investigationComplete(event: {
    /** Random and opaque: this event's own id. */
    eventId: string;
    reportId: string;
    status: "answered" | "waitingOnReporter" | "withAdmin" | "fixSuggested" | "fixInProgress" |
        "fixProposed" | "closed";
    at: Date;
  }): void;
}

/**
 * The callback of subscribeIssueReportChanged(). An event carries ids and labels only: never
 * the text of an entry, a name or who made the write. Read the report through this binding.
 * It is called for a write this workspace's own agents and gadgets made too. A report that
 * leaves "investigating" calls this and InvestigationCompleteHook, with an event id each. A
 * callback can be called more than once for the same event: key the work by `eventId`, which
 * is the same each time one event is delivered and differs between two writes. The events of
 * one report can arrive in any order, and two calls for it can run at once: never keep the
 * last event's `status` as the report's, and never take two calls for one report to run one
 * after the other. It answers within 30 seconds, as IssueReportedHook's does.
 */
export interface IssueReportChangedHook {
  /** Called when the report was written to, at `at`. */
  issueReportChanged(event: {
    /** Random and opaque: this event's own id. */
    eventId: string;
    reportId: string;
    /** What the write was: the status set ("status"), a claim, a take-over or a release
     * ("assignment"), a public entry by the reporter or an admin ("reply"), an entry for
     * admins alone ("note"), or the links replaced ("links"). */
    change: "status" | "assignment" | "reply" | "note" | "links";
    /** The status the write set, as admins read it, when it set one: on every "status", and
     * on the reporter's "reply" that reopened the report. A later write may have set another
     * by the time this arrives, in an event that arrived first: read the report for the status
     * it has. */
    status?: "new" | "investigating" | "answered" | "waitingOnReporter" | "withAdmin" |
        "fixSuggested" | "fixInProgress" | "fixProposed" | "closed";
    at: Date;
  }): void;
}

/**
 * What a gadget's callback implements, as the RpcTarget its [restore]() returns: the method of
 * each hook it is subscribed to, as IssueReportedHook, InvestigationCompleteHook and
 * IssueReportChangedHook declare it. One callback can serve all three hooks.
 */
export interface IssueReportHook
  extends Partial<IssueReportedHook>, Partial<InvestigationCompleteHook>,
    Partial<IssueReportChangedHook> {}

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
   * account-wide grant, is live. Its description lists no other grant. It takes the reason
   * alone, which the deployment's audit log keeps: the workspace is the report's, and an id
   * given before the reason is refused. Throws when the report names no workspace or one its
   * reporter does not own. When that workspace holds restricted data, every answer of the view
   * marks THIS workspace as holding restricted data too: from the first one on, nothing here is
   * applied without a person (a reply through this session included) and web fetches reach only
   * trusted hosts. The report itself, its images and its thread never mark.
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
  /** Where it stands. The admins' "fixSuggested" and "fixInProgress" read as "withAdmin" here. */
  status: "new" | "investigating" | "answered" | "waitingOnReporter" | "withAdmin" | "fixProposed" |
      "closed";
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
    /** The status this entry set, when it set one. The admins' "fixSuggested" and
     * "fixInProgress" read as "withAdmin" here. */
    status?: "new" | "investigating" | "answered" | "waitingOnReporter" | "withAdmin" |
        "fixProposed" | "closed";
  }[];
}
