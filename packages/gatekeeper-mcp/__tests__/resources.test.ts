import { describe, expect, it } from "vitest";

import { mcpResourceFor, mcpResources } from "../src/resources.js";

describe("mcpResources", () => {
  it("advertises HTTP only in insecure mode", () => {
    expect(mcpResources(false).map(resource => resource.urlPattern)).toEqual(["https://*"]);
    expect(mcpResources(true).map(resource => resource.urlPattern)).toEqual([
      "https://*",
      "http://*",
    ]);
  });

  it("gives the insecure entry a title that differs from the https one", () => {
    const [https, http] = mcpResources(true);
    expect(http.title).not.toBe(https.title);
  });

  it("returns the resource matching the connected endpoint", () => {
    expect(mcpResourceFor("https://mcp.example.com/mcp").urlPattern).toBe("https://*");
    expect(mcpResourceFor("http://localhost:3000/mcp").urlPattern).toBe("http://*");
  });
});
