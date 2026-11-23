import { describe, expect, it } from "vitest";
import type { GraphColumn } from "../src/graph-parse";
import {
  ListQueryError, compileQuery, findColumn, readFieldValue, requireRequired, toColumnInfo, validateFieldValues, visibleColumns,
} from "../src/sharepoint-lists";

function column(name: string, type: GraphColumn["type"], fields: Partial<GraphColumn> = {}): GraphColumn {
  return { name, displayName: name, type, required: false, readOnly: false, hidden: false, indexed: false, ...fields };
}

const COLUMNS = visibleColumns([
  column("Title", "text", { required: true, indexed: true, hidden: true }),
  column("Status", "choice", { choices: ["Open", "Closed"], indexed: true }),
  column("Tags", "multiChoice", { choices: ["ui", "api"] }),
  column("Notes", "note"),
  column("Estimate", "number"),
  column("Done", "boolean"),
  column("Due", "dateTime"),
  column("AssignedTo", "person"),
  column("Parent", "lookup", { readOnly: true }),
  column("Link", "hyperlink"),
  column("Score", "calculated", { readOnly: true }),
  column("Priority_x0020_Level", "choice", { displayName: "Priority Level", choices: ["High", "Low"] }),
]);

describe("visibleColumns", () => {
  it("keeps the list's own columns and Title, adds the system ones, and drops SharePoint's bookkeeping", () => {
    const names = visibleColumns([
      column("Title", "text", { hidden: true }),
      column("Status", "choice"),
      column("Secret", "text", { hidden: true }),
      column("_ModerationStatus", "other"),
      column("ContentType", "other"),
      column("Attachments", "boolean"),
      column("LinkTitle", "text"),
      column("Author", "person"),
    ]).map(entry => entry.name);
    expect(names).toEqual(["Title", "Status", "ID", "Created", "Modified"]);
  });

  it("keeps a column whose name only begins like one of SharePoint's", () => {
    const names = visibleColumns([
      column("OrderNumber", "number"), column("Editorial", "text"), column("AuthorNotes", "note"), column("GUIDance", "text"),
      column("Restricted_x0020_Area", "boolean"), column("BaseNameAlias", "text"),
    ]).map(entry => entry.name);
    expect(names).toEqual(["OrderNumber", "Editorial", "AuthorNotes", "GUIDance", "Restricted_x0020_Area", "BaseNameAlias", "ID", "Created", "Modified"]);
  });

  it("doesn't duplicate a system column the list already reports", () => {
    const names = visibleColumns([column("Modified", "dateTime", { readOnly: true })]).map(entry => entry.name);
    expect(names).toEqual(["Modified", "ID", "Created"]);
  });

  it("describes a column without its internal flags", () => {
    expect(toColumnInfo(COLUMNS.find(entry => entry.name === "Status")!)).toEqual({
      name: "Status", displayName: "Status", type: "choice", required: false, readOnly: false, indexed: true, choices: ["Open", "Closed"],
    });
  });
});

describe("findColumn", () => {
  it("matches the internal name, then an unambiguous display name in any case", () => {
    expect(findColumn(COLUMNS, "Priority_x0020_Level").name).toBe("Priority_x0020_Level");
    expect(findColumn(COLUMNS, "priority level").name).toBe("Priority_x0020_Level");
  });

  it("refuses an ambiguous display name, naming the real columns", () => {
    const columns = [column("A1", "text", { displayName: "Owner" }), column("A2", "text", { displayName: "owner" })];
    expect(() => findColumn(columns, "Owner")).toThrow(/no column "Owner"\. Its columns are: A1, A2\./);
  });

  it("refuses an empty name", () => {
    expect(() => findColumn(COLUMNS, "")).toThrow(ListQueryError);
  });
});

describe("compileQuery", () => {
  it("expands fields and filters nothing by default", () => {
    expect(compileQuery(COLUMNS)).toEqual({ query: { $expand: "fields" }, unindexed: [] });
  });

  it("filters through fields/, quoting text so it can't change the query's shape", () => {
    const { query } = compileQuery(COLUMNS, {
      where: [
        { field: "Title", op: "eq", value: "O'Brien' or 1 eq 1" },
        { field: "Status", op: "ne", value: "Closed" },
      ],
    });
    expect(query.$filter).toBe("fields/Title eq 'O''Brien'' or 1 eq 1' and fields/Status ne 'Closed'");
  });

  it("compares the ID as a quoted whole number, as Graph insists", () => {
    expect(compileQuery(COLUMNS, { where: [{ field: "ID", op: "gt", value: 7 }] }).query.$filter).toBe("fields/ID gt '7'");
    expect(() => compileQuery(COLUMNS, { where: [{ field: "ID", op: "eq", value: "7" }] })).toThrow(/whole numbers/);
    expect(() => compileQuery(COLUMNS, { where: [{ field: "ID", op: "eq", value: 1.5 }] })).toThrow(/whole numbers/);
  });

  it("filters yes/no columns as 1 and 0, numbers bare, and dates as quoted ISO strings", () => {
    const { query, unindexed } = compileQuery(COLUMNS, {
      where: [
        { field: "Done", op: "eq", value: true },
        { field: "Estimate", op: "le", value: 2.5 },
        { field: "Due", op: "lt", value: "2026-10-17T09:00:00Z" },
      ],
    });
    expect(query.$filter).toBe("fields/Done eq 1 and fields/Estimate le 2.5 and fields/Due lt '2026-10-17T09:00:00Z'");
    expect(unindexed).toEqual(["Done", "Estimate", "Due"]);
  });

  it("compiles startsWith and null comparisons", () => {
    const { query } = compileQuery(COLUMNS, {
      where: [{ field: "Title", op: "startsWith", value: "Bug" }, { field: "Estimate", op: "eq", value: null }],
    });
    expect(query.$filter).toBe("startswith(fields/Title,'Bug') and fields/Estimate eq null");
  });

  it.each([
    [{ field: "Estimate", op: "eq", value: "3" }, /holds numbers/],
    [{ field: "Estimate", op: "eq", value: Number.NaN }, /holds numbers/],
    [{ field: "Done", op: "eq", value: "yes" }, /true or false/],
    [{ field: "Due", op: "eq", value: "next Tuesday" }, /ISO 8601/],
    [{ field: "Due", op: "eq", value: "2026-13-45" }, /ISO 8601/],
    [{ field: "Title", op: "eq", value: 3 }, /holds text/],
    [{ field: "Title", op: "startsWith", value: 3 }, /compares with a string/],
    [{ field: "Title", op: "contains", value: "x" }, /Unknown comparison "contains"/],
    [{ field: "Title", op: "constructor", value: "x" }, /Unknown comparison/],
    [{ field: "Nope", op: "eq", value: "x" }, /no column "Nope"/],
  ] as const)("refuses %j", (condition, message) => {
    expect(() => compileQuery(COLUMNS, { where: [condition as never] })).toThrow(message);
  });

  it.each(["Notes", "Tags", "AssignedTo", "Parent", "Link"])("refuses to filter on %s, whose type Graph can't filter", field => {
    expect(() => compileQuery(COLUMNS, { where: [{ field, op: "eq", value: "x" }] })).toThrow(/can't be filtered on/);
  });

  it("refuses more than 20 conditions", () => {
    const where = Array.from({ length: 21 }, () => ({ field: "Title", op: "eq" as const, value: "x" }));
    expect(() => compileQuery(COLUMNS, { where })).toThrow(/at most 20/);
    expect(() => compileQuery(COLUMNS, { where: where.slice(1) })).not.toThrow();
  });

  it("sorts through fields/, reporting an unindexed sort column", () => {
    expect(compileQuery(COLUMNS, { orderBy: { field: "Modified", descending: true } }))
      .toEqual({ query: { $expand: "fields", $orderby: "fields/Modified desc" }, unindexed: [] });
    expect(compileQuery(COLUMNS, { orderBy: { field: "Due" } }))
      .toEqual({ query: { $expand: "fields", $orderby: "fields/Due" }, unindexed: ["Due"] });
  });

  it("selects named columns by internal name, leaving out the metadata every item carries", () => {
    expect(compileQuery(COLUMNS, { fields: ["Title", "priority level", "ID"] }).query.$expand)
      .toBe("fields($select=Title,Priority_x0020_Level,_UIVersionString,_ModerationStatus)");
    expect(compileQuery(COLUMNS, { fields: ["Created"] }).query.$expand).toBe("fields($select=Title,_UIVersionString,_ModerationStatus)");
    expect(() => compileQuery(COLUMNS, { fields: [] })).toThrow(/at least one column/);
  });
});

describe("validateFieldValues", () => {
  it("returns values keyed by internal name", () => {
    expect(validateFieldValues(COLUMNS, { Title: "Fix it", "Priority Level": "High", Tags: ["ui"], Done: false, Estimate: 3, Notes: null }))
      .toEqual({ Title: "Fix it", Priority_x0020_Level: "High", Tags: ["ui"], Done: false, Estimate: 3, Notes: null });
  });

  it.each([
    [{ Title: "x".repeat(256) }, /at most 255 characters/],
    [{ Title: "two\nlines" }, /single line/],
    [{ Notes: "x".repeat(64_000) }, /at most 63,999 characters/],
    [{ Title: null }, /required and can't be emptied/],
    [{ Status: "Pending" }, /"Pending" isn't a choice of column "Status"\. Choose one of: Open, Closed\./],
    [{ Status: ["Open"] }, /holds one of: Open, Closed/],
    [{ Tags: ["ui", "db"] }, /"db" isn't a choice/],
    [{ Tags: "ui" }, /list of choices/],
    [{ Estimate: "3" }, /holds a number/],
    [{ Done: 1 }, /true or false/],
    [{ Due: "tomorrow" }, /ISO 8601/],
    [{ AssignedTo: "Sarah" }, /\(person\) can't be written/],
    [{ Link: "https://example.com" }, /\(hyperlink\) can't be written/],
    [{ Parent: "1" }, /computed by SharePoint/],
    [{ Score: 1 }, /computed by SharePoint/],
    [{ ID: 4 }, /computed by SharePoint/],
    [{ Nope: "x" }, /no column "Nope"/],
    [{}, /at least one column/],
  ])("refuses %j", (fields, message) => {
    expect(() => validateFieldValues(COLUMNS, fields as never)).toThrow(message);
  });

  it("refuses something that isn't an object of values", () => {
    expect(() => validateFieldValues(COLUMNS, null as never)).toThrow(/object of column values/);
    expect(() => validateFieldValues(COLUMNS, ["Title"] as never)).toThrow(/object of column values/);
  });
});

describe("requireRequired", () => {
  it("names each required, writable column a new item leaves empty", () => {
    const columns = [...COLUMNS, column("Owner", "text", { required: true }), column("Computed", "calculated", { required: true, readOnly: true })];
    expect(() => requireRequired(columns, { Status: "Open", Owner: "" })).toThrow(/needs "Title", "Owner"\./);
    expect(() => requireRequired(columns, { Title: "x", Owner: "y" })).not.toThrow();
  });
});

describe("readFieldValue", () => {
  it("reads people, lookups, hyperlinks and multi-values as text", () => {
    expect(readFieldValue([{ LookupValue: "Sarah" }, { Email: "bob@contoso.com" }, "raw"])).toEqual(["Sarah", "bob@contoso.com", "raw"]);
    expect(readFieldValue({ Url: "https://contoso.com", Description: "Home" })).toBe("Home (https://contoso.com)");
    expect(readFieldValue({ Url: "https://contoso.com", Description: "https://contoso.com" })).toBe("https://contoso.com");
    expect(readFieldValue({ LookupValue: "Parent task" })).toBe("Parent task");
    expect(readFieldValue({ Label: "Finance", TermGuid: "x" })).toBe("Finance");
    expect(readFieldValue({ Latitude: 1 })).toBe("{\"Latitude\":1}");
    expect(readFieldValue(undefined)).toBeNull();
  });
});
