import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, StructuralElement, Table, TableCell, TextStyle,
} from "../src/docs-api";
import {
  assertMarkdownRangeEditable, canonicalizeMarkdownForWrite, canonicalizeMarkdownReplacement,
  canonicalLinkDestination, cellLinkDestination, computeReplaceOperations, docsLinkForDestination,
  docTabToMarkdown, LIST_LEVEL_TOO_DEEP, MARKDOWN_RENDERING_VERSION, markdownToDocRequests,
  plainTextToDocRequests, POSITIONED_ITEM_BEFORE, refuseNewSuggestionMarks,
  REPLAYABLE_TEXT_EDIT_VERSIONS, StructuredContentError, stripUnwritableCharacters,
  TABBED_ITEM_BEFORE,
} from "../src/markdown-converter";
import type {
  DocTabSnapshot, MarkdownRange, Segment, TableCellMapping, TableMapping,
} from "../src/markdown-converter";
import { applyDocsRequests } from "../src/docs-model";
import { applyDocEdit, DocModelError } from "../src/docs-replay";
import { lookOfTable } from "../src/docs-table-look";
import {
  appliedOneWay, BULLET_LIST, buildTab, cellTab, CHECK_LIST, grid, para, presetLevels,
} from "./doc-fixture";
import type { BlockSpec, CellSpec, ParagraphSpec } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";
import { indentedParagraphs } from "./docs-model-probes";

/** A segment with a document counterpart, as opposed to a Markdown-syntax-only one. */
type ContentSegment = Exclude<Segment, { syntaxOnly: true }>;

const isContent = (seg: Segment): seg is ContentSegment => !("syntaxOnly" in seg);

const TAB_ID = "tab-1";
const PARENTHESIZED_URL = "https://en.wikipedia.org/wiki/Function_(mathematics)";
const INLINE_STYLES: [string, TextStyle][] = [
  ["plain", {}],
  ["bold", { bold: true }],
  ["italic", { italic: true }],
  ["bold italic", { bold: true, italic: true }],
  ["strikethrough", { strikethrough: true }],
  ["linked", { link: { url: "https://e.com" } }],
];

/**
 * The document text as Google stores it, aligned so that a string index equals a doc index: index
 * 0 is the section break, and run text begins at 1.
 */
function docText(runs: string[]): string {
  return "\u0000" + runs.join("");
}

/** Every `Location`/`Range` object nested anywhere inside a batchUpdate request. */
function coordinates(requests: unknown[]): Record<string, unknown>[] {
  let found: Record<string, unknown>[] = [];
  let visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "location" || key === "range") found.push(nested as Record<string, unknown>);
      visit(nested);
    }
  };
  visit(requests);
  return found;
}

describe("docTabToMarkdown", () => {
  it("renders headings, inline styles, links and bullets", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Title\n"], namedStyleType: "HEADING_1" },
      { runs: ["Sub\n"], namedStyleType: "HEADING_2" },
      { runs: [
        "Hello ",
        { text: "bold", style: { bold: true } },
        " and ",
        { text: "it", style: { italic: true } },
        " and ",
        { text: "link", style: { link: { url: "https://e.com" } } },
        ".\n",
      ] },
      { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["two\n"], bullet: { listId: "L1", nestingLevel: 0 } },
    ], BULLET_LIST));

    expect(snapshot.markdown).toBe(
      "# Title\n\n## Sub\n\nHello **bold** and *it* and [link](https://e.com).\n\n- one\n- two\n");
  });

  it("renders subtitles as one italic span", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Release summary\n"], namedStyleType: "SUBTITLE" },
    ]));

    expect(snapshot.markdown).toBe("*Release summary*\n");
  });
  it("renders numbered headings inside list items", () => {
    let snapshot = docTabToMarkdown(buildTab([{
      runs: ["Section\n"],
      namedStyleType: "HEADING_2",
      bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    }));

    expect(snapshot.markdown).toBe("1. ## Section\n");
  });
  it("continues an interrupted ordered list", () => {
    let tab = buildTab([
      { runs: ["First\n"], bullet: { listId: "L1" } },
      { runs: ["prose\n"] },
      { runs: ["Second\n"], bullet: { listId: "L1" } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toBe("1. First\n\nprose\n\n2. Second\n");
  });

  it("preserves a configured ordered-list start", () => {
    let tab = buildTab([
      { runs: ["First\n"], bullet: { listId: "L1" } },
      { runs: ["Second\n"], bullet: { listId: "L1" } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 4 }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toBe("4. First\n1. Second\n");
  });

  it("preserves a configured start at each ordered-list level", () => {
    let tab = buildTab([
      { runs: ["Parent\n"], bullet: { listId: "L1" } },
      { runs: ["First child\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["Second child\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["Next parent\n"], bullet: { listId: "L1" } },
      { runs: ["Restarted child\n"], bullet: { listId: "L1", nestingLevel: 1 } },
    ], {
      L1: { listProperties: { nestingLevels: [
        { glyphType: "DECIMAL" },
        { glyphType: "DECIMAL", startNumber: 4 },
      ] } },
    });

    expect(docTabToMarkdown(tab).markdown).toBe(
      "1. Parent\n  4. First child\n  1. Second child\n1. Next parent\n  4. Restarted child\n",
    );
  });

  it("separates adjacent provider lists", () => {
    let tab = buildTab([
      { runs: ["First\n"], bullet: { listId: "L1" } },
      { runs: ["Fourth\n"], bullet: { listId: "L2" } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
      L2: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 4 }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toBe("1. First\n\n4. Fourth\n");
  });

  it("preserves a configured start while rewriting a numbered item", () => {
    let snapshot = docTabToMarkdown(buildTab([{
      runs: ["First\n"], bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 4 }] } },
    }));
    let oldMarkdown = snapshot.markdown.trimEnd();
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, oldMarkdown.length, "4. ## First", TAB_ID,
    ).requests;

    expect(requests.some(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request,
    )).toBe(false);
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType",
      },
    });
  });

  it("round-trips every supported inline-style transition through a block rewrite", () => {
    for (let [fromName, fromStyle] of INLINE_STYLES) {
      for (let [toName, toStyle] of INLINE_STYLES) {
        let snapshot = docTabToMarkdown(buildTab([{ runs: [
          { text: "a", style: fromStyle },
          { text: "b", style: toStyle },
          "\n",
        ] }]));
        let { requests } = computeReplaceOperations(
          snapshot.sourceMap, snapshot.markdown, 0, 0, "# ", TAB_ID,
        );
        let inserted = requests.find(request => "insertText" in request)?.insertText.text;
        let styles: TextStyle[] = [{}, {}];
        for (let request of requests) {
          if (!("updateTextStyle" in request)) continue;
          let { range, textStyle } = request.updateTextStyle;
          for (let index = Math.max(1, range.startIndex); index < Math.min(3, range.endIndex);
            index++) {
            styles[index - 1] = { ...styles[index - 1], ...textStyle };
          }
        }

        expect(inserted, `${fromName} -> ${toName}`).toBe("ab");
        expect(styles, `${fromName} -> ${toName}`).toEqual([fromStyle, toStyle]);
      }
    }
  });

  it("preserves overlapping styles through a block rewrite", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } },
      { text: "both", style: { bold: true, italic: true } },
      "\n",
    ] }]));
    let { requests } = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, 0, "# ", TAB_ID,
    );

    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 9, tabId: TAB_ID },
        textStyle: { italic: true },
        fields: "italic",
      },
    });
  });

  it("honors explicit non-italic subtitle runs", () => {
    let paragraph = {
      runs: ["Italic", { text: "Plain", style: { italic: false } }, "\n"],
      namedStyleType: "SUBTITLE",
    };

    expect(docTabToMarkdown(buildTab([paragraph])).markdown).toBe("*Italic*Plain\n");
    expect(docTabToMarkdown(cellTab([paragraph])).markdown)
      .toContain("<td><p><em>Italic</em>Plain</p></td>");
  });

  it("renders visible smart-chip content", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { person: { name: "Ada Lovelace", email: "ada@example.com" } },
      " owns ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " due ",
      { date: "Sep 16, 2026" },
      "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "Ada Lovelace owns [Launch plan](https://docs.google.com/document/d/plan) due Sep 16, 2026\n",
    );
  });

  it("escapes structured display text as Markdown", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { richLink: {
        title: "Plan](https://evil.example)",
        uri: "https://docs.google.com/document/d/safe",
      } },
      "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "[Plan\\]\\(https://evil\\.example\\)](https://docs.google.com/document/d/safe)\n",
    );
  });

  it("escapes opening brackets in linked text", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "a[b", style: { link: { url: "https://e.com" } } }, "\n",
    ] }]));

    expect(snapshot.markdown).toBe("[a\\[b](https://e.com)\n");
  });

  it("refuses edits to smart-chip display text", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { date: "Sep 16, 2026" }, "\n",
    ] }]));
    let start = snapshot.markdown.indexOf("Sep 16, 2026");

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + 12, "Sep 17, 2026", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("renders body horizontal rules as HTML", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [{ horizontalRule: true }, "\n"] }]));

    expect(snapshot.markdown).toBe("<hr>\n");
  });

  it("renders a markerless body list without inventing a marker", () => {
    let tab = buildTab([{
      runs: ["Text\n"], bullet: { listId: "markerless" },
    }], {
      markerless: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toBe("Text\n");
  });

  it("preserves markerless list membership across a block rewrite", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["First\n"], bullet: { listId: "markerless" } },
      { runs: ["Second\n"], bullet: { listId: "markerless" } },
    ], {
      markerless: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
    }));
    let { requests } = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, "First\nSecond".length,
      "Changed first\nChanged second", TAB_ID,
    );

    expect(requests.some(request => "deleteParagraphBullets" in request)).toBe(false);
  });

  // The level Google's live API returns for a BULLET_CHECKBOX list: a placeholder glyph type, no
  // symbol. It was read as a numbered list.
  it("renders a checklist as a bulleted list, in the body and in a cell", () => {
    let checklist: Parameters<typeof buildTab>[1] = {
      todo: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
    };
    let paragraphs = [{ runs: ["Task\n"], bullet: { listId: "todo" } }];

    expect(docTabToMarkdown(buildTab(paragraphs, checklist)).markdown).toBe("- Task\n");
    expect(docTabToMarkdown(cellTab(paragraphs, checklist)).markdown).toContain("<ul>");
  });

  // 😀 and 😁 share their high surrogate; Google rejects a delete covering only the low one.
  it("replaces a whole emoji when the new one shares its high surrogate", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: ["Smile 😀 now\n"] }]));
    let start = snapshot.markdown.indexOf("😀");
    let { requests } = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + "😀".length, "😁", TAB_ID,
    );

    expect(requests.find(request => "deleteContentRange" in request)?.deleteContentRange.range)
      .toMatchObject({ startIndex: 7, endIndex: 9 });
    expect(requests.find(request => "insertText" in request)?.insertText.text).toBe("😁");
  });

  // The contract agents are given: a line break within a paragraph is U+000B, read and written.
  it("reads and writes a line break within a paragraph as U+000B", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: ["Line one\u000bline two\n"] }]));
    expect(snapshot.markdown).toBe("Line one\u000bline two\n");

    let { requests } = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, snapshot.markdown.length - 1, "A\u000bB", TAB_ID,
    );
    expect(requests.find(request => "insertText" in request)?.insertText.text).toBe("A\u000bB");
  });

  it("carries the tab's identity, position and body end index through", () => {
    let snapshot = docTabToMarkdown({
      ...buildTab([{ runs: ["abc\n"] }]),
      tabId: "metrics",
      title: "Metrics",
      parentTabId: "details",
      index: 1,
      nestingLevel: 2,
    });
    expect(snapshot).toMatchObject({
      tabId: "metrics", title: "Metrics", parentTabId: "details", index: 1, nestingLevel: 2,
    });
    // Section break (1) + "abc\n" (4).
    expect(snapshot.bodyEndIndex).toBe(5);
  });
  it.each([
    ["table of contents", "tableOfContents", "[Table of contents]"],
    ["interior section break", "sectionBreak", "[Section break]"],
  ] as const)("protects an omitted %s", (_name, structure, placeholder) => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { structure, length: 10 },
      { runs: ["After\n"] },
    ]));

    expect(snapshot.markdown).toBe(`Before\n\n${placeholder}\n\nAfter\n`);
    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, snapshot.markdown.length,
      "Updated", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

});

describe("suggestions on text", () => {
  // "Plan " 1-6, "new " 6-10 a suggested insertion, "for " 10-14, "next " 14-19 suggested for
  // deletion, "week\n" 19-24 a suggested style.
  const SUGGESTED: ParagraphSpec = {
    runs: [
      "Plan ", { text: "new ", suggested: "insertion" }, "for ",
      { text: "next ", suggested: "deletion" }, { text: "week\n", suggested: "style" },
    ],
  };

  it("marks text a suggestion inserts or deletes, and not a suggested style", () => {
    let { markdown, sourceMap } = docTabToMarkdown(buildTab([SUGGESTED]));
    expect(markdown).toBe("Plan {++new ++}for {--next --}week\n");
    // The marks are syntax: each character of the text maps to its index, as without them.
    let mapped = sourceMap.blocks[0].segments.filter(isContent);
    expect(mapped.map(segment => markdown.slice(segment.mdStart, segment.mdEnd)))
      .toEqual(["Plan ", "new ", "for ", "next ", "week"]);
    expect(mapped.map(segment => segment.docStart)).toEqual([1, 6, 10, 14, 19]);
    expect(sourceMap.blocks[0].suggested).toEqual({
      docStart: 1, docEnd: 24,
      runs: [{ docStart: 6, docEnd: 10 }, { docStart: 14, docEnd: 19 }, { docStart: 19, docEnd: 24 }],
    });
  });

  it("marks suggested text inside its formatting, and a deletion of a suggested insertion", () => {
    let tab = buildTab([{
      runs: [
        { text: "bold", style: { bold: true }, suggested: "insertion" },
        { text: " link", style: { link: { url: "https://example.com/" } }, suggested: "deletion" },
        { text: " both\n", suggested: "insertion" },
      ],
    }]);
    let last = tab.body.content[1].paragraph!.elements[2].textRun!;
    last.suggestedDeletionIds = ["suggest.other"];
    expect(docTabToMarkdown(tab).markdown)
      .toBe("**{++bold++}**[{-- link--}](https://example.com/){++{-- both--}++}\n");
  });

  it("marks a paragraph whose style or bullet a suggestion changes, and shows nothing of it", () => {
    let plain = docTabToMarkdown(buildTab([para("Centred")]));
    for (let suggestedChange of ["style", "bullet"] as const) {
      let { markdown, sourceMap } = docTabToMarkdown(buildTab([{ ...para("Centred"), suggestedChange }]));
      expect(markdown).toBe(plain.markdown);
      expect(sourceMap.blocks[0].suggested).toEqual({ docStart: 1, docEnd: 9, own: true, runs: [] });
    }
    expect(plain.sourceMap.blocks[0]).not.toHaveProperty("suggested");
  });

  it("marks suggested text in a cell with <ins> and <del>, inside the tags of its look", () => {
    let tab = buildTab([para("Before"), {
      table: [[{
        paragraphs: [{
          runs: [
            "a", { text: "new", style: { bold: true }, suggested: "insertion" },
            { text: "old", suggested: "deletion" }, { text: "b\n", suggested: "style" },
          ],
        }],
      }, "c\n"]],
    }, para("After")]);
    let { markdown, sourceMap } = docTabToMarkdown(tab);
    expect(markdown).toContain("    <td><p>a<ins><strong>new</strong></ins><del>old</del>b</p></td>\n");
    let [cell, other] = sourceMap.tables[0].rows[0].cells;
    let start = cell.docStart + 1;
    expect(cell.suggested).toEqual([{
      docStart: start, docEnd: start + 9,
      runs: [
        { docStart: start + 1, docEnd: start + 4 }, { docStart: start + 4, docEnd: start + 7 },
        { docStart: start + 7, docEnd: start + 9 },
      ],
    }]);
    expect(other).not.toHaveProperty("suggested");
  });

  it("refuses new text that holds more of a suggestion's marks than the text it replaces", () => {
    let refused = (oldMarkdown: string, newMarkdown: string) => {
      try {
        refuseNewSuggestionMarks("replaceText", oldMarkdown, newMarkdown);
        return false;
      } catch (error) {
        expect((error as Error).message).toMatch(/^replaceText: the new text holds \{\+\+/);
        return true;
      }
    };
    // The marks of a suggestion the old text quotes may stay as they are, or go with it.
    expect(refused("Plan {++new ++}for", "Plan {++new ++}for all")).toBe(false);
    expect(refused("Plan {++new ++}for", "Plan")).toBe(false);
    expect(refused("Plan", "Plan {++new ++}")).toBe(true);
    expect(refused("{--next --}", "{--next --}{--week--}")).toBe(true);
    expect(refused("week", "week++}")).toBe(true);
    expect(refused("", "plain text")).toBe(false);
  });
});

describe("Markdown write canonicalization", () => {
  it("matches the document rendering for nested link formatting", () => {
    let tab = buildTab([{ runs: [{
      text: "x",
      style: { bold: true, link: { url: "https://e.com" } },
    }, "\n"] }]);

    expect(canonicalizeMarkdownForWrite("**[x](https://e.com)**")).toBe(
      docTabToMarkdown(tab).markdown.trimEnd(),
    );
  });
  it("escapes opening brackets while canonicalizing link labels", () => {
    expect(canonicalizeMarkdownForWrite("[a[b](https://e.com)"))
      .toBe("[a\\[b](https://e.com)");
  });

  it("canonicalizes many unmatched link openers in linear time", () => {
    let markdown = "[".repeat(64_000);
    expect(canonicalizeMarkdownForWrite(markdown)).toBe(markdown);
  }, 2_000);

  it("canonicalizes many formatting spans in linear time", () => {
    let markdown = "**a** ".repeat(2_000);
    expect(canonicalizeMarkdownForWrite(markdown)).toBe(markdown);
  }, 2_000);

  it("rejects excessive inline formatting complexity", () => {
    expect(() => canonicalizeMarkdownForWrite("*x* ".repeat(2_501)))
      .toThrow(/5000-formatting-token complexity limit/);
  });

  it("rejects excessive block complexity", () => {
    expect(() => canonicalizeMarkdownForWrite(`${"x\n".repeat(2_000)}x`))
      .toThrow(/2000-block complexity limit/);
  });

  it("trims densely formatted replacement boundaries in linear time", () => {
    let body = "~~a~~ ".repeat(2_000);
    let oldMarkdown = `**${body}x**`;
    let newMarkdown = `**${body}y**`;

    expect(canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown))
      .toBe(canonicalizeMarkdownForWrite(newMarkdown));
  }, 2_000);

  it.each(["   ", "\t"])("preserves a whitespace-only line", whitespace => {
    expect(canonicalizeMarkdownForWrite(whitespace)).toBe(whitespace);
  });

  it("preserves multiple whitespace-only lines", () => {
    expect(canonicalizeMarkdownForWrite("  \n\t")).toBe("  \n\n\t");
  });

  it("canonicalizes a multiline replacement as one fragment", () => {
    expect(canonicalizeMarkdownReplacement("x", "a\nb")).toBe("a\n\nb");
  });

  it("canonicalizes paragraph boundaries adjacent to unchanged context", () => {
    expect(canonicalizeMarkdownReplacement("A\n\nB", "A\nX\nB"))
      .toBe("A\n\nX\n\nB");
  });

  it("preserves an unchanged separator between provider lists", () => {
    expect(canonicalizeMarkdownReplacement(
      "1. First\n\n4. Fourth",
      "1. First\n\n4. Changed",
    )).toBe("1. First\n\n4. Changed");
  });

  it("separates adjacent list types", () => {
    expect(canonicalizeMarkdownForWrite("- one\n1. two")).toBe("- one\n\n1. two");
  });

  it("spells internal link destinations as a reread does", () => {
    expect(canonicalizeMarkdownForWrite("[x](?tab=%64etails)")).toBe("[x](?tab=details)");
  });

  /** What a paragraph of `text` in `style` reads as once `old` in it is replaced by `next`. */
  function splitEdit(text: string, style: TextStyle, old: string, next: string) {
    let tab = buildTab([{ runs: [{ text, style }, "\n"] }]);
    return docTabToMarkdown(
      applyDocEdit(tab, { type: "replaceText", oldMarkdown: old, newMarkdown: next })).markdown;
  }

  it.each([...INLINE_STYLES, ["bold linked", { bold: true, link: { url: "https://e.com" } }]] as const)(
    "splits a %s run the way a reread renders it", (_name, style: TextStyle) => {
      let reread = docTabToMarkdown(buildTab(["A", "B"].map(text => ({
        runs: [{ text, style }, "\n"],
      }))));

      expect(splitEdit("AB", style, "AB", "A\nB")).toBe(reread.markdown);
    });

  it("keeps untouched text verbatim when splitting a line", () => {
    expect(splitEdit("literal \\* AB", {}, "AB", "A\nB")).toBe("literal \\* A\n\nB\n");
  });

  it("leaves formatting spanning inserted breaks as the write parses it", () => {
    expect(splitEdit("Old", {}, "Old", "**a\nb**")).toBe("**a\n\nb**\n");
  });
});

/** How a replacement of the whole tab by itself and the appended text writes the same append. */
function wholeTabReplacement(markdown: string, appended: string): string {
  return canonicalizeMarkdownReplacement(
    markdown, markdown + (markdown.endsWith("\n") ? "\n" : "\n\n") + appended + "\n");
}

/** A paragraph, a table of four cells and another paragraph. */
function tableBetweenParagraphs(before: string, cell: string): GoogleDocsTab {
  return buildTab([
    { runs: [`${before}\n`] },
    { table: [["Field\n", `${cell}\n`], ["Name\n", "yes\n"]] },
    { runs: ["After\n"] },
  ]);
}

describe("appendText, as a read shows it", () => {
  it.each([
    ["an asterisk in a cell", tableBetweenParagraphs("Before", "Required*"), "*Source: finance.*"],
    [
      "an asterisk before the table",
      tableBetweenParagraphs("Before *", "Required"), "*Source: finance.*",
    ],
    [
      "an unmatched strikethrough marker in a cell",
      tableBetweenParagraphs("Before", "a ~~ b"), "x ~~ y",
    ],
    [
      "an unmatched bracket in a cell",
      tableBetweenParagraphs("Before", "see [1"), "x](https://y.example)",
    ],
  ])("appends without rewriting what is there: %s", (_name, tab, appended) => {
    let { markdown } = docTabToMarkdown(tab);
    expect(canonicalizeMarkdownForWrite(appended)).toBe(appended);
    expect(markdown).toContain("  </tr>\n  <tr>\n    <td><p>Name</p></td>\n");

    expect(docTabToMarkdown(applyDocEdit(tab, { type: "appendText", markdown: appended })).markdown)
      .toBe(`${markdown}\n${appended}\n`);
    // The replacement pairs the tab's unmatched token with the appended one and writes
    // everything from that token on again, as paragraphs.
    expect(wholeTabReplacement(markdown, appended))
      .toContain("  </tr>\n\n  <tr>\n\n    <td><p>Name</p></td>\n\n");
  });
});


describe("Google Docs tables", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Before\n"] },
    { table: [["Owner\n", "Status\n"], ["R&D <ops>\n", "Ready\n"]] },
    { runs: ["After\n"] },
  ]));

  it("renders every cell without inventing a header row", () => {
    expect(snapshot.markdown).toBe(
      "Before\n\n" +
      "<table>\n" +
      "  <tr>\n" +
      "    <td><p>Owner</p></td>\n" +
      "    <td><p>Status</p></td>\n" +
      "  </tr>\n" +
      "  <tr>\n" +
      "    <td><p>R&amp;D &lt;ops&gt;</p></td>\n" +
      "    <td><p>Ready</p></td>\n" +
      "  </tr>\n" +
      "</table>\n\n" +
      "After\n",
    );
  });

  it("preserves each run's link and text styles in cells", () => {
    let linked = {
      text: "Runbook <now>",
      style: {
        bold: true,
        italic: true,
        strikethrough: true,
        link: { url: 'https://example.com/runbook?a=1&team="ops"' },
      },
    };
    let tab = cellTab([{ runs: ["See ", linked, " today\n"] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      'See <a href="https://example.com/runbook?a=1&amp;team=&quot;ops&quot;">' +
      "<strong><em><s>Runbook &lt;now&gt;</s></em></strong></a> today",
    );
  });

  it("preserves internal Docs link destinations in cells", () => {
    let tab = cellTab([{ runs: [
      { text: "Tab", style: { link: { tabId: "details" } } }, " · ",
      { text: "Bookmark", style: { link: {
        bookmark: { id: "bookmark-1", tabId: "details" },
      } } }, " · ",
      { text: "Heading", style: { link: {
        heading: { id: "heading-1", tabId: "details" },
      } } }, " · ",
      { text: "Bookmark legacy", style: { link: { bookmarkId: "bookmark-2" } } }, " · ",
      { text: "Heading legacy", style: { link: { headingId: "heading-2" } } },
      "\n",
    ] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<a href="?tab=details">Tab</a> · ' +
      '<a href="?tab=details#bookmark=bookmark-1">Bookmark</a> · ' +
      '<a href="?tab=details#heading=heading-1">Heading</a> · ' +
      '<a href="#bookmark=bookmark-2">Bookmark legacy</a> · ' +
      '<a href="#heading=heading-2">Heading legacy</a>',
    );
  });

  it("preserves subtitle styling without redundant emphasis", () => {
    let tab = cellTab([{
      runs: ["Release ", { text: "summary", style: { italic: true } }, "\n"],
      namedStyleType: "SUBTITLE",
    }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<td><p><em>Release summary</em></p></td>",
    );
  });

  it("renders visible smart-chip content in cells", () => {
    let tab = cellTab([{ runs: [
      { person: { email: "owner@example.com" } },
      " · ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " · ",
      { date: "Sep 16, 2026" },
      "\n",
    ] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<p>owner@example.com · " +
      '<a href="https://docs.google.com/document/d/plan">Launch plan</a> · Sep 16, 2026</p>',
    );
  });

  it("renders active table link schemes as unlinked text", () => {
    let tab = cellTab([{ runs: [
      { text: "Run", style: { link: { url: "javascript:alert(1)" } } }, "\n",
    ] }]);
    let markdown = docTabToMarkdown(tab).markdown;

    expect(markdown).toContain("<p>Run</p>");
    expect(markdown).not.toContain("javascript:");
  });

  it("preserves internal table links", () => {
    let tab = cellTab([{ runs: [
      { text: "Details", style: { link: { tabId: "details" } } }, "\n",
    ] }]);

    expect(docTabToMarkdown(tab).markdown)
      .toContain('<a href="?tab=details">Details</a>');
  });

  it("renders page auto-text in cells", () => {
    let tab = cellTab([{ runs: [
      { autoText: "PAGE_NUMBER" }, " of ", { autoText: "PAGE_COUNT" }, "\n",
    ] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<p>[Page number] of [Page count]</p>");
  });

  it("defaults an omitted list nesting level to zero", () => {
    let tab = cellTab([{
      runs: ["Step\n"], bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain("<ol><li>Step</li></ol>");
  });

  it("renders a markerless list in a cell without inventing a marker", () => {
    let tab = cellTab([{
      runs: ["Text\n"], bullet: { listId: "markerless" },
    }], {
      markerless: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ul style="list-style-type: none"><li>Text</li></ul>',
    );
  });

  it("renders nested lists semantically with their configured start", () => {
    let tab = cellTab([
      { runs: ["Prepare\n"], bullet: { listId: "L1" } },
      { runs: ["Check\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["Launch\n"], bullet: { listId: "L1" } },
    ], {
      L1: { listProperties: { nestingLevels: [
        { glyphType: "DECIMAL", startNumber: 4 },
        { glyphSymbol: "●" },
      ] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ol start="4"><li>Prepare<ul style="list-style-type: none"><li>● Check</li></ul></li>' +
      "<li>Launch</li></ol>",
    );
  });

  it("restarts nested numbering under each parent", () => {
    let tab = cellTab([
      { runs: ["Parent one\n"], bullet: { listId: "L1" } },
      { runs: ["Child one\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["Parent two\n"], bullet: { listId: "L1" } },
      { runs: ["Child two\n"], bullet: { listId: "L1", nestingLevel: 1 } },
    ], {
      L1: { listProperties: { nestingLevels: [
        { glyphSymbol: "●" },
        { glyphType: "DECIMAL" },
      ] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ul style="list-style-type: none"><li>● Parent one' +
      "<ol><li>Child one</li></ol></li>" +
      "<li>● Parent two<ol><li>Child two</li></ol></li></ul>",
    );
  });

  it("keeps skipped nesting levels", () => {
    let lists = { L1: { listProperties: { nestingLevels: [
      { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" },
    ] } } };
    let skipped = cellTab([
      { runs: ["Top\n"], bullet: { listId: "L1" } },
      { runs: ["Deep\n"], bullet: { listId: "L1", nestingLevel: 2 } },
    ], lists);
    let indented = cellTab([{ runs: ["Start\n"], bullet: { listId: "L1", nestingLevel: 1 } }], lists);

    expect(docTabToMarkdown(skipped).markdown).toContain(
      '<ol><li>Top<ul style="list-style-type: none"><li><ol><li>Deep</li></ol></li></ul></li></ol>',
    );
    expect(docTabToMarkdown(indented).markdown).toContain(
      '<td><ul style="list-style-type: none"><li><ol><li>Start</li></ol></li></ul></td>',
    );
  });

  it("continues an interrupted ordered list in a table cell", () => {
    let tab = cellTab([
      { runs: ["First\n"], bullet: { listId: "L1" } },
      { runs: ["prose\n"] },
      { runs: ["Second\n"], bullet: { listId: "L1" } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<ol><li>First</li></ol>\n" +
      "      <p>prose</p>\n" +
      '      <ol start="2"><li>Second</li></ol>',
    );
  });

  it("preserves a zero start for decimal lists", () => {
    let tab = cellTab([{
      runs: ["Zero\n"], bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 0 }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain('<ol start="0"><li>Zero</li></ol>');
  });

  it("normalizes zero starts for lettered lists", () => {
    let tab = cellTab([{
      runs: ["Alpha\n"], bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{
        glyphType: "UPPER_ALPHA", startNumber: 0,
      }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain('<ol type="A"><li>Alpha</li></ol>');
  });

  it("preserves ordered list glyph styles", () => {
    let tab = buildTab([{ table: [[
      { paragraphs: [{ runs: ["Alpha\n"], bullet: { listId: "alpha" } }] },
      { paragraphs: [{ runs: ["Zero\n"], bullet: { listId: "zero" } }] },
    ]] }], {
      alpha: { listProperties: { nestingLevels: [{ glyphType: "UPPER_ALPHA", startNumber: 3 }] } },
      zero: { listProperties: { nestingLevels: [{ glyphType: "ZERO_DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td><ol type="A" start="3"><li>Alpha</li></ol></td>',
    );
    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td><ol style="list-style-type: decimal-leading-zero"><li>Zero</li></ol></td>',
    );
  });

  it("preserves unordered list glyphs", () => {
    let tab = cellTab([{
      runs: ["Task\n"], bullet: { listId: "checklist" },
    }], {
      checklist: { listProperties: { nestingLevels: [{ glyphSymbol: "☐" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ul style="list-style-type: none"><li>☐ Task</li></ul>',
    );
  });

  it("renders a horizontal rule in a cell as HTML", () => {
    let tab = cellTab([{
      runs: [{ horizontalRule: true }, "\n"],
    }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<td><hr></td>");
  });

  it("renders a table of contents placeholder in a cell", () => {
    let tab = cellTab([{ runs: ["placeholder\n"] }]);
    let cell = tab.body.content[1].table!.tableRows![0].tableCells![0];
    let element = cell.content![0];
    cell.content = [{
      startIndex: element.startIndex,
      endIndex: element.endIndex,
      tableOfContents: {},
    }];

    expect(docTabToMarkdown(tab).markdown).toContain("<td>[Table of contents]</td>");
  });

  it("renders a footnote's visible number", () => {
    let tab = cellTab([{ runs: [
      "See ", { footnote: { id: "fn-7", number: "7" } }, "\n",
    ] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<p>See [7]</p>");
  });

  it("renders manual line breaks in cells", () => {
    let tab = cellTab([{ runs: ["before\u000bafter\n"] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<p>before<br>after</p>");
  });

  it("marks omitted structured cell content", () => {
    let tab = cellTab([{ runs: [
      "Before ", { richLink: { title: "placeholder", uri: "https://example.com" } }, " after\n",
    ] }]);
    let element = tab.body.content[1].table!.tableRows![0].tableCells![0]
      .content![0].paragraph!.elements[1];
    delete element.richLink;
    Object.assign(element, { inlineObjectElement: { inlineObjectId: "image-1" } });

    expect(docTabToMarkdown(tab).markdown).toContain("<p>Before [Image] after</p>");
  });

  it("marks positioned images in body and table paragraphs", () => {
    let bodyTab = buildTab([{ runs: ["Caption\n"] }]);
    bodyTab.body.content[1].paragraph!.positionedObjectIds = ["image-1"];
    let tableTab = cellTab([{ runs: ["\n"] }]);
    let tableParagraph = tableTab.body.content[1].table!.tableRows![0].tableCells![0]
      .content![0].paragraph!;
    tableParagraph.positionedObjectIds = ["image-1", "image-2"];

    expect(docTabToMarkdown(bodyTab).markdown).toBe("[Image] Caption\n");
    expect(docTabToMarkdown(tableTab).markdown).toContain("<p>[Image] [Image]</p>");

    let bodySnapshot = docTabToMarkdown(bodyTab);
    expect(() => computeReplaceOperations(
      bodySnapshot.sourceMap, bodySnapshot.markdown, 8, 15, "Label", TAB_ID,
    )).toThrow("structured content cannot be edited");
  });

  it("protects text runs containing embedded content placeholders", () => {
    let tab = buildTab([{ runs: ["A\uE907B\n"] }]);
    let embeddedSnapshot = docTabToMarkdown(tab);

    expect(embeddedSnapshot.sourceMap.protectedRanges).toEqual([{ mdStart: 0, mdEnd: 4 }]);
    expect(() => computeReplaceOperations(
      embeddedSnapshot.sourceMap, embeddedSnapshot.markdown, 0, 3, "# A\uE907B", TAB_ID,
    )).toThrow("structured content cannot be edited");
  });

  it("preserves merged-cell spans", () => {
    let tab = buildTab([{ table: [[{
      paragraphs: [{ runs: ["Merged\n"] }],
      tableCellStyle: { rowSpan: 2, columnSpan: 2 },
    }], []] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td rowspan="2" colspan="2"><p>Merged</p></td>',
    );
  });

  it("separates multiple paragraphs within a cell", () => {
    let tab = cellTab([{ runs: ["First\n"] }, { runs: ["Second\n"] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<td>\n      <p>First</p>\n      <p>Second</p>\n    </td>",
    );
  });

  it("keeps text beside a horizontal rule within a cell", () => {
    let tab = cellTab([{ runs: ["Before ", { horizontalRule: true }, " after\n"] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<td><p>Before <hr> after</p></td>");
  });

  it("preserves headings, lists, and blank paragraphs within a cell", () => {
    let tab = cellTab([
      { runs: ["Heading\n"], namedStyleType: "HEADING_2" },
      { runs: ["First\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["Second\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["\n"] },
      { runs: ["Step\n"], bullet: { listId: "L2", nestingLevel: 0 } },
    ], {
      ...BULLET_LIST,
      L2: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<h2>Heading</h2>\n" +
      '      <ul style="list-style-type: none"><li>● First</li><li>● Second</li></ul>\n' +
      "      <p></p>\n" +
      "      <ol><li>Step</li></ol>",
    );
  });
  it("preserves heading semantics on list items", () => {
    let tab = cellTab([{
      runs: ["Section\n"],
      namedStyleType: "HEADING_2",
      bullet: { listId: "L1" },
    }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<ol><li><h2>Section</h2></li></ol>",
    );
  });


  it("refuses an edit spanning table structure", () => {
    expect(() => computeReplaceOperations(
      snapshot.sourceMap,
      snapshot.markdown,
      0,
      snapshot.markdown.trimEnd().length,
      "Updated",
      TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("refuses an edit within a table cell", () => {
    let start = snapshot.markdown.indexOf("Owner");

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + "Owner".length, "Lead", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("protects the separators around a table", () => {
    let tableStart = snapshot.markdown.indexOf("<table>");
    let tableEnd = snapshot.markdown.indexOf("</table>") + "</table>".length;

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, tableStart, "Updated", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, tableEnd, snapshot.markdown.length,
      "\nUpdated\n", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("maps edits after a table to document coordinates", () => {
    let start = snapshot.markdown.lastIndexOf("After");

    expect(computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + "After".length, "Later", TAB_ID,
    ).requests).toEqual([
      { deleteContentRange: { range: { startIndex: 45, endIndex: 47, tabId: TAB_ID } } },
      { insertText: { location: { index: 45, tabId: TAB_ID }, text: "La" } },
      {
        updateTextStyle: {
          range: { startIndex: 45, endIndex: 47, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
    ]);
  });
});

/** A table of a fixture's body, by its position among the body's elements. */
function fixtureTable(tab: GoogleDocsTab, element: number): Table {
  let table = tab.body.content[element]?.table;
  if (!table) throw new Error(`Element ${element} of the fixture is not a table`);
  return table;
}

function fixtureCell(tab: GoogleDocsTab, element: number, row: number, column: number): TableCell {
  let cell = fixtureTable(tab, element).tableRows?.[row]?.tableCells?.[column];
  if (!cell) throw new Error(`The fixture's table has no cell ${row}, ${column}`);
  return cell;
}

function fixtureParagraph(cell: TableCell, index = 0): Paragraph {
  let paragraph = cell.content?.[index]?.paragraph;
  if (!paragraph) throw new Error(`Element ${index} of the fixture's cell is not a paragraph`);
  return paragraph;
}

/** Turn one element of a paragraph into an inline image, which the fixture has no part for. */
function makeInlineImage(paragraph: Paragraph, element: number): void {
  let part = paragraph.elements[element];
  delete part.richLink;
  part.inlineObjectElement = { inlineObjectId: "image-1" };
}

/**
 * The lines of every top-level cell of a table in the Markdown, row by row. A cell's own lines are
 * indented four spaces and a nested table's further, so the indentation tells them apart.
 */
function cellBlocks(markdown: string, table: MarkdownRange): MarkdownRange[][] {
  let rows: MarkdownRange[][] = [];
  let open: MarkdownRange | undefined;
  let offset = table.mdStart;
  for (let line of markdown.slice(table.mdStart, table.mdEnd).split("\n")) {
    if (line.startsWith("    <td") || line === "  </tr>") {
      if (open) open.mdEnd = offset;
      open = undefined;
    }
    if (/^  <tr[ >]/.test(line)) rows.push([]);
    if (line.startsWith("    <td")) {
      open = { mdStart: offset, mdEnd: offset };
      rows[rows.length - 1].push(open);
    }
    offset += line.length + 1;
  }
  return rows;
}

type MappedText = {
  row: number;
  column: number;
  /** Where the text starts in the Markdown. */
  mdStart: number;
  /** The Markdown the text's range names. */
  html: string;
  /** The start index the map gives for the text's paragraph. */
  paragraph: number;
};

/** Every editable text the map lists for a table. */
function mappedTexts(snapshot: DocTabSnapshot, index = 0): MappedText[] {
  return snapshot.sourceMap.tables[index].rows.flatMap((row, rowIndex) =>
    row.cells.flatMap((cell, column) => cell.texts.map(text => ({
      row: rowIndex, column,
      mdStart: text.mdStart,
      html: snapshot.markdown.slice(text.mdStart, text.mdEnd),
      paragraph: text.docStart,
    }))));
}

/** The Markdown a range of the map names. */
const sliceOf = (snapshot: DocTabSnapshot, range: MarkdownRange): string =>
  snapshot.markdown.slice(range.mdStart, range.mdEnd);

/**
 * Hold a table's map to its HTML: its rows tile the HTML between the table's opening lines and
 * `</table>`, each row's cells tile the row between its `<tr>` line and `</tr>`, every cell is
 * the block of lines `cellBlocks` finds for it, and every text lies inside its cell, after the
 * text before it.
 */
function expectMapTilesTable(snapshot: DocTabSnapshot, table: TableMapping): void {
  let html = sliceOf(snapshot, table);
  let blocks = cellBlocks(snapshot.markdown, table);
  let opening = /^<table[^>]*>\n(?:  <colgroup>.*<\/colgroup>\n)?/.exec(html)?.[0] ?? "";
  let next = table.mdStart + opening.length;
  expect(opening).not.toBe("");
  expect(table.rows.map(row => row.cells.length)).toEqual(blocks.map(row => row.length));
  for (let [rowIndex, row] of table.rows.entries()) {
    let block = sliceOf(snapshot, row);
    let rowOpening = /^  <tr[^>]*>\n/.exec(block)?.[0] ?? "";
    expect(row.mdStart).toBe(next);
    expect(rowOpening).not.toBe("");
    expect(block.endsWith("  </tr>\n")).toBe(true);
    next = row.mdStart + rowOpening.length;
    for (let [column, cell] of row.cells.entries()) {
      let { mdStart, mdEnd } = blocks[rowIndex][column];
      expect([cell.mdStart, cell.mdEnd]).toEqual([next, mdEnd]);
      expect(cell.mdStart).toBe(mdStart);
      expect(sliceOf(snapshot, cell)).toMatch(/^    <td[ >][^]*<\/td>\n$/);
      let cursor = cell.mdStart;
      for (let text of cell.texts) {
        expect(text.mdStart).toBeGreaterThan(cursor);
        expect(text.mdEnd).toBeGreaterThanOrEqual(text.mdStart);
        expect(text.mdEnd).toBeLessThan(cell.mdEnd);
        cursor = text.mdEnd;
      }
      next = cell.mdEnd;
    }
    expect(row.mdEnd).toBe(next + "  </tr>\n".length);
    next = row.mdEnd;
  }
  expect(table.mdEnd).toBe(next + "</table>".length);
}

/** The start index of every paragraph in a fixture table's cells, in document order. */
function fixtureParagraphStarts(table: Table): number[] {
  return (table.tableRows ?? []).flatMap(row => (row.tableCells ?? []).flatMap(cell =>
    (cell.content ?? []).flatMap(element => element.paragraph ? [element.startIndex] : [])));
}

/** Where the map puts a row, its cells and their texts' paragraphs in the tab's index space. */
function rowIndexes(table: TableMapping, row: number): {
  docStart: number;
  docEnd: number;
  cells: { docStart: number; paragraphs: number[] }[];
} {
  let { docStart, docEnd, cells } = table.rows[row];
  return {
    docStart, docEnd,
    cells: cells.map(cell => ({
      docStart: cell.docStart, paragraphs: cell.texts.map(text => text.docStart),
    })),
  };
}

/** The map of a tab's first table. */
function firstTableMap(tab: GoogleDocsTab): TableMapping {
  return docTabToMarkdown(tab).sourceMap.tables[0];
}

/** What the map says of the cells of the first row of a tab's first table. */
function firstRowCells(tab: GoogleDocsTab): TableCellMapping[] {
  return firstTableMap(tab).rows[0].cells;
}

/** A cell holding one item of list `listId`. */
function listItemCell(listId: string) {
  return { paragraphs: [{ runs: ["Item\n"], bullet: { listId } }] };
}

/** A cell holding one paragraph of the given named style. */
function styledCell(namedStyleType: string) {
  return { paragraphs: [{ runs: ["Text\n"], namedStyleType }] };
}

/** Where each table's HTML is in a rendering: its start and its end. */
function tableRanges({ sourceMap }: DocTabSnapshot): number[][] {
  return sourceMap.tables.map(({ mdStart, mdEnd }) => [mdStart, mdEnd]);
}

/** The HTML each table's range names in a rendering. */
function tableHtmls({ markdown, sourceMap }: DocTabSnapshot): string[] {
  return sourceMap.tables.map(table => markdown.slice(table.mdStart, table.mdEnd));
}

/** The elements the table HTML writes around text in each of `INLINE_STYLES`. */
const INLINE_HTML: Record<string, (html: string) => string> = {
  plain: html => html,
  bold: html => `<strong>${html}</strong>`,
  italic: html => `<em>${html}</em>`,
  "bold italic": html => `<strong><em>${html}</em></strong>`,
  strikethrough: html => `<s>${html}</s>`,
  linked: html => `<a href="https://e.com">${html}</a>`,
};

/** A range of tab `t`, which the request tests write into. */
function tabRange(startIndex: number, endIndex: number) {
  return { startIndex, endIndex, tabId: "t" };
}

/** The requests `plainTextToDocRequests` adds for `text` at index 12 of tab `t`. */
function plainTextRequests(text: string, keepParagraphStyle?: boolean): GoogleDocsRequest[] {
  let requests: GoogleDocsRequest[] = [];
  plainTextToDocRequests(text, 12, "t", requests, keepParagraphStyle);
  return requests;
}

/** The one cell of a `cellTab` rendering, without the indentation of its first line. */
function singleCellHtml(tab: GoogleDocsTab): string {
  let snapshot = docTabToMarkdown(tab);
  let [[cell]] = cellBlocks(snapshot.markdown, snapshot.sourceMap.tables[0]);
  return snapshot.markdown.slice(cell.mdStart, cell.mdEnd).trim();
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Google Docs table map", () => {
  const PERSON = { person: { email: "owner@example.com" } };
  const RICH_LINK = { richLink: { title: "Plan", uri: "https://example.com/plan" } };
  const NUMBERED_LIST = { listProperties: { nestingLevels: [
    { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" },
  ] } };
  const THREE_LEVEL_LIST = { listProperties: { nestingLevels: [
    { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }, { glyphType: "DECIMAL" },
  ] } };
  // What a cell's list writes for each level its first item skips: an item with no marker.
  const SKIPPED_LEVEL = '<ul style="list-style-type: none"><li>';

  it("maps each top-level table to its HTML and its indexes", () => {
    let tab = buildTab([
      { runs: ["Before\n"] },
      { runs: ["\n"] },
      { table: [["r0c0\n", "r0c1\n"], ["r1c0\n", "r1c1\n"]] },
      { runs: ["After\n"] },
    ]);
    let snapshot = docTabToMarkdown(tab);
    let element = tab.body.content[3];
    let { tables } = snapshot.sourceMap;
    let table = tables[0];
    let html = snapshot.markdown.slice(table.mdStart, table.mdEnd);

    expect(tables).toHaveLength(1);
    expect(html.startsWith("<table>\n  <tr>\n")).toBe(true);
    expect(html.endsWith("  </tr>\n</table>")).toBe(true);
    expect(snapshot.markdown.slice(table.mdStart - 2, table.mdEnd + 2)).toBe(`\n\n${html}\n\n`);
    expect([table.docStart, table.docEnd]).toEqual([9, 37]);
    expect([table.docStart, table.docEnd]).toEqual([element.startIndex, element.endIndex]);
    expectMapTilesTable(snapshot, table);
    expect(table.rows.map(row => sliceOf(snapshot, row))).toEqual([
      "  <tr>\n    <td><p>r0c0</p></td>\n    <td><p>r0c1</p></td>\n  </tr>\n",
      "  <tr>\n    <td><p>r1c0</p></td>\n    <td><p>r1c1</p></td>\n  </tr>\n",
    ]);
    expect(table.rows[1].cells.map(cell => sliceOf(snapshot, cell)))
      .toEqual(["    <td><p>r1c0</p></td>\n", "    <td><p>r1c1</p></td>\n"]);
    expect(mappedTexts(snapshot).map(text => text.html)).toEqual(["r0c0", "r0c1", "r1c0", "r1c1"]);
    expect("suggested" in table).toBe(false);
    expect("pinnedRows" in table).toBe(false);
    expect(rowIndexes(table, 0)).toEqual({
      docStart: 10,
      docEnd: 23,
      cells: [
        { docStart: 11, paragraphs: [12] },
        { docStart: 17, paragraphs: [18] },
      ],
    });
  });

  it("maps a cell's text to the paragraph it came from", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { table: [
      [
        "One\n",
        { paragraphs: [
          { runs: ["First\n"] }, { runs: ["\n"] }, { runs: ["R&D <ops>\u000bnext\n"] },
        ] },
      ],
      [
        { paragraphs: [{ runs: ["Heading\n"], namedStyleType: "HEADING_2" }] },
        { paragraphs: [{ runs: ["Dot\n"], bullet: { listId: "L1" } }] },
      ],
      [
        { paragraphs: [
          { runs: ["Step\n"], bullet: { listId: "numbered" } },
          { runs: ["Sub\n"], bullet: { listId: "numbered", nestingLevel: 1 } },
          { runs: ["Next\n"], bullet: { listId: "numbered" } },
        ] },
        { paragraphs: [{
          runs: ["Section\n"], namedStyleType: "HEADING_3", bullet: { listId: "L1" },
        }] },
      ],
      [
        // A list whose first item starts below the top level, in a cell of one line and in a
        // cell of several: markerless items wrap it, one for each level it skips.
        { paragraphs: [{ runs: ["Deep\n"], bullet: { listId: "deep", nestingLevel: 2 } }] },
        { paragraphs: [
          { runs: ["Intro\n"] },
          { runs: ["Inner\n"], bullet: { listId: "inner", nestingLevel: 1 } },
        ] },
      ],
      [
        // An item two levels below its parent, and one that starts with its bullet character
        // one level down.
        { paragraphs: [
          { runs: ["Top\n"], bullet: { listId: "skipping" } },
          { runs: ["Low\n"], bullet: { listId: "skipping", nestingLevel: 2 } },
        ] },
        { paragraphs: [{ runs: ["Mark\n"], bullet: { listId: "marked", nestingLevel: 1 } }] },
      ],
    ] }, { runs: ["After\n"] }], {
      ...BULLET_LIST,
      numbered: NUMBERED_LIST,
      deep: THREE_LEVEL_LIST,
      inner: THREE_LEVEL_LIST,
      skipping: THREE_LEVEL_LIST,
      marked: { listProperties: { nestingLevels: [
        { glyphSymbol: "●" }, { glyphSymbol: "○" },
      ] } },
    });
    let snapshot = docTabToMarkdown(tab);
    let texts = mappedTexts(snapshot);
    let around = (text: MappedText, before: number, after: number) =>
      snapshot.markdown.slice(text.mdStart - before, text.mdStart + text.html.length + after);
    // The line of the Markdown a text stands in: what comes before the text, the text, the rest.
    let inLine = (text: MappedText) => {
      let start = snapshot.markdown.lastIndexOf("\n", text.mdStart - 1) + 1;
      let end = text.mdStart + text.html.length;
      return [
        snapshot.markdown.slice(start, text.mdStart), text.html,
        snapshot.markdown.slice(end, snapshot.markdown.indexOf("\n", end)),
      ];
    };

    expect(snapshot.markdown).toContain(
      "    <td>\n" +
      "      <p>First</p>\n" +
      "      <p></p>\n" +
      "      <p>R&amp;D &lt;ops&gt;<br>next</p>\n" +
      "    </td>\n");
    expect(texts.map(text => [text.row, text.column, text.html])).toEqual([
      [0, 0, "One"],
      [0, 1, "First"],
      [0, 1, ""],
      [0, 1, "R&amp;D &lt;ops&gt;<br>next"],
      [1, 0, "Heading"],
      [1, 1, "Dot"],
      [2, 0, "Step"],
      [2, 0, "Sub"],
      [2, 0, "Next"],
      [2, 1, "Section"],
      [3, 0, "Deep"],
      [3, 1, "Intro"],
      [3, 1, "Inner"],
      [4, 0, "Top"],
      [4, 0, "Low"],
      [4, 1, "Mark"],
    ]);
    expect(texts.map(text => text.paragraph)).toEqual(fixtureParagraphStarts(fixtureTable(tab, 2)));
    // An empty text's range sits inside its paragraph's tags.
    expect(around(texts[2], 3, 4)).toBe("<p></p>");
    expect(around(texts[5], 6, 5)).toBe("<li>● Dot</li>");

    expect(inLine(texts[10])).toEqual([
      `    <td>${SKIPPED_LEVEL}${SKIPPED_LEVEL}<ol><li>`, "Deep",
      "</li></ol></li></ul></li></ul></td>",
    ]);
    expect(inLine(texts[11])).toEqual(["      <p>", "Intro", "</p>"]);
    expect(inLine(texts[12])).toEqual([
      `      ${SKIPPED_LEVEL}<ol><li>`, "Inner", "</li></ol></li></ul>",
    ]);
    expect(inLine(texts[15])).toEqual([
      `    <td>${SKIPPED_LEVEL}<ul style="list-style-type: none"><li>○ `, "Mark",
      "</li></ul></li></ul></td>",
    ]);
  });

  it("counts every line of a cell, also those a chip's text breaks", () => {
    let snapshot = docTabToMarkdown(cellTab([
      { runs: [{ person: { name: "Ada\nLovelace", email: "ada@example.com" } }, "\n"] },
      { runs: ["Plain\n"] },
      { runs: ["Last\n"] },
    ]));

    expect(snapshot.markdown).toContain(
      "    <td>\n" +
      "      <p>Ada\n" +
      "      Lovelace</p>\n" +
      "      <p>Plain</p>\n" +
      "      <p>Last</p>\n" +
      "    </td>\n");
    expect(mappedTexts(snapshot).map(text => text.html)).toEqual(["Plain", "Last"]);
  });

  it("lists no text for cells it cannot edit, and a merged cell's own text", () => {
    let tab = buildTab([{ table: [
      [
        { paragraphs: [{ runs: ["Merged\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 2 } },
        "covered beside\n",
        "free\n",
      ],
      ["covered below\n", "covered across\n", "free too\n"],
      [
        { paragraphs: [{ runs: ["Outer\n"] }, { table: [["inner\n"]] }, { runs: ["\n"] }] },
        "contents\n",
        { paragraphs: [{ runs: ["Owner: ", PERSON, "\n"] }] },
      ],
      [
        { paragraphs: [{ runs: ["Figure ", RICH_LINK, "\n"] }] },
        "positioned\n",
        { paragraphs: [{ runs: ["Above ", { horizontalRule: true }, " below\n"] }] },
      ],
      [
        "A\uE907B\n",
        { paragraphs: [{ runs: ["Summary\n"], namedStyleType: "SUBTITLE" }] },
        { paragraphs: [{ runs: [PERSON, "\n"] }, { runs: ["Plain\n"] }] },
      ],
    ] }]);
    let contents = fixtureCell(tab, 1, 2, 1);
    contents.content = [{
      startIndex: contents.startIndex + 1, endIndex: contents.endIndex, tableOfContents: {},
    }];
    makeInlineImage(fixtureParagraph(fixtureCell(tab, 1, 3, 0)), 1);
    fixtureParagraph(fixtureCell(tab, 1, 3, 1)).positionedObjectIds = ["image-1"];
    let snapshot = docTabToMarkdown(tab);
    let table = snapshot.sourceMap.tables[0];

    expect(snapshot.markdown).toContain('<td rowspan="2" colspan="2"><p>Merged</p></td>');
    expect(snapshot.markdown).toContain("<td>[Table of contents]</td>");
    expect(snapshot.markdown).toContain("<td><p>Figure [Image]</p></td>");
    expect(snapshot.markdown).toContain("<td><p>[Image] positioned</p></td>");
    expect(snapshot.markdown).toContain("<td><p><em>Summary</em></p></td>");
    expect(table.rows.map(row => row.cells.map(cell => cell.texts.length)))
      .toEqual([[1, 0, 1], [0, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 1]]);
    expect(mappedTexts(snapshot).map(text => text.html))
      .toEqual(["Merged", "free", "free too", "Plain"]);
    expect(mappedTexts(snapshot).map(text => text.paragraph)).toEqual([
      fixtureCell(tab, 1, 0, 0).startIndex + 1,
      fixtureCell(tab, 1, 0, 2).startIndex + 1,
      fixtureCell(tab, 1, 1, 2).startIndex + 1,
      fixtureCell(tab, 1, 4, 2).endIndex - "Plain\n".length,
    ]);
  });

  it("reads a missing span as one, and a merged cell's reach from its spans", () => {
    let tab = buildTab([{ table: [
      [{ paragraphs: [{ runs: ["wide\n"] }], tableCellStyle: { columnSpan: 2 } }, "\n", "a\n"],
      [{ paragraphs: [{ runs: ["tall\n"] }], tableCellStyle: { rowSpan: 2 } }, "b\n", "c\n"],
      ["\n", "d\n", "e\n"],
      ["f\n", "g\n", "h\n"],
    ] }]);

    expect(mappedTexts(docTabToMarkdown(tab)).map(text => text.html))
      .toEqual(["wide", "a", "tall", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("keeps a paragraph editable whose text Google would strip from an insert", () => {
    let snapshot = docTabToMarkdown(buildTab([{ table: [["\uF0B7 item\n", "a\u0001b\n"]] }]));

    expect(mappedTexts(snapshot).map(text => text.html)).toEqual(["\uF0B7 item", "a\u0001b"]);
  });

  it("maps only top-level tables", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { table: [[{ paragraphs: [
        { runs: ["\n"] }, { table: [["inner\n"]] }, { runs: ["\n"] },
      ] }, "first\n"]] },
      { runs: ["Between\n"] },
      { table: [["second\n"]] },
      { runs: ["After\n"] },
    ]));
    let { tables } = snapshot.sourceMap;

    expect(snapshot.markdown).toContain("      <table>\n        <tr>\n          <td><p>inner</p></td>");
    expect(tables).toHaveLength(2);
    expect(tables[0].mdEnd).toBeLessThan(tables[1].mdStart);
    expect(mappedTexts(snapshot, 0).map(text => text.html)).toEqual(["first"]);
    expect(mappedTexts(snapshot, 1).map(text => text.html)).toEqual(["second"]);
    expect(snapshot.markdown.slice(tables[1].mdStart, tables[1].mdEnd)).toBe(
      "<table>\n  <tr>\n    <td><p>second</p></td>\n  </tr>\n</table>");
  });

  it("maps a table at either end of a tab, and one with no rows or no cells", () => {
    let ends = docTabToMarkdown(buildTab([{ table: [["first\n"]] }, { table: [["last\n"]] }]));
    let empty = buildTab([{ runs: ["Before\n"] }, { table: [["gone\n"]] }, { table: [["a\n"]] }]);
    delete fixtureTable(empty, 2).tableRows;
    delete (fixtureTable(empty, 3).tableRows ?? [])[0].tableCells;
    let emptySnapshot = docTabToMarkdown(empty);
    let emptied = emptySnapshot.sourceMap.tables;
    let [emptyRow] = fixtureTable(empty, 3).tableRows ?? [];

    expect(ends.markdown.startsWith("<table>\n")).toBe(true);
    expect(ends.markdown.endsWith("</table>\n")).toBe(true);
    expect(ends.sourceMap.tables.map(table => table.mdStart)).toEqual([
      0, ends.markdown.lastIndexOf("<table>"),
    ]);
    expect(mappedTexts(ends, 0).concat(mappedTexts(ends, 1)).map(text => text.html))
      .toEqual(["first", "last"]);
    expect(emptied.map(table => sliceOf(emptySnapshot, table)))
      .toEqual(["<table>\n</table>", "<table>\n  <tr>\n  </tr>\n</table>"]);
    for (let table of emptied) expectMapTilesTable(emptySnapshot, table);
    expect(emptied[0].rows).toEqual([]);
    expect(emptied[1].rows.map(row => sliceOf(emptySnapshot, row))).toEqual(["  <tr>\n  </tr>\n"]);
    expect(emptyRow.startIndex).toBe(18);
    expect(rowIndexes(emptied[1], 0))
      .toEqual({ docStart: emptyRow.startIndex, docEnd: emptyRow.endIndex, cells: [] });
  });

  it("drops an unsafe link, and writes a rule, a subtitle and chips in a cell", () => {
    let bold = { bold: true };

    expect(singleCellHtml(cellTab([{ runs: [
      { text: "Run", style: { link: { url: "javascript:alert(1)" } } }, " now\n",
    ] }]))).toBe("<td><p>Run now</p></td>");
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "a", style: bold }, { horizontalRule: true }, { text: "b", style: bold }, "\n",
    ] }]))).toBe("<td><p><strong>a</strong><hr><strong>b</strong></p></td>");
    expect(singleCellHtml(cellTab([{
      runs: ["Release ", "summary ", { text: "notes", style: { italic: true } }, "\n"],
      namedStyleType: "SUBTITLE",
    }]))).toBe("<td><p><em>Release summary notes</em></p></td>");
    expect(singleCellHtml(cellTab([{ runs: [PERSON, " and ", { date: "Sep 16, 2026" }, "\n"] }])))
      .toBe("<td><p>owner@example.com and Sep 16, 2026</p></td>");
  });

  it("writes a text-only cell paragraph's runs, those formatted alike in one element", () => {
    for (let [first, firstStyle] of INLINE_STYLES) {
      for (let [second, secondStyle] of INLINE_STYLES) {
        let snapshot = docTabToMarkdown(cellTab([{ runs: [
          { text: "A<", style: firstStyle }, { text: "&\u000bB", style: secondStyle },
          { text: "C", style: secondStyle }, "\n",
        ] }]));

        expect([first, second, mappedTexts(snapshot).map(text => text.html)]).toEqual([
          first, second,
          [first === second
            ? INLINE_HTML[first]("A&lt;&amp;<br>BC")
            : INLINE_HTML[first]("A&lt;") + INLINE_HTML[second]("&amp;<br>BC")],
        ]);
      }
    }
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "", style: { bold: true } }, { text: "a", style: { bold: true } },
      { text: "", style: { italic: true } }, { text: "b<", style: { bold: true, italic: false } },
      { text: "c", style: { link: { url: "https://e.com/?a=1&b=\"2\"" } } },
      {
        text: "d\u000be",
        style: { strikethrough: true, italic: true, bold: true, link: { tabId: "t.1" } },
      },
      "\n",
    ] }]))).toBe(
      "<td><p><strong>ab&lt;</strong>" +
      '<a href="https://e.com/?a=1&amp;b=&quot;2&quot;">c</a>' +
      '<a href="?tab=t.1"><strong><em><s>d<br>e</s></em></strong></a></p></td>');
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "old", style: { strikethrough: true } }, " new ",
      { text: "kept", style: { strikethrough: false } },
      { text: " gone", style: { strikethrough: true } },
      { text: " too", style: { strikethrough: true } }, "\n",
    ] }]))).toBe("<td><p><s>old</s> new kept<s> gone too</s></p></td>");
    expect(singleCellHtml(cellTab([{ runs: ["\n"] }]))).toBe("<td><p></p></td>");
  });

  it("says what each cell's HTML shows: its spans, its lines and its texts", () => {
    const title = { runs: ["Title\n"], namedStyleType: "TITLE" };
    let tab = buildTab([{ table: [
      [
        "one\n",
        { paragraphs: [{ runs: ["head\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 2 } },
        "\n",
      ],
      [
        { paragraphs: [title, { runs: ["\n"] }, { runs: ["last\n"] }] },
        "covered\n",
        { paragraphs: [{ runs: ["x\n"] }, { table: [["in\n"]] }, { runs: ["\n"] }] },
      ],
    ] }]);
    let snapshot = docTabToMarkdown(tab);
    let [table] = snapshot.sourceMap.tables;
    let shown = table.rows.map(row => row.cells.map(cell => ({
      html: sliceOf(snapshot, cell).split("\n")[0].trim(),
      spans: [cell.rowSpan, cell.columnSpan], nested: cell.nested,
      lines: cell.lines, emptyParagraph: cell.emptyParagraph,
      texts: cell.texts.map(text => [sliceOf(snapshot, text), text.docStart]),
    })));
    let paragraph = (row: number, column: number, index = 0) =>
      (fixtureCell(tab, 1, row, column).content ?? [])[index].startIndex;

    expectMapTilesTable(snapshot, table);
    expect(shown).toEqual([
      [
        {
          html: "<td><p>one</p></td>", spans: [1, 1], nested: false, lines: 1,
          emptyParagraph: false, texts: [["one", paragraph(0, 0)]],
        },
        {
          html: '<td rowspan="2" colspan="2"><p>head</p></td>', spans: [2, 2], nested: false,
          lines: 1, emptyParagraph: false, texts: [["head", paragraph(0, 1)]],
        },
        // A cell that a merged cell covers lists no text.
        {
          html: "<td><p></p></td>", spans: [1, 1], nested: false, lines: 1,
          emptyParagraph: true, texts: [],
        },
      ],
      [
        {
          html: "<td>", spans: [1, 1], nested: false, lines: 3, emptyParagraph: true,
          texts: [
            ["Title", paragraph(1, 0)], ["", paragraph(1, 0, 1)], ["last", paragraph(1, 0, 2)],
          ],
        },
        {
          html: "<td><p>covered</p></td>", spans: [1, 1], nested: false, lines: 1,
          emptyParagraph: false, texts: [],
        },
        // A cell that holds a table lists no text, and its lines count the table's.
        { html: "<td>", spans: [1, 1], nested: true, lines: 7, emptyParagraph: true, texts: [] },
      ],
    ]);
    expect(sliceOf(snapshot, table.rows[1].cells[0]))
      .toBe("    <td>\n      <h1>Title</h1>\n      <p></p>\n      <p>last</p>\n    </td>\n");
  });

  it("marks the cells that hold an item of a list that numbers a level", () => {
    let cells = firstRowCells(buildTab([{ table: [[
      listItemCell("numbered"),
      listItemCell("mixed"),
      { paragraphs: [
        { runs: ["\n"] }, { table: [[listItemCell("numbered")]] }, { runs: ["\n"] },
      ] },
      listItemCell("L1"),
      listItemCell("missing"),
      listItemCell("markerless"),
      "Plain\n",
    ]] }], {
      ...BULLET_LIST,
      numbered: NUMBERED_LIST,
      mixed: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }, { glyphType: "ALPHA" }] } },
      markerless: { listProperties: { nestingLevels: [
        { glyphType: "NONE" }, { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
      ] } },
    }));

    expect(cells.map(cell => cell.numbered))
      .toEqual([true, true, true, false, false, false, false]);
  });

  it("marks the cells that hold a footnote", () => {
    let footnote = { footnote: { id: "fn-1", number: "1" } };
    let snapshot = docTabToMarkdown(buildTab([{ table: [[
      { paragraphs: [{ runs: ["See ", footnote, "\n"] }] },
      { paragraphs: [{ runs: ["Plain\n"] }, { runs: [footnote, "\n"] }] },
      { paragraphs: [
        { runs: ["\n"] }, { table: [[{ paragraphs: [{ runs: [footnote, "\n"] }] }]] }, { runs: ["\n"] },
      ] },
      "See [1]\n",
      "\n",
    ]] }]));
    let { cells } = snapshot.sourceMap.tables[0].rows[0];

    expect(cells.map(cell => cell.footnote)).toEqual([true, true, true, false, false]);
    expect(mappedTexts(snapshot).map(text => [text.column, text.html])).toEqual([
      [1, "Plain"], [3, "See [1]"], [4, ""],
    ]);
  });

  it("marks the cells a new neighbour is reset beside", () => {
    let tab = buildTab([{ table: [[
      styledCell("HEADING_2"),
      styledCell("TITLE"),
      styledCell("SUBTITLE"),
      listItemCell("L1"),
      "contents\n",
      "no content\n",
      "Plain\n",
      "\n",
      { paragraphs: [{ runs: ["Plain\n"] }, { runs: ["Heading\n"], namedStyleType: "HEADING_1" }] },
      { paragraphs: [
        { runs: ["Plain\n"] }, { table: [[styledCell("HEADING_1")]] }, { runs: ["\n"] },
      ] },
    ]] }], BULLET_LIST);
    let contents = fixtureCell(tab, 1, 0, 4);
    contents.content = [{
      startIndex: contents.startIndex + 1, endIndex: contents.endIndex, tableOfContents: {},
    }];
    delete fixtureCell(tab, 1, 0, 5).content;

    expect(firstRowCells(tab).map(cell => cell.styled))
      .toEqual([true, true, true, true, true, true, false, false, false, false]);
  });

  it("marks the cells that hold an element the rendering shows nothing for", () => {
    let unnamed = { person: { email: "" } };
    let tab = buildTab([{ table: [[
      { paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] },
      { paragraphs: [{ runs: ["Status: ", { dropdown: "Open" }, "\n"] }] },
      { paragraphs: [{ runs: ["Notes\n"] }, { runs: [{ dropdown: "Open" }, "\n"] }] },
      { paragraphs: [
        { runs: ["\n"] },
        { table: [[{ paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] }]] },
        { runs: ["\n"] },
      ] },
      { paragraphs: [{ runs: [unnamed, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, " and ", { date: "Sep 16, 2026" }, "\n"] }] },
      { paragraphs: [{ runs: [RICH_LINK, { horizontalRule: true }, "\n"] }] },
      "\uE907\n",
      "\n",
      { paragraphs: [{ runs: [RICH_LINK, "\n"] }] },
    ]] }]);
    makeInlineImage(fixtureParagraph(fixtureCell(tab, 1, 0, 9)), 0);

    expect(firstRowCells(tab).map(cell => cell.unshown))
      .toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    // What such a cell reads as: nothing where the element stands.
    let { markdown } = docTabToMarkdown(tab);
    expect(markdown).toContain(
      "  <tr>\n    <td><p></p></td>\n    <td><p>Status: </p></td>\n    <td>\n" +
      "      <p>Notes</p>\n      <p></p>\n    </td>\n");
  });

  it("counts a suggested change to a row's or a cell's style as a suggestion of the table", () => {
    let rows = [["a\n", "b\n"], ["c\n", "d\n"]];
    let plain = buildTab([{ table: rows }]);
    let styled = buildTab([{ table: rows }]);
    fixtureCell(styled, 1, 1, 0).suggestedTableCellStyleChanges = { "suggest.a": {}, "suggest.b": {} };
    (fixtureTable(styled, 1).tableRows ?? [])[0].suggestedTableRowStyleChanges = { "suggest.c": {} };
    // The view shows none of it.
    expect(docTabToMarkdown(styled).markdown).toBe(docTabToMarkdown(plain).markdown);
    expect(firstTableMap(plain).suggested).toBeUndefined();
    expect(firstTableMap(styled).suggested).toBe(3);
  });

  it("counts the suggestions on the text and the paragraphs of its cells as the table's", () => {
    let rows = (cell: CellSpec) => [["a\n", "b\n"], ["c\n", cell]];
    let plain = firstTableMap(buildTab([{ table: rows("d\n") }]));
    let counted = (cell: CellSpec) => firstTableMap(buildTab([{ table: rows(cell) }])).suggested;
    expect(plain.suggested).toBeUndefined();
    expect(counted({ paragraphs: [{ runs: ["d", { text: "new\n", suggested: "insertion" }] }] })).toBe(1);
    expect(counted({ paragraphs: [{ runs: [{ text: "old", suggested: "deletion" }, "\n"] }] })).toBe(1);
    expect(counted({ paragraphs: [{ runs: [{ text: "d\n", suggested: "style" }] }] })).toBe(1);
    expect(counted({ paragraphs: [{ runs: ["d\n"], suggestedChange: "style" }] })).toBe(1);
    expect(counted({
      paragraphs: [
        { runs: [{ text: "d", suggested: "insertion" }, "\n"], suggestedChange: "bullet" },
        { runs: [{ text: "e\n", suggested: "style" }] },
      ],
    })).toBe(3);
  });

  it("marks a table that holds suggestions and counts its pinned rows", () => {
    let rows = [["a\n", "b\n"], ["c\n", "d\n"], ["e\n", "f\n"]];
    let plain = firstTableMap(buildTab([{ table: rows }]));
    let ownFields = (["suggestedInsertionIds", "suggestedDeletionIds"] as const).map(field => {
      let tab = buildTab([{ table: rows }]);
      fixtureTable(tab, 1)[field] = ["s1"];
      return firstTableMap(tab);
    });
    let emptyIds = buildTab([{ table: rows }]);
    Object.assign(fixtureTable(emptyIds, 1), { suggestedInsertionIds: [], suggestedDeletionIds: [] });
    Object.assign(fixtureCell(emptyIds, 1, 0, 0), { suggestedInsertionIds: [] });
    let nested = buildTab([{ table: [[{ paragraphs: [
      { runs: ["\n"] }, { table: rows, suggestedRows: { 0: "deletion" } }, { runs: ["\n"] },
    ] }]] }]);
    let secondRowPinned = buildTab([{ table: rows }]);
    (fixtureTable(secondRowPinned, 1).tableRows ?? [])[1].tableRowStyle = { tableHeader: true };

    expect(firstTableMap(buildTab([{ table: rows, suggestedRows: { 1: "insertion" } }])).suggested)
      .toBeGreaterThan(0);
    expect(firstTableMap(buildTab([{ table: [
      ["a\n", { paragraphs: [{ runs: ["b\n"] }], suggested: "deletion" }],
    ] }])).suggested).toBeGreaterThan(0);
    expect(ownFields.map(table => table.suggested)).toEqual([1, 1]);
    // A table inside a cell: deleting the cell discards what is suggested in it.
    expect(firstTableMap(nested).suggested).toBeGreaterThan(0);
    for (let table of [plain, firstTableMap(emptyIds)]) {
      expect("suggested" in table).toBe(false);
    }

    expect(firstTableMap(buildTab([{ table: rows, headerRows: 2 }])).pinnedRows).toBe(2);
    expect(firstTableMap(buildTab([{ table: rows, headerRows: 3 }])).pinnedRows).toBe(3);
    for (let table of [plain, firstTableMap(secondRowPinned)]) {
      expect("pinnedRows" in table).toBe(false);
    }
  });

  it("moves tables with an edit before them and leaves earlier ones", () => {
    let tab = buildTab([
      { runs: ["Before\n"] },
      { table: [["one\n"]] },
      { runs: ["Middle\n"] },
      { table: [["two\n"]] },
      { runs: ["After\n"] },
    ]);
    let snapshot = docTabToMarkdown(tab);
    let [first, second] = tableRanges(snapshot);
    let edit = (oldMarkdown: string, newMarkdown: string) =>
      docTabToMarkdown(applyDocEdit(tab, { type: "replaceText", oldMarkdown, newMarkdown }));

    let before = edit("Before", "Before and more");
    expect(tableRanges(before)).toEqual([first.map(at => at + 9), second.map(at => at + 9)]);
    expect(tableHtmls(before)).toEqual(tableHtmls(snapshot));

    let between = edit("Middle", "Mid");
    expect(tableRanges(between)).toEqual([first, second.map(at => at - 3)]);
    expect(tableHtmls(between)).toEqual(tableHtmls(snapshot));

    let after = edit("After", "Afterwards");
    expect(tableRanges(after)).toEqual([first, second]);
    expect(tableHtmls(after)).toEqual(tableHtmls(snapshot));

    expect(tableRanges(edit("Before", "Behind"))).toEqual([first, second]);
  });

  describe("plainTextToDocRequests", () => {
    let insertText = { insertText: { location: { index: 12, tabId: "t" }, text: "ab\ncd" } };
    let clearTextStyle = {
      updateTextStyle: { range: tabRange(12, 17), textStyle: {}, fields: "bold,italic,strikethrough,link" },
    };
    let resetParagraphs = (endIndex: number) => [
      { deleteParagraphBullets: { range: tabRange(12, endIndex) } },
      {
        updateParagraphStyle: {
          range: tabRange(12, endIndex),
          paragraphStyle: {
            namedStyleType: "NORMAL_TEXT",
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      },
    ];

    it("fills a paragraph with plain text", () => {
      expect(plainTextRequests("ab\ncd")).toEqual([insertText, ...resetParagraphs(18), clearTextStyle]);
      expect(plainTextRequests("")).toEqual(resetParagraphs(13));
    });

    it("fills a paragraph and leaves its style", () => {
      expect(plainTextRequests("ab\ncd", true)).toEqual([insertText, clearTextStyle]);
      expect(plainTextRequests("", true)).toEqual([]);
    });

    it("appends to the requests it is given, and reads no Markdown in the text", () => {
      let requests: GoogleDocsRequest[] = [{ deleteContentRange: { range: tabRange(30, 31) } }];
      plainTextToDocRequests("**a** - [b](https://e.com)", 12, "t", requests, true);

      expect(requests).toEqual([
        { deleteContentRange: { range: tabRange(30, 31) } },
        { insertText: { location: { index: 12, tabId: "t" }, text: "**a** - [b](https://e.com)" } },
        {
          updateTextStyle: {
            range: tabRange(12, 38), textStyle: {}, fields: "bold,italic,strikethrough,link",
          },
        },
      ]);
    });

    it("sends no indent reset when appending", () => {
      let requests = markdownToDocRequests("x", 12, "t", { resetParagraphs: true });

      expect(requests.flatMap(request => request.updateParagraphStyle ?? [])).toEqual([{
        range: tabRange(12, 14),
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      }]);
    });
  });

  it("strips what Google strips", () => {
    let stripped = [
      ...Array.from({ length: 9 }, (_, code) => code),
      ...Array.from({ length: 20 }, (_, index) => 0x0c + index),
      0xe000, 0xe907, 0xf0b7, 0xf8ff,
    ].map(code => String.fromCharCode(code));

    expect(stripUnwritableCharacters(`${stripped.join("")}x${stripped.join("y")}`))
      .toBe(`x${"y".repeat(stripped.length - 1)}`);
    expect(stripUnwritableCharacters("tab\there\nline\u000bbreak \u00a0\ud7ff\uf900 \u{1F600}"))
      .toBe("tab\there\nline\u000bbreak \u00a0\ud7ff\uf900 \u{1F600}");
    expect(stripUnwritableCharacters("")).toBe("");
  });

  it("reads a heading or bookmark link without a tab as one of the edited tab", () => {
    expect(cellLinkDestination("#heading=h.x", "t.1")).toBe("?tab=t.1#heading=h.x");
    expect(cellLinkDestination("#bookmark=b", "t.1")).toBe("?tab=t.1#bookmark=b");
    expect(cellLinkDestination("#heading=h.x", "t 1/2")).toBe("?tab=t%201%2F2#heading=h.x");
    expect(docTabToMarkdown(cellTab([{ runs: [
      { text: "x", style: { link: { heading: { id: "h.x", tabId: "t 1/2" } } } }, "\n",
    ] }])).markdown).toContain(`<a href="${cellLinkDestination("#heading=h.x", "t 1/2")}">x</a>`);

    for (let destination of [
      "?tab=t.2#heading=h.x", "?tab=t.2#bookmark=b", "?tab=t.2", "?tab=%74.2#heading=h%2Ex",
      "https://x.example/#heading=h.x", "mailto:a@b.example",
    ]) {
      expect([destination, cellLinkDestination(destination, "t.1")])
        .toEqual([destination, canonicalLinkDestination(destination)]);
    }
    expect(cellLinkDestination("?tab=%74.2#heading=h%2Ex", "t.1")).toBe("?tab=t.2#heading=h.x");
    expect(cellLinkDestination("https://x.example/#heading=h.x", "t.1"))
      .toBe("https://x.example/#heading=h.x");
  });

  it("gives the link a destination stands for", () => {
    expect(docsLinkForDestination("https://e.com/#heading=h.x"))
      .toEqual({ url: "https://e.com/#heading=h.x" });
    expect(docsLinkForDestination("?tab=t.1#heading=h.x"))
      .toEqual({ heading: { id: "h.x", tabId: "t.1" } });
    expect(docsLinkForDestination("#bookmark=b")).toEqual({ bookmarkId: "b" });
    expect(docsLinkForDestination("?tab=t.1")).toEqual({ tabId: "t.1" });
  });

  it("pins the rendering version with the earlier versions it still replays", () => {
    expect([MARKDOWN_RENDERING_VERSION, REPLAYABLE_TEXT_EDIT_VERSIONS]).toEqual([8, [7]]);
  });

  it("marks the paragraphs a positioned object is anchored to", () => {
    let tab = buildTab([
      { runs: ["Anchored\n"] },
      { runs: ["Figure ", RICH_LINK, "\n"] },
      { runs: ["[Image] typed ", PERSON, "\n"] },
      { runs: ["Plain\n"] },
    ]);
    let positioned = tab.body.content[1].paragraph;
    let image = tab.body.content[2].paragraph;
    if (!positioned || !image) throw new Error("The fixture's first elements are paragraphs");
    positioned.positionedObjectIds = ["image-1"];
    makeInlineImage(image, 1);
    let snapshot = docTabToMarkdown(tab);
    let [anchored, ...others] = snapshot.sourceMap.blocks;

    expect(snapshot.markdown).toBe(
      "[Image] Anchored\n\nFigure \\[Image\\]\n\n[Image] typed owner@example\\.com\n\nPlain\n");
    expect(anchored.positioned).toBe(true);
    expect(others.map(block => "positioned" in block)).toEqual([false, false, false]);
  });

  it("refuses a protected range with its own error class", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before \\* star\n"] },
      { table: [["Owner\n"]] },
      { runs: ["After\n"] },
    ]));
    let { markdown, sourceMap } = snapshot;
    let owner = markdown.indexOf("Owner");
    let message = "replaceText: structured content cannot be edited. Narrow the match to plain text.";
    let refusals = [
      thrownBy(() => assertMarkdownRangeEditable(sourceMap.protectedRanges, owner, owner + 5)),
      thrownBy(() => computeReplaceOperations(sourceMap, markdown, owner, owner + 5, "Lead", TAB_ID)),
      thrownBy(() => computeReplaceOperations(
        sourceMap, markdown, 0, markdown.length, "Rewritten\n", TAB_ID)),
    ];
    let escape = markdown.indexOf("\\*");
    let splitEscape = thrownBy(() =>
      computeReplaceOperations(sourceMap, markdown, escape + 1, escape + 2, "+", TAB_ID));

    for (let refusal of refusals) {
      expect(refusal).toBeInstanceOf(StructuredContentError);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal instanceof Error && refusal.message).toBe(message);
    }
    expect(new StructuredContentError().name).toBe("Error");
    expect(splitEscape).toBeInstanceOf(Error);
    expect(splitEscape).not.toBeInstanceOf(StructuredContentError);
    expect(splitEscape instanceof Error && splitEscape.message)
      .toContain("Markdown escape syntax cannot be edited partially");
    expect(() => assertMarkdownRangeEditable(sourceMap.protectedRanges, 0, 6)).not.toThrow();
  });
});

// These are what keeps an edit from landing on the wrong characters. A content segment claims a
// 1:1 mapping between Markdown and document indices, and computeReplaceOperations trusts it.
describe("source map invariants", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: [
      "Hello ",
      { text: "bold", style: { bold: true } },
      " and ",
      { text: "link", style: { link: { url: "https://e.com" } } },
      ".\n",
    ] },
    { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
  ], BULLET_LIST));
  let text = docText(["Title\n", "Hello ", "bold", " and ", "link", ".\n", "one\n"]);
  let segments = snapshot.sourceMap.blocks.flatMap(b => b.segments);
  let contentSegments = segments.filter(isContent);

  it("gives every content segment equal length in both spaces", () => {
    for (let seg of contentSegments) {
      expect(seg.mdEnd - seg.mdStart).toBe(seg.docEnd - seg.docStart);
    }
  });

  it("maps every content segment to the same text in both spaces", () => {
    for (let seg of contentSegments) {
      expect(snapshot.markdown.slice(seg.mdStart, seg.mdEnd))
        .toBe(text.slice(seg.docStart, seg.docEnd));
    }
  });

  it("keeps segments non-overlapping and ordered in both spaces", () => {
    let mdCursor = 0;
    let docCursor = 0;
    for (let seg of segments) {
      expect(seg.mdStart).toBeGreaterThanOrEqual(mdCursor);
      expect(seg.mdEnd).toBeGreaterThanOrEqual(seg.mdStart);
      mdCursor = seg.mdEnd;
      if ("syntaxOnly" in seg) continue;
      expect(seg.docStart).toBeGreaterThanOrEqual(docCursor);
      docCursor = seg.docEnd;
    }
  });

  it("keeps each block's segments inside the block's own ranges", () => {
    for (let block of snapshot.sourceMap.blocks) {
      for (let seg of block.segments) {
        expect(seg.mdStart).toBeGreaterThanOrEqual(block.mdStart);
        expect(seg.mdEnd).toBeLessThanOrEqual(block.mdEnd);
        if ("syntaxOnly" in seg) continue;
        expect(seg.docStart).toBeGreaterThanOrEqual(block.docStart);
        expect(seg.docEnd).toBeLessThanOrEqual(block.docEnd);
      }
    }
  });

  it("tiles every table with its rows and cells, and gives its look and its paragraphs", () => {
    const merged = { rowSpan: 2, columnSpan: 2 };
    const item = (line: string, nestingLevel = 0) =>
      ({ runs: [`${line}\n`], bullet: { listId: "L1", nestingLevel } });
    let built = buildTab([
      { table: [
        [{ paragraphs: [{ runs: ["head\n"] }], tableCellStyle: merged }, "\n", "c\n"],
        ["\n", "\n", { paragraphs: [item("one"), item("deep", 2), { runs: ["\n"] }] }],
        [
          { paragraphs: [{ runs: ["x\n"] }, { table: [[{ paragraphs: [item("in")] }, "\n"]] }, { runs: ["y\n"] }] },
          { paragraphs: [{ runs: ["wide\n"] }], tableCellStyle: { columnSpan: 2 } },
          "\n",
        ],
      ], columns: [null, 80, null], heights: [0, 24, 0] },
      { runs: ["Between\n"] },
      { table: [["a\n"], ["b\n", "c\n"]] },
    ], BULLET_LIST);
    let recorded = readFixtures().flatMap(fixture =>
      [fixture.before, ...fixture.steps.map(step => step.after)]);
    let tables = 0;

    for (let tab of [built, ...recorded]) {
      let rendering = docTabToMarkdown(tab);
      let elements = tab.body.content.filter(element => element.table);
      expect(rendering.sourceMap.tables).toHaveLength(elements.length);
      for (let [index, table] of rendering.sourceMap.tables.entries()) {
        let element = elements[index];
        let rows = element.table?.tableRows ?? [];
        expectMapTilesTable(rendering, table);
        expect(table.look).toEqual(lookOfTable(element.table!));
        expect([table.docStart, table.docEnd]).toEqual([element.startIndex, element.endIndex]);
        expect(rendering.sourceMap.protectedRanges.filter(range =>
          range.mdStart <= table.mdStart && table.mdEnd <= range.mdEnd)).toHaveLength(1);
        // Every row and cell at the fixture's indexes, and each text a paragraph of its own cell.
        expect(table.rows.map((_, at) => rowIndexes(table, at).docStart)).toEqual(
          rows.map(row => row.startIndex));
        for (let [at, row] of rows.entries()) {
          let cells = row.tableCells ?? [];
          let mapped = rowIndexes(table, at);
          expect([mapped.docEnd, mapped.cells.map(cell => cell.docStart)])
            .toEqual([row.endIndex, cells.map(cell => cell.startIndex)]);
          for (let [column, cell] of mapped.cells.entries()) {
            let paragraphs = (cells[column].content ?? []).flatMap(part =>
              part.paragraph ? [part.startIndex] : []);
            expect(cell.paragraphs).toEqual(paragraphs.filter(start => cell.paragraphs.includes(start)));
          }
        }
        tables++;
      }
    }
    // The two built here, and those of the recordings.
    expect(tables).toBeGreaterThan(2);
  });
});

describe("Markdown links", () => {
  it("preserves a closing bracket in a linked label through a heading rewrite", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "a]b", style: { link: { url: "https://e.com" } } }, "\n",
    ] }]));
    let oldMarkdown = snapshot.markdown.trimEnd();
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, oldMarkdown.length, `# ${oldMarkdown}`, TAB_ID,
    ).requests;

    expect(snapshot.markdown).toBe("[a\\]b](https://e.com)\n");
    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "a]b" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
        textStyle: { link: { url: "https://e.com" } },
        fields: "link",
      },
    });
  });

  it("preserves an internal tab target through a heading rewrite", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "Details", style: { link: { tabId: "details" } } }, "\n",
    ] }]));
    let oldMarkdown = snapshot.markdown.trimEnd();
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, oldMarkdown.length, `# ${oldMarkdown}`, TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 8, tabId: TAB_ID },
        textStyle: { link: { tabId: "details" } },
        fields: "link",
      },
    });
  });

  it.each([
    ["?tab=details", { tabId: "details" }],
    ["?tab=details#bookmark=bookmark-1", {
      bookmark: { id: "bookmark-1", tabId: "details" },
    }],
    ["?tab=details#heading=heading-1", {
      heading: { id: "heading-1", tabId: "details" },
    }],
    ["#bookmark=bookmark-2", { bookmarkId: "bookmark-2" }],
    ["#heading=heading-2", { headingId: "heading-2" }],
  ])("writes internal destination %s as an internal link", (destination, link) => {
    let requests = markdownToDocRequests(`[x](${destination})`, 1, TAB_ID);

    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 2, tabId: TAB_ID },
        textStyle: { link },
        fields: "link",
      },
    });
  });

  it("coalesces adjacent links with the same destination", () => {
    let requests = markdownToDocRequests(
      "[a](https://e.com)[b](https://e.com)", 1, TAB_ID,
    );

    expect(requests.filter(request => request.updateTextStyle?.fields === "link")).toEqual([{
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 3, tabId: TAB_ID },
        textStyle: { link: { url: "https://e.com" } },
        fields: "link",
      },
    }]);
  });

  it("materializes an empty-label link as literal text", () => {
    let snapshot = docTabToMarkdown(buildTab([{
      runs: ["Title\n"], namedStyleType: "HEADING_1",
    }]));
    let replacement = "[](https://e.com/**path**)";
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, snapshot.markdown.trimEnd().length,
      replacement, TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: replacement },
    });
  });

  it("maps text after an escaped linked-label bracket", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "a]b", style: { link: { url: "https://e.com" } } }, "\n",
    ] }]));
    let start = snapshot.markdown.indexOf("b");

    expect(computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + 1, "c", TAB_ID,
    ).requests[0]).toEqual({
      deleteContentRange: { range: { startIndex: 3, endIndex: 4, tabId: TAB_ID } },
    });
  });

  it("rejects a range that splits an escaped linked-label character", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "a]b", style: { link: { url: "https://e.com" } } }, "\n",
    ] }]));
    let start = snapshot.markdown.indexOf("]b");

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + 2, "x]b", TAB_ID,
    )).toThrow("replaceText: Markdown escape syntax cannot be edited partially");
  });

  it.each([
    ["balanced", PARENTHESIZED_URL],
    ["escaped", "https://en.wikipedia.org/wiki/Function_\\(mathematics\\)"],
  ])("parses %s destination parentheses", (_name, destination) => {
    let requests = markdownToDocRequests(`[link](${destination})`, 1, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "link" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 5, tabId: TAB_ID },
        textStyle: { link: { url: PARENTHESIZED_URL } },
        fields: "link",
      },
    });
  });

  it("renders destination parentheses canonically escaped", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "link", style: { link: { url: PARENTHESIZED_URL } } }, "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "[link](https://en.wikipedia.org/wiki/Function_\\(mathematics\\))\n",
    );
  });

  it("preserves a parenthesized link beside a formatting edit", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, " and ",
      { text: "link", style: { link: { url: PARENTHESIZED_URL } } }, "\n",
    ] }]));
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, "**bold**".length, "plain", TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "plain and link" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 11, endIndex: 15, tabId: TAB_ID },
        textStyle: { link: { url: PARENTHESIZED_URL } },
        fields: "link",
      },
    });
  });
});

// Tab bodies have independent index spaces, so a coordinate without the selected tab's ID would
// land in whichever tab Google picks by default.
describe("selected-tab write coordinates", () => {
  it("stamps the tab ID on every inserted location and styled range", () => {
    let requests = markdownToDocRequests(
      "# Head\n\n- one\n\n**bold** and [link](https://e.com)\n", 7, "metrics");

    let found = coordinates(requests);
    expect(found).toHaveLength(requests.length);
    for (const coordinate of found) expect(coordinate.tabId).toBe("metrics");
  });
});

describe("computeReplaceOperations", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: ["Hello ", { text: "bold", style: { bold: true } }, " world.\n"] },
  ]));
  let md = snapshot.markdown;
  let replace = (oldText: string, newText: string) => {
    let start = md.indexOf(oldText);
    expect(start).toBeGreaterThanOrEqual(0);
    return computeReplaceOperations(
      snapshot.sourceMap, md, start, start + oldText.length, newText, TAB_ID);
  };

  it("renders the fixture as expected", () => {
    expect(md).toBe("# Title\n\nHello **bold** world.\n");
  });

  it("emits nothing when the text is unchanged", () => {
    expect(replace("world", "world")).toEqual({ requests: [], trimmedOld: "", trimmedNew: "" });
  });

  it("deletes then re-inserts at the mapped document range", () => {
    let result = replace("world", "there");

    expect(result).toMatchObject({ trimmedOld: "world", trimmedNew: "there" });
    expect(result.requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } },
      { insertText: { location: { index: 18, tabId: TAB_ID }, text: "there" } },
    ]);
  });

  it("trims a shared prefix down to a bare insert", () => {
    let result = replace("world", "worlds");

    expect(result).toMatchObject({ trimmedOld: "", trimmedNew: "s" });
    expect(result.requests[0]).toEqual({
      insertText: { location: { index: 23, tabId: TAB_ID }, text: "s" },
    });
  });
  it("inserts a following paragraph after the existing terminator", () => {
    let paragraph = docTabToMarkdown(buildTab([{ runs: ["Hello\n"] }]));
    let { requests } = computeReplaceOperations(
      paragraph.sourceMap, paragraph.markdown, 0, paragraph.markdown.length,
      "Hello\nAfter", TAB_ID,
    );

    expect(requests[0]).toEqual({
      insertText: { location: { index: 6, tabId: TAB_ID }, text: "\nAfter" },
    });
  });

  it("inserts after a structured-only paragraph", () => {
    let paragraph = docTabToMarkdown(buildTab([{ runs: [
      { date: "Sep 16, 2026" }, "\n",
    ] }]));
    let { requests } = computeReplaceOperations(
      paragraph.sourceMap, paragraph.markdown, 0, paragraph.markdown.length,
      paragraph.markdown + "After", TAB_ID,
    );

    expect(requests[0]).toEqual({
      insertText: { location: { index: 2, tabId: TAB_ID }, text: "\nAfter" },
    });
  });

  it("preserves a terminal newline in an inline insertion", () => {
    let paragraph = docTabToMarkdown(buildTab([{ runs: ["fooBAR\n"] }]));
    let start = paragraph.markdown.indexOf("BAR");
    let { requests } = computeReplaceOperations(
      paragraph.sourceMap, paragraph.markdown, start, start + 3, "A\nBAR", TAB_ID,
    );

    expect(requests[0]).toEqual({
      insertText: { location: { index: 4, tabId: TAB_ID }, text: "A\n" },
    });
  });

  it("emits only a delete when the replacement is empty", () => {
    expect(replace("world", "")).toEqual({
      trimmedOld: "world",
      trimmedNew: "",
      requests: [{ deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } }],
    });
  });

  it("preserves surrounding text when the range spans Markdown syntax", () => {
    expect(replace("**bold**", "plain").requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 24, tabId: TAB_ID } } },
      { insertText: { location: { index: 7, tabId: TAB_ID }, text: "Hello plain world." } },
    ]);
  });

  it("does not expand an insertion into a preceding protected list item", () => {
    let protectedSnapshot = docTabToMarkdown(buildTab([
      { runs: [
        { richLink: { title: "Plan", uri: "https://docs.google.com/document/d/plan" } },
        "\n",
      ], bullet: { listId: "L1" } },
      { runs: ["second\n"], bullet: { listId: "L1" } },
    ], BULLET_LIST));
    let oldText = "- second";
    let start = protectedSnapshot.markdown.indexOf(oldText);

    let { requests } = computeReplaceOperations(
      protectedSnapshot.sourceMap,
      protectedSnapshot.markdown,
      start,
      start + oldText.length,
      `Intro\n${oldText}`,
      TAB_ID,
    );

    expect(requests[0]).toEqual({
      insertText: { location: { index: 3, tabId: TAB_ID }, text: "Intro\n" },
    });
  });
  it("rejects edits to the separator before structured content", () => {
    let structured = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { runs: [{ date: "Sep 16, 2026" }, "\n"] },
    ]));

    expect(() => computeReplaceOperations(
      structured.sourceMap, structured.markdown, 0, "Before\n\n".length,
      "Updated\n", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });


  it("preserves untouched literal Markdown punctuation", () => {
    let punctuationSnapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, " costs 2 * 3 = 6\n",
    ] }]));
    let oldText = "**bold**";
    let start = punctuationSnapshot.markdown.indexOf(oldText);

    let { requests } = computeReplaceOperations(
      punctuationSnapshot.sourceMap,
      punctuationSnapshot.markdown,
      start,
      start + oldText.length,
      "plain",
      TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "plain costs 2 * 3 = 6" },
    });
  });

  it("preserves untouched backslashes during block rewrites", () => {
    let path = String.raw`\\server\share`;
    let pathSnapshot = docTabToMarkdown(buildTab([{
      runs: [`Path ${path}\n`], namedStyleType: "HEADING_1",
    }]));

    let { requests } = computeReplaceOperations(
      pathSnapshot.sourceMap, pathSnapshot.markdown, 0, pathSnapshot.markdown.trimEnd().length,
      `Path ${path}`, TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: `Path ${path}` },
    });
  });

  it("turns escaped formatting delimiters into literal text", () => {
    let bold = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, "\n",
    ] }]));
    let { requests } = computeReplaceOperations(
      bold.sourceMap, bold.markdown, 0, "**bold**".length,
      String.raw`\*\*bold\*\*`, TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "**bold**" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        textStyle: {},
        fields: "bold,italic,strikethrough,link",
      },
    });
  });

  it("does not trim through Markdown formatting delimiters", () => {
    let italic = docTabToMarkdown(buildTab([{ runs: [
      { text: "x", style: { italic: true } }, "\n",
    ] }]));
    let result = computeReplaceOperations(
      italic.sourceMap, italic.markdown, 0, "*x*".length, "**x**", TAB_ID,
    );

    expect(result).toMatchObject({ trimmedOld: "*x*", trimmedNew: "**x**" });
    expect(result.requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 2, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
  });

  it.each([
    ["italic", "*x", "*x*", { italic: true }, "italic"],
    ["strikethrough", "~~x", "~~x~~", { strikethrough: true }, "strikethrough"],
  ] as const)("completes an unmatched %s span", (_name, oldText, newText, textStyle, fields) => {
    let plain = docTabToMarkdown(buildTab([{ runs: [`${oldText}\n`] }]));
    let result = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, oldText.length, newText, TAB_ID,
    );

    expect(result).toMatchObject({ trimmedOld: oldText, trimmedNew: newText });
    expect(result.requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 2, tabId: TAB_ID },
        textStyle,
        fields,
      },
    });
  });

  it.each(["# heading", "- item", "1. item"])(
    "keeps %s literal inside a paragraph",
    replacement => {
      let plain = docTabToMarkdown(buildTab([{ runs: ["Alpha target omega\n"] }]));
      let start = plain.markdown.indexOf("target");
      let { requests } = computeReplaceOperations(
        plain.sourceMap, plain.markdown, start, start + "target".length, replacement, TAB_ID,
      );

      expect(requests).toContainEqual({
        insertText: {
          location: { index: 1, tabId: TAB_ID },
          text: `Alpha ${replacement} omega`,
        },
      });
      expect(requests.some(request =>
        "updateParagraphStyle" in request || "createParagraphBullets" in request ||
        "deleteParagraphBullets" in request,
      )).toBe(false);
    },
  );

  it("applies block syntax isolated by trimming", () => {
    let plain = docTabToMarkdown(buildTab([{ runs: ["Title\n"] }]));

    let { requests } = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, "Title".length, "# Title", TAB_ID,
    );

    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "HEADING_1" },
        fields: "namedStyleType",
      },
    });
  });

  it.each([
    ["bullet", "- Title", "BULLET_DISC_CIRCLE_SQUARE"],
    ["numbered", "1. Title", "NUMBERED_DECIMAL_ALPHA_ROMAN"],
  ])("applies %s syntax at a paragraph boundary", (_name, replacement, bulletPreset) => {
    let plain = docTabToMarkdown(buildTab([{ runs: ["Title\n"] }]));
    let { requests } = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, "Title".length, replacement, TAB_ID,
    );

    expect(requests).toContainEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        bulletPreset,
      },
    });
  });
  it.each([
    ["heading", "# ", "updateParagraphStyle"],
    ["bullet", "- ", "createParagraphBullets"],
    ["numbered", "1. ", "createParagraphBullets"],
  ])("writes an empty %s without inserting its marker", (_name, replacement, styleRequest) => {
    let plain = docTabToMarkdown(buildTab([{ runs: ["Old\n"] }]));
    let { requests } = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, "Old".length, replacement, TAB_ID,
    );

    expect(requests.some(request => "insertText" in request)).toBe(false);
    expect(requests.some(request => styleRequest in request)).toBe(true);
  });

  it("writes a heading inside a numbered list item", () => {
    let requests = markdownToDocRequests("1. ## Section", 1, TAB_ID);

    expect(requests.some(request =>
      request.updateParagraphStyle?.paragraphStyle.namedStyleType === "HEADING_2"
    )).toBe(true);
    expect(requests.some(request => "createParagraphBullets" in request)).toBe(true);
  });

  it("creates contiguous numbered items as one list", () => {
    let requests = markdownToDocRequests("1. First\n1. Second", 1, TAB_ID);

    expect(requests.filter(request => "createParagraphBullets" in request)).toEqual([{
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 14, tabId: TAB_ID },
        bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN",
      },
    }]);
  });

  it("rewrites items of separate lists in place", () => {
    let listSnapshot = docTabToMarkdown(buildTab([
      { runs: ["First\n"], bullet: { listId: "L1" } },
      { runs: ["Second\n"], bullet: { listId: "L2" } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
      L2: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    }));
    let requests = computeReplaceOperations(
      listSnapshot.sourceMap, listSnapshot.markdown, 0, listSnapshot.markdown.trimEnd().length,
      "1. Changed first\n1. Changed second", TAB_ID,
    ).requests;

    expect(requests.some(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request)).toBe(false);
  });

  it("clears removed heading and list styles", () => {
    let heading = docTabToMarkdown(buildTab([{
      runs: ["Title\n"], namedStyleType: "HEADING_1",
    }]));
    let list = docTabToMarkdown(buildTab([{
      runs: ["item\n"], bullet: { listId: "L1" },
    }], BULLET_LIST));

    let headingRequests = computeReplaceOperations(
      heading.sourceMap, heading.markdown, 0, "# Title".length, "Title", TAB_ID,
    ).requests;
    let listRequests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "- item".length, "item", TAB_ID,
    ).requests;

    expect(headingRequests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    expect(listRequests).toContainEqual({
      deleteParagraphBullets: { range: { startIndex: 1, endIndex: 6, tabId: TAB_ID } },
    });
  });

  it("clears indentation after removing list bullets", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 },
    }], BULLET_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "  - nested".length, "nested", TAB_ID,
    ).requests;
    let deleteIndex = requests.findIndex(request => "deleteParagraphBullets" in request);

    expect(requests.slice(deleteIndex, deleteIndex + 2)).toEqual([
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 8, tabId: TAB_ID } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 8, tabId: TAB_ID },
          paragraphStyle: {
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "indentStart,indentFirstLine",
        },
      },
    ]);
  });

  it("clears list indentation when one item becomes plain paragraphs", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 },
    }], BULLET_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "plain\n\nsecond", TAB_ID,
    ).requests;

    expect(requests.filter(request =>
      "updateParagraphStyle" in request || "deleteParagraphBullets" in request,
    )).toEqual([
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 14, tabId: TAB_ID } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
          paragraphStyle: {
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "indentStart,indentFirstLine",
        },
      },
      {
        updateParagraphStyle: {
          range: { startIndex: 7, endIndex: 14, tabId: TAB_ID },
          paragraphStyle: {
            namedStyleType: "NORMAL_TEXT",
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      },
    ]);
  });

  it("keeps a custom list when an edit adds an item", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["Task\n"], bullet: { listId: "check" },
    }], CHECK_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "- One\n- Two", TAB_ID,
    ).requests;

    expect(requests.some(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request)).toBe(false);
  });

  it("preserves an unchanged custom list when inserting an adjacent block", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["Task\n"], bullet: { listId: "check" },
    }], CHECK_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "Intro\n- Task", TAB_ID,
    ).requests;

    expect(requests.some(request => "createParagraphBullets" in request)).toBe(false);
  });

  it.each([
    ["title", buildTab([{ runs: ["Kept\n"], namedStyleType: "TITLE" }]), "# A\n\n# Kept\n\n# B"],
    ["markerless list item", buildTab([{ runs: ["Kept\n"], bullet: { listId: "none" } }], {
      none: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
    }), "# A\n\nKept\n\n# B"],
  ])("leaves an unchanged %s between inserted blocks alone", (_, tab, replacement) => {
    let { sourceMap, markdown } = docTabToMarkdown(tab);
    let requests = computeReplaceOperations(
      sourceMap, markdown, 0, markdown.trimEnd().length, replacement, TAB_ID,
    ).requests;

    // B lands at 6–8 while Kept still sits at 1–6, then A at 1–3.
    expect(new Set(requests.flatMap(request => {
      let range = (request.updateParagraphStyle ?? request.deleteParagraphBullets)?.range;
      return range ? [`${range.startIndex}-${range.endIndex}`] : [];
    }))).toEqual(new Set(["6-8", "1-3"]));
  });

  it.each([
    ["# Added\n\n# Kept", "HEADING_1"],
    ["Intro\n\n# Kept", "NORMAL_TEXT"],
  ])("keeps the title on its own paragraph in %j", (replacement, addedStyle) => {
    let { sourceMap, markdown } = docTabToMarkdown(buildTab([
      { runs: ["Kept\n"], namedStyleType: "TITLE" },
      { runs: ["Removed\n"] },
    ]));
    let requests = computeReplaceOperations(
      sourceMap, markdown, 0, markdown.trimEnd().length, replacement, TAB_ID,
    ).requests;

    expect(requests.flatMap(request => request.updateParagraphStyle
      ? [request.updateParagraphStyle.paragraphStyle.namedStyleType] : [])).toEqual([
      "TITLE", addedStyle,
    ]);
  });

  it("keeps a numbered list whose items shift within one rewrite", () => {
    let { sourceMap, markdown } = docTabToMarkdown(buildTab([
      { runs: ["a\n"], bullet: { listId: "L1" } },
      { runs: ["b\n"], bullet: { listId: "L1" } },
    ], { L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } }));
    let requests = computeReplaceOperations(
      sourceMap, markdown, 0, markdown.trimEnd().length, "1. b\n1. c", TAB_ID,
    ).requests;

    expect(requests.some(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request)).toBe(false);
  });

  it("pairs an equal-count rewrite at the block limit in place", () => {
    let paragraphs = Array.from({ length: 999 }, (_, index) => `paragraph ${index}`);
    let { sourceMap, markdown } = docTabToMarkdown(buildTab([
      { runs: ["Old title\n"], namedStyleType: "TITLE" },
      ...paragraphs.map(paragraph => ({ runs: [`${paragraph}\n`] })),
    ]));
    let replacement = ["# New title", ...paragraphs.map(paragraph => `${paragraph} edited`)]
      .join("\n\n");
    let requests = computeReplaceOperations(
      sourceMap, markdown, 0, markdown.trimEnd().length, replacement, TAB_ID,
    ).requests;

    expect(requests.filter(request => "deleteContentRange" in request)).toHaveLength(1_000);
    expect(requests.some(request => "updateParagraphStyle" in request)).toBe(false);
  });

  it("keeps an unchanged title beyond the alignment limit", () => {
    let { sourceMap, markdown } = docTabToMarkdown(buildTab(Array.from({ length: 501 },
      (_, index) => index === 250
        ? { runs: ["Title\n"], namedStyleType: "TITLE" }
        : { runs: [`p${index}\n`] })));
    let lines = markdown.trimEnd().split("\n\n");
    lines[0] = "p0 edited";
    lines[500] = "p500 edited";
    lines.splice(400, 0, "added after");
    lines.splice(100, 0, "added before");
    let requests = computeReplaceOperations(
      sourceMap, markdown, 0, markdown.trimEnd().length, lines.join("\n\n"), TAB_ID,
    ).requests;

    expect(requests.flatMap(request => request.updateParagraphStyle
      ? [request.updateParagraphStyle.paragraphStyle.namedStyleType] : [])).toEqual([
      "NORMAL_TEXT", "NORMAL_TEXT",
    ]);
  });

  it("preserves title and custom list styles during inline edits", () => {
    let title = docTabToMarkdown(buildTab([{
      runs: [{ text: "Title", style: { bold: true } }, "\n"], namedStyleType: "TITLE",
    }]));
    let list = docTabToMarkdown(buildTab([{
      runs: [{ text: "Task", style: { bold: true } }, "\n"], bullet: { listId: "check" },
    }], CHECK_LIST));
    let titleRequests = computeReplaceOperations(
      title.sourceMap, title.markdown, 0, "# **Title**".length, "# Title", TAB_ID,
    ).requests;
    let listRequests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "- **Task**".length, "- Task", TAB_ID,
    ).requests;

    expect(titleRequests.some(request => "updateParagraphStyle" in request)).toBe(false);
    expect(listRequests.some(request =>
      "deleteParagraphBullets" in request || "createParagraphBullets" in request,
    )).toBe(false);
  });

  it("applies bold from a mapped inline source", () => {
    let requests = replace("bold", "bald").requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 14, endIndex: 15, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("applies a link from a mapped inline source", () => {
    let linked = docTabToMarkdown(buildTab([{ runs: [
      { text: "link", style: { link: { url: "https://example.com" } } }, "\n",
    ] }]));
    let start = linked.markdown.indexOf("link");
    let requests = computeReplaceOperations(
      linked.sourceMap, linked.markdown, start, start + "link".length, "lint", TAB_ID,
    ).requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 4, endIndex: 5, tabId: TAB_ID },
        textStyle: { link: { url: "https://example.com" } },
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("preserves a shared style across adjacent source segments", () => {
    let styled = docTabToMarkdown(buildTab([{ runs: [
      { text: "one", style: { bold: true } },
      { text: "two", style: { bold: true } },
      "\n",
    ] }]));
    let start = styled.markdown.indexOf("onetwo");
    let requests = computeReplaceOperations(
      styled.sourceMap, styled.markdown, start, start + "onetwo".length, "new", TAB_ID,
    ).requests;

    expect(requests.at(-1)).toEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold,italic,strikethrough,link",
      },
    });
  });

  it("resets a mapped plain source beside styled text", () => {
    let mixed = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, "plain\n",
    ] }]));
    let start = mixed.markdown.indexOf("plain");
    let requests = computeReplaceOperations(
      mixed.sourceMap, mixed.markdown, start, start + "plain".length, "new", TAB_ID,
    ).requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 8, tabId: TAB_ID },
        textStyle: {},
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("resets inherited styles before applying Markdown styles", () => {
    let styled = docTabToMarkdown(buildTab([{ runs: [{
      text: "Old\n",
      style: {
        bold: true,
        italic: true,
        strikethrough: true,
        link: { url: "https://example.com" },
      },
    }] }]));
    let requests = computeReplaceOperations(
      styled.sourceMap, styled.markdown, 0, styled.markdown.trimEnd().length,
      "**New**", TAB_ID,
    ).requests;

    expect(requests.filter(request => "updateTextStyle" in request)).toEqual([
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
          textStyle: { bold: true },
          fields: "bold",
        },
      },
    ]);
  });

  it("uses an explicit italic override when removing subtitle emphasis", () => {
    let subtitle = docTabToMarkdown(buildTab([{
      runs: ["Subtitle\n"], namedStyleType: "SUBTITLE",
    }]));
    let requests = computeReplaceOperations(
      subtitle.sourceMap, subtitle.markdown, 0, "*Subtitle*".length, "Subtitle", TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        textStyle: { italic: false },
        fields: "italic",
      },
    });
    expect(requests.some(request =>
      "updateParagraphStyle" in request &&
      request.updateParagraphStyle.paragraphStyle.namedStyleType === "NORMAL_TEXT",
    )).toBe(false);
  });

  it("reuses the existing terminator and clears heading style", () => {
    let heading = docTabToMarkdown(buildTab([{
      runs: ["Title\n"], namedStyleType: "HEADING_1",
    }]));

    let { requests } = computeReplaceOperations(
      heading.sourceMap, heading.markdown, 0, "# Title".length, "", TAB_ID,
    );

    expect(requests[0]).toEqual({
      deleteContentRange: { range: { startIndex: 1, endIndex: 6, tabId: TAB_ID } },
    });
    expect(requests.some(request => "insertText" in request)).toBe(false);
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 2, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
  });

  it("clears list formatting when emptying a block", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["item\n"], bullet: { listId: "L1" },
    }], BULLET_LIST));
    let { requests } = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "- item".length, "", TAB_ID,
    );

    expect(requests).toContainEqual({
      deleteParagraphBullets: { range: { startIndex: 1, endIndex: 2, tabId: TAB_ID } },
    });
  });

  it("preserves list nesting", () => {
    let requests = markdownToDocRequests("  - nested", 1, TAB_ID);

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "\tnested" },
    });
    // A range's shallowest paragraph lands at level 0 whatever its tabs, so the item is bulleted
    // behind an empty paragraph with no tab, which is then deleted.
    expect(requests.slice(-3)).toEqual([
      { insertText: { location: { index: 1, tabId: TAB_ID }, text: "\n" } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 10, tabId: TAB_ID },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 2, tabId: TAB_ID } } },
    ]);
  });

  it("parses backslash-escaped Markdown punctuation", () => {
    let requests = markdownToDocRequests(String.raw`\* literal C:\temp`, 1, TAB_ID);

    expect(requests).toEqual([
      { insertText: { location: { index: 1, tabId: TAB_ID }, text: "* literal C:\\temp" } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 18, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
    ]);
  });

  it.each(["*", "**", "***", "~~"])(
    "inserts unmatched %s delimiters literally",
    delimiter => {
      let markdown = `Use ${delimiter} as text`;
      let requests = markdownToDocRequests(markdown, 1, TAB_ID);

      expect(requests[0]).toEqual({
        insertText: { location: { index: 1, tabId: TAB_ID }, text: markdown },
      });
    },
  );

  it("inserts adjacent empty strikethrough delimiters literally", () => {
    expect(markdownToDocRequests("~~~~", 1, TAB_ID)[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "~~~~" },
    });
  });

  it("joins adjacent strikethrough spans without retaining delimiters", () => {
    let requests = markdownToDocRequests("~~a~~~~b~~", 1, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "ab" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 3, tabId: TAB_ID },
        textStyle: { strikethrough: true },
        fields: "strikethrough",
      },
    });
  });

  it("calculates style ranges after removing provider-stripped characters", () => {
    let requests = markdownToDocRequests("**A\u0001B\uE000C**", 10, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 10, tabId: TAB_ID }, text: "ABC" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 13, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
    let styleRanges = requests.flatMap(request =>
      "updateTextStyle" in request ? [request.updateTextStyle.range] : []);
    expect(styleRanges).toEqual([
      { startIndex: 10, endIndex: 13, tabId: TAB_ID },
      { startIndex: 10, endIndex: 13, tabId: TAB_ID },
    ]);
  });

  it("parses numbered starts", () => {
    let requests = markdownToDocRequests("2. item", 1, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "item" },
    });
    expect(requests).toContainEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 6, tabId: TAB_ID },
        bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN",
      },
    });
  });

  it("inserts plain paragraphs with a constant number of requests", () => {
    let markdown = Array.from({ length: 50 }, (_, index) => `Paragraph ${index}`).join("\n\n");
    let requests = markdownToDocRequests(markdown, 1, TAB_ID);
    let text = requests[0].insertText.text;

    expect(requests).toEqual([
      { insertText: { location: { index: 1, tabId: TAB_ID }, text } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 1 + text.length, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
    ]);
  });

  it("shares paragraph requests across adjacent paragraphs that need the same change", () => {
    let markdown = ["# One", "# Two", "Three", "Four", "# Five"].join("\n\n");
    let requests = markdownToDocRequests(markdown, 1, TAB_ID, { resetParagraphs: true });

    expect(requests.filter(request => "deleteParagraphBullets" in request)).toHaveLength(1);
    expect(requests.flatMap(request => {
      let update = request.updateParagraphStyle;
      return update
        ? [[update.paragraphStyle.namedStyleType, update.range.startIndex, update.range.endIndex]]
        : [];
    })).toEqual([
      ["HEADING_1", 1, 9],
      ["NORMAL_TEXT", 9, 20],
      ["HEADING_1", 20, 25],
    ]);
  });
});

/** The requests that replace `oldMarkdown`, which the tab's rendering holds, by `newMarkdown`. */
function replacementRequests(
  tab: DocTabSnapshot, oldMarkdown: string, newMarkdown: string,
): GoogleDocsRequest[] {
  let start = tab.markdown.indexOf(oldMarkdown);
  expect(start).toBeGreaterThanOrEqual(0);
  return computeReplaceOperations(
    tab.sourceMap, tab.markdown, start, start + oldMarkdown.length, newMarkdown, TAB_ID,
  ).requests;
}

/** An append's requests as approval builds them: after the tab's last paragraph, told its blocks. */
function appendedRequests(tab: DocTabSnapshot, markdown: string): GoogleDocsRequest[] {
  return markdownToDocRequests("\n" + markdown, tab.bodyEndIndex - 1, TAB_ID, {
    resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: tab.sourceMap.blocks,
  });
}

/** A range of the tab the write tests name. */
function rangeOfTab(startIndex: number, endIndex: number) {
  return { startIndex, endIndex, tabId: TAB_ID };
}

function textInserted(index: number, text: string): GoogleDocsRequest {
  return { insertText: { location: { index, tabId: TAB_ID }, text } };
}

/** What takes existing items into a range to be bulleted: their bullets and indents removed. */
function unbulleted(startIndex: number, endIndex: number): GoogleDocsRequest[] {
  return [
    { deleteParagraphBullets: { range: rangeOfTab(startIndex, endIndex) } },
    {
      updateParagraphStyle: {
        range: rangeOfTab(startIndex, endIndex),
        paragraphStyle: {
          indentStart: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" },
        },
        fields: "indentStart,indentFirstLine",
      },
    },
  ];
}

/** The deletion of the empty paragraph a range was bulleted behind. */
function scaffoldDeleted(index: number): GoogleDocsRequest {
  return { deleteContentRange: { range: rangeOfTab(index, index + 1) } };
}

/** The start indexes of the list items of `content`, those of table cells included. */
function listItemStarts(content: StructuralElement[]): number[] {
  return content.flatMap(element => {
    if (element.paragraph) return element.paragraph.bullet ? [element.startIndex] : [];
    return (element.table?.tableRows ?? []).flatMap(row =>
      (row.tableCells ?? []).flatMap(cell => listItemStarts(cell.content ?? [])));
  });
}

/**
 * The start indexes of the indented paragraphs that are not list items. A write leaves none:
 * Google indents the items it bullets, and a write resets the indent of a paragraph whose bullet
 * it removes.
 */
function indentedOutsideLists(tab: GoogleDocsTab): number[] {
  let items = new Set(listItemStarts(tab.body.content));
  return indentedParagraphs(tab).filter(start => !items.has(start));
}

/** The one empty paragraph of each tab is its paragraph `index`, and no list item. */
function expectEmptyParagraphAt(tabs: GoogleDocsTab[], index: number): void {
  for (let tab of tabs) {
    let paragraphs = tab.body.content.flatMap(({ paragraph }) => paragraph ? [paragraph] : []);
    let empty = paragraphs.flatMap((paragraph, at) =>
      paragraph.elements.map(element => element.textRun?.content).join("") === "\n"
        ? [[at, paragraph.bullet]] : []);
    expect(empty).toEqual([[index, undefined]]);
  }
}

/** The last `length` requests, which must be the only ones that create bullets. */
function bulletPhase(requests: GoogleDocsRequest[], length: number): GoogleDocsRequest[] {
  // Everything before writes text, resets what the new paragraphs inherited and styles them.
  expect(requests.slice(0, -length).some(request => "createParagraphBullets" in request))
    .toBe(false);
  return requests.slice(-length);
}

// Google nests a bulleted range from the item directly before it, at that item's level plus each
// paragraph's tabs less the fewest in the range; the recordings pin the builders' batches for it.
describe.each([
  ["bulleted", "- ", "BULLET_DISC_CIRCLE_SQUARE", [
    { glyphSymbol: "\u25cf" }, { glyphSymbol: "\u25cb" }, { glyphSymbol: "\u25a0" },
  ]],
  ["numbered", "1. ", "NUMBERED_DECIMAL_ALPHA_ROMAN", [
    { glyphType: "DECIMAL" }, { glyphType: "ALPHA" }, { glyphType: "ROMAN" },
  ]],
] as const)("the nesting of new %s list items", (_kind, marker, bulletPreset, nestingLevels) => {
  let lists: GoogleDocsTab["lists"] = { L1: { listProperties: { nestingLevels: [...nestingLevels] } } };
  /** A line of the rendering: an item at `level`. */
  let item = (level: number, text: string) => "  ".repeat(level) + marker + text;
  /** A tab holding the items "a", "b", "c"... at `levels`, then a plain paragraph if asked. */
  let listDoc = (levels: number[], plain = true) => buildTab([
    ...levels.map((nestingLevel, index) => ({
      runs: [`${"abcdef"[index]}\n`], bullet: { listId: "L1", nestingLevel },
    })),
    ...(plain ? [{ runs: ["plain\n"] }] : []),
  ], lists);
  let bullets = (startIndex: number, endIndex: number) =>
    ({ createParagraphBullets: { range: rangeOfTab(startIndex, endIndex), bulletPreset } });

  it("does not count a list of its kind that the preset did not make", () => {
    // A list as the Docs editor can make one: of the same kind, with glyphs of its own. Whether
    // Google joins it is not on record; the model starts a list after it, and so does the write.
    let own = marker === "- "
      ? [{ glyphSymbol: "\u25c6" }, { glyphSymbol: "\u25c7" }, { glyphSymbol: "\u25c6" }]
      : [{ glyphType: "UPPER_ALPHA" }, { glyphType: "UPPER_ROMAN" }, { glyphType: "DECIMAL" }];
    // "a" [1,3) and "b" [3,5), at levels 0 and 1; an appended item's paragraph starts at 5.
    let doc = (plain = false) => buildTab([
      { runs: ["a\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["b\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      ...(plain ? [{ runs: ["plain\n"] }] : []),
    ], { L1: { listProperties: { nestingLevels: own } } });
    let written = (line: string) => {
      let requests = appendedRequests(docTabToMarkdown(doc()), line);
      // No item of the list is taken in.
      expect(requests.some(request => "deleteParagraphBullets" in request &&
        request.deleteParagraphBullets.range.startIndex < 5)).toBe(false);
      let applied = applyDocsRequests(doc(), requests);
      let bulleted = applied.body.content.flatMap(({ paragraph }) => paragraph?.bullet ?? []);
      expect(bulleted.map(bullet => bullet.listId === "L1")).toEqual([true, true, false]);
      expect(docTabToMarkdown(applied).markdown)
        .toBe(`${item(0, "a")}\n${item(1, "b")}\n\n${line}\n`);
      return requests;
    };

    // As deep as the item before it, or deeper: bulleted behind an empty paragraph, as a run
    // that starts a list is.
    expect(bulletPhase(written(item(1, "c")), 3))
      .toEqual([textInserted(5, "\n"), bullets(5, 9), scaffoldDeleted(5)]);
    expect(bulletPhase(written(item(2, "c")), 3))
      .toEqual([textInserted(5, "\n"), bullets(5, 10), scaffoldDeleted(5)]);
    // Shallower than it: bulleted alone.
    expect(bulletPhase(written(item(0, "c")), 1)).toEqual([bullets(5, 7)]);
    // The same behind an item a rewrite of whole blocks leaves as it is ("b" ends at 6).
    let rewrite = replacementRequests(docTabToMarkdown(doc(true)),
      `${item(0, "a")}\n${item(1, "b")}\n\nplain`,
      `${item(0, "a2")}\n${item(1, "b")}\n\n${item(1, "plain")}`);
    expect(bulletPhase(rewrite, 3))
      .toEqual([textInserted(6, "\n"), bullets(6, 14), scaffoldDeleted(6)]);
    expect(docTabToMarkdown(applyDocsRequests(doc(true), rewrite)).markdown)
      .toBe(`${item(0, "a2")}\n${item(1, "b")}\n\n${item(1, "plain")}\n`);
  });

  it("reads every nesting case back from the model as it was written", () => {
    let other = marker === "- " ? "1. " : "- ";
    let [a, b, c] = [item(0, "a"), item(1, "b"), item(2, "c")];
    let plainTab = buildTab([{ runs: ["plain\n"] }]);
    // Each is a tab, the text replaced in it (none for an append), and the text written.
    let cases: [GoogleDocsTab, string | undefined, string][] = [
      [listDoc([0, 0]), a, `${a}\n${item(1, "a1")}`],
      [listDoc([0, 1]), b, `${b}\n${item(2, "b1")}`],
      [listDoc([0]), a, `${a}\n${item(1, "a1")}\n${item(2, "a2")}`],
      [plainTab, undefined, `${item(1, "x")}\n${item(2, "y")}`],
      [listDoc([0, 1, 2], false), undefined, item(0, "d")],
      [listDoc([0, 1]), b, `${b}\n${item(0, "c")}`],
      [listDoc([0, 1, 2]), c, `${c}\n${item(1, "c2")}`],
      [listDoc([0, 1, 2]), `${b}\n${c}`, `${item(2, "new")}\n${b}\n${c}\n${item(0, "top")}`],
      [listDoc([0, 1]), b, `${b}\n${item(2, "x")}\n${item(1, "y")}`],
      [listDoc([0, 1]), "plain", `  ${other}plain`],
    ];
    for (let [tab, replaced, written] of cases) {
      let snapshot = docTabToMarkdown(tab);
      let requests = replaced === undefined
        ? appendedRequests(snapshot, written)
        : replacementRequests(snapshot, replaced, written);
      let asked = replaced === undefined
        ? `${snapshot.markdown}${tab === plainTab ? "\n" : ""}${written}\n`
        : snapshot.markdown.replace(replaced, written);
      let applied = appliedOneWay(tab, requests);
      expect(docTabToMarkdown(applied).markdown, written).toBe(asked);
      expect(indentedOutsideLists(applied)).toEqual([]);
    }
  });
});

/** A replacement of text that occurs in `tab`, as its requests and the text it changes. */
function replace(tab: DocTabSnapshot, oldMarkdown: string, newMarkdown: string) {
  let start = tab.markdown.indexOf(oldMarkdown);
  expect(start).toBeGreaterThanOrEqual(0);
  return computeReplaceOperations(
    tab.sourceMap, tab.markdown, start, start + oldMarkdown.length, newMarkdown, TAB_ID);
}

/** The text each `insertText` of `requests` writes. */
function insertedText(requests: GoogleDocsRequest[]): string[] {
  return requests.flatMap(request => "insertText" in request ? [request.insertText.text] : []);
}

describe("a block marker written where the old text goes on", () => {
  let listId = Object.keys(BULLET_LIST)[0];
  /** A tab of bulleted items at `levels` and a plain paragraph, read as Markdown. */
  let tabOf = (items: [text: string, level: number][], plain = "plain") => docTabToMarkdown(buildTab([
    ...items.map(([text, nestingLevel]) => ({ runs: [`${text}\n`], bullet: { listId, nestingLevel } })),
    { runs: [`${plain}\n`] },
  ], BULLET_LIST));

  it("splits an item in two when the second keeps the end of the first", () => {
    // The two share " two": the marker's space is the space before "two".
    let { requests, trimmedOld, trimmedNew } = replace(tabOf([["one two", 0]]), "- one two", "- one\n- two");

    expect([trimmedOld, trimmedNew]).toEqual([" ", "\n- "]);
    expect(insertedText(requests)).toEqual(["one\ntwo"]);
    // The second paragraph is split off the item, whose list it keeps.
    expect(requests.some(request => "deleteParagraphBullets" in request)).toBe(false);
  });

  it("writes the second line as the numbered item or heading its marker names", () => {
    let numbered = replace(tabOf([["one two", 0]]), "- one two", "- one\n1. two");
    expect(numbered.trimmedNew).toBe("\n1. ");
    expect(insertedText(numbered.requests)).toEqual(["one\ntwo"]);
    expect(numbered.requests.at(-1)).toMatchObject({
      createParagraphBullets: { bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" },
    });

    let heading = replace(tabOf([["one two", 0]]), "- one two", "- one\n## two");
    expect(heading.trimmedNew).toBe("\n## ");
    expect(insertedText(heading.requests)).toEqual(["one\ntwo"]);
    expect(heading.requests).toContainEqual(expect.objectContaining({
      updateParagraphStyle: expect.objectContaining({
        paragraphStyle: expect.objectContaining({ namedStyleType: "HEADING_2" }),
      }),
    }));
  });

  it("takes a marker's characters out of the text when they become the marker", () => {
    // " - two" is text of the old item; "- two" is an item of the new Markdown.
    let { requests, trimmedOld, trimmedNew } =
      replace(tabOf([["one - two", 0]]), "- one - two", "- one\n- two");

    expect([trimmedOld, trimmedNew]).toEqual([" - ", "\n- "]);
    expect(insertedText(requests)).toEqual(["one\ntwo"]);
  });

  it("splits a plain paragraph into a paragraph and an item", () => {
    let { requests, trimmedNew } = replace(tabOf([["item", 0]], "one two"), "one two", "one\n\n- two");

    expect(trimmedNew).toBe("\n\n- ");
    expect(insertedText(requests).join("")).not.toContain("-");
    expect(requests.at(-1)).toMatchObject({
      createParagraphBullets: { bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
    });
  });

  it("leaves text that only looks like a marker as text", () => {
    // No space follows the hyphen, so the line is not a list item.
    let { trimmedOld, trimmedNew } = replace(tabOf([["one two", 0]]), "- one two", "- one\n-two");

    expect([trimmedOld, trimmedNew]).toEqual([" ", "\n-"]);
  });

  it("leaves a marker both sides have in the text they share", () => {
    // The space after the marker is the marker's in the old Markdown too.
    let kind = replace(tabOf([["one", 0]]), "- one", "1. one");
    expect([kind.trimmedOld, kind.trimmedNew]).toEqual(["-", "1."]);

    // A paragraph written ahead of an item: the item's own marker stays shared.
    let ahead = replace(tabOf([["one", 0]]), "- one", "Lead\n\n- one");
    expect([ahead.trimmedOld, ahead.trimmedNew]).toEqual(["", "Lead\n\n"]);
  });
});

describe("computeReplaceOperations, read back as written", () => {
  /**
   * Every phrasing of the one edit that turns `markdown` into `result`, quoting up to three
   * characters on either side of where the text goes, as a range and its replacement. None of
   * them splits a pair of emphasis markers.
   */
  function phrasings(markdown: string, result: string): [number, number, string][] {
    let found: [number, number, string][] = [];
    let added = result.length - markdown.length;
    for (let at = 0; at <= markdown.length; at++) {
      let text = result.slice(at, at + added);
      if (markdown.slice(0, at) + text + markdown.slice(at) !== result) continue;
      if (markdown[at - 1] === "*") continue;
      for (let start = Math.max(0, at - 3); start <= at; start++) {
        for (let end = at; end <= Math.min(markdown.length, at + 3); end++) {
          let newMarkdown = markdown.slice(start, at) + text + markdown.slice(at, end);
          if (start < end && !markdown.slice(start, end).includes("*")) {
            found.push([start, end, newMarkdown]);
          }
        }
      }
    }
    return found;
  }

  /**
   * The requests of the replacement of `[start, end)` by `newMarkdown`, applied by the model,
   * read the same under each of its options: as the text that was typed, or as `result` where
   * a read gives it otherwise.
   */
  function expectReadsAsWritten(
    tab: GoogleDocsTab, start: number, end: number, newMarkdown: string, result?: string,
  ): void {
    let snapshot = docTabToMarkdown(tab);
    let reads = result ??
      snapshot.markdown.slice(0, start) + newMarkdown + snapshot.markdown.slice(end);
    let rendered = canonicalizeMarkdownReplacement(snapshot.markdown.slice(start, end), newMarkdown);
    let { requests } = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, end, rendered, TAB_ID);
    let edit = JSON.stringify([start, end, newMarkdown]);
    let applied = appliedOneWay(tab, requests);
    expect(docTabToMarkdown(applied).markdown, edit).toBe(reads);
    expect(indentedOutsideLists(applied)).toEqual([]);
  }

  it("writes a heading in front of empty paragraphs with as many as it shows", () => {
    for (let empties of [1, 2, 3]) {
      for (let last of [[para("End")], []]) {
        let tab = buildTab(
          [para("Before"), ...Array.from({ length: empties }, () => para("")), ...last]);
        let { markdown } = docTabToMarkdown(tab);
        for (let text of ["## Notes", "## Notes\n\nSee below", "See above\n\n## Notes",
          "See below"]) {
          let result = markdown.replace("Before\n\n", `Before\n\n${text}\n\n`);
          for (let [start, end, newMarkdown] of phrasings(markdown, result)) {
            expectReadsAsWritten(tab, start, end, newMarkdown);
          }
        }
      }
    }
  });

  it("takes a plain paragraph written in front of a list item or subtitle out of it", () => {
    let none = { glyphType: "NONE" };
    let lists = { ...BULLET_LIST, markerless: { listProperties: { nestingLevels: [none, none] } } };
    let targets = [
      { runs: ["Notes\n"], bullet: { listId: "markerless" } },
      { runs: ["Notes\n"], bullet: { listId: "markerless", nestingLevel: 1 } },
      { runs: ["Notes\n"], bullet: { listId: "L1" } },
      { runs: ["Notes\n"], namedStyleType: "SUBTITLE" },
      { runs: ["Notes\n"] },
    ];
    for (let target of targets) {
      let tab = buildTab([{ runs: ["Before\n"] }, target, { runs: ["End\n"] }], lists);
      let { markdown } = docTabToMarkdown(tab);
      let at = markdown.indexOf("\n\n") + 2;
      for (let text of ["Caption", "One\n\nTwo", "**Caption**", "## Head"]) {
        let result = `${markdown.slice(0, at)}${text}\n\n${markdown.slice(at)}`;
        for (let [start, end, newMarkdown] of phrasings(markdown, result)) {
          expectReadsAsWritten(tab, start, end, newMarkdown);
        }
      }
    }
  });

  it("keeps a list item's or heading's style on text written after its marker", () => {
    // The rest of the paragraph keeps its formatting and links.
    let formatted = ["Notes ", { text: "here", style: { bold: true } }, "\n"];
    let linked = ["Notes ", { text: "here", style: { italic: true, link: { url: "https://example.com/" } } }, "\n"];
    let targets = [
      { runs: ["Notes here\n"], bullet: { listId: "L1" } },
      { runs: ["Notes here\n"], namedStyleType: "HEADING_2" },
      { runs: formatted, bullet: { listId: "L1" } },
      { runs: formatted, namedStyleType: "HEADING_2" },
      { runs: linked, bullet: { listId: "L1" } },
      { runs: linked, namedStyleType: "HEADING_2" },
    ];
    for (let target of targets) {
      let tab = buildTab([{ runs: ["Before\n"] }, target, { runs: ["After\n"] }], BULLET_LIST);
      let { markdown } = docTabToMarkdown(tab);
      for (let [oldMarkdown, newMarkdown] of [
        ["Notes here", "End\n\n"],
        ["Notes", "End\n\n"],
        ["Notes here", "End\n\nNotes here"],
        ...target.runs.length === 1 ? [["here", "x\n\nhere"], ["here", "x\n\n"]] : [],
      ]) {
        let start = markdown.indexOf(oldMarkdown);
        expectReadsAsWritten(tab, start, start + oldMarkdown.length, newMarkdown);
      }
    }
  });

  describe("list items written through the model", () => {
    let presetList = (numbered = false) =>
      ({ listProperties: { nestingLevels: presetLevels(numbered) } });
    // Two lists as Google makes them for each preset, and one whose level shows no marker.
    let lists: GoogleDocsTab["lists"] = {
      B: presetList(), B2: presetList(), N: presetList(true), N2: presetList(true),
      markerless: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
    };
    let listItem = (text: string, listId: string, nestingLevel = 0) =>
      ({ runs: [`${text}\n`], bullet: { listId, nestingLevel } });
    let listTab = (...blocks: Parameters<typeof buildTab>[0]) => buildTab(blocks, lists);

    /** `expectReadsAsWritten` for the text `oldMarkdown`, which the tab's rendering holds. */
    function expectReplacementReadsAsWritten(
      tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, result?: string,
    ): void {
      let start = docTabToMarkdown(tab).markdown.indexOf(oldMarkdown);
      expect(start).toBeGreaterThanOrEqual(0);
      expectReadsAsWritten(tab, start, start + oldMarkdown.length, newMarkdown, result);
    }

    /**
     * What the model reads once `requests` are applied, the same under each of its options, and
     * the tab it leaves under either setting of what a new cell copies.
     */
    function applied(
      tab: GoogleDocsTab, requests: GoogleDocsRequest[],
    ): { markdown: string; tabs: GoogleDocsTab[] } {
      let { markdown } = docTabToMarkdown(appliedOneWay(tab, requests));
      let tabs = [false, true].map(copyStyles => applyDocsRequests(tab, requests, { copyStyles }));
      return { markdown, tabs };
    }

    /**
     * A replacement of `oldMarkdown`, which the tab's rendering holds: the requests it sends and
     * what the model reads of them.
     */
    function replaced(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): {
      model: string; requests: GoogleDocsRequest[]; tabs: GoogleDocsTab[];
    } {
      let snapshot = docTabToMarkdown(tab);
      let start = snapshot.markdown.indexOf(oldMarkdown);
      expect(start).toBeGreaterThanOrEqual(0);
      let rendered = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
      let { requests } = computeReplaceOperations(
        snapshot.sourceMap, snapshot.markdown, start, start + oldMarkdown.length, rendered, TAB_ID);
      let { markdown, tabs } = applied(tab, requests);
      return { model: markdown, requests, tabs };
    }

    /** An append as approval builds it, and what the model reads of its requests. */
    function appendTo(tab: GoogleDocsTab, markdown: string): {
      requests: GoogleDocsRequest[]; markdown: string; tabs: GoogleDocsTab[];
    } {
      let requests = appendedRequests(docTabToMarkdown(tab), markdown);
      return { requests, ...applied(tab, requests) };
    }

    let bulletRequests = (requests: GoogleDocsRequest[]) => requests.filter(request =>
      "createParagraphBullets" in request || "deleteParagraphBullets" in request);

    it("reads a list written into an empty tab, and after a heading, as it was written", () => {
      expectReadsAsWritten(listTab(para("")), 0, 0, "- a\n- b\n- c");
      expectReplacementReadsAsWritten(
        listTab({ runs: ["Head\n"], namedStyleType: "HEADING_1" }, para("text")), "text", "- a\n- b");
      expectReplacementReadsAsWritten(
        listTab({ runs: ["Head\n"], namedStyleType: "HEADING_1" }), "# Head", "# Head\n\n- a\n- b");
    });

    it("reads a rewritten item of a list whose level has no marker as it was written", () => {
      expectReplacementReadsAsWritten(
        listTab(para("Before"), listItem("Notes", "markerless"), para("End")), "Notes", "Other");
    });

    // Inferred, not on record: the image stays with its paragraph, of which nothing changes.
    it("reads a paragraph deleted in front of a positioned image's paragraph as it was written", () => {
      let tab = listTab(para("O"), para("P"), para("Q"));
      tab.body.content[3].paragraph!.positionedObjectIds = ["kix.img"];
      expectReplacementReadsAsWritten(tab, "O\n\nP", "O");
      let { model, requests, tabs } = replaced(tab, "O\n\nP", "O");

      // The builder deletes the whole paragraph, from its start to the start of the image's.
      expect(requests).toEqual([{ deleteContentRange: { range: rangeOfTab(3, 5) } }]);
      expect(model).toBe("O\n\n[Image] Q\n");
      for (let result of tabs) {
        expect(result.body.content.map(element => element.paragraph?.positionedObjectIds))
          .toEqual([undefined, undefined, ["kix.img"]]);
      }
    });

    it("writes an item as deep as a list item that holds a positioned image, or deeper, and leaves the image where it is", () => {
      // "a" is [1,3), and "b", at level 2 with the image, [3,5).
      let anchored = (...rest: Parameters<typeof buildTab>[0]) => {
        let tab = listTab(listItem("a", "B"), listItem("b", "B", 2), ...rest);
        tab.body.content[2].paragraph!.positionedObjectIds = ["kix.img"];
        return tab;
      };
      let further = () => anchored(listItem("c", "B", 2), para("End"));
      let expectImageOnB = (tabs: GoogleDocsTab[]) => {
        for (let result of tabs) {
          expect(result.body.content.flatMap(({ paragraph }) => paragraph?.positionedObjectIds
            ? [[paragraph.elements.map(part => part.textRun?.content ?? "").join(""),
              paragraph.positionedObjectIds]]
            : [])).toEqual([["b\n", ["kix.img"]]]);
        }
      };
      /** The builders' empty paragraph goes in where "b" ends, never in front of it. */
      let expectEmptyParagraphBehindB = (requests: GoogleDocsRequest[]) => {
        expect(requests.some(request => "insertText" in request &&
          request.insertText.location.index === 5 && /^\t*\n$/.test(request.insertText.text)))
          .toBe(true);
        expect(requests[requests.length - 1]).toEqual(scaffoldDeleted(5));
      };

      let asDeep = appendTo(anchored(), "    - c");
      expect(asDeep.markdown).toBe("- a\n    - [Image] b\n    - c\n");
      expectImageOnB(asDeep.tabs);

      let deeper = appendTo(anchored(), "      - c");
      expect(deeper.markdown).toBe("- a\n    - [Image] b\n      - c\n");
      expectImageOnB(deeper.tabs);
      expectEmptyParagraphBehindB(deeper.requests);

      let nested = replaced(further(), "    - c", "      - c");
      expect(nested.model).toBe("- a\n    - [Image] b\n      - c\n\nEnd\n");
      expectImageOnB(nested.tabs);
      expectEmptyParagraphBehindB(nested.requests);

      // The item's text quoted without its marker.
      let split = replaced(further(), "c", "c\n    - d");
      expect(split.model).toBe("- a\n    - [Image] b\n    - c\n    - d\n\nEnd\n");
      expectImageOnB(split.tabs);

      // A shallower item could only be placed by rewriting "b", so the builders refuse it.
      expect(() => appendTo(anchored(), "  - c")).toThrow(POSITIONED_ITEM_BEFORE);
      expect(() => replaced(further(), "    - c", "  - c")).toThrow(POSITIONED_ITEM_BEFORE);
      expect(() => replaced(further(), "c", "c\n  - d")).toThrow(POSITIONED_ITEM_BEFORE);
    });

    // From here on a tab can read otherwise than the Markdown written: each test asserts what
    // the model reads, which is Google's as recorded.

    // An item bulleted in front of a list starts a list of its own (bullets-never-following).
    it("keeps an item written in front of a list in a list of its own", () => {
      let first = replaced(
        listTab(para("P"), listItem("a", "B"), listItem("b", "B"), para("End")), "- a", "  - a");
      expect(first.model).toBe("P\n\n  - a\n\n- b\n\nEnd\n");
    });

    // A bulleted range joins the list of the item directly before it when the same preset made
    // that list, whichever list its paragraphs were in (bullets-join-same-preset).
    it("joins an item bulleted again to the list of its preset directly in front of it", () => {
      for (let [first, second, other, marker, otherMarker] of [
        ["B", "B2", "N", "- ", "1. "], ["N", "N2", "B", "1. ", "- "],
      ]) {
        let nested = replaced(
          listTab(listItem("a", first), listItem("b", second), para("End")),
          `${marker}b`, `  ${marker}b`);
        expect(nested.requests.filter(request => "createParagraphBullets" in request))
          .toHaveLength(1);
        expect(nested.model).toBe(`${marker}a\n  ${marker}b\n\nEnd\n`);

        // An item the range takes in moves with it: `b`, a level deeper than the item written
        // after it, leaves the second list for the first.
        let taken = replaced(listTab(
          listItem("a", first), listItem("b", second, 1), listItem("c", other), para("End"),
        ), `${otherMarker}c`, `${marker}X`);
        expect(taken.model).toBe(`${marker}a\n  ${marker}b\n${marker}X\n\nEnd\n`);
      }
    });

    // With no bullet request every item stays in its list, and two lists of one preset side by
    // side read with a blank line between them (list-text-edits, bullets-never-following).
    it("keeps two lists apart that an edit brings together, and joins the halves of one", () => {
      for (let [first, second, marker] of [["B", "B2", "- "], ["N", "N2", "1. "]]) {
        let around = () =>
          listTab(listItem("a", first), para("P"), listItem("b", second), para("End"));

        let removed = replaced(around(), "P\n\n", "");
        expect(removed.requests.map(request => Object.keys(request)[0]))
          .toEqual(["deleteContentRange"]);
        expect(removed.model).toBe(`${marker}a\n\n${marker}b\n\nEnd\n`);

        let rewritten = replaced(around(), `P\n\n${marker}b`, `${marker}x`);
        expect(bulletRequests(rewritten.requests)).toEqual([]);
        expect(rewritten.model).toBe(`${marker}a\n\n${marker}x\n\nEnd\n`);

        // The other way round: the two halves of a list that another list parts are one list
        // once that list is gone.
        let halves = replaced(listTab(
          listItem("a", first), listItem("b", second), listItem("c", first), para("End"),
        ), `${marker}a\n\n${marker}b`, `${marker}X`);
        expect(bulletRequests(halves.requests)).toEqual([]);
        expect(halves.model).toBe(`${marker}X\n${marker}c\n\nEnd\n`);
      }

      // The halves of one bulleted list that a paragraph parts read as one list once the
      // paragraph is gone, without the blank line the edit leaves between them.
      expectReplacementReadsAsWritten(
        listTab(listItem("a", "B"), para("P"), listItem("b", "B"), para("End")), "P\n\n", "",
        "- a\n- b\n\nEnd\n");
    });

    // A numbered list a paragraph splits goes on counting by the items in front of the paragraph
    // (bullets-numbering-2).
    it("goes on counting in a numbered list a paragraph splits", () => {
      let split = listTab(listItem("a", "N"), para("b"), listItem("c", "N"), para("End"));
      let fewer = replaced(split, "1. a", "X");
      expect(fewer.model).toBe("X\n\nb\n\n1. c\n\nEnd\n");
      let more = replaced(split, "1. a", "1. a\n1. X");
      expect(more.model).toBe("1. a\n1. X\n\nb\n\n3. c\n\nEnd\n");
    });

    // The second item is split off the first, whose list and level it keeps (list-text-edits).
    it("splits a nested item in two at its level", () => {
      let { model, requests } = replaced(listTab(
        listItem("alpha item", "B"), listItem("inserted sibling", "B"),
        { runs: ["beta ", { text: "bold", style: { bold: true } }, " item\n"],
          bullet: { listId: "B", nestingLevel: 1 } },
        listItem("gamma item", "B", 2), listItem("omega item", "B"),
        listItem("first", "N"), listItem("inner", "N", 1), listItem("second", "N"),
      ), "    - gamma item", "    - gamma\n    - item");

      expect(requests.some(request => "createParagraphBullets" in request)).toBe(false);
      expect(insertedText(requests)).toEqual(["gamma\nitem"]);
      expect(model).toBe(
        "- alpha item\n- inserted sibling\n  - beta **bold** item\n    - gamma\n    - item\n" +
        "- omega item\n\n1. first\n  1. inner\n1. second\n");
    });

    // A text edit leaves an item's bullet and a line break in an item makes two items of its
    // list (list-text-edits); these replacements send nothing else but one nested bullet.
    it("keeps two items rewritten in one replacement in their one list", () => {
      for (let [listId, marker] of [["B", "- "], ["N", "1. "]]) {
        let tab = () => listTab(
          para("P"), listItem("a", listId), listItem("b", listId), listItem("c", listId),
          para("End"));
        let items = (...texts: string[]) => texts.map(text => marker + text).join("\n");
        // Each is the text replaced, the text written and the items Google has.
        let cases = [
          [items("a", "b"), items("x", "y"), items("x", "y", "c")],
          [items("b", "c"), items("y", "z"), items("a", "y", "z")],
          [items("a", "b", "c"), items("x", "y", "z"), items("x", "y", "z")],
          [items("a", "b"), items("x", "y", "w"), items("x", "y", "w", "c")],
          // One quoted item is enough: an item written in front of it, in the middle of the list
          // and at its start, and the item rewritten with another written after it.
          [items("b"), items("new", "b"), items("a", "new", "b", "c")],
          [items("a"), items("new", "a"), items("new", "a", "b", "c")],
          [items("a"), items("x", "y"), items("x", "y", "b", "c")],
        ];
        for (let [oldMarkdown, newMarkdown, googles] of cases) {
          let { model, requests } = replaced(tab(), oldMarkdown, newMarkdown);

          expect(bulletRequests(requests), newMarkdown).toEqual([]);
          expect(model).toBe(`P\n\n${googles}\n\nEnd\n`);
        }
        // With the first of the quoted items left as it is, the tab reads as the Markdown written.
        expectReplacementReadsAsWritten(tab(), items("a", "b"), items("a", "y"));
        expectReplacementReadsAsWritten(tab(), items("a"), items("a", "y"));
      }

      // The same in front of a nested item, which the new item's line break splits.
      let nested = replaced(
        listTab(listItem("a", "B"), listItem("b", "B", 1), para("End")), "  - b", "  - new\n  - b");
      expect(bulletRequests(nested.requests)).toEqual([]);
      expect(nested.model).toBe("- a\n  - new\n  - b\n\nEnd\n");

      // An item rewritten with a nested one under it: the nested item is bulleted by one request.
      let child = replaced(listTab(listItem("a", "B"), para("End")), "- a", "- x\n  - y");
      expect(child.requests.filter(request => "createParagraphBullets" in request)).toHaveLength(1);
      expect(child.model).toBe("- x\n  - y\n\nEnd\n");
      expectReplacementReadsAsWritten(listTab(listItem("a", "B"), para("End")), "- a", "- a\n  - y");

      // An item's text quoted without its marker, and an item after it: one `insertText` splits it.
      let split = replaced(
        listTab(listItem("a", "B"), listItem("c", "B"), para("End")), "c", "c\n- d");
      expect(bulletRequests(split.requests)).toEqual([]);
      expect(split.model).toBe("- a\n- c\n- d\n\nEnd\n");
    });

    // A replacement at the blank line behind an item nests from that item, as an append does.
    it("writes an item at the blank line behind a list item at the level it is written at", () => {
      // The indent of an item at the ninth level.
      let ninthIndent = " ".repeat(16);
      let nested = () => listTab(listItem("p", "B"), listItem("a", "B", 1), para("End"));
      let createdBullets = (startIndex: number, endIndex: number): GoogleDocsRequest => ({
        createParagraphBullets: {
          range: rangeOfTab(startIndex, endIndex), bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });

      // A sibling of the nested item, "a" at [3,5), is bulleted as it is: the requests are an
      // append's behind the same item.
      let sibling = replaced(nested(), "\n\nEnd", "\n  - x\n\nEnd");
      expect(sibling.model).toBe("- p\n  - a\n  - x\n\nEnd\n");
      expect(sibling.requests).toEqual(
        appendTo(listTab(listItem("p", "B"), listItem("a", "B", 1)), "  - x").requests);
      expect(bulletRequests(sibling.requests)).toEqual([
        { deleteParagraphBullets: { range: rangeOfTab(5, 8) } }, createdBullets(5, 8),
      ]);

      // A shallower item takes the nested one into its range, with its level in a tab.
      let top = replaced(nested(), "\n\nEnd", "\n- x\n\nEnd");
      expect(top.model).toBe("- p\n  - a\n- x\n\nEnd\n");
      expect(top.requests.slice(-3)).toEqual(
        [unbulleted(3, 5)[1], textInserted(3, "\t"), createdBullets(3, 8)]);

      // A deeper one is bulleted behind an empty paragraph that carries the nested item's level.
      let child = replaced(nested(), "\n\nEnd", "\n    - x\n\nEnd");
      expect(child.model).toBe("- p\n  - a\n    - x\n\nEnd\n");
      expect(child.requests.slice(-3)).toEqual(
        [textInserted(5, "\t\n"), createdBullets(5, 11), scaffoldDeleted(5)]);

      let several = "\n- x\n  - y\n- z\n\nEnd";
      expect(replaced(nested(), "\n\nEnd", several).model)
        .toBe("- p\n  - a\n- x\n  - y\n- z\n\nEnd\n");
      for (let text of ["\n  - x\n\nEnd", "\n- x\n\nEnd", "\n    - x\n\nEnd", several]) {
        expectReplacementReadsAsWritten(nested(), "\n\nEnd", text);
      }

      let numbered = listTab(listItem("p", "N"), listItem("a", "N", 1), para("End"));
      expect(replaced(numbered, "\n\nEnd", "\n  1. x\n\nEnd").model)
        .toBe("1. p\n  1. a\n  1. x\n\nEnd\n");
      // An item of another kind of list starts a list of its own behind an empty paragraph.
      expect(replaced(nested(), "\n\nEnd", "\n  1. x\n\nEnd").model)
        .toBe("- p\n  - a\n\n  1. x\n\nEnd\n");

      // Behind an item at the ninth level, and a ninth-level item behind a nested one: as a
      // replacement builds them, and as a call replays them.
      let ninth = () => listTab(listItem("p", "B"), listItem("a", "B", 8), para("End"));
      let deep: [GoogleDocsTab, string, string][] = [
        [ninth(), `\n${ninthIndent}- x\n\nEnd`, `- p\n${ninthIndent}- a\n${ninthIndent}- x\n\nEnd\n`],
        [ninth(), "\n  - x\n\nEnd", `- p\n${ninthIndent}- a\n  - x\n\nEnd\n`],
        [nested(), `\n${ninthIndent}- x\n\nEnd`, `- p\n  - a\n${ninthIndent}- x\n\nEnd\n`],
      ];
      for (let [tab, newMarkdown, reads] of deep) {
        expect(replaced(tab, "\n\nEnd", newMarkdown).model).toBe(reads);
        let edit = { type: "replaceText" as const, oldMarkdown: "\n\nEnd", newMarkdown };
        expect(docTabToMarkdown(applyDocEdit(tab, edit)).markdown).toBe(reads);
      }

      // A write of no list item bullets nothing.
      expect(bulletRequests(replaced(nested(), "\n\nEnd", "\n\nplain\n\nEnd").requests)).toEqual([]);

      // Behind the tab's last item, which holds a positioned image: a sibling is bulleted as it
      // is, and a shallower item, placed only by rewriting that item, is refused.
      let anchored = listTab(listItem("p", "B"), listItem("a", "B", 1));
      anchored.body.content[2].paragraph!.positionedObjectIds = ["kix.img"];
      expect(replaced(anchored, "a\n", "a\n  - x\n").model).toBe("- p\n  - [Image] a\n  - x\n");
      expect(() => replaced(anchored, "a\n", "a\n- x\n")).toThrow(POSITIONED_ITEM_BEFORE);
    });

    // No recording shows what Google does with a tenth level, so the builders send none.
    it("refuses a list item written past the ninth level", () => {
      let ninthIndent = " ".repeat(16);
      let tenthIndent = " ".repeat(18);

      // Appended, behind text and to a blank tab, and a paragraph made an item.
      for (let item of [`${tenthIndent}- x`, `${tenthIndent}1. x`]) {
        expect(() => appendTo(listTab(para("P")), item)).toThrow(LIST_LEVEL_TOO_DEEP);
        expect(() => applyDocEdit(listTab(para("")), { type: "appendText", markdown: item }))
          .toThrow(LIST_LEVEL_TOO_DEEP);
      }
      expect(() => replaced(listTab(para("P"), para("t"), para("End")), "t", `${tenthIndent}- t`))
        .toThrow(LIST_LEVEL_TOO_DEEP);

      // Behind an item at the ninth level, a sibling is written and a deeper item is not.
      let ninth = () => listTab(listItem("a", "B", 8));
      expect(() => appendTo(ninth(), `${tenthIndent}- x`)).toThrow(LIST_LEVEL_TOO_DEEP);
      expect(appendTo(ninth(), `${ninthIndent}- x`).markdown)
        .toBe(`${ninthIndent}- a\n${ninthIndent}- x\n`);
      // Seventeen spaces is the ninth level.
      expect(appendTo(listTab(para("P")), `${" ".repeat(17)}- x`).markdown)
        .toBe(`P\n\n${ninthIndent}- x\n`);
      // An item of the tab at the ninth level is taken into a range with its level.
      expect(appendTo(listTab(listItem("a", "B"), listItem("b", "B", 8)), "- x").markdown)
        .toBe(`- a\n${ninthIndent}- b\n- x\n`);

      // Text that reads as a marker that deep is no item, and an edit beside it builds.
      let literal = listTab(para(`${tenthIndent}- lit`), para("x"), para("End"));
      expect(replaced(literal, "x", "y").model).toBe(`${tenthIndent}- lit\n\ny\n\nEnd\n`);

      // At the blank line behind a list item, as a call replays it: the refusal is the
      // builders', whatever the level of the item the write joins.
      let written = (level: number, newMarkdown: string) => applyDocEdit(
        listTab(listItem("p", "B"), listItem("a", "B", level), para("End")),
        { type: "replaceText", oldMarkdown: "\n\nEnd", newMarkdown });
      for (let level of [1, 8]) {
        let refusal = thrownBy(() => written(level, `\n${tenthIndent}- x\n\nEnd`));
        expect(refusal).toBeInstanceOf(Error);
        expect(refusal).not.toBeInstanceOf(DocModelError);
        expect((refusal as Error).message).toBe(LIST_LEVEL_TOO_DEEP);
      }
    });

    /** `without` replaced by nothing, held to the requests of the same text with its line break. */
    function removedWithBreak(tab: GoogleDocsTab, without: string): ReturnType<typeof replaced> {
      let removed = replaced(tab, without, "");
      expect(removed.requests).toEqual(replaced(tab, `${without}\n`, "").requests);
      return removed;
    }

    // The batch is list-text-edits' "a nested item removed", with or without the line break.
    it("removes a list item replaced by nothing with its paragraph, with or without its line break", () => {
      for (let [listId, marker] of [["B", "- "], ["N", "1. "]]) {
        let item = (text: string) => listItem(text, listId);
        let between = listTab(para("P"), item("a"), item("b"), para("End"));

        // Between two items of its list: the paragraph goes, and the list stays whole.
        let middle = removedWithBreak(
          listTab(para("P"), item("a"), item("b"), item("c"), para("End")), `${marker}b`);
        expect(middle.requests).toEqual([{ deleteContentRange: { range: rangeOfTab(5, 7) } }]);
        expect(middle.model).toBe(`P\n\n${marker}a\n${marker}c\n\nEnd\n`);

        // The first item, of the tab and behind a paragraph.
        expect(removedWithBreak(listTab(item("a"), item("b"), para("End")), `${marker}a`).model)
          .toBe(`${marker}b\n\nEnd\n`);
        expect(removedWithBreak(between, `${marker}a`).model).toBe(`P\n\n${marker}b\n\nEnd\n`);

        // The last item: before a paragraph, at the end of the tab, and before a table, where
        // the kept item merges into the paragraph that ends the section.
        expect(removedWithBreak(between, `${marker}b`).model).toBe(`P\n\n${marker}a\n\nEnd\n`);
        expect(removedWithBreak(listTab(item("a"), item("b")), `${marker}b`).model)
          .toBe(`${marker}a\n`);
        let beforeTable = removedWithBreak(
          listTab(item("a"), item("b"), grid(["t"]), para("End")), `${marker}b`);
        expect(beforeTable.requests)
          .toEqual([{ deleteContentRange: { range: rangeOfTab(2, 4) } }]);
        expect(beforeTable.model).toBe(
          `${marker}a\n\n<table>\n  <tr>\n    <td><p>t</p></td>\n  </tr>\n</table>\n\nEnd\n`);

        // Two items quoted to the last one's text.
        let two = `${marker}b\n${marker}c`;
        expect(removedWithBreak(listTab(item("a"), item("b"), item("c")), two).model)
          .toBe(`${marker}a\n`);
        expect(removedWithBreak(listTab(item("a"), item("b"), item("c"), item("d")), two).model)
          .toBe(`${marker}a\n${marker}d\n`);

        // With the paragraph after the list too, the range ends in no item: the empty paragraph
        // the tab keeps is that paragraph's.
        let rest = replaced(between, `${marker}b\n\nEnd`, "");
        expect(bulletRequests(rest.requests)).toEqual([]);
        expect(rest.model).toBe(`P\n\n${marker}a\n\n\n`);
        expectEmptyParagraphAt(rest.tabs, 2);
        // The same in front of a further paragraph, whose line break could go.
        let further = listTab(para("P"), item("a"), item("b"), para("End"), para("Z"));
        expect(replaced(further, `${marker}b\n\nEnd`, "").model)
          .toBe(`P\n\n${marker}a\n\n\n\nZ\n`);
      }

      // A paragraph or a heading quoted from its start goes with the items behind it.
      for (let [first, quoted] of [
        [para("P"), "P"], [{ ...para("H"), namedStyleType: "HEADING_2" }, "## H"],
      ] as const) {
        let lines = removedWithBreak(
          listTab(first, listItem("a", "B"), listItem("b", "B")), `${quoted}\n\n- a`);
        expect(lines.requests).toEqual([{ deleteContentRange: { range: rangeOfTab(1, 5) } }]);
        expect(lines.model).toBe("- b\n");
      }
      // A range that starts inside the paragraph leaves what is before it.
      let inside = replaced(
        listTab(para("Pq"), listItem("a", "B"), listItem("b", "B")), "q\n\n- a", "");
      expect(inside.model).toBe("P\n\n- b\n");

      // The text a replacement keeps on both sides is not part of the change.
      let kept = listTab(para("P"), listItem("a", "B"), listItem("b", "B"), para("End"));
      let whole = replaced(kept, "- b\n", "");
      expect(whole.model).toBe("P\n\n- a\n\nEnd\n");
      expect(replaced(kept, "- b\n\nEnd", "\n\nEnd").requests).toEqual(whole.requests);
      expect(replaced(kept, "- b\n", "\n").requests).toEqual(whole.requests);
    });

    // A caller may leave a nested item's indentation out of the text it quotes.
    it("removes a nested list item quoted from its marker with its paragraph", () => {
      for (let [listId, marker] of [["B", "- "], ["N", "1. "]]) {
        let item = (text: string, level = 0) => listItem(text, listId, level);

        let middle = listTab(item("a"), item("b", 1), item("c"), para("End"));
        let line = replaced(middle, `  ${marker}b\n`, "");
        expect(line.requests).toEqual([{ deleteContentRange: { range: rangeOfTab(3, 5) } }]);
        for (let quoted of [`${marker}b`, ` ${marker}b`, `  ${marker}b`]) {
          let removed = replaced(middle, quoted, "");
          expect(removed.requests).toEqual(line.requests);
          expect(removed.model).toBe(`${marker}a\n${marker}c\n\nEnd\n`);
        }

        let pair = listTab(item("a"), item("b", 1), item("c", 1), item("d"), para("End"));
        let two = replaced(pair, `${marker}b\n  ${marker}c`, "");
        expect(two.requests).toEqual(replaced(pair, `  ${marker}b\n  ${marker}c\n`, "").requests);
        expect(two.model).toBe(`${marker}a\n${marker}d\n\nEnd\n`);

        // The last item of the tab, behind an item of its level: the two merge.
        expect(replaced(listTab(item("a", 1), item("b", 1)), `${marker}b`, "").model)
          .toBe(`  ${marker}a\n`);

        // Behind an item of another level the line break cannot go, and the whole line goes
        // without it: no paragraph of spaces stays.
        let deeper = listTab(item("a"), item("b", 1));
        expect(() => replaced(deeper, `  ${marker}b\n`, "")).toThrow(
          "cannot keep a list item while deleting the paragraphs that end its section");
        let last = replaced(deeper, `${marker}b`, "");
        expect(last.requests).toEqual(replaced(deeper, `  ${marker}b`, "").requests);
        expect(last.model).toBe(`${marker}a\n\n\n`);
        expectEmptyParagraphAt(last.tabs, 1);
      }

      // Quoted from its marker with its line break, the item is cut out of the Markdown as it
      // reads, and the next line takes the indentation left behind.
      let spliced = replaced(
        listTab(listItem("a", "B"), listItem("b", "B", 1), listItem("c", "B"), para("End")),
        "- b\n", "");
      expect(spliced.model).toBe("- a\n  - c\n\nEnd\n");
      // An item of its level there is nested that much deeper, or refused past the ninth level,
      // and a blank line or the end of the tab keeps a paragraph of those spaces.
      let siblings = (level: number) => listTab(
        listItem("a", "B"), listItem("b", "B", level), listItem("c", "B", level), para("End"));
      expect(replaced(siblings(1), "- b\n", "").model).toBe("- a\n    - c\n\nEnd\n");
      expect(() => replaced(siblings(5), "- b\n", "")).toThrow(LIST_LEVEL_TOO_DEEP);
      expect(replaced(siblings(5), "- b", "").model).toBe(`- a\n${" ".repeat(10)}- c\n\nEnd\n`);
      let beforeBlank = listTab(listItem("a", "B"), listItem("b", "B", 1), para("End"));
      expect(replaced(beforeBlank, "- b\n", "").model).toBe("- a\n\n  \n\nEnd\n");
      let endsTab = listTab(listItem("a", "B", 1), listItem("b", "B", 1));
      expect(replaced(endsTab, "- b\n", "").model).toBe("  - a\n\n  \n");
      // A paragraph whose text reads as a nested item is no list item's line.
      let plain = replaced(listTab(para("P"), para("  - b"), para("End")), "- b", "");
      expect(plain.model).toBe("P\n\n  \n\nEnd\n");
      // Nor are the spaces a paragraph starts with an item's indentation: they stay.
      let spaces = replaced(
        listTab(para("  x"), listItem("a", "B"), listItem("b", "B")), "x\n\n- a", "");
      expect(spaces.model).toBe("  \n\n- b\n");
      // An item's text quoted without its marker is emptied: the marker lies before the range,
      // so the item stays, at its level.
      let emptied = replaced(
        listTab(
          para("P"), listItem("a", "B"), listItem("b", "B"), listItem("c", "B"), para("End")),
        "b", "");
      expect(emptied.model).toBe("P\n\n- a\n- \n- c\n\nEnd\n");
      let emptiedNested = replaced(
        listTab(listItem("a", "B"), listItem("b", "B", 1), listItem("c", "B"), para("End")),
        "b", "");
      expect(emptiedNested.model).toBe("- a\n  - \n- c\n\nEnd\n");
    });

    // Where the replacement with the line break is refused, or pulls no line in beside the item.
    it("leaves an empty paragraph where a list item's line break cannot go with it", () => {
      // Before a table as at the end of the tab.
      let table = "<table>\n  <tr>\n    <td><p>t</p></td>\n  </tr>\n</table>";
      let beforeTable = listTab(
        listItem("a", "B"), listItem("b", "B", 1), grid(["t"]), para("End"));
      expect(() => replaced(beforeTable, "  - b\n", "")).toThrow(
        "cannot keep a list item while deleting the paragraphs that end its section");
      expect(replaced(beforeTable, "  - b", "").model).toBe(`- a\n\n\n\n${table}\n\nEnd\n`);
      // Behind an item of another list, the line break quoted or not.
      let otherList = listTab(listItem("a", "B"), listItem("b", "B2"));
      expect(removedWithBreak(otherList, "- b").model).toBe("- a\n\n\n");
      expect(() => replaced(otherList, "\n\n- b", "")).toThrow(
        "cannot keep a list item while deleting the paragraphs that end its section");

      // The line break of an item in front of one that holds a chip cannot be edited.
      let chip = listTab(
        listItem("a", "B"), listItem("b", "B"),
        { runs: ["c ", { date: "Jan 5, 2026" }, "\n"], bullet: { listId: "B", nestingLevel: 0 } },
        para("End"));
      expect(() => replaced(chip, "- b\n", "")).toThrow("structured content cannot be edited");
      expect(replaced(chip, "- b", "").model).toBe("- a\n\n\n\n- c Jan 5, 2026\n\nEnd\n");
      // Nor can the line break of the last item in front of a paragraph that holds one.
      let chipAfter = listTab(
        listItem("a", "B"), listItem("b", "B"),
        { runs: ["c ", { date: "Jan 5, 2026" }, "\n"] }, para("End"));
      expect(() => replaced(chipAfter, "- b\n", "")).toThrow("structured content cannot be edited");
      expect(replaced(chipAfter, "- b", "").model).toBe("- a\n\n\n\nc Jan 5, 2026\n\nEnd\n");

      // The only item of its list has a blank line on both sides, so no line is pulled in.
      let only = listTab(para("P"), listItem("a", "B"), para("End"));
      let alone = removedWithBreak(only, "- a");
      expect(alone.model).toBe("P\n\n\n\nEnd\n");
      expectEmptyParagraphAt(alone.tabs, 1);
      // Taking the blank line after it, or the two line breaks before the tab's last paragraph,
      // removes that paragraph too.
      expect(replaced(only, "- a\n\n", "").model).toBe("P\n\nEnd\n");
      let ending = listTab(para("P"), listItem("b", "B"));
      expect(replaced(ending, "\n\n- b", "").model).toBe("P\n");
      expect(replaced(ending, "\n- b", "").model).toBe("P\n\n\n");
    });

    it("lets a fault of the builders through where it tries a removed item's line break", () => {
      let snapshot = docTabToMarkdown(listTab(
        para("P"), listItem("a", "B"), listItem("b", "B"), listItem("c", "B"), para("End")));
      // The second question is the check of the range with the line break.
      let asked = 0;
      let protectedRanges = new Proxy(snapshot.sourceMap.protectedRanges, {
        get(target, key, receiver) {
          if (key === "some" && ++asked === 2) throw new TypeError("a fault");
          return Reflect.get(target, key, receiver);
        },
      });
      let start = snapshot.markdown.indexOf("- b");
      expect(() => computeReplaceOperations(
        { ...snapshot.sourceMap, protectedRanges }, snapshot.markdown, start, start + "- b".length,
        "", TAB_ID,
      )).toThrow(TypeError);
    });

    let cleared = (start: number, end: number) => ({ updateTextStyle: {
      range: rangeOfTab(start, end), textStyle: {}, fields: "bold,italic,strikethrough,link",
    } });

    // `createParagraphBullets` strips a bulleted paragraph's leading tabs, so an item is bulleted
    // without its text's tabs and they are written afterwards (recorded: tab-starts-new-list-item).
    it("writes the tab a new item's text starts with once its bullet is made", () => {
      let made = replaced(listTab(para("P"), para("\tfoo"), para("End")), "\tfoo", "- \tfoo");
      expect(made.model).toBe("P\n\n- \tfoo\n\nEnd\n");
      expect(made.requests).toContainEqual(textInserted(3, "foo"));
      expect(made.requests.slice(-3)).toEqual([
        expect.objectContaining({
          createParagraphBullets: expect.objectContaining({ range: rangeOfTab(3, 7) }),
        }),
        textInserted(3, "\t"), cleared(3, 4),
      ]);
      expect(replaced(listTab(para("P"), para("foo"), para("End")), "foo", "- \tfoo").model)
        .toBe("P\n\n- \tfoo\n\nEnd\n");

      // The text canonicalised for an append's write keeps the tab, so it reaches the builders.
      expect(canonicalizeMarkdownForWrite("- a\n- \tb")).toBe("- a\n- \tb");

      // A run of levels: each item is laid out behind its level's tabs alone, one bullet request
      // makes them all, and the tabs of their texts go in last item first.
      let run = appendTo(listTab(para("P")), "- a\n  - \tb\n    - \t\tc\n- \td");
      expect(run.markdown).toBe("P\n\n- a\n  - \tb\n    - \t\tc\n- \td\n");
      expect(run.requests[0]).toEqual(textInserted(2, "\na\n\tb\n\t\tc\nd"));
      let created = run.requests.filter(request => "createParagraphBullets" in request);
      expect(created).toEqual([expect.objectContaining({
        createParagraphBullets: expect.objectContaining({ range: rangeOfTab(3, 14) }),
      })]);
      expect(run.requests.slice(-7)).toEqual([
        created[0],
        textInserted(9, "\t"), cleared(9, 10),
        textInserted(7, "\t\t"), cleared(7, 9),
        textInserted(5, "\t"), cleared(5, 6),
      ]);

      // The tabs keep the look they are written with, whatever the text beside them has.
      for (let text of ["- **\t**b", "- \t**b**", "- **\tb**", "- ~~\t~~b"]) {
        expect(appendTo(listTab(para("P")), text).markdown).toBe(`P\n\n${text}\n`);
      }

      // An item that is only a tab, and a tab that holds nothing else.
      expect(appendTo(listTab(para("P")), "- \t").markdown).toBe("P\n\n- \t\n");
      expect(docTabToMarkdown(applyDocEdit(listTab(para("")), {
        type: "appendText", markdown: "- \tx\n  - \ty",
      })).markdown).toBe("- \tx\n  - \ty\n");

      // An item of the tab written again at another level.
      expect(replaced(listTab(listItem("a", "B"), listItem("\tb", "B"), para("End")),
        "- \tb", "  - \tb").model).toBe("- a\n  - \tb\n\nEnd\n");
      expect(replaced(listTab(listItem("a", "B"), listItem("\tb", "B", 1), para("End")),
        "  - \tb", "- \tb").model).toBe("- a\n- \tb\n\nEnd\n");

      // At the blank line behind an item.
      expect(replaced(listTab(listItem("p", "B"), listItem("\ta", "B", 1), para("End")),
        "\n\nEnd", "\n  - \tx\n\nEnd").model).toBe("- p\n  - \ta\n  - \tx\n\nEnd\n");

      // At the ninth level, where the tabs of the level and of the text together pass nine.
      let deep = " ".repeat(16);
      expect(appendTo(listTab(para("P")), `${deep}- \tx`).markdown).toBe(`P\n\n${deep}- \tx\n`);
      expect(appendTo(listTab(para("P")), `- a\n${deep}- \t\tx\n- b`).markdown)
        .toBe(`P\n\n- a\n${deep}- \t\tx\n- b\n`);
    });

    // An item a shallower new item takes into its range is bulleted again, and its own tabs are
    // written back once the bullets are made; the recording tab-item-bulleted-again pins the rest.
    it("writes back the tabs of an item it bullets again", () => {
      let B = (text: string, level = 0) => listItem(text, "B", level);
      let between = (item: BlockSpec) => listTab(B("a"), B("x", 1), item, B("c", 1), para("End"));

      // Two tabs over its level are both deleted.
      expect(replaced(
        between(B("\t\t\tb", 1)), "  - x\n  - \t\t\tb\n  - c", "  - y\n  - \t\t\tb\n- c",
      ).model).toBe("- a\n  - y\n  - \t\t\tb\n- c\n\nEnd\n");

      // Several in one range, with new items that start with tabs behind them.
      expect(replaced(
        listTab(B("a"), B("x", 1), B("\tb", 1), B("\t\tc", 2), B("d", 2), para("End")),
        "  - x\n  - \tb\n    - \t\tc\n    - d", "  - y\n  - \tb\n    - \t\tc\n- \td\n  - \te",
      ).model).toBe("- a\n  - y\n  - \tb\n    - \t\tc\n- \td\n  - \te\n\nEnd\n");

      // An item that keeps its bullet keeps its tab too, so the tab of the item written behind it
      // goes in where that item's text starts.
      expect(replaced(listTab(B("\tb"), para("End")), "- \tb", "- \tb\n  - \tc").model)
        .toBe("- \tb\n  - \tc\n\nEnd\n");

      // A heading in the item: the tab is written back as a plain paragraph's text, so no
      // paragraph style follows it.
      let heading = replaced(listTab(B("a"), B("\tb", 1), B("c", 1), para("End")),
        "  - \tb\n  - c", "  - # \tb\n- c");
      expect(heading.model).toBe("- a\n  - # \tb\n- c\n\nEnd\n");
      expect(heading.requests.slice(
        heading.requests.findLastIndex(request => "createParagraphBullets" in request) + 1,
      )).toEqual([textInserted(3, "\t"), cleared(3, 4)]);

      // At the ninth level.
      let deep = " ".repeat(16);
      expect(replaced(
        listTab(B("a"), B("x", 8), B("\tb", 8), B("c", 8), para("End")),
        `${deep}- x\n${deep}- \tb\n${deep}- c`, `${deep}- y\n${deep}- \tb\n- c`,
      ).model).toBe(`- a\n${deep}- y\n${deep}- \tb\n- c\n\nEnd\n`);
    });

    // The tab would be read as nesting and removed, and the item stands before the lines the
    // change writes, so nothing writes the tab back.
    it("refuses a new item that would bullet again an item before the lines it changes whose text starts with a tab", () => {
      let taken = () => listTab(listItem("a", "B"), listItem("\tb", "B", 1));
      let ended = (...items: BlockSpec[]) => listTab(listItem("a", "B"), ...items, para("End"));
      expect(docTabToMarkdown(taken()).markdown).toBe("- a\n  - \tb\n");
      expect(docTabToMarkdown(taken()).sourceMap.blocks.map(block => block.tabbed))
        .toEqual([undefined, true]);
      expect(() => appendTo(taken(), "- c")).toThrow(TABBED_ITEM_BEFORE);
      expect(() => appendTo(taken(), "- \tc")).toThrow(TABBED_ITEM_BEFORE);
      // At the blank line behind it.
      expect(() => replaced(ended(listItem("\tb", "B", 1)), "\n\nEnd", "\n- c\n\nEnd"))
        .toThrow(TABBED_ITEM_BEFORE);
      // A line both texts share is not part of the change.
      expect(() => replaced(ended(listItem("\tb", "B", 1), listItem("c", "B", 1)),
        "  - \tb\n  - c", "  - \tb\n- c")).toThrow(TABBED_ITEM_BEFORE);
      // An item further up.
      expect(() => replaced(ended(listItem("\tb", "B", 2), listItem("c", "B", 1)),
        "  - c", "  - c\n- d")).toThrow(TABBED_ITEM_BEFORE);

      // The same item changed by the call is one of the lines written, and keeps its tab.
      expect(replaced(ended(listItem("\tb", "B", 1)), "  - \tb", "  - \tB\n- c").model)
        .toBe("- a\n  - \tB\n- c\n\nEnd\n");
      // At its level and deeper it is not taken in.
      expect(appendTo(taken(), "  - c").markdown).toBe("- a\n  - \tb\n  - c\n");
      expect(appendTo(taken(), "    - c").markdown).toBe("- a\n  - \tb\n    - c\n");
      // An item with a tab anywhere but at the start of its text is taken in.
      expect(appendTo(listTab(listItem("a", "B"), listItem("x\ty", "B", 1)), "- c").markdown)
        .toBe("- a\n  - x\ty\n- c\n");
      // A paragraph that is no list item is never taken in.
      expect(appendTo(listTab(para("\tp")), "- c").markdown).toBe("\tp\n\n- c\n");
    });

    it("writes a tab into a list item as it is where no bullet is made", () => {
      /**
       * The replacement's requests and reading. It makes no bullet, and once its text is written
       * or deleted it sends styles alone.
       */
      let styledOnly = (tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string) => {
        let { requests, model } = replaced(tab, oldMarkdown, newMarkdown);
        expect(bulletRequests(requests)).toEqual([]);
        let written = requests.findLastIndex(request =>
          "insertText" in request || "deleteContentRange" in request);
        expect(requests.slice(written + 1).filter(request =>
          !("updateParagraphStyle" in request || "updateTextStyle" in request))).toEqual([]);
        return { requests, model };
      };

      expect(styledOnly(listTab(listItem("\tb", "B"), listItem("c", "B"), para("End")),
        "- \tb\n- c", "- \tx\n- y").model).toBe("- \tx\n- y\n\nEnd\n");
      let one = () => listTab(listItem("\tb", "B"), para("End"));
      expect(styledOnly(one(), "- \tb", "- \tc").model).toBe("- \tc\n\nEnd\n");
      expect(styledOnly(one(), "- \tb", "- \tb\n- c").model).toBe("- \tb\n- c\n\nEnd\n");
      expect(styledOnly(one(), "- \tb", "- # \tb").model).toBe("- # \tb\n\nEnd\n");
      expect(styledOnly(one(), "- \tb", "- **\tb**").model).toBe("- **\tb**\n\nEnd\n");

      // An item split off an item is written with its tab, into a paragraph that takes the bullet.
      let split = styledOnly(listTab(listItem("a", "B"), para("End")), "- a", "- a\n- \tb");
      expect(split.requests[0]).toEqual(textInserted(2, "\n\tb"));
      expect(split.model).toBe("- a\n- \tb\n\nEnd\n");

      // The tab removed, and a tab anywhere else in an item.
      expect(styledOnly(listTab(listItem("a", "B"), listItem("\tb", "B", 1), para("End")),
        "  - \tb", "  - b").model).toBe("- a\n  - b\n\nEnd\n");
      expect(appendTo(listTab(para("P")), "- a\tb").markdown).toBe("P\n\n- a\tb\n");
    });
  });
});
