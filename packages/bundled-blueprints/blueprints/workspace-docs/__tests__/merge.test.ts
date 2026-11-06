// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergeBlockHtml } from "../files/lib/merge.ts";

const merge = (base: string, theirs: string, mine: string) => mergeBlockHtml(base, theirs, mine).html;

describe("mergeBlockHtml: text", () => {
  it("keeps either side when only one changed", () => {
    expect(merge("<p>a b</p>", "<p>a b</p>", "<p>a c</p>")).toBe("<p>a c</p>");
    expect(merge("<p>a b</p>", "<p>a c</p>", "<p>a b</p>")).toBe("<p>a c</p>");
    expect(merge("<p>a b</p>", "<p>a c</p>", "<p>a c</p>")).toBe("<p>a c</p>");
  });

  it("keeps both sides' edits to different words", () => {
    expect(merge("<p>The quick brown fox jumps.</p>", "<p>The slow brown fox jumps.</p>", "<p>The quick brown fox leaps.</p>"))
      .toBe("<p>The slow brown fox leaps.</p>");
  });

  it("keeps adjacent edits: a word changed beside a word inserted", () => {
    expect(merge("<p>one two three</p>", "<p>one 2 three</p>", "<p>one two and a half three</p>"))
      .toBe("<p>one 2 and a half three</p>");
    // The local side typing at the end while the other side edits the start.
    expect(merge("<p>Hello world</p>", "<p>Hi world</p>", "<p>Hello world, and more</p>")).toBe("<p>Hi world, and more</p>");
  });

  it("lets the local side win where both changed the same word", () => {
    expect(merge("<p>a cat sat</p>", "<p>a dog sat</p>", "<p>a cow sat</p>")).toBe("<p>a cow sat</p>");
    // ... and only there.
    expect(merge("<p>a cat sat down</p>", "<p>a dog sat up</p>", "<p>a cow sat down</p>")).toBe("<p>a cow sat up</p>");
  });

  it("keeps both insertions at one point, the local one first", () => {
    expect(merge("<p>Hello</p>", "<p>Hello there</p>", "<p>Hello world</p>")).toBe("<p>Hello world there</p>");
  });

  it("does not repeat an insertion one side already contains (a save whose reply was lost)", () => {
    expect(merge("<p>Hello</p>", "<p>Hello world</p>", "<p>Hello world, again</p>")).toBe("<p>Hello world, again</p>");
    expect(merge("<p>Hello</p>", "<p>Hello world, again</p>", "<p>Hello world</p>")).toBe("<p>Hello world</p>");
  });

  it("applies a deletion beside an edit", () => {
    expect(merge("<p>one two three four</p>", "<p>one three four</p>", "<p>one two three 4</p>")).toBe("<p>one three 4</p>");
  });

  it("lets an edit win over a deletion of the same word", () => {
    expect(merge("<p>one two three</p>", "<p>one three</p>", "<p>one TWO three</p>")).toBe("<p>one TWO three</p>");
    expect(merge("<p>one two three</p>", "<p>one TWO three</p>", "<p>one three</p>")).toBe("<p>one three</p>");
  });

  it("deletes everything either side deleted when both only deleted", () => {
    expect(merge("<p>one two three</p>", "<p>one two</p>", "<p>one three</p>")).toBe("<p>one </p>");
  });

  it("merges into and out of empty blocks", () => {
    expect(merge("<p><br></p>", "<p>agent text</p>", "<p><br></p>")).toBe("<p>agent text</p>");
    expect(merge("<p><br></p>", "<p>agent</p>", "<p>mine</p>")).toBe("<p>mine</p>");
    expect(merge("<p>gone</p>", "<p><br></p>", "<p>gone soon</p>")).toBe("<p><br> soon</p>");
  });

  it("keeps entities and non-breaking spaces as the browser writes them", () => {
    expect(merge("<p>a &amp; b&nbsp;</p>", "<p>A &amp; b&nbsp;</p>", "<p>a &amp; b&nbsp;c &lt;d&gt;</p>")).toBe("<p>A &amp; b&nbsp;c &lt;d&gt;</p>");
  });
});

describe("mergeBlockHtml: spaces", () => {
  it("treats a space and a non-breaking space alike, keeping the local kind", () => {
    // Typing after a trailing &nbsp; turns it into a space; the agent's Markdown round trip does too.
    expect(merge("<p>one two&nbsp;</p>", "<p>ONE two </p>", "<p>one two three</p>")).toBe("<p>ONE two three</p>");
    expect(merge("<p>one two </p>", "<p>ONE two </p>", "<p>one two&nbsp;</p>")).toBe("<p>ONE two&nbsp;</p>");
  });

  it("keeps both words typed at one spot, however each side spaced them", () => {
    // Found by the two-page fuzz: each side retyped the space between the words differently.
    expect(merge("<p>Qb38Q&nbsp; Qb39Q</p>", "<p>Qb38Q Qg122Q Qb39Q</p>", "<p>Qb38Q&nbsp; &nbsp; Qa121Q&nbsp; Qa117Q Qb39Q</p>"))
      .toBe("<p>Qb38Q&nbsp; &nbsp; Qa121Q&nbsp; Qa117Q Qg122Q Qb39Q</p>");
  });

  it("does not glue a word typed after a space to the word before when the other side trims the space", () => {
    // The agent's Markdown round trip drops a trailing space the user is typing after.
    expect(merge("<p>end&nbsp;</p>", "<p>END</p>", "<p>end next</p>")).toBe("<p>END next</p>");
    expect(merge("<p>end&nbsp;</p>", "<p>end</p>", "<p>end next</p>")).toBe("<p>end next</p>");
  });

  it("compares spacing exactly in a code block", () => {
    expect(merge("<pre>a = 1<br>b = 2</pre>", "<pre>a =  1<br>b = 2</pre>", "<pre>a = 1<br>b = 3</pre>")).toBe("<pre>a =  1<br>b = 3</pre>");
  });
});

describe("mergeBlockHtml: formatting", () => {
  it("keeps one side's bold beside the other's text edit", () => {
    expect(merge("<p>make this bold and that</p>", "<p>make this bold and those</p>", "<p>make <b>this bold</b> and that</p>"))
      .toBe("<p>make <b>this bold</b> and those</p>");
  });

  it("edits text inside formatting the other side added", () => {
    expect(merge("<p>a link here</p>", "<p>a <a href=\"https://x.test\">link</a> here</p>", "<p>a link here, fixed</p>"))
      .toBe("<p>a <a href=\"https://x.test\">link</a> here, fixed</p>");
  });

  it("always produces balanced tags, even when formatting edits overlap", () => {
    const html = merge("<p><b>x y</b> z</p>", "<p>x y z</p>", "<p><b>x y z</b></p>");
    // Theirs unbolded "x y", mine bolded " z": both hold, and the tags still pair up.
    expect(html).toBe("<p>x y<b> z</b></p>");
    const nested = merge("<p>a <i>b <b>c</b></i> d</p>", "<p>a <i>b <b>c</b></i> D</p>", "<p>A <i>b <b>c</b> e</i> d</p>");
    expect(nested).toBe("<p>A <i>b <b>c</b> e</i> D</p>");
  });

  it("formatting changed on a word the other side edited: the local side wins that word", () => {
    expect(merge("<p>one two three</p>", "<p>one 2 three</p>", "<p>one <b>two</b> three</p>")).toBe("<p>one <b>two</b> three</p>");
  });

  it("keeps inline code, colours and line breaks", () => {
    expect(merge("<p>run <code>npm</code> now<br>then</p>", "<p>run <code>pnpm</code> now<br>then</p>", "<p>run <code>npm</code> now<br>then <span class=\"tc-red\">stop</span></p>"))
      .toBe("<p>run <code>pnpm</code> now<br>then <span class=\"tc-red\">stop</span></p>");
  });
});

describe("mergeBlockHtml: block element", () => {
  it("merges the tag and each attribute separately", () => {
    expect(merge("<h1>Title</h1>", "<h1>Title text</h1>", "<h2>Title</h2>")).toBe("<h2>Title text</h2>");
    expect(merge("<p>left</p>", "<p style=\"text-align: center;\">left</p>", "<p>left side</p>")).toBe("<p style=\"text-align: center;\">left side</p>");
    expect(merge("<p>x</p>", "<p style=\"text-align: center;\">x</p>", "<p style=\"text-align: right;\">x</p>")).toBe("<p style=\"text-align: right;\">x</p>");
  });

  it("follows a conversion into a list made on either side", () => {
    expect(merge("<p>item one</p>", "<ul><li>item one</li></ul>", "<p>item one!</p>")).toBe("<ul><li>item one!</li></ul>");
    expect(merge("<p>item one</p>", "<p>item 1</p>", "<ol><li>item one</li></ol>")).toBe("<ol><li>item 1</li></ol>");
  });

  it("keeps the local block whole rather than build a shape no side had", () => {
    // A heading on one side and a list on the other: a list item can't go in a heading.
    expect(merge("<h1>x</h1>", "<ul><li>x</li></ul>", "<h2>x y</h2>")).toBe("<h2>x y</h2>");
  });
});

describe("mergeBlockHtml: lists and to-dos", () => {
  const todo = (...items: [string, boolean][]) => `<ul class="checklist">${items.map(([t, c]) => `<li${c ? " data-checked=\"true\"" : ""}>${t}</li>`).join("")}</ul>`;

  it("keeps an item ticked on one side and edited on the other", () => {
    expect(merge(todo(["buy milk", false], ["call Bob", false]), todo(["buy milk", true], ["call Bob", false]), todo(["buy oat milk", false], ["call Bob", false])))
      .toBe(todo(["buy oat milk", true], ["call Bob", false]));
  });

  it("keeps items added on both sides in different places", () => {
    expect(merge("<ul><li>a</li><li>b</li></ul>", "<ul><li>a</li><li>a2</li><li>b</li></ul>", "<ul><li>a</li><li>b</li><li>c</li></ul>"))
      .toBe("<ul><li>a</li><li>a2</li><li>b</li><li>c</li></ul>");
  });

  it("keeps both new items added at the same place", () => {
    expect(merge("<ul><li>a</li></ul>", "<ul><li>a</li><li>theirs</li></ul>", "<ul><li>a</li><li>mine</li></ul>"))
      .toBe("<ul><li>a</li><li>mine</li><li>theirs</li></ul>");
  });

  it("keeps nested lists and text after them", () => {
    const base = "<ul><li>top<ul><li>sub</li></ul>after</li><li>next</li></ul>";
    expect(merge(base, base.replace("next", "NEXT"), base.replace("sub", "sub item"))).toBe("<ul><li>top<ul><li>sub item</li></ul>after</li><li>NEXT</li></ul>");
  });

  it("an item deleted on one side and edited on the other keeps the edit", () => {
    expect(merge("<ul><li>a</li><li>b</li><li>c</li></ul>", "<ul><li>a</li><li>c</li></ul>", "<ul><li>a</li><li>b!</li><li>c</li></ul>"))
      .toBe("<ul><li>a</li><li>b!</li><li>c</li></ul>");
  });
});

describe("mergeBlockHtml: tables", () => {
  const table = (rows: string[][], cols?: number) =>
    "<table>" + (cols ? "<colgroup>" + "<col style=\"width: 50%;\">".repeat(cols) + "</colgroup>" : "") +
    "<tbody>" + rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>";

  it("keeps edits to different cells", () => {
    expect(merge(table([["a", "b"], ["c", "d"]]), table([["a", "B"], ["c", "d"]]), table([["a", "b"], ["c", "d!"]])))
      .toBe(table([["a", "B"], ["c", "d!"]]));
  });

  it("keeps a row added on one side and a cell edited on the other", () => {
    expect(merge(table([["a", "b"]]), table([["a", "b"], ["<br>", "<br>"]]), table([["a!", "b"]]))).toBe(table([["a!", "b"], ["<br>", "<br>"]]));
  });

  it("refuses a ragged table: a column on one side, a row on the other", () => {
    const base = table([["a", "b"]]);
    const theirs = table([["a", "b", "<br>"]]), mine = table([["a", "b"], ["c", "d"]]);
    expect(merge(base, theirs, mine)).toBe(mine);
  });

  it("checks column widths against the cells", () => {
    const base = table([["a", "b"]], 2), mine = table([["a", "b"], ["c", "d"]], 2);
    const theirs = table([["a", "b", "x"]], 3);
    expect(merge(base, theirs, mine)).toBe(mine);
  });
});

describe("mergeBlockHtml: positions", () => {
  it("maps a caret in the local text past text the other side inserted before it", () => {
    // Local caret after "world" (11 characters in), the other side added "Oh, " in front.
    const m = mergeBlockHtml("<p>Hello world</p>", "<p>Oh, Hello world</p>", "<p>Hello world!</p>");
    expect(m.html).toBe("<p>Oh, Hello world!</p>");
    expect(m.mapPosition(12)).toBe(16);
    expect(m.mapPosition(0)).toBe(0);
  });

  it("keeps a caret at the end of the local insertion before the other side's at the same point", () => {
    const m = mergeBlockHtml("<p>Hello</p>", "<p>Hello there</p>", "<p>Hello world</p>");
    expect(m.html).toBe("<p>Hello world there</p>");
    expect(m.mapPosition(11)).toBe(11);
  });

  it("moves a caret in a deleted word to where the deletion was", () => {
    const m = mergeBlockHtml("<p>one two three</p>", "<p>one three</p>", "<p>one two three!</p>");
    expect(m.html).toBe("<p>one three!</p>");
    expect(m.mapPosition(6)).toBe(4); // inside "two" -> after "one "
    expect(m.mapPosition(14)).toBe(10); // after "!"
  });

  it("counts structure: one position where each list item opens", () => {
    // <li>a</li><li>b</li>: li(1) a(2) li(3) b(4). The other side adds an item in front.
    const m = mergeBlockHtml("<ul><li>a</li><li>b</li></ul>", "<ul><li>z</li><li>a</li><li>b</li></ul>", "<ul><li>a</li><li>bc</li></ul>");
    expect(m.html).toBe("<ul><li>z</li><li>a</li><li>bc</li></ul>");
    expect(m.mapPosition(5)).toBe(7);
    expect(m.mapPosition(3)).toBe(5); // start of the second item
  });

  it("is the identity when the local side is kept whole", () => {
    const m = mergeBlockHtml("<h1>x</h1>", "<ul><li>x</li></ul>", "<h2>x y</h2>");
    expect(m.mapPosition(3)).toBe(3);
  });
});

describe("mergeBlockHtml: properties", () => {
  // Random word edits on both sides of a base: every word one side inserted in a
  // stretch the other side left alone survives, exactly once, and the result is balanced.
  it("never drops or duplicates non-overlapping edits", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const words = Array.from({ length: 12 }, (_, i) => "w" + i);
    for (let round = 0; round < 300; round++) {
      // Each side edits its own half, so nothing overlaps.
      const mine = [...words], theirs = [...words];
      const mineAt = Math.floor(rnd() * 5), theirAt = 7 + Math.floor(rnd() * 5);
      const mineOp = Math.floor(rnd() * 3), theirOp = Math.floor(rnd() * 3);
      const edit = (arr: string[], at: number, op: number, tag: string) => {
        if (op === 0) arr.splice(at, 0, tag);
        else if (op === 1) arr[at] = tag;
        else arr.splice(at, 1);
      };
      edit(theirs, theirAt, theirOp, "T" + round);
      edit(mine, mineAt, mineOp, "M" + round);
      const expected = [...words];
      edit(expected, theirAt, theirOp, "T" + round);
      edit(expected, mineAt, mineOp, "M" + round);
      const p = (arr: string[]) => `<p>${arr.map((w) => /^w\d+$/.test(w) && Number(w.slice(1)) % 3 === 1 ? `<b>${w}</b>` : w).join(" ")}</p>`;
      expect(merge(p(words), p(theirs), p(mine)).replace(/<\/b> <b>/g, " ")).toBe(p(expected).replace(/<\/b> <b>/g, " "));
    }
  });

  // Random edits of every kind on both sides of random list blocks: the result is
  // one balanced element, every word the local side added is there exactly once,
  // and every word the other side added at most once.
  it("stays well-formed under random concurrent edits", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    type Item = { words: string[]; bold: Set<number>; checked: boolean };
    const html = (items: Item[]) => `<ul class="checklist">${items.map((item) =>
      `<li${item.checked ? " data-checked=\"true\"" : ""}>${item.words.map((w, k) => item.bold.has(k) ? `<b>${w}</b>` : w).join(" ") || "<br>"}</li>`).join("")}</ul>`;
    const clone = (items: Item[]) => items.map((item) => ({ words: [...item.words], bold: new Set(item.bold), checked: item.checked }));
    let fresh = 0;
    const edit = (items: Item[], tag: string, added: string[]) => {
      for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
        const item = pick(items), op = Math.floor(rnd() * 6), at = Math.floor(rnd() * (item.words.length + 1));
        if (op === 0) { const w = `${tag}${fresh++}`; item.words.splice(at, 0, w); added.push(w); }
        else if (op === 1 && item.words.length) item.words.splice(Math.min(at, item.words.length - 1), 1);
        else if (op === 2 && item.words.length) item.bold.add(Math.min(at, item.words.length - 1));
        else if (op === 3) item.checked = !item.checked;
        else if (op === 4) { const w = `${tag}${fresh++}`; items.splice(items.indexOf(item) + 1, 0, { words: [w], bold: new Set(), checked: false }); added.push(w); }
        else if (op === 5 && items.length > 1) items.splice(items.indexOf(item), 1);
      }
    };
    for (let round = 0; round < 400; round++) {
      const base: Item[] = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({ words: Array.from({ length: Math.floor(rnd() * 5) }, (_unused, k) => `w${i}x${k}`), bold: new Set<number>(), checked: false }));
      const mine = clone(base), theirs = clone(base), mineAdded: string[] = [], theirAdded: string[] = [];
      edit(mine, "M", mineAdded);
      edit(theirs, "T", theirAdded);
      const out = merge(html(base), html(theirs), html(mine));
      expect(out).toMatch(/^<ul class="checklist">(?:<li(?: data-checked="true")?>(?:[^<]|<\/?b>|<br>)*<\/li>)*<\/ul>$/);
      const opens = out.match(/<b>/g)?.length ?? 0, closes = out.match(/<\/b>/g)?.length ?? 0;
      expect(opens).toBe(closes);
      const text = out.replace(/<[^>]*>/g, " ");
      const count = (w: string) => text.split(new RegExp(`\\b${w}\\b`)).length - 1;
      for (const w of mineAdded.filter((word) => html(mine).includes(word))) expect(count(w)).toBe(1);
      for (const w of theirAdded) expect(count(w)).toBeLessThanOrEqual(1);
    }
  });
});
