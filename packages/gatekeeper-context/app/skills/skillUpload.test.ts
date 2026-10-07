import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { prepareSkillUploads, writeSkillUploadMetadata, type SkillUploadFile } from "./skillUpload";

const file = (path: string, body = "Body", contentType = "text/markdown"): SkillUploadFile => ({
  path,
  body,
  contentType,
});

describe("prepareSkillUploads", () => {
  it("treats loose Markdown files as separate skills requiring metadata", () => {
    const candidates = prepareSkillUploads([
      file("one.md", "First"),
      file("two.markdown", "Second"),
      file("notes.txt", "Ignored", "text/plain"),
    ]);

    expect(candidates.map(({ label, name, description }) => ({
      label,
      name,
      description,
    }))).toEqual([
      { label: "one", name: "one", description: "First" },
      { label: "two", name: "two", description: "Second" },
    ]);
  });

  it("creates a neutral description when Markdown contains only a heading", () => {
    const [candidate] = prepareSkillUploads([file("deployment-check.md", "# Deployment check")]);

    expect(candidate.description).toBe("Instructions for deployment check.");
  });

  it("uses prose directly below a heading as the description", () => {
    const [candidate] = prepareSkillUploads([
      file("deployment-check.md", "# Deployment check\nVerify the production deployment."),
    ]);

    expect(candidate.description).toBe("Verify the production deployment.");
  });

  it.each([
    ["ordinary text", "Follow these instructions."],
    ["a leading thematic rule", "---\nFollow these instructions."],
    ["an unclosed metadata-looking block", "---\nname: deployment-check\nDescription"],
    ["prose between thematic rules", "---\nFollow these instructions.\n---\nThen verify."],
    ["a YAML sequence", "---\n- first\n- second\n---\nInstructions"],
    ["an unrelated YAML mapping", "---\ntitle: Old document\n---\nInstructions"],
    ["malformed YAML", "---\nname: [broken\n---\nInstructions"],
    ["an empty fenced block", "---\n\n---\nInstructions"],
    ["leading whitespace", "\n---\nname: example\ndescription: Example\n---\nInstructions"],
    ["CRLF and BOM", "\uFEFF---\r\nFollow these instructions.\r\n---\r\n\r\nVerify.\r\n"],
  ])("imports %s as legacy Markdown without losing text", (_, original) => {
    const candidates = prepareSkillUploads([
      file("review.md", original),
      file("other.md", "Another skill."),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].name).toBe("review");
    expect(candidates[0].manifestBody).toBe(original);
    expect(candidates[0].description).not.toBe("");
    const converted = writeSkillUploadMetadata(original, "review", "Review instructions.");
    expect(converted).toBe(`---\nname: review\ndescription: Review instructions.\n---\n\n${original}`);
  });

  it("derives legacy descriptions from the same preserved content used for conversion", () => {
    const [candidate] = prepareSkillUploads([
      file("review.md", "---\nFollow these instructions.\n---\nAfterword."),
    ]);

    expect(candidate.description).toContain("Follow these instructions.");
  });

  it.each([
    ["name: example", "example", ""],
    ["description: Existing description.", "", "Existing description."],
    ["name: 123\ndescription: false", "", ""],
    ["name: INVALID\ndescription: ''", "INVALID", ""],
    [`name: example\ndescription: ${"a".repeat(1025)}`, "example", "a".repeat(1025)],
  ])("leaves recognized metadata for review rather than inferring replacements: %s", (metadata, name, description) => {
    const [candidate] = prepareSkillUploads([
      file("review.md", `---\n${metadata}\n---\nInstructions with a different description.`),
    ]);

    expect(candidate.name).toBe(name);
    expect(candidate.description).toBe(description);
  });

  it("recognizes BOM, CRLF, and indented fence text inside YAML block scalars", () => {
    const original = "\uFEFF--- \r\nname: review\r\ndescription: |\r\n  Review carefully.\r\n  ---\r\n  Then verify.\r\nlicense: MIT\r\n--- \r\n\r\nInstructions\r\n";
    const [candidate] = prepareSkillUploads([file("old-name.md", original)]);

    expect(candidate.name).toBe("review");
    expect(candidate.description).toBe("Review carefully.\n---\nThen verify.\n");
    const converted = writeSkillUploadMetadata(original, "new-name", candidate.description);
    expect(converted).toContain("license: MIT");
    expect(converted.endsWith("\r\nInstructions\r\n")).toBe(true);
  });

  it("groups related files under SKILL.md and separates nested skill bundles", () => {
    const candidates = prepareSkillUploads([
      file("pack/SKILL.md", "---\nname: parent\ndescription: Parent\n---\nParent"),
      file("pack/reference.md"),
      file("pack/nested/SKILL.md", "---\nname: child\ndescription: Child\n---\nChild"),
      file("pack/nested/script.ts", "code", "text/plain"),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].supportingFiles.map(({ path }) => path)).toEqual(["reference.md"]);
    expect(candidates[1].supportingFiles.map(({ path }) => path)).toEqual(["script.ts"]);
  });

  it("removes the selected folder name from bundle-relative paths", () => {
    const [candidate] = prepareSkillUploads([
      file("incident-kit/SKILL.md", "Body"),
      file("incident-kit/assets/checklist.md"),
    ]);

    expect(candidate.label).toBe("incident-kit");
    expect(candidate.supportingFiles[0].path).toBe("assets/checklist.md");
  });
});

describe("writeSkillUploadMetadata", () => {
  it("preserves extra frontmatter and content", () => {
    const body = writeSkillUploadMetadata(
      "---\nname: old\ndescription: Old\nlicense: MIT\n---\n\n# Instructions",
      "new-skill",
      "New description",
    );
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(body);

    expect(parseYaml(match?.[1] ?? "")).toEqual({
      name: "new-skill",
      description: "New description",
      license: "MIT",
    });
    expect(match?.[2]).toBe("\n# Instructions");
  });

  it("preserves malformed frontmatter as Markdown content", () => {
    const body = writeSkillUploadMetadata(
      "---\nname: [broken\n---\nKeep this",
      "fixed",
      "Fixed metadata",
    );

    expect(body).toContain("name: fixed");
    expect(body).toContain("description: Fixed metadata");
    expect(body).toContain("Keep this");
    expect(body).toContain("---\nname: [broken\n---\nKeep this");
  });

  it("preserves a non-mapping block between Markdown thematic rules", () => {
    const original = "---\nFollow these instructions carefully.\n---\nThen verify the result.";

    const body = writeSkillUploadMetadata(original, "careful-review", "Review carefully");

    expect(body).toContain("name: careful-review");
    expect(body).toContain("description: Review carefully");
    expect(body).toContain(original);
  });
});
