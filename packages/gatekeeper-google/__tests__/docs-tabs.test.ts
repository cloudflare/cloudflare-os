import { describe, expect, it } from "vitest";
import { blankDocsTab } from "../src/docs-api";
import { checkDocTabTitle, insertDocTab, type DocTabPlacement } from "../src/docs-tabs";
import { docTabToMarkdown, type DocTabSnapshot } from "../src/markdown-converter";

/** A blank tab with `id`, placed as given; its content does not matter here. */
function tab(id: string, place: Partial<DocTabSnapshot> = {}): DocTabSnapshot {
  return { ...docTabToMarkdown(blankDocsTab(id, id.toUpperCase())), ...place };
}

/** Each tab as `id@index/nestingLevel<parent`, in list order. */
function shape(tabs: DocTabSnapshot[]): string[] {
  return tabs.map(t =>
    `${t.tabId}@${t.index}/${t.nestingLevel}${t.parentTabId ? `<${t.parentTabId}` : ""}`);
}

// a
//   a1
//     a1x
//   a2
// b
const DOC = [
  tab("a"),
  tab("a1", { parentTabId: "a", nestingLevel: 1 }),
  tab("a1x", { parentTabId: "a1", nestingLevel: 2 }),
  tab("a2", { parentTabId: "a", index: 1, nestingLevel: 1 }),
  tab("b", { index: 1 }),
];

function add(tabs: DocTabSnapshot[], id: string, placement: DocTabPlacement = {}) {
  return insertDocTab(tabs, tab(id), placement);
}

describe("insertDocTab", () => {
  it("puts a top-level tab last when no index is given", () => {
    expect(shape(add(DOC, "n"))).toEqual(["a@0/0", "a1@0/1<a", "a1x@0/2<a1", "a2@1/1<a", "b@1/0", "n@2/0"]);
  });

  it("puts a child after its parent's last descendant when no index is given", () => {
    expect(shape(add(DOC, "n", { parentTabId: "a" }))).toEqual(
      ["a@0/0", "a1@0/1<a", "a1x@0/2<a1", "a2@1/1<a", "n@2/1<a", "b@1/0"]);
  });

  it("places a tab at an index, shifting its later siblings and only them", () => {
    expect(shape(add(DOC, "n", { parentTabId: "a", index: 0 }))).toEqual(
      ["a@0/0", "n@0/1<a", "a1@1/1<a", "a1x@0/2<a1", "a2@2/1<a", "b@1/0"]);
    expect(shape(add(DOC, "n", { index: 1 }))).toEqual(
      ["a@0/0", "a1@0/1<a", "a1x@0/2<a1", "a2@1/1<a", "n@1/0", "b@2/0"]);
  });

  it("takes the child count as an index, as Google does", () => {
    expect(shape(add(DOC, "n", { parentTabId: "a", index: 2 })))
      .toEqual(shape(add(DOC, "n", { parentTabId: "a" })));
  });

  it("nests under a tab added before it", () => {
    let tabs = add(add(DOC, "n"), "m", { parentTabId: "n" });
    expect(shape(tabs).slice(-2)).toEqual(["n@2/0", "m@0/1<n"]);
    expect(shape(add(tabs, "o", { parentTabId: "n", index: 0 })).slice(-3))
      .toEqual(["n@2/0", "o@0/1<n", "m@1/1<n"]);
  });

  it("leaves the list it was given alone", () => {
    let before = shape(DOC);
    add(DOC, "n", { index: 0 });
    expect(shape(DOC)).toEqual(before);
  });

  it.each([
    [{ parentTabId: "zz" }, 'no tab with ID "zz" exists in this document'],
    [{ parentTabId: "a1x" }, "nests tabs at most three levels deep"],
    [{ parentTabId: "a", index: 3 }, 'from 0 to 2, the number of tabs under tab "a"'],
    [{ index: -1 }, "from 0 to 2, the number of tabs at the top level"],
    [{ index: 0.5 }, "index must be an integer"],
  ] as const)("refuses %o", (placement, message) => {
    expect(() => add(DOC, "n", placement)).toThrow(message);
  });
});

describe("checkDocTabTitle", () => {
  it.each([
    ["", "must not be empty"],
    ["  ", "must not be empty"],
    ["a\nb", "one line"],
    ["x".repeat(51), "at most 50 characters"],
    // 26 emoji are 52 code units, which Google counts.
    ["😀".repeat(26), "at most 50 characters"],
  ])("refuses %j", (title, message) => {
    expect(() => checkDocTabTitle(title)).toThrow(message);
  });

  it("takes a title Google keeps as given", () => {
    expect(() => checkDocTabTitle("x".repeat(50))).not.toThrow();
    expect(() => checkDocTabTitle("  a\tb  ")).not.toThrow();
  });
});
