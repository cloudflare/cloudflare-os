import { describe, expect, it } from "vitest";
import { inlineMarkdown, isCodeEditorHtml, markdownToHtml, paletteColorOf, sanitizePastedHtml, textToHtml, type PasteContext } from "../files/lib/paste.ts";

const context: PasteContext = {
  colorKeys: new Set(["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]),
  image: () => null,
};
const paste = (html: string) => sanitizePastedHtml(html, context);

describe("textToHtml", () => {
  // GFM allows a single dash per delimiter cell, and its colons align the column.
  it("reads a pipe table with an alignment row as a table with aligned columns", () => {
    expect(textToHtml("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")).toBe(
      "<table><thead><tr><th>a</th><th style=\"text-align: center;\">b</th><th style=\"text-align: right;\">c</th></tr></thead>" +
      "<tbody><tr><td>1</td><td style=\"text-align: center;\">2</td><td style=\"text-align: right;\">3</td></tr></tbody></table>",
    );
  });

  it("keeps a quote's blocks: a quote per paragraph, its list and code between", () => {
    expect(markdownToHtml("````\n```\nx\n```\n````")).toBe("<pre>```\nx\n```</pre>");
    expect(markdownToHtml("> one\n> two\n>\n> - a\n> - b\n>\n> ```\n> x\n> ```\n>\n> end")).toBe(
      "<blockquote>one<br>two</blockquote><ul><li>a</li><li>b</li></ul><pre>x</pre><blockquote>end</blockquote>",
    );
  });
});

describe("inlineMarkdown", () => {
  it("leaves underscores and asterisks in a link's URL and in code alone", () => {
    expect(inlineMarkdown("see [docs](https://x.com/_a_/*b*) and `*c*` but *d*"))
      .toBe('see <a href="https://x.com/_a_/*b*">docs</a> and <code>*c*</code> but <i>d</i>');
    expect(inlineMarkdown("**[bold link](x.com)**")).toBe('<b><a href="https://x.com">bold link</a></b>');
  });
});

describe("sanitizePastedHtml", () => {
  // Word can put its list style on a heading, which isn't a list item: it stays a heading.
  it("pastes a heading carrying Word's list style as a heading", () => {
    expect(paste('<h1 style="mso-list:l0 level1 lfo1">Heading</h1>')).toBe("<h1>Heading</h1>");
  });

  it("rebuilds Word's list paragraphs as nested lists without their markers", () => {
    const item = (list: string, level: number, marker: string, text: string) =>
      `<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;mso-list:${list} level${level} lfo1'><![if !supportLists]>` +
      `<span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>\n`;
    expect(paste(
      item("l0", 1, "·", "One") + item("l0", 2, "o", "Nested <b>bold</b>") + item("l0", 1, "·", "Two") +
      "<p class=MsoNormal>Between</p>\n" + item("l1", 1, "1.", "First") + item("l1", 1, "2.", "Second"),
    )).toBe("<ul><li>One<ul><li>Nested <b>bold</b></li></ul></li><li>Two</li></ul><p>Between</p><ol><li>First</li><li>Second</li></ol>");
  });

  it("splits a quote of several blocks, and a definition list into lines", () => {
    expect(paste("<blockquote><p>Para one</p><ul><li>a</li></ul><pre>x\ny</pre><p>Para <i>two</i></p></blockquote><dl><dt>Term</dt><dd>Definition</dd></dl>"))
      .toBe("<blockquote>Para one</blockquote><ul><li>a</li></ul><pre>x\ny</pre><blockquote>Para <i>two</i></blockquote><p><b>Term</b></p><p>Definition</p>");
  });

  // Google Docs colours every run literally: chromatic colours map to the nearest palette class,
  // its black text, transparent backgrounds and link blue map to none.
  it("maps literal colours to the palette, and drops neutral ones and link colours", () => {
    expect(paste(
      '<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr"><span style="color:#000000;background-color:transparent;font-weight:400">plain</span> ' +
      '<span style="color:#ff0000;font-weight:400">red</span> <span style="background-color:#ffff00;font-weight:400">hl</span> ' +
      '<a href="https://x.test"><span style="color:#1155cc;text-decoration:underline">link</span></a></p></b>',
    )).toBe('<p>plain <span class="tc-red">red</span> <span class="hl-yellow">hl</span> <a href="https://x.test"><u>link</u></a></p>');
    expect(paste("<p class=MsoNormal><span style='background:yellow;mso-highlight:yellow'>w</span> <span style='color:#C00000'>dark red</span></p>"))
      .toBe('<p><span class="hl-yellow">w</span> <span class="tc-red">dark red</span></p>');
  });

  it("names the nearest palette colour", () => {
    expect(paletteColorOf("#4a86e8", "tc")).toBe("blue");
    expect(paletteColorOf("rgb(153, 0, 255)", "tc")).toBe("purple");
    expect(paletteColorOf("#783f04", "tc")).toBe("brown");
    expect(paletteColorOf("#fff2cc", "hl")).toBe("yellow");
    expect(paletteColorOf("#666666", "tc")).toBeUndefined();
    expect(paletteColorOf("rgba(24, 24, 32, 0.05)", "hl")).toBeUndefined();
    expect(paletteColorOf("url(x)", "hl")).toBeNull();
  });

  it("keeps a GitHub task list as a checklist, and a list item's paragraphs as lines", () => {
    expect(paste(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> todo</li>' +
      '<li class="task-list-item"><input type="checkbox" checked disabled> done</li></ul>' +
      "<ol><li><p>first para</p><p>second para</p></li></ol>",
    )).toBe('<ul class="checklist"><li>todo</li><li data-checked="true">done</li></ul><ol><li>first para<br>second para</li></ol>');
  });

  it("nests Google Docs' sibling sub-lists under the item above", () => {
    expect(paste('<ul><li aria-level="1"><p>a</p></li><ul><li aria-level="2"><p>b</p></li></ul><li aria-level="1"><p>c</p></li></ul>'))
      .toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });

  it("keeps a run of inline content together, and a code block's line breaks", () => {
    expect(paste('<div>Hello <b>world</b> and <i>more</i><p>next</p></div><pre class="c-mrkdwn__pre">one<br>two</pre>'))
      .toBe("<p>Hello <b>world</b> and <i>more</i></p><p>next</p><pre>one\ntwo</pre>");
  });

  // A cell spanning rows leaves an empty cell below it, so the next row's cells keep their columns.
  it("keeps cells in their columns past a pasted row span", () => {
    expect(paste('<table><thead><tr><th>Owner</th><th>Task</th></tr></thead><tbody><tr><td rowspan="2">Ada</td><td>Build</td></tr><tr><td>Test</td></tr></tbody></table>'))
      .toBe("<table><thead><tr><th>Owner</th><th>Task</th></tr></thead><tbody><tr><td>Ada</td><td>Build</td></tr><tr><td><br></td><td>Test</td></tr></tbody></table>");
  });

  it("keeps a pasted table cell's alignment", () => {
    expect(paste('<table><thead><tr><th align="center">a</th><th style="text-align: right">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'))
      .toBe('<table><thead><tr><th style="text-align: center;">a</th><th style="text-align: right;">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  });
});

describe("isCodeEditorHtml", () => {
  it("recognizes a code editor's syntax-coloured copy, and nothing richer", () => {
    expect(isCodeEditorHtml('<meta charset="utf-8"><div style="color: #ccc;font-family: Menlo, Monaco, monospace;white-space: pre;"><div><span>| a |</span></div></div>')).toBe(true);
    expect(isCodeEditorHtml("<div><b>bold</b></div>")).toBe(false);
    expect(isCodeEditorHtml("<pre>code</pre>")).toBe(false);
  });
});
