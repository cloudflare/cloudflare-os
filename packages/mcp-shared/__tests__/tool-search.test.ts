import { describe, expect, it } from "vitest";

import { matchesToolQuery, toolQueryTerms } from "../src/tool-search.js";

const match = (
  tool: { name: string; title?: string; description?: string },
  query: string,
) => matchesToolQuery(tool, toolQueryTerms(query));

describe("tool query matching", () => {
  it("treats word separators alike on both sides of the comparison", () => {
    // The obvious query has to find the obvious tool. MCP tool names are snake_case and a portal
    // prefixes each with `{server_id}_`, so a matcher that took `_` literally would answer nothing
    // for every one of these spellings.
    const tool = { name: "github_list_issues" };
    expect(match(tool, "list issues")).toBe(true);
    expect(match(tool, "list_issues")).toBe(true);
    expect(match(tool, "list-issues")).toBe(true);
    expect(match(tool, "listIssues")).toBe(true);
    expect(match(tool, "  list   issues  ")).toBe(true);
  });

  it("requires every term, in any order and any case", () => {
    const tool = { name: "gh_create_issue", description: "Open a new issue on a repository" };
    expect(match(tool, "issue repository")).toBe(true);
    expect(match(tool, "REPOSITORY Issue")).toBe(true);
    expect(match(tool, "issue milestone")).toBe(false);
  });

  it("matches on title and description, not only the name", () => {
    const tool = { name: "gh_x1", title: "Create issue", description: "Files a bug report" };
    expect(match(tool, "create")).toBe(true);
    expect(match(tool, "bug report")).toBe(true);
  });

  it("matches nothing outside the bounded prefix of a field", () => {
    // The bound is what keeps matching cheap against text that arrives straight from the endpoint,
    // where a description has not been clamped yet and is whatever the server chose to send.
    const buried = { name: "gh_x2", description: `${"padding ".repeat(1000)} needle` };
    expect(match(buried, "needle")).toBe(false);
    expect(match(buried, "padding")).toBe(true);
  });

  it("does not turn a separator-only query into match-everything", () => {
    expect(toolQueryTerms(" _ - ")).toEqual([]);
    expect(match({ name: "anything" }, " _ - ")).toBe(false);
  });

  it("deduplicates normalized terms", () => {
    expect(toolQueryTerms("issue ISSUE issue_issue")).toEqual(["issue"]);
  });
});
