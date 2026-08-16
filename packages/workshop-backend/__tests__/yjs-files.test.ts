import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextEdit, readDocFiles, writeDocFiles } from "../src/yjs-files";

function docWithFiles(rootName: string, files: Record<string, string>): Y.Doc {
  let doc = new Y.Doc();
  let root = doc.getMap<Y.Text>(rootName);
  doc.transact(() => {
    for (let [name, content] of Object.entries(files)) {
      root.set(name, new Y.Text(content));
    }
  });
  return doc;
}

describe("readDocFiles", () => {
  it("flattens a root map to plain text", () => {
    let doc = docWithFiles("7", { "client.js": "a", "lib/util.js": "b" });
    expect(readDocFiles(doc, "7")).toEqual(new Map([
      ["client.js", "a"],
      ["lib/util.js", "b"],
    ]));
    // Other roots (including the unnamed legacy root) read as empty.
    expect(readDocFiles(doc, "").size).toBe(0);
  });
});

describe("applyTextEdit", () => {
  function edit(before: string, after: string): void {
    let text = new Y.Doc().getText("t");
    text.insert(0, before);
    applyTextEdit(text, after);
    expect(text.toString()).toBe(after);
  }

  it("handles boundary and overlap cases", () => {
    edit("", "hello");
    edit("hello", "");
    edit("abc", "axc");
    edit("aaa", "aa");     // ambiguous prefix/suffix overlap
    edit("aa", "aaa");
    edit("abc", "abc");
    edit("x", "y");
    edit("prefix mid suffix", "prefix changed suffix");
  });

  it("never splits a surrogate pair", () => {
    // The naive common prefix/suffix scan would cut between these pairs' halves, leaving lone
    // surrogates in the Y.Text -- which Yjs's UTF-8 update encoding turns into U+FFFD, so a
    // remote replica would decode different content than the local doc holds. Verify through an
    // actual encode/decode round trip.
    for (let [before, after] of [
      ["a\u{1F600}b", "a\u{1F601}b"],   // shared high surrogate, differing low
      ["\u{1F600}", "\u{1F600}\u{1F600}"],
      ["\uD83D\uDE00", "\uD83E\uDE00"], // differing high surrogate, shared low
    ] as const) {
      let doc = docWithFiles("", { "f.txt": before });
      applyTextEdit(doc.getMap<Y.Text>("").get("f.txt")!, after);
      expect(doc.getMap<Y.Text>("").get("f.txt")!.toString()).toBe(after);

      let replica = new Y.Doc();
      Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(doc));
      expect(replica.getMap<Y.Text>("").get("f.txt")!.toString()).toBe(after);
    }
  });

  it("edits minimally, so disjoint concurrent edits merge to the expected text", () => {
    // Two replicas of one file. Replica A rewrites the middle line via applyTextEdit; replica B
    // appends a line concurrently. A minimal-span edit leaves B's insertion anchored where the
    // user put it; a delete-all/re-insert would not.
    let a = docWithFiles("", { "f.txt": "one\ntwo\nthree\n" });
    let b = new Y.Doc();
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    applyTextEdit(a.getMap<Y.Text>("").get("f.txt")!, "one\n2\nthree\n");
    b.getMap<Y.Text>("").get("f.txt")!.insert("one\ntwo\nthree\n".length, "four\n");

    Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b));
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    expect(a.getMap<Y.Text>("").get("f.txt")!.toString()).toBe("one\n2\nthree\nfour\n");
    expect(b.getMap<Y.Text>("").get("f.txt")!.toString()).toBe("one\n2\nthree\nfour\n");
  });

  it("preserves a concurrent edit between two separately changed regions", () => {
    // Replica A changes the first and last lines via applyTextEdit; replica B concurrently edits
    // inside the untouched middle. A single-hunk (whole-middle) replacement would delete the
    // text under B's edit and re-insert it, duplicating or orphaning B's change; a multi-hunk
    // diff leaves the middle alone so the edits compose cleanly.
    let a = docWithFiles("", { "f.txt": "A\nmiddle\nZ\n" });
    let b = new Y.Doc();
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    applyTextEdit(a.getMap<Y.Text>("").get("f.txt")!, "AAA\nmiddle\nZZZ\n");
    // B rewrites "middle" -> "muddle" (edit one character within the middle line).
    b.getMap<Y.Text>("").get("f.txt")!.delete("A\nm".length, 1);
    b.getMap<Y.Text>("").get("f.txt")!.insert("A\nm".length, "u");

    Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b));
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    expect(a.getMap<Y.Text>("").get("f.txt")!.toString()).toBe("AAA\nmuddle\nZZZ\n");
    expect(b.getMap<Y.Text>("").get("f.txt")!.toString()).toBe("AAA\nmuddle\nZZZ\n");
  });

  it("handles multi-hunk combinations of inserts, deletes, and rewrites", () => {
    let cases: [string, string][] = [
      // Two rewrites with retained context between.
      ["a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n"],
      // Insert in one place, delete in another.
      ["a\nb\nc\nd\n", "a\nx\nb\nc\n"],
      // Rewrites at the very ends with no shared prefix/suffix lines.
      ["a\nb\nc\n", "A\nb\nC\n"],
      // Whole-line insertions adjacent to changed lines.
      ["one\ntwo\nthree\n", "zero\none\n2\nthree\nfour\n"],
      // No trailing newline on either side.
      ["a\nb\nc", "a\nB\nc"],
      ["a\nb\nc", "a\nb\nc\nd"],
      // CRLF content.
      ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
      // Separators that are *not* line boundaries here (bare \r, U+2028, U+2029) must survive
      // both as edited content and as retained content around other edits: a lossy split (one
      // that treats them as boundaries but drops them) shifts every subsequent hunk's offsets,
      // corrupting text the edit never touched.
      ["a\rb", "a\rc"],
      ["a\rb\nc\nd\n", "a\rb\nc\nD\n"],
      ["a\u2028b\nmid\nz\n", "a\u2028b\nmid\nZ\n"],
      ["a\u2029b", "x\ny\u2029z"],
      ["one\rtwo\rthree", "one\rtwo\rthree\nfour"],
      // Everything replaced.
      ["a\nb\n", "x\ny\nz\n"],
      // Repeated identical lines (ambiguous alignment).
      ["a\na\na\n", "a\na\n"],
      ["a\nb\na\nb\n", "a\nb\nx\na\nb\n"],
    ];
    for (let [before, after] of cases) {
      edit(before, after);
    }
  });

  it("still produces the exact target when the region exceeds the diff-size fallback", () => {
    // Over MAX_DIFF_LINES the changed region is replaced as one whole hunk instead of being
    // diffed -- less minimal, but the result must still be exact. Give every line distinct
    // content so the prefix/suffix trim can't shrink the region below the bound.
    let before = Array.from({length: 21_000}, (_, i) => `a${i}\n`).join("");
    let after = Array.from({length: 21_000}, (_, i) => `b${i}\n`).join("");
    edit(before, after);
  });

  it("produces the exact target under randomized line edits", () => {
    // Deterministic PRNG so failures reproduce.
    let seed = 12345;
    let rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      let lineCount = rand(20);
      let lines = Array.from({length: lineCount}, () => `line${rand(10)}\n`);
      let before = lines.join("");
      // Random edits: delete, insert, or rewrite random lines.
      let edited = [...lines];
      for (let i = rand(6); i > 0; i--) {
        let pos = rand(edited.length + 1);
        switch (rand(3)) {
          case 0: edited.splice(pos, 0, `new${rand(10)}\n`); break;
          case 1: if (pos < edited.length) edited.splice(pos, 1); break;
          case 2: if (pos < edited.length) edited[pos] = `changed${rand(10)}\n`; break;
        }
      }
      edit(before, edited.join(""));
    }
  });
});

describe("writeDocFiles", () => {
  it("inserts, edits, and deletes to match the target map, in one update", () => {
    let doc = docWithFiles("3", { "keep.js": "same", "edit.js": "old text", "drop.js": "bye" });

    let updates = 0;
    doc.on("updateV2", () => ++updates);

    let target = new Map([
      ["keep.js", "same"],
      ["edit.js", "new text"],
      ["added.js", "fresh"],
    ]);
    writeDocFiles(doc, "3", target);

    expect(readDocFiles(doc, "3")).toEqual(target);
    expect(updates).toBe(1);
  });

  it("is a no-op update-wise when content already matches", () => {
    let doc = docWithFiles("3", { "a.js": "x" });
    let updates = 0;
    doc.on("updateV2", () => ++updates);
    writeDocFiles(doc, "3", new Map([["a.js", "x"]]));
    expect(updates).toBe(0);
  });
});
