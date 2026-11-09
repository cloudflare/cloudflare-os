import { describe, expect, it } from "vitest";
import { parseInlineHtmlBlocks } from "@gadgets/workshop-shared/inline-html-blocks";

const lines = (...parts: string[]) => parts.join("\n");
const kinds = (...parts: string[]) => parseInlineHtmlBlocks(lines(...parts)).map(s => s.kind);
const VIEW = ["<inline-html>", "<p>a view</p>", "</inline-html>"];
const EXAMPLE = ["<inline-html>", "<script>agent.send(\"Example only\")</script>", "</inline-html>"];

describe("parseInlineHtmlBlocks", () => {
  it("splits an answer into prose and blocks, in order, with each prose part's offset", () => {
    let answer = lines(
      "Food is up 18%.",
      "<inline-html>",
      "<title> Food, October </title>",
      "<div id=chart></div>",
      "</inline-html>",
      "Want weekly totals?",
    );
    expect(parseInlineHtmlBlocks(answer)).toEqual([
      { kind: "text", text: "Food is up 18%.\n", start: 0 },
      { kind: "block", title: "Food, October",
        html: "<title> Food, October </title>\n<div id=chart></div>" },
      { kind: "text", text: "\nWant weekly totals?", start: answer.indexOf("\nWant") },
    ]);
  });

  it("refuses a block with nothing but a title, or nothing at all", () => {
    let segments = parseInlineHtmlBlocks(lines(
      "<inline-html>", "</inline-html>",
      "<inline-html>", "  <title>Plan</title>  ", "</inline-html>",
      "<inline-html>", "<title>Plan</title><p>Step one</p>", "</inline-html>",
    ));
    expect(segments.flatMap(s => s.kind === "block" ? [[s.title, s.error]] : [])).toEqual([
      [undefined, "This view has no content."],
      ["Plan", "This view has no content."],
      ["Plan", undefined],
    ]);
  });

  it("parses a long block whose <title> never closes", () => {
    // Large enough that a pattern which rescans from each unclosed <title> exceeds the test timeout.
    let html = "<title>" + "<title>a".repeat(100_000);
    expect(parseInlineHtmlBlocks(lines("<inline-html>", html, "</inline-html>")))
        .toEqual([{ kind: "block", html }]);
    expect(parseInlineHtmlBlocks(lines("<inline-html>", html))).toEqual([
      { kind: "open", text: lines("<inline-html>", html), html },
    ]);
  });

  it("parses a long code example of tag lines, and many examples each followed by a view", () => {
    // Large enough that parsing the Markdown again for each tag line, or the rest of the answer
    // for each view, exceeds the test timeout.
    let example = lines("```html", ...Array.from({ length: 4_000 }, () => "<inline-html>"), "```");
    expect(parseInlineHtmlBlocks(example)).toEqual([{ kind: "text", text: example, start: 0 }]);
    expect(kinds(example, "<inline-html>", "<p>a view</p>", "</inline-html>")).toEqual(["text", "block"]);
    let repeated = Array.from({ length: 1_000 }, () => lines("```", "<inline-html>", "```", ...VIEW)).join("\n");
    expect(kinds(repeated)).toEqual(Array.from({ length: 1_000 }, () => ["text", "block"]).flat());
  });

  it("counts a tag only alone on its line, with no indent", () => {
    let text = lines(
      "Write `<inline-html>` to draw a view.",
      "Done. <inline-html><p>not a block</p></inline-html>",
      "  <inline-html>", "<p>indented</p>", "</inline-html>",
      "<inline-html class='wide'>", "<p>with attributes</p>", "</inline-html>",
    );
    expect(parseInlineHtmlBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
    expect(parseInlineHtmlBlocks(lines(
      "<inline-html>  ", "<p>a</inline-html></p>", "  </inline-html>", "<p>b</p>", "</inline-html>\t",
    ))).toEqual([{ kind: "block", html: "<p>a</inline-html></p>\n  </inline-html>\n<p>b</p>" }]);
  });

  it("leaves a block in a code fence as prose, and closes the fence only on a bare marker of the same kind, at least as long", () => {
    let text = lines("````html", ...VIEW, "```", ...EXAMPLE, "````");
    expect(parseInlineHtmlBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
    expect(kinds("~~~~", "~~~", "```", ...EXAMPLE, "~~~~ x", "~~~~", ...VIEW)).toEqual(["text", "block"]);
  });

  it("closes a fence at three spaces of indent or less, however deep its opener is", () => {
    expect(kinds("  ```html", "  example", "    ```", ...EXAMPLE, "```")).toEqual(["text"]);
    expect(kinds("  ~~~html", "  example", "\t~~~", ...EXAMPLE, "~~~")).toEqual(["text"]);
    expect(kinds("   ```html", "   example", "   ```", ...VIEW)).toEqual(["text", "block"]);
  });

  it("ends a fence in a list item or block quote at the first line indented less than its marker", () => {
    // Such a fence cannot hold a tag line, which ends its container, but the line that ends it may
    // open a fence at the left.
    for (let marker of ["1. ", "- ", "* ", "2) ", "10. ", "> ", "- > ", "1.\t"]) {
      let pad = marker.replace(/[^>\t]/g, " ");
      let fenced = [`${marker}\`\`\`html`, `${pad}example`, `${pad}\`\`\``];
      expect(kinds(...fenced, ...VIEW), marker).toEqual(["text", "block"]);
      expect(kinds(`${marker}\`\`\`html`, `${pad}example`, ...VIEW), marker).toEqual(["text", "block"]);
      expect(kinds(...fenced, "```", ...EXAMPLE, "```"), marker).toEqual(["text"]);
    }
    expect(kinds("10. Start it:", "    ```sh", "    npm start", "  ```", ...EXAMPLE, "```")).toEqual(["text"]);
    expect(kinds("Run:", "    ```sh", "    npm start", ...VIEW)).toEqual(["text", "block"]);
  });

  it("keeps a fence in the list item it continues, so an outdented fence opens a new one", () => {
    expect(kinds("- Example:", "  ```html", "  code", "```", ...EXAMPLE, "```")).toEqual(["text"]);
    expect(kinds("1. Example:", "", "   ```text", "   example", "```", ...EXAMPLE, "```")).toEqual(["text"]);
    expect(kinds("- Example:", "  ```html", "  code", ...VIEW)).toEqual(["text", "block"]);
    // With no list item open, a line at the left does not end an indented fence.
    expect(kinds("- Item", "", "Example:", "  ```html", ...EXAMPLE, "  ```")).toEqual(["text"]);
  });

  it("reads code blocks after thematic breaks, paragraphs, lazy lines and HTML as Markdown does", () => {
    let example = [...EXAMPLE, "```"];
    expect(kinds("* * *", "  ```html", ...example)).toEqual(["text"]);
    expect(kinds("- - -", "  ```html", ...example)).toEqual(["text"]);
    // An item numbered 2 cannot interrupt a paragraph, so no list holds the fence.
    expect(kinds("Paragraph", "2. Example", "   ```html", ...example)).toEqual(["text"]);
    expect(kinds("- Example:", "lazy continuation", "  ```html", "  code", "```", ...example)).toEqual(["text"]);
    expect(kinds("<div>", "```", "", "```", ...example)).toEqual(["text"]);
  });

  it("reads \\r\\n and a lone \\r as line endings, with offsets into the original text", () => {
    let answer = ["Run it:", "```js", "start();", "```", ...VIEW, "Done."].join("\r\n");
    let segments = parseInlineHtmlBlocks(answer);
    expect(segments.map(s => s.kind)).toEqual(["text", "block", "text"]);
    for (let segment of segments) {
      if (segment.kind === "text") expect(answer.slice(segment.start, segment.start + segment.text.length)).toBe(segment.text);
    }
    let mixed = `\`\`\`\r\nexample\r\n\`\`\`\r\n\n\`\`\`\n${lines(...EXAMPLE)}\n\`\`\``;
    expect(parseInlineHtmlBlocks(mixed)).toEqual([{ kind: "text", text: mixed, start: 0 }]);
    expect(parseInlineHtmlBlocks("```\rexample\r```\r<inline-html>\ra view\r</inline-html>").map(s => s.kind))
      .toEqual(["text", "block"]);
  });

  it("keeps an unclosed block open, with its HTML so far and its title once streamed", () => {
    let streamed = lines("Here it comes:", "<inline-html>", "<title>Plan</title>", "<div>");
    expect(parseInlineHtmlBlocks(streamed)).toEqual([
      { kind: "text", text: "Here it comes:\n", start: 0 },
      { kind: "open", text: "<inline-html>\n<title>Plan</title>\n<div>", html: "<title>Plan</title>\n<div>", title: "Plan" },
    ]);
    expect(parseInlineHtmlBlocks("<inline-html>\n<p>a</p>\n</inline-ht"))
      .toEqual([{ kind: "open", text: "<inline-html>\n<p>a</p>\n</inline-ht", html: "<p>a</p>" }]);
  });

  it("while an answer streams, opens or closes a block only once its tag line ends", () => {
    let streaming = { streaming: true };
    expect(parseInlineHtmlBlocks("Intro\n<inline-html>", streaming))
      .toEqual([{ kind: "text", text: "Intro\n<inline-html>", start: 0 }]);
    let block = lines("<inline-html>", "<p>a</p>", "</inline-html>");
    expect(parseInlineHtmlBlocks(block)).toEqual([{ kind: "block", html: "<p>a</p>" }]);
    for (let text of [block, `${block} `]) {
      expect(parseInlineHtmlBlocks(text, streaming)).toEqual([{ kind: "open", text, html: "<p>a</p>" }]);
    }
    expect(parseInlineHtmlBlocks(`${block}x`, streaming))
      .toEqual([{ kind: "open", text: `${block}x`, html: "<p>a</p>\n</inline-html>x" }]);
  });

  it("keeps each block at its place among the segments at every cut of a streamed answer", () => {
    // The Workshop keeps a view by that place, from the moment its block opens, and writes an open
    // block's HTML into the view as it grows.
    let answer = lines(
      "Intro.", "<inline-html>", "<title>One</title>", "<p>1 < 2</p>", "</inline-html>x", "</inline-html>",
      "<inline-html>", "  <p>two</p>  ", "", "</inline-html>", "Outro.",
    );
    let final = parseInlineHtmlBlocks(answer);
    let blocksAt = final.flatMap((segment, i) => segment.kind === "block" ? [i] : []);
    let opensAt = [...answer.matchAll(/^<inline-html>\n/gm)].map(tag => tag.index + tag[0].length);
    for (let cut = 0; cut <= answer.length; cut++) {
      let parsed = parseInlineHtmlBlocks(answer.slice(0, cut), { streaming: true });
      expect(parsed.flatMap((segment, i) => segment.kind === "text" ? [] : [i]), `blocks at cut ${cut}`)
        .toEqual(blocksAt.filter((_, n) => opensAt[n] <= cut));
      parsed.forEach((segment, i) => {
        let block = final[i];
        if (segment.kind === "text" || block?.kind !== "block") return;
        if (segment.kind === "block") expect(segment).toEqual(block);
        else expect(block.html.slice(0, segment.html.length)).toBe(segment.html);
      });
    }
  });
});
