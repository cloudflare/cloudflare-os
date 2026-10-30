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
import { type ExtractOptions, extractSchema, normalizeDoc } from "../src/extract.ts";
import type { ApiShape, Schema, SchemaService } from "../src/schema.ts";

const PACKAGE = join(import.meta.dirname, "..");
const FIXTURES = join(import.meta.dirname, "__fixtures__");
const FIXTURE: ExtractOptions = {
  entry: join(FIXTURES, "api.ts"),
  tsconfig: join(PACKAGE, "tsconfig.json"),
  entryName: "FixturePublicApi",
  constants: ["SERVICE_SALT"],
};
const EXPECTED_SCHEMA = join(FIXTURES, "schema.json");

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
    expect(method("FixturePublicApi", "download").returns).toEqual({ kind: "readableStream" });
    expect(method("FixtureAuthedApi", "importArchive").params[0]!.type).toEqual({ kind: "readableStream" });
    // The client-implemented interface is recorded with every method, and the bare function with
    // its signature.
    expect(method("Notebook", "subscribe").params[0]!.type).toEqual({ kind: "stub", service: "NotesSubscriber" });
    expect(schema.services.NotesSubscriber!.methods.map((m) => [m.name, m.params.map((p) => p.name)]))
      .toEqual([["added", ["note"]], ["ready", []], ["removed", ["id"]]]);
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
      kind: "object",
      properties: { children: { kind: "array", element: { kind: "ref", name: "Outline" } }, title: { kind: "string" } },
    });
    const { properties } = schema.shapes.Note as { properties: Record<string, ApiShape> };
    expect([properties.created, properties.size, properties.body])
      .toEqual([{ kind: "date" }, { kind: "bigint" }, { kind: "bytes" }]);
    expect(properties.tags).toEqual({ kind: "union", branches: [{ kind: "array", element: { kind: "string" } },
      { kind: "undefined" }] });
  });

  test("records the constants and the docs, @param text on the parameter", () => {
    const schema = extractSchema(FIXTURE);
    expect(schema.constants).toEqual({ SERVICE_SALT: [1, 2, 254, 255] });
    const open = schema.services.FixtureAuthedApi!.methods.find((m) => m.name === "openNotebook")!;
    expect(open.doc).toBe("A capability hop, with an optional callback that is never passed.\n@param id The notebook's ID.");
    expect(open.params[0]!.doc).toBe("The notebook's ID.");
    expect(schema.services.FixtureAuthedApi!.doc).toBe("The authenticated API, as upstream's AuthenticatedApi.");
  });

  test("is deterministic across separate programs", () => {
    expect(JSON.stringify(extractSchema(FIXTURE))).toBe(JSON.stringify(extractSchema(FIXTURE)));
  });
});

test("normalizes doc text", () => {
  expect(normalizeDoc("  first  \r\nsecond\t\r\n\r\n\r\n\n third\n")).toBe("first\nsecond\n\n third");
  expect(normalizeDoc("")).toBe("");
});

describe("refuses what the schema cannot describe, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-schema-extract-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const extract = (source: string, entryName = "Api") => {
    const entry = join(dir, `api-${files++}.ts`);
    writeFileSync(entry, source);
    return () => extractSchema({ entry, compilerOptions: { strict: true }, entryName, constants: [] });
  };

  test("an overloaded method", () => {
    expect(extract("export interface Api { a(x: string): void; a(x: number): void; }")).toThrow(/Api\.a: overloaded/);
  });
  test("a rest parameter", () => {
    expect(extract("export interface Api { a(...xs: string[]): void; }")).toThrow(/Api\.a: rest parameter xs/);
  });
  test("a property", () => {
    expect(extract("export interface Api { a(): void; b: string; }")).toThrow(/Api\.b: a property/);
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
  expect(method("AuthenticatedApi", "openGadget")?.returns).toEqual({ kind: "stub", service: "Overseer" });
  expect(method("Overseer", "getGadget")?.returns).toEqual({ kind: "stub", service: "GadgetClient" });
  expect(method("GadgetClient", "connectToGadget")?.returns).toEqual({ kind: "stub" });
  expect(schema.constants.SERVICE_SALT?.length).toBe(16);

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
  }
  expect(schema.services.AiChatSubscriber!.methods.some((m) => m.name === "changeApplied")).toBe(true);
});
