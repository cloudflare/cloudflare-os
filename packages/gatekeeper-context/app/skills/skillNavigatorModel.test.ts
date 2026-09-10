import { describe, expect, it } from "vitest";
import type {
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../../src/context-types";
import {
  buildSkillNavigator,
  filterSkillNavigator,
} from "./skillNavigatorModel";

const collection = (
  id: string,
  title: string,
  description = "",
): EnabledCollectionInfo => ({
  id,
  title,
  description,
  source: "private",
  lastUpdated: new Date(0),
});

const document = (
  path: string,
  options: { skillName?: string; description?: string } = {},
): ContextDocumentSummary => ({
  path,
  name: path.split("/").at(-1) ?? path,
  description: options.description ?? "",
  contentType: "text/markdown",
  skillName: options.skillName,
  lastUpdated: new Date(0),
});

describe("skillNavigatorModel", () => {
  it("lists collections, skill ancestors, and skills without context documents", () => {
    const collections = [collection("product", "Product"), collection("empty", "Empty")];
    const documents = new Map([
      ["product", [
        document("context/roadmap.md", { description: "Context only" }),
        document("skills/release/SKILL.md", {
          skillName: "release",
          description: "Ship a release",
        }),
        document("skills/release/references/checklist.md"),
        document("teams/design/review/SKILL.md", { skillName: "review" }),
      ]],
    ]);

    expect(buildSkillNavigator(collections, documents)).toMatchObject([
      { collection: { title: "Empty" }, children: [] },
      {
        collection: { title: "Product" },
        children: [
          {
            type: "directory",
            path: "skills",
            children: [{ type: "skill", name: "release" }],
          },
          {
            type: "directory",
            path: "teams",
            children: [{
              type: "directory",
              path: "teams/design",
              children: [{ type: "skill", name: "review" }],
            }],
          },
        ],
      },
    ]);
  });

  it("matches collection metadata, directories, skill names, and descriptions", () => {
    const navigator = buildSkillNavigator(
      [collection("product", "Product", "Launch work")],
      new Map([["product", [
        document("skills/release/SKILL.md", {
          skillName: "release",
          description: "Publish changes",
        }),
        document("teams/design/review/SKILL.md", {
          skillName: "review",
          description: "Check a pull request",
        }),
      ]]]),
    );

    expect(filterSkillNavigator(navigator, "publish")[0].children).toMatchObject([
      { path: "skills", children: [{ name: "release" }] },
    ]);
    expect(filterSkillNavigator(navigator, "design")[0].children).toMatchObject([
      { path: "teams", children: [{ path: "teams/design", children: [{ name: "review" }] }] },
    ]);
    expect(filterSkillNavigator(navigator, "launch")[0].children).toEqual(navigator[0].children);
    expect(filterSkillNavigator(navigator, "missing")).toEqual([]);
  });

  it("keeps an empty collection when its metadata matches", () => {
    const navigator = buildSkillNavigator(
      [collection("empty", "Empty collection", "No skills yet")],
      new Map(),
    );

    expect(filterSkillNavigator(navigator, "empty")).toEqual(navigator);
  });
});
