import { describe, expect, it } from "vite-plus/test";
import { markdownToStorage, storageToMarkdown } from "../src/confluence-markdown";

describe("storageToMarkdown", () => {
  it("converts headings", () => {
    expect(storageToMarkdown("<h1>Title</h1><h2>Sub</h2>")).toBe("# Title\n\n## Sub");
  });

  it("converts paragraphs with inline emphasis", () => {
    expect(storageToMarkdown("<p>Hello <strong>bold</strong> and <em>italic</em>.</p>"))
      .toBe("Hello **bold** and *italic*.");
  });

  it("converts inline code and links", () => {
    expect(storageToMarkdown('<p>Run <code>npm i</code> see <a href="https://x.com">site</a>.</p>'))
      .toBe("Run `npm i` see [site](https://x.com).");
  });

  it("converts bullet and numbered lists", () => {
    expect(storageToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(storageToMarkdown("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
  });

  it("converts a code macro to a fenced block with language", () => {
    const xhtml =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
      "<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>";
    expect(storageToMarkdown(xhtml)).toBe("```js\nconst x = 1;\n```");
  });

  it("converts a task list to checkboxes", () => {
    const xhtml =
      "<ac:task-list>" +
      "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
      "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task>" +
      "</ac:task-list>";
    expect(storageToMarkdown(xhtml)).toBe("- [x] done\n- [ ] todo");
  });

  it("converts blockquotes and horizontal rules", () => {
    expect(storageToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
    expect(storageToMarkdown("<p>a</p><hr/><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("renders an info panel as a prefixed blockquote", () => {
    const xhtml =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>';
    expect(storageToMarkdown(xhtml)).toBe("> **Info:** Heads up");
  });
});

describe("markdownToStorage", () => {
  it("converts headings", () => {
    expect(markdownToStorage("# Title\n\n## Sub")).toBe("<h1>Title</h1><h2>Sub</h2>");
  });

  it("converts paragraphs with inline emphasis", () => {
    expect(markdownToStorage("Hello **bold** and *italic*."))
      .toBe("<p>Hello <strong>bold</strong> and <em>italic</em>.</p>");
  });

  it("escapes HTML-special characters in text", () => {
    expect(markdownToStorage("a < b & c")).toBe("<p>a &lt; b &amp; c</p>");
  });

  it("converts inline code and links", () => {
    expect(markdownToStorage("Run `npm i` see [site](https://x.com)."))
      .toBe('<p>Run <code>npm i</code> see <a href="https://x.com">site</a>.</p>');
  });

  it("escapes a double quote in a link href (attribute-injection guard)", () => {
    expect(markdownToStorage('[x](https://a.com/"onmouseover="evil)'))
      .toBe('<p><a href="https://a.com/&quot;onmouseover=&quot;evil">x</a></p>');
  });

  it("converts bullet and numbered lists", () => {
    expect(markdownToStorage("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToStorage("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("converts a fenced code block to a code macro", () => {
    expect(markdownToStorage("```js\nconst x = 1;\n```")).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>",
    );
  });

  it("converts task lists", () => {
    expect(markdownToStorage("- [x] done\n- [ ] todo")).toBe(
      "<ac:task-list>" +
        "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
        "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task>" +
        "</ac:task-list>",
    );
  });

  it("converts blockquotes and horizontal rules", () => {
    expect(markdownToStorage("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(markdownToStorage("a\n\n---\n\nb")).toBe("<p>a</p><hr/><p>b</p>");
  });

  it("neutralizes a ]]> sequence inside a code block (CDATA injection)", () => {
    const out = markdownToStorage("```\nfoo ]]></ac:plain-text-body></ac:structured-macro><h1>x</h1>\n```");
    // The injected markup must not be able to break out of the CDATA section.
    expect(out).not.toContain("]]></ac:plain-text-body></ac:structured-macro><h1>");
    expect(out).toContain("]]]]><![CDATA[>");
  });
});

describe("round-trip", () => {
  it("preserves a code block containing ]]> and angle brackets", () => {
    const md = "```ts\nconst html = `<div>` ]]> end;\n```";
    expect(storageToMarkdown(markdownToStorage(md))).toBe(md);
  });

  it("preserves a representative document through storage -> markdown -> storage", () => {
    const md = [
      "# Heading",
      "",
      "A paragraph with **bold**, *italic*, and `code`.",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(storageToMarkdown(markdownToStorage(md))).toBe(md);
  });
});
