/// <reference types="node" />
import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, Table, TableCell, TextStyle,
} from "../src/docs-api";
import {
  applyMarkdownEdit, assertMarkdownRangeEditable, canonicalizeMarkdownAppend,
  canonicalizeMarkdownForWrite, canonicalizeMarkdownReplacement, canonicalLinkDestination,
  cellInlineHtml, cellLinkDestination, computeReplaceOperations, docsLinkForDestination,
  docTabToMarkdown, MARKDOWN_RENDERING_VERSION, markdownToDocRequests, packTableRow,
  plainTextToDocRequests, REPLAYABLE_TEXT_EDIT_VERSIONS, StructuredContentError,
  stripUnwritableCharacters, tableRowCells, tableRowIndexes,
} from "../src/markdown-converter";
import type {
  CellInlineRun, DocTabSnapshot, EditableMarkdown, MarkdownRange, Segment, TableCellEntry,
  TableMapping,
} from "../src/markdown-converter";
import { BULLET_LIST, buildTab, cellTab, CHECK_LIST } from "./doc-fixture";

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

  function splitEdit(text: string, style: TextStyle, old: string, next: string) {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [{ text, style }, "\n"] }]));
    let start = snapshot.markdown.indexOf(old);
    return applyMarkdownEdit(
      {
        markdown: snapshot.markdown,
        protectedRanges: snapshot.sourceMap.protectedRanges,
        tables: snapshot.sourceMap.tables,
      },
      start, start + old.length, canonicalizeMarkdownReplacement(old, next),
    ).markdown;
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

/** The rendering of a paragraph, a table of four cells and another paragraph. */
function tableBetweenParagraphs(before: string, cell: string): string {
  return docTabToMarkdown(buildTab([
    { runs: [`${before}\n`] },
    { table: [["Field\n", `${cell}\n`], ["Name\n", "yes\n"]] },
    { runs: ["After\n"] },
  ])).markdown;
}

describe("canonicalizeMarkdownAppend", () => {
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
  ])("appends without rewriting what is there: %s", (_name, markdown, appended) => {
    expect(canonicalizeMarkdownForWrite(appended)).toBe(appended);
    expect(markdown).toContain("  </tr>\n  <tr>\n    <td><p>Name</p></td>\n");

    expect(canonicalizeMarkdownAppend(markdown, appended)).toBe(`${markdown}\n${appended}\n`);
    // The replacement pairs the tab's unmatched token with the appended one and writes
    // everything from that token on again, as paragraphs.
    expect(wholeTabReplacement(markdown, appended))
      .toContain("  </tr>\n\n  <tr>\n\n    <td><p>Name</p></td>\n\n");
  });

  const TAILS = ["base\n", "base\n\n\n", "base", "base\n\n", "- one\n", "1. one\n", "\n"];
  const APPENDED = [
    "added", "- two", "1. two", "# H", "a\n\nb", "x\n\n\n\ny", "   ", "", "\n\nlead", "trail\n\n",
  ];

  it("separates an append as a replacement of the whole tab does", () => {
    for (let tail of TAILS) {
      for (let text of APPENDED) {
        let appended = canonicalizeMarkdownForWrite(text);
        let result = canonicalizeMarkdownAppend(tail, appended);

        expect([tail, text, result]).toEqual([tail, text, wholeTabReplacement(tail, appended)]);
        expect(result.startsWith(tail)).toBe(true);
      }
    }
    expect(canonicalizeMarkdownAppend("- one\n", "- two")).toBe("- one\n- two\n");
    expect(canonicalizeMarkdownAppend("1. one\n", "- two")).toBe("1. one\n\n- two\n");
    expect(canonicalizeMarkdownAppend("base\n\n", "added")).toBe("base\n\n\n\nadded\n");
  });

  it("keeps a last line the tab left unterminated", () => {
    expect(canonicalizeMarkdownAppend("a]\nPlain", "")).toBe("a]\nPlain\n\n\n");
    // The replacement of the whole tab would double the line break between the two lines.
    expect(wholeTabReplacement("a]\nPlain", "")).not.toBe("a]\nPlain\n\n\n");
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
    if (line === "  <tr>") rows.push([]);
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

/** Every editable text the map lists for a table, read through the map's accessors. */
function mappedTexts(snapshot: DocTabSnapshot, index = 0): MappedText[] {
  let table = snapshot.sourceMap.tables[index];
  let blocks = cellBlocks(snapshot.markdown, table);
  let texts: MappedText[] = [];
  table.rows.forEach((_, row) => {
    let indexes = tableRowIndexes(table, row);
    tableRowCells(table, row).forEach((cell, column) => {
      let cellStart = blocks[row][column].mdStart;
      cell.texts.forEach(([start, end], text) => texts.push({
        row, column,
        mdStart: cellStart + start,
        html: snapshot.markdown.slice(cellStart + start, cellStart + end),
        paragraph: indexes.cells[column].paragraphs[text],
      }));
    });
  });
  return texts;
}

/** The start index of every paragraph in a fixture table's cells, in document order. */
function fixtureParagraphStarts(table: Table): number[] {
  return (table.tableRows ?? []).flatMap(row => (row.tableCells ?? []).flatMap(cell =>
    (cell.content ?? []).flatMap(element => element.paragraph ? [element.startIndex] : [])));
}

/** The map of a tab's first table. */
function firstTableMap(tab: GoogleDocsTab): TableMapping {
  return docTabToMarkdown(tab).sourceMap.tables[0];
}

/** What the map says of the cells of the first row of a tab's first table. */
function firstRowCells(tab: GoogleDocsTab): TableCellEntry[] {
  return tableRowCells(firstTableMap(tab), 0);
}

/** A cell holding one item of list `listId`. */
function listItemCell(listId: string) {
  return { paragraphs: [{ runs: ["Item\n"], bullet: { listId } }] };
}

/** A cell holding one paragraph of the given named style. */
function styledCell(namedStyleType: string) {
  return { paragraphs: [{ runs: ["Text\n"], namedStyleType }] };
}

/** The HTML each table's range names in a rendering. */
function tableHtmls({ markdown, tables }: EditableMarkdown): string[] {
  return tables.map(table => markdown.slice(table.mdStart, table.mdEnd));
}

/** One of `INLINE_STYLES` as the run `cellInlineHtml` takes for `text`. */
function inlineRun([, style]: (typeof INLINE_STYLES)[number], text: string): CellInlineRun {
  return {
    text,
    bold: style.bold,
    italic: style.italic,
    strikethrough: style.strikethrough,
    link: style.link && "url" in style.link ? style.link.url : undefined,
  };
}

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
    expect(table.rows).toEqual([[32, 11, 15, 32, 11, 15], [32, 11, 15, 32, 11, 15]]);
    expect(table.docRows).toEqual([[10, 6, 1, 6, 1], [23, 6, 1, 6, 1]]);
    expect("suggested" in table).toBe(false);
    expect("pinnedRows" in table).toBe(false);

    let rows = fixtureTable(tab, 3).tableRows ?? [];
    expect(rows).toHaveLength(2);
    rows.forEach((row, index) => {
      expect(tableRowIndexes(table, index)).toEqual({
        docStart: row.startIndex,
        docEnd: row.endIndex,
        cells: (row.tableCells ?? []).map(cell => ({
          docStart: cell.startIndex,
          docEnd: cell.endIndex,
          paragraphs: (cell.content ?? []).map(paragraph => paragraph.startIndex),
        })),
      });
    });
    expect(tableRowIndexes(table, 0)).toEqual({
      docStart: 10,
      docEnd: 23,
      cells: [
        { docStart: 11, docEnd: 17, paragraphs: [12] },
        { docStart: 17, docEnd: 23, paragraphs: [18] },
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
    expect(around(texts[0], 3, 4)).toBe("<p>One</p>");
    expect(around(texts[2], 3, 4)).toBe("<p></p>");
    expect(around(texts[4], 4, 5)).toBe("<h2>Heading</h2>");
    expect(around(texts[5], 6, 5)).toBe("<li>● Dot</li>");
    expect(around(texts[6], 8, 4)).toBe("<ol><li>Step<ol>");
    expect(around(texts[7], 8, 10)).toBe("<ol><li>Sub</li></ol>");
    expect(around(texts[8], 9, 10)).toBe("</li><li>Next</li></ol>");
    expect(around(texts[9], 10, 10)).toBe("<li><h3>● Section</h3></li>");

    expect(inLine(texts[10])).toEqual([
      `    <td>${SKIPPED_LEVEL}${SKIPPED_LEVEL}<ol><li>`, "Deep",
      "</li></ol></li></ul></li></ul></td>",
    ]);
    expect(inLine(texts[11])).toEqual(["      <p>", "Intro", "</p>"]);
    expect(inLine(texts[12])).toEqual([
      `      ${SKIPPED_LEVEL}<ol><li>`, "Inner", "</li></ol></li></ul>",
    ]);
    expect(inLine(texts[13])).toEqual([
      "    <td><ol><li>", "Top", `${SKIPPED_LEVEL}<ol><li>Low</li></ol></li></ul></li></ol></td>`,
    ]);
    expect(inLine(texts[14])).toEqual([
      `    <td><ol><li>Top${SKIPPED_LEVEL}<ol><li>`, "Low", "</li></ol></li></ul></li></ol></td>",
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

  it("lists no text for cells it cannot edit", () => {
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
    expect(table.rows.map((_, row) => tableRowCells(table, row).map(cell => cell.texts.length)))
      .toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 1]]);
    expect(mappedTexts(snapshot).map(text => text.html)).toEqual(["free", "free too", "Plain"]);
    expect(mappedTexts(snapshot).map(text => text.paragraph)).toEqual([
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
      .toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
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
    let emptied = docTabToMarkdown(empty).sourceMap.tables;

    expect(ends.markdown.startsWith("<table>\n")).toBe(true);
    expect(ends.markdown.endsWith("</table>\n")).toBe(true);
    expect(ends.sourceMap.tables.map(table => table.mdStart)).toEqual([
      0, ends.markdown.lastIndexOf("<table>"),
    ]);
    expect(mappedTexts(ends, 0).concat(mappedTexts(ends, 1)).map(text => text.html))
      .toEqual(["first", "last"]);
    expect([emptied[0].rows, emptied[0].docRows]).toEqual([[], []]);
    expect([emptied[1].rows, emptied[1].docRows]).toEqual([[[]], [[18]]]);
    expect(tableRowCells(emptied[1], 0)).toEqual([]);
    expect(tableRowIndexes(emptied[1], 0)).toEqual({ docStart: 18, docEnd: 19, cells: [] });
  });

  it("shares one element between adjacent runs formatted alike", () => {
    let bold = { bold: true };
    let struck = { strikethrough: true };
    let link = { link: { url: "https://e.com" } };

    expect(singleCellHtml(cellTab([{ runs: [
      { text: "Hello ", style: bold }, { text: "World", style: bold }, "\n",
    ] }]))).toBe("<td><p><strong>Hello World</strong></p></td>");
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "Hello ", style: bold }, { text: "World", style: { bold: true, italic: true } }, "\n",
    ] }]))).toBe("<td><p><strong>Hello </strong><strong><em>World</em></strong></p></td>");
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "Read ", style: link }, { text: "this", style: link }, "\n",
    ] }]))).toBe('<td><p><a href="https://e.com">Read this</a></p></td>');
    expect(singleCellHtml(cellTab([{ runs: [
      { text: "old", style: struck }, " new ", { text: "gone", style: struck },
      { text: " too", style: struck }, "\n",
    ] }]))).toBe("<td><p><s>old</s> new <s>gone too</s></p></td>");
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

  it("writes a text-only cell paragraph as cellInlineHtml writes its runs", () => {
    for (let first of INLINE_STYLES) {
      for (let second of INLINE_STYLES) {
        let snapshot = docTabToMarkdown(cellTab([{ runs: [
          { text: "A<", style: first[1] }, { text: "&\u000bB", style: second[1] },
          { text: "C", style: second[1] }, "\n",
        ] }]));

        expect([first[0], second[0], mappedTexts(snapshot).map(text => text.html)]).toEqual([
          first[0], second[0],
          [cellInlineHtml([
            inlineRun(first, "A<"), inlineRun(second, "&\u000bB"), inlineRun(second, "C"),
          ])],
        ]);
      }
    }
    expect(cellInlineHtml([
      { text: "", bold: true }, { text: "a", bold: true }, { text: "", italic: true },
      { text: "b<", bold: true, italic: false }, { text: "c", link: "https://e.com/?a=1&b=\"2\"" },
      { text: "d\u000be", strikethrough: true, italic: true, bold: true, link: "?tab=t.1" },
    ])).toBe(
      "<strong>ab&lt;</strong>" +
      '<a href="https://e.com/?a=1&amp;b=&quot;2&quot;">c</a>' +
      '<a href="?tab=t.1"><strong><em><s>d<br>e</s></em></strong></a>');
    expect(cellInlineHtml([
      { text: "old", strikethrough: true }, { text: " new " },
      { text: "kept", strikethrough: false },
      { text: " gone", strikethrough: true }, { text: " too", strikethrough: true },
    ])).toBe("<s>old</s> new kept<s> gone too</s>");
    expect(cellInlineHtml([])).toBe("");
  });

  it("packs and unpacks a row", () => {
    let plain = {
      numbered: false, footnote: false, styled: false, loneChip: false, unshown: false,
    };
    let cells: TableCellEntry[] = [
      { ...plain, texts: [[11, 15]] },
      { ...plain, texts: [], numbered: true },
      { ...plain, texts: [[9, 12], [20, 20]] },
      { ...plain, texts: [], footnote: true },
      { ...plain, texts: [[11, 15]], numbered: true, footnote: true },
      { ...plain, texts: [], styled: true, loneChip: true },
      { ...plain, texts: [], styled: true },
      { ...plain, texts: [], loneChip: true },
      { ...plain, texts: [[11, 15]], unshown: true },
      { ...plain, texts: [], loneChip: true, unshown: true },
    ];
    let row = packTableRow(cells);

    expect(row).toEqual(
      [32, 11, 15, 1, 64, 9, 12, 20, 20, 2, 35, 11, 15, 12, 4, 8, 48, 11, 15, 24]);
    expect(tableRowCells({ mdStart: 0, mdEnd: 0, rows: [row] }, 0)).toEqual(cells);
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
    let cells = tableRowCells(snapshot.sourceMap.tables[0], 0);

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

  it("marks the cells that hold a chip alone", () => {
    let tab = buildTab([{ table: [[
      { paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, "\n"] }] },
      { paragraphs: [{ runs: [{ date: "Sep 16, 2026" }, "\n"] }] },
      { paragraphs: [{ runs: [RICH_LINK, "\n"] }] },
      "\uE907\n",
      { paragraphs: [{ runs: ["Owner: ", PERSON, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, " owns it\n"] }] },
      { paragraphs: [{ runs: ["Owner\n"] }, { runs: [PERSON, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, "\n"] }, { runs: ["\n"] }] },
      { paragraphs: [{ runs: [RICH_LINK, "\n"] }] },
      "\n",
      "Plain\n",
    ]] }]);
    makeInlineImage(fixtureParagraph(fixtureCell(tab, 1, 0, 9)), 0);

    expect(firstRowCells(tab).map(cell => cell.loneChip)).toEqual([
      true, true, true, true, true, false, false, false, false, false, false, false,
    ]);
    expect(docTabToMarkdown(tab).markdown).toContain(
      "  <tr>\n    <td><p></p></td>\n    <td><p>owner@example.com</p></td>\n");
    expect(docTabToMarkdown(tab).markdown).toContain("    <td><p>[Image]</p></td>\n");
  });

  it("marks the cells of chips nobody has seen copied", () => {
    let tab = buildTab([{ table: [[
      { paragraphs: [{ runs: [PERSON, PERSON, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, " \n"] }] },
      { paragraphs: [{ runs: [PERSON, "\uE907\n"] }] },
      "\uE907\uE907\n",
      { paragraphs: [{ runs: [{ dropdown: "Open" }, RICH_LINK, "\n"] }] },
      { paragraphs: [{ runs: [PERSON, ", ", PERSON, "\n"] }] },
      { paragraphs: [{ runs: [RICH_LINK, " caption\n"] }] },
    ]] }]);
    makeInlineImage(fixtureParagraph(fixtureCell(tab, 1, 0, 4)), 1);
    makeInlineImage(fixtureParagraph(fixtureCell(tab, 1, 0, 6)), 0);

    expect(firstRowCells(tab).map(cell => cell.loneChip))
      .toEqual([true, true, true, true, true, false, false]);
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
      .toEqual([true, true, true, true, true, false, false, false, false, false]);
    // What such a cell reads as: nothing where the element stands.
    let { markdown } = docTabToMarkdown(tab);
    expect(markdown).toContain(
      "  <tr>\n    <td><p></p></td>\n    <td><p>Status: </p></td>\n    <td>\n" +
      "      <p>Notes</p>\n      <p></p>\n    </td>\n");
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
      .toBe(true);
    expect(firstTableMap(buildTab([{ table: [
      ["a\n", { paragraphs: [{ runs: ["b\n"] }], suggested: "deletion" }],
    ] }])).suggested).toBe(true);
    expect(ownFields.map(table => table.suggested)).toEqual([true, true]);
    // A table inside a cell: deleting the cell discards what is suggested in it.
    expect(firstTableMap(nested).suggested).toBe(true);
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
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { table: [["one\n"]] },
      { runs: ["Middle\n"] },
      { table: [["two\n"]] },
      { runs: ["After\n"] },
    ]));
    let content: EditableMarkdown = {
      markdown: snapshot.markdown,
      protectedRanges: snapshot.sourceMap.protectedRanges,
      tables: snapshot.sourceMap.tables,
    };
    let [first, second] = content.tables;
    let edit = (old: string, replacement: string) => {
      let start = content.markdown.indexOf(old);
      return applyMarkdownEdit(content, start, start + old.length, replacement);
    };

    let before = edit("Before", "Before and more");
    expect(before.tables).toEqual([
      { ...first, mdStart: first.mdStart + 9, mdEnd: first.mdEnd + 9 },
      { ...second, mdStart: second.mdStart + 9, mdEnd: second.mdEnd + 9 },
    ]);
    expect(before.tables[0].rows).toBe(first.rows);
    expect(tableHtmls(before)).toEqual(tableHtmls(content));

    let between = edit("Middle", "Mid");
    expect(between.tables[0]).toBe(first);
    expect(between.tables[1]).toEqual({
      ...second, mdStart: second.mdStart - 3, mdEnd: second.mdEnd - 3,
    });
    expect(tableHtmls(between)).toEqual(tableHtmls(content));

    let after = edit("After", "Afterwards");
    expect(after.tables[0]).toBe(first);
    expect(after.tables[1]).toBe(second);
    expect(tableHtmls(after)).toEqual(tableHtmls(content));

    expect(edit("Before", "Behind").tables).toBe(content.tables);
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

    for (let character of stripped) {
      expect([character.charCodeAt(0), stripUnwritableCharacters(`a${character}b`)])
        .toEqual([character.charCodeAt(0), "ab"]);
    }
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
    expect([MARKDOWN_RENDERING_VERSION, REPLAYABLE_TEXT_EDIT_VERSIONS]).toEqual([7, [6]]);
  });

  it("keeps a large table's map small", () => {
    let rows = Array.from({ length: 200 }, (_row, row) =>
      Array.from({ length: 20 }, (_cell, column) => `c${row}.${column}\n`));
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] }, { table: rows }, { runs: ["After\n"] },
    ]));
    let unmapped = { ...snapshot, sourceMap: { ...snapshot.sourceMap, tables: [] } };
    let bytesPerCell = (serialize(snapshot).length - serialize(unmapped).length) / (200 * 20);

    expect(mappedTexts(snapshot)).toHaveLength(200 * 20);
    expect(bytesPerCell).toBeGreaterThan(0);
    expect(bytesPerCell).toBeLessThanOrEqual(14);
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
    let content = { markdown, protectedRanges: sourceMap.protectedRanges, tables: sourceMap.tables };
    let owner = markdown.indexOf("Owner");
    let message = "replaceText: structured content cannot be edited. Narrow the match to plain text.";
    let refusals = [
      thrownBy(() => assertMarkdownRangeEditable(sourceMap.protectedRanges, owner, owner + 5)),
      thrownBy(() => applyMarkdownEdit(content, owner, owner + 5, "Lead")),
      thrownBy(() => computeReplaceOperations(sourceMap, markdown, owner, owner + 5, "Lead", TAB_ID)),
      thrownBy(() => applyMarkdownEdit(content, 0, markdown.length, "Rewritten\n")),
    ];
    let escape = markdown.indexOf("\\*");
    let splitEscape = thrownBy(() => applyMarkdownEdit(content, escape + 1, escape + 2, "+"));

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

  it("keeps a table's rows, cells and texts ordered and inside the table in both spaces", () => {
    let mapped = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { table: [
        ["a\n", { paragraphs: [{ runs: ["first\n"] }, { runs: ["\n"] }, { runs: ["third\n"] }] }],
        [{ paragraphs: [
          { runs: ["one\n"], bullet: { listId: "L1" } },
          { runs: ["two\n"], bullet: { listId: "L1" } },
        ] }, "\n"],
      ] },
      { runs: ["Between\n"] },
      { table: [["b\n"]] },
      { runs: ["After\n"] },
    ], BULLET_LIST));
    let { tables, protectedRanges } = mapped.sourceMap;
    let mdCursor = 0;
    let docCursor = 0;

    expect(tables).toHaveLength(2);
    for (let table of tables) {
      let blocks = cellBlocks(mapped.markdown, table);
      expect(table.mdStart).toBeGreaterThanOrEqual(mdCursor);
      expect(table.docStart).toBeGreaterThanOrEqual(docCursor);
      expect(protectedRanges.filter(range =>
        range.mdStart <= table.mdStart && table.mdEnd <= range.mdEnd)).toHaveLength(1);

      let rowStart = table.docStart + 1;
      table.rows.forEach((_, row) => {
        let indexes = tableRowIndexes(table, row);
        let cellStart = indexes.docStart + 1;
        expect(indexes.docStart).toBe(rowStart);
        tableRowCells(table, row).forEach((cell, column) => {
          let { docStart, docEnd, paragraphs } = indexes.cells[column];
          let block = blocks[row][column];
          let textCursor = 0;
          let paragraphCursor = docStart + 1;
          expect(docStart).toBe(cellStart);
          expect(paragraphs).toHaveLength(cell.texts.length);
          cell.texts.forEach(([start, end], index) => {
            expect(start).toBeGreaterThan(textCursor);
            expect(end).toBeGreaterThanOrEqual(start);
            expect(block.mdStart + end).toBeLessThan(block.mdEnd);
            expect(paragraphs[index]).toBeGreaterThanOrEqual(paragraphCursor);
            expect(paragraphs[index]).toBeLessThan(docEnd);
            textCursor = end;
            paragraphCursor = paragraphs[index] + 1;
          });
          cellStart = docEnd;
        });
        expect(indexes.docEnd).toBe(cellStart);
        rowStart = indexes.docEnd;
      });
      expect(table.docEnd).toBe(rowStart + 1);
      mdCursor = table.mdEnd;
      docCursor = table.docEnd;
    }
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
    expect(requests).toContainEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
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
