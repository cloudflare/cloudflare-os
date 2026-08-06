import { describe, expect, it } from "vite-plus/test";

import { observerRefusalMessage } from "../src/sharing-policy.js";

describe("observerRefusalMessage", () => {
  it("names the source and points at the path that does work", () => {
    // Whoever reads this has just been turned away from a link someone sent them, so it has to say
    // what to do next -- otherwise the owner's only recourse looks like "give up".
    const message = observerRefusalMessage("the MCP server mcp.linear.app");
    expect(message).toContain("mcp.linear.app");
    expect(message).toContain("only be opened by its owner");
    expect(message).toContain("blueprint");
  });
});
