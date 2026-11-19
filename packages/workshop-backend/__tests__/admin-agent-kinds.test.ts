import { describe, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS, ADMIN_AGENT_KINDS, ADMIN_AGENT_LEND_SECONDS, ADMIN_BINDING_SUBRESOURCE, ADMIN_GATEKEEPER_VENDOR_ID, adminAgentAction, type AdminAgentAction, type AdminAgentKind } from "@gadgets/workshop-shared/admin-agent";

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

  it("reads exactly the listings, the getters that hold no secret, and views", () => {
    expect(methodsOfKind("read")).toEqual([
      "getAdminAuditStats", "getContentAccessRequest", "getIssueReport", "getSettings",
      "inspectUser", "inspectWorkspace", "listAdminAudit", "listContentAccessRequests",
      "listIssueReports", "listUsers", "listWorkspaces", "readIssueReportImage", "whoami",
    ]);
  });

  it("queues exactly the methods the action kinds name", () => {
    let queued = [...new Set(actions.map(([, action]) => action.method))].toSorted();
    expect(methodsOfKind("act")).toEqual(queued);
    expect(queued).toEqual(["requestContentAccess", "writeWorkspace"]);
    expect(actions).toHaveLength(2);
  });

  it("omits every setter, approval, denial, test and grant ending", () => {
    let matched = 0;
    for (let [method, kind] of kinds) {
      if (!method.startsWith("set") && !/approve|deny|test|end/i.test(method)) continue;
      matched++;
      expect(kind, method).toBe("omitted");
    }
    expect(matched).toBeGreaterThan(0);
  });

  it("never reads through a method that files a request", () => {
    let requests = kinds.filter(([method]) => method.startsWith("request"));
    expect(requests.map(([method]) => method)).toContain("requestContentAccess");
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
    for (let [name, action] of actions) {
      expect(action.kind.label, name).not.toBe("");
    }
  });

  it("makes every kind wait for a person", () => {
    for (let [name, action] of actions) {
      expect(action.autoApprovable, name).toBe(false);
    }
  });

  it("writes to a workspace and asks for content access under kinds of their own", () => {
    let { contentAccessRequest, workspaceWriteRequest } = ADMIN_AGENT_ACTIONS;
    expect(workspaceWriteRequest).toMatchObject(
        { method: "writeWorkspace", autoApprovable: false });
    expect(contentAccessRequest).toMatchObject(
        { method: "requestContentAccess", autoApprovable: false });
    expect(contentAccessRequest.kind.tag).not.toBe(workspaceWriteRequest.kind.tag);
  });
});

describe("adminAgentAction", () => {
  // The tags are written out: auto-approval rules are stored under them, so renaming one would
  // silently drop the rules users enabled for it.
  it("maps each tag to its kind", () => {
    expect(adminAgentAction("workspace-write-request")).toBe("workspaceWriteRequest");
    expect(adminAgentAction("content-access-request")).toBe("contentAccessRequest");
    for (let [name, action] of actions) {
      expect(adminAgentAction(action.kind.tag)).toBe(name);
    }
  });

  it("maps anything else to undefined", () => {
    expect(adminAgentAction(undefined)).toBeUndefined();
    expect(adminAgentAction("")).toBeUndefined();
    expect(adminAgentAction("workspaceWriteRequest")).toBeUndefined();
    expect(adminAgentAction("workspace-write-request ")).toBeUndefined();
    expect(adminAgentAction("WORKSPACE-WRITE-REQUEST")).toBeUndefined();
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
    expect(ADMIN_BINDING_SUBRESOURCE).toBe("admin:deployment");
    expect(ADMIN_GATEKEEPER_VENDOR_ID).toBe("admin");
  });
});
