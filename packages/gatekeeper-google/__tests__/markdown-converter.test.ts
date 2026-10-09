import { describe, expect, it } from "vitest";
import type { TextStyle } from "../src/docs-api";
import {
  applyMarkdownEdit, canonicalizeMarkdownForWrite, canonicalizeMarkdownReplacement,
  computeReplaceOperations,
  docTabToMarkdown, markdownToDocRequests,
} from "../src/markdown-converter";
import type { Segment } from "../src/markdown-converter";
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
      { markdown: snapshot.markdown, protectedRanges: snapshot.sourceMap.protectedRanges },
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
