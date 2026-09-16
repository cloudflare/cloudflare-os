import { describe, expect, it } from "vitest";
import {
  AGENT_SKILL_CATALOG_MAX_ENTRIES,
  isSkillManifestPath, buildAgentSkillCatalogEntries, buildAgentSkillCommands,
  buildAgentSkillMessage, buildContextCatalog, parseSkillManifest,
  type CollectionSkills,
} from "../src/agent-skill";
import { isTextContentType } from "../src/context-types";

describe("parseSkillManifest", () => {
  it("parses a specification-conformant manifest", () => {
    expect(parseSkillManifest(
      "operations/incident-response/SKILL.md",
      `---
name: incident-response
description: Diagnose and mitigate production incidents.
license: Apache-2.0
compatibility: Requires access to production observability tools.
metadata:
  owner: sre
allowed-tools: Read Grep
---
# Incident response

Follow the runbook.
`,
    )).toEqual({
      name: "incident-response",
      description: "Diagnose and mitigate production incidents.",
    });
  });

  it("allows the frontmatter name to differ from the parent directory", () => {
    expect(parseSkillManifest("skills/example-dir/SKILL.md", `---
name: example
description: Valid description.
---
Instructions
`)).toEqual({
      name: "example",
      description: "Valid description.",
    });
  });

  it("accepts a collection-root manifest", () => {
    expect(isSkillManifestPath("SKILL.md")).toBe(true);
    expect(parseSkillManifest("SKILL.md", `---
name: incident-response
description: Incident response.
---
Instructions
`)).toEqual({
      name: "incident-response",
      description: "Incident response.",
    });
  });

  it("rejects a manifest with an invalid filename", () => {
    expect(() => parseSkillManifest("operations/incident-response/skill.md", `---
name: incident-response
description: Incident response.
---
Instructions
`)).toThrow("Skill manifest filename must be SKILL.md.");
  });

  it.each([
    ["Bad", "Skill name must use lowercase letters, numbers, and single hyphens."],
    ["bad--name", "Skill name must use lowercase letters, numbers, and single hyphens."],
    ["", "Skill name is required."],
  ])("rejects invalid name %s", (name, message) => {
    expect(() => parseSkillManifest(`skills/${name || "empty"}/SKILL.md`, `---
name: ${name}
description: Valid description.
---
Instructions
`)).toThrow(message);
  });

  it.each(["", "   "])("rejects an empty description", (description) => {
    expect(() => parseSkillManifest("skills/example/SKILL.md", `---
name: example
description: "${description}"
---
Instructions
`)).toThrow("Skill description is required.");
  });

  it("accepts frontmatter from uploaded files with a BOM or fence whitespace", () => {
    expect(parseSkillManifest("skills/example/SKILL.md", `\uFEFF--- \r
name: example\r
description: Valid description.\r
--- \r
Instructions
`)).toEqual({
      name: "example",
      description: "Valid description.",
    });
  });

  it("does not treat indented delimiter-looking lines as frontmatter fences", () => {
    expect(parseSkillManifest("skills/example/SKILL.md", `---
name: example
description: |
  Valid description.
  ---
  Still part of the description.
---
Instructions
`)).toEqual({
      name: "example",
      description: "Valid description.\n---\nStill part of the description.",
    });
  });

  it("rejects malformed frontmatter with an actionable diagnostic", () => {
    expect(() => parseSkillManifest("skills/example/SKILL.md", "# Missing frontmatter"))
      .toThrow("Skill manifest must start with YAML frontmatter.");
    expect(() => parseSkillManifest("skills/example/SKILL.md", "---\nname: example\n"))
      .toThrow("Skill manifest frontmatter is not closed.");
    expect(() => parseSkillManifest("skills/example/SKILL.md", "---\nname: [\n---\nBody"))
      .toThrow("Skill frontmatter is not valid YAML.");
    expect(() => parseSkillManifest("skills/example/SKILL.md", "---\n[]\n---\nBody"))
      .toThrow("Skill frontmatter must be a mapping.");
  });

  it("accepts skill bodies larger than 10,000 characters", () => {
    expect(parseSkillManifest(
      "skills/example/SKILL.md",
      `---\nname: example\ndescription: Example.\n---\n${"a".repeat(10_001)}`,
    )).toEqual({name: "example", description: "Example."});
  });

});

describe("buildAgentSkillCommands", () => {
  it("keeps duplicate names as exact collection-qualified command IDs", () => {
    let now = new Date();
    let loaded: CollectionSkills[] = ["sales", "engineering"].map(collectionId => ({
      collection: {
        id: collectionId,
        title: collectionId === "sales" ? "Sales Playbooks" : "Engineering Runbooks",
        description: "",
        source: collectionId === "sales" ? "private" : "public",
        lastUpdated: now,
      },
      skills: [{
        path: "deploy/SKILL.md",
        description: `Deploy for ${collectionId}`,
        skillName: "deploy",
      }],
    }));

    expect(buildAgentSkillCommands(loaded)).toEqual([{
      id: "sales/deploy/SKILL.md",
      name: "deploy",
      description: "Deploy for sales",
      resourceLabel: "Sales Playbooks · deploy/SKILL.md",
    }, {
      id: "engineering/deploy/SKILL.md",
      name: "deploy",
      description: "Deploy for engineering",
      resourceLabel: "Engineering Runbooks · deploy/SKILL.md",
    }]);
    expect(buildAgentSkillCatalogEntries(loaded)).toEqual([{
      id: "engineering/deploy/SKILL.md",
      title: "deploy",
      description: "Agent Skill. Read with env[N].read(id) and console.log(document.content). Deploy for engineering",
    }, {
      id: "sales/deploy/SKILL.md",
      title: "deploy",
      description: "Agent Skill. Read with env[N].read(id) and console.log(document.content). Deploy for sales",
    }]);
  });

  it("returns all discovered skills", () => {
    let now = new Date();
    let loaded: CollectionSkills[] = [{
      collection: {
        id: "large",
        title: "Large Library",
        description: "",
        source: "public",
        lastUpdated: now,
      },
      skills: Array.from({length: 102}, (_, index) => ({
        path: `skill-${index}/SKILL.md`,
        description: `Skill ${index}`,
        skillName: `skill-${index}`,
      })),
    }];

    expect(buildAgentSkillCommands(loaded)).toHaveLength(102);
  });

  it("uses only the current derived skill metadata", () => {
    let now = new Date();
    let loaded: CollectionSkills[] = [{
      collection: {
        id: "operations",
        title: "Operations",
        description: "",
        source: "private",
        lastUpdated: now,
      },
      skills: [{
        path: "deploy/SKILL.md",
        description: "Deploy safely.",
        skillName: "deploy",
      }],
    }];

    expect(buildAgentSkillCommands(loaded).map(command => command.name)).toEqual(["deploy"]);

    loaded[0].skills = [{
      ...loaded[0].skills[0],
      description: "Release safely.",
      skillName: "release",
    }];
    expect(buildAgentSkillCommands(loaded)).toMatchObject([{
      name: "release",
      description: "Release safely.",
    }]);

    loaded[0].skills = [];
    expect(buildAgentSkillCommands(loaded)).toEqual([]);
  });
});

describe("skill manifest content types", () => {
  it("recognizes normalized text content types with parameters", () => {
    expect(isTextContentType("Text/Markdown; charset=utf-8")).toBe(true);
    expect(isTextContentType(" application/yaml; charset=utf-8 ")).toBe(true);
    expect(isTextContentType("application/octet-stream")).toBe(false);
  });
});

describe("buildAgentSkillMessage", () => {
  // A quote in the path is why the root is named in prose rather than an element attribute.
  let docId = 'lib/skills/de"ck/SKILL.md';
  let root = 'skill root: lib/skills/de"ck/ — read the documents it references before following ' +
    "it: prefix skill-local paths with this root, shared paths with the collection ID alone. " +
    "Read by ID.";

  it("replaces $ARGUMENT with the full argument text", () => {
    expect(buildAgentSkillMessage(
      docId,
      "Create a presentation about $ARGUMENT.",
      "CloudflareOS",
    )).toBe(
      `<agent_skill>\nCreate a presentation about CloudflareOS.\n</agent_skill>\n\n${root}`,
    );
  });

  it("inserts dollar signs without replacement-string expansion", () => {
    let args = "$& $$ $` $' $1";
    expect(buildAgentSkillMessage(docId, "Use $ARGUMENT exactly.", args)).toBe(
      `<agent_skill>\nUse ${args} exactly.\n</agent_skill>\n\n${root}`,
    );
  });

  it("appends the argument when the skill has no placeholder", () => {
    expect(buildAgentSkillMessage(
      docId,
      "Create a clear presentation.",
      "Make it nice and clean",
    )).toBe(
      `<agent_skill>\nCreate a clear presentation.\n</agent_skill>\n\n${root}\n\n` +
      "ARGUMENT: Make it nice and clean",
    );
  });

  it("does not append an empty argument", () => {
    expect(buildAgentSkillMessage(docId, "Create a clear presentation.", "")).toBe(
      `<agent_skill>\nCreate a clear presentation.\n</agent_skill>\n\n${root}`,
    );
  });
});

describe("buildContextCatalog", () => {
  let collection = (id: string, title: string) => ({
    id, title, description: `${title} description`,
    source: "public" as const, lastUpdated: new Date(),
  });

  it("keeps every collection when skills exceed their cap", () => {
    let collections = Array.from({length: 40}, (_, index) =>
      collection(`c${index}`, `Zulu collection ${String(index).padStart(2, "0")}`));
    let loaded: CollectionSkills[] = [{
      collection: collections[0],
      // Named to sort ahead of every collection title, which is what used to evict them.
      skills: Array.from({length: AGENT_SKILL_CATALOG_MAX_ENTRIES + 50}, (_, index) => ({
        path: `aa-skill-${index}/SKILL.md`,
        description: `Skill ${index}`,
        skillName: `aa-skill-${String(index).padStart(4, "0")}`,
      })),
    }];

    let catalog = buildContextCatalog(collections, loaded);

    let ids = new Set(catalog.entries.map(entry => entry.id));
    expect(collections.every(each => ids.has(each.id))).toBe(true);
    expect(catalog.entries).toHaveLength(collections.length + AGENT_SKILL_CATALOG_MAX_ENTRIES);
    expect(catalog.truncated).toBe(true);
  });

  it("reports no truncation when every skill fits", () => {
    let collections = [collection("c0", "Runbooks")];
    let loaded: CollectionSkills[] = [{
      collection: collections[0],
      skills: [{path: "deploy/SKILL.md", description: "Deploy", skillName: "deploy"}],
    }];

    let catalog = buildContextCatalog(collections, loaded);

    expect(catalog.entries.map(entry => entry.id)).toEqual(["c0", "c0/deploy/SKILL.md"]);
    expect(catalog.truncated).toBe(false);
  });
});
