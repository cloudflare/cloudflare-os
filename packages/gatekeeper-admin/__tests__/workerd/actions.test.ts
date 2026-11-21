// The seven action kinds: what queues each, what its card says, which a rule may approve, and what
// applying one does and fails as. Actions are queued through sessions the facet opened and
// applied through the facet, over RPC, so a refusal's code crosses a hop as it does from the
// Workshop.

import { ActionJournal, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { ADMIN_AGENT_ACTIONS, type AdminAgentAction } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, ISSUE_REPORT_ERROR_CODES,
  ISSUE_REPORT_STATUSES, type IssueReportStatus, MAX_ADMIN_ACCESS_REASON_LENGTH,
  MAX_ISSUE_REPORT_TEXT_LENGTH, createAdminAccessError, createAdminGrantError,
  createIssueReportError,
} from "@gadgets/workshop-shared/api";
import type { ActionDescription, ActionField } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import { ADMIN_ACTIONS, type AdminActions, TERMINAL_REFUSALS } from "../../src/actions.js";
import {
  type Answer, type Log, REPORT_ID, type Recording, type Session, adminApi, facet, issueReport,
  openBinding, rejection, workshop,
} from "./fakes.js";

const WORKSPACE = "workspace-9";
const OUTCOME_UNKNOWN = "The Admin API did not say whether this was done. Check the report's " +
  "thread (or the audit log, for a write or a request) before rejecting this action.";

/** The Admin API a session is lent: it knows the one report. */
const lends: Answer = (name) => name === "getIssueReport" ? issueReport() : { answered: name };

type Case = {
  kind: AdminAgentAction;
  /** Queues the action through `binding`, a session of the whole binding. */
  queue(binding: Session): Promise<unknown>;
  /** What the fakes see when it is queued. */
  queuedLog: string[];
  /** The stored payload, as the action set takes it. */
  payload: AdminActions[AdminAgentAction];
  /** The one call its apply makes. */
  call: { name: string; args: unknown[] };
  title: string;
  description: string;
  fields: ActionField[];
};

const writeFields = (action: string, args: unknown, reason: string): ActionField[] => [
  { label: "Workspace", kind: "inline", value: WORKSPACE },
  { label: "Action", kind: "inline", value: action },
  { label: "Arguments", kind: "json", value: JSON.stringify(args, null, 2) },
  { label: "Reason", kind: "text", value: reason },
];

const contentFields = (reason: string): ActionField[] => [
  { label: "Workspace", kind: "inline", value: WORKSPACE },
  { label: "Reason", kind: "text", value: reason },
];

const CASES: Case[] = [
  {
    kind: "issueReportReply",
    queue: (binding) => binding.addIssueReportEntry!(REPORT_ID, "  We are looking.\n", "public"),
    queuedLog: ["submit issue-report-reply"],
    payload: { reportId: REPORT_ID, text: "We are looking." },
    call: { name: "addIssueReportEntry", args: [REPORT_ID, "We are looking.", "public"] },
    title: `Reply to the reporter of issue report ${REPORT_ID}`,
    description: "Posts this reply in the report's public thread, where its reporter reads it. " +
      "It was written with access to what only admins see: read it before approving.",
    fields: [
      { label: "Report", kind: "inline", value: REPORT_ID },
      { label: "Reply", kind: "text", value: "We are looking." },
    ],
  },
  {
    kind: "issueReportScopedReply",
    queue: async (binding) => {
      using session = await binding.openIssueReport!(REPORT_ID) as Session;
      await session.reply!("Fixed, please retry.");
    },
    // No lend and no read of the report: the card is the call's own.
    queuedLog: ["submit issue-report-scoped-reply"],
    payload: { reportId: REPORT_ID, text: "Fixed, please retry." },
    call: { name: "addIssueReportEntry", args: [REPORT_ID, "Fixed, please retry.", "public"] },
    title: `Reply to the reporter of issue report ${REPORT_ID}, from a session limited to it`,
    description: "Posts this reply in the report's public thread. Sent from a session limited " +
      "to this report.",
    fields: [
      { label: "Report", kind: "inline", value: REPORT_ID },
      { label: "Reply", kind: "text", value: "Fixed, please retry." },
    ],
  },
  {
    kind: "issueReportNote",
    queue: (binding) => binding.addIssueReportEntry!(REPORT_ID, "Cache key looks stale.", "admins"),
    queuedLog: ["submit issue-report-note"],
    payload: { reportId: REPORT_ID, text: "Cache key looks stale." },
    call: { name: "addIssueReportEntry", args: [REPORT_ID, "Cache key looks stale.", "admins"] },
    title: `Add an admins-only note to issue report ${REPORT_ID}`,
    description: "Adds this note to the report's thread. Only admins read it.",
    fields: [
      { label: "Report", kind: "inline", value: REPORT_ID },
      { label: "Note", kind: "text", value: "Cache key looks stale." },
    ],
  },
  {
    kind: "issueReportStatus",
    queue: (binding) => binding.setIssueReportStatus!(REPORT_ID, "waitingOnReporter"),
    queuedLog: ["submit issue-report-status"],
    payload: { reportId: REPORT_ID, status: "waitingOnReporter" },
    call: { name: "setIssueReportStatus", args: [REPORT_ID, "waitingOnReporter"] },
    title: `Set issue report ${REPORT_ID} to Waiting on the reporter`,
    description: "Changes the report's status. Its reporter sees the change in the thread, " +
      "unless they read the old status and the new one as the same.",
    fields: [
      { label: "Report", kind: "inline", value: REPORT_ID },
      { label: "Status", kind: "inline", value: "Waiting on the reporter" },
    ],
  },
  {
    // A claim stands for the kind here; a release has its own cases below.
    kind: "issueReportAssignment",
    queue: (binding) => binding.claimIssueReport!(REPORT_ID),
    queuedLog: ["submit issue-report-assignment"],
    payload: { reportId: REPORT_ID, assignment: "claim" },
    call: { name: "claimIssueReport", args: [REPORT_ID] },
    title: `Assign issue report ${REPORT_ID} to this workspace's owner`,
    description: "Makes this workspace's owner, the admin this connection acts as, the " +
      "report's assignee, whoever approves this. Every admin sees who holds a report. Nothing " +
      "changes if the owner already holds it, and it is refused if another admin does: it never " +
      "takes a report from anyone.",
    fields: [
      { label: "Report", kind: "inline", value: REPORT_ID },
      { label: "Assignee", kind: "inline", value: "This workspace's owner" },
    ],
  },
  {
    kind: "workspaceWriteRequest",
    queue: (binding) =>
      binding.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 3 }, "It loops.\nStop it."),
    queuedLog: ["submit workspace-write-request"],
    payload: { workspaceId: WORKSPACE, action: "stopAgent", args: { chatId: 3 }, reason: "It loops.\nStop it." },
    call: { name: "writeWorkspace", args: [WORKSPACE, "stopAgent", { chatId: 3 }, "It loops.\nStop it."] },
    title: `Write to workspace ${WORKSPACE}: stopAgent`,
    description: "Runs the write as the owner, a deployment admin, as soon as this is approved. " +
      "Its reason goes to the deployment's admin audit log, not to that workspace, whose members " +
      "see only what the write does.",
    fields: writeFields("stopAgent", { chatId: 3 }, "It loops.\nStop it."),
  },
  {
    kind: "contentAccessRequest",
    queue: (binding) => binding.requestContentAccess!(WORKSPACE, "Need the chat."),
    queuedLog: ["submit content-access-request"],
    payload: { workspaceId: WORKSPACE, reason: "Need the chat." },
    call: { name: "requestContentAccess", args: [WORKSPACE, "Need the chat."] },
    title: `Ask the admins for access to the content of workspace ${WORKSPACE}`,
    description: "Files a request that another deployment admin approves from the admin " +
      "panel's pending approvals: once approved, admins can read that workspace's chats and " +
      "files for a time. Nobody who is in this workspace now, you included once you approve " +
      "this, can approve that request.",
    fields: contentFields("Need the chat."),
  },
];

const caseOf = (kind: AdminAgentAction) => CASES.find((candidate) => candidate.kind === kind)!;

/** `candidate`'s action, queued on a facet of its own. */
async function queued(candidate: Case) {
  const { log, admin, queue } = workshop(lends);
  const { gatekeeper, session } = await openBinding(queue);
  await candidate.queue(session);
  session[Symbol.dispose]();
  return { log, admin, queue, gatekeeper, id: queue.submitted[0]!.action };
}

/** An Admin API lent for one action, which answers every call with `answer`. */
const lent = (answer?: Answer) => adminApi([] as Log, answer);
/** One that records each call and then fails it with `error`. */
const failing = (error: unknown) => lent(() => { throw error; });

/** The refusal the Admin API makes with `code`. */
function refusal(code: string): Error {
  const among = (codes: Record<string, string>) => Object.values(codes).includes(code);
  if (among(ISSUE_REPORT_ERROR_CODES)) return createIssueReportError(code as never);
  if (among(ADMIN_GRANT_ERROR_CODES)) return createAdminGrantError(code as never);
  return createAdminAccessError(code as never);
}

describe("each action kind", () => {
  it("has a case here, and a tag no other kind has", () => {
    expect(CASES.map((candidate) => candidate.kind).toSorted())
        .toEqual(Object.keys(ADMIN_AGENT_ACTIONS).toSorted());
    const tags = Object.values(ADMIN_AGENT_ACTIONS).map((action) => action.kind.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  for (const candidate of CASES) {
    const { kind, call } = candidate;

    it(`${kind}: queues one action with its card and reads nothing through the binding`, async () => {
      const { log, admin, queue } = await queued(candidate);

      const description: ActionDescription = {
        title: candidate.title,
        description: candidate.description,
        fields: candidate.fields,
        descriptionIsComplete: true,
        implementsRevert: false,
        autoApprovable: ADMIN_AGENT_ACTIONS[kind].autoApprovable,
        actionKind: { ...ADMIN_AGENT_ACTIONS[kind].kind },
        awaitDecision: true,
      };
      expect(queue.submitted).toEqual([{ action: expect.any(Number), description }]);
      expect(log).toEqual(candidate.queuedLog);
      expect(queue.observations).toEqual([]);
      // Nothing was posted, set or filed, and the root's kinds made no call at all.
      expect(admin.calls.filter((made) => made.name !== "getIssueReport")).toEqual([]);
    });

    it(`${kind}: applies as exactly the stored call, once, on the Admin API lent for it`, async () => {
      const { admin, gatekeeper, id } = await queued(candidate);
      const before = admin.calls.length;
      const api = lent();

      await gatekeeper.applyAdminAction(id, api as never);
      expect(api.calls).toEqual([call]);

      // An applied action is not run again.
      await gatekeeper.applyAdminAction(id, api as never);
      expect(api.calls).toEqual([call]);
      expect(admin.calls).toHaveLength(before);
    });
  }
});

describe("the card of a change of status", () => {
  // Each status as the card names it, and what its reporter reads where that is another status.
  const NAMED: [IssueReportStatus, string, string?][] = [
    ["new", "New"],
    ["investigating", "Investigating"],
    ["answered", "Answered"],
    ["waitingOnReporter", "Waiting on the reporter"],
    ["withAdmin", "With an admin"],
    ["fixSuggested", "Fix suggested", "With the admins"],
    ["fixInProgress", "Fix in progress", "With the admins"],
    ["fixProposed", "Fix proposed"],
    ["closed", "Closed"],
  ];

  it("has a case here for every status", () => {
    expect(NAMED.map(([status]) => status)).toEqual([...ISSUE_REPORT_STATUSES]);
  });

  it.each(NAMED)("names %s as %s, and what its reporter reads where that differs",
      async (status, name, reporterReads) => {
    const { queue } = workshop(lends);
    const { session } = await openBinding(queue);
    using _session = session;
    await session.setIssueReportStatus!(REPORT_ID, status);

    expect(queue.submitted[0]!.description).toMatchObject({
      title: `Set issue report ${REPORT_ID} to ${name}`,
      fields: [
        { label: "Report", kind: "inline", value: REPORT_ID },
        { label: "Status", kind: "inline", value: name },
        ...(reporterReads === undefined
            ? [] : [{ label: "Reporter reads", kind: "inline", value: reporterReads }]),
      ],
    });
  });
});

describe("the card of an assignment", () => {
  it("names the report a release leaves with nobody, and whose release it is", async () => {
    const { log, admin, queue } = workshop(lends);
    const { gatekeeper, session } = await openBinding(queue);
    await session.releaseIssueReport!(REPORT_ID);
    session[Symbol.dispose]();

    const { issueReportAssignment } = ADMIN_AGENT_ACTIONS;
    const description: ActionDescription = {
      title: `Release issue report ${REPORT_ID} from this workspace's owner`,
      description: "Leaves the report with no assignee, if this workspace's owner, the admin " +
        "this connection acts as, holds it. Nothing changes if nobody holds it, and it is " +
        "refused if another admin does.",
      fields: [
        { label: "Report", kind: "inline", value: REPORT_ID },
        { label: "Released by", kind: "inline", value: "This workspace's owner" },
      ],
      descriptionIsComplete: true,
      implementsRevert: false,
      autoApprovable: issueReportAssignment.autoApprovable,
      actionKind: { ...issueReportAssignment.kind },
      awaitDecision: true,
    };
    expect(queue.submitted).toEqual([{ action: expect.any(Number), description }]);
    // Queuing read nothing, so it names the owner in words and marks nothing.
    expect(log).toEqual(["submit issue-report-assignment"]);
    expect(queue.observations).toEqual([]);
    expect(admin.calls).toEqual([]);

    const api = lent();
    await gatekeeper.applyAdminAction(queue.submitted[0]!.action, api as never);
    expect(api.calls).toEqual([{ name: "releaseIssueReport", args: [REPORT_ID] }]);
  });

  it("is one kind for a claim and a release, told apart by the call alone", async () => {
    const { queue } = workshop(lends);
    const { session } = await openBinding(queue);
    using _session = session;
    await session.claimIssueReport!(REPORT_ID);
    await session.claimIssueReport!(REPORT_ID, {});
    await session.claimIssueReport!(REPORT_ID, { takeOverFrom: undefined });
    await session.releaseIssueReport!(REPORT_ID);

    const cards = queue.submitted.map((entry) => entry.description);
    expect(cards.map((card) => card.actionKind?.tag)).toEqual(Array(4).fill("issue-report-assignment"));
    expect(cards.map((card) => card.autoApprovable)).toEqual(Array(4).fill(true));
    expect(cards.map((card) => card.title.split(" ")[0])).toEqual(["Assign", "Assign", "Assign", "Release"]);
  });

  it.each([
    ["assigned", "Another admin holds this issue report."],
    ["threadFull", undefined],
  ] as const)("fails for good on a refusal coded %s, with the store's message", async (name, message) => {
    const error = refusal(ISSUE_REPORT_ERROR_CODES[name]);
    if (message !== undefined) expect(error.message).toBe(message);
    for (const release of [false, true]) {
      const { queue } = workshop(lends);
      const { gatekeeper, session } = await openBinding(queue);
      await (release ? session.releaseIssueReport!(REPORT_ID) : session.claimIssueReport!(REPORT_ID));
      session[Symbol.dispose]();
      const id = queue.submitted[0]!.action;
      const working = lent();

      expect((await rejection(gatekeeper.applyAdminAction(id, failing(error) as never))).message)
          .toBe(error.message);
      expect((await rejection(gatekeeper.applyAdminAction(id, working as never))).message)
          .toBe(error.message);
      expect(working.calls).toEqual([]);
    }
  });
});

describe("the verdicts", () => {
  it("let a rule approve four kinds, and never a reply through the binding, a write or a content request", async () => {
    const offered = (await facet().getAutoApprovableActions()).map((kind) => kind.tag);

    expect(offered.toSorted()).toEqual([
      "issue-report-assignment", "issue-report-note", "issue-report-scoped-reply",
      "issue-report-status",
    ]);
    expect(ADMIN_AGENT_ACTIONS.issueReportReply.autoApprovable).toBe(false);
    expect(ADMIN_AGENT_ACTIONS.workspaceWriteRequest.autoApprovable).toBe(false);
    expect(ADMIN_AGENT_ACTIONS.contentAccessRequest.autoApprovable).toBe(false);
    for (const [name, action] of Object.entries(ADMIN_AGENT_ACTIONS)) {
      expect(offered.includes(action.kind.tag), name).toBe(action.autoApprovable);
    }
  });

  it("queue a write and a content request as kinds of their own, each waiting for a person", async () => {
    const { queue } = workshop();
    const { session } = await openBinding(queue);
    using _session = session;

    await session.requestContentAccess!(WORKSPACE, "the same reason");
    await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, "the same reason");
    await session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 7 }, "x");

    const [content, restart, stop] = queue.submitted.map((entry) => entry.description);
    expect([content!.actionKind?.tag, restart!.actionKind?.tag, stop!.actionKind?.tag]).toEqual(
        ["content-access-request", "workspace-write-request", "workspace-write-request"]);
    expect([content!.autoApprovable, restart!.autoApprovable, stop!.autoApprovable])
        .toEqual([false, false, false]);
    // A write's card shows the workspace, the action, its arguments and the whole reason; a
    // content request's the workspace and the reason.
    expect(restart!.fields).toEqual(writeFields("restartWorkspace", {}, "the same reason"));
    expect(content!.fields).toEqual(contentFields("the same reason"));
    // Only the content request's card says who may not approve the request it files.
    expect(content!.description).toContain("can approve that request");
    expect(restart!.description).not.toContain("can approve that request");
  });

  it("split a public reply by the capability it came through, whatever the call says", async () => {
    const { queue } = workshop(lends);
    const { session } = await openBinding(queue);
    using _session = session;
    using report = await session.openIssueReport!(REPORT_ID) as Session;
    const text = "The same words.";

    await session.addIssueReportEntry!(REPORT_ID, text, "public");
    await report.reply!(text);
    // No argument turns one into the other: each of these is refused by the argument check.
    for (const call of [
      () => session.addIssueReportEntry!(REPORT_ID, text, "scoped"),
      () => session.addIssueReportEntry!(REPORT_ID, text, "public", "issue-report-scoped-reply"),
      () => session.addIssueReportEntry!(REPORT_ID, text, "public", { scoped: true }),
      () => report.reply!({ text, visibility: "admins" }),
    ]) {
      expect((await rejection(call())).message).not.toBe("did not reject");
    }
    // An argument reply() does not take is not read: the reply is queued as this session's kind.
    await report.reply!(text, "issue-report-reply");

    expect(queue.submitted.map((entry) => entry.description.actionKind?.tag)).toEqual(
        ["issue-report-reply", "issue-report-scoped-reply", "issue-report-scoped-reply"]);
    expect(queue.submitted.map((entry) => entry.description.autoApprovable))
        .toEqual([false, true, true]);
  });
});

describe("what is refused before anything is queued", () => {
  it("blank and over-long text, through the binding and through a report session", async () => {
    const { log, queue } = workshop(lends);
    const { session } = await openBinding(queue);
    using _session = session;
    using report = await session.openIssueReport!(REPORT_ID) as Session;
    const long = "x".repeat(MAX_ISSUE_REPORT_TEXT_LENGTH + 1);
    const refused = `The text must be non-blank and at most ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters.`;

    for (const text of ["", " \n\t ", long]) {
      expect((await rejection(session.addIssueReportEntry!(REPORT_ID, text, "public"))).message).toBe(refused);
      expect((await rejection(session.addIssueReportEntry!(REPORT_ID, text, "admins"))).message).toBe(refused);
      expect((await rejection(report.reply!(text))).message).toBe(refused);
    }
    expect(log).toEqual([]);

    // The longest text there is, once trimmed, is queued.
    await session.addIssueReportEntry!(REPORT_ID, ` ${long.slice(1)} `, "admins");
    expect(queue.submitted).toHaveLength(1);
  });

  it("a blank and an over-long reason, for a write and for a content request", async () => {
    const { log, queue } = workshop();
    const { session } = await openBinding(queue);
    using _session = session;
    const long = "x".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1);
    const refused = `A reason is required, and must be at most ${MAX_ADMIN_ACCESS_REASON_LENGTH} characters.`;

    for (const reason of ["", " \n\t ", long]) {
      expect((await rejection(session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, reason)))
          .message).toBe(refused);
      expect((await rejection(session.requestContentAccess!(WORKSPACE, reason))).message)
          .toBe(refused);
    }
    expect(log).toEqual([]);

    // The longest reason there is, once trimmed, is queued, and trimmed is how it is stored.
    await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, ` ${long.slice(1)}\n`);
    await session.requestContentAccess!(WORKSPACE, `${long.slice(1)} `);
    expect(queue.submitted.map((entry) => entry.description.fields)).toEqual(
        [writeFields("restartWorkspace", {}, long.slice(1)), contentFields(long.slice(1))]);
  });

  it("arguments a write's action does not take, lacks or cannot hold", async () => {
    const { log, queue } = workshop();
    const { session } = await openBinding(queue);
    using _session = session;
    const request = (action: string, args: object) =>
      rejection(session.writeWorkspace!(WORKSPACE, action, args, "reason"));

    // Each fits the schema, which knows the arguments only as an optional number.
    expect((await request("stopAgent", {})).message).toBe('"stopAgent" needs `chatId`.');
    expect((await request("restartWorkspace", { chatId: 7 })).message)
        .toBe('"restartWorkspace" takes no `chatId`.');
    for (const chatId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await request("stopAgent", { chatId })).message)
          .toBe("`chatId` must be a non-negative whole number.");
    }
    expect(log).toEqual([]);
    expect(queue.submitted).toEqual([]);

    // What the action takes is queued, an id of zero included.
    await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, "reason");
    await session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 0 }, "reason");
    expect(queue.submitted.map((entry) => entry.description.fields)).toEqual([
      writeFields("restartWorkspace", {}, "reason"),
      writeFields("stopAgent", { chatId: 0 }, "reason"),
    ]);
  });

  it("an unknown status, an unknown action and arguments that are not a write's or a request's", async () => {
    const { log, queue } = workshop();
    const { session } = await openBinding(queue);
    using _session = session;

    for (const call of [
      () => session.setIssueReportStatus!(REPORT_ID, "done"),
      () => session.setIssueReportStatus!(REPORT_ID),
      () => session.writeWorkspace!(WORKSPACE, "deleteWorkspace", {}, "reason"),
      () => session.writeWorkspace!(WORKSPACE, "grantContentAccess", {}, "reason"),
      () => session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: "three" }, "reason"),
      () => session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 3 }),
      () => session.requestContentAccess!(WORKSPACE),
      () => session.requestContentAccess!(WORKSPACE, "reason", {}),
    ]) {
      expect((await rejection(call())).message).toMatch(/^Invalid arguments for AdminApi\./);
    }

    expect(log).toEqual([]);
    expect(queue.submitted).toEqual([]);
  });
});

describe("an action that fails to apply", () => {
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    for (const code of TERMINAL_REFUSALS) {
      it(`${kind}: a refusal coded ${code} is final, and is not tried again`, async () => {
        const { gatekeeper, id } = await queued(candidate);
        const refusing = failing(refusal(code));
        const working = lent();

        expect((await rejection(gatekeeper.applyAdminAction(id, refusing as never))).message)
            .toBe(refusal(code).message);
        expect(refusing.calls).toEqual([call]);
        // The kit answers a failed action with its failure, and runs nothing.
        expect((await rejection(gatekeeper.applyAdminAction(id, working as never))).message)
            .toBe(refusal(code).message);
        expect(working.calls).toEqual([]);
      });
    }

    for (const [what, code] of [
      ["an owner who is no longer an admin", ADMIN_ACCESS_ERROR_CODES.notAdmin],
      ["the gatekeeper turned off after the lend", ADMIN_ACCESS_ERROR_CODES.gatekeeperOff],
    ] as const) {
      it(`${kind}: ${what} leaves it pending`, async () => {
        const { gatekeeper, id } = await queued(candidate);
        const refused = createAdminAccessError(code);
        const refusing = failing(refused);
        const working = lent();

        expect((await rejection(gatekeeper.applyAdminAction(id, refusing as never))).message)
            .toBe(refused.message);
        await gatekeeper.applyAdminAction(id, working as never);
        expect(working.calls).toEqual([call]);
      });
    }
  }

  const UNKNOWN: [string, unknown][] = [
    ["an error with no code", new Error("Network connection lost.")],
    ["a code this gatekeeper does not know", Object.assign(new Error("Refused."), { code: "SOMETHING_NEW" })],
    ["a refusal of another call", createAdminGrantError(ADMIN_GRANT_ERROR_CODES.requestNotPending)],
    ["a rejection that is no error", "the stub broke"],
  ];

  // Every kind, a status included: set again after someone changed the report's status, it
  // would undo their change.
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    for (const [what, error] of UNKNOWN) {
      it(`${kind}: ${what} after the call leaves the outcome unknown, and it never runs again`, async () => {
        const { gatekeeper, id } = await queued(candidate);
        const broken = failing(error);
        const working = lent();

        expect((await rejection(gatekeeper.applyAdminAction(id, broken as never))).message)
            .toBe(OUTCOME_UNKNOWN);
        expect(broken.calls).toEqual([call]);
        expect((await rejection(gatekeeper.applyAdminAction(id, working as never))).message)
            .toBe(OUTCOME_UNKNOWN);
        expect(working.calls).toEqual([]);

        // A person rejects it, having looked: then it is gone.
        await gatekeeper.rejectAction(id);
        expect((await rejection(gatekeeper.applyAdminAction(id, working as never))).message)
            .toBe(`Unknown pending action: ${id}`);
        expect(working.calls).toEqual([]);
      });
    }
  }
});

/** Durable Object KV, in memory: cloned values and scans in key order. */
function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void values.set(key, structuredClone(value)),
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix, startAfter, end, limit }:
        { prefix: string; startAfter?: string; end?: string; limit?: number }) =>
      [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) &&
              (startAfter === undefined || key > startAfter) && (end === undefined || key < end))
          .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
  };
}

/**
 * `candidate`'s action, queued on an action set bound here: to a journal the test can read, and
 * to a host that holds no Admin API until the test puts one in `held`.
 */
async function bound(candidate: Case) {
  const held = new Map<number, Recording>();
  const journal = new ActionJournal<TaggedAction<AdminActions>>(memoryKv(), { namespace: "test" });
  const actions = ADMIN_ACTIONS.bind(journal, { lentFor: (action) => held.get(action) as never });
  const id = await actions.submit(
      { submitAction: async () => {} } as never, candidate.kind, candidate.payload as never);
  return { held, journal, actions, id };
}

describe("an action that is lent nothing", () => {
  // The facet applies only with an Admin API in hand, so the action set is bound here.
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    it(`${kind}: makes no call, stays pending, and applies once it is lent an Admin API`, async () => {
      const { held, actions, id } = await bound(candidate);

      expect((await rejection(actions.apply(id))).message)
          .toBe("This action was given no Admin API to apply with.");

      const api = lent();
      held.set(id, api);
      await actions.apply(id);
      expect(api.calls).toEqual([call]);
    });
  }
});

describe("an action whose call is under way", () => {
  // What a facet that dies here leaves behind: a claimed action is never run again, so nothing
  // is posted, set or filed twice.
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    it(`${kind}: is claimed in the journal until the Admin API answers`, async () => {
      const { held, journal, actions, id } = await bound(candidate);
      expect(journal.get(id)?.state).toBe("pending");
      const called = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      const api = lent(() => {
        called.resolve();
        return answer.promise;
      });
      held.set(id, api);

      const applying = actions.apply(id);
      await called.promise;
      expect(api.calls).toEqual([call]);
      expect(journal.get(id)?.state).toBe("claimed");

      answer.resolve();
      await applying;
      expect(journal.get(id)).toBeUndefined();
    });
  }
});

describe("the facet's other entry points", () => {
  it("reject a pending action, which then cannot be applied", async () => {
    const { gatekeeper, id } = await queued(caseOf("issueReportNote"));
    const api = lent();

    await gatekeeper.rejectAction(id);

    expect((await rejection(gatekeeper.applyAdminAction(id, api as never))).message)
        .toBe(`Unknown pending action: ${id}`);
    expect(api.calls).toEqual([]);
  });

  it("refuse to apply without a lent Admin API, and to revert", async () => {
    const { gatekeeper, id } = await queued(caseOf("issueReportNote"));

    expect((await rejection(gatekeeper.applyAction(id, lent() as never))).message)
        .toBe("The admin gatekeeper applies an action only with the Admin API lent for it.");
    expect((await rejection(gatekeeper.revertAction(id))).message)
        .toBe("The admin gatekeeper's actions cannot be reverted.");

    // Neither touched the action: it still applies.
    const api = lent();
    await gatekeeper.applyAdminAction(id, api as never);
    expect(api.calls).toEqual([caseOf("issueReportNote").call]);
  });
});
