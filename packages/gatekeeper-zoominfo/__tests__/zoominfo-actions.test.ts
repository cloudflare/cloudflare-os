import { describe, expect, it } from "vitest";
import { AUTO_APPROVABLE_KINDS, ENRICH_ACTION, enrichmentActionDescription } from "../src/zoominfo-actions";

describe("enrichmentActionDescription", () => {
  it.each([1, 25])("never auto-approves an enrichment costing up to %i credits", credits => {
    const description = enrichmentActionDescription("Enrich companies", { matchCompanyInput: [] }, credits);

    expect(description.actionKind).toEqual(ENRICH_ACTION);
    expect(description.autoApprovable).toBe(false);
  });

  it("tags enrichments under a stable kind", () => {
    expect(ENRICH_ACTION).toEqual({ tag: "zoominfo.enrich", label: "Enrich records (spends credits)" });
  });

  it("discloses the worst-case cost and shows the request verbatim", () => {
    const { description, fields, implementsRevert, awaitDecision } =
      enrichmentActionDescription("Enrich contacts", { matchPersonInput: [{ emailAddress: "a@example.com" }] }, 2,
        { page: 1, pageSize: 25 });

    expect(description).toContain("up to **2** ZoomInfo bulk-data credits");
    expect(fields?.map(field => field.label)).toEqual(["Request", "Page"]);
    expect(implementsRevert).toBe(false);
    expect(awaitDecision).toBe(true);
  });
});

describe("AUTO_APPROVABLE_KINDS", () => {
  it("offers no kind, since enrichment spends credits", () => {
    expect(AUTO_APPROVABLE_KINDS).toEqual([]);
  });
});
