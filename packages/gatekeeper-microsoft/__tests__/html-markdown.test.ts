import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown } from "../src/html-markdown";

describe("htmlToMarkdown", () => {
  it("turns headings and paragraphs into blocks, collapsing whitespace as a browser would", () => {
    expect(htmlToMarkdown("<h1>Launch  plan</h1>\n<p>We   ship\n in <b>March</b>.</p><h3>Risks</h3><div>None yet.</div>"))
      .toBe("# Launch plan\n\nWe ship in **March**.\n\n### Risks\n\nNone yet.");
  });

  it("writes emphasis, strikethrough and inline code", () => {
    expect(htmlToMarkdown("<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>x = 1</code></p>"))
      .toBe("**bold** _it_ ~~gone~~ `x = 1`");
  });

  it("keeps safe links and drops unsafe ones, keeping their text", () => {
    expect(htmlToMarkdown("<p><a href=\"https://contoso.com/a b\">site</a>, <a href=\"/sites/Eng\">eng</a>, " +
      "<a href=\"mailto:p@contoso.com\">mail</a>, <a href=\" JavaScript:alert(1)\">bad</a>, <a href=\"data:text/html,x\">data</a></p>"))
      .toBe("[site](https://contoso.com/a%20b), [eng](/sites/Eng), [mail](mailto:p@contoso.com), bad, data");
  });

  it("keeps a link target's parentheses from ending it early", () => {
    expect(htmlToMarkdown("<a href=\"https://en.wikipedia.org/wiki/Foo_(bar)\">Foo</a>"))
      .toBe("[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29)");
  });

  it("nests lists, numbering ordered ones", () => {
    expect(htmlToMarkdown("<ul><li>One<ul><li>One a</li><li>One b</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol>"))
      .toBe("- One\n  - One a\n  - One b\n- Two\n\n1. First\n2. Second");
  });

  it("writes a table with a header row, escaping pipes in cells once", () => {
    expect(htmlToMarkdown("<table><tr><th>Name</th><th>Role</th></tr><tr><td>Sarah</td><td>Eng | Lead</td></tr><tr><td>Bob<br>Smith</td></tr></table>"))
      .toBe("| Name | Role |\n| --- | --- |\n| Sarah | Eng \\| Lead |\n| Bob Smith |  |");
  });

  it("keeps an outer table's rows around a nested table, whose text joins the cell", () => {
    expect(htmlToMarkdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr><tr><td>2</td><td>z</td></tr></table>"))
      .toBe("| A | B |\n| --- | --- |\n| 1 | x y |\n| 2 | z |");
  });

  it("gives a table without a header an empty one, as GitHub requires", () => {
    expect(htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr></table>")).toBe("|  |  |\n| --- | --- |\n| a | b |");
  });

  it("keeps preformatted text as written, in a fence", () => {
    expect(htmlToMarkdown("<pre><code>if (a) {\n  b();\n}</code></pre><p>after</p>")).toBe("```\nif (a) {\n  b();\n}\n```\n\nafter");
  });

  it("quotes blockquotes", () => {
    expect(htmlToMarkdown("<blockquote><p>Ship it.</p><p>Soon.</p></blockquote><p>Done</p>")).toBe("> Ship it.\n>\n> Soon.\n\nDone");
  });

  it("names images by their alt text", () => {
    expect(htmlToMarkdown("<p><img src=\"x.png\" alt=\"Org chart\"> <img src=\"y.png\"></p>")).toBe("[image: Org chart] [image]");
  });

  it("decodes entities and escapes what Markdown would misread", () => {
    expect(htmlToMarkdown("<p>Fish &amp; chips &lt;3 &#x1F600; &mdash; *not bold* [x]</p>")).toBe("Fish & chips \\<3 😀 — \\*not bold\\* \\[x\\]");
    expect(htmlToMarkdown("<p># not a heading</p><p>1. not a list</p>")).toBe("\\# not a heading\n\n1\\. not a list");
  });

  it("drops scripts, styles, comments and unknown tags with their raw content", () => {
    expect(htmlToMarkdown("<p>a<script>alert('x')</script><style>p{}</style><!-- note -->b<custom-tag>c</custom-tag></p>")).toBe("abc");
    expect(htmlToMarkdown("<p>a</p><script>never closed")).toBe("a");
  });

  it("keeps a stray < as text", () => {
    expect(htmlToMarkdown("<p>1 < 2 and 3 <> 4</p>")).toBe("1 \\< 2 and 3 \\<\\> 4");
  });

  it("puts a line break on its own line, and a rule between blocks", () => {
    expect(htmlToMarkdown("<p>one<br>two</p><hr><p>three</p>")).toBe("one\ntwo\n\n---\n\nthree");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references, keeping unknown names", () => {
    expect(decodeEntities("&lt;&GT;&#65;&#x42;&nbsp;&unknown;")).toBe("<>AB &unknown;");
  });

  it("replaces NUL, lone surrogates and out-of-range code points", () => {
    expect(decodeEntities("&#0;&#xD800;&#x110000;")).toBe("���");
  });
});
