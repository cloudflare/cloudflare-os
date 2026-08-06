import { describe, expect, it } from "vite-plus/test";

import { mcpResourceFor, mcpResources } from "../src/resources.js";

describe("mcpResources", () => {
  it("advertises HTTP only in insecure mode", () => {
    expect(mcpResources(false).map(resource => resource.urlPattern)).toEqual(["https://*"]);
    expect(mcpResources(true).map(resource => resource.urlPattern)).toEqual([
      "https://*",
      "http://*",
    ]);
  });

  it("returns the resource matching the connected endpoint", () => {
    expect(mcpResourceFor("https://mcp.example.com/mcp").urlPattern).toBe("https://*");
    expect(mcpResourceFor("http://localhost:3000/mcp").urlPattern).toBe("http://*");
  });
});
