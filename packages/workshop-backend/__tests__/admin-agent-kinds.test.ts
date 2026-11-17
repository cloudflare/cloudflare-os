import { describe, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS, ADMIN_AGENT_KINDS, ADMIN_AGENT_LEND_SECONDS, ADMIN_BINDING_SUBRESOURCE, ADMIN_GATEKEEPER_VENDOR_ID, adminAgentAction, adminAgentActionMethods, type AdminAgentAction, type AdminAgentKind } from "@gadgets/workshop-shared/admin-agent";

// That the table names every AdminApi method, and no other, is a compile-time check
// (admin-gatekeeper.ts in workshop-shared). These tests hold what the types cannot: which kind a
// method of a given name may have, and the values stored records and rules depend on.

const kinds = Object.entries(ADMIN_AGENT_KINDS) as [string, AdminAgentKind][];
const actions = Object.entries(ADMIN_AGENT_ACTIONS) as
    [AdminAgentAction, (typeof ADMIN_AGENT_ACTIONS)[AdminAgentAction]][];

function methodsOfKind(kind: AdminAgentKind): string[] {
  return kinds.filter(([, k]) => k === kind).map(([method]) => method).toSorted();
}

describe("ADMIN_AGENT_KINDS", () => {
  it("gives every method one of the three kinds", () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (let [method, kind] of kinds) {
      expect(["read", "act", "omitted"], method).toContain(kind);
    }
  });

  it("reads exactly the listings, the getters that hold no secret, reports, views and who the admin is", () => {
    expect(methodsOfKind("read")).toEqual([
      "getAdminAuditStats", "getIssueReport", "getSettings", "getWorkspaceWrite",
      "inspectUser", "inspectWorkspace", "isBlueprintFeatured", "listAdminAudit",
      "listIssueReports", "listUsers", "listWorkspaces", "readIssueReportImage", "whoami",
    ]);
  });

  it("queues exactly the methods the action kinds name", () => {
    let queued = [...new Set(actions.flatMap(([name]) => adminAgentActionMethods(name)))].toSorted();
    expect(methodsOfKind("act")).toEqual(queued);
    expect(queued).toEqual([
      "addIssueReportEntry", "claimIssueReport", "releaseIssueReport", "requestWorkspaceWrite",
      "setIssueReportStatus",
    ]);
    expect(actions).toHaveLength(7);
  });

  it("omits every setter, passkey, approval, denial, test and grant ending, but a report's status", () => {
    let matched = 0;
    for (let [method, kind] of kinds) {
      if (!method.startsWith("set") && !/Passkey|approve|deny|test|end/i.test(method)) continue;
      matched++;
      expect(kind, method).toBe(method === "setIssueReportStatus" ? "act" : "omitted");
    }
    expect(matched).toBeGreaterThan(0);
  });

  it("never reads through a method that files a request", () => {
    let requests = kinds.filter(([method]) => method.startsWith("request"));
    expect(requests.map(([method]) => method)).toContain("requestWorkspaceWrite");
    for (let [method, kind] of requests) {
      expect(kind, method).not.toBe("read");
    }
  });

  it("omits the update status, whose answer holds the link that opens the deploy flow", () => {
    expect(ADMIN_AGENT_KINDS.getUpdateStatus).toBe("omitted");
    expect(ADMIN_AGENT_KINDS.checkForUpdates).toBe("omitted");
  });
});

describe("ADMIN_AGENT_ACTIONS", () => {
  it("gives each kind a tag of its own", () => {
    let tags = actions.map(([, action]) => action.kind.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("issue-report-assignment");
    for (let [name, action] of actions) {
      expect(action.kind.label, name).not.toBe("");
    }
  });

  it("makes exactly the admin binding's public reply and a content access request wait for a person", () => {
    let waiting = actions.filter(([, action]) => !action.autoApprovable).map(([name]) => name);
    expect(waiting.toSorted()).toEqual(["contentAccessRequest", "issueReportReply"]);
  });

  it("tells the two public replies apart by tag and by verdict alone", () => {
    let replies = actions.filter(([, action]) => action.visibility === "public");
    expect(replies.map(([name]) => name).toSorted()).toEqual(["issueReportReply", "issueReportScopedReply"]);
    let { issueReportReply, issueReportScopedReply } = ADMIN_AGENT_ACTIONS;
    expect(issueReportReply.kind.tag).not.toBe(issueReportScopedReply.kind.tag);
    expect(issueReportReply.method).toBe("addIssueReportEntry");
    expect(issueReportScopedReply.method).toBe("addIssueReportEntry");
    expect(issueReportReply.autoApprovable).toBe(false);
    expect(issueReportScopedReply.autoApprovable).toBe(true);
  });

  it("posts an admins-only note and sets a status under kinds a rule may approve", () => {
    let { issueReportNote, issueReportStatus } = ADMIN_AGENT_ACTIONS;
    expect(issueReportNote).toMatchObject(
        { method: "addIssueReportEntry", visibility: "admins", autoApprovable: true });
    expect(issueReportStatus).toMatchObject(
        { method: "setIssueReportStatus", visibility: undefined, autoApprovable: true });
  });

  it("lets a rule apply under the mark exactly an admins-only note, a status and an assignment", () => {
    let exempt = actions.filter(([, action]) => action.autoApprovableWhileRestricted)
        .map(([name]) => name);
    expect(exempt.toSorted())
        .toEqual(["issueReportAssignment", "issueReportNote", "issueReportStatus"]);
  });

  it("never marks so a kind that always waits for a person", () => {
    for (let [name, action] of actions) {
      expect(action.autoApprovableWhileRestricted && !action.autoApprovable, name).toBe(false);
    }
  });

  it("names one method for every kind but an assignment, which names its two", () => {
    for (let [name, action] of actions) {
      if (name === "issueReportAssignment") continue;
      expect(adminAgentActionMethods(name), name).toEqual([action.method]);
    }
    let { issueReportAssignment } = ADMIN_AGENT_ACTIONS;
    expect(adminAgentActionMethods("issueReportAssignment"))
        .toEqual(["claimIssueReport", "releaseIssueReport"]);
    expect(issueReportAssignment).toMatchObject(
        { visibility: undefined, grantsContent: undefined, autoApprovable: true });
    // No other kind may make either call.
    for (let [name] of actions) {
      if (name === "issueReportAssignment") continue;
      expect(adminAgentActionMethods(name), name).not.toContain("claimIssueReport");
      expect(adminAgentActionMethods(name), name).not.toContain("releaseIssueReport");
    }
  });

  it("splits filing a write request in two, by whether it asks for content access", () => {
    let granting = actions.filter(([, action]) => action.grantsContent === true);
    let other = actions.filter(([, action]) => action.grantsContent === false);
    expect(granting.map(([name]) => name)).toEqual(["contentAccessRequest"]);
    expect(other.map(([name]) => name)).toEqual(["workspaceWriteRequest"]);
    let { contentAccessRequest, workspaceWriteRequest } = ADMIN_AGENT_ACTIONS;
    expect(contentAccessRequest.method).toBe("requestWorkspaceWrite");
    expect(workspaceWriteRequest.method).toBe("requestWorkspaceWrite");
    expect(contentAccessRequest.kind.tag).not.toBe(workspaceWriteRequest.kind.tag);
    expect(contentAccessRequest.autoApprovable).toBe(false);
    expect(workspaceWriteRequest.autoApprovable).toBe(true);
    // Every kind of another method leaves the field unset: it is a write request's alone.
    for (let [name, action] of actions) {
      if (action.method !== "requestWorkspaceWrite") {
        expect(action.grantsContent, name).toBeUndefined();
      }
    }
  });
});

describe("adminAgentAction", () => {
  // The tags are written out: auto-approval rules are stored under them, so renaming one would
  // silently drop the rules users enabled for it.
  it("maps each tag to its kind", () => {
    expect(adminAgentAction("issue-report-reply")).toBe("issueReportReply");
    expect(adminAgentAction("issue-report-scoped-reply")).toBe("issueReportScopedReply");
    expect(adminAgentAction("issue-report-note")).toBe("issueReportNote");
    expect(adminAgentAction("issue-report-status")).toBe("issueReportStatus");
    expect(adminAgentAction("issue-report-assignment")).toBe("issueReportAssignment");
    expect(adminAgentAction("workspace-write-request")).toBe("workspaceWriteRequest");
    expect(adminAgentAction("content-access-request")).toBe("contentAccessRequest");
    for (let [name, action] of actions) {
      expect(adminAgentAction(action.kind.tag)).toBe(name);
    }
  });

  it("maps anything else to undefined", () => {
    expect(adminAgentAction(undefined)).toBeUndefined();
    expect(adminAgentAction("")).toBeUndefined();
    expect(adminAgentAction("issueReportReply")).toBeUndefined();
    expect(adminAgentAction("issue-report-reply ")).toBeUndefined();
    expect(adminAgentAction("ISSUE-REPORT-REPLY")).toBeUndefined();
    expect(adminAgentAction("toString")).toBeUndefined();
    expect(adminAgentAction("gmail.send")).toBeUndefined();
  });
});

describe("the admin gatekeeper's constants", () => {
  it("lends for 15 minutes", () => {
    expect(ADMIN_AGENT_LEND_SECONDS).toBe(900);
  });

  // Observations already recorded carry the subresource id, and the Gatekeeper binding is named
  // after the vendor id, so neither is ever renamed.
  it("pins the ids stored records carry", () => {
    expect(ADMIN_BINDING_SUBRESOURCE).toBe("instanceadmin:deployment");
    expect(ADMIN_GATEKEEPER_VENDOR_ID).toBe("instanceadmin");
  });
});
