// The session limited to one issue report: what it returns of the report, that nothing it takes
// or returns reaches another, what its reads record, and how it opens the reporter's workspace.

import { ADMIN_BINDING_SUBRESOURCE } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, ISSUE_REPORT_ERROR_CODES, createAdminAccessError,
  createIssueReportError, getAdminAccessErrorCode,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";
import { scopedReport } from "../../src/report-session.js";
import { SERVICES } from "../../src/surface.js";
import HAND_WRITTEN_TYPES from "../../src/types.txt";
import {
  REPORT_ID, type Recording, type Session, VIEW, issueReport, openBinding, recordingTarget,
  rejection, sampleArguments, workshop,
} from "./fakes.js";

const BYTES = new Uint8Array([1, 2, 3, 4]);
const VIEW_METHODS = SERVICES.get(VIEW)!;

/** The fixture report as its reporter reads it: what get() must return, and nothing more. */
const SCOPED = {
  id: REPORT_ID,
  filedAt: new Date("2026-03-04T05:06:07.000Z"),
  reporter: { id: "ada", name: "Ada" },
  text: "The sheet is empty.",
  priority: "high",
  context: { workspaceId: "workspace-1", chatId: 4 },
  status: "investigating",
  images: [{ id: "image-1", type: "image/png", byteLength: 4 }],
  grant: { id: "grant-1", scope: "workspace", expiresAt: new Date("2026-03-05T00:00:00.000Z") },
  entries: [
    { id: "e1", at: new Date("2026-03-04T05:10:00.000Z"), author: { id: "ada", name: "Ada" },
      visibility: "public", text: "It still happens." },
    { id: "e3", at: new Date("2026-03-04T05:30:00.000Z"), author: { name: "Grace" },
      visibility: "public", via: "gatekeeper", text: "We are looking." },
    // The reporter, answering as an admin: the entry has a `via`, so it carries no id.
    { id: "e4", at: new Date("2026-03-04T05:40:00.000Z"), author: { name: "Ada" },
      visibility: "public", via: "cli", text: "", status: "investigating" },
  ],
};

/**
 * The Workshop's side of a triage: a queue, and an Admin API that knows the one report, the
 * level in force and the reporter's workspace. Each field of `state` can be changed mid-test.
 */
function triage() {
  const views: Recording[] = [];
  const state = {
    report: issueReport() as Record<string, unknown> | Error,
    effective: "content",
    /** What the reporter's workspace says of itself, or the error describing it fails with. */
    description: { id: "workspace-1", owner: { id: "ada-as-the-workspace-keeps-it" } } as unknown,
    /** What the open is refused with, when it is. */
    open: undefined as Error | undefined,
    /** What a call on the view other than describe() is refused with, when it is. */
    viewCall: undefined as Error | undefined,
  };
  const side = workshop((name) => {
    switch (name) {
      case "getIssueReport":
        if (state.report instanceof Error) throw state.report;
        return state.report;
      case "getSettings":
        return { adminWorkspaceAccess: { effective: state.effective } };
      case "readIssueReportImage":
        return new Blob([BYTES]).stream();
      case "inspectWorkspace": {
        if (state.open) throw state.open;
        const view = recordingTarget(VIEW, VIEW_METHODS, side.log, (method) => {
          if (method === "describe") {
            if (state.description instanceof Error) throw state.description;
            return state.description;
          }
          if (state.viewCall) throw state.viewCall;
          return { answered: method };
        });
        views.push(view);
        return view;
      }
      default:
        return { answered: name };
    }
  });
  return { ...side, views, state };
}

/** A report session over `queue`, and the session of the whole binding that opened it. */
async function openReport(queue: ReturnType<typeof triage>["queue"]) {
  const { session: root } = await openBinding(queue);
  return { root, report: await root.openIssueReport!(REPORT_ID) as Session };
}

/** A public entry the reporter's account wrote: as the reporter, or as an admin through `via`. */
const adasEntry = (via?: string) => ({
  id: "e", at: new Date(0), author: { id: "ada", name: "Ada" }, visibility: "public", text: "x",
  ...(via && { via }),
});

describe("scopedReport()", () => {
  it("copies the fields it names, the public entries, and nothing else", () => {
    expect(scopedReport(issueReport() as never)).toEqual(SCOPED);
  });

  it("leaves out what a report lacks", () => {
    const bare = scopedReport(issueReport({ context: {}, grant: undefined, entries: [] }) as never);
    expect(bare.context).toEqual({});
    expect(bare).not.toHaveProperty("grant");
    expect(bare.entries).toEqual([]);
  });

  it("keeps an author's id by the entry's `via`, never by whose id it is", () => {
    const { entries } = scopedReport(
        issueReport({ entries: [adasEntry(), adasEntry("api")] }) as never);
    // Both were written by the reporter's account: only the one written as the reporter has it.
    expect(entries.map((scoped) => scoped.author)).toEqual([{ id: "ada", name: "Ada" }, { name: "Ada" }]);
  });

  it("reads a status this build does not know as \"withAdmin\", on the report and on an entry", () => {
    const later = "addedSince" as never;
    const scoped = scopedReport(issueReport({
      status: later, entries: [{ ...adasEntry("api"), text: "", status: later }],
    }) as never);
    expect(scoped.status).toBe("withAdmin");
    expect(scoped.entries.map((entry) => entry.status)).toEqual(["withAdmin"]);
  });
});

/** A bare change of status an admin made, as the admins read it. */
const moved = (id: string, status: string, visibility = "public") => ({
  id, at: new Date("2026-03-04T05:50:00.000Z"), author: { id: "grace", name: "Grace" },
  visibility, via: "api", text: "", status,
});

describe("a report session's view of a fix", () => {
  const ADMINS_OWN = /fixSuggested|fixInProgress/;

  it.each(["fixSuggested", "fixInProgress"] as const)(
      "reads a suggested or in-progress fix as withAdmin, on the report and on a thread line (%s)",
      async (status) => {
    const { queue, state } = triage();
    state.report = issueReport({ status, entries: [moved("e5", status)] });
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const read = await report.get!();

    expect(read.status).toBe("withAdmin");
    expect(read.entries).toEqual([{
      id: "e5", at: new Date("2026-03-04T05:50:00.000Z"), author: { name: "Grace" },
      visibility: "public", via: "api", text: "", status: "withAdmin",
    }]);
    expect(JSON.stringify(read)).not.toMatch(ADMINS_OWN);
  });

  it("reads a proposed fix as itself", () => {
    const scoped = scopedReport(
        issueReport({ status: "fixProposed", entries: [moved("e5", "fixProposed")] }) as never);
    expect(scoped.status).toBe("fixProposed");
    expect(scoped.entries.map((entry) => entry.status)).toEqual(["fixProposed"]);
  });

  it("never returns an admins-only status line", async () => {
    const { queue, state } = triage();
    state.report = issueReport({
      status: "fixInProgress",
      entries: [
        moved("e5", "withAdmin"), moved("e6", "fixSuggested", "admins"),
        moved("e7", "fixInProgress", "admins"),
      ],
    });
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const read = await report.get!();

    expect(read.status).toBe("withAdmin");
    expect(read.entries.map((entry: { id: string }) => entry.id)).toEqual(["e5"]);
    expect(JSON.stringify(read)).not.toMatch(ADMINS_OWN);
  });
});

/**
 * What calling `name` on `report` is refused with. An RPC stub answers every name, so only a
 * call's rejection says the session has no such method: the same refusal as for a name nothing
 * has.
 */
const refusalOf = async (report: Session, name: string, ...args: unknown[]) =>
  (await rejection(report[name]!(...args))).message;

/**
 * The text of one interface in the declarations an agent is given, to its closing brace. A
 * session's declarations are its own two interfaces: the rest of the file describes the whole
 * connection.
 */
function declarationOf(name: string): string {
  const start = HAND_WRITTEN_TYPES.indexOf(`export interface ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return HAND_WRITTEN_TYPES.slice(start, HAND_WRITTEN_TYPES.indexOf("\n}\n", start));
}

describe("a report session", () => {
  it("is opened without a lend, a read or an observation", async () => {
    const { log, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    expect(log).toEqual([]);
  });

  it("returns the report as its reporter reads it: lent, observed, then read", async () => {
    const { log, admin, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const read = await report.get!();

    expect(read).toEqual(SCOPED);
    for (const absent of ["links", "updatedAt", "secretNote"]) expect(read).not.toHaveProperty(absent);
    for (const entry of read.entries) {
      expect(entry).not.toHaveProperty("agent");
      expect(entry).not.toHaveProperty("internal");
    }
    expect(JSON.stringify(read)).not.toContain("grace");
    expect(log).toEqual(["getAdminApi", "observe Issue report: get", "AdminApi.getIssueReport"]);
    expect(admin.calls).toEqual([{ name: "getIssueReport", args: [REPORT_ID] }]);
    expect(queue.observations).toEqual([{
      title: "Issue report: get",
      description: "Read an issue report, as its reporter sees it.",
      fields: [{ label: "Report", kind: "inline", value: REPORT_ID }],
      containsRestrictedData: true,
      subresources: [ADMIN_BINDING_SUBRESOURCE],
    }]);
  });

  it("reads an image of its own report, handing the stream on unread", async () => {
    const { admin, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const stream = await report.readImage!("image-1");

    expect(new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer())).toEqual(BYTES);
    expect(admin.calls).toEqual([{ name: "readIssueReportImage", args: [REPORT_ID, "image-1"] }]);
    expect(queue.observations).toEqual([{
      title: "Issue report: readImage",
      description: "Read an image of an issue report.",
      fields: [
        { label: "Report", kind: "inline", value: REPORT_ID },
        { label: "Image", kind: "inline", value: "image-1" },
      ],
      containsRestrictedData: true,
      subresources: [ADMIN_BINDING_SUBRESOURCE],
    }]);
  });

  it("reads nothing when its observation is refused", async () => {
    const { log, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;
    queue.refuseObservations = true;

    for (const call of [() => report.get!(), () => report.readImage!("image-1")]) {
      expect((await rejection(call())).message).toBe("The approval queue refused this observation.");
    }
    expect((await rejection(report.inspectWorkspace!("triage"))).message)
        .toBe("The approval queue refused this observation.");

    expect(log.filter((entry) => /getIssueReport|readIssueReportImage|inspectWorkspace$/.test(entry)))
        // The reads inspectWorkspace() makes for itself, before its observation.
        .toEqual(["AdminApi.getIssueReport", "observe Issue report: inspectWorkspace"]);
  });

  it("has no way to name another report", async () => {
    const { admin, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    // An argument get() does not take is not read, and readImage()'s one argument is an image.
    await report.get!("report-2");
    await report.readImage!("report-2");
    expect(admin.calls.map((call) => call.args[0])).toEqual([REPORT_ID, REPORT_ID]);

    for (const call of [
      () => report.openIssueReport!("report-2"),
      () => report.getIssueReport!("report-2"),
      () => report.listIssueReports!(),
      () => report.addIssueReportEntry!("report-2", "x", "public"),
      () => report.readImage!(2),
      () => report.readImage!(),
      () => report.reply!(2),
      () => report.inspectWorkspace!(2),
      () => report.inspectWorkspace!(),
    ]) {
      expect((await rejection(call())).message).not.toBe("did not reject");
    }
    // The Admin API's order, a workspace id and then the reason, is refused: the id would be
    // recorded as the reason of the open and of every call on the view.
    expect((await rejection(report.inspectWorkspace!("w".repeat(64), "triage"))).message).toBe(
        "Invalid arguments for IssueReportSession.inspectWorkspace: it takes the reason alone, " +
        "a string. The workspace is the report's.");
    expect(admin.calls).toHaveLength(2);
  });

  it("has no method that assigns", async () => {
    const { log, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const refused = await refusalOf(report, "noSuchMethod", REPORT_ID);
    expect(refused).not.toBe("did not reject");
    for (const call of [
      () => refusalOf(report, "claimIssueReport", REPORT_ID),
      () => refusalOf(report, "claimIssueReport", REPORT_ID, { takeOverFrom: "linus" }),
      () => refusalOf(report, "claimIssueReport"),
      () => refusalOf(report, "releaseIssueReport", REPORT_ID),
      () => refusalOf(report, "releaseIssueReport"),
    ]) {
      expect((await call()).replace(/claimIssueReport|releaseIssueReport/, "noSuchMethod"))
          .toBe(refused);
    }

    expect(log).toEqual([]);
    expect(queue.submitted).toEqual([]);
  });

  it("has no whoami()", async () => {
    const { log, admin, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    // A session limited to one report names nobody but its reporter: which admin it answers
    // for is not its to tell.
    expect((await refusalOf(report, "whoami")).replace("whoami", "noSuchMethod"))
        .toBe(await refusalOf(report, "noSuchMethod"));

    expect(log).toEqual([]);
    expect(queue.observations).toEqual([]);
    expect(admin.calls).toEqual([]);
  });

  it("declares none of the three, and no assignee", () => {
    const session = declarationOf("IssueReportSession");
    const report = declarationOf("ScopedIssueReport");
    expect(session).toContain("reply(text: string): Promise<void>;");
    expect(report).toContain("entries: {");
    for (const name of ["claimIssueReport", "releaseIssueReport", "whoami"]) {
      expect(session, name).not.toContain(name);
    }
    expect(session + report).not.toMatch(/assignee|assignment/i);
  });

  it("returns no assignee and no assignment line", async () => {
    const { queue, state } = triage();
    const held = { id: "grace", name: "Grace", at: new Date("2026-03-04T05:45:00.000Z"), via: "api" };
    const base = issueReport();
    state.report = issueReport({
      assignee: held,
      entries: [
        ...base.entries,
        { id: "e5", at: held.at, author: { id: "grace", name: "Grace" }, visibility: "admins",
          via: "api", text: "", assignment: "claimed" },
        { id: "e6", at: new Date("2026-03-04T05:46:00.000Z"), author: { id: "linus", name: "Linus" },
          visibility: "admins", via: "gatekeeper", agent: { workspaceId: "fixes", chatId: 1 },
          text: "", assignment: "takenOver" },
      ],
    });
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    const read = await report.get!();

    // Exactly what it returns of a report nobody holds.
    expect(read).toEqual(SCOPED);
    expect(read).not.toHaveProperty("assignee");
    for (const entry of read.entries) expect(entry).not.toHaveProperty("assignment");
    expect(JSON.stringify(read)).not.toMatch(/assign|claimed|takenOver|linus/i);
  });

  it("refuses a report that does not exist at its first call", async () => {
    const { queue, state } = triage();
    state.report = createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound);
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    for (const call of [() => report.get!(), () => report.reply!("x"), () => report.inspectWorkspace!("triage")]) {
      expect((await rejection(call())).message).toBe("No such issue report.");
    }
    expect(queue.submitted).toEqual([]);
  });

  it("outlives the session that opened it, on a lend of its own", async () => {
    const { log, admin, queue } = triage();
    const { root, report } = await openReport(queue);
    using _report = report;

    root[Symbol.dispose]();
    expect(await report.get!()).toEqual(SCOPED);
    expect((await rejection(root.listUsers!())).message).not.toBe("did not reject");

    // The root read nothing, so the one lend is the report session's, as is the queue's last copy.
    expect(log.filter((entry) => entry === "getAdminApi")).toHaveLength(1);
    expect([queue.disposed, admin.disposed]).toEqual([0, 0]);
  });

  it("releases its queue and its lend when it is disposed", async () => {
    const { admin, queue } = triage();
    const { root, report } = await openReport(queue);
    await report.get!();

    report[Symbol.dispose]();
    await vi.waitFor(() => expect(admin.disposed).toBe(1));
    // The queue is released once its last copy is: the root session still holds one.
    expect(queue.disposed).toBe(0);
    root[Symbol.dispose]();
    await vi.waitFor(() => expect(queue.disposed).toBe(1));
  });
});

describe("a report session's reply", () => {
  it("is queued with the report's label, read by the session and returned to nobody", async () => {
    const { log, queue } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    expect(await report.reply!("Fixed, please retry.")).toBeUndefined();

    expect(log).toEqual(["getAdminApi", "AdminApi.getIssueReport", "submit issue-report-scoped-reply"]);
    expect(queue.observations).toEqual([]);
    expect(queue.submitted[0]!.description.title).toBe(`Reply to Ada on issue report ${REPORT_ID}`);
  });

  it("shows no more of a long report than how it begins", async () => {
    const { queue, state } = triage();
    state.report = issueReport({ text: "a".repeat(200) + "b".repeat(50) });
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    await report.reply!("Thanks.");

    expect(queue.submitted[0]!.description.fields).toContainEqual(
        { label: "Report begins", kind: "text", value: "a".repeat(200) });
  });
});

describe("a report session's view of the reporter's workspace", () => {
  it("is opened for the level in force, in one call, after the session's own reads", async () => {
    for (const [effective, access] of [["content", "content"], ["metadata", "metadata"], ["off", "metadata"]]) {
      const { log, admin, queue, state } = triage();
      state.effective = effective!;
      const { root, report } = await openReport(queue);
      using _root = root;
      using _report = report;

      using _view = await report.inspectWorkspace!("triage") as Session;

      expect(log, effective).toEqual([
        "getAdminApi", "AdminApi.getIssueReport", "AdminApi.getSettings",
        "observe Issue report: inspectWorkspace", "AdminApi.inspectWorkspace",
      ]);
      expect(admin.calls.at(-1), effective).toEqual({
        name: "inspectWorkspace",
        args: ["workspace-1", "triage", { access, forIssueReport: REPORT_ID }],
      });
      expect(queue.observations).toEqual([{
        title: "Issue report: inspectWorkspace",
        description: "Open the workspace of an issue report, as its reporter shows it.",
        fields: [
          { label: "Report", kind: "inline", value: REPORT_ID },
          { label: "Reason", kind: "inline", value: "triage" },
        ],
        containsRestrictedData: true,
        subresources: [ADMIN_BINDING_SUBRESOURCE],
      }]);
    }
  });

  it("is refused for a report that names no workspace, before anything is opened", async () => {
    const { log, queue, state } = triage();
    state.report = issueReport({ context: { appVersion: "1.2.3" } });
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    expect((await rejection(report.inspectWorkspace!("triage"))).message)
        .toBe("This report names no workspace.");

    expect(log).toEqual(["getAdminApi", "AdminApi.getIssueReport"]);
  });

  it("is refused for a workspace that is not the reporter's, which the workspace decides", async () => {
    const { queue, views, state } = triage();
    state.open = createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound);
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    expect((await rejection(report.inspectWorkspace!("triage"))).message)
        .toBe("This report's workspace is not its reporter's.");

    // Nothing was opened, so nothing was described.
    expect(views).toEqual([]);
  });

  it("passes every other refusal of the open through as it is", async () => {
    for (const code of [ADMIN_ACCESS_ERROR_CODES.accessOff, ADMIN_ACCESS_ERROR_CODES.contentOff]) {
      const { queue, state } = triage();
      state.open = createAdminAccessError(code);
      const { root, report } = await openReport(queue);
      using _root = root;
      using _report = report;

      const refused = await rejection(report.inspectWorkspace!("triage"));

      expect(refused.message).toBe(state.open.message);
      expect(getAdminAccessErrorCode(refused)).toBe(code);
    }
  });

  it("compares no ids: the open decides, whatever the reporter's and the owner's ids look like", async () => {
    const { queue, views, state } = triage();
    state.description = {
      owner: { id: "f".repeat(64) }, grants: [{ id: "grant-1", source: "owner" }],
    };
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;

    using view = await report.inspectWorkspace!("triage") as Session;

    // The description comes back as the workspace gave it: filtering its grants is the workspace's.
    expect(await view.describe!()).toEqual(state.description);
    expect(views).toHaveLength(1);
  });

  it("forwards a content call unchanged, and passes the workspace's refusal through", async () => {
    const { queue, views, state } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;
    using view = await report.inspectWorkspace!("triage") as Session;

    expect(await view.getChat!(4, 9)).toEqual({ answered: "getChat" });
    expect(views[0]!.calls.at(-1)).toEqual({ name: "getChat", args: [4, 9] });

    state.viewCall = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    const refused = await rejection(view.getChat!(4));
    expect(getAdminAccessErrorCode(refused)).toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    expect(refused.message).toBe(state.viewCall.message);
  });
});

/** Calls every method of `report` and of its view once, and returns the titles they record. */
async function readEverything(report: Session) {
  await report.get!();
  await report.readImage!("image-1");
  await report.reply!("Thanks.");
  using view = await report.inspectWorkspace!("triage") as Session;
  for (const name of VIEW_METHODS) await view[name]!(...sampleArguments(VIEW, name));
  return [
    "Issue report: get", "Issue report: readImage", "Issue report: inspectWorkspace",
    ...VIEW_METHODS.map((name) => `Admin view: ${name}`),
  ];
}

describe("what a report session's reads record", () => {
  // A report's text and images are whatever its reporter put there, and anyone can file one.
  it("the mark and the whole binding's id on each, whatever the reporter's workspace holds", async () => {
    for (const description of [{ containsRestrictedData: true }, { containsRestrictedData: false }, {}]) {
      const { log, queue, views, state } = triage();
      state.description = description;
      const { root, report } = await openReport(queue);
      using _root = root;
      using _report = report;

      const titles = await readEverything(report);

      expect(queue.observations.map((observation) => observation.title)).toEqual(titles);
      for (const observation of queue.observations) {
        expect(observation.subresources, observation.title).toEqual([ADMIN_BINDING_SUBRESOURCE]);
        expect(observation.containsRestrictedData, observation.title).toBe(true);
      }
      // Each call of the view is observed before it is forwarded, metadata and content alike.
      for (const name of VIEW_METHODS) {
        const observed = log.indexOf(`observe Admin view: ${name}`);
        expect(observed, name).toBeGreaterThan(-1);
        expect(log[observed + 1], name).toBe(`AdminWorkspaceView.${name}`);
      }
      // The session asks the view nothing of its own: describe() ran once, for the caller.
      expect(views[0]!.calls.filter((call) => call.name === "describe")).toHaveLength(1);
    }
  });

  it("nothing of the view when the observation is refused", async () => {
    const { queue, views } = triage();
    const { root, report } = await openReport(queue);
    using _root = root;
    using _report = report;
    using view = await report.inspectWorkspace!("triage") as Session;
    queue.refuseObservations = true;

    expect((await rejection(view.listChats!())).message)
        .toBe("The approval queue refused this observation.");

    expect(queue.observations.at(-1)).toMatchObject(
        { title: "Admin view: listChats", containsRestrictedData: true });
    expect(views[0]!.calls).toEqual([]);
  });
});
