import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  buildNewSkillLocation,
  makeSkillManifestBody,
  uniqueSkillDirectory,
} from "./addSkillNavigatorNode";

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

  it("keeps collision suffixes within the metadata name limit", () => {
    const name = "a".repeat(64);
    const documents = new Map([[
      "collection",
      [{
        path: `${name}/SKILL.md`,
        name: "SKILL.md",
        description: "",
        contentType: "text/markdown",
        lastUpdated: new Date(),
      }],
    ]]);

    const location = buildNewSkillLocation(documents, "collection", "", name);
    expect(location.name).toBe(`${"a".repeat(62)}-2`);
    expect(location.path).toBe(`${location.name}/SKILL.md`);
  });

  it("returns the complete skill directory below a legacy parent", () => {
    const location = buildNewSkillLocation(new Map(), "collection", "legacy", "new-skill");

    expect(location).toEqual({
      name: "new-skill",
      directory: "legacy/new-skill",
      path: "legacy/new-skill/SKILL.md",
    });
  });
});
