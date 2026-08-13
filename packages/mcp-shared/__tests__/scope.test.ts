import { describe, expect, it } from "vitest";
import {
  endpointOfResourceUrl,
  endpointTag,
  formatToolScope,
  isWholeEndpoint,
  parseToolScope,
  requireCompleteCatalogForToolSelection,
  sameEndpoint,
  scopeAllows,
  validateToolScopeAgainstCatalog,
} from "../src/scope.js";
import { MAX_TOOLS_PER_SERVER } from "../src/tools.js";

const ENDPOINT = "https://portal.example.com/mcp";

describe("parseToolScope", () => {
  it("treats a bare endpoint as the whole endpoint", () => {
    const scope = parseToolScope(ENDPOINT);
    expect(scope).toEqual({ serverId: undefined, tools: undefined });
    expect(isWholeEndpoint(scope)).toBe(true);
  });

  it("reads a server scope", () => {
    expect(parseToolScope(`${ENDPOINT}#server=github`).serverId).toBe("github");
  });

  it("reads a tool scope, decoding each name", () => {
    expect(parseToolScope(`${ENDPOINT}#tool=a%2Cb&tool=c`).tools).toEqual(["a,b", "c"]);
  });

  it("reads both keys together", () => {
    expect(parseToolScope(`${ENDPOINT}#server=gh&tool=gh_a&tool=gh_b`)).toEqual({
      serverId: "gh",
      tools: ["gh_a", "gh_b"],
    });
  });

  it("ignores unknown keys", () => {
    expect(parseToolScope(`${ENDPOINT}#server=gh&mode=selected`).serverId).toBe("gh");
  });

  it("fails closed on the legacy tools key", () => {
    for (const url of [
      `${ENDPOINT}#tools=gh_list_issues`,
      `${ENDPOINT}#tool=gh_list_issues&tools=gh_list_issues`,
    ]) {
      expect(scopeAllows(parseToolScope(url), "gh_list_issues", false)).toBe(false);
    }
  });

  it("treats no fragment at all as the whole endpoint", () => {
    expect(isWholeEndpoint(parseToolScope(`${ENDPOINT}#`))).toBe(true);
    expect(isWholeEndpoint(parseToolScope(ENDPOINT))).toBe(true);
    expect(isWholeEndpoint(parseToolScope("not a url"))).toBe(true);
  });

  it("fails closed on a key that is present but yields nothing", () => {
    // The alternative is failing open: an absent `tools` key means the whole endpoint, the widest
    // grant there is, so a mangled `#tool=` must not arrive at it.
    for (const url of [`${ENDPOINT}#server=&tool=`, `${ENDPOINT}#tool=&tool=`, `${ENDPOINT}#tool=`]) {
      const scope = parseToolScope(url);
      expect(isWholeEndpoint(scope)).toBe(false);
      expect(scopeAllows(scope, "gh_list_issues", false)).toBe(false);
    }
  });

  it("keeps an emptied scope empty across a format/parse round trip", () => {
    // `describe()` re-renders the scope onto the endpoint and the result is parsed again, so
    // dropping an empty restriction on the way out would undo the fail-closed parse above.
    const emptied = { serverId: undefined, tools: [] };
    expect(parseToolScope(formatToolScope(ENDPOINT, emptied))).toEqual(emptied);
  });

  it("rejects oversized named-tool grants before they reach a connector", () => {
    const fragment = new URLSearchParams();
    for (let i = 0; i <= MAX_TOOLS_PER_SERVER; i++) fragment.append("tool", `tool_${i}`);
    expect(() => parseToolScope(`${ENDPOINT}#${fragment}`)).toThrow(/at most 200/);
    expect(() => formatToolScope(ENDPOINT, {
      tools: Array.from({ length: MAX_TOOLS_PER_SERVER + 1 }, (_, i) => `tool_${i}`),
    })).toThrow(/at most 200/);
  });
});

describe("formatToolScope", () => {
  it("round-trips every scope shape", () => {
    for (const scope of [
      {},
      { serverId: "gh" },
      { tools: ["a", "b"] },
      { serverId: "gh", tools: ["gh_a"] },
      { tools: ["weird,name"] },
    ]) {
      expect(parseToolScope(formatToolScope(ENDPOINT, scope)))
        .toEqual({ serverId: undefined, tools: undefined, ...scope });
    }
  });

  it("leaves an unscoped endpoint untouched", () => {
    expect(formatToolScope(ENDPOINT, {})).toBe(ENDPOINT);
  });
});

describe("sameEndpoint", () => {
  it("ignores the scope fragment, which is the grant rather than the endpoint", () => {
    expect(sameEndpoint(`${ENDPOINT}#server=gh&tool=gh_a`, ENDPOINT)).toBe(true);
    expect(endpointOfResourceUrl(`${ENDPOINT}#server=gh`)).toBe(ENDPOINT);
  });

  it("distinguishes two endpoints on one host", () => {
    // The regression this guards: the check used to compare origins only, so a portal repointed
    // from `/mcp` to `/mcp-v2` kept every existing binding valid. The facet calls whatever endpoint
    // the account recorded, so the grant said one server and the calls went to another.
    expect(sameEndpoint("https://gw.example.com/mcp", "https://gw.example.com/mcp-v2")).toBe(false);
    expect(sameEndpoint("https://gw.example.com/mcp?v=1", "https://gw.example.com/mcp")).toBe(false);
  });

  it("still refuses a different host", () => {
    expect(sameEndpoint("https://gw.example.com/mcp", "https://evil.example.net/mcp")).toBe(false);
  });

  it("normalizes both sides, so one endpoint spelled two ways still matches", () => {
    expect(sameEndpoint("https://gw.example.com", "https://gw.example.com/")).toBe(true);
  });

  it("refuses anything unparseable rather than treating it as a match", () => {
    expect(sameEndpoint("not a url", ENDPOINT)).toBe(false);
    expect(sameEndpoint(ENDPOINT, "not a url")).toBe(false);
  });
});

describe("scopeAllows", () => {
  it("allows anything when the scope is empty", () => {
    expect(scopeAllows({}, "gh_list_issues", true)).toBe(true);
  });

  it("enforces a server scope by prefix", () => {
    expect(scopeAllows({ serverId: "gh" }, "gh_list_issues", true)).toBe(true);
    expect(scopeAllows({ serverId: "gh" }, "linear_list_comments", true)).toBe(false);
  });

  it("enforces a tool scope by exact name", () => {
    expect(scopeAllows({ tools: ["gh_a"] }, "gh_a", true)).toBe(true);
    expect(scopeAllows({ tools: ["gh_a"] }, "gh_ab", true)).toBe(false);
  });

  it("enforces both keys independently", () => {
    const scope = { serverId: "gh", tools: ["gh_a", "linear_b"] };
    expect(scopeAllows(scope, "gh_a", true)).toBe(true);
    // Named, but belongs to another server: a tool list smuggled past the server scope is refused.
    expect(scopeAllows(scope, "linear_b", true)).toBe(false);
    // Right server, but not named.
    expect(scopeAllows(scope, "gh_c", true)).toBe(false);
  });

  it("never grants a portal's own session-management tools", () => {
    // These toggle which upstream servers the session can reach, so granting one would let a Gadget
    // widen its own authority.
    expect(scopeAllows({}, "portal_toggle_servers", true)).toBe(false);
    expect(scopeAllows({ tools: ["portal_toggle_servers"] }, "portal_toggle_servers", true))
      .toBe(false);
  });

  it("does not withhold a plain server's coincidentally named tool", () => {
    // The exclusion exists because portals can be re-toggled; a plain server cannot be.
    expect(scopeAllows({}, "portal_open", false)).toBe(true);
  });
});

describe("validateToolScopeAgainstCatalog", () => {
  const catalog = {
    tools: [{ name: "gh_list_issues" }, { name: "linear_list_comments" }],
    truncated: false,
  };

  it("rejects a named tool absent from a complete catalog", () => {
    expect(() => validateToolScopeAgainstCatalog({ tools: ["missing"] }, catalog))
      .toThrow(/missing.*current tool catalog/i);
  });

  it("accepts named tools present in a complete catalog", () => {
    expect(() => validateToolScopeAgainstCatalog({ tools: ["gh_list_issues"] }, catalog))
      .not.toThrow();
  });

  it("accepts named tools that were found before an exact-name listing stopped", () => {
    expect(() => validateToolScopeAgainstCatalog(
      { tools: ["gh_list_issues"] }, { ...catalog, truncated: true }))
      .not.toThrow();
  });

  it("refuses an unresolved named tool when its listing was truncated", () => {
    expect(() => validateToolScopeAgainstCatalog(
      { tools: ["missing"] }, { ...catalog, truncated: true }))
      .toThrow(/truncated/i);
  });

  it("accepts a reported server-wide grant despite a truncated tool catalog", () => {
    const github = { id: "gh", name: "GitHub", enabled: true };
    expect(validateToolScopeAgainstCatalog(
      { serverId: "gh" }, { ...catalog, truncated: true }, [github])).toEqual(github);
  });

  it("rejects a portal server absent from both the catalog and reported server list", () => {
    expect(() => validateToolScopeAgainstCatalog({ serverId: "jira" }, catalog, []))
      .toThrow(/jira.*current portal catalog/i);
  });

  it("accepts an all-tools grant for a currently reported server with no tools", () => {
    const jira = { id: "jira", name: "Jira Cloud", enabled: false };
    expect(validateToolScopeAgainstCatalog({ serverId: "jira" }, catalog, [jira])).toEqual(jira);
  });

  it("returns fallback metadata for a server established by its current tools", () => {
    expect(validateToolScopeAgainstCatalog({ serverId: "gh" }, catalog, [])).toEqual({
      id: "gh",
      name: "gh",
      enabled: true,
    });
  });

  it("uses current tool evidence to validate a pinned-empty grant", () => {
    expect(validateToolScopeAgainstCatalog(
      { serverId: "gh", tools: [] }, catalog, [])).toEqual({
      id: "gh",
      name: "gh",
      enabled: true,
    });
  });

  it("rejects named tools outside or absent from the selected portal server", () => {
    expect(() => validateToolScopeAgainstCatalog(
      { serverId: "gh", tools: ["linear_list_comments"] }, catalog))
      .toThrow(/does not belong.*gh/i);
    expect(() => validateToolScopeAgainstCatalog(
      { serverId: "gh", tools: ["gh_missing"] }, catalog))
      .toThrow(/gh_missing.*current tool catalog/i);
  });
});

describe("requireCompleteCatalogForToolSelection", () => {
  it("refuses individual selection from a truncated catalog", () => {
    expect(() => requireCompleteCatalogForToolSelection(true))
      .toThrow(/too large.*individual tools/i);
    expect(() => requireCompleteCatalogForToolSelection(false)).not.toThrow();
  });
});

describe("endpointTag", () => {
  // Action-kind tags namespace persistent approval policy, so they have to draw the line between
  // servers in exactly the place the rest of the connector does.
  const pairs: [string, string][] = [
    ["https://h.example.com/mcp", "https://h.example.com/mcp-v2"],
    ["https://h.example.com/mcp", "https://other.example.com/mcp"],
    ["https://h.example.com/a/mcp", "https://h.example.com/b/mcp"],
    ["https://h.example.com/mcp?t=1", "https://h.example.com/mcp?t=2"],
    ["https://h.example.com/mcp", "https://h.example.com:8443/mcp"],
  ];

  it("separates every pair of endpoints that sameEndpoint calls different", () => {
    // The regression: tags were keyed on the origin, so the first pair collided and an
    // always-approve decision for a tool on one path auto-applied to the same name on the other.
    for (const [a, b] of pairs) {
      expect(sameEndpoint(a, b)).toBe(false);
      expect(endpointTag(a)).not.toBe(endpointTag(b));
    }
  });

  it("gives one endpoint one tag, however it is spelled", () => {
    // The other direction. Splitting a single endpoint's policy across two spellings would quietly
    // ask the user to re-approve tools they had already decided on.
    const spellings = [
      "https://h.example.com/mcp",
      "https://h.example.com/mcp#tool=a&tool=b",
      "https://H.Example.com/mcp",
      "https://h.example.com:443/mcp",
    ];
    for (const spelling of spellings) {
      expect(sameEndpoint(spelling, spellings[0])).toBe(true);
      expect(endpointTag(spelling)).toBe(endpointTag(spellings[0]));
    }
  });

  it("encodes, so an endpoint cannot be read as a tag separator", () => {
    // Tags are composed as `mcp:<endpoint>` and `mcp-portal:<endpoint>:<binding>`, so a raw colon
    // or slash inside the endpoint half could be mistaken for structure by anything parsing them.
    const tag = endpointTag("https://h.example.com/mcp");
    expect(tag).not.toContain(":");
    expect(tag).not.toContain("/");
  });
});
