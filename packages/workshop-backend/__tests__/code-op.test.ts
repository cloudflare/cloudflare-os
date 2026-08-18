import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "capnweb";
import {
  MAX_CODE_OP_SIZE,
  MAX_FILE_PATH_LENGTH,
  MAX_FILE_TEXT_LENGTH,
  applyCodeOp,
  changedGadgets,
  composeCodeOp,
  diffFiles,
  transformCodeOp,
  validateCodeOpContent,
  validateCodeOpSchema,
  type CodeContent,
  type CodeOp,
  type FileOp,
  type TextOp,
} from "@gadgets/workshop-shared/code-op";

// The module under test lives in workshop-shared (both sides of the wire share the op
// invariants), but like the yjs-seed tests before them these run here so they execute under
// workerd like the rest of the git-backed code flow.
//
// The fuzz harnesses deliberately build TextOps by hand (rather than importing
// @codemirror/state, which is module-private to code-op.ts): sections tile the whole original
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

// Builds the compact-JSON TextOp for a sorted list of non-overlapping replacements.
function makeEdit(
    baseLength: number, specs: { from: number, to: number, insert: string }[]): TextOp {
  let op: TextOp = [];
  let pos = 0;
  for (let { from, to, insert } of specs) {
    if (from > pos) op.push(from - pos);
    op.push(insert === "" ? [to - from] : [to - from, ...insert.split("\n")]);
    pos = to;
  }
  if (pos < baseLength) op.push(baseLength - pos);
  return op;
}

// A random valid edit against `base`: a few non-overlapping replacements on code-point
// boundaries, each possibly a pure insert, deletion, or replacement.
function randomEdit(rng: () => number, base: string): TextOp {
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

// A random valid op against `content`: mixes edits, sets (of existing and new files), and
// removes (of existing and absent files) across the content's gadgets plus sometimes a brand
// new one.
function randomCodeOp(rng: () => number, base: CodeContent): CodeOp {
  let op: CodeOp = {};
  let addFile = (gadget: Map<string, FileOp>) => {
    if (rng() < 0.3) gadget.set(`new${randomInt(rng, 2)}.txt`, { set: randomText(rng, 8) });
    if (rng() < 0.1) gadget.set("ghost.txt", { remove: true });
  };
  for (let [gadgetId, files] of base) {
    let gadget = new Map<string, FileOp>();
    for (let [path, text] of files) {
      let r = rng();
      if (r < 0.35) continue;
      else if (r < 0.65) gadget.set(path, { edit: randomEdit(rng, text) });
      else if (r < 0.85) gadget.set(path, { set: randomText(rng, 8) });
      else gadget.set(path, { remove: true });
    }
    addFile(gadget);
    if (gadget.size > 0) op[gadgetId] = [...gadget];
  }
  if (rng() < 0.2) {
    let gadget = new Map<string, FileOp>([["n.txt", { set: randomText(rng, 6) }]]);
    addFile(gadget);
    op[50 + randomInt(rng, 2)] = [...gadget];
  }
  return op;
}

// Content as plain objects for deep comparison, normalizing away empty gadget entries (which
// applyCodeOp may or may not create depending on op shape).
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

describe("transformCodeOp convergence", () => {
  it("converges for concurrent edit pairs, stepwise and composed", () => {
    let rng = makeRng(1);
    for (let i = 0; i < 1500; i++) {
      let base = randomText(rng, 20);
      let c = content({ 1: { "f.txt": base } });
      let a: CodeOp = { 1: [["f.txt", { edit: randomEdit(rng, base) }]] };
      let b: CodeOp = { 1: [["f.txt", { edit: randomEdit(rng, base) }]] };
      validateCodeOpSchema(a);
      validateCodeOpSchema(b);

      let t = transformCodeOp(a, b);
      // Both transformed halves must pass content validation at their new bases: transform
      // preserves code-point-boundary cleanliness.
      validateCodeOpContent(t.b, applyCodeOp(c, a));
      validateCodeOpContent(t.a, applyCodeOp(c, b));

      // Stepwise convergence...
      let viaA = applyCodeOp(applyCodeOp(c, a), t.b);
      let viaB = applyCodeOp(applyCodeOp(c, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      // ...and the composed form of the same law.
      expect(toPlain(applyCodeOp(c, composeCodeOp(a, t.b)))).toEqual(toPlain(viaA));
      expect(toPlain(applyCodeOp(c, composeCodeOp(b, t.a)))).toEqual(toPlain(viaA));
    }
  });

  it("converges for mixed concurrent ops (edit/set/remove across files and gadgets)", () => {
    let rng = makeRng(2);
    for (let i = 0; i < 1500; i++) {
      let c = randomContent(rng);
      let a = randomCodeOp(rng, c);
      let b = randomCodeOp(rng, c);
      validateCodeOpSchema(a);
      validateCodeOpSchema(b);

      let t = transformCodeOp(a, b);
      let viaA = applyCodeOp(applyCodeOp(c, a), t.b);
      let viaB = applyCodeOp(applyCodeOp(c, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      expect(toPlain(applyCodeOp(c, composeCodeOp(a, t.b)))).toEqual(toPlain(viaA));
      expect(toPlain(applyCodeOp(c, composeCodeOp(b, t.a)))).toEqual(toPlain(viaA));
    }
  });

  it("orders the earlier op's inserts first at equal positions", () => {
    let c = content({ 1: { "f.txt": "xy" } });
    let a: CodeOp = { 1: [["f.txt", { edit: [[0, "A"], 2] }]] };
    let b: CodeOp = { 1: [["f.txt", { edit: [[0, "B"], 2] }]] };
    let t = transformCodeOp(a, b);
    expect(toPlain(applyCodeOp(applyCodeOp(c, a), t.b))).toEqual({ 1: { "f.txt": "ABxy" } });
    expect(toPlain(applyCodeOp(applyCodeOp(c, b), t.a))).toEqual({ 1: { "f.txt": "ABxy" } });
  });

  it("leaves disjoint gadgets and paths untouched", () => {
    let a: CodeOp = { 1: [["f.txt", { set: "A" }]] };
    let b: CodeOp = { 2: [["g.txt", { remove: true }]] };
    expect(transformCodeOp(a, b)).toEqual({ a, b });
  });
});

describe("transformCodeOp set/remove last-writer-wins", () => {
  const BASE = content({ 1: { "f.txt": "hello" } });

  // Each case: [a, b, expected t.a, expected t.b, expected converged file state].
  const CASES: [FileOp, FileOp, FileOp | undefined, FileOp | undefined, string | undefined][] = [
    [{ set: "A" }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ set: "A" }, { remove: true }, undefined, { remove: true }, undefined],
    [{ remove: true }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ remove: true }, { remove: true }, undefined, { remove: true }, undefined],
    [{ set: "A" }, { edit: [[5, "!"]] }, { set: "A" }, undefined, "A"],
    [{ remove: true }, { edit: [[5, "!"]] }, { remove: true }, undefined, undefined],
    [{ edit: [[5, "!"]] }, { set: "B" }, undefined, { set: "B" }, "B"],
    [{ edit: [[5, "!"]] }, { remove: true }, undefined, { remove: true }, undefined],
  ];

  for (let [aOp, bOp, expectA, expectB, merged] of CASES) {
    it(`${Object.keys(aOp)[0]} vs ${Object.keys(bOp)[0]}`, () => {
      let a: CodeOp = { 1: [["f.txt", aOp]] };
      let b: CodeOp = { 1: [["f.txt", bOp]] };
      let t = transformCodeOp(a, b);
      expect(t.a).toEqual(expectA === undefined ? {} : { 1: [["f.txt", expectA]] });
      expect(t.b).toEqual(expectB === undefined ? {} : { 1: [["f.txt", expectB]] });

      let viaA = applyCodeOp(applyCodeOp(BASE, a), t.b);
      let viaB = applyCodeOp(applyCodeOp(BASE, b), t.a);
      expect(toPlain(viaA)).toEqual(toPlain(viaB));
      expect(viaA.get(1)!.get("f.txt")).toBe(merged);
    });
  }
});

// =======================================================================================
// Fuzz: compose vs apply

describe("composeCodeOp", () => {
  it("matches sequential application", () => {
    let rng = makeRng(3);
    for (let i = 0; i < 1000; i++) {
      let c = randomContent(rng);
      let a = randomCodeOp(rng, c);
      let c2 = applyCodeOp(c, a);
      let b = randomCodeOp(rng, c2);
      expect(toPlain(applyCodeOp(c, composeCodeOp(a, b)))).toEqual(toPlain(applyCodeOp(c2, b)));
    }
  });

  it("composes a set followed by an edit into a set", () => {
    let a: CodeOp = { 1: [["f.txt", { set: "hello" }]] };
    let b: CodeOp = { 1: [["f.txt", { edit: [5, [0, " world"]] }]] };
    expect(composeCodeOp(a, b)).toEqual({ 1: [["f.txt", { set: "hello world" }]] });
  });

  it("rejects an edit composed after a remove", () => {
    let a: CodeOp = { 1: [["f.txt", { remove: true }]] };
    let b: CodeOp = { 1: [["f.txt", { edit: [[1, "x"]] }]] };
    expect(() => composeCodeOp(a, b)).toThrow(/compose edit after remove/);
  });
});

// =======================================================================================
// Fuzz: diffFiles

describe("diffFiles", () => {
  it("produces valid, boundary-clean ops whose application reproduces the target", () => {
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

      let op = diffFiles(before, after);
      validateCodeOpSchema(op);
      // Content validation proves every edit boundary lands on a code-point boundary and no
      // insert carries a lone surrogate, even over astral-heavy content.
      validateCodeOpContent(op, before);
      expect(toPlain(applyCodeOp(before, op))).toEqual(toPlain(after));
    }
  });

  it("is deterministic with sorted keys", () => {
    let before = content({ 5: { "b.txt": "x", "a.txt": "y" }, 2: { "c.txt": "z" } });
    let after = content({ 5: { "b.txt": "x2", "a.txt": "y2" }, 2: { "c.txt": "z2" } });
    let op = diffFiles(before, after);
    expect(JSON.stringify(op)).toBe(JSON.stringify(diffFiles(before, after)));
    expect(Object.keys(op)).toEqual(["2", "5"]);
    expect(op["5"].map(([path]) => path)).toEqual(["a.txt", "b.txt"]);
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
    let op = diffFiles(before, after);
    validateCodeOpContent(op, before);
    expect(toPlain(applyCodeOp(before, op))).toEqual(toPlain(after));
  });
});

// =======================================================================================
// Line-separator round-trips

describe("line separator handling", () => {
  const EXOTIC = "a\r\nb\rc\u2028d\u2029e\0f\nno trailing newline";

  it("round-trips exotic separators through set, edit, and diff", () => {
    let c = content({ 1: { "f.txt": "placeholder" } });
    let viaSet = applyCodeOp(c, { 1: [["f.txt", { set: EXOTIC }]] });
    expect(viaSet.get(1)!.get("f.txt")).toBe(EXOTIC);

    // An edit that retains everything reproduces the text exactly (the apply path round-trips
    // the content through the OT core's internal document representation).
    let identity = applyCodeOp(viaSet, { 1: [["f.txt", { edit: [EXOTIC.length] }]] });
    expect(identity.get(1)!.get("f.txt")).toBe(EXOTIC);

    // A diffed edit between exotic variants applies losslessly, including an insert that
    // itself contains a bare "\r".
    let target = `x\r${EXOTIC}\u2028y`;
    let op = diffFiles(viaSet, content({ 1: { "f.txt": target } }));
    expect("edit" in op["1"][0][1]).toBe(true);
    expect(applyCodeOp(viaSet, op).get(1)!.get("f.txt")).toBe(target);
  });
});

// =======================================================================================
// Application semantics

describe("applyCodeOp", () => {
  it("does not modify its input", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    applyCodeOp(c, { 1: [["f.txt", { set: "changed" }], ["g.txt", { set: "new" }]] });
    expect(toPlain(c)).toEqual({ 1: { "f.txt": "hello" } });
  });

  it("throws on an edit of an absent file or a wrong-length base", () => {
    let c = content({ 1: { "f.txt": "ab" } });
    expect(() => applyCodeOp(c, { 1: [["g.txt", { edit: [2] }]] })).toThrow(/absent file/);
    expect(() => applyCodeOp(c, { 1: [["f.txt", { edit: [5] }]] })).toThrow(/wrong length/);
  });

  it("treats remove of an absent file as a no-op", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    let result = applyCodeOp(
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

describe("validateCodeOpSchema", () => {
  it("accepts the identity op and well-formed ops", () => {
    validateCodeOpSchema({});
    validateCodeOpSchema({
      0: [["a.txt", { set: "" }]],
      12: [["b/c.txt", { edit: [1, [2, "x", ""], 3] }], ["d.txt", { remove: true }]],
    });
  });

  it("rejects malformed outer shapes", () => {
    expect(() => validateCodeOpSchema([] as unknown as CodeOp)).toThrow(/must be an object/);
    expect(() => validateCodeOpSchema({ "01": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeOpSchema({ "-1": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeOpSchema({ "1.5": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeOpSchema({ "abc": [["a", { remove: true }]] }))
        .toThrow(/canonical gadget id/);
    expect(() => validateCodeOpSchema({ 1: [] })).toThrow(/is empty/);
    expect(() => validateCodeOpSchema({ 1: {} as unknown as CodeOp[string] }))
        .toThrow(/must be an array/);
    expect(() => validateCodeOpSchema({ 1: ["f"] as unknown as CodeOp[string] }))
        .toThrow(/pair/);
    expect(() => validateCodeOpSchema({ 1: [["f"]] as unknown as CodeOp[string] }))
        .toThrow(/pair/);
    expect(() => validateCodeOpSchema({ 1: [[42, { remove: true }]] as unknown as CodeOp[string] }))
        .toThrow(/pair/);
    expect(() => validateCodeOpSchema({ 1: [["", { remove: true }]] })).toThrow(/path is empty/);
    expect(() => validateCodeOpSchema(
        { 1: [["f", { remove: true }], ["f", { set: "x" }]] })).toThrow(/duplicate/);
  });

  it("rejects malformed file ops", () => {
    let bad = (fileOp: unknown) =>
        expect(() => validateCodeOpSchema({ 1: [["f", fileOp as FileOp]] }));
    bad({}).toThrow(/exactly one/);
    bad({ set: "x", remove: true }).toThrow(/exactly one/);
    bad({ frobnicate: 1 }).toThrow(/exactly one/);
    bad(null).toThrow(/must be an object/);
    bad("remove").toThrow(/must be an object/);
    bad({ set: 42 }).toThrow(/must be a string/);
    bad({ remove: false }).toThrow(/must be true/);
  });

  it("rejects malformed text ops", () => {
    let bad = (edit: unknown) =>
        expect(() => validateCodeOpSchema({ 1: [["f", { edit: edit as TextOp }]] }));
    bad("nope").toThrow(/must be an array/);
    bad([{}]).toThrow(/invalid section length/);
    bad([-1]).toThrow(/invalid section length/);
    bad([1.5]).toThrow(/invalid section length/);
    bad([["x"]]).toThrow(/invalid section length/);
    bad([[-2, "x"]]).toThrow(/invalid section length/);
    bad([[1, 2]]).toThrow(/malformed/);
  });

  it("rejects do-nothing sections and embedded newlines in inserted lines", () => {
    let bad = (edit: unknown) =>
        expect(() => validateCodeOpSchema({ 1: [["f", { edit: edit as TextOp }]] }));
    // Zero-progress padding would evade the size caps.
    bad([0]).toThrow(/do-nothing/);
    bad([1, 0, 1]).toThrow(/do-nothing/);
    bad([[0]]).toThrow(/do-nothing/);
    bad([[0, ""]]).toThrow(/do-nothing/);
    // An inserted "line" containing "\n" desynchronizes line metadata from the text.
    bad([[0, "a\nb"], 3]).toThrow(/contains a newline/);
    // The legitimate forms of the same content still pass.
    validateCodeOpSchema({ 1: [["f", { edit: [[0, "a", "b"], 3] }]] });  // multi-line insert
    validateCodeOpSchema({ 1: [["f", { edit: [[0, "", ""], 3] }]] });  // pure "\n" insert
  });

  it("enforces the per-file, per-path, and per-op size caps", () => {
    let big = "x".repeat(MAX_FILE_TEXT_LENGTH + 1);
    expect(() => validateCodeOpSchema({ 1: [["f", { set: big }]] })).toThrow(/too large/);
    expect(() => validateCodeOpSchema({ 1: [["f", { edit: [[0, big]] }]] })).toThrow(/too large/);
    // Growing an existing file past the cap trips on newLength even with a small insertion.
    expect(() => validateCodeOpSchema(
        { 1: [["f", { edit: [MAX_FILE_TEXT_LENGTH, [0, "!"]] }]] })).toThrow(/too large/);

    expect(() => validateCodeOpSchema(
        { 1: [["p".repeat(MAX_FILE_PATH_LENGTH + 1), { remove: true }]] }))
        .toThrow(/path is too long/);

    let chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
    let files: [string, FileOp][] = [];
    let count = Math.ceil(MAX_CODE_OP_SIZE / MAX_FILE_TEXT_LENGTH) + 1;
    for (let i = 0; i < count; i++) files.push([`f${i}`, { set: chunk }]);
    expect(() => validateCodeOpSchema({ 1: files })).toThrow(/op is too large/);
  });

  it("caps ops made of many payload-free entries", () => {
    // Removes insert nothing, but each entry still counts toward the op size.
    let path = "p".repeat(1000);
    let removes: [string, FileOp][] = [];
    for (let i = 0; i * 1000 <= MAX_CODE_OP_SIZE; i++) {
      removes.push([`${path}${i}`, { remove: true }]);
    }
    expect(() => validateCodeOpSchema({ 1: removes })).toThrow(/op is too large/);

    // Likewise an edit's sections: maximal fragmentation (one section per retained unit)
    // counts toward the op size even though it inserts nothing.
    let sections: TextOp = Array.from({ length: MAX_FILE_TEXT_LENGTH }, () => 1);
    let edits: [string, FileOp][] = [];
    for (let i = 0; i < 5; i++) edits.push([`e${i}`, { edit: sections }]);
    expect(() => validateCodeOpSchema({ 1: edits })).toThrow(/op is too large/);
  });

  it("rejects oversized edits before walking or re-parsing them", () => {
    // A hostile section count is rejected by the O(1) pre-check: had the sections been walked,
    // these holes would report "invalid section length" instead (and had it reached
    // ChangeSet.fromJSON, a second multi-million-element representation would be allocated).
    let holes: TextOp = [];
    holes.length = 100_000_000;
    expect(() => validateCodeOpSchema({ 1: [["f", { edit: holes }]] }))
        .toThrow(/code op is too large/);

    // Inserted text is budget-checked as it accrues: this edit's total insertion exceeds the
    // *op* budget mid-walk, which fires before the per-file newLength check ("file is too
    // large") that runs after fromJSON.
    let chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
    let inserts: TextOp = Array.from({ length: 5 }, () => [0, chunk] as [number, string]);
    expect(() => validateCodeOpSchema({ 1: [["f", { edit: inserts }]] }))
        .toThrow(/code op is too large/);

    // A single section padded with empty lines is rejected on its separator count alone,
    // before its lines are walked: the poisoned last line would otherwise report "contains a
    // newline".
    let padded: TextOp = [[0, ...Array.from({ length: 2_100_000 }, () => ""), "a\nb"]];
    expect(() => validateCodeOpSchema({ 1: [["f", { edit: padded }]] }))
        .toThrow(/code op is too large/);
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

    let op = diffFiles(before, after);
    validateCodeOpSchema(op);
    expect(op["1"].map(([path]) => path)).toEqual([...NAMES].toSorted());
    expect(toPlain(applyCodeOp(before, op))).toEqual(toPlain(after));

    // The op survives JSON serialization (as stored rows do)...
    let reparsed = JSON.parse(JSON.stringify(op)) as CodeOp;
    expect(toPlain(applyCodeOp(before, reparsed))).toEqual(toPlain(after));

    // ...and Cap'n Web serialization (as broadcast rows and submitted ops do), which is the
    // round-trip a path-keyed representation could not make.
    let overRpc = deserialize(serialize(op)) as CodeOp;
    expect(overRpc).toEqual(op);
    expect(toPlain(applyCodeOp(before, overRpc))).toEqual(toPlain(after));
  });

  it("keeps them intact through transform and compose", () => {
    let c = content({ 1: { "f.txt": "hello" } });
    let a: CodeOp = { 1: [["constructor", { set: "x" }], ["__proto__", { set: "y" }]] };
    let b: CodeOp = { 1: [["f.txt", { set: "z" }]] };

    // The expected content is built with JSON.parse: a literal "__proto__" property in source
    // would set the prototype rather than the key. (toPlain's Object.fromEntries creates real
    // keys for such names.)
    let expected = JSON.parse('{"1": {"f.txt": "z", "constructor": "x", "__proto__": "y"}}');

    let t = transformCodeOp(a, b);
    expect(toPlain(applyCodeOp(applyCodeOp(c, a), t.b)))
        .toEqual(toPlain(applyCodeOp(applyCodeOp(c, b), t.a)));
    expect(toPlain(applyCodeOp(applyCodeOp(c, a), t.b))).toEqual(expected);

    let composed = composeCodeOp(a, b);
    expect(toPlain(applyCodeOp(c, composed))).toEqual(expected);
  });
});

describe("validateCodeOpContent", () => {
  const CONTENT = content({ 1: { "f.txt": "😀x" } });

  it("accepts boundary-clean edits, sets, and removes of anything", () => {
    validateCodeOpContent({ 1: [["f.txt", { edit: [[2], 1] }]] }, CONTENT);  // delete the 😀
    validateCodeOpContent({ 1: [["f.txt", { edit: [3] }]] }, CONTENT);  // identity retain
    validateCodeOpContent({ 1: [["f.txt", { edit: [[0, "🧠"], 3] }]] }, CONTENT);
    validateCodeOpContent({ 1: [["absent.txt", { set: "hi" }]] }, CONTENT);
    validateCodeOpContent({ 9: [["nowhere.txt", { remove: true }]] }, CONTENT);
  });

  it("rejects edits of absent files and wrong-length bases", () => {
    expect(() => validateCodeOpContent({ 1: [["g.txt", { edit: [3] }]] }, CONTENT))
        .toThrow(/absent file/);
    expect(() => validateCodeOpContent({ 2: [["f.txt", { edit: [3] }]] }, CONTENT))
        .toThrow(/absent file/);
    expect(() => validateCodeOpContent({ 1: [["f.txt", { edit: [7] }]] }, CONTENT))
        .toThrow(/length mismatch/);
  });

  it("rejects boundaries that split a surrogate pair", () => {
    // Delete just the high half of the 😀.
    expect(() => validateCodeOpContent({ 1: [["f.txt", { edit: [[1], 2] }]] }, CONTENT))
        .toThrow(/splits a surrogate pair/);
    // Replace starting mid-pair.
    expect(() => validateCodeOpContent({ 1: [["f.txt", { edit: [1, [1, "y"], 1] }]] }, CONTENT))
        .toThrow(/splits a surrogate pair/);
  });

  it("rejects lone surrogates in inserted and set text", () => {
    expect(() => validateCodeOpContent(
        { 1: [["f.txt", { edit: [[0, "\ud83d"], 3] }]] }, CONTENT))
        .toThrow(/lone surrogate/);
    expect(() => validateCodeOpContent(
        { 1: [["g.txt", { set: "ok\udc00" }]] }, CONTENT))
        .toThrow(/lone surrogate/);
    // A well-formed pair in an insert passes.
    validateCodeOpContent({ 1: [["f.txt", { edit: [[0, "😀"], 3] }]] }, CONTENT);
  });
});
