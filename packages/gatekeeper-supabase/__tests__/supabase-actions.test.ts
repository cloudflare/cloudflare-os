import { describe, expect, it } from "vitest";
import {
  ACTION_KIND_CATALOG, AUTO_APPROVABLE_KINDS, RUN_SQL_ACTION, executeActionDescription,
} from "../src/supabase-actions";

describe("executeActionDescription", () => {
  it.each([
    ["INSERT INTO notes (body) VALUES ($1)", ["hello"]],
    ["DROP TABLE notes", undefined],
  ])("never auto-approves %s, benign or destructive", (sql, params) => {
    const description = executeActionDescription("abcdefghijklmnop", sql, params);

    expect(description.actionKind).toEqual(RUN_SQL_ACTION);
    expect(description.autoApprovable).toBe(false);
  });

  it("tags statements under a stable kind", () => {
    expect(RUN_SQL_ACTION).toEqual({ tag: "supabase.runSql", label: "Run SQL" });
  });

  it("shows the statement and parameters verbatim", () => {
    const { fields, implementsRevert, awaitDecision } =
      executeActionDescription("abcdefghijklmnop", "DELETE FROM notes WHERE id = $1", [7]);

    expect(fields?.map(field => field.label)).toEqual(["SQL", "Parameters"]);
    expect(fields?.[0]).toMatchObject({ value: "DELETE FROM notes WHERE id = $1" });
    expect(implementsRevert).toBe(false);
    expect(awaitDecision).toBe(true);
  });
});

describe("AUTO_APPROVABLE_KINDS", () => {
  it("offers no kind, since SQL is never auto-approved", () => {
    expect(AUTO_APPROVABLE_KINDS).toEqual([]);
  });
});

describe("ACTION_KIND_CATALOG", () => {
  it("advertises SQL as the one kind, always waiting for a person", () => {
    expect(ACTION_KIND_CATALOG).toEqual([{ kind: RUN_SQL_ACTION, autoApprovable: false }]);
  });
});
