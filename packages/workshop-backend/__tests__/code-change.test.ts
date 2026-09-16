import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "capnweb";
import {
  MAX_CODE_CHANGE_SIZE,
  MAX_FILE_PATH_LENGTH,
  MAX_FILE_TEXT_LENGTH,
  applyCodeChange,
  changedGadgets,
  composeCodeChange,
  diffFiles,
  replaceSpanChange,
  transformCodeChange,
  validateCodeChangeContent,
  validateCodeChangeSchema,
  type CodeContent,
  type CodeChange,
  type FileChange,
  type TextChange,
} from "@gadgets/workshop-shared/code-change";

// The module under test lives in workshop-shared (both sides of the wire share the change
// invariants), but like the yjs-seed tests before them these run here so they execute under
// workerd like the rest of the git-backed code flow.
//
// The fuzz harnesses deliberately build TextChanges by hand (rather than importing
// @codemirror/state, which is module-private to code-change.ts): sections tile the whole original
// text, a bare number retains, and [deletedLen, ...insertedLines] replaces.

// =======================================================================================
// Deterministic fuzz helpers

// mulberry32: tiny deterministic PRNG so failures reproduce.
function makeRng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randomInt(rng, items.length)];
}

// Deliberately astral- and separator-heavy: surrogate pairs (😀, 🧠), an emoji-with-modifier
// (two code points, four UTF-16 units), combining text, and every line-separator exotic the
// codebase promises to round-trip (bare \r, \u2028, \u2029, NUL).
const ALPHABET = [
  "a", "b", "x", " ", "é", "😀", "🧠", "👍🏽", "\n", "\n", "\r", "\r\n", "\u2028", "\u2029", "\0",
];

function randomText(rng: () => number, maxPieces: number): string {
  let out = "";
  for (let i = 0, n = randomInt(rng, maxPieces + 1); i < n; i++) out += pick(rng, ALPHABET);
  return out;
}

// All positions in `text` that don't split a surrogate pair.
function codePointBoundaries(text: string): number[] {
  let out = [0];
  for (let i = 1; i <= text.length; i++) {
    let prev = text.charCodeAt(i - 1);
    let cur = i < text.length ? text.charCodeAt(i) : 0;
    if (prev >= 0xd800 && prev < 0xdc00 && cur >= 0xdc00 && cur < 0xe000) continue;
    out.push(i);
  }
  return out;
}

// Builds the compact-JSON TextChange for a sorted list of non-overlapping replacements.
function makeEdit(
    baseLength: number, specs: { from: number, to: number, insert: string }[]): TextChange {
  let change: TextChange = [];
  let pos = 0;
  for (let { from, to, insert } of specs) {
    if (from > pos) change.push(from - pos);
    change.push(insert === "" ? [to - from] : [to - from, ...insert.split("\n")]);
    pos = to;
  }
  if (pos < baseLength) change.push(baseLength - pos);
  return change;
}

// A random valid edit against `base`: a few non-overlapping replacements on code-point
// boundaries, each possibly a pure insert, deletion, or replacement.
function randomEdit(rng: () => number, base: string): TextChange {
  let bounds = codePointBoundaries(base);
  let specs: { from: number, to: number, insert: string }[] = [];
  let i = 0;
  while (i < bounds.length) {
    if (rng() < 0.4) {
      let from = bounds[i];
      let j = Math.min(bounds.length - 1, i + randomInt(rng, 4));
      let to = bounds[j];
      let insert = rng() < 0.8 ? randomText(rng, 4) : "";
      if (from !== to || insert !== "") specs.push({ from, to, insert });
      i = j + 1;
    } else {
      i++;
    }
  }
  return makeEdit(base.length, specs);
}

function randomContent(rng: () => number): CodeContent {
  let out: CodeContent = new Map();
  for (let i = 0, n = 1 + randomInt(rng, 2); i < n; i++) {
    let files = new Map<string, string>();
    for (let j = 0, m = randomInt(rng, 4); j < m; j++) {
      files.set(`f${j}.txt`, randomText(rng, 12));
    }
    out.set(1 + i * 3, files);
  }
  return out;
}

// A random valid change against `content`: mixes edits, sets (of existing and new files), and
// removes (of existing and absent files) across the content's gadgets plus sometimes a brand
// new one.
function randomCodeChange(rng: () => number, base: CodeContent): CodeChange {
  let change: CodeChange = {};
  let addFile = (gadget: Map<string, FileChange>) => {
    if (rng() < 0.3) gadget.set(`new${randomInt(rng, 2)}.txt`, { set: randomText(rng, 8) });
    if (rng() < 0.1) gadget.set("ghost.txt", { remove: true });
  };
  for (let [gadgetId, files] of base) {
    let gadget = new Map<string, FileChange>();
    for (let [path, text] of files) {
      let r = rng();
      if (r < 0.35) continue;
      else if (r < 0.65) gadget.set(path, { edit: randomEdit(rng, text) });
      else if (r < 0.85) gadget.set(path, { set: randomText(rng, 8) });
      else gadget.set(path, { remove: true });
    }
    addFile(gadget);
    if (gadget.size > 0) change[gadgetId] = [...gadget];
  }
  if (rng() < 0.2) {
    let gadget = new Map<string, FileChange>([["n.txt", { set: randomText(rng, 6) }]]);
    addFile(gadget);
    change[50 + randomInt(rng, 2)] = [...gadget];
  }
  return change;
}

// Content as plain objects for deep comparison, normalizing away empty gadget entries (which
// applyCodeChange may or may not create depending on change shape).
function toPlain(value: CodeContent): Record<string, Record<string, string>> {
  let out: Record<string, Record<string, string>> = {};
  for (let [gadgetId, files] of value) {
    if (files.size === 0) continue;
    out[gadgetId] = Object.fromEntries(files);
  }
  return out;
}

function content(gadgets: Record<string, Record<string, string>>): CodeContent {
  return new Map(Object.entries(gadgets).map(
      ([id, files]) => [Number(id), new Map(Object.entries(files))]));
}

// =======================================================================================
// Fuzz: the OT laws

describe("transformCodeChange convergence", () => {
  it("converges for concurrent edit pairs, stepwise and composed", () => {
    let rng = makeRng(1);
    for (let i = 0; i < 1500; i++) {
      let base = randomText(rng, 20);
      let c = content({ 1: { "f.txt": base } });
      let a: CodeChange = { 1: [["f.txt", { edit: randomEdit(rng, base) }]] };
      let b: CodeChange = { 1: [["f.txt", { edit: randomEdit(rng, base) }]] };
      validateCodeChangeSchema(a);
      validateCodeChangeSchema(b);

      let t = transformCodeChange(a, b);
      // Both transformed halves must pass content validation at their new bases: transform
      // preserves code-point-boundary cleanliness.
      validateCodeChangeContent(t.b, applyCodeChange(c, a));
      validateCodeChangeContent(t.a, applyCodeChange(c, b));

      // Stepwise convergence...
      let viaA = applyCodeChange(applyCodeChange(c, a), t.b);
      let viaB = applyCodeChange(applyCodeChange(c, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      // ...and the composed form of the same law.
      expect(toPlain(applyCodeChange(c, composeCodeChange(a, t.b)))).toEqual(toPlain(viaA));
      expect(toPlain(applyCodeChange(c, composeCodeChange(b, t.a)))).toEqual(toPlain(viaA));
    }
  });

  it("converges for mixed concurrent changes (edit/set/remove across files and gadgets)", () => {
    let rng = makeRng(2);
    for (let i = 0; i < 1500; i++) {
      let c = randomContent(rng);
      let a = randomCodeChange(rng, c);
      let b = randomCodeChange(rng, c);
      validateCodeChangeSchema(a);
      validateCodeChangeSchema(b);

      let t = transformCodeChange(a, b);
      let viaA = applyCodeChange(applyCodeChange(c, a), t.b);
      let viaB = applyCodeChange(applyCodeChange(c, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      expect(toPlain(applyCodeChange(c, composeCodeChange(a, t.b)))).toEqual(toPlain(viaA));
      expect(toPlain(applyCodeChange(c, composeCodeChange(b, t.a)))).toEqual(toPlain(viaA));
    }
  });

  it("orders the earlier change's inserts first at equal positions", () => {
    let c = content({ 1: { "f.txt": "xy" } });
    let a: CodeChange = { 1: [["f.txt", { edit: [[0, "A"], 2] }]] };
    let b: CodeChange = { 1: [["f.txt", { edit: [[0, "B"], 2] }]] };
    let t = transformCodeChange(a, b);
    expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b)))
        .toEqual({ 1: { "f.txt": "ABxy" } });
    expect(toPlain(applyCodeChange(applyCodeChange(c, b), t.a)))
        .toEqual({ 1: { "f.txt": "ABxy" } });
  });

  it("leaves disjoint gadgets and paths untouched", () => {
    let a: CodeChange = { 1: [["f.txt", { set: "A" }]] };
    let b: CodeChange = { 2: [["g.txt", { remove: true }]] };
    expect(transformCodeChange(a, b)).toEqual({ a, b });
  });
});

describe("transformCodeChange set/remove last-writer-wins", () => {
  const BASE = content({ 1: { "f.txt": "hello" } });

  // Each case: [a, b, expected t.a, expected t.b, expected converged file state].
  const CASES: [FileChange, FileChange, FileChange | undefined, FileChange | undefined,
                string | undefined][] = [
    [{ set: "A" }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ set: "A" }, { remove: true }, undefined, { remove: true }, undefined],
    [{ remove: true }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ remove: true }, { remove: true }, undefined, { remove: true }, undefined],
    [{ set: "A" }, { edit: [[5, "!"]] }, { set: "A" }, undefined, "A"],
    [{ remove: true }, { edit: [[5, "!"]] }, { remove: true }, undefined, undefined],
    [{ edit: [[5, "!"]] }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ edit: [[5, "!"]] }, { remove: true }, undefined, { remove: true }, undefined],
  ];

  for (let [aChange, bChange, expectA, expectB, merged] of CASES) {
    it(`${Object.keys(aChange)[0]} vs ${Object.keys(bChange)[0]}`, () => {
      let a: CodeChange = { 1: [["f.txt", aChange]] };
      let b: CodeChange = { 1: [["f.txt", bChange]] };
      let t = transformCodeChange(a, b);
      expect(t.a).toEqual(expectA === undefined ? {} : { 1: [["f.txt", expectA]] });
      expect(t.b).toEqual(expectB === undefined ? {} : { 1: [["f.txt", expectB]] });

      let viaA = applyCodeChange(applyCodeChange(BASE, a), t.b);
      let viaB = applyCodeChange(applyCodeChange(BASE, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      expect(viaA.get(1)!.get("f.txt")).toBe(merged);
    });
  }
});

// =======================================================================================
// Fuzz: compose vs apply

describe("composeCodeChange", () => {
  it("matches sequential application", () => {
    let rng = makeRng(3);
    for (let i = 0; i < 1000; i++) {
      let c = randomContent(rng);
      let a = randomCodeChange(rng, c);
      let c2 = applyCodeChange(c, a);
      let b = randomCodeChange(rng, c2);
      expect(toPlain(applyCodeChange(c, composeCodeChange(a, b))))
          .toEqual(toPlain(applyCodeChange(c2, b)));
    }
  });

  it("composes a set followed by an edit into a set", () => {
    let a: CodeChange = { 1: [["f.txt", { set: "hello" }]] };
    let b: CodeChange = { 1: [["f.txt", { edit: [5, [0, " world"]] }]] };
    expect(composeCodeChange(a, b)).toEqual({ 1: [["f.txt", { set: "hello world" }]] });
  });

  it("rejects an edit composed after a remove", () => {
    let a: CodeChange = { 1: [["f.txt", { remove: true }]] };
    let b: CodeChange = { 1: [["f.txt", { edit: [[1, "x"]] }]] };
    expect(() => composeCodeChange(a, b)).toThrow(/compose edit after remove/);
  });
});

// =======================================================================================
// Fuzz: diffFiles

describe("diffFiles", () => {
  it("produces valid, boundary-clean changes whose application reproduces the target", () => {
    let rng = makeRng(4);
    for (let i = 0; i < 1200; i++) {
      let before = randomContent(rng);
      // Derive `after` by mutating: changed, removed, added, and untouched files.
      let after: CodeContent = new Map();
      for (let [gadgetId, files] of before) {
        let newFiles = new Map<string, string>();
        for (let [path, text] of files) {
          let r = rng();
          if (r < 0.25) continue;  // removed
          else if (r < 0.5) newFiles.set(path, text);  // untouched
          else newFiles.set(path, randomText(rng, 12));  // replaced
        }
        if (rng() < 0.4) newFiles.set("added.txt", randomText(rng, 8));
        after.set(gadgetId, newFiles);
      }

      let change = diffFiles(before, after);
      validateCodeChangeSchema(change);
      // Content validation proves every edit boundary lands on a code-point boundary and no
      // insert carries a lone surrogate, even over astral-heavy content.
      validateCodeChangeContent(change, before);
      expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));
    }
  });

  it("is deterministic with sorted keys", () => {
    let before = content({ 5: { "b.txt": "x", "a.txt": "y" }, 2: { "c.txt": "z" } });
    let after = content({ 5: { "b.txt": "x2", "a.txt": "y2" }, 2: { "c.txt": "z2" } });
    let change = diffFiles(before, after);
    expect(JSON.stringify(change)).toBe(JSON.stringify(diffFiles(before, after)));
    expect(Object.keys(change)).toEqual(["2", "5"]);
    expect(change["5"].map(([path]) => path)).toEqual(["a.txt", "b.txt"]);
  });

  it("emits set/remove/edit per file state transition and {} for identical content", () => {
    let before = content({ 1: { "keep.txt": "same", "gone.txt": "bye", "mod.txt": "aXc" } });
    let after = content({ 1: { "keep.txt": "same", "new.txt": "hi", "mod.txt": "aYc" } });
    let entries = new Map(diffFiles(before, after)["1"]);
    expect(entries.get("gone.txt")).toEqual({ remove: true });
    expect(entries.get("new.txt")).toEqual({ set: "hi" });
    expect("edit" in entries.get("mod.txt")!).toBe(true);
    expect(entries.get("keep.txt")).toBeUndefined();

    expect(diffFiles(before, before)).toEqual({});
  });

  it("never splits surrogate pairs in astral-adjacent replacements", () => {
    let before = content({ 1: { "f.txt": "😀😀😀" } });
    let after = content({ 1: { "f.txt": "😀🧠😀" } });
    let change = diffFiles(before, after);
    validateCodeChangeContent(change, before);
    expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));
  });
});

describe("replaceSpanChange", () => {
  // Validates the change against a one-file document, applies it, and asserts the result equals the
  // plain string splice the span replacement describes.
  function applySpan(doc: string, from: number, replaced: string, insert: string): TextChange {
    expect(doc.slice(from, from + replaced.length)).toBe(replaced);  // test self-check
    let edit = replaceSpanChange(doc.length, from, replaced, insert);
    let change: CodeChange = { 1: [["f.txt", { edit }]] };
    let before = content({ 1: { "f.txt": doc } });
    validateCodeChangeSchema(change);
    validateCodeChangeContent(change, before);
    expect(applyCodeChange(before, change).get(1)!.get("f.txt"))
        .toBe(doc.slice(0, from) + insert + doc.slice(from + replaced.length));
    return edit;
  }

  it("trims unchanged disambiguation context down to the changed text", () => {
    // The model padded the match with "return " and ";" to disambiguate; only "1" changed.
    let doc = "function foo() { return 1; }";
    let edit = applySpan(doc, doc.indexOf("return 1;"), "return 1;", "return 2;");
    expect(edit).toEqual(makeEdit(doc.length, [{ from: 24, to: 25, insert: "2" }]));
  });

  it("emits pure insertions and deletions from padded matches", () => {
    let insertion = applySpan("ab-ab", 3, "ab", "aXb");
    expect(insertion).toEqual(makeEdit(5, [{ from: 4, to: 4, insert: "X" }]));

    let deletion = applySpan("aXbab", 0, "aXb", "ab");
    expect(deletion).toEqual(makeEdit(5, [{ from: 1, to: 2, insert: "" }]));
  });

  it("handles span edges and whole-document replacement", () => {
    applySpan("abc", 0, "abc", "xyz");            // whole document
    expect(applySpan("abc", 0, "a", "A")).toEqual(makeEdit(3, [{ from: 0, to: 1, insert: "A" }]));
    expect(applySpan("abc", 2, "c", "C")).toEqual(makeEdit(3, [{ from: 2, to: 3, insert: "C" }]));
    applySpan("", 0, "", "hello");                // insertion into an empty document
  });

  it("yields the identity change when nothing changed", () => {
    expect(replaceSpanChange(10, 3, "same", "same")).toEqual([10]);
    expect(replaceSpanChange(4, 4, "", "")).toEqual([4]);
  });

  it("preserves multi-line inserts with exotic separators", () => {
    let insert = "x\r\ny\rz\u2028w\nv";
    applySpan("start[MID]end", 5, "[MID]", insert);
  });

  it("never lets trimming split a surrogate pair", () => {
    // Prefix back-off: 😀 (D83D DE00) and 😂 (D83D DE02) share their high surrogate.
    expect(applySpan("😀x", 0, "😀x", "😂x"))
        .toEqual(makeEdit(3, [{ from: 0, to: 2, insert: "😂" }]));
    // Suffix back-off: 𐐀 (D801 DC00) and 𝐀 (D835 DC00) share their low surrogate.
    expect(applySpan("a𐐀", 1, "𐐀", "𝐀"))
        .toEqual(makeEdit(3, [{ from: 1, to: 3, insert: "𝐀" }]));
  });

  it("fuzz: padded random spans validate and apply over astral-heavy text", () => {
    let rng = makeRng(11);
    for (let i = 0; i < 1500; i++) {
      let prefix = randomText(rng, 6);
      let core = randomText(rng, 6);
      let suffix = randomText(rng, 6);
      let doc = prefix + core + suffix;
      // Replace `core` (padding included in the match or not) with random text sharing random
      // context, exercising the trim against every ALPHABET exotic.
      let pad = rng() < 0.5;
      let from = pad ? 0 : prefix.length;
      let replaced = pad ? doc : core;
      let insert = (pad ? prefix : "") + randomText(rng, 6) + (pad ? suffix : "");
      applySpan(doc, from, replaced, insert);
    }
  });

  it("rejects out-of-range spans at construction", () => {
    expect(() => replaceSpanChange(3, 2, "cd", "x")).toThrow();
    expect(() => replaceSpanChange(3, 4, "", "x")).toThrow();
  });
});

// =======================================================================================
// Line-separator round-trips

describe("line separator handling", () => {
  const EXOTIC = "a\r\nb\rc\u2028d\u2029e\0f\nno trailing newline";

  it("round-trips exotic separators through set, edit, and diff", () => {
    let c = content({ 1: { "f.txt": "placeholder" } });
    let viaSet = applyCodeChange(c, { 1: [["f.txt", { set: EXOTIC }]] });
    expect(viaSet.get(1)!.get("f.txt")).toBe(EXOTIC);

    // An edit that retains everything reproduces the text exactly (the apply path round-trips
    // the content through the OT core's internal document representation).
    let identity = applyCodeChange(viaSet, { 1: [["f.txt", { edit: [EXOTIC.length] }]] });
    expect(identity.get(1)!.get("f.txt")).toBe(EXOTIC);

    // A diffed edit between exotic variants applies losslessly, including an insert that
    // itself contains a bare "\r".
    let target = `x\r${EXOTIC}\u2028y`;
    let change = diffFiles(viaSet, content({ 1: { "f.txt": target } }));
    expect("edit" in change["1"][0][1]).toBe(true);
    expect(applyCodeChange(viaSet, change).get(1)!.get("f.txt")).toBe(target);
  });
});

// =======================================================================================
// Application semantics

describe("applyCodeChange", () => {
  it("does not modify its input", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    applyCodeChange(c, { 1: [["f.txt", { set: "changed" }], ["g.txt", { set: "new" }]] });
    expect(toPlain(c)).toEqual({ 1: { "f.txt": "hello" } });
  });

  it("throws on an edit of an absent file or a wrong-length base", () => {
    let c = content({ 1: { "f.txt": "ab" } });
    expect(() => applyCodeChange(c, { 1: [["g.txt", { edit: [2] }]] })).toThrow(/absent file/);
    expect(() => applyCodeChange(c, { 1: [["f.txt", { edit: [5] }]] })).toThrow(/wrong length/);
  });

  it("treats remove of an absent file as a no-op", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    let result = applyCodeChange(
        c, { 1: [["g.txt", { remove: true }]], 9: [["x", { remove: true }]] });
    expect(toPlain(result)).toEqual({ 1: { "f.txt": "hello" } });
  });
});

describe("changedGadgets", () => {
  it("returns touched gadget ids ascending", () => {
    expect(changedGadgets({ 10: [["a", { remove: true }]], 2: [["b", { set: "x" }]] }))
        .toEqual([2, 10]);
    expect(changedGadgets({})).toEqual([]);
  });
});

// =======================================================================================
// Validation matrix

describe("validateCodeChangeSchema", () => {
  it("accepts the identity change and well-formed changes", () => {
    validateCodeChangeSchema({});
    validateCodeChangeSchema({
      0: [["a.txt", { set: "" }]],
      12: [["b/c.txt", { edit: [1, [2, "x", ""], 3] }], ["d.txt", { remove: true }]],
    });
  });

  // Wire-shape rejection -- a non-object change, a gadget entry that isn't an array of [string,
  // FileChange] pairs, a FileChange variant of the wrong type -- is capnweb-validate's job,
  // established before a change reaches this module (see the trust boundary note in
  // code-change.ts). These cases cover only what a well-typed CodeChange can still get wrong.
  it("rejects malformed outer shapes", () => {
    expect(() => validateCodeChangeSchema({ "01": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeChangeSchema({ "-1": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeChangeSchema({ "1.5": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeChangeSchema({ "abc": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeChangeSchema({ 1: [] })).toThrow(/is empty/);
    expect(() => validateCodeChangeSchema({ 1: [["", { remove: true }]] }))
        .toThrow(/path is empty/);
    expect(() => validateCodeChangeSchema(
        { 1: [["f", { remove: true }], ["f", { set: "x" }]] })).toThrow(/duplicate/);
  });

  // The wire validator's FileChange union is first-match and tolerates extra properties, so a
  // multi-variant file change is ours to reject (applyCodeChange and transformCodeChange would
  // read it differently and diverge two replicas).
  it("rejects file changes that are not exactly one variant", () => {
    let bad = (fileChange: unknown) =>
        expect(() => validateCodeChangeSchema({ 1: [["f", fileChange as FileChange]] }));
    bad({}).toThrow(/exactly one/);
    bad({ set: "x", remove: true }).toThrow(/exactly one/);
    bad({ frobnicate: 1 }).toThrow(/exactly one/);
  });

  // Likewise: a section length is a `number` to the wire validator, which says nothing about
  // integrality or sign.
  it("rejects malformed text changes", () => {
    let bad = (edit: TextChange) =>
        expect(() => validateCodeChangeSchema({ 1: [["f", { edit }]] }));
    bad([-1]).toThrow(/invalid section length/);
    bad([1.5]).toThrow(/invalid section length/);
    bad([[-2, "x"]]).toThrow(/invalid section length/);
  });

  it("rejects do-nothing sections and embedded newlines in inserted lines", () => {
    let bad = (edit: unknown) =>
        expect(() => validateCodeChangeSchema({ 1: [["f", { edit: edit as TextChange }]] }));
    // Zero-progress padding would evade the size caps.
    bad([0]).toThrow(/do-nothing/);
    bad([1, 0, 1]).toThrow(/do-nothing/);
    bad([[0]]).toThrow(/do-nothing/);
    bad([[0, ""]]).toThrow(/do-nothing/);
    // An inserted "line" containing "\n" desynchronizes line metadata from the text.
    bad([[0, "a\nb"], 3]).toThrow(/contains a newline/);
    // The legitimate forms of the same content still pass.
    validateCodeChangeSchema({ 1: [["f", { edit: [[0, "a", "b"], 3] }]] });  // multi-line insert
    validateCodeChangeSchema({ 1: [["f", { edit: [[0, "", ""], 3] }]] });  // pure "\n" insert
  });

  it("enforces the per-file, per-path, and per-change size caps", () => {
    let big = "x".repeat(MAX_FILE_TEXT_LENGTH + 1);
    expect(() => validateCodeChangeSchema({ 1: [["f", { set: big }]] })).toThrow(/too large/);
    expect(() => validateCodeChangeSchema({ 1: [["f", { edit: [[0, big]] }]] }))
        .toThrow(/too large/);
    // Growing an existing file past the cap trips on newLength even with a small insertion.
    expect(() => validateCodeChangeSchema(
        { 1: [["f", { edit: [MAX_FILE_TEXT_LENGTH, [0, "!"]] }]] })).toThrow(/too large/);

    expect(() => validateCodeChangeSchema(
        { 1: [["p".repeat(MAX_FILE_PATH_LENGTH + 1), { remove: true }]] }))
        .toThrow(/path is too long/);

    let chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
    let files: [string, FileChange][] = [];
    let count = Math.ceil(MAX_CODE_CHANGE_SIZE / MAX_FILE_TEXT_LENGTH) + 1;
    for (let i = 0; i < count; i++) files.push([`f${i}`, { set: chunk }]);
    expect(() => validateCodeChangeSchema({ 1: files })).toThrow(/change is too large/);
  });

  it("caps changes made of many payload-free entries", () => {
    // Removes insert nothing, but each entry still counts toward the change size.
    let path = "p".repeat(1000);
    let removes: [string, FileChange][] = [];
    for (let i = 0; i * 1000 <= MAX_CODE_CHANGE_SIZE; i++) {
      removes.push([`${path}${i}`, { remove: true }]);
    }
    expect(() => validateCodeChangeSchema({ 1: removes })).toThrow(/change is too large/);

    // Likewise an edit's sections: maximal fragmentation (one section per retained unit)
    // counts toward the change size even though it inserts nothing.
    let sections: TextChange = Array.from({ length: MAX_FILE_TEXT_LENGTH }, () => 1);
    let edits: [string, FileChange][] = [];
    for (let i = 0; i < 5; i++) edits.push([`e${i}`, { edit: sections }]);
    expect(() => validateCodeChangeSchema({ 1: edits })).toThrow(/change is too large/);
  });

  it("rejects oversized edits before walking or re-parsing them", () => {
    // A hostile section count is rejected by the O(1) pre-check: had the sections been walked,
    // these holes would report "invalid section length" instead (and had it reached
    // ChangeSet.fromJSON, a second multi-million-element representation would be allocated).
    let holes: TextChange = [];
    holes.length = 100_000_000;
    expect(() => validateCodeChangeSchema({ 1: [["f", { edit: holes }]] }))
        .toThrow(/code change is too large/);

    // Inserted text is budget-checked as it accrues: this edit's total insertion exceeds the
    // *change* budget mid-walk, which fires before the per-file newLength check ("file is too
    // large") that runs after fromJSON.
    let chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
    let inserts: TextChange = Array.from({ length: 5 }, () => [0, chunk] as [number, string]);
    expect(() => validateCodeChangeSchema({ 1: [["f", { edit: inserts }]] }))
        .toThrow(/code change is too large/);

    // A single section padded with empty lines is rejected on its separator count alone,
    // before its lines are walked: the poisoned last line would otherwise report "contains a
    // newline".
    let padded: TextChange = [[0, ...Array.from({ length: 2_100_000 }, () => ""), "a\nb"]];
    expect(() => validateCodeChangeSchema({ 1: [["f", { edit: padded }]] }))
        .toThrow(/code change is too large/);
  });
});

// =======================================================================================
// Exotic file names
//
// Git content can legitimately contain files named after Object.prototype members. Paths are
// entry-list *values*, never object keys, precisely so these survive both object construction
// (a computed "__proto__" assignment sets the prototype instead of creating a key) and RPC
// transit (Cap'n Web deletes prototype-shadowing keys, and "toJSON", from every object it
// deserializes -- a path-keyed map would silently lose these files on the wire).

describe("file names colliding with Object.prototype members", () => {
  const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "toJSON"];

  it("round-trips them through diffFiles, apply, JSON, and Cap'n Web", () => {
    let before = content({ 1: {} });
    let after: CodeContent = new Map([[1, new Map(NAMES.map((name, i) => [name, `v${i}`]))]]);

    let change = diffFiles(before, after);
    validateCodeChangeSchema(change);
    expect(change["1"].map(([path]) => path)).toEqual([...NAMES].toSorted());
    expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));

    // The change survives JSON serialization (as stored rows do)...
    let reparsed = JSON.parse(JSON.stringify(change)) as CodeChange;
    expect(toPlain(applyCodeChange(before, reparsed))).toEqual(toPlain(after));

    // ...and Cap'n Web serialization (as broadcast rows and submitted changes do), which is the
    // round-trip a path-keyed representation could not make.
    let overRpc = deserialize(serialize(change)) as CodeChange;
    expect(overRpc).toEqual(change);
    expect(toPlain(applyCodeChange(before, overRpc))).toEqual(toPlain(after));
  });

  it("keeps them intact through transform and compose", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    let a: CodeChange = { 1: [["constructor", { set: "x" }], ["__proto__", { set: "y" }]] };
    let b: CodeChange = { 1: [["f.txt", { set: "z" }]] };

    // The expected content is built with JSON.parse: a literal "__proto__" property in source
    // would set the prototype rather than the key. (toPlain's Object.fromEntries creates real
    // keys for such names.)
    let expected = JSON.parse('{"1": {"f.txt": "z", "constructor": "x", "__proto__": "y"}}');

    let t = transformCodeChange(a, b);
    expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b)))
        .toEqual(toPlain(applyCodeChange(applyCodeChange(c, b), t.a)));
    expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b))).toEqual(expected);

    let composed = composeCodeChange(a, b);
    expect(toPlain(applyCodeChange(c, composed))).toEqual(expected);
  });
});

describe("validateCodeChangeContent", () => {
  const CONTENT = content({ 1: { "f.txt": "😀x" } });

  it("accepts boundary-clean edits, sets, and removes of anything", () => {
    validateCodeChangeContent({ 1: [["f.txt", { edit: [[2], 1] }]] }, CONTENT);  // delete the 😀
    validateCodeChangeContent({ 1: [["f.txt", { edit: [3] }]] }, CONTENT);  // identity retain
    validateCodeChangeContent({ 1: [["f.txt", { edit: [[0, "🧠"], 3] }]] }, CONTENT);
    validateCodeChangeContent({ 1: [["absent.txt", { set: "hi" }]] }, CONTENT);
    validateCodeChangeContent({ 9: [["nowhere.txt", { remove: true }]] }, CONTENT);
  });

  it("rejects edits of absent files and wrong-length bases", () => {
    expect(() => validateCodeChangeContent({ 1: [["g.txt", { edit: [3] }]] }, CONTENT))
        .toThrow(/absent file/);
    expect(() => validateCodeChangeContent({ 2: [["f.txt", { edit: [3] }]] }, CONTENT))
        .toThrow(/absent file/);
    expect(() => validateCodeChangeContent({ 1: [["f.txt", { edit: [7] }]] }, CONTENT))
        .toThrow(/length mismatch/);
  });

  it("rejects boundaries that split a surrogate pair", () => {
    // Delete just the high half of the 😀.
    expect(() => validateCodeChangeContent({ 1: [["f.txt", { edit: [[1], 2] }]] }, CONTENT))
        .toThrow(/splits a surrogate pair/);
    // Replace starting mid-pair.
    expect(() => validateCodeChangeContent({ 1: [["f.txt", { edit: [1, [1, "y"], 1] }]] }, CONTENT))
        .toThrow(/splits a surrogate pair/);
  });

  it("rejects lone surrogates in inserted and set text", () => {
    expect(() => validateCodeChangeContent(
        { 1: [["f.txt", { edit: [[0, "\ud83d"], 3] }]] }, CONTENT))
        .toThrow(/lone surrogate/);
    expect(() => validateCodeChangeContent(
        { 1: [["g.txt", { set: "ok\udc00" }]] }, CONTENT))
        .toThrow(/lone surrogate/);
    // A well-formed pair in an insert passes.
    validateCodeChangeContent({ 1: [["f.txt", { edit: [[0, "😀"], 3] }]] }, CONTENT);
  });
});
