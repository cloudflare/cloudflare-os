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

    expect(candidates.map(({ label, name, metadataError }) => ({ label, name, metadataError }))).toEqual([
      { label: "one", name: "one", metadataError: "Add a name and description for this skill." },
      { label: "two", name: "two", metadataError: "Add a name and description for this skill." },
    ]);
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
    expect(candidates.map(({ metadataError }) => metadataError)).toEqual([null, null]);
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
    expect(match?.[2]).toBe("# Instructions");
  });

  it("replaces malformed frontmatter without dropping the Markdown body", () => {
    const body = writeSkillUploadMetadata(
      "---\nname: [broken\n---\nKeep this",
      "fixed",
      "Fixed metadata",
    );

    expect(body).toContain("name: fixed");
    expect(body).toContain("description: Fixed metadata");
    expect(body).toContain("Keep this");
    expect(body).not.toContain("[broken");
  });
});
