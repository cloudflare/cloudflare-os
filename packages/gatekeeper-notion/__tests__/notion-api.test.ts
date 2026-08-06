import { describe, expect, it } from "vite-plus/test";
import {
  blocksToMarkdown,
  markdownToBlocks,
  parseNotionId,
  propertyValueToInput,
  type BlockWithChildren,
} from "../src/notion-api";

function paragraph(richText: unknown[]): BlockWithChildren {
  return { block: { id: "b", type: "paragraph", paragraph: { rich_text: richText } } as any };
}
function run(content: string, annotations?: Record<string, boolean>) {
  return { type: "text", plain_text: content, text: { content }, annotations: annotations ?? {} };
}

import { simulatePageContent, simulatedTitle, type StoredActionRecord } from "../src/notion-actions";

function rec(id: number, action: any): StoredActionRecord {
  return { id, action, state: "pending", submittedAt: id };
}

describe("parseNotionId", () => {
  // Slug words ending in a hex char (a–f or a digit) must not glue onto the 32-char ID.
  it("parses slug URLs whose last word ends in a hex character", () => {
    expect(parseNotionId("https://app.notion.com/p/Team-Home-8513f007d6074da88eebabcbcd0b78f4"))
      .toBe("8513f007-d607-4da8-8eeb-abcbcd0b78f4");
    expect(parseNotionId("https://app.notion.com/p/Ad-Hoc-cf259cd6c939441da86764eef3892c66"))
      .toBe("cf259cd6-c939-441d-a867-64eef3892c66");
    expect(parseNotionId("https://www.notion.so/My-Page-Title-1c5e94bd682e422fb42d13fea9f655a0"))
      .toBe("1c5e94bd-682e-422f-b42d-13fea9f655a0");
  });

  it("parses slug URLs whose last word ends in a non-hex character", () => {
    expect(parseNotionId("https://app.notion.com/p/V-lkommen-till-Notion-38809dfc5d6380b9a93ad369abe07009"))
      .toBe("38809dfc-5d63-80b9-a93a-d369abe07009");
  });

  it("parses bare IDs and dashed UUIDs", () => {
    expect(parseNotionId("https://www.notion.so/38809dfc5d6380b9a93ad369abe07009"))
      .toBe("38809dfc-5d63-80b9-a93a-d369abe07009");
    expect(parseNotionId("38809dfc5d6380b9a93ad369abe07009"))
      .toBe("38809dfc-5d63-80b9-a93a-d369abe07009");
    expect(parseNotionId("2c5e94bd-682e-422f-b42d-13fea9f655a0"))
      .toBe("2c5e94bd-682e-422f-b42d-13fea9f655a0");
  });

  it("ignores the ?v= view ID on database URLs (uses the path ID)", () => {
    expect(parseNotionId(
      "https://www.notion.so/ws/Tasks-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&pvs=4"))
      .toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("prefers the focused page (?p=) on peek URLs over the containing database in the path", () => {
    expect(parseNotionId(
      "https://www.notion.so/ws/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&p=cccccccccccccccccccccccccccccccc&pm=s"))
      .toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("throws when no ID is present", () => {
    expect(() => parseNotionId("https://www.notion.so/")).toThrow();
    expect(() => parseNotionId("not-an-id")).toThrow();
  });
});

describe("markdownToBlocks", () => {
  it("maps common Markdown constructs to Notion blocks", () => {
    const blocks = markdownToBlocks(
      "# Heading\n\nA paragraph.\n\n- a\n- b\n\n1. one\n\n- [x] done\n\n> quote\n\n---") as Array<Record<string, any>>;
    const types = blocks.map(b => b.type);
    expect(types).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "quote",
      "divider",
    ]);
    expect(blocks[5].to_do.checked).toBe(true);
  });

  it("captures a fenced code block with its language", () => {
    const blocks = markdownToBlocks("```ts\nconst x = 1;\n```") as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].code.language).toBe("typescript");
  });
});

describe("blocksToMarkdown emphasis", () => {
  it("merges adjacent same-style runs instead of emitting ****", () => {
    const md = blocksToMarkdown([paragraph([run("foo", { bold: true }), run("bar", { bold: true })])]);
    expect(md).toBe("**foobar**");
    expect(md).not.toContain("****");
  });

  it("hoists whitespace outside emphasis markers", () => {
    // A bold run with a trailing space must render as "**Tip:** ok", not "**Tip: **ok" (the latter
    // has a space directly inside the markers, which CommonMark won't treat as bold).
    const md = blocksToMarkdown([paragraph([run("Tip: ", { bold: true }), run("ok")])]);
    expect(md).toBe("**Tip:** ok");
  });
});

describe("blocksToMarkdown columns", () => {
  it("renders column_list/column children transparently (no placeholder)", () => {
    const tree: BlockWithChildren[] = [{
      block: { id: "cl", type: "column_list", has_children: true } as any,
      children: [{
        block: { id: "c1", type: "column", has_children: true } as any,
        children: [paragraph([run("left")])],
      }, {
        block: { id: "c2", type: "column", has_children: true } as any,
        children: [paragraph([run("right")])],
      }],
    }];
    const md = blocksToMarkdown(tree);
    expect(md).toContain("left");
    expect(md).toContain("right");
    expect(md).not.toContain("unsupported block");
  });
});

describe("simulatedTitle", () => {
  it("derives the title from setTitle, the create title, and title-typed properties", () => {
    expect(simulatedTitle([rec(1, { type: "setTitle", pageId: "p", title: "Renamed", previousTitle: "" })], "Old"))
      .toBe("Renamed");
    // Title set via a title-typed property entry on create (not the `title` shorthand).
    expect(simulatedTitle([rec(1, {
      type: "createPage", provisionalId: "~1", parent: { kind: "database", databaseId: "d" },
      properties: { Name: { type: "title", text: "FromProp" } },
    })], "")).toBe("FromProp");
    // setProperties with a title-typed entry updates the title too.
    expect(simulatedTitle([rec(1, {
      type: "setProperties", pageId: "p",
      properties: { Name: { type: "title", text: "Edited" } }, previousProperties: {},
    })], "Old")).toBe("Edited");
  });
});

describe("simulatePageContent", () => {
  it("reflects the markdown->block conversion (not a raw echo)", () => {
    const md = simulatePageContent(null, [rec(1, { type: "appendContent", pageId: "p", markdown: "##### deep\n\n* a" })]);
    // ##### clamps to ### and `*` bullets become `-`, matching what an apply + read-back yields.
    expect(md).toContain("### deep");
    expect(md).toContain("- a");
    expect(md).not.toContain("##### ");
    expect(md).not.toContain("* a");
  });
});

describe("markdownToBlocks headings", () => {
  it("clamps headings deeper than H3 to heading_3", () => {
    const blocks = markdownToBlocks("#### deep") as Array<Record<string, any>>;
    expect(blocks[0].type).toBe("heading_3");
  });
});

describe("blocksToMarkdown child pages", () => {
  it("renders child pages as https links and does not inline their bodies", () => {
    const tree: BlockWithChildren[] = [{
      block: { id: "11111111111111111111111111111111", type: "child_page", has_children: true,
        child_page: { title: "Sub" } } as any,
      // Even if a body was (incorrectly) fetched, it must not be inlined.
      children: [{ block: { id: "x", type: "paragraph", paragraph: { rich_text: [run("secret body")] } } as any }],
    }];
    const md = blocksToMarkdown(tree);
    expect(md).toContain("[Sub](https://www.notion.so/11111111111111111111111111111111)");
    expect(md).not.toContain("secret body");
    expect(md).not.toContain("notion://");
    expect(md).not.toContain("nested content not shown");
  });
});

describe("propertyValueToInput", () => {
  it("round-trips writable values and rejects computed ones", () => {
    expect(propertyValueToInput({ type: "select", option: "Doing" }))
      .toEqual({ type: "select", option: "Doing" });
    expect(propertyValueToInput({ type: "people", people: [{ id: "u1" }, { id: "u2" }] }))
      .toEqual({ type: "people", userIds: ["u1", "u2"] });
    expect(propertyValueToInput({ type: "formula", value: 5 })).toBeNull();
    expect(propertyValueToInput({ type: "created_time", time: new Date() })).toBeNull();
  });
});
