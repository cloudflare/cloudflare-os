// @vitest-environment node
import { HtmlRenderer, Parser } from "commonmark";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../files/lib/markdown.ts";

describe("htmlToMarkdown", () => {
  // The markup Chrome's execCommand writes under styleWithCSS for the toolbar's Bold, Italic,
  // Strikethrough, Underline and font size.
  it("exports the emphasis the toolbar applies as inline styles", () => {
    expect(htmlToMarkdown(
      '<p data-block-id="b1"><span style="font-weight: bold;">Hello</span> ' +
      '<span style="font-style: italic;">world</span>, ' +
      '<span style="text-decoration-line: line-through;">select</span> ' +
      '<span style="text-decoration-line: underline;">me</span> ' +
      '<font style="font-size: 18pt;">big</font> ' +
      '<span style="font-weight: 700; font-style: italic;">both</span>.</p>',
    )).toBe("**Hello** *world*, ~~select~~ me big ***both***.\n");
  });

  // Plain-text paste writes each newline as a `<br>`, so a blank line between pasted paragraphs
  // is two in a row.
  it("keeps each line break, but not those holding the end of a paragraph open", () => {
    expect(htmlToMarkdown(
      "<p>line one<br>line <b>two</b><br></p><p>pasted<br><br>after a blank line<br><br></p>" +
      "<p><br></p><h2>a<br>b</h2><pre>x<br>y</pre>",
    )).toBe(
      "line one\\\nline **two**\n\npasted\\\n\\\nafter a blank line\n\n## a b\n\n```\nx\ny\n```\n",
    );
  });

  // Typing "Hello " in bold leaves the space inside the run, and `**Hello **world` keeps its
  // asterisks; Enter after a bold line leaves an empty bold run, and `****` is a horizontal rule.
  it("writes emphasis only around text, tight against it", () => {
    expect(htmlToMarkdown(
      '<p><span style="font-weight: bold;">Hello </span>world,<i> see</i> ' +
      '<b><a href="https://example.com">this</a></b></p>' +
      '<p><span style="font-weight: bold;"><br></span></p>' +
      '<p><span style="text-decoration-line: line-through;"><br></span></p>',
    )).toBe("**Hello** world, *see* [**this**](https://example.com)\n");
  });

  // Bolding again what is already bold, or next to it, gives two elements for one stretch of
  // bold; a pair of markers each would read `**A****B**`, with the asterisks showing.
  it("writes one pair of markers for each stretch of formatting", () => {
    expect(htmlToMarkdown(
      '<p><b>A<span style="font-weight: bold;">B</span>C</b> and <b>pasted</b>' +
      '<span style="font-weight: bold;">rebold</span>, <i><b>both</b> italic</i></p>',
    )).toBe("**ABC** and **pastedrebold**, ***both** italic*\n");
  });

  // An agent's HTML can unbold inside bold, and Google Docs wraps what it copies in
  // `<b style="font-weight: normal">`; the page shows the innermost element's say.
  it("lets an element's style turn off the emphasis its tag or an ancestor applies", () => {
    expect(htmlToMarkdown(
      '<p><b>one <span style="font-weight: normal">two</span> three</b> ' +
      '<i>four <span style="font-style: normal;">five</span></i> ' +
      '<b style="font-weight: normal">six</b></p>',
    )).toBe("**one** two **three** *four* five six\n");
  });

  // Emphasis cannot pair across a link label's brackets (`**[one** two](…)` shows its asterisks),
  // and the toolbar's Bold or Italic on a whole link styles the link itself.
  it("renders a link label's emphasis on the letters that have it", () => {
    const markdown = htmlToMarkdown(
      '<p><b>see <a href="https://example.com">one <span style="font-weight: normal">two</span></a></b> ' +
      '<a href="https://example.com" style="font-style: italic;">three</a></p>',
    );
    expect(renderedFormats(markdown), markdown).toEqual([..."bbbbbb", "", "", "", ..."iiiii"]);
  });

  // The editor gives each stretch of formatting one span, so bolding one range of a line and
  // italicising another, inside a word or across words, gives these runs. Delimiters that change
  // inside a word can pair differently than written (`**A***B**C***` leaves C unbolded).
  it("exports bold and italic that CommonMark renders on the same letters", () => {
    const text = "ab cd ef";
    const offsets = [...Array(text.length + 1).keys()];
    const ranges = offsets.flatMap((start) => offsets.filter((end) => end > start).map((end) => [start, end]));
    for (const [boldStart, boldEnd] of ranges) {
      for (const [italicStart, italicEnd] of ranges) {
        const formats = [...text].map((_, i) =>
          (i >= boldStart && i < boldEnd ? "b" : "") + (i >= italicStart && i < italicEnd ? "i" : ""));
        const markdown = htmlToMarkdown(editorHtml(text, formats));
        expect(renderedFormats(markdown), markdown)
          .toEqual(formats.filter((_, i) => text[i] !== " "));
      }
    }
  });

  it("keeps code verbatim, without emphasis or escapes", () => {
    expect(htmlToMarkdown(
      '<pre><span style="font-weight: bold;">npm</span> install</pre>' +
      "<p>Run <code>a*b_c</code> or <b><code>x</code></b>, <code>one<br>line</code></p>",
    )).toBe("```\nnpm install\n```\n\nRun `a*b_c` or **`x`**, `one line`\n");
  });
});

/** `text` as the editor marks it up, with one span for each stretch of the same `formats`. */
function editorHtml(text: string, formats: string[]): string {
  let html = "";
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (formats[end] === formats[start]) end++;
    const style = [
      formats[start].includes("b") && "font-weight: bold;",
      formats[start].includes("i") && "font-style: italic;",
    ].filter(Boolean).join(" ");
    const run = text.slice(start, end);
    html += style ? `<span style="${style}">${run}</span>` : run;
    start = end;
  }
  return `<p>${html}</p>`;
}

/** The formats CommonMark renders `markdown`'s visible characters with; a stray `*` is one. */
function renderedFormats(markdown: string): string[] {
  const html = new HtmlRenderer().render(new Parser().parse(markdown));
  const formats: string[] = [];
  let bold = 0;
  let italic = 0;
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (/^<\/?strong>$/.test(token)) bold += token[1] === "/" ? -1 : 1;
    else if (/^<\/?em>$/.test(token)) italic += token[1] === "/" ? -1 : 1;
    else if (!token.startsWith("<")) {
      const format = (bold ? "b" : "") + (italic ? "i" : "");
      formats.push(...Array.from(token.replace(/\s/g, ""), () => format));
    }
  }
  return formats;
}
