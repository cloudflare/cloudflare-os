import { describe, expect, it } from "vitest";
import {
  isPortalNativeTool,
  looksLikePortal,
  parsePortalServers,
  reconcilePortalServers,
  toolBelongsToServer,
} from "../src/portal.js";
import { scopeAllows } from "../src/scope.js";
import { MAX_TOOLS_PER_SERVER } from "../src/tools.js";

// What a caller passes when it fetched with the ordinary catalog cap and the listing completed.
const COMPLETE = { truncated: false, cap: MAX_TOOLS_PER_SERVER };

describe("portal detection", () => {
  it("recognizes a portal by its built-in server listing", () => {
    expect(looksLikePortal([{ name: "ordinary_tool" }], COMPLETE)).toBe(false);
    expect(looksLikePortal(
      [{ name: "portal_list_servers" }, { name: "gh_list_issues" }], COMPLETE))
      .toBe(true);
  });

  it("does not infer a portal from prefixed-looking names alone", () => {
    // Plenty of ordinary servers name tools `verb_noun`. Only the portal's own tool is evidence.
    expect(looksLikePortal([{ name: "search" }, { name: "create_issue" }], COMPLETE)).toBe(false);
    expect(looksLikePortal([{ name: "list_issues" }, { name: "create_issue" }], COMPLETE))
      .toBe(false);
  });

  it("assumes a portal when the catalog was truncated", () => {
    // `tools/list` is capped at MAX_TOOLS_PER_SERVER and MCP does not order it, so on a large
    // endpoint `portal_list_servers` may be one of the tools we never saw. Concluding "not a portal"
    // from evidence we could not have seen would fail open; the next test shows what it costs.
    const truncated = Array.from(
      { length: MAX_TOOLS_PER_SERVER }, (_unused, index) => ({ name: `gh_tool_${index}` }));
    expect(looksLikePortal(truncated, COMPLETE)).toBe(true);
    expect(looksLikePortal(truncated.slice(0, -1), COMPLETE)).toBe(false);
  });

  it("assumes a portal when the byte budget cut the catalog short", () => {
    // The tool count is not the only cap. A catalog of large tool descriptions exhausts the byte
    // budget first, so the listing stops with a short array that looks complete -- and a real portal
    // would then be granted at its bare endpoint, leaving `portal_toggle_servers` callable by a
    // Gadget that could widen its own reach with it.
    const short = [{ name: "gh_list_issues" }, { name: "gh_create_issue" }];
    expect(looksLikePortal(short, { truncated: true, cap: MAX_TOOLS_PER_SERVER })).toBe(true);
    expect(looksLikePortal(short, COMPLETE)).toBe(false);
  });

  it("keeps refusing portal-native tools when the listing tool falls outside the cap", () => {
    // The failure this guards: `portal_toggle_single_server` re-enables upstream servers, so a Gadget
    // granted it could widen its own authority. Detection is the only thing standing in the way.
    const truncated = [
      { name: "portal_toggle_single_server" },
      ...Array.from(
        { length: MAX_TOOLS_PER_SERVER - 1 }, (_unused, index) => ({ name: `gh_tool_${index}` })),
    ];
    expect(scopeAllows({}, "portal_toggle_single_server", looksLikePortal(truncated, COMPLETE)))
      .toBe(false);
  });
});

describe("server id recovery", () => {
  it("splits on the first underscore only, so a tool name may keep its own underscores", () => {
    expect(toolBelongsToServer("gh_list_issues", "gh")).toBe(true);
    expect(toolBelongsToServer("test_search_cloudflare_documentation", "test")).toBe(true);
    // The remainder is not re-split: the second segment is part of the tool name, not a server.
    expect(toolBelongsToServer("test_search_cloudflare_documentation", "test_search")).toBe(false);
  });

  it("assigns no server to a name without a usable prefix", () => {
    // Bare, leading- and trailing-underscore names belong to no server, so a server-scoped grant
    // must not reach them and grouping must not invent a bucket for them.
    for (const name of ["search", "_leading", "trailing_"]) {
      expect(toolBelongsToServer(name, "search"), name).toBe(false);
      expect(toolBelongsToServer(name, ""), name).toBe(false);
    }
  });

  it("matches membership exactly, not by string prefix", () => {
    expect(toolBelongsToServer("gh_list_issues", "gh")).toBe(true);
    // "g" is a prefix of "gh" but not the server id, so this must not match.
    expect(toolBelongsToServer("gh_list_issues", "g")).toBe(false);
    // A server id that is a prefix of a longer one must not capture its tools.
    expect(toolBelongsToServer("github_list_issues", "gh")).toBe(false);
  });

  it("treats every portal_-prefixed tool as portal-native", () => {
    expect(isPortalNativeTool("portal_list_servers")).toBe(true);
    expect(isPortalNativeTool("portal_toggle_single_server")).toBe(true);
    expect(isPortalNativeTool("portalish_tool")).toBe(false);
  });
});

// Captured verbatim from a live Cloudflare MCP server portal. The earlier parser expected JSON and
// returned nothing for this, which is the whole reason it was rewritten.
const REAL_PORTAL_REPLY = {
  content: [{
    type: "text",
    text: "Available MCP Servers:\n\n" +
      "- Cloudflare documentation (test): \u2713 enabled\n" +
      "- Linear (linear): \u2713 enabled\n\n" +
      "Use portal_toggle_single_server to enable/disable a specific server.",
  }],
};

describe("parsePortalServers", () => {
  it("reads a real portal's reply, ignoring the prose around it", () => {
    // The heading and the trailing instruction are not bullet lines, and the instruction names a
    // portal tool, so neither may become a server. Each display name pairs with the id that
    // prefixes that server's tools, which is what a grant actually matches on.
    const listing = parsePortalServers(REAL_PORTAL_REPLY);
    expect(listing).toEqual({ complete: true, servers: [
      { id: "test", name: "Cloudflare documentation", enabled: true },
      { id: "linear", name: "Linear", enabled: true },
    ] });
    expect(toolBelongsToServer(
      "test_search_cloudflare_documentation", listing.servers[0].id)).toBe(true);
  });

  it("reports a disabled server, and shows one whose wording it cannot read", () => {
    // The flag only drives a hint, so unfamiliar wording must not hide a grantable server.
    expect(parsePortalServers({
      content: [{
        type: "text",
        text: "- Linear (linear): \u2713 enabled\n- GitHub (github): \u2717 disabled"
          + "\n- Jira (jira): active",
      }],
    })).toEqual({ complete: true, servers: [
      { id: "linear", name: "Linear", enabled: true },
      { id: "github", name: "GitHub", enabled: false },
      { id: "jira", name: "Jira", enabled: true },
    ] });
  });

  it("reads structuredContent and distinguishes complete empty from unrecognized", () => {
    expect(parsePortalServers({
      structuredContent: [{ id: "gh", name: "GitHub", enabled: false }],
    })).toEqual({
      complete: true,
      servers: [{ id: "gh", name: "GitHub", enabled: false }],
    });
    expect(parsePortalServers({ structuredContent: [] }))
      .toEqual({ complete: true, servers: [] });
    expect(parsePortalServers({})).toEqual({ complete: false, servers: [] });
    expect(parsePortalServers({ content: [{ type: "text", text: "no servers today" }] }))
      .toEqual({ complete: false, servers: [] });
    expect(parsePortalServers({ structuredContent: "a string" }))
      .toEqual({ complete: false, servers: [] });
  });

  it("falls back to valid text when structured content has an unrecognized shape", () => {
    expect(parsePortalServers({
      structuredContent: { servers: [{ id: "ignored" }] },
      content: [{ type: "text", text: "- GitHub (gh): enabled" }],
    })).toEqual({
      complete: true,
      servers: [{ id: "gh", name: "GitHub", enabled: true }],
    });
    expect(parsePortalServers({
      structuredContent: [{ type: "text", text: "not a server record" }],
      content: [{ type: "text", text: "- Linear (linear): enabled" }],
    })).toEqual({
      complete: true,
      servers: [{ id: "linear", name: "Linear", enabled: true }],
    });
  });

  it("marks a partially malformed server list incomplete", () => {
    expect(parsePortalServers({
      content: [
        { type: "text", text: "Available MCP Servers:" },
        { type: "text", text: "- Linear (linear): enabled" },
        { type: "text", text: "- malformed" },
      ],
    })).toEqual({
      complete: false,
      servers: [{ id: "linear", name: "Linear", enabled: true }],
    });
  });

  it("marks unrecognized list formats incomplete so tool prefixes can recover them", () => {
    for (const entry of ["+ GitHub (gh): enabled", "1. GitHub (gh): enabled"]) {
      expect(parsePortalServers({
        content: [{ type: "text", text: `Available MCP Servers:\n${entry}` }],
      })).toEqual({ complete: false, servers: [] });
    }
  });
});


describe("reconcilePortalServers", () => {
  const tools = [
    { name: "portal_list_servers" },
    { name: "gh_list_issues" },
    { name: "linear_list_comments" },
    { name: "unprefixed" },
  ];

  it("names groups from the reported list", () => {
    expect(reconcilePortalServers(
      [{ id: "gh", name: "GitHub", enabled: true }, { id: "linear", name: "Linear", enabled: true }],
      tools,
    )).toEqual([
      { id: "gh", name: "GitHub", enabled: true },
      { id: "linear", name: "Linear", enabled: true },
    ]);
  });

  it("keeps a prefix that contributes tools but was not reported", () => {
    // Tool names are the authority on what can be granted, so an unnamed group beats a hidden one.
    expect(reconcilePortalServers([], tools)).toEqual([
      { id: "gh", name: "gh", enabled: true },
      { id: "linear", name: "linear", enabled: true },
    ]);
  });

  it("drops a reported server that contributes no tools", () => {
    const servers = reconcilePortalServers(
      [{ id: "gh", name: "GitHub", enabled: true }, { id: "jira", name: "Jira", enabled: false }],
      [{ name: "gh_list_issues" }],
    );
    expect(servers).toEqual([{ id: "gh", name: "GitHub", enabled: true }]);
  });

  it("sorts by display name", () => {
    expect(reconcilePortalServers(
      [{ id: "gh", name: "Zulip", enabled: true }, { id: "linear", name: "Asana", enabled: true }],
      tools,
    ).map(server => server.name)).toEqual(["Asana", "Zulip"]);
  });
});
