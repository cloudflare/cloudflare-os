// The declaration emitter, on small hand-built schemas, and on this repository's own
// `workshop-shared/src/api.ts`, whose generated declarations are type-checked against the real API
// as a caller holds it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript6";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AWAITABLE, emitDeclarations, PIPELINED, UNTYPED_STUB } from "../src/emit/dts.ts";
import { extractSchema } from "../src/extract.ts";
import { type ApiShape, FORMAT, type Schema, type SchemaMethod, type SchemaService, type SchemaShape } from "../src/schema.ts";

/**
 * A schema of `services` (doc and methods defaulting to none, direction to the server's: the
 * emitter reads its own positions from the root) and `shapes`.
 */
function schemaOf(services: Record<string, Partial<SchemaService>>,
  shapes: Record<string, SchemaShape> = {}, entry = Object.keys(services)[0]!): Schema {
  return {
    format: FORMAT,
    entry,
    constants: {},
    services: Object.fromEntries(Object.entries(services).map(([name, service]) =>
      [name, { doc: "", direction: "server", methods: [], ...service }])),
    shapes,
  };
}

function method(name: string, returns: ApiShape, params: SchemaMethod["params"] = [], doc = ""): SchemaMethod {
  return { name, doc, params, returns };
}

/** The names `text` declares at its top level. */
function declared(text: string): string[] {
  return [...text.matchAll(/^export (?:interface|type) ([^\s=<]+)/gm)].map((match) => match[1]!).toSorted();
}

/** Library files, parsed once for every in-memory program. */
const parsedLibs = new Map<string, ts.SourceFile | undefined>();

/**
 * Type-checks in-memory files (`.d.ts`, or `.ts` that imports them as `./name.js`, and `capnweb`),
 * fully (`skipLibCheck` off), under the Web platform's globals, and returns every diagnostic in
 * them, with the file's name. Only they are checked: capnweb's own declarations do not pass a full
 * check.
 */
function diagnose(files: Record<string, string>): { file: string; code: number; text: string }[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: [],
    skipDefaultLibCheck: true,
    paths: { capnweb: [join(import.meta.dirname, "..", "node_modules", "capnweb", "dist", "index.d.ts")] },
  };
  const paths = Object.fromEntries(Object.entries(files).map(([name, text]) => [`/virtual/${name}`, text]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile, directoryExists } = host;
  host.getSourceFile = (name, language, ...rest) => {
    if (name in paths) return ts.createSourceFile(name, paths[name]!, language);
    if (!parsedLibs.has(name)) parsedLibs.set(name, getSourceFile.call(host, name, language, ...rest));
    return parsedLibs.get(name);
  };
  host.fileExists = (name) => name in paths || fileExists.call(host, name);
  host.readFile = (name) => paths[name] ?? readFile.call(host, name);
  host.directoryExists = (name) => name === "/virtual" || (directoryExists?.call(host, name) ?? true);
  const program = ts.createProgram({ rootNames: Object.keys(paths), options, host });
  const sources = Object.keys(paths).map((name) => program.getSourceFile(name)!);
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...sources.flatMap((source) => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]),
  ].map((diagnostic) => ({
    file: diagnostic.file?.fileName.replace("/virtual/", "") ?? "",
    code: diagnostic.code,
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

describe("shapes", () => {
  const object: ApiShape = {
    kind: "object",
    properties: {
      "content-type": { kind: "string" },
      count: { kind: "union", branches: [{ kind: "number" }, { kind: "undefined" }] },
      gone: { kind: "undefined" },
      nested: { kind: "object", properties: { deep: { kind: "boolean" } } },
    },
  };
  const cases: [ApiShape, string][] = [
    [{ kind: "string" }, "string"],
    [{ kind: "number" }, "number"],
    [{ kind: "boolean" }, "boolean"],
    [{ kind: "bigint" }, "bigint"],
    [{ kind: "null" }, "null"],
    [{ kind: "undefined" }, "undefined"],
    [{ kind: "void" }, "void"],
    [{ kind: "any" }, "unknown"],
    [{ kind: "literal", value: 'say "hi"' }, '"say \\"hi\\""'],
    [{ kind: "literal", value: 3 }, "3"],
    [{ kind: "literal", value: false }, "false"],
    [{ kind: "array", element: { kind: "literal", value: -1 } }, "(-1)[]"],
    [{ kind: "array", element: { kind: "union", branches: [{ kind: "null" }, { kind: "string" }] } }, "(null | string)[]"],
    [{ kind: "array", element: { kind: "array", element: { kind: "number" } } }, "number[][]"],
    [{ kind: "set", element: { kind: "string" } }, "Set<string>"],
    [{ kind: "map", key: { kind: "string" }, value: { kind: "ref", name: "Item" } }, "Map<string, Item>"],
    [{ kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }] }, "[string, number]"],
    [{
      kind: "tuple",
      elements: [{ kind: "string" }, { kind: "union", branches: [{ kind: "boolean" }, { kind: "number" }] }],
      minLength: 1,
      rest: { kind: "union", branches: [{ kind: "null" }, { kind: "string" }] },
    }, "[string, (boolean | number)?, ...(null | string)[]]"],
    [{ kind: "tuple", elements: [] }, "[]"],
    [{ kind: "object", properties: {} }, "{}"],
    [object, '{\n    "content-type": string;\n    count?: number;\n    gone?: undefined;\n    nested: {\n      deep: boolean;\n    };\n  }'],
    [{ kind: "object", properties: {}, index: { kind: "number" } }, "{\n    [key: string]: number;\n  }"],
    [{
      kind: "object",
      properties: { name: { kind: "union", branches: [{ kind: "string" }, { kind: "undefined" }] } },
      index: { kind: "number" },
    }, "{\n    name?: string;\n    [key: string]: number | string | undefined;\n  }"],
    [{ kind: "union", branches: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }] }, '"a" | "b"'],
    [{ kind: "ref", name: "Item" }, "Item"],
    [{ kind: "date" }, "Date"],
    [{ kind: "bytes" }, "Uint8Array"],
    [{ kind: "error" }, "Error"],
    [{ kind: "readableStream" }, "ReadableStream"],
    [{ kind: "writableStream" }, "WritableStream"],
    [{ kind: "readableStream", element: { kind: "bytes" } }, "ReadableStream<Uint8Array>"],
    [{ kind: "writableStream", element: { kind: "ref", name: "Item" } }, "WritableStream<Item>"],
    [{ kind: "arrayBuffer" }, "ArrayBuffer"],
    [{ kind: "dataView" }, "DataView"],
    [{ kind: "regexp" }, "RegExp"],
    [{ kind: "blob" }, "Blob"],
    [{ kind: "url" }, "URL"],
    [{ kind: "headers" }, "Headers"],
    [{ kind: "request" }, "Request"],
    [{ kind: "response" }, "Response"],
    [{ kind: "typedArray", name: "Float64Array" }, "Float64Array"],
    [{ kind: "typedArray", name: "Float16Array" }, "unknown /* Float16Array */"],
    [{ kind: "stub", service: "Other" }, "Other"],
    [{ kind: "stub" }, UNTYPED_STUB],
    [{
      kind: "function",
      params: [{ name: "a", type: { kind: "string" }, optional: false },
        { name: "b", type: { kind: "number" }, optional: true }],
      returns: { kind: "void" },
    }, "(a: Awaitable<string>, b?: Awaitable<number>) => Promise<void>"],
    [{
      kind: "union",
      branches: [{ kind: "function", params: [], returns: { kind: "string" } }, { kind: "null" }],
    }, "(() => Promise<string>) | null"],
    [{ kind: "unsupported", reason: "a */ comment\nacross lines" }, "unknown /* a *\\/ comment across lines */"],
  ];
  const schema = schemaOf({
    Api: { methods: cases.map(([shape], i) => method(`m${String(i).padStart(2, "0")}`, shape)) },
    Other: { methods: [method("ping", { kind: "void" })] },
  }, { Item: { kind: "object", properties: { id: { kind: "number" } } } });
  const { full } = emitDeclarations(schema, { root: "Api" });

  // A method returning a capability returns it pipelined, every other a promise.
  test.each(cases.map(([shape, expected], i) => [shape.kind, i, expected, shape] as const))(
    "%s (m%i) renders as its TypeScript type", (_kind, i, expected, shape) => {
      const result = shape.kind === "stub" && shape.service ? `${PIPELINED}<${expected}>` : `Promise<${expected}>`;
      expect(full).toContain(`  m${String(i).padStart(2, "0")}(): ${result};\n`);
    });

  test("declares every referenced name, the helper aliases included, and type-checks", () => {
    expect(declared(full)).toEqual(["Api", AWAITABLE, "Item", "Other", PIPELINED, UNTYPED_STUB]);
    expect(full).toContain(`export type ${UNTYPED_STUB} = unknown;`);
    expect(diagnose({ "api.d.ts": full })).toEqual([]);
  });

  test("an untyped stub's alias is declared only where one is reached", () => {
    const { full: none } = emitDeclarations(schemaOf({ Api: { methods: [method("a", { kind: "string" })] } }),
      { root: "Api" });
    expect(none).not.toContain(UNTYPED_STUB);
  });
});

describe("a whole file", () => {
  const schema = schemaOf({
    Root: {
      doc: "The root.",
      methods: [
        method("open", { kind: "stub", service: "Child" }, [
          { name: "id", type: { kind: "string" }, optional: false, doc: "The child's ID." },
          { name: "mode", type: { kind: "ref", name: "Mode" }, optional: true, doc: "How to open it." },
          { name: "since", type: { kind: "date" }, optional: false, doc: "" },
          { name: "onClose", type: { kind: "function", params: [], returns: { kind: "void" } }, optional: true, doc: "" },
          { name: "last", type: { kind: "boolean" }, optional: false, doc: "" },
        ], "Opens a child.\n\n    indented, as a code block\n@param id The child's ID."),
        method("subscribe", { kind: "stub", service: "Handle" }, [
          { name: "subscriber", type: { kind: "stub", service: "Subscriber" }, optional: false, doc: "" },
        ]),
      ],
    },
    Child: { methods: [method("note", { kind: "ref", name: "Note" })] },
    Handle: {},
    Subscriber: { doc: "Implemented by the caller.", methods: [method("changed", { kind: "void" })] },
  }, {
    Mode: { kind: "union", branches: [{ kind: "literal", value: "read" }, { kind: "literal", value: "write" }] },
    Note: {
      kind: "object",
      properties: { body: { kind: "string" }, children: { kind: "array", element: { kind: "ref", name: "Note" } } },
    },
  });

  test("is the header, the root, then every other declaration by name", () => {
    const { full } = emitDeclarations(schema, { root: "Root", header: "Generated from a schema.\n\nDo not edit." });
    expect(full).toBe(`// Generated from a schema.
//
// Do not edit.

/** The root. */
export interface Root {
  /**
   * Opens a child.
   *
   *     indented, as a code block
   * @param id The child's ID.
   * @param mode How to open it.
   */
  open(id: Awaitable<string>, mode: Awaitable<Mode> | undefined, since: Awaitable<Date>, onClose: (() => Awaitable<void>) | undefined, last: Awaitable<boolean>): Pipelined<Child>;
  subscribe(subscriber: Subscriber): Pipelined<Handle>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

export interface Child {
  note(): Promise<Note>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

export interface Handle {
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/** Implemented by the caller. */
export interface Subscriber {
  changed(): Awaitable<void>;
}

export type Mode = "read" | "write";

export type Note = {
  body: string;
  children: Note[];
};

/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, \`root.set(root.get())\`. And what a function or a method the caller
 * implements may return: its result as is, or from an \`async\` function.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * What a call returning a capability returns: a promise of the capability, whose methods can be
 * called before it resolves (promise pipelining): \`root.open(id).list()\` sends both calls at
 * once, the second to whatever the first returns. Disposing it disposes the capability.
 */
export type Pipelined<T> = Promise<T> & T;
`);
    expect(diagnose({ "api.d.ts": full })).toEqual([]);
  });

  test("has no header unless given one", () => {
    expect(emitDeclarations(schema, { root: "Root" }).full).toMatch(/^\/\*\* The root\. \*\/\nexport interface Root/);
  });

  test("is the same for the same schema, however its keys are ordered", () => {
    const reversed: Schema = {
      ...schema,
      services: Object.fromEntries(Object.entries(schema.services).toReversed()),
      shapes: Object.fromEntries(Object.entries(schema.shapes).toReversed()),
    };
    expect(emitDeclarations(reversed, { root: "Root" })).toEqual(emitDeclarations(schema, { root: "Root" }));
  });

  test("refuses a root, a service or a shape the schema does not have", () => {
    expect(() => emitDeclarations(schema, { root: "Nowhere" })).toThrow("no service Nowhere");
    const dangling = schemaOf({ Api: { methods: [method("a", { kind: "ref", name: "Missing" })] } });
    expect(() => emitDeclarations(dangling, { root: "Api" })).toThrow("no shape Missing");
  });
});

describe("omit", () => {
  const schema = schemaOf({
    Public: {
      methods: [
        method("authenticate", { kind: "stub", service: "Authed" }),
        method("login", { kind: "ref", name: "Session" }, [
          { name: "password", type: { kind: "ref", name: "Secret" }, optional: false, doc: "" },
        ]),
        method("ping", { kind: "void" }),
        method("status", { kind: "string" }),
      ],
    },
    Authed: { methods: [method("whoami", { kind: "string" })] },
  }, { Secret: { kind: "object", properties: {} }, Session: { kind: "object", properties: { token: { kind: "string" } } } });

  test("drops the methods named, on every service, and whatever only they reach", () => {
    const { full, fragments } = emitDeclarations(schema, { root: "Public", omit: ["authenticate", "login"] });
    expect(full).not.toMatch(/authenticate|login|Authed|Secret|Session/);
    expect(declared(full)).toEqual(["Public"]);
    expect(Object.keys(fragments)).toEqual(["Public"]);
  });

  test("drops `Service.method` on that service only", () => {
    const { full } = emitDeclarations(schema, { root: "Public", omit: ["Public.status", "Authed.status"] });
    expect(full).not.toContain("status");
    expect(full).toContain("whoami");
  });
});

describe("names", () => {
  const schema = schemaOf({
    Api: {
      methods: [
        method("delete", { kind: "ref", name: "Foo<Bar>" }, [
          { name: "class", type: { kind: "ref", name: "Foo_Bar" }, optional: false, doc: "A reserved word." },
          { name: "#2", type: { kind: "ref", name: "Name#2" }, optional: false, doc: "" },
        ]),
        method("kebab-case", { kind: "stub", service: "{}" }),
        method("shadow", { kind: "ref", name: "Promise" }),
        method("helper", { kind: "ref", name: "Pipelined" }),
        method("awaitable", { kind: "ref", name: "Awaitable" }),
        method("generic", { kind: "ref", name: "Map<string, Foo<Bar>[]>" }),
        method("operator", { kind: "ref", name: "keyof" }, [
          { name: "x", type: { kind: "ref", name: "Ünicode" }, optional: false, doc: "" },
        ]),
        method("new", { kind: "object", properties: { new: { kind: "string" } } }, [
          { name: "new", type: { kind: "string" }, optional: false, doc: "" },
        ]),
      ],
    },
    "{}": {},
  }, {
    "Foo<Bar>": { kind: "object", properties: { "x-y": { kind: "string" }, ok: { kind: "number" } } },
    Foo_Bar: { kind: "literal", value: "taken first" },
    "Name#2": { kind: "string" },
    Promise: { kind: "object", properties: { resolved: { kind: "string" } } },
    Pipelined: { kind: "string" },
    Awaitable: { kind: "number" },
    "Map<string, Foo<Bar>[]>": { kind: "string" },
    keyof: { kind: "string" },
    Ünicode: { kind: "string" },
  });
  const { full } = emitDeclarations(schema, { root: "Api" });

  test("rewrites the ones that are not identifiers, shadow a global or are type operators, without collisions", () => {
    // A valid name keeps itself, a Unicode one included; a rewritten one takes the next free suffix.
    expect(declared(full)).toEqual(["Api", AWAITABLE, "Awaitable_2", "Empty", "Foo_Bar", "Foo_Bar_2",
      "Map_string_Foo_Bar_Array", "Name_2", PIPELINED, "Pipelined_2", "Promise_2", "keyof_2", "Ünicode"]);
    expect(full).toContain("operator(x: Awaitable<Ünicode>): Promise<keyof_2>;");
    expect(full).toContain("export type Foo_Bar = \"taken first\";");
    expect(full).toContain("delete(_class: Awaitable<Foo_Bar>, _2: Awaitable<Name_2>): Promise<Foo_Bar_2>;");
    expect(full).toContain("  /** @param _class A reserved word. */\n");
    expect(full).toContain("shadow(): Promise<Promise_2>;");
    expect(full).toContain(`"kebab-case"(): ${PIPELINED}<Empty>;`);
    expect(full).toContain("helper(): Promise<Pipelined_2>;");
    expect(full).toContain("awaitable(): Promise<Awaitable_2>;");
    expect(full).toContain("  \"x-y\": string;\n");
    // Unquoted in an interface, `new(...)` would declare a construct signature instead.
    expect(full).toContain("\"new\"(_new: Awaitable<string>): Promise<{\n    new: string;\n  }>;");
    expect(diagnose({
      "api.d.ts": full,
      "caller.ts": `import type { Api } from "./api.js";
declare const api: Api;
export const created: string = (await api.new("x")).new;`,
    })).toEqual([]);
  });

  test("are the same in every fragment", () => {
    const { fragments } = emitDeclarations(schema, { root: "Api" });
    expect(Object.keys(fragments)).toEqual(["Api", "Empty"]);
    expect(fragments.Api).toContain("delete(_class: Awaitable<Foo_Bar>, _2: Awaitable<Name_2>): Promise<Foo_Bar_2>;");
  });
});

// A `*/` in a doc or reason, or a line terminator in the header, would turn the rest into declarations.
test("escapes a `*/` in any doc or reason, and a line terminator in the header", () => {
  const schema = schemaOf({
    Api: {
      doc: "Service */ export interface Leaked1 {}",
      methods: [method("a", { kind: "unsupported", reason: "why */ export interface Leaked2 {}" }, [
        { name: "x", type: { kind: "string" }, optional: false, doc: "param */ export interface Leaked3 {}" },
      ], "Method */\nexport interface Leaked4 {}"), method("b", { kind: "ref", name: "Item" })],
    },
  }, {
    Item: {
      doc: "Shape */ export interface Leaked8 {}",
      kind: "object",
      properties: { x: { kind: "string" } },
      propertyDocs: { x: { doc: "Property */ export interface Leaked9 {}" } },
    },
  });
  const { full } = emitDeclarations(schema, {
    root: "Api",
    header: "header */ export interface Leaked5 {}\u2028export interface Leaked6 {}\u2029export interface Leaked7 {}",
  });
  expect(full).toMatch(/^\/\/ header \*\/ export interface Leaked5 \{\}\n\/\/ export interface Leaked6 \{\}\n\/\/ /);
  expect(full).toContain("/** Service *\\/ export interface Leaked1 {} */");
  expect(full).toContain("   * @param x param *\\/ export interface Leaked3 {}\n");
  expect(full).toContain("/** Shape *\\/ export interface Leaked8 {} */\n");
  expect(full).toContain("  /** Property *\\/ export interface Leaked9 {} */\n");
  expect(declared(full)).toEqual(["Api", AWAITABLE, "Item"]);
  expect(diagnose({ "api.d.ts": full })).toEqual([]);
});

describe("functions", () => {
  // `subscribe` takes a callback the caller writes, whose own argument is a function the caller
  // calls; `unsubscriber` returns a function the caller calls; `Handlers` is reached both ways.
  const callback: ApiShape = {
    kind: "function",
    params: [
      { name: "meta", type: { kind: "ref", name: "Meta" }, optional: false },
      { name: "reply", type: { kind: "function", params: [], returns: { kind: "boolean" } }, optional: false },
    ],
    returns: { kind: "void" },
  };
  const handlers: ApiShape = {
    kind: "object",
    properties: { onEvent: { kind: "function", params: [], returns: { kind: "string" } } },
  };
  const schema = schemaOf({
    Api: {
      methods: [
        method("handlers", { kind: "ref", name: "Handlers" }, [
          { name: "handlers", type: { kind: "ref", name: "Handlers" }, optional: false, doc: "" },
        ]),
        method("subscribe", { kind: "void" }, [{ name: "callback", type: callback, optional: false, doc: "" }]),
        method("unsubscriber", { kind: "function", params: [], returns: { kind: "void" } }),
      ],
    },
  }, { Handlers: handlers, Meta: { kind: "object", properties: { id: { kind: "string" } } } });
  const { full, fragments } = emitDeclarations(schema, { root: "Api" });

  test("one the caller writes may return its result as is, one it calls returns a promise", () => {
    expect(full).toContain(
      "subscribe(callback: (meta: Meta, reply: () => Promise<boolean>) => Awaitable<void>): Promise<void>;");
    expect(full).toContain("unsubscriber(): Promise<() => Promise<void>>;");
    expect(full).toContain("handlers(handlers: Awaitable<Handlers>): Promise<Handlers>;");
    expect(full).toContain("export type Handlers = {\n  onEvent: () => Awaitable<string>;\n};");
    expect(fragments.Api).toBe(full);
  });

  test("a synchronous callback type-checks, and so does awaiting what a returned function returns", () => {
    expect(diagnose({
      "api.d.ts": full,
      "caller.ts": `import type { Api } from "./api.js";
declare const api: Api;
void api.subscribe((meta) => {
  const id: string = meta.id;
  void id;
});
void api.subscribe(async (_meta, reply) => {
  const ok: boolean = await reply();
  void ok;
});
void api.handlers({ onEvent: () => "sync" });
export async function call(): Promise<string> {
  const unsubscribe = await api.unsubscriber();
  const done: Promise<void> = unsubscribe();
  await done;
  return await (await api.handlers({ onEvent: async () => "async" })).onEvent();
}
`,
    })).toEqual([]);
  });
});

/** A function of no parameters. */
function fn(returns: ApiShape): ApiShape {
  return { kind: "function", params: [], returns };
}

describe("held and implemented services", () => {
  // `Api` is held, and takes a value `rename` can be given a promise of; `Child` is returned (held);
  // `Sub` is passed in (implemented by the caller), and itself returns a function and takes one;
  // `Both` is returned and passed in.
  const schema = schemaOf({
    Api: {
      methods: [
        method("both", { kind: "stub", service: "Both" }, [
          { name: "both", type: { kind: "stub", service: "Both" }, optional: false, doc: "" },
        ]),
        method("child", { kind: "stub", service: "Child" }),
        method("factory", fn({ kind: "stub", service: "Child" })),
        method("rename", { kind: "void" }, [{ name: "name", type: { kind: "string" }, optional: false, doc: "" }]),
        method("subscribe", { kind: "stub", service: "Child" }, [
          { name: "sub", type: { kind: "stub", service: "Sub" }, optional: false, doc: "" },
        ]),
      ],
    },
    Both: { methods: [method("ping", { kind: "string" })] },
    Child: { methods: [method("name", { kind: "string" })] },
    Sub: {
      methods: [method("handlerFor", fn({ kind: "string" }), [
        { name: "lookup", type: fn({ kind: "string" }), optional: false, doc: "" },
      ])],
    },
  });
  const { full } = emitDeclarations(schema, { root: "Api" });
  const declaration = (name: string) => full.split("\n\n").find((part) => part.includes(`export interface ${name} `))!;

  test("a held service disposes, and pipelines a returned capability", () => {
    expect(declaration("Api")).toContain("  child(): Pipelined<Child>;\n");
    expect(declaration("Api")).toContain("  factory(): Promise<() => Pipelined<Child>>;\n");
    expect(declaration("Api")).toContain("  rename(name: Awaitable<string>): Promise<void>;\n");
    expect(declaration("Api")).toContain("  [Symbol.dispose](): void;\n");
    expect(declaration("Child")).toContain("  [Symbol.dispose](): void;\n");
  });

  test("a service the caller implements has no dispose, and its directions are reversed", () => {
    expect(declaration("Sub")).not.toContain("Symbol.dispose");
    expect(declaration("Sub")).toContain(
      "  handlerFor(lookup: () => Promise<string>): Awaitable<() => Awaitable<string>>;\n");
  });

  test("a service reached both ways may be disposed", () => {
    expect(declaration("Both")).toContain("  [Symbol.dispose]?(): void;\n");
    expect(declaration("Both")).toContain("  ping(): Awaitable<string>;\n");
  });

  // An implementation's methods return their results as written, synchronous or `async`, and a
  // call's result is passed on to the next call unawaited.
  test("a caller using each, and implementing those it passes in, type-checks", () => {
    expect(diagnose({
      "api.d.ts": full,
      "caller.ts": `import type { Api, Both, Sub } from "./api.js";
declare const api: Api;
class Subscriber implements Sub {
  async handlerFor(lookup: () => Promise<string>) {
    const found: string = await lookup();
    return () => found;
  }
}
class SyncSubscriber implements Sub {
  handlerFor(_lookup: () => Promise<string>) {
    return () => "now";
  }
}
class Implemented implements Both {
  async ping() {
    return "pong";
  }
}
class SyncImplemented implements Both {
  ping() {
    return "pong";
  }
}
export async function use(): Promise<string> {
  using subscription = await api.subscribe(new Subscriber());
  void subscription;
  (await api.subscribe(new SyncSubscriber()))[Symbol.dispose]();
  using child = api.child();
  const made = await api.factory();
  const name: string = await made().name();
  (await api.both(new Implemented()))[Symbol.dispose]?.();
  const pong: string = await (await api.both(new SyncImplemented())).ping();
  await api.rename(child.name());
  await api.rename("plain");
  return name + pong + await child.name() + await api.child().name();
}
`,
    })).toEqual([]);
  });
});

describe("streams", () => {
  // A readable stream's chunks travel as the stream does, a writable one's the other way.
  const schema = schemaOf({
    Api: {
      methods: [
        method("read", { kind: "readableStream", element: fn({ kind: "string" }) }),
        method("upload", { kind: "void" }, [
          { name: "source", type: { kind: "readableStream", element: { kind: "ref", name: "Chunk" } }, optional: false,
            doc: "" },
          { name: "sink", type: { kind: "writableStream", element: fn({ kind: "string" }) }, optional: false, doc: "" },
        ]),
        method("write", { kind: "writableStream", element: fn({ kind: "string" }) }),
      ],
    },
  }, { Chunk: { kind: "object", properties: { data: { kind: "bytes" } } } });
  const { full } = emitDeclarations(schema, { root: "Api" });

  test("carry their element type, in the position its values travel, and reach the shapes in it", () => {
    expect(full).toContain("  read(): Promise<ReadableStream<() => Promise<string>>>;\n");
    expect(full).toContain("  write(): Promise<WritableStream<() => Awaitable<string>>>;\n");
    expect(full).toContain("  upload(source: Awaitable<ReadableStream<Chunk>>, "
      + "sink: Awaitable<WritableStream<() => Promise<string>>>): Promise<void>;\n");
    expect(declared(full)).toEqual(["Api", AWAITABLE, "Chunk"]);
    expect(diagnose({ "api.d.ts": full })).toEqual([]);
  });
});

describe("properties", () => {
  // `Api` is held, and `Sub`, which has properties of its own, is implemented by the caller.
  const schema = schemaOf({
    Api: {
      properties: [
        { name: "build", doc: "An optional property.\n@deprecated Read version.", type: { kind: "number" }, optional: true,
          deprecated: "Read version." },
        { name: "child", doc: "", type: { kind: "stub", service: "Child" }, optional: false },
        { name: "meta", doc: "", type: { kind: "ref", name: "Meta" }, optional: false },
        { name: "spare", doc: "", type: { kind: "stub", service: "Child" }, optional: true },
        { name: "version", doc: "The version.", type: { kind: "string" }, optional: false },
      ],
      methods: [
        method("subscribe", { kind: "void" }, [
          { name: "sub", type: { kind: "stub", service: "Sub" }, optional: false, doc: "" },
        ]),
      ],
    },
    Child: { methods: [method("name", { kind: "string" })] },
    Sub: {
      properties: [
        { name: "id", doc: "", type: { kind: "number" }, optional: false },
        { name: "label", doc: "", type: { kind: "string" }, optional: true },
      ],
      methods: [method("changed", { kind: "void" })],
    },
  }, { Meta: { kind: "object", properties: { tag: { kind: "string" } } } });
  const { full, fragments } = emitDeclarations(schema, { root: "Api" });

  test("a held service's are read as a call's result, there whether or not optional, before its methods", () => {
    expect(full).toContain(`export interface Api {
  /**
   * An optional property.
   * @deprecated Read version.
   */
  readonly build: Promise<number | undefined>;
  readonly child: Pipelined<Child>;
  readonly meta: Promise<Meta>;
  readonly spare: Promise<Child | undefined>;
  /** The version. */
  readonly version: Promise<string>;
  subscribe(sub: Sub): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}
`);
  });

  test("an implemented service's are the values themselves, an optional one may be left out", () => {
    expect(full).toContain(`export interface Sub {
  readonly id: number;
  readonly label?: string;
  changed(): Awaitable<void>;
}
`);
  });

  test("reach the shapes and services in their types, in the full file and the fragments", () => {
    expect(declared(full)).toEqual(["Api", AWAITABLE, "Child", "Meta", PIPELINED, "Sub"]);
    expect(declared(fragments.Api!)).toEqual(["Api", "Meta", PIPELINED]);
    expect(missingNames(fragments)).toEqual({ Api: ["Child", "Child", "Sub"], Child: [], Sub: [] });
  });

  test("one reached both ways is an Awaitable, which a caller reading it awaits", () => {
    const both = schemaOf({
      Api: {
        methods: [method("swap", { kind: "stub", service: "Both" }, [
          { name: "both", type: { kind: "stub", service: "Both" }, optional: false, doc: "" },
        ])],
      },
      Both: { properties: [{ name: "tag", doc: "", type: { kind: "string" }, optional: true }] },
    });
    const declarations = emitDeclarations(both, { root: "Api" }).full;
    expect(declarations).toContain(`export interface Both {
  readonly tag?: Awaitable<string | undefined>;
  /** Disposes of this stub, releasing the capability it holds. Absent on an implementation. */
  [Symbol.dispose]?(): void;
}
`);
    expect(diagnose({
      "api.d.ts": declarations,
      "caller.ts": `import type { RpcStub, RpcTarget } from "capnweb";
import type * as Generated from "./api.js";
interface Both extends RpcTarget {
  tag?: string;
}
interface Api extends RpcTarget {
  swap(both: RpcStub<Both>): Promise<RpcStub<Both>>;
}
declare const held: RpcStub<Api>;
declare const both: RpcStub<Both>;
export const generated: Generated.Both = both;
export async function swapped(): Promise<Generated.Both> {
  return await held.swap(both);
}
export const implemented: Generated.Both = { tag: "x" };
export async function read(b: Generated.Both): Promise<string | undefined> {
  return await b.tag;
}
`,
    })).toEqual([]);
  });

  // capnweb types reading a property of a stub as an `RpcPromise` of its value, which pipelines, and
  // takes an implementation's property as the value itself, read from a getter.
  test("capnweb's RpcStub of the interface they come from is assignable to the declaration, and pipelines", () => {
    expect(diagnose({
      "api.d.ts": full,
      "caller.ts": `import type { RpcStub, RpcTarget } from "capnweb";
import type * as Generated from "./api.js";
interface Child extends RpcTarget {
  name(): Promise<string>;
}
interface Sub {
  readonly id: number;
  label?: string;
  changed(): void;
}
interface Api extends RpcTarget {
  build?: number;
  readonly child: Child;
  readonly meta: { tag: string };
  spare?: Child;
  readonly version: string;
  subscribe(sub: Sub): Promise<void>;
}
declare const held: RpcStub<Api>;
export const generated: Generated.Api = held;
class Implemented implements Generated.Sub {
  get id() {
    return 1;
  }
  changed() {}
}
export async function use(api: Generated.Api): Promise<string> {
  await api.subscribe(new Implemented());
  const build: number | undefined = await api.build;
  const spare: Generated.Child | undefined = await api.spare;
  return (await api.child.name()) + (await api.version) + (await api.meta).tag + String(build) + String(spare);
}
`,
    })).toEqual([]);
  });
});

describe("tags", () => {
  const params: SchemaMethod["params"] = [{ name: "x", type: { kind: "string" }, optional: false, doc: "The x." }];
  const schema = schemaOf({
    Api: {
      deprecated: "",
      methods: [
        { ...method("both", { kind: "void" }, params), deprecated: "", mutates: true },
        { ...method("gone", { kind: "void" }), deprecated: "Removed soon." },
        { ...method("old", { kind: "void" }, [], "Old.\n@deprecated Use new."), deprecated: "Use new." },
        { ...method("other", { kind: "stub", service: "Other" }) },
        { ...method("save", { kind: "void" }, [], "Saves."), mutates: true },
        { ...method("since", { kind: "void" }, [], "New.\n@since 2"), tags: { beta: "", since: "2" } },
        { ...method("tagged", { kind: "void" }, [], "Writes.\n\n@mutates"), mutates: true },
      ],
      properties: [{ name: "version", doc: "", type: { kind: "string" }, optional: false, tags: { since: "1" } }],
    },
    Other: {
      doc: "Kept.\n@deprecated", deprecated: "", tags: { audience: "agents" },
      methods: [method("entry", { kind: "ref", name: "Entry" })],
    },
  }, {
    Entry: {
      doc: "One entry.",
      kind: "object",
      properties: {
        id: { kind: "number" },
        label: { kind: "union", branches: [{ kind: "string" }, { kind: "undefined" }] },
        role: { kind: "ref", name: "Role" },
        title: { kind: "string" },
        token: { kind: "string" },
      },
      propertyDocs: {
        id: { doc: "Its ID." }, label: { deprecated: "Read title." }, title: { doc: "Shown.\n\nTwice." },
        token: { tags: { secret: "" } },
      },
    },
    Role: { deprecated: "", kind: "literal", value: "admin" },
  });
  const { full } = emitDeclarations(schema, { root: "Api" });

  test("`@deprecated` and `@mutates` are in the JSDoc once, from the field when the doc lacks them", () => {
    expect(full).toMatch(/^\/\*\* @deprecated \*\/\nexport interface Api \{/);
    expect(full).toContain("  /**\n   * @param x The x.\n   * @deprecated\n   * @mutates\n   */\n  both(");
    expect(full).toContain("  /** @deprecated Removed soon. */\n  gone(");
    expect(full).toContain("  /**\n   * Old.\n   * @deprecated Use new.\n   */\n  old(");
    expect(full).toContain("  other(): Pipelined<Other>;");
    expect(full).toContain("  /**\n   * Saves.\n   * @mutates\n   */\n  save(");
    expect(full).toContain("  /**\n   * Writes.\n   *\n   * @mutates\n   */\n  tagged(");
    expect(full).toContain("/**\n * Kept.\n * @deprecated\n * @audience agents\n */\nexport interface Other {");
  });

  test("the other tags are in the JSDoc once, from `tags` when the doc lacks them", () => {
    expect(full).toContain("  /**\n   * New.\n   * @since 2\n   * @beta\n   */\n  since(");
    expect(full).toContain("  /** @since 1 */\n  readonly version: Promise<string>;");
  });

  test("a named shape's and an object property's docs and `@deprecated` are in their JSDoc", () => {
    expect(full).toContain([
      "/** One entry. */",
      "export type Entry = {",
      "  /** Its ID. */",
      "  id: number;",
      "  /** @deprecated Read title. */",
      "  label?: string;",
      "  role: Role;",
      "  /**",
      "   * Shown.",
      "   *",
      "   * Twice.",
      "   */",
      "  title: string;",
      "  /** @secret */",
      "  token: string;",
      "};",
      "",
      "/** @deprecated */",
      "export type Role = \"admin\";",
    ].join("\n"));
    expect(diagnose({ "api.d.ts": full })).toEqual([]);
  });
});

// The extractor's own fixture, which has every member and tag the format records.
test("the extractor's fixture: every tag once, and declarations that type-check", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "schema.json"), "utf8")) as Schema;
  const { full } = emitDeclarations(fixture, { root: fixture.entry });
  const services = Object.values(fixture.services);
  const members = services.flatMap((service) => [...service.methods, ...service.properties ?? []]);
  const shapes = Object.values(fixture.shapes);
  const shapeDocs = [...shapes, ...shapes.flatMap((shape) => shape.kind === "object" ? Object.values(shape.propertyDocs ?? {}) : [])];
  const deprecated = [...services, ...members, ...shapeDocs].filter((item) => item.deprecated !== undefined).length;
  const mutates = services.flatMap((service) => service.methods).filter((m) => m.mutates).length;
  const since = [...services, ...members, ...shapeDocs].filter((item) => item.tags?.since !== undefined).length;
  expect(deprecated).toBeGreaterThan(0);
  expect(mutates).toBeGreaterThan(0);
  expect(since).toBeGreaterThan(0);
  expect(full.match(/@deprecated\b/g)).toHaveLength(deprecated);
  expect(full.match(/@mutates\b/g)).toHaveLength(mutates);
  expect(full.match(/@since\b/g)).toHaveLength(since);
  expect(diagnose({ "api.d.ts": full })).toEqual([]);
});

test("the extractor's fixture: a documented alias and a documented property keep their docs, extracted and emitted", () => {
  const PACKAGE = join(import.meta.dirname, "..");
  const schema = extractSchema({
    entry: join(import.meta.dirname, "__fixtures__", "api.ts"),
    tsconfig: join(PACKAGE, "tsconfig.json"),
    entryName: "FixturePublicApi",
  });
  const { full, fragments } = emitDeclarations(schema, { root: "FixtureAuthedApi" });
  for (const text of [full, fragments.Notebook!]) {
    expect(text).toContain('/** A string-literal union. */\nexport type Mood = "busy" | "calm";\n');
    expect(text).toContain("/** A stored note. */\nexport type Note = {\n");
    expect(text).toContain("  /**\n   * Its first line, from before titles.\n   * @deprecated Read title.\n   * @since 1\n   */\n  heading?: string;\n");
    expect(text).toContain("  /** Optional, so a union with `undefined`. */\n  tags?: string[];\n");
  }
});

describe("fragments", () => {
  // Root reaches Shared and RootOnly; Child (by a stub) reaches Shared and ChildOnly, which holds
  // a stub of Grandchild inside a shape.
  const schema = schemaOf({
    Root: {
      methods: [
        method("child", { kind: "stub", service: "Child" }, [
          { name: "options", type: { kind: "ref", name: "RootOnly" }, optional: false, doc: "" },
        ]),
        method("shared", { kind: "ref", name: "Shared" }),
      ],
    },
    Child: {
      methods: [
        method("both", { kind: "ref", name: "ChildOnly" }, [
          { name: "s", type: { kind: "ref", name: "Shared" }, optional: false, doc: "" },
        ]),
      ],
    },
    Grandchild: { methods: [method("leaf", { kind: "ref", name: "GrandchildOnly" })] },
  }, {
    ChildOnly: { kind: "object", properties: { next: { kind: "stub", service: "Grandchild" } } },
    GrandchildOnly: { kind: "string" },
    RootOnly: { kind: "object", properties: { s: { kind: "ref", name: "Shared" } } },
    Shared: { kind: "object", properties: { n: { kind: "number" } } },
  });
  const { full, fragments } = emitDeclarations(schema, { root: "Root" });

  test("hold a service and the shapes it reaches without crossing into another service", () => {
    expect(Object.keys(fragments)).toEqual(["Child", "Grandchild", "Root"]);
    expect(declared(fragments.Root!)).toEqual([AWAITABLE, PIPELINED, "Root", "RootOnly", "Shared"]);
    expect(declared(fragments.Child!)).toEqual([AWAITABLE, "Child", "ChildOnly", "Shared"]);
    expect(declared(fragments.Grandchild!)).toEqual(["Grandchild", "GrandchildOnly"]);
    expect(fragments.Child).toContain("next: Grandchild;");
  });

  test("together declare what the full file does, and each declaration as the full file does", () => {
    const union = new Set(Object.values(fragments).flatMap(declared));
    expect([...union].toSorted()).toEqual(declared(full));
    for (const fragment of Object.values(fragments)) {
      for (const declaration of fragment.split("\n\n")) expect(full).toContain(declaration);
    }
  });

  test("each type-checks, missing only the other services' names", () => {
    expect(missingNames(fragments)).toEqual({ Child: ["Grandchild"], Grandchild: [], Root: ["Child"] });
  });
});

/** Per fragment, the names it uses without declaring them (each fragment its own module). */
function missingNames(fragments: Record<string, string>): Record<string, string[]> {
  const diagnostics = diagnose(Object.fromEntries(Object.entries(fragments).map(([name, text]) => [`${name}.d.ts`, text])));
  const missing: Record<string, string[]> = Object.fromEntries(Object.keys(fragments).map((name) => [name, []]));
  for (const { file, code, text } of diagnostics) {
    expect(CANNOT_FIND_NAME, `${file}: ${text}`).toContain(code);
    missing[file.replace(/\.d\.ts$/, "")]!.push(/'([^']+)'/.exec(text)![1]!);
  }
  for (const names of Object.values(missing)) names.sort();
  return missing;
}

/** "Cannot find name '{0}'.", and the same with "Did you mean '{1}'?". */
const CANNOT_FIND_NAME = [2304, 2552];

test("imports nothing but the schema's types, as a pure emitter", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "emit", "dts.ts"), "utf8");
  expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["../schema.ts"]);
});

describe("workshop-shared's API", () => {
  const PACKAGE = join(import.meta.dirname, "..");
  const SHARED = join(PACKAGE, "..", "workshop-shared");
  const API = join(SHARED, "src", "api.ts");
  const TSCONFIG = join(SHARED, "tsconfig.json");
  /** What the generator leaves out: an agent already holds an authenticated stub. */
  const CREDENTIAL_METHODS = ["authenticate", "authenticateFromCfAccess", "createAccount", "login", "changePassword"];
  const ROOT = "AuthenticatedApi";

  const schema = extractSchema({ entry: API, tsconfig: TSCONFIG, entryName: "PublicApi" });
  const emitted = emitDeclarations(schema, { root: ROOT, omit: CREDENTIAL_METHODS });
  const dir = mkdtempSync(join(tmpdir(), "api-schema-dts-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("declares the authenticated surface and nothing that logs in", () => {
    expect(/^export (?:interface|type) ([\w$]+)/m.exec(emitted.full)?.[1]).toBe(ROOT);
    expect(declared(emitted.full)).not.toContain("PublicApi");
    expect(declared(emitted.full)).not.toContain("LoginAttempt");
    for (const name of CREDENTIAL_METHODS) expect(emitted.full).not.toMatch(new RegExp(`^  ${name}\\(`, "m"));
  });

  test("fragments: together what the full file declares, each missing only other services", () => {
    const union = new Set(Object.values(emitted.fragments).flatMap(declared));
    expect([...union].toSorted()).toEqual(declared(emitted.full));
    const services = new Set(Object.keys(emitted.fragments));
    for (const [fragment, names] of Object.entries(missingNames(emitted.fragments))) {
      for (const name of names) expect(services.has(name), `${fragment} uses ${name}`).toBe(true);
    }
  });

  // What a caller holds is capnweb's `RpcStub<AuthenticatedApi>`: each call returns an
  // `RpcPromise`, a returned `RpcTarget` becomes a stub with the same treatment, and awaited values
  // are stubified. The probe asserts it is assignable to the generated `AuthenticatedApi`, which
  // relates every method's parameters and awaited result, transitively through every service.
  // TypeScript gives up on relating types nested deeply enough, and where it gives up depends on
  // the order it checks files in, so the probe also asserts the same of every service a caller
  // reaches by calling, each held as the stub its first path from the root returns.
  //
  // That direction catches a generated result narrower than the real one, and only that: with a
  // generated result wider (a dropped property, `unknown` for `boolean`) the stub is still
  // assignable. Nor does it pin parameters down: the generated services declare methods, whose
  // parameters TypeScript compares bivariantly even under `strictFunctionTypes`, so a parameter
  // narrowed (a literal for `string`) or widened (`unknown` for `string`) passes alike. So for
  // every method of those services, and of every service a caller implements (a subscriber the
  // API takes as a parameter, whose parameters are the values a code-mode agent receives), the
  // probe also asserts that the generated awaited result is assignable to the real one, and that
  // each data parameter is assignable both ways, real to generated and generated to real. A
  // result mixing data with capabilities (an object with a stub property, `null` or a capability)
  // is compared part by part: each of its data properties, and the union of its branches that
  // are not objects, generated to real; a capability in it is related by the stub's direction
  // alone, and a part `dataParts` cannot take apart fails the probe rather than going unchecked.
  // A parameter of a call the holder makes is generated as `Awaitable<T>`, which also takes a
  // promise of it, as a stub's does: there the generated parameter less its promise is what is
  // assignable to the real one, and a promise of the real one must be assignable to the generated
  // one. With the stub's direction that makes every data result, data part of a result and data
  // parameter mutually assignable, equal as far as assignability can tell; a capability or a
  // callback is checked in the stub's direction only. Comparing awaited
  // results cannot tell a subscriber's `void` from `Promise<void>`, so for each service a caller
  // only implements, the probe also asserts that the real result, as an implementation written to
  // it returns it, is assignable to the generated one. That
  // holds only for data, with no capability or function anywhere in it: the real one is an
  // `RpcTarget` class or a function as the implementation types it, which the generated
  // interface is not meant to be assignable to. Nor does assignability notice a method missing
  // from a generated interface, which is merely narrower, so the probe also asserts that each of
  // those services declares exactly the real one's methods, less the omitted ones. The real methods
  // are those `api.ts` declares, not a stub's, whose parameters also take promises: a service by
  // its name, or a generic one (`GatekeeperClient<any>`) as the declared result of the method
  // that first returns it.
  //
  // capnweb types a parameter declared as an interface extending `RpcTarget` as requiring an
  // `RpcTarget` (a plain object is passed by value), by a `unique symbol` brand only capnweb can
  // name, so a declaration file independent of capnweb can never satisfy it. The probe therefore
  // augments exactly those generated interfaces (a service the API takes as a parameter and
  // declares extending `RpcTarget` directly) with `extends RpcTarget`, which is what the module
  // comment of `dts.ts` tells an implementer to do, and checks everything else as is. A service
  // extending `RpcTarget` only indirectly would make the probe fail, not pass.
  //
  // An implemented method's result and a supplied callback's are `Awaitable<T>`, since what the
  // implementation returns reaches the API as a promise either way; but capnweb's types demand
  // of an implementation exactly the result `api.ts` declares, a `Promise<void>` here and a
  // `void` there. So the stub's direction is checked against a view of the generated file in
  // which `Awaitable<T>` is `T & Promise<T>`, which satisfies either reading, and the reverse
  // checks above pin `Awaitable<T>` itself down. A parameter of a call the holder makes is then
  // `T & Promise<T>` too, which a stub, taking `T` or a promise of it, accepts.
  //
  // `skipLibCheck` is off for the probe and the generated file, so the generated file is fully
  // checked, and their diagnostics are the ones collected: capnweb's own declarations do not
  // pass a full check.
  //
  // Every probe is checked in one program, each in its own directory, because capnweb's
  // instantiation of the real stub dominates the cost; each probe's types are distinct, so no
  // result carries over between probes.
  const AWAITABLE_DECLARATION = `export type ${AWAITABLE}<T> = T | Promise<T>;`;
  const probes: { declarations: string; usage: string }[] = [];
  let probeDiagnostics: string[][] | undefined;

  /** Registers a probe of `declarations`, with `usage` appended, and returns its index in `probeResults()`. */
  function probe(declarations: string, usage = ""): number {
    if (probeDiagnostics) throw new Error("a probe registered after the probes were checked");
    expect(declarations).toContain(AWAITABLE_DECLARATION);
    return probes.push({ declarations, usage }) - 1;
  }

  /** Each registered probe's diagnostics, from checking them all once. */
  function probeResults(): string[][] {
    probeDiagnostics ??= checkProbes();
    return probeDiagnostics;
  }
  // The one check, ~2 s locally and ten times that on a contended CI runner, is set-up rather than
  // the first test to read it, which would otherwise spend its own time limit on all of them.
  beforeAll(() => {
    probeResults();
  }, 60_000);

  function checkProbes(): string[][] {
    const branded = parameterServices(schema, ROOT, CREDENTIAL_METHODS)
      .filter((name) => extendsRpcTargetDirectly(API, name));
    const held = heldServices(schema, ROOT, CREDENTIAL_METHODS);
    const callers = new Set([ROOT, ...held.map(({ service }) => service)]);
    const callbacks = parameterServices(schema, ROOT, CREDENTIAL_METHODS)
      .filter((name) => !callers.has(name) && declaresPlainInterface(API, name));
    const reverse = [...callers, ...callbacks].flatMap((service) =>
      schema.services[service]!.methods.filter((m) => !CREDENTIAL_METHODS.includes(m.name)).flatMap((m) => {
        const key = JSON.stringify(m.name);
        const called = callers.has(service);
        const checks = dataParts(schema, m.returns, `Awaited<ReturnType<Real_${service}[${key}]>>`,
          `Awaited<ReturnType<Generated.${service}[${key}]>>`, `${service}.${m.name}`);
        if (!called && isData(schema, m.returns)) {
          checks.push(`Assignable<ReturnType<Generated.${service}[${key}]>, ReturnType<Real_${service}[${key}]>>`);
        }
        m.params.forEach((param, i) => {
          if (!isData(schema, param.type)) return;
          const real = `Parameters<Real_${service}[${key}]>[${i}]`;
          const ours = `Parameters<Generated.${service}[${key}]>[${i}]`;
          checks.push(`Assignable<${ours},\n  ${real}>`,
            `Assignable<${real},\n  ${called ? `Awaited<${ours}>` : ours}>`);
          if (called) checks.push(`Assignable<${ours},\n  Promise<Exclude<${real}, undefined>>>`);
        });
        return checks;
      }));
    const probeText = (usage: string) => `import type { RpcStub, RpcTarget } from "capnweb";
import type { ${ROOT} } from ${JSON.stringify(API.replace(/\.ts$/, ".js"))};
import type * as Real from ${JSON.stringify(API.replace(/\.ts$/, ".js"))};
import type * as Generated from "./workshop-api.js";
import type * as StubView from "./workshop-api-stub-view.js";

${["./workshop-api.js", "./workshop-api-stub-view.js"].map((module) => `declare module ${JSON.stringify(module)} {
${branded.map((name) => `  interface ${name} extends RpcTarget {}`).join("\n")}
}`).join("\n")}

type Held_${ROOT} = RpcStub<${ROOT}>;
${held.map((hop) =>
    `type Held_${hop.service} = NonNullable<Awaited<ReturnType<Held_${hop.from}[${JSON.stringify(hop.method)}]>>>;`)
    .join("\n")}

${[...held.map(({ service }) => service).toReversed(), ROOT].map((service) =>
    `declare const held_${service}: Held_${service};\nexport const generated_${service}: StubView.${service} = held_${service};`)
    .join("\n")}

/** \`From\`, where it is assignable to \`To\`. */
type Assignable<To, From extends To> = From;
type Real_${ROOT} = Real.${ROOT};
${held.map((hop) => `type Real_${hop.service} = ${declaresPlainInterface(API, hop.service) ? `Real.${hop.service}`
    : `NonNullable<Awaited<ReturnType<Real_${hop.from}[${JSON.stringify(hop.method)}]>>>`};`).join("\n")}
${callbacks.map((name) => `type Real_${name} = Real.${name};`).join("\n")}
${reverse.map((check, i) => `export type Reverse${i} = ${check};`).join("\n")}

/** \`Keys\`, where there are none. */
type NoKeys<Keys extends never> = Keys;
/** A type's method names, less capnweb's brands. */
type Methods<T> = Exclude<Extract<keyof T, string>, \`__RPC_\${string}\`>;
type Omitted = ${CREDENTIAL_METHODS.map((name) => JSON.stringify(name)).join(" | ")};
${[...callers, ...callbacks].map((service) =>
    `export type Missing_${service} = NoKeys<Exclude<Methods<Real_${service}>, keyof Generated.${service} | Omitted>>;
export type Extra_${service} = NoKeys<Exclude<Methods<Generated.${service}>, keyof Real_${service}>>;`).join("\n")}

${usage}
`;
    const files = probes.map(({ declarations, usage }, i) => {
      const probeDir = join(dir, String(i));
      mkdirSync(probeDir);
      const generated = join(probeDir, "workshop-api.d.ts");
      const stubView = join(probeDir, "workshop-api-stub-view.d.ts");
      const file = join(probeDir, "probe.ts");
      writeFileSync(generated, declarations);
      writeFileSync(stubView, declarations.replace(AWAITABLE_DECLARATION, `export type ${AWAITABLE}<T> = T & Promise<T>;`));
      writeFileSync(file, probeText(usage));
      return [file, generated, stubView] as const;
    });
    const read = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, SHARED, undefined, TSCONFIG);
    const program = ts.createProgram({
      rootNames: files.map(([file]) => file),
      options: {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: false,
        // The probe lives outside the workspace; this is the copy `api.ts` itself resolves.
        paths: { capnweb: [join(SHARED, "node_modules", "capnweb", "dist", "index.d.ts")] },
      },
    });
    const shared = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    return files.map(([file, ...declarations]) => {
      const sources = [file, ...declarations].map((name) => program.getSourceFile(name)!);
      expect(sources.every(Boolean)).toBe(true);
      const diagnostics = [
        ...shared,
        ...sources.flatMap((source) => [...program.getSyntacticDiagnostics(source),
          ...program.getSemanticDiagnostics(source)]),
      ];
      // Each message with the probe's line it is on, which names the method checked.
      return diagnostics.map((diagnostic) => {
        const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        if (diagnostic.file?.fileName !== file || diagnostic.start === undefined) return text;
        const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${text}\n  at: ${diagnostic.file.text.split("\n")[line]!.trim()}`;
      });
    });
  }

  const holds = probe(emitted.full);
  test("what a caller holds, RpcStub<AuthenticatedApi>, is assignable to the generated declaration", () => {
    expect(probeResults()[holds]).toEqual([]);
  });

  const callback = probe(emitted.full, `declare const overseer: Generated.Overseer;
void overseer.subscribeToMetadata((metadata) => {
  const title: string = metadata.title;
  void title;
});`);
  test("a synchronous callback type-checks against the generated declaration", () => {
    const subscribe = schema.services.Overseer!.methods.find((m) => m.name === "subscribeToMetadata")!;
    expect(subscribe.params[0]!.type.kind).toBe("function");
    expect(emitted.full).toContain("subscribeToMetadata(callback: (metadata: WorkspaceMetadata) => Awaitable<void>)");
    expect(probeResults()[callback]).toEqual([]);
  });

  // A subscriber written to `api.ts`'s interface, its methods synchronous, implements the generated
  // one; and one call's result is passed to the next unawaited, as capnweb resolves it first.
  const syncSubscriber = probe(emitted.full, `declare const api: Generated.AuthenticatedApi;
class Accounts implements Generated.ConnectedAccountsSubscriber {
  readonly ids = new Set<number>();
  add(id: number) {
    this.ids.add(id);
  }
  remove(id: number) {
    this.ids.delete(id);
  }
  ready() {}
}
export async function rename(id: string, from: number, to: number): Promise<void> {
  using subscription = await api.subscribeConnectedAccounts(new Accounts());
  void subscription;
  const overseer = api.openWorkspace(id);
  await overseer.getGadget(to).setTitle(overseer.getGadget(from).getTitle());
}`);
  test("a synchronous subscriber, and a promised argument, type-check against the generated declaration", () => {
    expect(probeResults()[syncSubscriber]).toEqual([]);
  });

  // Disposal is how a caller cancels a subscription, and pipelining sends a chain of calls at once.
  const disposes = probe(emitted.full, `declare const api: Generated.AuthenticatedApi;
export async function use(id: string): Promise<number> {
  const chats = await api.openWorkspace(id).listChats();
  using subscription = await api.openWorkspace(id).subscribeToMetadata(() => {});
  void subscription;
  const handle = await (await api.openWorkspace(id)).subscribeToMetadata(() => {});
  handle[Symbol.dispose]();
  api[Symbol.dispose]();
  return chats.length;
}`);
  test("a returned handle disposes, and a returned capability pipelines, against the generated declaration", () => {
    expect(probeResults()[disposes]).toEqual([]);
  });

  // The negative controls: the probe catches a wrong result on the root, one on a service two
  // capability hops away, a wrong property in a shape a result returns, and one in the shape
  // nested deepest in any result; and, in the other direction, a property dropped from a returned
  // shape, a result widened to `unknown`, a data property beside a capability widened or dropped,
  // and a branch added to a nullable capability; and a parameter narrowed to a literal or widened
  // to `unknown`, on the root and on a subscriber a caller implements; and a method dropped, one
  // with neither a data parameter nor a data result from the root, and one from a subscriber.
  // Each edit is made, and its probe registered, as the tests are collected; a test reads its
  // probe's diagnostics.
  function corrupt(edit: (copy: Schema) => string) {
    const copy = structuredClone(schema);
    const target = edit(copy);
    const index = probe(emitDeclarations(copy, { root: ROOT, omit: CREDENTIAL_METHODS }).full);
    return {
      target,
      get diagnostics() {
        return probeResults()[index]!;
      },
    };
  }
  /** `GatekeeperUiFrame`, data beside a capability, as a root method returns it. */
  function frame(copy: Schema) {
    const results = copy.services[ROOT]!.methods.filter((m) => m.name === "startResourceConfigurator")
      .map((m) => m.returns);
    expect(results).toEqual([{ kind: "ref", name: "GatekeeperUiFrame" }]);
    const shape = copy.shapes.GatekeeperUiFrame as Extract<ApiShape, { kind: "object" }>;
    expect(shape.properties).toEqual({ iframeHtml: { kind: "string" }, ui: { kind: "stub" } });
    return shape;
  }
  function firstMethod(copy: Schema, service: string, kind: ApiShape["kind"]) {
    const found = copy.services[service]!.methods.find((m) => m.returns.kind === kind && !CREDENTIAL_METHODS.includes(m.name));
    expect(found, `a ${kind}-returning method of ${service}`).toBeDefined();
    return found!;
  }
  describe("fails on a corrupted declaration", () => {

    const rootResult = corrupt((copy) => {
      const m = firstMethod(copy, ROOT, "boolean");
      m.returns = { kind: "string" };
      return m.name;
    });
    test("a root method's result", () => {
      const { target, diagnostics } = rootResult;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`'${target}\\b`));
    });

    const twoHops = corrupt((copy) => {
      const m = firstMethod(copy, "GadgetClient", "string");
      m.returns = { kind: "number" };
      return m.name;
    });
    test("a result two hops away", () => {
      expect(schema.services.Overseer!.methods.find((m) => m.name === "getGadget")!.returns)
        .toEqual({ kind: "stub", service: "GadgetClient" });
      const { target, diagnostics } = twoHops;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`'${target}\\b`));
    });

    const shapeProperty = corrupt((copy) => {
      for (const m of copy.services[ROOT]!.methods) {
        const shape = m.returns.kind === "ref" ? copy.shapes[m.returns.name] : undefined;
        if (shape?.kind !== "object") continue;
        const property = Object.entries(shape.properties).find(([, value]) => value.kind === "string");
        if (!property) continue;
        shape.properties[property[0]] = { kind: "number" };
        return property[0];
      }
      throw new Error("no returned object shape with a string property");
    });
    test("a property of a returned shape", () => {
      const { target, diagnostics } = shapeProperty;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`'${target}\\b`));
    });

    const services = [ROOT, ...heldServices(schema, ROOT, CREDENTIAL_METHODS).map(({ service }) => service)];
    const deepest = deepestShape(schema, services, CREDENTIAL_METHODS);
    expect(deepest.depth, deepest.name).toBeGreaterThanOrEqual(4);
    const deepestProperty = corrupt((copy) => {
      const shape = copy.shapes[deepest.name] as Extract<ApiShape, { kind: "object" }>;
      const property = Object.keys(shape.properties).find((key) => shape.properties[key]!.kind === "string")!;
      shape.properties[property] = { kind: "number" };
      return property;
    });
    test("a property of the shape nested deepest in any result", () => {
      const { target, diagnostics } = deepestProperty;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`'${target}\\b`));
    });

    const droppedProperty = corrupt((copy) => {
      for (const m of copy.services[ROOT]!.methods) {
        const shape = m.returns.kind === "ref" ? copy.shapes[m.returns.name] : undefined;
        if (shape?.kind !== "object" || !isData(copy, shape)) continue;
        const property = Object.keys(shape.properties).find((key) => {
          const value = shape.properties[key]!;
          const branches = value.kind === "union" ? value.branches : [value];
          return !branches.some((branch) => branch.kind === "undefined");
        });
        if (!property) continue;
        delete shape.properties[property];
        return property;
      }
      throw new Error("no returned data shape with a required property");
    });
    test("a property dropped from a returned shape", () => {
      const { target, diagnostics } = droppedProperty;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`'${target}\\b`));
    });

    const widenedResult = corrupt((copy) => {
      const m = firstMethod(copy, ROOT, "boolean");
      m.returns = { kind: "any" };
      return m.name;
    });
    test("a result widened to unknown", () => {
      const { target, diagnostics } = widenedResult;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"`));
    });

    // `GatekeeperUiFrame` is data beside a capability (`ui`), so the stub's direction alone would
    // let its data be widened or dropped.
    describe("a data property beside a capability in a result", () => {
      const widened = corrupt((copy) => {
        frame(copy).properties.iframeHtml = { kind: "any" };
        return "iframeHtml";
      });
      test("widened to unknown", () => {
        const { diagnostics } = widened;
        expect(diagnostics.join("\n")).toMatch(/\["iframeHtml"\]/);
      });
      const dropped = corrupt((copy) => {
        delete frame(copy).properties.iframeHtml;
        return "iframeHtml";
      });
      test("dropped", () => {
        const { diagnostics } = dropped;
        expect(diagnostics.join("\n")).toMatch(/'iframeHtml'/);
      });
    });

    const addedBranch = corrupt((copy) => {
      const m = copy.services[ROOT]!.methods.find((candidate) => candidate.name === "getAdminApi")!;
      expect(m.returns).toEqual({ kind: "union", branches: [{ kind: "null" }, { kind: "stub", service: "AdminApi" }] });
      (m.returns as Extract<ApiShape, { kind: "union" }>).branches.push({ kind: "string" });
      return m.name;
    });
    test("a branch added to a result that is null or a capability", () => {
      const { target, diagnostics } = addedBranch;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"`));
    });

    const narrowedParameter = corrupt((copy) => {
      const m = copy.services[ROOT]!.methods.find((candidate) => !CREDENTIAL_METHODS.includes(candidate.name)
        && candidate.params.some((param) => param.type.kind === "string"))!;
      expect(m, "a root method with a string parameter").toBeDefined();
      m.params.find((param) => param.type.kind === "string")!.type = { kind: "literal", value: "only-this" };
      return m.name;
    });
    test("a parameter narrowed to a literal", () => {
      const { target, diagnostics } = narrowedParameter;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"`));
    });

    const widenedParameter = corrupt((copy) => {
      const m = copy.services[ROOT]!.methods.find((candidate) => !CREDENTIAL_METHODS.includes(candidate.name)
        && candidate.params.some((param) => param.type.kind === "string"))!;
      expect(m, "a root method with a string parameter").toBeDefined();
      m.params.find((param) => param.type.kind === "string")!.type = { kind: "any" };
      return m.name;
    });
    test("a parameter widened to unknown", () => {
      const { target, diagnostics } = widenedParameter;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"`));
    });

    const droppedRootMethod = corrupt((copy) => {
      copy.services[ROOT]!.methods = copy.services[ROOT]!.methods.filter((m) => m.name !== "newWorkspace");
      return "newWorkspace";
    });
    test("a method dropped from the root", () => {
      const newWorkspace = schema.services[ROOT]!.methods.find((m) => m.name === "newWorkspace")!;
      expect(newWorkspace.params).toEqual([]);
      expect(newWorkspace.returns).toEqual({ kind: "stub", service: "Overseer" });
      const { target, diagnostics } = droppedRootMethod;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"[\\s\\S]*Missing_${ROOT}`));
    });

    const droppedSubscriberMethod = corrupt((copy) => {
      const subscriber = copy.services.ConnectedAccountsSubscriber!;
      subscriber.methods = subscriber.methods.filter((m) => m.name !== "add");
      return "add";
    });
    test("a method dropped from a subscriber", () => {
      const { target, diagnostics } = droppedSubscriberMethod;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`"${target}"[\\s\\S]*Missing_ConnectedAccountsSubscriber`));
    });

    const widenedSubscriberParameter = corrupt((copy) => {
      const m = copy.services.ConnectedAccountsSubscriber!.methods.find((candidate) => candidate.name === "add")!;
      const param = m.params.find((candidate) => candidate.name === "vendorId")!;
      expect(param.type).toEqual({ kind: "string" });
      param.type = { kind: "any" };
      return m.name;
    });
    test("a subscriber's parameter widened to unknown", () => {
      expect(parameterServices(schema, ROOT, CREDENTIAL_METHODS)).toContain("ConnectedAccountsSubscriber");
      const { target, diagnostics } = widenedSubscriberParameter;
      expect(diagnostics.join("\n")).toMatch(new RegExp(`ConnectedAccountsSubscriber\\["${target}"\\]`));
    });
  });
});

/** Whether `shape` is data: no capability, function or unsupported value anywhere in it. */
function isData(schema: Schema, shape: ApiShape, seen = new Set<string>()): boolean {
  switch (shape.kind) {
    case "stub":
    case "function":
    case "unsupported":
      return false;
    case "array":
    case "set":
      return isData(schema, shape.element, seen);
    case "map":
      return isData(schema, shape.key, seen) && isData(schema, shape.value, seen);
    case "tuple":
      return [...shape.elements, ...shape.rest ? [shape.rest] : []].every((s) => isData(schema, s, seen));
    case "object":
      return [...Object.values(shape.properties), ...shape.index ? [shape.index] : []]
        .every((s) => isData(schema, s, seen));
    case "union":
      return shape.branches.every((s) => isData(schema, s, seen));
    case "ref":
      if (seen.has(shape.name)) return true;
      seen.add(shape.name);
      return isData(schema, schema.shapes[shape.name]!, seen);
    default:
      return true;
  }
}

/** Shape kinds that are never objects, so `Exclude<T, object>` keeps exactly them. */
const NOT_OBJECTS = new Set<ApiShape["kind"]>(["string", "number", "boolean", "bigint", "null", "undefined", "void",
  "literal"]);

/**
 * The checks that the data in `ours`, the generated type of `shape`, is assignable to `real`: the
 * whole of it, for data; a capability or function has none; an object property by property, an
 * array by its element; a union's branches that are not objects together, and the one branch
 * that is an object, if any, by itself. Anything else that holds a capability throws, so the probe
 * is extended rather than silently skipping it.
 */
function dataParts(schema: Schema, shape: ApiShape, real: string, ours: string, where: string,
  seen = new Set<string>()): string[] {
  if (isData(schema, shape)) return [`Assignable<${real},\n  ${ours}>`];
  switch (shape.kind) {
    case "stub":
    case "function":
    case "unsupported":
      return [];
    case "ref":
      if (seen.has(shape.name)) return [];
      return dataParts(schema, schema.shapes[shape.name]!, real, ours, where, new Set([...seen, shape.name]));
    case "array":
      return dataParts(schema, shape.element, `${real}[number]`, `${ours}[number]`, where, seen);
    case "object":
      return [
        ...Object.entries(shape.properties).flatMap(([name, value]) => {
          const key = JSON.stringify(name);
          return dataParts(schema, value, `${real}[${key}]`, `${ours}[${key}]`, where, seen);
        }),
        ...shape.index ? dataParts(schema, shape.index, `${real}[string]`, `${ours}[string]`, where, seen) : [],
      ];
    case "union": {
      const objects = shape.branches.filter((branch) => !NOT_OBJECTS.has(branch.kind));
      if (objects.length > 1) throw new Error(`${where}: a result with more than one object branch and a capability`);
      return [
        `Assignable<${real},\n  Exclude<${ours}, object>>`,
        ...objects.flatMap((branch) =>
          dataParts(schema, branch, `Extract<${real}, object>`, `Extract<${ours}, object>`, where, seen)),
      ];
    }
    default:
      throw new Error(`${where}: a ${shape.kind} holding a capability, which the probe cannot take apart`);
  }
}

/**
 * Of the object shapes with a string property, the one whose nearest occurrence in a result of the
 * given services' methods is deepest, counted in named shapes from the result (1 is the result's
 * own).
 */
function deepestShape(schema: Schema, services: string[], omit: string[]): { name: string; depth: number } {
  const depths = new Map<string, number>();
  let level: ApiShape[] = services.flatMap((service) =>
    schema.services[service]!.methods.filter((m) => !omit.includes(m.name)).map((m) => m.returns));
  for (let depth = 1; level.length; depth++) {
    const next: ApiShape[] = [];
    const visit = (shape: ApiShape): void => {
      switch (shape.kind) {
        case "array":
        case "set":
          return visit(shape.element);
        case "map":
          visit(shape.key);
          return visit(shape.value);
        case "tuple":
          return [...shape.elements, ...shape.rest ? [shape.rest] : []].forEach(visit);
        case "object":
          return [...Object.values(shape.properties), ...shape.index ? [shape.index] : []].forEach(visit);
        case "union":
          return shape.branches.forEach(visit);
        case "ref":
          if (depths.has(shape.name)) return;
          depths.set(shape.name, depth);
          next.push(schema.shapes[shape.name]!);
      }
    };
    level.forEach(visit);
    level = next;
  }
  const [name, depth] = [...depths].filter(([key]) => {
    const shape = schema.shapes[key]!;
    return shape.kind === "object" && Object.values(shape.properties).some((value) => value.kind === "string");
  }).toSorted(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]!;
  return { name, depth };
}

/**
 * The services that appear in a parameter of a method reachable from `root` (through every shape
 * and capability), sorted: those a caller implements.
 */
function parameterServices(schema: Schema, root: string, omit: string[]): string[] {
  const parameters = new Set<string>();
  const services = new Set<string>();
  const shapes = new Set<string>();
  const visit = (shape: ApiShape, inParameter: boolean): void => {
    switch (shape.kind) {
      case "array":
      case "set":
        return visit(shape.element, inParameter);
      case "map":
        visit(shape.key, inParameter);
        return visit(shape.value, inParameter);
      case "tuple":
        return [...shape.elements, ...shape.rest ? [shape.rest] : []].forEach((s) => visit(s, inParameter));
      case "object":
        return [...Object.values(shape.properties), ...shape.index ? [shape.index] : []]
          .forEach((s) => visit(s, inParameter));
      case "union":
        return shape.branches.forEach((s) => visit(s, inParameter));
      case "ref":
        if (shapes.has(`${inParameter}:${shape.name}`)) return;
        shapes.add(`${inParameter}:${shape.name}`);
        return visit(schema.shapes[shape.name]!, inParameter);
      case "function":
        shape.params.forEach((param) => visit(param.type, true));
        return visit(shape.returns, inParameter);
      case "stub":
        if (shape.service === undefined) return;
        if (inParameter) parameters.add(shape.service);
        return service(shape.service);
    }
  };
  const service = (name: string) => {
    if (services.has(name)) return;
    services.add(name);
    for (const m of schema.services[name]!.methods.filter((candidate) => !omit.includes(candidate.name))) {
      m.params.forEach((param) => visit(param.type, true));
      visit(m.returns, false);
    }
  };
  service(root);
  return [...parameters].toSorted();
}

/** Whether `file` declares interface `name`, without type parameters. */
function declaresPlainInterface(file: string, name: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  return source.statements.some((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name
    && !statement.typeParameters);
}

/** Whether `file` declares interface `name` with `RpcTarget` in its own `extends` clause. */
function extendsRpcTargetDirectly(file: string, name: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  return source.statements.some((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name
    && !!statement.heritageClauses?.some((clause) => clause.types.some((type) => type.expression.getText(source) === "RpcTarget")));
}

/**
 * The services a caller reaches from `root` by calling (a method's result is the capability, or a
 * union of it with values), each with the service and method of the first path to it, breadth
 * first in method order. Only those with identifiers for names: `RpcStub<{}>` has no methods.
 */
function heldServices(schema: Schema, root: string, omit: string[]): { service: string; from: string; method: string }[] {
  const held: { service: string; from: string; method: string }[] = [];
  const seen = new Set([root]);
  for (let i = -1; i < held.length; i++) {
    const from = i < 0 ? root : held[i]!.service;
    for (const m of schema.services[from]!.methods.filter((candidate) => !omit.includes(candidate.name))) {
      const branches = m.returns.kind === "union" ? m.returns.branches : [m.returns];
      for (const branch of branches) {
        if (branch.kind !== "stub" || branch.service === undefined || seen.has(branch.service)) continue;
        seen.add(branch.service);
        if (/^[A-Za-z_$][\w$]*$/.test(branch.service)) held.push({ service: branch.service, from, method: m.name });
      }
    }
  }
  return held;
}
