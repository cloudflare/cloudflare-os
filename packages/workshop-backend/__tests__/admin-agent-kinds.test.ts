import { describe, expect, it } from "vitest";
import { ADMIN_AGENT_KINDS, ADMIN_AGENT_LEND_SECONDS, ADMIN_BINDING_SUBRESOURCE, ADMIN_GATEKEEPER_VENDOR_ID, type AdminAgentKind } from "@gadgets/workshop-shared/admin-agent";

// That the table names every AdminApi method, and no other, is a compile-time check
// (admin-gatekeeper.ts in workshop-shared). These tests hold what the types cannot: which kind a
// method of a given name may have, and the values stored records and rules depend on.

const kinds = Object.entries(ADMIN_AGENT_KINDS) as [string, AdminAgentKind][];

function methodsOfKind(kind: AdminAgentKind): string[] {
  return kinds.filter(([, k]) => k === kind).map(([method]) => method).toSorted();
}

describe("ADMIN_AGENT_KINDS", () => {
  it("gives every method one of the two kinds", () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (let [method, kind] of kinds) {
      expect(["read", "omitted"], method).toContain(kind);
    }
  });

  it("reads exactly the listings, the getters that hold no secret, and views", () => {
    expect(methodsOfKind("read")).toEqual([
      "getAdminAuditStats", "getIssueReport", "getSettings", "inspectUser", "inspectWorkspace",
      "listAdminAudit", "listIssueReports", "listUsers", "listWorkspaces", "readIssueReportImage",
      "whoami",
    ]);
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

  it("omits the update status, whose answer holds the link that opens the deploy flow", () => {
    expect(ADMIN_AGENT_KINDS.getUpdateStatus).toBe("omitted");
    expect(ADMIN_AGENT_KINDS.checkForUpdates).toBe("omitted");
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
