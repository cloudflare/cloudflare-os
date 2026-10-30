import { describe, expect, it } from "vitest";
import { gadgetUiAnswerAsText, parseGadgetUiBlocks } from "@gadgets/workshop-shared/gadget-ui-blocks";

const lines = (...parts: string[]) => parts.join("\n");

describe("parseGadgetUiBlocks", () => {
  it("splits an answer into prose and blocks, in order, with each prose part's offset", () => {
    let answer = lines(
      "Food is up 18%.",
      "<gadget-ui>",
      "<title> Food, October </title>",
      "<div id=chart></div>",
      "</gadget-ui>",
      "Want weekly totals?",
    );
    expect(parseGadgetUiBlocks(answer)).toEqual([
      { kind: "text", text: "Food is up 18%.\n", start: 0 },
      { kind: "block", title: "Food, October",
        html: "<title> Food, October </title>\n<div id=chart></div>" },
      { kind: "text", text: "\nWant weekly totals?", start: answer.indexOf("\nWant") },
    ]);
  });

  it("refuses a block with nothing but a title, or nothing at all, whatever its attributes", () => {
    let segments = parseGadgetUiBlocks(lines(
      "<gadget-ui></gadget-ui>",
      "<gadget-ui>", "  <title>Plan</title>  ", "</gadget-ui>",
      "\t <gadget-ui class='wide'>", "<title>Plan</title><p>Step one</p>", "</gadget-ui>",
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
    expect(parseGadgetUiBlocks(lines("<gadget-ui>", html, "</gadget-ui>")))
        .toEqual([{ kind: "block", html }]);
    expect(parseGadgetUiBlocks(lines("<gadget-ui>", html))).toEqual([
      { kind: "open", text: lines("<gadget-ui>", html), html },
    ]);
  });

  it("leaves a tag in a code fence or mid-line as prose", () => {
    let text = lines(
      "Write `<gadget-ui>` to draw a view:",
      "````html",
      "<gadget-ui>",
      "```",
      "</gadget-ui>",
      "````",
      "Done. <gadget-ui>not a block</gadget-ui>",
    );
    expect(parseGadgetUiBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
  });

  it("closes a fence only on a bare marker of the same kind, at least as long", () => {
    let segments = parseGadgetUiBlocks(lines(
      "~~~~", "~~~", "```", "<gadget-ui>", "still code", "</gadget-ui>", "~~~~",
      "<gadget-ui>", "a view", "</gadget-ui>",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block"]);
  });

  it("closes a fence at most three spaces deeper than the line that opened it", () => {
    let segments = parseGadgetUiBlocks(lines(
      "1. Start it:", "    ```sh", "    npm start", "    ```",
      "<gadget-ui>", "a view", "</gadget-ui>",
      "```", "        ```", "<gadget-ui>", "still code", "</gadget-ui>", "```",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block", "text"]);
  });

  it("reads a fence that follows a list or quote marker on its line as code, open or closed", () => {
    for (let marker of ["1. ", "- ", "* ", "2) ", "> ", "- > "]) {
      let pad = " ".repeat(marker.length);
      let example = [`${marker}\`\`\`html`, `${pad}<gadget-ui>`, `${pad}<p>an example</p>`, `${pad}</gadget-ui>`];
      expect(parseGadgetUiBlocks(lines(...example)).map(s => s.kind), marker).toEqual(["text"]);
      expect(parseGadgetUiBlocks(lines(...example, `${pad}\`\`\``, "<gadget-ui>", "a view", "</gadget-ui>"))
          .map(s => s.kind), marker).toEqual(["text", "block"]);
    }
  });

  it("keeps an unclosed block open, with its HTML so far and its title once streamed", () => {
    let streamed = lines("Here it comes:", "<gadget-ui>", "<title>Plan</title>", "<div>");
    expect(parseGadgetUiBlocks(streamed)).toEqual([
      { kind: "text", text: "Here it comes:\n", start: 0 },
      { kind: "open", text: "<gadget-ui>\n<title>Plan</title>\n<div>", html: "<title>Plan</title>\n<div>", title: "Plan" },
    ]);
    expect(parseGadgetUiBlocks("<gadget-ui>\n<ti")).toEqual([{ kind: "open", text: "<gadget-ui>\n<ti", html: "<ti" }]);
  });

  it("keeps each block at its place among the segments at every cut of a streamed answer", () => {
    // The Workshop keeps a view by that place, from the moment its block opens, and writes an open
    // block's HTML into the view as it grows.
    let answer = lines(
      "Intro.", "<gadget-ui>", "<title>One</title>", "<p>1 < 2</p>", "</gadget-ui>",
      "<gadget-ui class='wide'>", "  <p>two</p>  ", "", "</gadget-ui>", "Outro.",
    );
    let final = parseGadgetUiBlocks(answer);
    let blocksAt = final.flatMap((segment, i) => segment.kind === "block" ? [i] : []);
    let opensAt = [...answer.matchAll(/^<gadget-ui[^>]*>/gm)].map(tag => tag.index + tag[0].length);
    for (let cut = 0; cut <= answer.length; cut++) {
      let parsed = parseGadgetUiBlocks(answer.slice(0, cut));
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

describe("gadgetUiAnswerAsText", () => {
  it("puts a note that names each closed view in its place, and keeps an unclosed one", () => {
    let answer = lines(
      "Food is up 18%.", "<gadget-ui>", "<title>Food\n  by week</title>", "<script>draw()</script>",
      "</gadget-ui>", "<gadget-ui>", "<p>untitled</p>", "</gadget-ui>",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    );
    expect(gadgetUiAnswerAsText(answer)).toBe(lines(
      "Food is up 18%.", "[View in the chat: Food by week]", "[View in the chat]",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    ));
  });
});
