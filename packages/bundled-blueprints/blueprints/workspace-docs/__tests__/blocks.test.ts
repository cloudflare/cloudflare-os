// @vitest-environment node
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../files/lib/markdown.ts";
import {
  blockTypeOf,
  markdownToSpecs,
  mergeBlockList,
  resolvePosition,
  retypeSpec,
  setItemChecked,
  specHtml,
  specsFrom,
  splitTopLevelHtml,
  stripUnsafe,
} from "../files/lib/blocks.ts";

// The block API's spec -> HTML conversion must produce exactly what the editor writes for the same
// content, so an agent's block and a typed one are indistinguishable to the editor and the exports.
describe("specHtml", () => {
  it("writes inline Markdown as the editor's markup, and leaves unsafe links as text", () => {
    expect(specHtml("Hello **world** and `x<y` [l](https://a.b) [bad](javascript:alert(1))"))
      .toBe('<p>Hello <b>world</b> and <code>x&lt;y</code> <a href="https://a.b">l</a> [bad](javascript:alert(1))</p>');
  });

  it("keeps code spans out of link targets", () => {
    expect(specHtml("[a](`x`) see https://a.b`c`")).toBe('<p>[a](<code>x</code>) see <a href="https://a.b">https://a.b</a><code>c</code></p>');
  });

  it("accepts the type aliases", () => {
    expect(specHtml({ type: "heading", text: "Plan" })).toBe("<h2>Plan</h2>");
    expect(specHtml({ type: "title", text: "T" })).toBe("<h1>T</h1>");
    expect(specHtml({ type: "rule" })).toBe("<hr>");
    expect(() => specHtml({ type: "banner", text: "x" })).toThrow('Unknown block type "banner"');
  });

  it("writes lists: to-dos with their checks, nested lists of their own kind, lines of text as items", () => {
    expect(specHtml({ type: "todo", items: [{ text: "Ship it", checked: true }, "Tell people"] }))
      .toBe('<ul class="checklist"><li data-checked="true">Ship it</li><li>Tell people</li></ul>');
    expect(specHtml({ type: "ul", items: [{ text: "a", items: ["b"], listType: "ol" }] }))
      .toBe("<ul><li>a<ol><li>b</li></ol></li></ul>");
    expect(specHtml({ type: "ul", text: "a\nb" })).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("writes code escaped, without its final newline", () => {
    expect(specHtml({ type: "code", text: "a < b\n" })).toBe("<pre>a &lt; b</pre>");
    expect(specHtml({ type: "code", text: "" })).toBe("<pre><br></pre>");
  });

  it("writes a table with a header row, padded rows and percentage column widths", () => {
    expect(specHtml({ type: "table", rows: [["Name", "Role"], ["Ada"]], widths: [30, 70] })).toBe(
      '<table><colgroup><col style="width: 30%;"><col style="width: 70%;"></colgroup>' +
      "<thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td>Ada</td><td><br></td></tr></tbody></table>",
    );
    expect(specHtml({ type: "table", rows: [["a", "b"]], header: false }))
      .toBe("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>");
    expect(() => specHtml({ type: "table", rows: [] })).toThrow("A table needs rows");
  });

  it("writes an image only from an https or data:image source", () => {
    expect(specHtml({ type: "image", src: "https://x/y.png", alt: "Y", width: 300.4 }))
      .toBe('<p><img class="doc-image" draggable="true" src="https://x/y.png" alt="Y" style="width:300px;height:auto;"></p>');
    expect(() => specHtml({ type: "image", src: "javascript:x" })).toThrow("An image needs an https:// or data:image src.");
  });

  it("judges an untyped spec by its fields", () => {
    expect(specHtml({ items: ["a"] })).toBe("<ul><li>a</li></ul>");
    expect(specHtml({ rows: [["a"]] })).toBe("<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><br></td></tr></tbody></table>");
    expect(specHtml({ html: "<b>inline</b>" })).toBe("<p><b>inline</b></p>");
    expect(specHtml({ markdown: "## From Markdown" })).toBe("<h2>From Markdown</h2>");
  });
});

describe("specsFrom", () => {
  // The editor holds one element per block, so an html spec with several becomes several blocks.
  it("splits an html spec into one block per top-level element", () => {
    expect(specsFrom({ blocks: [{ html: "<h2>a</h2><p>b</p>loose" }] })).toEqual([
      { type: "html", html: "<h2>a</h2>" },
      { type: "html", html: "<p>b</p>" },
      { type: "html", html: "<p>loose</p>" },
    ]);
  });

  it("expands Markdown, given alone or as an entry, after the blocks", () => {
    expect(specsFrom({ blocks: [{ markdown: "# A\n\nb" }, "c"], markdown: "- d" })).toEqual([
      { type: "h1", text: "A" }, { type: "p", text: "b" }, "c", { type: "ul", items: [{ text: "d", checked: false }] },
    ]);
  });
});

describe("markdownToSpecs", () => {
  it("reads headings, paragraphs, nested and task lists, quotes, code, dividers, images and pipe tables", () => {
    expect(markdownToSpecs(
      "# T\n\npara\nline two\n\n- a\n  - b\n- [x] c\n1. d\n\n> q\n> r\n\n```js\ncode\n```\n---\n" +
      "![i](https://x/y.png)\n| a | b |\n|---|---|\n| 1 | 2 \\| 3 |",
    )).toEqual([
      { type: "h1", text: "T" },
      { type: "p", text: "para\nline two" },
      { type: "ul", items: [{ text: "a", checked: false, items: [{ text: "b", checked: false }], listType: "ul" }] },
      { type: "todo", items: [{ text: "c", checked: true }] },
      { type: "ol", items: [{ text: "d", checked: false }] },
      { type: "quote", text: "q\nr" },
      { type: "code", text: "code" },
      { type: "divider" },
      { type: "image", alt: "i", src: "https://x/y.png" },
      { type: "table", rows: [["a", "b"], ["1", "2 | 3"]], header: true },
    ]);
  });

  it("caps headings at level 3 and keeps an unsafe image as a paragraph", () => {
    expect(markdownToSpecs("#### deep\n![x](javascript:alert(1))")).toEqual([
      { type: "h3", text: "deep" }, { type: "p", text: "![x](javascript:alert(1))" },
    ]);
  });

  // GFM allows one dash per delimiter cell, as in a centred `:-:` column.
  it("reads a table whose delimiter row has single-dash alignment cells", () => {
    expect(markdownToSpecs("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")).toEqual([
      { type: "table", rows: [["a", "b", "c"], ["1", "2", "3"]], header: true },
    ]);
  });
});

describe("splitTopLevelHtml", () => {
  it("cuts HTML into top-level blocks, wrapping loose inline content in paragraphs", () => {
    expect(splitTopLevelHtml("text <b>x</b><p>a</p><hr><ul><li><ul><li>n</li></ul></li></ul><br>tail")).toEqual([
      "<p>text <b>x</b></p>", "<p>a</p>", "<hr>", "<ul><li><ul><li>n</li></ul></li></ul>", "<p><br>tail</p>",
    ]);
    expect(splitTopLevelHtml("")).toEqual(["<p><br></p>"]);
  });
});

describe("list items through Markdown", () => {
  // A line break in an item is an indented continuation, so editing another word keeps the list whole.
  it("keeps a list item's line break", () => {
    const md = htmlToMarkdown("<ul><li>First<br>Second</li><li>Third</li></ul>");
    expect(md).toBe("- First  \n  Second\n- Third\n");
    expect(markdownToSpecs(md.replace("Third", "THIRD")).map(specHtml)).toEqual(["<ul><li>First<br>Second</li><li>THIRD</li></ul>"]);
    expect(htmlToMarkdown("<ol><li>a<ul><li>b<br>c</li></ul></li></ol>")).toBe("1. a\n  - b  \n    c\n");
  });

  // An empty item reads back as an item, so editing another one keeps the list whole.
  it("keeps empty list items", () => {
    for (const html of ["<ul><li>First</li><li><br></li><li>Third</li></ul>", "<ol><li>a</li><li><br></li></ol>", '<ul class="checklist"><li>a</li><li><br></li></ul>']) {
      expect(markdownToSpecs(htmlToMarkdown(html)).map(specHtml)).toEqual([html]);
    }
  });

  // Under one item, a bulleted list after a numbered one stays its own list.
  it("keeps nested lists of different kinds apart", () => {
    const html = "<ul><li>Parent<ol><li>Numbered</li></ol><ul><li>Bullet</li></ul></li></ul>";
    const md = htmlToMarkdown(html);
    expect(markdownToSpecs(md).map(specHtml)).toEqual([html]);
    expect(markdownToSpecs(md.replace("Parent", "Renamed")).map(specHtml)).toEqual([html.replace("Parent", "Renamed")]);
  });
});

describe("fenced code", () => {
  // A Makefile recipe needs its tab: code is kept exactly as written.
  it("keeps tabs inside a fence", () => {
    expect(markdownToSpecs("```\nall:\n\tcc main.c\n```").map(specHtml)).toEqual(["<pre>all:\n\tcc main.c</pre>"]);
  });

  // An agent edits a code block through its Markdown, so code holding a fence must survive the trip.
  it("round-trips code that holds a fence of its own", () => {
    const html = "<pre>intro\n```js\nconst x = 1\n```\noutro</pre>";
    const md = htmlToMarkdown(html);
    expect(md.trim().split("\n")[0]).toBe("````");
    expect(markdownToSpecs(md).map(specHtml)).toEqual([html]);
  });

  it("closes a fence only on a bare fence line at least as long", () => {
    expect(markdownToSpecs("```\na\n```js\nb\n```\nafter").map(specHtml)).toEqual(["<pre>a\n```js\nb</pre>", "<p>after</p>"]);
    expect(markdownToSpecs("````\na\n```\n````").map(specHtml)).toEqual(["<pre>a\n```</pre>"]);
  });
});

// Agents edit blocks through their Markdown: what the edit doesn't touch must come back as it was.
describe("Markdown round trips", () => {
  const roundTrip = (html: string) => markdownToSpecs(htmlToMarkdown(html)).map(specHtml);

  it("keeps inline code that holds backticks", () => {
    expect(htmlToMarkdown("<p>run <code>echo `date`</code> now</p>").trim()).toBe("run `` echo `date` `` now");
    expect(roundTrip("<p>run <code>echo `date`</code> now</p>")).toEqual(["<p>run <code>echo `date`</code> now</p>"]);
    expect(roundTrip("<p>x <code>``</code> and <code>a</code></p>")).toEqual(["<p>x <code>``</code> and <code>a</code></p>"]);
  });

  // The serializer switches markers to keep adjacent lists apart; a new marker is a new list.
  it("keeps adjacent lists apart by their markers", () => {
    const runs = (md: string) => markdownToSpecs(md).map((s) => [s.type, (s as { items?: unknown[] }).items?.length]);
    expect(runs("1. First\n\n1) Second")).toEqual([["ol", 1], ["ol", 1]]);
    expect(runs("- a\n* b")).toEqual([["ul", 1], ["ul", 1]]);
    expect(runs("1. a\n2. b")).toEqual([["ol", 2]]);
  });

  it("keeps a table cell's literal <br> text", () => {
    expect(htmlToMarkdown("<table><tbody><tr><td>&lt;br&gt;</td></tr></tbody></table>")).toContain("| \\<br> |");
  });
});

describe("Markdown headings", () => {
  // Only a closing run of #s after a space is markup: "C#" keeps its hash.
  it("keeps a hash that ends the heading's last word", () => {
    expect(markdownToSpecs("## Learn C#\n### Done ###").map(specHtml)).toEqual(["<h2>Learn C#</h2>", "<h3>Done</h3>"]);
  });
});

describe("stripUnsafe", () => {
  it("drops scripts, svg, event handlers and script URLs, leaving text and safe attributes alone", () => {
    expect(stripUnsafe(
      '<p onclick="x()">a <a href=" java\nscript:alert(1)">l</a><script>bad()</script>' +
      '<svg><a xlink:href="javascript:1"/></svg><img src=x onerror=alert(1)> one = two <a href="/online=1">ok</a></p>',
    )).toBe('<p>a <a>l</a><img src=x> one = two <a href="/online=1">ok</a></p>');
  });

  it("drops a script URL spelled with named character references", () => {
    expect(stripUnsafe('<a href="java&Tab;script:alert(1)">x</a><a href="javascript&colon;alert(1)">y</a>')).toBe("<a>x</a><a>y</a>");
    expect(stripUnsafe('<a href="data&colon;text/html,x">z</a><a href="/q?a=1&amp;x;javascript:1">ok</a>')).toBe('<a>z</a><a href="/q?a=1&amp;x;javascript:1">ok</a>');
  });

  it("drops what the editor scrubs: forms, templates, noscript, and id, name, srcdoc, contenteditable", () => {
    expect(stripUnsafe('<form><input value=1><button>b</button></form>after<template><p>t</p></template><noscript><p>n</p></noscript>')).toBe("after");
    expect(stripUnsafe('<p id="a" name="b" contenteditable="true" class="c">t</p>')).toBe('<p class="c">t</p>');
  });

  it("reads tags as a browser does", () => {
    // Quotes only count after "=", so this handler is an attribute of its own.
    expect(stripUnsafe('<img "x onerror=alert(1)>')).toBe('<img "x>');
    // A comment ends at the first -->, even inside what looks like a quoted value.
    expect(stripUnsafe('<!-- <a title="--><img src=x onerror=1>"> -->')).toBe('<!-- <a title="--><img src=x>"> -->');
    // Tags inside raw-text elements are text.
    expect(stripUnsafe("<xmp><b onclick=1></b></xmp>")).toBe("<xmp><b onclick=1></b></xmp>");
    expect(stripUnsafe('<title><a href="</title><img src=x onerror=alert(1)>">')).toBe('<img src=x>">');
    // A tag the input ends inside is dropped, as a browser drops it.
    expect(stripUnsafe('<p>t <a href="x')).toBe("<p>t ");
  });

  it("leaves the editor's own markup exactly as it is", () => {
    const html = '<ul class="checklist"><li data-checked="true"><b>a</b> &amp; <a href="https://x.test/?a=1&amp;b=2">l</a></li></ul>' +
      '<p style="text-align: center;"><img class="doc-image" draggable="true" src="data:image/png;base64,AA" alt="A &quot;b&quot;" style="width:120px;height:auto;"><br></p>' +
      "<pre>if (a &lt; b) {}</pre><table><tbody><tr><td>1 &gt; 0</td></tr></tbody></table><!-- note --><hr>";
    expect(stripUnsafe(html)).toBe(html);
  });

  it("takes linear time on input crafted to backtrack", () => {
    const started = performance.now();
    for (const piece of ["<script", "<a \"", "<a '\"", "<xmp>", "<link"]) stripUnsafe(piece.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("blockTypeOf", () => {
  it("names a block as the block API does", () => {
    expect([
      "<h4>x</h4>", '<ul class="checklist"><li>a</li></ul>', '<blockquote style="margin-left:40px">x</blockquote>',
      "<blockquote>x</blockquote>", '<p><img src="x"></p>', "<pre>x</pre>", "<hr>", "<table></table>", "<figure></figure>",
    ].map(blockTypeOf)).toEqual(["h3", "todo", "p", "quote", "image", "code", "divider", "table", "figure"]);
  });
});

describe("retypeSpec", () => {
  it("turns text into another text type, keeping its markup and alignment", () => {
    expect(retypeSpec('<p style="text-align: center;">Hi <b>there</b></p>', "h1"))
      .toEqual({ type: "html", html: '<h1 style="text-align: center;">Hi <b>there</b></h1>' });
  });

  it("turns text into a list item or code, and code into lines", () => {
    expect(retypeSpec("<h2>Hi</h2>", "todo")).toEqual({ type: "todo", items: [{ html: "Hi" }] });
    expect(retypeSpec("<p>a<br>b &amp; c</p>", "code")).toEqual({ type: "code", text: "a\nb & c" });
    expect(retypeSpec("<pre>a\nb\n</pre>", "ul")).toEqual({ type: "ul", items: [{ html: "a" }, { html: "b" }] });
  });

  it("swaps a list's kind, dropping checks when it stops being a to-do list", () => {
    expect(retypeSpec("<ul><li>a</li></ul>", "todo")).toEqual({ type: "html", html: '<ul class="checklist"><li>a</li></ul>' });
    expect(retypeSpec('<ul class="checklist"><li data-checked="true">a</li></ul>', "ol")).toEqual({ type: "html", html: "<ol><li>a</li></ol>" });
  });

  it("refuses a change that needs new content", () => {
    expect(() => retypeSpec("<hr>", "h1")).toThrow("Can't turn this divider block into h1 by type alone");
  });
});

describe("setItemChecked", () => {
  it("checks or unchecks the nth top-level item, not a nested one", () => {
    const html = '<ul class="checklist"><li>a<ul><li>n</li></ul></li><li data-checked="true">b</li></ul>';
    expect(setItemChecked(html, 1, false)).toBe('<ul class="checklist"><li>a<ul><li>n</li></ul></li><li>b</li></ul>');
    expect(setItemChecked(html, 0, true)).toBe('<ul class="checklist"><li data-checked="true">a<ul><li>n</li></ul></li><li data-checked="true">b</li></ul>');
  });

  it("refuses a block that is not a to-do list, and an item that is not there", () => {
    expect(() => setItemChecked("<ul><li>a</li></ul>", 0, true)).toThrow("That block is not a to-do list.");
    expect(() => setItemChecked('<ul class="checklist"><li>a</li></ul>', 3, true)).toThrow("No item 3 in that list.");
  });
});

describe("mergeBlockList", () => {
  // setMarkdown is not a wipe-and-replace: open editors see only what changed.
  it("keeps unchanged blocks, updates changed ones in place, and inserts the rest", () => {
    const merged = mergeBlockList(
      [{ id: "a", html: "<p>1</p>" }, { id: "b", html: "<p>2</p>" }, { id: "c", html: "<p>3</p>" }],
      ["<p>1</p>", "<p>2x</p>", "<p>new</p>", "<p>3</p>"],
    );
    expect(merged.map((block) => block.html)).toEqual(["<p>1</p>", "<p>2x</p>", "<p>new</p>", "<p>3</p>"]);
    expect(merged[0].id).toBe("a");
    expect(merged[1].id).toBe("b");
    expect(merged[2].id).toMatch(/^b_[0-9a-f-]{36}$/);
    expect(merged[3].id).toBe("c");
  });
});

describe("resolvePosition", () => {
  const list = [{ id: "a", html: "" }, { id: "b", html: "" }];
  it("places after or before a block, at an index (negative from the end), or at the end", () => {
    expect(resolvePosition(list, { afterId: "a" })).toBe(1);
    expect(resolvePosition(list, { beforeId: "b" })).toBe(1);
    expect(resolvePosition(list, { index: 0 })).toBe(0);
    expect(resolvePosition(list, { index: -1 })).toBe(2);
    expect(resolvePosition(list, {})).toBe(2);
    expect(() => resolvePosition(list, { beforeId: "zz" })).toThrow("Unknown block id: zz");
  });
});

// An agent reads blocks as Markdown and may pass them back: escaped text must come back as text.
describe("Markdown round trip", () => {
  it("reads every escape the Markdown export writes back as the same text", () => {
    for (const text of ["1. not a list", "2) two", "- dash", "# hash", "&gt; quote", "+ plus", "---", "a `tick` and &lt;b&gt;tag&lt;/b&gt;", "a*b_c [x] \\"]) {
      const html = `<p>${text}</p>`;
      expect(specsFrom({ markdown: htmlToMarkdown(html) }).map(specHtml).join("")).toBe(html);
    }
  });
});
