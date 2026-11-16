import { describe, expect, it } from "vitest";
import { jsonLength } from "../src/json-length";
import { seeded } from "./doc-fixture";

/** The characters a generated string is drawn from: one for each way a JSON string writes one. */
const ALPHABET = [
  "a", "Z", " ", "0", "\"", "\\", "\b", "\t", "\n", "\u000b", "\f", "\r", "\u0000", "\u001f",
  "\u007f", "\u2028", "é", "中", "😀", "\ud83d", "\ude00",
];

const NUMBERS = [0, -0, 1, -17, 1.5, -0.001, 123456789.125, 1e21, 1e-7, NaN, Infinity, -Infinity];

/** Generated values, each made of everything `JSON.stringify` treats in a way of its own. */
function generator(seed: number) {
  let random = seeded(seed);
  let below = (limit: number) => Math.floor(random() * limit);
  let pick = <T>(items: readonly T[]): T => items[below(items.length)];
  let string = () => Array.from({ length: below(7) }, () => pick(ALPHABET)).join("");
  let array = (depth: number) => {
    let items: unknown[] = Array.from({ length: below(5) }, () => value(depth - 1));
    // A hole: an index the array holds nothing at.
    if (items.length > 0 && below(4) === 0) delete items[below(items.length)];
    return items;
  };
  let object = (depth: number) =>
    Object.fromEntries(Array.from({ length: below(5) }, () => [string(), value(depth - 1)]));
  /** An object `JSON.stringify` writes as what its `toJSON` returns. */
  let replaced = (depth: number): unknown => {
    let returned = pick([
      () => undefined,
      () => pick(NUMBERS),
      () => `quote " and line \n${string()}`,
      () => array(depth),
      // A nested object, which holds such objects of its own.
      () => ({ inner: replaced(depth - 1), ...object(depth) }),
      // What `toJSON` returns is written as it is: its own `toJSON` is not called.
      () => ({ toJSON: () => { throw new Error("called on what toJSON returned"); }, b: string() }),
    ])();
    return { ignored: string(), toJSON: () => returned };
  };
  let leaf = (): unknown => pick([
    () => null, () => true, () => false, () => undefined, () => pick(NUMBERS), string, string,
    () => new Date(below(2_000_000_000_000)),
    () => new Number(1.5), () => new String("a\"b"), () => new Boolean(false),
    () => () => 1, () => Symbol("s"),
  ])();
  /** A value at most `depth` levels of arrays and objects deep. */
  let value = (depth: number): unknown => depth <= 0
    ? leaf()
    : pick([leaf, () => array(depth), () => array(depth), () => object(depth), () => object(depth),
      () => replaced(depth)])();
  return { below, value };
}

describe("jsonLength", () => {
  it("counts what JSON.stringify writes, for generated values", () => {
    let { below, value } = generator(20_240);
    let seen = new Set<string>();
    let compared = 0;
    for (let i = 0; i < 2_000; i++) {
      let generated = value(1 + below(4));
      let text = JSON.stringify(generated) as string | undefined;
      // A value with no text at the top is the last test's.
      if (text === undefined) continue;
      expect(jsonLength(generated), text).toBe(text.length);
      seen.add(text);
      compared++;
    }
    expect(compared).toBeGreaterThan(1_800);
    // The generator reaches what it claims to: each kind of text appears in some value.
    let all = [...seen].join("\n");
    for (let part of [
      "\\\"", "\\\\", "\\b", "\\t", "\\n", "\\u000b", "\\f", "\\r", "\\u0000", "\\u001f",
      "\\ud83d", "\\ude00", "😀", "\u007f", "\u2028", "é", "中", "1e+21", "1e-7", "null", "[null,",
      ",null]", "{}", "[]", "1.5", "\"a\\\"b\"", "false", "quote \\\" and line \\n",
    ]) {
      expect(all).toContain(part);
    }
    // A date, as its `toJSON` writes it.
    expect(all).toMatch(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/);
  });

  it("counts each escape as JSON.stringify writes it", () => {
    for (let [text, length] of [
      ["", 2],
      ["plain", 7],
      ["\"", 4],
      ["\\", 4],
      ["\b", 4], ["\t", 4], ["\n", 4], ["\f", 4], ["\r", 4],
      ["\u0000", 8], ["\u000b", 8], ["\u001f", 8],
      // Neither is escaped: a space, U+007F, a line separator, an accented and a CJK letter.
      [" ", 3], ["\u007f", 3], ["\u2028", 3], ["é", 3], ["中", 3],
      // A well-formed pair is its two units.
      ["😀", 4],
      // A high surrogate with no low one after it, and a low one with no high one before it.
      ["\ud83d", 8], ["\ud83dx", 9], ["\ud83d😀", 10],
      ["\ude00", 8], ["x\ude00", 9], ["\ude00\ud83d", 14], ["😀\ude00", 10],
    ] as const) {
      expect(jsonLength(text), JSON.stringify(text)).toBe(length);
      expect(JSON.stringify(text).length, JSON.stringify(text)).toBe(length);
      // A key is written as a string is.
      expect(jsonLength({ [text]: 1 })).toBe(length + 4);
      expect(JSON.stringify({ [text]: 1 }).length).toBe(length + 4);
    }
  });

  it("counts a number as it is printed, and a non-finite one as null", () => {
    for (let [number, length] of [
      [0, 1], [-0, 1], [7, 1], [-17, 3], [1.5, 3], [1e21, 5], [1e-7, 4], [0.1 + 0.2, 19],
      [NaN, 4], [Infinity, 4], [-Infinity, 4],
    ]) {
      expect(jsonLength(number), String(number)).toBe(length);
      expect(JSON.stringify(number).length, String(number)).toBe(length);
    }
  });

  it("counts an array's holes and an object's unwritten properties as JSON.stringify does", () => {
    let holed = [1, 2, 3];
    delete holed[1];
    for (let [value, length] of [
      [[], 2], [{}, 2], [[[]], 4], [{ a: {} }, 8],
      [[undefined], 6], [holed, 10], [[() => 1, Symbol("s")], 11],
      [{ a: undefined }, 2], [{ a: () => 1, b: Symbol("s") }, 2],
      // A comma stands only between properties that are written.
      [{ a: undefined, b: 1, c: undefined, d: 2, e: undefined }, 13],
      [{ a: null, b: true, c: false }, 29],
      // Only its own enumerable keys are written: not an inherited one, not a hidden one.
      [Object.assign(Object.create({ inherited: 1 }), { own: 2 }), 9],
      [Object.defineProperty({ a: 1 }, "hidden", { value: 2, enumerable: false }), 7],
    ] as const) {
      expect(jsonLength(value), JSON.stringify(value)).toBe(length);
      expect(JSON.stringify(value).length, JSON.stringify(value)).toBe(length);
    }
  });

  it("counts what toJSON returns in the place the object stood", () => {
    let date = new Date(Date.UTC(2020, 1, 29, 12, 30, 45, 678));
    let replacedFunction = Object.assign(() => 1, { toJSON: () => "f" });
    for (let [value, length] of [
      [[{ toJSON: () => undefined }], 6],
      [{ a: { toJSON: () => undefined } }, 2],
      [{ toJSON: () => 1 }, 1],
      // What it returns has a `toJSON` of its own, which is a property like any other: left out.
      [{ toJSON: () => ({ toJSON: () => 1, b: 2 }) }, 7],
      [{ a: 1, toJSON: () => [1, "\n"] }, 8],
      [date, 26], [[date], 28], [{ at: date }, 33],
      [new Date(NaN), 4],
      // A function with a `toJSON` is replaced as an object is, wherever it stands.
      [replacedFunction, 3], [[replacedFunction], 5], [{ a: replacedFunction }, 9],
    ] as const) {
      expect(jsonLength(value), JSON.stringify(value)).toBe(length);
      expect(JSON.stringify(value).length, JSON.stringify(value)).toBe(length);
    }
    // Once, and never on what it returned.
    let calls = 0;
    let once = { toJSON: () => { calls++; return { toJSON: () => { calls += 10; return 0; } }; } };
    expect(jsonLength([once])).toBe(4);
    expect(calls).toBe(1);
  });

  it("counts a boxed number, string or boolean as its primitive", () => {
    for (let [value, length] of [
      [new Number(1.5), 3], [new Number(NaN), 4], [new String("a\"b"), 6], [Object("a"), 3],
      [new Boolean(false), 5], [new Boolean(true), 4],
      [[new Number(-0)], 3], [{ a: new String("") }, 8],
      // A boxed value `toJSON` returned is unboxed too.
      [{ toJSON: () => new Number(12) }, 2],
    ] as const) {
      expect(jsonLength(value), JSON.stringify(value)).toBe(length);
      expect(JSON.stringify(value).length, JSON.stringify(value)).toBe(length);
    }
  });

  it("throws for a value JSON.stringify gives no text for", () => {
    for (let value of [undefined, () => 1, Symbol("s"), { toJSON: () => undefined }]) {
      expect(JSON.stringify(value)).toBeUndefined();
      expect(() => jsonLength(value)).toThrow(TypeError);
    }
    for (let value of [1n, [1n], { a: 1n }, Object(1n), { toJSON: () => 1n }]) {
      expect(() => JSON.stringify(value)).toThrow(TypeError);
      expect(() => jsonLength(value)).toThrow(TypeError);
    }
  });
});
