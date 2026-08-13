// Matching a text query against a tool, shared by every catalog search.
//
// One implementation on purpose. Two connectors search the same way over different sources -- one
// filters definitions already in hand, while endpoint discovery applies it as each page is parsed --
// and a query answered differently depending on the path would be a difference nobody asked for and
// nobody could see.

import type { McpTool } from "./client.js";

/** Longest accepted agent-supplied search query. */
export const MAX_QUERY_CHARS = 200;

/** Most tool summaries returned by one search. */
export const MAX_SEARCH_RESULTS = 20;

// Longest run of one server-supplied field considered when matching.
//
// The bound is load-bearing on the path that matches tools as they arrive from the endpoint, before
// per-field clamping: a description there is whatever the server sent, and every term is tested
// against it. Applied unconditionally rather than only on that path, so no caller has to know which
// of its inputs were already clamped in order to be safe.
const MAX_SEARCHABLE_FIELD_CHARS = 4000;

// Normalizes text for matching. Word separators become spaces so that a query typed as
// `list issues`, `list_issues`, or `listIssues` reaches a tool named `github_list_issues`: MCP tool
// names are overwhelmingly snake_case or camelCase, and a portal prefixes each with `{server_id}_`,
// so leaving word boundaries in place would make the obvious query miss the obvious tool.
function normalize(text: string): string {
  return text.slice(0, MAX_SEARCHABLE_FIELD_CHARS)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-\s]+/g, " ");
}

/** Splits a query into normalized terms that a matching tool must all contain. */
export function toolQueryTerms(query: string): string[] {
  return [...new Set(normalize(query.slice(0, MAX_QUERY_CHARS)).split(" ").filter(Boolean))];
}

/** Returns whether a tool's name, title, and description collectively match every term. */
export function matchesToolQuery(
  tool: Pick<McpTool, "name" | "title" | "description">,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return false;
  const text = [tool.name, tool.title, tool.description]
    .filter((value): value is string => typeof value === "string")
    .map(normalize)
    .join(" ");
  return terms.every(term => text.includes(term));
}
