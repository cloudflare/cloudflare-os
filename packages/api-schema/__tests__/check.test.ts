// checkArguments(), on a hand-built schema with one parameter per kind it tells apart.

import { describe, expect, test } from "vitest";
import { checkArguments, MAX_ARGUMENT_PROBLEMS } from "../src/check.ts";
import { type ApiShape, FORMAT, type Schema, type SchemaParam, type SchemaShape } from "../src/schema.ts";

const param = (name: string, type: ApiShape, optional = false): SchemaParam => ({ name, type, optional, doc: "" });
const orUndefined = (shape: ApiShape): ApiShape => ({ kind: "union", branches: [shape, { kind: "undefined" }] });
const literal = (value: string): ApiShape => ({ kind: "literal", value });
/** An array of `length` with `entries` at their indexes and holes elsewhere. */
function holed(length: number, entries: Record<number, unknown>): unknown[] {
  const array: unknown[] = [];
  array.length = length;
  return Object.assign(array, entries);
}
/** The one problem with a `what` where a value is due. */
const refused = (what: string) => [`value: expected ${what}, which can't be passed by value`];

/** A node of a tree, tagged `a` to `e`, each kind an object branch that holds more nodes. */
const TREE_KINDS = ["a", "b", "c", "d", "e"];

const SHAPES: Record<string, SchemaShape> = {
  Options: {
    doc: "What to list.",
    kind: "object",
    properties: { limit: orUndefined({ kind: "number" }), query: { kind: "string" } },
    propertyDocs: { limit: { doc: "The most to return." } },
  },
  Labels: { kind: "object", properties: { primary: { kind: "string" } }, index: { kind: "number" } },
  Mood: { kind: "union", branches: [literal("busy"), literal("calm")], tags: { since: "1" } },
  Size: { kind: "union", branches: [literal("large"), literal("small")] },
  Destination: {
    kind: "union",
    branches: [
      { kind: "object", properties: { kind: literal("inbox") } },
      { kind: "object", properties: { kind: literal("folder"), path: { kind: "string" } } },
    ],
  },
  Source: {
    kind: "union",
    branches: [
      { kind: "object", properties: { kind: literal("mail") } },
      { kind: "object", properties: { kind: literal("feed"), url: { kind: "string" } } },
    ],
  },
  Pair: { kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }] },
  Names: { kind: "array", element: { kind: "string" } },
  Chain: { kind: "object", properties: { child: orUndefined({ kind: "ref", name: "Chain" }) } },
  Tree: {
    kind: "union",
    branches: TREE_KINDS.map((kind) => ({
      kind: "object",
      properties: { children: { kind: "array", element: { kind: "ref", name: "Tree" } }, kind: literal(kind) },
    })),
  },
};

/** A schema whose service `Api` has `method(value)` for `type`, and `call` with `params`. */
function schemaOf(type: ApiShape, params: SchemaParam[] = []): Schema {
  return {
    format: FORMAT,
    entry: "Api",
    constants: {},
    services: {
      Api: {
        doc: "",
        direction: "server",
        methods: [
          { name: "call", doc: "", params, returns: { kind: "void" } },
          { name: "method", doc: "", params: [param("value", type)], returns: { kind: "void" } },
        ],
      },
    },
    shapes: SHAPES,
  };
}

/** The problems with `value` as the one argument of a parameter of `type`. */
const check = (type: ApiShape, value: unknown) => checkArguments(schemaOf(type), "Api", "method", [value]);

describe("kinds", () => {
  test("primitives, void, null and literals", () => {
    for (const [kind, good, bad] of [
      ["string", "a", 1], ["number", 1, "1"], ["boolean", false, 0], ["bigint", 1n, 1],
      ["null", null, undefined], ["undefined", undefined, null],
    ] as const) {
      expect(check({ kind }, good)).toEqual([]);
      expect(check({ kind }, bad)).toEqual([`value: expected ${kind}`]);
    }
    expect(check({ kind: "void" }, undefined)).toEqual([]);
    expect(check({ kind: "void" }, 0)).toEqual(["value: expected undefined"]);
    expect(check({ kind: "void" }, null)).toEqual(["value: expected undefined"]);
    expect(check({ kind: "literal", value: "on" }, "on")).toEqual([]);
    expect(check({ kind: "literal", value: "on" }, "off")).toEqual(['value: expected "on"']);
    expect(check({ kind: "literal", value: 2 }, 2)).toEqual([]);
    expect(check({ kind: "literal", value: 2 }, "2")).toEqual(["value: expected 2"]);
    expect(check({ kind: "literal", value: true }, false)).toEqual(["value: expected true"]);
  });

  test("any and unsupported accept anything", () => {
    for (const value of [undefined, null, 1, {}, () => 1, new Map(), new ReadableStream()]) {
      expect(check({ kind: "any" }, value)).toEqual([]);
      expect(check({ kind: "unsupported", reason: "a symbol" }, value)).toEqual([]);
    }
  });

  test("arrays, sets and maps, with the path to each element", () => {
    const strings: ApiShape = { kind: "array", element: { kind: "string" } };
    expect(check(strings, ["a", "b"])).toEqual([]);
    expect(check(strings, [])).toEqual([]);
    expect(check(strings, "a")).toEqual(["value: expected array"]);
    expect(check(strings, ["a", 1, "c", false])).toEqual(["value[1]: expected string", "value[3]: expected string"]);
    expect(check(strings, { 0: "a", length: 1 })).toEqual(["value: expected array"]);
    expect(check({ kind: "ref", name: "Names" }, 1)).toEqual(["value: expected array"]);
    // A hole reads as `undefined`.
    expect(check(strings, holed(3, { 0: "a", 2: "c" }))).toEqual(["value[1]: expected string"]);

    const set: ApiShape = { kind: "set", element: { kind: "number" } };
    expect(check(set, new Set([1, 2]))).toEqual([]);
    expect(check(set, [1, 2])).toEqual(["value: expected Set"]);
    expect(check(set, new Set([1, "2"]))).toEqual(["value[1]: expected number"]);

    const map: ApiShape = { kind: "map", key: { kind: "string" }, value: { kind: "ref", name: "Options" } };
    expect(check(map, new Map([["a", { query: "q" }]]))).toEqual([]);
    expect(check(map, { a: { query: "q" } })).toEqual(["value: expected Map"]);
    expect(check(map, new Map<unknown, unknown>([["a", { query: "q" }], [2, { query: 3 }]])))
      .toEqual(["value[1][0]: expected string", "value[1][1].query: expected string"]);
  });

  test("tuples: required, optional and variadic elements", () => {
    const pair: ApiShape = { kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }] };
    expect(check(pair, ["a", 1])).toEqual([]);
    expect(check(pair, ["a"])).toEqual(["value: expected an array of 2"]);
    expect(check(pair, ["a", 1, 2])).toEqual(["value: expected an array of 2"]);
    expect(check(pair, "a1")).toEqual(["value: expected an array of 2"]);
    expect(check(pair, [1, "a"])).toEqual(["value[0]: expected string", "value[1]: expected number"]);
    // A hole is not a required element.
    expect(check(pair, holed(2, { 0: "a" }))).toEqual(["value[1]: expected number"]);
    // A named tuple is described as its shape, and by its name among a union's branches.
    expect(check({ kind: "ref", name: "Pair" }, ["a"])).toEqual(["value: expected an array of 2"]);
    expect(check({ kind: "union", branches: [{ kind: "ref", name: "Pair" }, { kind: "null" }] }, ["a"]))
      .toEqual(["value: expected Pair | null"]);

    const optional: ApiShape = { kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }], minLength: 1 };
    expect(check(optional, ["a"])).toEqual([]);
    expect(check(optional, ["a", 1])).toEqual([]);
    expect(check(optional, ["a", undefined])).toEqual([]);
    expect(check(optional, ["a", "1"])).toEqual(["value[1]: expected number"]);
    expect(check(optional, [])).toEqual(["value: expected an array of 1 to 2"]);
    expect(check(optional, ["a", 1, 2])).toEqual(["value: expected an array of 1 to 2"]);

    const rest: ApiShape = { kind: "tuple", elements: [{ kind: "string" }], rest: { kind: "boolean" } };
    expect(check(rest, ["a"])).toEqual([]);
    expect(check(rest, ["a", true, false])).toEqual([]);
    expect(check(rest, ["a", true, 1])).toEqual(["value[2]: expected boolean"]);
    // Only an optional element may be `undefined`, not one of the rest.
    expect(check(rest, ["a", undefined])).toEqual(["value[1]: expected boolean"]);
    expect(check(rest, [])).toEqual(["value: expected an array of at least 1"]);
  });

  test("objects: declared keys, optional ones, undeclared ones and index signatures", () => {
    const options: ApiShape = { kind: "ref", name: "Options" };
    expect(check(options, { query: "a" })).toEqual([]);
    expect(check(options, { query: "a", limit: 5 })).toEqual([]);
    expect(check(options, { query: "a", limit: undefined })).toEqual([]);
    expect(check(options, { limit: "5" })).toEqual(["value.limit: expected number", "value.query: expected string"]);
    expect(check(options, { query: "a", extra: 1, "two words": 2 }))
      .toEqual(["value.extra: expected no such key", 'value["two words"]: expected no such key']);
    for (const value of [null, [], "a", new Date(), new (class Options { query = "a"; })()]) {
      expect(check(options, value)).toEqual(["value: expected object"]);
    }
    expect(check(options, Object.assign(Object.create(null), { query: "a" }))).toEqual([]);
    // A key the value only inherits is not one it has, even where what it inherits would fit.
    expect(check(options, Object.assign(Object.create({ query: "a" }), {}))).toEqual(["value: expected object"]);
    const text: ApiShape = { kind: "string" };
    expect(check({ kind: "object", properties: { toString: text } }, {})).toEqual(["value.toString: expected string"]);
    const proto: ApiShape = { kind: "object", properties: { ["__proto__"]: { kind: "object", properties: {} } } };
    expect(check(proto, {})).toEqual(["value.__proto__: expected object"]);
    expect(check(proto, JSON.parse('{ "__proto__": {} }'))).toEqual([]);
    // Nor is a key every object inherits one the shape declares.
    expect(check(options, { query: "a", constructor: 1 })).toEqual(["value.constructor: expected no such key"]);

    const labels: ApiShape = { kind: "ref", name: "Labels" };
    expect(check(labels, { primary: "a" })).toEqual([]);
    expect(check(labels, { primary: "a", red: 1, blue: 2 })).toEqual([]);
    expect(check(labels, { primary: "a", red: "1", "light blue": null }))
      .toEqual(["value.red: expected number", 'value["light blue"]: expected number']);
    // A declared key is checked as declared, not as the index signature.
    expect(check(labels, { primary: 1 })).toEqual(["value.primary: expected string"]);
    // A key every object inherits is checked as the index signature when the value has it.
    expect(check(labels, { primary: "a", toString: "b" })).toEqual(["value.toString: expected number"]);
  });

  test("unions: a value fits some branch, or the problem names the union", () => {
    const nullable: ApiShape = { kind: "union", branches: [{ kind: "string" }, { kind: "null" }] };
    expect(check(nullable, null)).toEqual([]);
    expect(check(nullable, "a")).toEqual([]);
    expect(check(nullable, 1)).toEqual(["value: expected string | null"]);
    // `undefined` is left out of the description: a value it fit would not be described.
    expect(check(orUndefined({ kind: "number" }), "1")).toEqual(["value: expected number"]);
    expect(check(orUndefined({ kind: "ref", name: "Mood" }), 1)).toEqual(['value: expected "busy" | "calm"']);
    // One branch failing only inside the value is the one reported.
    expect(check(orUndefined({ kind: "ref", name: "Options" }), { query: 1 })).toEqual(["value.query: expected string"]);
    // Branches of one kind are named once.
    expect(check({ kind: "union", branches: [{ kind: "ref", name: "Options" }, { kind: "ref", name: "Labels" }] }, 1))
      .toEqual(["value: expected object"]);
  });

  test("named unions: by their branches when those are scalars, by name when not", () => {
    const mood: ApiShape = { kind: "ref", name: "Mood" };
    expect(check(mood, "calm")).toEqual([]);
    expect(check(mood, "angry")).toEqual(['value: expected "busy" | "calm"']);

    const destination: ApiShape = { kind: "ref", name: "Destination" };
    expect(check(destination, { kind: "folder", path: "/a" })).toEqual([]);
    expect(check(destination, { kind: "inbox" })).toEqual([]);
    // Several branches fail inside the value, so none is singled out.
    expect(check(destination, { kind: "folder" })).toEqual(["value: expected Destination"]);
    expect(check(destination, "inbox")).toEqual(["value: expected Destination"]);
    expect(check({ kind: "array", element: destination }, [{ kind: "inbox" }, { kind: "outbox" }]))
      .toEqual(["value[1]: expected Destination"]);
  });

  test("two unions tried on one value each give their own answer", () => {
    const mood: ApiShape = { kind: "ref", name: "Mood" };
    const size: ApiShape = { kind: "ref", name: "Size" };
    const either: ApiShape = { kind: "union", branches: [mood, size] };
    expect(check(either, "small")).toEqual([]);
    expect(check(either, "calm")).toEqual([]);
    expect(check(either, "mild")).toEqual(['value: expected "busy" | "calm" | "large" | "small"']);
    // Inside two object branches, at one path: neither the refusal nor the fit of the first
    // branch's union is taken for the second's.
    const tagged: ApiShape = {
      kind: "union",
      branches: [
        { kind: "object", properties: { x: mood, y: { kind: "string" } } },
        { kind: "object", properties: { x: size, y: { kind: "number" } } },
      ],
    };
    expect(check(tagged, { x: "calm", y: "a" })).toEqual([]);
    expect(check(tagged, { x: "small", y: 1 })).toEqual([]);
    expect(check(tagged, { x: "calm", y: 1 })).toEqual(["value: expected object"]);
    expect(check(tagged, { x: "small", y: "a" })).toEqual(["value: expected object"]);
    // The same of two unions of objects, whose answers are kept by union as well as by path.
    const destination: ApiShape = { kind: "ref", name: "Destination" };
    const source: ApiShape = { kind: "ref", name: "Source" };
    expect(check({ kind: "union", branches: [destination, source] }, { kind: "mail" })).toEqual([]);
    const held: ApiShape = {
      kind: "union",
      branches: [
        { kind: "object", properties: { x: destination, y: { kind: "string" } } },
        { kind: "object", properties: { x: source, y: { kind: "number" } } },
      ],
    };
    expect(check(held, { x: { kind: "mail" }, y: 1 })).toEqual([]);
    expect(check(held, { x: { kind: "inbox" }, y: 1 })).toEqual(["value: expected object"]);
  });

  test("dates, bytes, typed arrays and other built-ins", () => {
    expect(check({ kind: "date" }, new Date(0))).toEqual([]);
    expect(check({ kind: "date" }, new Date(Number.NaN))).toEqual(["value: expected a valid Date"]);
    expect(check({ kind: "date" }, "2026-01-01")).toEqual(["value: expected a valid Date"]);
    expect(check({ kind: "bytes" }, new Uint8Array(2))).toEqual([]);
    expect(check({ kind: "bytes" }, [1, 2])).toEqual(["value: expected Uint8Array"]);
    expect(check({ kind: "typedArray", name: "Float64Array" }, new Float64Array(1))).toEqual([]);
    expect(check({ kind: "typedArray", name: "Float64Array" }, new Float32Array(1))).toEqual(["value: expected Float64Array"]);
    for (const [kind, good, name] of [
      ["error", new TypeError("x"), "Error"], ["arrayBuffer", new ArrayBuffer(1), "ArrayBuffer"],
      ["dataView", new DataView(new ArrayBuffer(1)), "DataView"], ["regexp", /x/, "RegExp"], ["blob", new Blob([]), "Blob"],
      ["url", new URL("https://example.com"), "URL"], ["headers", new Headers(), "Headers"],
      ["request", new Request("https://example.com"), "Request"], ["response", new Response(), "Response"],
    ] as const) {
      expect(check({ kind }, good)).toEqual([]);
      expect(check({ kind }, "https://example.com")).toEqual([`value: expected ${name}`]);
    }
    // A typed array this runtime lacks can't be told apart, so the value is left to where the call
    // lands: a name of no global, of another global, or of something every object inherits.
    for (const name of ["Float16ArrayFromTheFuture", "Object", "constructor", "toString", "__proto__"]) {
      expect(check({ kind: "typedArray", name }, 1)).toEqual([]);
    }
  });

  test("a built-in the global object inherits is checked as one it owns", () => {
    // Some runtimes keep these constructors on the global object's prototype.
    const globals = globalThis as Record<string, unknown>;
    const inherited = Object.getPrototypeOf(globalThis) as Record<string, unknown>;
    const builtIns = ([
      ["blob", "Blob", new Blob([])], ["url", "URL", new URL("https://example.com")],
      ["headers", "Headers", new Headers()], ["request", "Request", new Request("https://example.com")],
      ["response", "Response", new Response()],
    ] as const).map((builtIn) => [...builtIn, Object.getOwnPropertyDescriptor(globals, builtIn[1])!] as const);
    try {
      for (const [, name, , descriptor] of builtIns) {
        delete globals[name];
        Object.defineProperty(inherited, name, descriptor);
      }
      for (const [kind, name, good] of builtIns) {
        expect(Object.hasOwn(globals, name)).toBe(false);
        expect(check({ kind }, good)).toEqual([]);
        expect(check({ kind }, "https://example.com")).toEqual([`value: expected ${name}`]);
      }
    } finally {
      for (const [, name, , descriptor] of builtIns) {
        delete inherited[name];
        Object.defineProperty(globals, name, descriptor);
      }
    }
  });

  test("capabilities, functions and streams are always refused", () => {
    expect(check({ kind: "stub", service: "Api" }, { dup() {} })).toEqual(refused("a capability"));
    expect(check({ kind: "stub" }, undefined)).toEqual(refused("a capability"));
    expect(check({ kind: "function", params: [], returns: { kind: "void" } }, () => {})).toEqual(refused("a function"));
    expect(check({ kind: "readableStream" }, new ReadableStream())).toEqual(refused("a stream"));
    expect(check({ kind: "writableStream", element: { kind: "bytes" } }, new WritableStream())).toEqual(refused("a stream"));
    // Inside a value, too, and as a branch of a union.
    expect(check({ kind: "array", element: { kind: "stub", service: "Api" } }, [1]))
      .toEqual(["value[0]: expected a capability, which can't be passed by value"]);
    expect(check({ kind: "union", branches: [{ kind: "stub", service: "Api" }, { kind: "null" }] }, {}))
      .toEqual(["value: expected a capability | null"]);
    expect(check({ kind: "union", branches: [{ kind: "stub", service: "Api" }, { kind: "null" }] }, null)).toEqual([]);
  });
});

describe("arity", () => {
  const schema = schemaOf({ kind: "void" }, [param("id", { kind: "string" }), param("limit", { kind: "number" }, true)]);
  const call = (...args: unknown[]) => checkArguments(schema, "Api", "call", args);

  test("a missing required argument, an optional one left out, and one too many", () => {
    expect(call("a")).toEqual([]);
    expect(call("a", 1)).toEqual([]);
    expect(call("a", undefined)).toEqual([]);
    expect(call()).toEqual(["id: expected string"]);
    expect(call(undefined, "1")).toEqual(["id: expected string", "limit: expected number"]);
    expect(call("a", 1, true)).toEqual(["argument 3: expected none, as Api.call takes 2"]);
    expect(call("a", 1, true, undefined, null))
      .toEqual(["argument 3: expected none, as Api.call takes 2", "argument 5: expected none, as Api.call takes 2"]);
    // A trailing undefined is an argument left out.
    expect(call("a", 1, undefined)).toEqual([]);
  });

  test("a required parameter whose shape takes undefined may be left out", () => {
    const optionalShape = schemaOf({ kind: "void" }, [param("note", orUndefined({ kind: "string" }))]);
    expect(checkArguments(optionalShape, "Api", "call", [])).toEqual([]);
    expect(checkArguments(optionalShape, "Api", "call", [1])).toEqual(["note: expected string"]);
  });
});

describe("bounds", () => {
  test("recursion stops at depth 64", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 100; i++) deep = (deep.child = {}) as Record<string, unknown>;
    const problems = check({ kind: "ref", name: "Chain" }, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^value(\.child)+: nested more than 64 levels deep$/);
    // A value that holds itself ends the same way.
    const cycle: Record<string, unknown> = {};
    cycle.child = cycle;
    expect(check({ kind: "ref", name: "Chain" }, cycle)).toEqual([expect.stringMatching(/nested more than 64 levels deep$/)]);
    // Shallow enough is checked in full.
    expect(check({ kind: "ref", name: "Chain" }, { child: { child: {} } })).toEqual([]);
    expect(check({ kind: "ref", name: "Chain" }, { child: { child: { child: 1 } } })).toEqual(["value.child.child.child: expected object"]);
  });

  test("a value nested under unions whose branches all recurse is checked once", () => {
    // Every node is of the last kind, so each union tries every branch, each of which holds the
    // nodes below: five to the power of the depth checks, were a node checked once per branch.
    // Such a check would not return, so a node counts the reads of its kind, one for each branch
    // that tries it, and throws past one per branch for every node the check reaches.
    let reads = 0;
    let most = 0;
    const node = (kind: string, children: unknown[]) => ({
      children,
      get kind() {
        if (++reads > most) throw new Error(`a node's kind was read more than ${most} times in all`);
        return kind;
      },
    });
    const tree = (depth: number, leaf: string): unknown =>
      depth === 0 ? node(leaf, []) : node("e", [tree(depth - 1, leaf)]);
    /** The problems with `value` as a Tree of which the check reaches `nodes` nodes at most. */
    const checkTree = (value: unknown, nodes: number) => {
      reads = 0;
      most = TREE_KINDS.length * nodes;
      return check({ kind: "ref", name: "Tree" }, value);
    };
    expect(checkTree(tree(15, "e"), 16)).toEqual([]);
    expect(checkTree(tree(15, "z"), 16)).toEqual(["value: expected Tree"]);
    // A value that holds itself, too, which is followed 64 levels at most.
    const cycle = node("e", []);
    cycle.children.push(cycle);
    expect(checkTree(cycle, 64)).toEqual(["value: expected Tree"]);
  });

  test("what a union tried is kept no longer than the outermost union above it", () => {
    // Only a schema written by hand brings one union to one path twice in a call, with two
    // parameters of one name. Each argument is still checked afresh: neither the fit nor the
    // refusal of the union inside the first's is taken for the second's.
    const destination = orUndefined({ kind: "ref", name: "Destination" });
    const twice = schemaOf({ kind: "void" }, [param("value", destination), param("value", destination)]);
    expect(checkArguments(twice, "Api", "call", [{ kind: "inbox" }, { kind: "outbox" }]))
      .toEqual(["value: expected Destination"]);
    expect(checkArguments(twice, "Api", "call", [{ kind: "outbox" }, { kind: "inbox" }]))
      .toEqual(["value: expected Destination"]);
  });

  test(`reports at most ${MAX_ARGUMENT_PROBLEMS} problems`, () => {
    expect(MAX_ARGUMENT_PROBLEMS).toBe(10);
    const numbers = Array.from({ length: 50 }, (_, i) => i);
    const problems = check({ kind: "array", element: { kind: "string" } }, numbers);
    expect(problems).toHaveLength(MAX_ARGUMENT_PROBLEMS);
    expect(problems[MAX_ARGUMENT_PROBLEMS - 1]).toBe(`value[${MAX_ARGUMENT_PROBLEMS - 1}]: expected string`);
    // Across arguments, and counting the ones too many.
    const two = schemaOf({ kind: "void" }, [param("first", { kind: "array", element: { kind: "string" } })]);
    expect(checkArguments(two, "Api", "call", [numbers.slice(0, 9), 1, 2])).toEqual([
      ...numbers.slice(0, 9).map((i) => `first[${i}]: expected string`),
      "argument 2: expected none, as Api.call takes 1",
    ]);
    // Inside the one branch of a union that is reported, too.
    expect(check(orUndefined({ kind: "array", element: { kind: "string" } }), numbers)).toHaveLength(MAX_ARGUMENT_PROBLEMS);
  });
});

test("throws on a service, method or shape the schema lacks", () => {
  expect(() => checkArguments(schemaOf({ kind: "void" }), "Nope", "call", [])).toThrow("no service Nope in the schema");
  expect(() => checkArguments(schemaOf({ kind: "void" }), "toString", "call", [])).toThrow("no service toString in the schema");
  expect(() => checkArguments(schemaOf({ kind: "void" }), "Api", "nope", [])).toThrow("no method nope on service Api");
  expect(() => check({ kind: "ref", name: "Gone" }, 1)).toThrow("no shape Gone in the schema");
  expect(() => check({ kind: "ref", name: "constructor" }, 1)).toThrow("no shape constructor in the schema");
});
