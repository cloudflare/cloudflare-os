import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { makeSkillManifestBody, uniqueSkillDirectory } from "./addSkillNavigatorNode";

const frontmatter = (body: string) => body.slice(4, body.indexOf("\n---\n", 4));

describe("makeSkillManifestBody", () => {
  it.each([
    "Handles: incidents",
    "First line\nSecond line",
    "Value # not a comment",
  ])("round-trips YAML-sensitive descriptions", (description) => {
    const body = makeSkillManifestBody("incident-response", description);

    expect(parseYaml(frontmatter(body))).toEqual({
      name: "incident-response",
      description,
    });
  });
});

describe("uniqueSkillDirectory", () => {
  it("reserves inferred ancestor directories", () => {
    const documents = new Map([["collection", [{
      path: "legacy/nested/file.md",
      name: "file.md",
      description: "",
      contentType: "text/markdown",
      lastUpdated: new Date(),
    }]]]);

    expect(uniqueSkillDirectory(documents, "collection", "", "legacy")).toBe("legacy-2");
  });
});
