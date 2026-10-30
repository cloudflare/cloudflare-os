// @vitest-environment node
import { HtmlRenderer, Parser } from "commonmark";
import { describe, expect, it } from "vitest";
import { decodeHtml, htmlToMarkdown, readHtmlAttribute } from "../files/lib/markdown.ts";

// A hard line break: two spaces and a newline.
const BR = "  \n";

describe("htmlToMarkdown", () => {
  // The markup Chrome's execCommand writes under styleWithCSS -- what older documents and pasted
  // HTML carry -- exports the same as the editor's own <b>/<i>/<s>.
  it("exports the emphasis inline styles carry", () => {
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
  // is two in a row; a heading is one line, and a code block keeps its lines.
  it("keeps each line break, but not those holding the end of a paragraph open", () => {
    expect(htmlToMarkdown(
      "<p>line one<br>line <b>two</b><br></p><p>pasted<br><br>after a blank line<br><br></p>" +
      "<p><br></p><h2>a<br>b</h2><pre>x<br>y</pre>",
    )).toBe(`line one${BR}line **two**\n\npasted${BR}${BR}after a blank line\n\n## a b\n\n\`\`\`\nx\ny\n\`\`\`\n`);
  });

  // `**Hello **world` keeps its asterisks, and an empty `****` is a horizontal rule.
  it("writes emphasis only around text, tight against it", () => {
    expect(htmlToMarkdown(
      '<p><span style="font-weight: bold;">Hello </span>world,<i> see</i> ' +
      '<b><a href="https://example.com">this</a></b></p>' +
      '<p><span style="font-weight: bold;"><br></span></p>' +
      "<p><b><br></b></p>" +
      '<p><span style="text-decoration-line: line-through;"><br></span></p>',
    )).toBe("**Hello** world, *see* [**this**](https://example.com)\n");
  });

  it("writes one pair of markers per stretch of the same emphasis", () => {
    expect(htmlToMarkdown(
      '<p><b>A<span style="font-weight: bold;">B</span>C</b> and <b>pasted</b>' +
      '<span style="font-weight: bold;">rebold</span>, <i><b>both</b> italic</i></p>',
    )).toBe("**ABC** and **pastedrebold**, ***both** italic*\n");
  });

  it("lets an inner style turn emphasis off", () => {
    expect(htmlToMarkdown(
      '<p><b>one <span style="font-weight: normal">two</span> three</b> ' +
      '<i>four <span style="font-style: normal;">five</span></i> ' +
      '<b style="font-weight: normal">six</b></p>',
    )).toBe("**one** two **three** *four* five six\n");
  });

  // Emphasis can't pair across a link label's brackets, so the label opens and closes its own.
  it("emphasises a link label inside its brackets", () => {
    const markdown = htmlToMarkdown(
      '<p><b>see <a href="https://example.com">one <span style="font-weight: normal">two</span></a></b> ' +
      '<a href="https://example.com" style="font-style: italic;">three</a></p>',
    );
    expect(renderedFormats(markdown), markdown).toEqual([..."bbbbbb", "", "", "", ..."iiiii"]);
  });

  // Every bold range against every italic range over a short text, as tags and as styles: what a
  // CommonMark reader renders is exactly what was formatted, letter for letter -- including where
  // emphasis changes inside a word and the block has to fall back to <strong>/<em>.
  it("renders bold and italic on exactly the letters that had them", () => {
    const text = "ab cd ef";
    const offsets = [...Array(text.length + 1).keys()];
    const ranges = offsets.flatMap((start) => offsets.filter((end) => end > start).map((end) => [start, end]));
    for (const [bs, be] of ranges) {
      for (const [is, ie] of ranges) {
        const formats = [...text].map((_, i) => (i >= bs && i < be ? "b" : "") + (i >= is && i < ie ? "i" : ""));
        for (const tags of [false, true]) {
          const markdown = htmlToMarkdown(editorHtml(text, formats, tags));
          expect(renderedFormats(markdown), markdown).toEqual(formats.filter((_, i) => text[i] !== " "));
        }
      }
    }
  });

  it("keeps code verbatim", () => {
    expect(htmlToMarkdown(
      '<pre><span style="font-weight: bold;">npm</span> install</pre>' +
      "<p>Run <code>a*b_c</code> or <b><code>x</code></b>, <code>one<br>line</code></p>",
    )).toBe("```\nnpm install\n```\n\nRun `a*b_c` or **`x`**, `one line`\n");
  });

  it("exports checklists, tables, quotes, dividers and images, and drops zero-width spaces", () => {
    expect(htmlToMarkdown(
      '<ul class="checklist"><li data-checked="true">Ship<ul><li>sub</li></ul></li><li>Tell</li></ul>' +
      "<table><thead><tr><th><b>Name</b></th><th>Role</th></tr></thead><tbody><tr><td>A|b</td><td>x<br>y</td></tr></tbody></table>" +
      "<p>a​b <code>c​</code>​</p><blockquote>q1<br>q2</blockquote><hr>" +
      '<p><img class="doc-image" src="https://x/y.png" alt="Pic [1]"></p><ol><li>one</li><li>two</li></ol>',
    )).toBe(
      "- [x] Ship\n  - [ ] sub\n- [ ] Tell\n\n" +
      "| **Name** | Role   |\n| -------- | ------ |\n| A\\|b     | x<br>y |\n\n" +
      "ab `c`\n\n> q1  \n> q2\n\n---\n\n![Pic \\[1\\]](https://x/y.png)\n\n1. one\n2. two\n",
    );
  });

  // The editor's indent is a <blockquote style="margin…">: its lines are paragraphs, not a quote.
  it("exports an indent as paragraphs", () => {
    expect(htmlToMarkdown(
      '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;"><p>a</p><p>b <b>c</b></p></blockquote>' +
      "<blockquote>q</blockquote>",
    )).toBe("a\n\nb **c**\n\n> q\n");
  });

  // Two lists side by side are one list to Markdown unless the second changes its marker.
  it("keeps side-by-side lists apart", () => {
    const markdown = htmlToMarkdown(
      '<ul><li>one</li><ul><li>two</li></ul><li>three</li></ul><ul class="checklist"><li>a</li></ul>' +
      "<ul><li>b</li></ul><ol><li>c</li></ol><p>d</p>",
    );
    expect(markdown).toBe("- one\n  - two\n- three\n\n* [ ] a\n\n- b\n\n1. c\n\nd\n");
    const html = new HtmlRenderer().render(new Parser().parse(markdown));
    expect(html.match(/<ul>|<ol>/g)).toHaveLength(5);
  });

  it("escapes Markdown punctuation in text, and writes nothing for an empty document", () => {
    expect(htmlToMarkdown("<p>a*b_c [x] \\ &lt;tag&gt; &amp;&nbsp;done</p>")).toBe("a\\*b\\_c \\[x\\] \\\\ \\<tag> & done\n");
    expect(htmlToMarkdown("<p><br></p><p></p>")).toBe("");
  });

  // Text that reads as Markdown syntax at the start of a line stays text when rendered.
  it("keeps text that looks like a list, heading, quote or rule as text", () => {
    const texts = ["1. not a list", "- not a bullet", "# not a heading", "> not a quote", "+ plus", "---", "a `tick` and <b>tag</b>"];
    const html = texts.map((text) => `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("") + "<p>first<br>2) second</p>";
    const rendered = new HtmlRenderer().render(new Parser().parse(htmlToMarkdown(html)));
    expect(rendered).not.toMatch(/<(ol|ul|h1|blockquote|hr|code|b)\b/);
    for (const text of texts) expect(rendered).toContain(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    expect(htmlToMarkdown("<p>-5 degrees, 3.5 stars</p>")).toBe("-5 degrees, 3.5 stars\n");
  });

  it("writes a table cell's lines as <br> and pads its columns", () => {
    expect(htmlToMarkdown("<table><tbody><tr><td>a</td><td>longer</td></tr><tr><td>b<br>c</td></tr></tbody></table>"))
      .toBe("| a      | longer |\n| ------ | ------ |\n| b<br>c |        |\n");
  });

  it("marks a column's alignment when all its cells share it", () => {
    const cell = (tag: string, text: string, align?: string) =>
      align ? `<${tag} style="text-align: ${align};">${text}</${tag}>` : `<${tag}>${text}</${tag}>`;
    const html = "<table><tbody>" +
      `<tr>${cell("th", "Item")}${cell("th", "Qty", "center")}${cell("th", "Cost", "right")}${cell("th", "Mixed", "right")}</tr>` +
      `<tr>${cell("td", "Pen")}${cell("td", "2", "center")}${cell("td", "$4", "right")}${cell("td", "x")}</tr>` +
      "</tbody></table>";
    expect(htmlToMarkdown(html)).toBe("| Item | Qty | Cost | Mixed |\n| ---- | :-: | ---: | ----- |\n| Pen  | 2   | $4   | x     |\n");
  });

  it("writes link and image destinations CommonMark reads whole", () => {
    const md = htmlToMarkdown('<p><a href="https://x.test/a b(c)">l</a> <img src="https://x.test/p q).png" alt="i"></p>');
    expect(md).toBe("[l](https://x.test/a%20b%28c%29) ![i](https://x.test/p%20q%29.png)\n");
    const html = new HtmlRenderer().render(new Parser().parse(md));
    expect(html).toContain('href="https://x.test/a%20b%28c%29"');
    expect(html).toContain('src="https://x.test/p%20q%29.png"');
  });

  it("drops script URLs, keeping a link's label", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">one</a> <a href="java&amp;Tab;script:x">two</a> <a href="data:text/html,x">three</a> <a>four</a></p>'))
      .toBe("one two three four\n");
    expect(htmlToMarkdown('<p>a<img src="javascript:x" alt="bad">b</p>')).toBe("ab\n");
  });

  it("keeps data: images, abbreviating long ones when asked", () => {
    const short = "data:image/png;base64,iVBORw0KGgo=";
    expect(htmlToMarkdown(`<p><img src="${short}" alt="p"></p>`)).toBe(`![p](${short})\n`);
    const long = "data:image/png;base64," + "A".repeat(400);
    expect(htmlToMarkdown(`<p><img src="${long}" alt="p"></p>`)).toBe(`![p](${long})\n`);
    expect(htmlToMarkdown(`<p><img src="${long}" alt="p"></p>`, { abbreviateImages: true })).toMatch(/^!\[p\]\(data:image\/png;… 300 B #[0-9a-f]{8}\)\n$/);
  });
});

describe("HTML attribute helpers", () => {
  it("reads an attribute in any quoting, decoded", () => {
    expect(readHtmlAttribute(' href="a&amp;b" class=x', "href")).toBe("a&b");
    expect(readHtmlAttribute(" data-x='1'", "data-x")).toBe("1");
    expect(readHtmlAttribute(" class=checklist", "class")).toBe("checklist");
    expect(readHtmlAttribute(" class=checklist", "style")).toBe("");
  });

  it("reads the attribute itself, not one ending in its name or text inside another's value", () => {
    expect(readHtmlAttribute(' data-src="a" src="b"', "src")).toBe("b");
    expect(readHtmlAttribute(' alt="x src=y" src="z"', "src")).toBe("z");
    expect(readHtmlAttribute(' data-class="x" class="checklist"', "class")).toBe("checklist");
    expect(htmlToMarkdown('<p><img data-src="lazy.png" src="https://a/real.png" alt="pic"></p>')).toBe("![pic](https://a/real.png)\n");
  });

  it("decodes numeric and the named entities the serializer writes", () => {
    expect(decodeHtml("&lt;&#x41;&#66;&quot;&apos;&nbsp;&amp;&copy;")).toBe("<AB\"' &&copy;");
  });

  it("decodes an out-of-range code point as the replacement character rather than throwing", () => {
    expect(decodeHtml("a&#x110000;b&#xD800;c&#0;")).toBe("a\ufffdb\ufffdc\ufffd");
  });
});

// The editor's markup for `text`, each letter formatted as `formats` says, as tags or as styles.
function editorHtml(text: string, formats: string[], tags: boolean): string {
  let html = "";
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (formats[end] === formats[start]) end++;
    const format = formats[start], run = text.slice(start, end);
    if (tags) {
      html += (format.includes("b") ? "<b>" : "") + (format.includes("i") ? "<i>" : "") + run +
        (format.includes("i") ? "</i>" : "") + (format.includes("b") ? "</b>" : "");
    } else {
      const style = [format.includes("b") && "font-weight: bold;", format.includes("i") && "font-style: italic;"].filter(Boolean).join(" ");
      html += style ? `<span style="${style}">${run}</span>` : run;
    }
    start = end;
  }
  return `<p>${html}</p>`;
}

// How CommonMark renders each non-space letter of `markdown`: "b", "i", "bi" or "".
function renderedFormats(markdown: string): string[] {
  const html = new HtmlRenderer().render(new Parser().parse(markdown));
  const formats: string[] = [];
  let bold = 0, italic = 0;
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (/^<\/?strong>$/.test(token)) bold += token[1] === "/" ? -1 : 1;
    else if (/^<\/?em>$/.test(token)) italic += token[1] === "/" ? -1 : 1;
    else if (!token.startsWith("<")) formats.push(...Array.from(token.replace(/\s/g, ""), () => (bold ? "b" : "") + (italic ? "i" : "")));
  }
  return formats;
}
