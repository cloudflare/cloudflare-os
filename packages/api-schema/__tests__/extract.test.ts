// The extractor, against the miniature API in `__fixtures__/api.ts` (whose schema is committed as
// `__fixtures__/schema.json`) and against this repository's own `workshop-shared/src/api.ts`.
//
// After changing the fixture or the extractor on purpose, rewrite the expected schema with
// `API_SCHEMA_UPDATE_FIXTURES=1 pnpm --filter @gadgets/api-schema test:run`, and read the diff.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript6";
import { afterAll, describe, expect, test } from "vitest";
import { type ExtractOptions, extractSchema, extractSchemaAndSources, normalizeDoc } from "../src/extract.ts";
import { type ApiShape, FORMAT, type Schema, type SchemaService } from "../src/schema.ts";

const PACKAGE = join(import.meta.dirname, "..");
const FIXTURES = join(import.meta.dirname, "__fixtures__");
const FIXTURE: ExtractOptions = {
  entry: join(FIXTURES, "api.ts"),
  tsconfig: join(PACKAGE, "tsconfig.json"),
  entryName: "FixturePublicApi",
  constants: ["SERVICE_SALT"],
};
const EXPECTED_SCHEMA = join(FIXTURES, "schema.json");
/** Options for a one-file API, skipping library checks as the root tsconfig the generator loads does. */
const STRICT: ts.CompilerOptions = { strict: true, skipLibCheck: true };

const SHARED = join(PACKAGE, "..", "workshop-shared");
const WORKSHOP_API: ExtractOptions = {
  entry: join(SHARED, "src", "api.ts"),
  tsconfig: join(SHARED, "tsconfig.json"),
  entryName: "PublicApi",
  constants: ["SERVICE_SALT"],
};

describe("the fixture", () => {
  test("extracts the fixture's schema as committed", () => {
    const actual = `${JSON.stringify(extractSchema(FIXTURE), null, 2)}\n`;
    if (process.env.API_SCHEMA_UPDATE_FIXTURES) writeFileSync(EXPECTED_SCHEMA, actual);
    expect(actual).toBe(readFileSync(EXPECTED_SCHEMA, "utf8"));
  });

  test("tells capabilities, callbacks, streams, handles and any tails apart", () => {
    const schema = extractSchema(FIXTURE);
    const method = (service: string, name: string) => {
      const found = schema.services[service]!.methods.find((m) => m.name === name);
      expect(found, `${service}.${name}`).toBeDefined();
      return found!;
    };
    // A Promise<Interface extending RpcTarget> and an RpcStub<Interface> are both capabilities.
    expect(method("FixturePublicApi", "authenticate").returns).toEqual({ kind: "stub", service: "FixtureAuthedApi" });
    expect(method("FixtureAuthedApi", "openNotebook").returns).toEqual({ kind: "stub", service: "Notebook" });
    // A method-only interface behind a nullable stub.
    expect(method("FixtureAuthedApi", "getAdmin").returns)
      .toEqual({ kind: "union", branches: [{ kind: "null" }, { kind: "stub", service: "FixtureAdmin" }] });
    expect(schema.services.FixtureAdmin!.methods.map((m) => m.name)).toEqual(["setBanner"]);
    // RpcStub<{}> is a capability with no methods; RpcStub<any> one with no service.
    expect(method("Notebook", "lock").returns).toEqual({ kind: "stub", service: "{}" });
    expect(schema.services["{}"]!.methods).toEqual([]);
    expect(method("Notebook", "connect").returns).toEqual({ kind: "stub" });
    expect(method("FixturePublicApi", "download").returns).toEqual({ kind: "readableStream", element: { kind: "bytes" } });
    expect(method("FixtureAuthedApi", "importArchive").params[0]!.type)
      .toEqual({ kind: "readableStream", element: { kind: "bytes" } });
    // The client-implemented interface is recorded with every method, and the bare function with
    // its signature.
    expect(method("Notebook", "subscribe").params[0]!.type).toEqual({ kind: "stub", service: "NotesSubscriber" });
    expect(schema.services.NotesSubscriber!.methods.map((m) => [m.name, m.params.map((p) => p.name)]))
      .toEqual([["added", ["note"]], ["edited", ["id", "cursor"]], ["ready", []], ["removed", ["id"]]]);
    expect(method("Notebook", "watchTitle").params[0]!.type).toEqual({
      kind: "function",
      params: [{ name: "title", type: { kind: "string" }, optional: false }],
      returns: { kind: "void" },
    });
  });

  test("keeps optional parameters' types without the undefined they imply", () => {
    const schema = extractSchema(FIXTURE);
    const findNotes = schema.services.FixtureAuthedApi!.methods.find((m) => m.name === "findNotes")!;
    expect(findNotes.params.map(({ name, type, optional }) => ({ name, type, optional }))).toEqual([
      { name: "query", type: { kind: "string" }, optional: false },
      { name: "limit", type: { kind: "number" }, optional: true },
      { name: "url", type: { kind: "string" }, optional: true },
    ]);
    const upload = schema.services.Notebook!.methods.find((m) => m.name === "upload")!;
    expect(upload.params[1]!.type).toEqual({ kind: "boolean" });
  });

  test("hoists named types once, references them by name, and survives recursion", () => {
    const schema = extractSchema(FIXTURE);
    expect(Object.keys(schema.shapes)).toEqual(["Destination", "Mood", "Note", "Outline"]);
    expect(schema.shapes.Outline).toEqual({
      doc: "A recursive named type.",
      kind: "object",
      properties: { children: { kind: "array", element: { kind: "ref", name: "Outline" } }, title: { kind: "string" } },
    });
    const { properties } = schema.shapes.Note as { properties: Record<string, ApiShape> };
    expect([properties.created, properties.size, properties.body])
      .toEqual([{ kind: "date" }, { kind: "bigint" }, { kind: "bytes" }]);
    expect(properties.tags).toEqual({ kind: "union", branches: [{ kind: "array", element: { kind: "string" } },
      { kind: "undefined" }] });
  });

  test("keeps a named type's doc and its properties' docs, with their @deprecated tags", () => {
    const { shapes } = extractSchema(FIXTURE);
    expect(shapes.Mood).toEqual({
      doc: "A string-literal union.",
      kind: "union",
      branches: [{ kind: "literal", value: "busy" }, { kind: "literal", value: "calm" }],
    });
    // Only the documented properties have an entry; a deprecated one keeps its tag in `doc` too.
    expect((shapes.Note as Extract<ApiShape, { kind: "object" }>).propertyDocs).toEqual({
      heading: { doc: "Its first line, from before titles.\n@deprecated Read title.\n@since 1", deprecated: "Read title.",
        tags: { since: "1" } },
      tags: { doc: "Optional, so a union with `undefined`." },
    });
    expect(shapes.Outline).not.toHaveProperty("propertyDocs");
    expect(Object.keys(shapes.Note!)).toEqual(["doc", "kind", "properties", "propertyDocs"]);
  });

  test("records the constants and the docs, @param text on the parameter", () => {
    const schema = extractSchema(FIXTURE);
    expect(schema.constants).toEqual({ SERVICE_SALT: [1, 2, 254, 255] });
    const open = schema.services.FixtureAuthedApi!.methods.find((m) => m.name === "openNotebook")!;
    expect(open.doc).toBe("A capability hop, with an optional callback that is never passed.\n@param id The notebook's ID.");
    expect(open.params[0]!.doc).toBe("The notebook's ID.");
    expect(schema.services.FixtureAuthedApi!.doc).toBe("The authenticated API, as upstream's AuthenticatedApi.");
  });

  test("names its format first", () => {
    const schema = extractSchema(FIXTURE);
    expect(schema.format).toBe(FORMAT);
    expect(Object.keys(schema)).toEqual(["format", "entry", "constants", "services", "shapes"]);
  });

  test("marks which side implements each service", () => {
    const { services } = extractSchema(FIXTURE);
    expect(Object.fromEntries(Object.entries(services).map(([name, service]) => [name, service.direction]))).toEqual({
      // Reached through the parameters of a client-implemented interface and of a function.
      Cursor: "server",
      FixtureAdmin: "server",
      FixtureAuthedApi: "server",
      FixturePublicApi: "server",
      LegacyNotes: "server",
      Notebook: "server",
      NotesSubscriber: "client",
      // Returned as a handle, and passed back to `LegacyNotes.release`.
      "{}": "both",
    });
  });

  test("records properties, @deprecated and @mutates, and omits them when absent", () => {
    const { services } = extractSchema(FIXTURE);
    const method = (service: string, name: string) => services[service]!.methods.find((m) => m.name === name)!;
    expect(services.FixturePublicApi!.properties).toEqual([
      { name: "build", doc: "An optional property.\n@deprecated Read version.", type: { kind: "number" }, optional: true,
        deprecated: "Read version." },
      { name: "version", doc: "A property, read by pipelining.", type: { kind: "string" }, optional: false },
    ]);
    expect(services.FixturePublicApi!.methods.map((m) => m.name)).not.toContain("version");
    expect("properties" in services.Notebook!).toBe(false);

    expect(services.LegacyNotes!.deprecated).toBe("Kept for clients from before accounts.");
    expect(services.LegacyNotes!.doc).toBe("@deprecated Kept for clients from before accounts.");
    expect(method("FixturePublicApi", "legacy").deprecated).toBe("Use authenticate.");
    expect(method("FixturePublicApi", "legacy").doc).toBe("The notes API from before accounts.\n@deprecated Use authenticate.");
    expect(method("LegacyNotes", "list").deprecated).toBe("");
    expect("deprecated" in services.Notebook!).toBe(false);
    expect("deprecated" in method("LegacyNotes", "release")).toBe(false);

    expect(method("Notebook", "file").mutates).toBe(true);
    expect("mutates" in method("Notebook", "upload")).toBe(false);
    // The tags the format does not model; @mutates and @param have fields of their own.
    expect(method("Notebook", "file").tags).toEqual({ since: "2" });
    expect("tags" in method("Notebook", "upload")).toBe(false);
    expect("tags" in method("FixtureAuthedApi", "openNotebook")).toBe(false);
  });

  test("is deterministic across separate programs", () => {
    expect(JSON.stringify(extractSchema(FIXTURE))).toBe(JSON.stringify(extractSchema(FIXTURE)));
  });
});

test("normalizes doc text", () => {
  expect(normalizeDoc("  first  \r\nsecond\t\r\n\r\n\r\n\n third\n")).toBe("first\nsecond\n\n third");
  expect(normalizeDoc("")).toBe("");
});

// A gatekeeper's src/app-api.ts re-exports its app UI's interface as AppApi (scripts/generate.ts), which the
// checker reads as the interface itself.
test("follows a re-exported entry to the interface it names, which keeps its own name", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "api-schema-reexport-")));
  try {
    writeFileSync(join(dir, "types.ts"), "export interface PanelApi { open(): Promise<string>; }\n");
    writeFileSync(join(dir, "app-api.ts"), 'export type { PanelApi as AppApi } from "./types";\n');
    const schema = extractSchema({ entry: join(dir, "app-api.ts"), compilerOptions: STRICT, entryName: "AppApi", constants: [] });
    expect(schema.entry).toBe("PanelApi");
    expect(Object.keys(schema.services)).toEqual(["PanelApi"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// What the generator hashes to tell when its files are stale: a config the tsconfig extends can change
// the schema (`strictNullChecks` drops a result's `null`) as surely as a source can.
test("reports the files it read: the tsconfig, the configs it extends, and every source loaded", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "api-schema-sources-")));
  try {
    writeFileSync(join(dir, "base.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base.json", compilerOptions: { types: [] } }));
    writeFileSync(join(dir, "names.ts"), "export type Name = string;\n");
    writeFileSync(join(dir, "api.ts"), 'import type { Name } from "./names";\nexport interface Api { name(): Promise<Name | null>; }\n');
    const { sources } = extractSchemaAndSources({ entry: join(dir, "api.ts"), tsconfig: join(dir, "tsconfig.json"), entryName: "Api" });
    const own = sources.filter((path) => path.startsWith(dir)).map((path) => path.slice(dir.length + 1));
    expect(own.toSorted()).toEqual(["api.ts", "base.json", "names.ts", "tsconfig.json"]);
    expect(sources.some((path) => /[\\/]lib\.[\w.]*\.d\.ts$/.test(path))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("refuses what the schema cannot describe, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-extract-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const extract = (source: string, entryName = "Api") => {
    const entry = join(dir, `api-${files++}.ts`);
    writeFileSync(entry, source);
    return () => extractSchema({ entry, compilerOptions: STRICT, entryName, constants: [] });
  };

  test("an overloaded method", () => {
    expect(extract("export interface Api { a(x: string): void; a(x: number): void; }")).toThrow(/Api\.a: overloaded/);
  });
  test("a rest parameter", () => {
    expect(extract("export interface Api { a(...xs: string[]): void; }")).toThrow(/Api\.a: rest parameter xs/);
  });
  test("a tuple element after the variadic one", () => {
    expect(extract("export interface Api { a(): Promise<[...string[], number]>; }"))
      .toThrow(/\[\.\.\.string\[\], number\]: an element after the variadic one/);
    expect(extract("export interface Api { a(): Promise<[boolean, ...string[], number]>; }"))
      .toThrow(/an element after the variadic one/);
  });
  test("a missing entry interface", () => {
    expect(extract("export interface Other { a(): void; }")).toThrow(/no exported Api/);
  });
  test("a constant that is not a byte array", () => {
    expect(() => extractSchema({ ...FIXTURE, constants: ["Mood"] })).toThrow(/Mood is not an exported `new Uint8Array/);
  });
  // An unresolved type would read as `any`: a capability quietly turned into an untyped value.
  test("an API that does not type-check", () => {
    expect(extract('import type { Missing } from "./nowhere.ts";\nexport interface Api { a(): Promise<Missing>; }'))
      .toThrow(/does not type-check[\s\S]*nowhere/);
  });
});

describe("members, tags and streams", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-members-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const extract = (source: string) => {
    const entry = join(dir, `api-${files++}.ts`);
    writeFileSync(entry, source);
    return extractSchema({ entry, compilerOptions: STRICT, entryName: "Api", constants: [] });
  };

  test("a non-method member is a property, an optional method still a method", () => {
    const { services } = extract(`export interface Sub { ping(): void; }
export interface Api { a(): void; b?(): void; readonly c: string; d?: Sub | null; get e(): number; }
`);
    expect(services.Api!.methods.map((m) => m.name)).toEqual(["a", "b"]);
    expect(services.Api!.properties).toEqual([
      { name: "c", doc: "", type: { kind: "string" }, optional: false },
      { name: "d", doc: "", type: { kind: "union", branches: [{ kind: "null" }, { kind: "stub", service: "Sub" }] },
        optional: true },
      { name: "e", doc: "", type: { kind: "number" }, optional: false },
    ]);
    // A property's value comes from the side implementing the service.
    expect(services.Sub!.direction).toBe("server");
  });

  // capnweb serves an `RpcTarget`'s prototype, not its instance: a field, even one holding a
  // function, cannot be read or called over RPC, while a getter can.
  test("a class's surface is its prototype's members: its getters and methods, not its fields", () => {
    const { services } = extract(`export class Api {
  constructor(readonly id: string) {}
  readonly kind = "api";
  handler = () => 1;
  get size(): number { return 0; }
  ping(): void {}
}
`);
    expect(services.Api!.methods.map((m) => m.name)).toEqual(["ping"]);
    expect(services.Api!.properties).toEqual([{ name: "size", doc: "", type: { kind: "number" }, optional: false }]);
  });

  test("the entry reached again is a stub of it, whatever its members", () => {
    for (const member of ["b: string;", "b?(): void;"]) {
      const { services, shapes } = extract(`export interface Api { a(): Promise<Api>; ${member} }\n`);
      expect(services.Api!.methods[0]!.returns).toEqual({ kind: "stub", service: "Api" });
      expect(shapes).toEqual({});
    }
  });

  test("a stream's element type, absent when undeclared or any", () => {
    const { services } = extract(`export interface Api {
  a(): Promise<ReadableStream<string>>; b(): Promise<ReadableStream>; c(): Promise<ReadableStream<any>>;
  d(): Promise<WritableStream<Uint8Array>>;
}
`);
    expect(services.Api!.methods.map((m) => m.returns)).toEqual([
      { kind: "readableStream", element: { kind: "string" } },
      { kind: "readableStream" },
      { kind: "readableStream" },
      { kind: "writableStream", element: { kind: "bytes" } },
    ]);
  });

  test("a tuple's rest element, an array of arrays as one, a variadic type parameter as its element", () => {
    const { services } = extract(`export interface Api {
  a(): [string, ...number[]]; b(): [string, ...number[][]]; c<T extends boolean[]>(): [string, ...T];
}
`);
    expect(services.Api!.methods.map((m) => m.returns)).toEqual([
      { kind: "tuple", elements: [{ kind: "string" }], rest: { kind: "number" } },
      { kind: "tuple", elements: [{ kind: "string" }], rest: { kind: "array", element: { kind: "number" } } },
      { kind: "tuple", elements: [{ kind: "string" }], rest: { kind: "boolean" } },
    ]);
  });

  test("@mutates and @deprecated, read from the tag wherever it is in the comment", () => {
    const method = extract(`export interface Api {
  /**
   * Saves.
   * @deprecated Use
   * saveAll.
   * @mutates
   */
  save(): void;
}
`).services.Api!.methods[0]!;
    expect(method).toEqual({ name: "save", doc: "Saves.\n@deprecated Use\nsaveAll.\n@mutates", params: [],
      returns: { kind: "void" }, deprecated: "Use\nsaveAll.", mutates: true });
  });

  test("every other tag, by name, on services, methods, properties, named types and object properties", () => {
    const { services, shapes } = extract(`/** @audience agents */
export interface Api {
  /**
   * Opens.
   * @param id Which.
   * @returns The thing.
   * @throws When it is missing.
   * @example api.open("a")
   * @see close
   * @mutates
   * @category files
   * @beta
   * @since 2
   * @since and again
   */
  open(id: string): Promise<Config>;
  /** @since 3 */
  readonly version: string;
  /** No tags. */
  close(): void;
}
/** A configuration. @since 1 */
export type Config = {
  /**
   * The token.
   * @secret
   */
  token: string;
  /** Plain. */
  name: string;
};
`);
    const [close, open] = services.Api!.methods;
    expect(services.Api!.tags).toEqual({ audience: "agents" });
    // Sorted by name; a repeated tag's texts joined; a bare one "". The doc keeps every tag.
    expect(open!.tags).toEqual({ beta: "", category: "files", since: "2\nand again" });
    expect(Object.keys(open!.tags!)).toEqual(["beta", "category", "since"]);
    expect(open!.doc).toContain("@throws When it is missing.");
    expect(open!.mutates).toBe(true);
    expect("tags" in close!).toBe(false);
    expect(services.Api!.properties![0]!.tags).toEqual({ since: "3" });
    expect(shapes.Config).toMatchObject({ tags: { since: "1" } });
    expect((shapes.Config as Extract<ApiShape, { kind: "object" }>).propertyDocs).toEqual({
      name: { doc: "Plain." },
      token: { doc: "The token.\n@secret", tags: { secret: "" } },
    });
  });
});

describe("which side implements each service", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-direction-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const directions = (source: string) => {
    const entry = join(dir, `api-${files++}.ts`);
    writeFileSync(entry, source);
    const { services } = extractSchema({ entry, compilerOptions: STRICT, entryName: "Api", constants: [] });
    return Object.fromEntries(Object.entries(services).map(([name, service]) => [name, service.direction]));
  };
  // Method-only interfaces are capabilities, so these need no capnweb.
  const SERVICES = `export interface Handle { close(): void; }
export interface Reply { send(text: string): void; }
`;

  test("a result is the implementer's, a parameter the other side's, swapped across a client service", () => {
    expect(directions(`${SERVICES}export interface Sub { event(handle: Handle): Promise<Reply>; }
export interface Api { open(): Promise<Handle>; subscribe(sub: Sub): void; }
`)).toEqual({ Api: "server", Handle: "server", Reply: "client", Sub: "client" });
  });

  test("a function swaps the same way, as a parameter or as a result", () => {
    expect(directions(`${SERVICES}export interface Api { watch(callback: (handle: Handle) => Reply): void; }
`)).toEqual({ Api: "server", Handle: "server", Reply: "client" });
    expect(directions(`${SERVICES}export interface Api { sender(): Promise<(reply: Reply) => Handle>; }
`)).toEqual({ Api: "server", Handle: "server", Reply: "client" });
  });

  test("through named shapes, collections and writable streams' elements", () => {
    expect(directions(`${SERVICES}export type Wrapped = { handles: Map<string, Handle[]>; replies?: [Reply] };
export interface Api {
  give(wrapped: Wrapped): void; take(): Promise<Wrapped>; feed(): Promise<WritableStream<Reply>>;
  drain(): Promise<ReadableStream<Handle>>;
}
`)).toEqual({ Api: "server", Handle: "both", Reply: "both" });
    expect(directions(`${SERVICES}export interface Api { feed(): Promise<WritableStream<Reply>>; }
`)).toEqual({ Api: "server", Reply: "client" });
  });

  // Whichever way it is reached first, a service reached both ways is walked as each side's, so what
  // it reaches is too.
  test("a service reached both ways, and what it reaches", () => {
    const thing = "export interface Thing { listen(reply: Reply): void; open(): Promise<Handle>; }\n";
    const expected = { Api: "server", Handle: "both", Reply: "both", Thing: "both" };
    expect(directions(`${SERVICES}${thing}export interface Api { a(thing: Thing): void; b(): Promise<Thing>; }
`)).toEqual(expected);
    expect(directions(`${SERVICES}${thing}export interface Api { a(): Promise<Thing>; b(thing: Thing): void; }
`)).toEqual(expected);
  });
});

/** `RpcStub<RpcTarget>` read as untyped, with no `RpcTarget` service beside `Api` and `Sub`. */
function expectUntypedRpcTarget(schema: Schema) {
  expect(Object.keys(schema.services)).toEqual(["Api", "Sub"]);
  expect(schema.services.Api!.methods.map((m) => m.returns)).toEqual([{ kind: "stub" }, { kind: "stub", service: "Sub" }]);
}

// capnweb's base types are recognised by where they are installed, or by `isRuntimeFile`: TypeScript
// reads a linked package at its real path, which has no `node_modules/capnweb/` in it, and capnweb's
// own fixtures import its sources directly.
describe("recognises capnweb's declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-runtime-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const installed = realpathSync(join(PACKAGE, "node_modules", "capnweb"));
  for (const copy of ["checkout/capnweb", "vendor/capnweb"]) {
    mkdirSync(join(dir, copy, "dist"), { recursive: true });
    cpSync(join(installed, "package.json"), join(dir, copy, "package.json"));
    cpSync(join(installed, "dist", "index.d.ts"), join(dir, copy, "dist", "index.d.ts"));
  }
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(installed, join(dir, "node_modules", "capnweb"), "dir");
  const options = { strict: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    // capnweb's declarations import `node:http`, which this directory has no types for.
    skipLibCheck: true };
  const extract = (from: string, isRuntimeFile?: (fileName: string) => boolean) => {
    const entry = join(dir, `api-${from.replace(/\W+/g, "-")}${isRuntimeFile ? "-named" : ""}.ts`);
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from ${JSON.stringify(from)};
export interface Sub extends RpcTarget { ping(): Promise<void>; }
export interface Api extends RpcTarget { any(): Promise<RpcStub<RpcTarget>>; sub(): Promise<RpcStub<Sub>>; }
`);
    return extractSchema({ entry, entryName: "Api", compilerOptions: options, ...(isRuntimeFile ? { isRuntimeFile } : {}) });
  };
  test("an installed package", () => {
    expectUntypedRpcTarget(extract("capnweb"));
  });
  test("a vendored copy, named by the isRuntimeFile option", () => {
    expectUntypedRpcTarget(extract("./vendor/capnweb/dist/index.js", (file) => file.includes("/vendor/capnweb/")));
  });
  test("an RpcTarget from a copy not named is taken for the API's own, an empty service", () => {
    const schema = extract("./checkout/capnweb/dist/index.js");
    expect(schema.services.Api!.methods[0]!.returns).toEqual({ kind: "stub", service: "RpcTarget" });
  });
  // capnweb types a declared RpcPromise<X> result as it does Promise<X>: X's own shape.
  test("an RpcPromise result, the shape of what it resolves to", () => {
    const entry = join(dir, "api-rpc-promise.ts");
    writeFileSync(entry, `import type { RpcPromise, RpcTarget } from "capnweb";
export interface Sub extends RpcTarget { ping(): Promise<void>; }
export interface Api extends RpcTarget {
  count(): RpcPromise<number>; record(): RpcPromise<{ title: string }>; sub(): RpcPromise<Sub>;
}
`);
    const schema = extractSchema({ entry, entryName: "Api", compilerOptions: options });
    expect(Object.keys(schema.services)).toEqual(["Api", "Sub"]);
    expect(schema.services.Api!.methods.map((m) => m.returns)).toEqual([
      { kind: "number" },
      { kind: "object", properties: { title: { kind: "string" } } },
      { kind: "stub", service: "Sub" },
    ]);
  });
  // capnweb accepts RpcStub<X> for an unbranded X, which the graph may already hold as a value.
  test("a value type also used as a capability, refused naming it", () => {
    const entry = join(dir, "api-value-stub.ts");
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from "capnweb";
export interface X { a(): void; b: string; }
export interface Api extends RpcTarget { get(): Promise<X>; stub(): Promise<RpcStub<X>>; }
`);
    expect(() => extractSchema({ entry, entryName: "Api", compilerOptions: options }))
      .toThrow(/X: a value elsewhere in the graph, so it cannot also be a capability/);
  });
  test("a capability also used as a value, refused whichever is reached first", () => {
    const entry = join(dir, "api-stub-value.ts");
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from "capnweb";
export interface X { a(): void; b: string; }
export interface Api extends RpcTarget { get(): Promise<RpcStub<X>>; stub(): Promise<X>; }
`);
    expect(() => extractSchema({ entry, entryName: "Api", compilerOptions: options }))
      .toThrow(/X: a capability elsewhere in the graph, so it cannot also be a value/);
  });
  // `RpcStub<{}>` and a value `{}` are one type to TypeScript.
  test("an anonymous type both a stub's target and a value, inlined whichever is reached first", () => {
    const entry = join(dir, "api-anonymous-stub-value.ts");
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from "capnweb";
export interface Api extends RpcTarget { a(): Promise<RpcStub<{}>>; b(): Promise<{ input: {} }>; }
export interface Api2 extends RpcTarget { a(): Promise<{ input: {} }>; b(): Promise<RpcStub<{}>>; }
`);
    for (const [entryName, stub, value] of [["Api", 0, 1], ["Api2", 1, 0]] as const) {
      const methods = extractSchema({ entry, entryName, compilerOptions: options }).services[entryName]!.methods;
      expect(methods[stub]!.returns).toEqual({ kind: "stub", service: "{}" });
      expect(methods[value]!.returns)
        .toEqual({ kind: "object", properties: { input: { kind: "object", properties: {} } } });
    }
  });
  // An API's own augmentation of capnweb merges into its interfaces, but its members are the API's.
  test("an augmentation of the runtime module, whose members are the API's own", () => {
    const entry = join(dir, "api-augmented.ts");
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from "capnweb";
declare module "capnweb" { interface RpcTarget { extra(): Promise<string>; } }
export interface Sub extends RpcTarget { ping(): Promise<void>; }
export interface Api extends RpcTarget { own(): Promise<number>; sub(): Promise<RpcStub<Sub>>; }
`);
    const schema = extractSchema({ entry, entryName: "Api", compilerOptions: options });
    expect(schema.services.Api!.methods.map((m) => m.name)).toEqual(["extra", "own", "sub"]);
    expect(schema.services.Sub!.methods.map((m) => m.name)).toEqual(["extra", "ping"]);
  });
});

// The Workers runtime's types reach an API through workers-types' global declarations, which a
// `types` entry loads as a script rather than as a module: their members are the runtime's too.
describe("recognises the Workers runtime's global types", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-workers-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "node_modules", "@cloudflare"), { recursive: true });
  symlinkSync(realpathSync(join(PACKAGE, "node_modules", "capnweb")), join(dir, "node_modules", "capnweb"), "dir");
  symlinkSync(realpathSync(join(PACKAGE, "node_modules", "@cloudflare", "workers-types")),
    join(dir, "node_modules", "@cloudflare", "workers-types"), "dir");
  const options = { strict: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true, lib: ["lib.esnext.d.ts"], types: ["@cloudflare/workers-types/experimental"] };
  const extract = (name: string, source: string, isRuntimeFile?: (fileName: string) => boolean) => {
    const entry = join(dir, `${name}.ts`);
    writeFileSync(entry, `import type { RpcStub, RpcTarget } from "capnweb";\n${source}`);
    return extractSchema({ entry, entryName: "Api", compilerOptions: options, ...(isRuntimeFile ? { isRuntimeFile } : {}) });
  };
  test("an interface extending the global DurableObject keeps only its own methods", () => {
    const schema = extract("api", `export interface Room extends DurableObject { greet(name: string): Promise<string>; }
export interface Api extends RpcTarget { room(): Promise<RpcStub<Room>>; binding(): Promise<Fetcher>;
  object(): Promise<RpcStub<DurableObject>>; }
`);
    expect(schema.services.Room!.methods.map((m) => m.name)).toEqual(["greet"]);
    expect(schema.services.Api!.methods.find((m) => m.name === "object")!.returns).toEqual({ kind: "stub" });
    const binding = schema.services.Api!.methods.find((m) => m.name === "binding")!.returns;
    expect(binding.kind === "stub" && binding.service && schema.services[binding.service]!.methods).toEqual([]);
    expect(Object.keys(schema.services).toSorted()).toEqual(["Api", "Room", (binding as { service: string }).service]
      .toSorted());
  });
  test("with workers-types not recognised, its members are taken for the API's own", () => {
    const schema = extract("api-unnamed", `export interface Room extends DurableObject { greet(name: string): Promise<string>; }
export interface Api extends RpcTarget { room(): Promise<RpcStub<Room>>; }
`, (file) => file.includes("/node_modules/capnweb/"));
    expect(schema.services.Room!.methods.map((m) => m.name)).toContain("alarm");
  });
  test("a global augmentation of the runtime's interface, whose members are the API's own", () => {
    const schema = extract("api-augmented", `declare global { interface DurableObject { extra(): Promise<string>; } }
export interface Room extends DurableObject { greet(name: string): Promise<string>; }
export interface Api extends RpcTarget { room(): Promise<RpcStub<Room>>; }
`);
    expect(schema.services.Room!.methods.map((m) => m.name)).toEqual(["extra", "greet"]);
  });
});

/** The method names an interface declares in `file`, read from the syntax alone. */
function declaredMethods(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const declaration = source.statements.find((s): s is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(s) && s.name.text === name);
  expect(declaration, `${name} in ${file}`).toBeDefined();
  return declaration!.members.filter(ts.isMethodSignature).map((member) => member.name.getText(source)).toSorted();
}

test("workshop-shared's API: the whole graph, and every subscriber's full method list", () => {
  const schema = extractSchema(WORKSHOP_API);
  const method = (service: string, name: string) => schema.services[service]?.methods.find((m) => m.name === name);
  expect(method("PublicApi", "authenticate")?.returns).toEqual({ kind: "stub", service: "AuthenticatedApi" });
  expect(method("AuthenticatedApi", "openWorkspace")?.returns).toEqual({ kind: "stub", service: "Overseer" });
  expect(method("Overseer", "getGadget")?.returns).toEqual({ kind: "stub", service: "GadgetClient" });
  expect(method("GadgetClient", "connectToGadget")?.returns).toEqual({ kind: "stub" });
  expect(schema.constants.SERVICE_SALT?.length).toBe(16);
  for (const name of ["PublicApi", "AuthenticatedApi", "Overseer"]) expect(schema.services[name]?.direction, name).toBe("server");

  const methods = Object.values(schema.services).reduce((n, service: SchemaService) => n + service.methods.length, 0);
  expect(methods, `${methods} methods`).toBeGreaterThan(150);

  const subscribers = new Map<string, string>();
  let functions = 0;
  for (const [service, { methods: list }] of Object.entries(schema.services)) {
    for (const m of list.filter((x) => x.name.startsWith("subscribe"))) {
      const callback = m.params[0]!.type;
      if (callback.kind === "function") {
        functions++;
        expect(callback.params.map((p) => p.name), `${service}.${m.name}`).toEqual(["metadata"]);
      } else {
        expect(callback.kind, `${service}.${m.name}`).toBe("stub");
        subscribers.set(`${service}.${m.name}`, (callback as { service: string }).service);
      }
    }
  }
  expect(functions).toBe(1);
  expect([...new Set(subscribers.values())].toSorted()).toEqual([
    "ActionsSubscriber", "AiChatSubscriber", "ConnectedAccountsSubscriber", "ConsoleLogSubscriber",
    "NotificationSubscriber", "PresenceSubscriber", "WorkpiecesSubscriber",
  ]);
  // A client-implemented interface keeps every method it declares, so the client can implement it
  // from the schema alone.
  for (const name of subscribers.values()) {
    expect(schema.services[name]!.methods.map((m) => m.name), name).toEqual(declaredMethods(WORKSHOP_API.entry, name));
    expect(schema.services[name]!.direction, name).toBe("client");
  }
  expect(schema.services.AiChatSubscriber!.methods.some((m) => m.name === "changeApplied")).toBe(true);
});
