// A session limited to one issue report: the report as its reporter reads it, its images, a
// reply in its public thread, and the reporter's workspace as the reporter chose to show it. It
// exists so that code can be handed what the reporter could see and nothing else, which is why
// its reply may reach the reporter with no person in between.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { AdminAgentQueue } from "@gadgets/workshop-shared/admin-gatekeeper";
import {
  type AdminIssueReport, type AdminWorkspaceDescription, ISSUE_REPORT_ERROR_CODES,
  type IssueReport, type IssueReportEntry, getIssueReportErrorCode,
} from "@gadgets/workshop-shared/api";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { type BoundAdminActions, entryText } from "./actions.js";
import { type AdminSession, Lend, forwarderFor } from "./forward.js";

/**
 * The subresource id of every observation a report session makes, its view's included: one id
 * for every report. Never the whole binding's id, which is what keeps a workspace admins-only
 * for good: nothing a report session reads does that.
 */
export const REPORT_SUBRESOURCE = "instanceadmin:report";

/** How much of a report's text the card of a reply shows, to say which report it answers. */
const FIRST_LINE_LENGTH = 200;

/**
 * An issue report as its reporter reads it: the report, and the public entries of its thread
 * with an author's id only on the reporter's own. No links, no admins-only entry, and nothing of
 * where an admin's entry came from.
 */
export type ScopedIssueReport = IssueReport & { entries: Omit<IssueReportEntry, "agent">[] };

/**
 * `report` as its reporter reads it. An allowlist: each field is copied by name, so one the
 * Admin API adds later does not come through until it is named here and in types.d.ts.
 *
 * The reporter's own entry is the one with no `via`, which is the report store's rule too: no
 * id is compared, so it holds for an admin who filed the report and later answered it as one.
 */
export function scopedReport(
  report: AdminIssueReport & { entries: IssueReportEntry[] },
): ScopedIssueReport {
  const { context, grant } = report;
  return {
    id: report.id,
    filedAt: report.filedAt,
    reporter: { id: report.reporter.id, name: report.reporter.name },
    text: report.text,
    priority: report.priority,
    context: {
      ...(context.workspaceId !== undefined && { workspaceId: context.workspaceId }),
      ...(context.chatId !== undefined && { chatId: context.chatId }),
      ...(context.gadgetId !== undefined && { gadgetId: context.gadgetId }),
      ...(context.appVersion !== undefined && { appVersion: context.appVersion }),
    },
    status: report.status,
    images: report.images.map(({ id, type, byteLength }) => ({ id, type, byteLength })),
    ...(grant && {
      grant: {
        id: grant.id,
        scope: grant.scope,
        expiresAt: grant.expiresAt,
        ...(grant.endedAt !== undefined && { endedAt: grant.endedAt }),
      },
    }),
    entries: report.entries.filter((entry) => entry.visibility === "public").map((entry) => ({
      id: entry.id,
      at: entry.at,
      author: entry.via === undefined
          ? { id: entry.author.id, name: entry.author.name } : { name: entry.author.name },
      visibility: entry.visibility,
      ...(entry.via !== undefined && { via: entry.via }),
      text: entry.text,
      ...(entry.status !== undefined && { status: entry.status }),
    })),
  };
}

/**
 * What a workspace's activity records for one read of a report session, before the read is
 * made. Never flagged as restricted data: the report, its images and its public thread are what
 * the reporter could see, whatever the reporter's workspace holds.
 */
function describeRead(
  method: string, intro: string, values: Record<string, string>,
): ObservationDescription {
  const rendered = buildDescription(intro);
  for (const [label, value] of Object.entries(values)) rendered.inline(label, value);
  const { description, fields } = rendered.finish();
  return {
    title: `Issue report: ${method}`,
    description,
    ...(fields ? { fields } : {}),
    subresources: [REPORT_SUBRESOURCE],
  };
}

/**
 * The session `AdminBinding.openIssueReport()` returns. It owns its queue and asks it for a lend
 * of its own, so it shares nothing with the session that opened it and outlives it. No method
 * takes a report id, and nothing it returns leads to another report, a listing, the audit log,
 * settings or a write request.
 *
 * State lives in real private fields: RPC exposes an RpcTarget's properties as well as its
 * methods.
 */
@validateRpc()
export class IssueReportSession extends RpcTarget {
  readonly #reportId: string;
  readonly #queue: RpcStub<AdminAgentQueue>;
  readonly #actions: BoundAdminActions;
  readonly #lend: Lend;

  constructor(reportId: string, queue: RpcStub<AdminAgentQueue>, actions: BoundAdminActions) {
    super();
    this.#reportId = reportId;
    this.#queue = queue;
    this.#actions = actions;
    this.#lend = new Lend(queue);
  }

  /** The report as its reporter reads it. */
  async get(): Promise<ScopedIssueReport> {
    const admin = await this.#lend.get();
    await this.#queue.authorizeObservation(describeRead(
        "get", "Read an issue report, as its reporter sees it.", { Report: this.#reportId }));
    return scopedReport(await admin.getIssueReport(this.#reportId));
  }

  /** One image of the report, as the stream the Admin API returned: it is never read here. */
  async readImage(imageId: string): Promise<ReadableStream<Uint8Array>> {
    const admin = await this.#lend.get();
    await this.#queue.authorizeObservation(describeRead(
        "readImage", "Read an image of an issue report.",
        { Report: this.#reportId, Image: imageId }));
    return await admin.readIssueReportImage(this.#reportId, imageId);
  }

  /**
   * Queues a public reply in the report's thread, as the kind only this session queues. The
   * report is read for the card's label alone and nothing of it is returned, so it is not
   * observed.
   */
  async reply(text: string): Promise<void> {
    const entry = entryText(text);
    const admin = await this.#lend.get();
    const report = scopedReport(await admin.getIssueReport(this.#reportId));
    await this.#actions.submit(this.#queue, "issueReportScopedReply", {
      reportId: this.#reportId,
      text: entry,
      report: {
        reporter: report.reporter.name,
        filedAt: report.filedAt.toISOString(),
        firstLine: report.text.slice(0, FIRST_LINE_LENGTH),
      },
    });
  }

  /**
   * An audited view of the workspace the report names, when its reporter owns it. The session
   * decides nothing about what the view shows: the workspace answers or refuses each call under
   * `forIssueReport`, and refuses the open itself unless the report is one its owner filed
   * about it. No id is compared here.
   *
   * Skips validation: the view is a forwarder, whose type declares none of the methods it
   * defines from the schema, and a validated return would be wrapped in a proxy that refuses
   * them all. So `reason` is checked here, and the Workshop validates it again.
   */
  @skipRpcValidation()
  async inspectWorkspace(reason: string): Promise<AdminSession> {
    if (typeof reason !== "string") {
      throw new TypeError("Invalid arguments for IssueReportSession.inspectWorkspace: reason " +
          "must be a string.");
    }
    const admin = await this.#lend.get();
    // The session's own reads: nothing of either is returned, so neither is observed.
    const { context } = await admin.getIssueReport(this.#reportId);
    if (context.workspaceId === undefined) throw new Error("This report names no workspace.");
    // Content is asked for only where the deployment allows it: asking and falling back would
    // write a refused record for every view opened on a deployment that reads metadata alone.
    const { adminWorkspaceAccess } = await admin.getSettings();
    const access = adminWorkspaceAccess.effective === "content" ? "content" : "metadata";

    // Before the open, which returns a capability and no data.
    await this.#queue.authorizeObservation(describeRead(
        "inspectWorkspace", "Open the workspace of an issue report, as its reporter shows it.",
        { Report: this.#reportId, Reason: reason }));
    let view;
    try {
      view = await admin.inspectWorkspace(
          context.workspaceId, reason, { access, forIssueReport: this.#reportId });
    } catch (error) {
      if (getIssueReportErrorCode(error) === ISSUE_REPORT_ERROR_CODES.notFound) {
        throw new Error("This report's workspace is not its reporter's.", { cause: error });
      }
      throw error;
    }

    // Whether the reporter's workspace holds restricted data, asked once, here: every call on
    // the view is then observed as reading restricted data before it is forwarded, so the
    // workspace that reads is marked before the first answer reaches it. No view is handed out
    // without knowing. A reporter's workspace marked after this is read unflagged until this
    // view ends, which the Workshop makes no later than the session's lend; asking before every
    // call would double the audit records of every read.
    let description: AdminWorkspaceDescription;
    try {
      description = await view.describe();
    } catch (error) {
      view[Symbol.dispose]();
      throw error;
    }
    const restricted = description.containsRestrictedData === true;
    return new (forwarderFor("AdminWorkspaceView"))(
        this.#queue.dup(), { restricted, subresource: REPORT_SUBRESOURCE }, view);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
    this.#lend[Symbol.dispose]();
  }
}
