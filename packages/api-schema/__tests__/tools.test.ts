// The tool-catalog emitter, against small hand-built schemas (one per rule), the extractor's fixture
// and this repository's own `workshop-shared/src/api.ts`, whose every tool schema must be a
// structurally valid JSON Schema with each `$ref` resolving inside it.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { emitToolCatalog, type JsonSchema, type Tool, type ToolCatalog } from "../src/emit/tools.ts";
import { extractSchema } from "../src/extract.ts";
import {
  FORMAT, type ApiShape, type Schema, type SchemaMethod, type SchemaProperty, type SchemaService, type SchemaShape,
} from "../src/schema.ts";

const PACKAGE = join(import.meta.dirname, "..");

const method = (name: string, params: [string, ApiShape, boolean?, string?][], returns: ApiShape = { kind: "void" },
  doc = ""): SchemaMethod => ({
  name,
  doc,
  params: params.map(([param, type, optional = false, paramDoc = ""]) => ({ name: param, type, optional, doc: paramDoc })),
  returns,
});
const service = (...methods: SchemaMethod[]): SchemaService => ({ doc: "", direction: "server", methods });
const clientService = (...methods: SchemaMethod[]): SchemaService => ({ ...service(...methods), direction: "client" });
const schemaProperty = (name: string, type: ApiShape): SchemaProperty => ({ name, doc: "", type, optional: false });
const schemaOf = (services: Record<string, SchemaService>, shapes: Record<string, SchemaShape> = {}): Schema =>
  ({ format: FORMAT, entry: Object.keys(services)[0]!, constants: {}, services, shapes });
const stub = (name?: string): ApiShape => name === undefined ? { kind: "stub" } : { kind: "stub", service: name };
const ref = (name: string): ApiShape => ({ kind: "ref", name });
const toolOf = (catalog: ToolCatalog, id: string): Tool => {
  const found = catalog.tools.find((tool) => tool.id === id);
  expect(found, id).toBeDefined();
  return found!;
};
/** The single parameter `x` of the one tool of a schema with one method, `Api.m(x)`. */
const paramSchema = (type: ApiShape, shapes: Record<string, SchemaShape> = {}) =>
  emitToolCatalog(schemaOf({ Api: service(method("m", [["x", type]])) }, shapes), { root: "Api" })
    .tools[0]!.inputSchema.properties.x;

describe("maps each shape to JSON Schema", () => {
  test("scalars, literals and any", () => {
    expect(paramSchema({ kind: "string" })).toEqual({ type: "string" });
    expect(paramSchema({ kind: "number" })).toEqual({ type: "number" });
    expect(paramSchema({ kind: "boolean" })).toEqual({ type: "boolean" });
    expect(paramSchema({ kind: "null" })).toEqual({ type: "null" });
    expect(paramSchema({ kind: "undefined" })).toEqual({ type: "null", "x-capnweb-kind": "undefined" });
    expect(paramSchema({ kind: "literal", value: "on" })).toEqual({ const: "on" });
    expect(paramSchema({ kind: "literal", value: 3 })).toEqual({ const: 3 });
    expect(paramSchema({ kind: "any" })).toEqual({});
  });

  test("bigint, Date and bytes in their JSON spellings, marked", () => {
    expect(paramSchema({ kind: "bigint" })).toEqual({ type: "string", pattern: "^-?[0-9]+$", "x-capnweb-kind": "bigint" });
    expect(paramSchema({ kind: "date" })).toEqual({ type: "string", format: "date-time", "x-capnweb-kind": "date" });
    expect(paramSchema({ kind: "bytes" }))
      .toEqual({ type: "string", contentEncoding: "base64", "x-capnweb-kind": "bytes" });
  });

  test("unions: enum when every branch is a literal, anyOf otherwise", () => {
    expect(paramSchema({ kind: "union", branches: [{ kind: "literal", value: "a" }, { kind: "literal", value: 1 }] }))
      .toEqual({ enum: ["a", 1] });
    expect(paramSchema({ kind: "union", branches: [{ kind: "null" }, { kind: "literal", value: "a" }] }))
      .toEqual({ anyOf: [{ type: "null" }, { const: "a" }] });
    expect(paramSchema({ kind: "union", branches: [{ kind: "null" }, stub("Api")] }))
      .toEqual({ anyOf: [{ type: "null" }, { "x-capnweb-kind": "capability", "x-capnweb-service": "Api" }] });
  });

  test("arrays, tuples, sets and maps", () => {
    expect(paramSchema({ kind: "array", element: { kind: "string" } })).toEqual({ type: "array", items: { type: "string" } });
    expect(paramSchema({ kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }] }))
      .toEqual({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, items: false });
    expect(paramSchema({ kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }], minLength: 1,
      rest: { kind: "boolean" } }))
      .toEqual({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 1,
        items: { type: "boolean" } });
    // `prefixItems` must not be empty: an empty tuple is a closed empty array, a rest-only one an array.
    expect(paramSchema({ kind: "tuple", elements: [] })).toEqual({ type: "array", items: false });
    expect(paramSchema({ kind: "tuple", elements: [], rest: { kind: "string" } }))
      .toEqual({ type: "array", items: { type: "string" } });
    for (const elements of [[], [{ kind: "string" }]] satisfies ApiShape[][]) {
      expect(structuralErrors(paramSchema({ kind: "tuple", elements })!)).toEqual([]);
    }
    expect(paramSchema({ kind: "set", element: { kind: "number" } }))
      .toEqual({ type: "array", items: { type: "number" }, "x-capnweb-kind": "set" });
    expect(paramSchema({ kind: "map", key: { kind: "string" }, value: { kind: "date" } })).toEqual({
      type: "array",
      items: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "string", format: "date-time", "x-capnweb-kind": "date" }],
        minItems: 2,
        items: false,
      },
      "x-capnweb-kind": "map",
    });
  });

  test("objects: optional properties lose their undefined, an index opens them", () => {
    expect(paramSchema({
      kind: "object",
      properties: {
        always: { kind: "string" },
        maybe: { kind: "union", branches: [{ kind: "number" }, { kind: "undefined" }] },
        either: { kind: "union", branches: [{ kind: "null" }, { kind: "string" }, { kind: "undefined" }] },
        never: { kind: "undefined" },
      },
    })).toEqual({
      type: "object",
      properties: {
        always: { type: "string" },
        maybe: { type: "number" },
        either: { anyOf: [{ type: "null" }, { type: "string" }] },
        never: { type: "null", "x-capnweb-kind": "undefined" },
      },
      required: ["always"],
      additionalProperties: false,
    });
    expect(paramSchema({ kind: "object", properties: {}, index: { kind: "number" } }))
      .toEqual({ type: "object", properties: {}, additionalProperties: { type: "number" } });
  });

  test("names Object.prototype has, such as __proto__, as plain keys", () => {
    const properties: Record<string, ApiShape> = JSON.parse('{"__proto__": {"kind": "string"}}');
    const object = paramSchema({ kind: "object", properties });
    expect(Object.keys(object!.properties!)).toEqual(["__proto__"]);
    expect(object!.required).toEqual(["__proto__"]);
    expect(structuralErrors(object!)).toEqual([]);
    const input = emitToolCatalog(schemaOf({ Api: service(method("m", [["__proto__", { kind: "number" }]])) }),
      { root: "Api" }).tools[0]!.inputSchema;
    expect(Object.keys(input.properties)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(input.properties)).toBe(Object.prototype);
    expect(structuralErrors(input)).toEqual([]);
  });

  test("what cannot travel as JSON, marked for the host to supply", () => {
    expect(paramSchema(stub("Sink"))).toEqual({ "x-capnweb-kind": "capability", "x-capnweb-service": "Sink" });
    expect(paramSchema(stub())).toEqual({ "x-capnweb-kind": "capability" });
    expect(paramSchema({ kind: "function", params: [], returns: { kind: "void" } })).toEqual({ "x-capnweb-kind": "function" });
    expect(paramSchema({ kind: "readableStream" })).toEqual({ "x-capnweb-kind": "stream", "x-capnweb-stream": "readable" });
    expect(paramSchema({ kind: "writableStream" })).toEqual({ "x-capnweb-kind": "stream", "x-capnweb-stream": "writable" });
    expect(paramSchema({ kind: "typedArray", name: "Int32Array" }))
      .toEqual({ "x-capnweb-kind": "typedArray", "x-capnweb-type": "Int32Array" });
    for (const kind of ["error", "arrayBuffer", "dataView", "regexp", "blob", "url", "headers", "request",
      "response"] as const) {
      expect(paramSchema({ kind })).toEqual({ "x-capnweb-kind": kind });
    }
    expect(paramSchema({ kind: "unsupported", reason: "a symbol" }))
      .toEqual({ "x-capnweb-kind": "unsupported", "x-capnweb-reason": "a symbol" });
  });

  test("streams with what they carry, when declared", () => {
    expect(paramSchema({ kind: "readableStream", element: { kind: "bytes" } })).toEqual({
      "x-capnweb-kind": "stream",
      "x-capnweb-stream": "readable",
      "x-capnweb-element": { type: "string", contentEncoding: "base64", "x-capnweb-kind": "bytes" },
    });
    // A named element is one of the tool's `$defs`, like any other reference.
    const input = emitToolCatalog(schemaOf({ Api: service(method("m", [["x", { kind: "writableStream",
      element: ref("Line") }]])) }, { Line: { kind: "string" } }), { root: "Api" }).tools[0]!.inputSchema;
    expect(input.properties.x).toEqual({ "x-capnweb-kind": "stream", "x-capnweb-stream": "writable",
      "x-capnweb-element": { $ref: "#/$defs/Line" } });
    expect(input.$defs).toEqual({ Line: { type: "string" } });
    expect(structuralErrors(input)).toEqual([]);
  });

  test("parameters: declaration order, docs, required, closed", () => {
    const catalog = emitToolCatalog(schemaOf({
      Api: service(method("m", [["z", { kind: "string" }, false, "The first."], ["a", { kind: "number" }, true],
        ["m", ref("Shape"), false, "Named."]], { kind: "void" }, "Does m.")),
    }, { Shape: { kind: "object", properties: {} } }), { root: "Api" });
    const tool = catalog.tools[0]!;
    expect(tool.description).toBe("Does m.");
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["z", "a", "m"]);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        z: { type: "string", description: "The first." },
        a: { type: "number" },
        m: { $ref: "#/$defs/Shape", description: "Named." },
      },
      required: ["z", "m"],
      additionalProperties: false,
      $defs: { Shape: { type: "object", properties: {}, additionalProperties: false } },
    });
    expect(tool.returns).toEqual({ type: "null", "x-capnweb-kind": "undefined" });
  });

  test("deprecated and mutates, as the method has them", () => {
    const catalog = emitToolCatalog(schemaOf({
      Api: service(
        { ...method("bare", []), deprecated: "" },
        { ...method("old", []), deprecated: "Use plain." },
        { ...method("write", []), mutates: true },
        method("plain", []),
      ),
    }), { root: "Api" });
    expect(toolOf(catalog, "Api.bare").deprecated).toBe("");
    expect(toolOf(catalog, "Api.old").deprecated).toBe("Use plain.");
    expect(toolOf(catalog, "Api.old")).not.toHaveProperty("mutates");
    expect(toolOf(catalog, "Api.write").mutates).toBe(true);
    expect(toolOf(catalog, "Api.write")).not.toHaveProperty("deprecated");
    expect(toolOf(catalog, "Api.plain")).not.toHaveProperty("deprecated");
    expect(toolOf(catalog, "Api.plain")).not.toHaveProperty("mutates");
  });
});

describe("reachability", () => {
  const schema = schemaOf({
    Root: service(
      method("open", [["id", { kind: "string" }]], { kind: "union", branches: [{ kind: "null" }, stub("Door")] }),
      method("subscribe", [["subscriber", stub("Listener")], ["callback", { kind: "function", params: [],
        returns: stub("Hidden") }]]),
      method("bundle", [], ref("Bundle")),
      method("handle", [], stub("{}")),
      method("anything", [], stub()),
      method("admin", [], stub("Admin")),
    ),
    Door: service(method("admin", []), method("close", [])),
    Listener: clientService(method("heard", [["what", { kind: "string" }]], stub("Hidden"))),
    Hidden: clientService(method("secret", [])),
    Inner: service(method("knock", [], stub("Door"))),
    Admin: service(method("settings", [], stub("Settings"))),
    Settings: service(method("read", [], { kind: "string" })),
    Unreached: service(method("lost", [])),
    "{}": service(),
  }, { Bundle: { kind: "object", properties: { inner: stub("Inner"), count: { kind: "number" } } } });

  test("follows returned capabilities, not parameters", () => {
    const catalog = emitToolCatalog(schema, { root: "Root" });
    expect(catalog.tools.map((tool) => tool.id)).toEqual([
      "Admin.settings", "Door.admin", "Door.close", "Inner.knock", "Root.admin", "Root.anything", "Root.bundle", "Root.handle",
      "Root.open", "Root.subscribe", "Settings.read",
    ]);
    expect(catalog.experimental).toBe(true);
    expect(catalog.root).toBe("Root");
    expect(catalog.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("continuesOn names the service a capability result has tools on", () => {
    const catalog = emitToolCatalog(schema, { root: "Root" });
    expect(toolOf(catalog, "Root.open").continuesOn).toBe("Door");
    expect(toolOf(catalog, "Root.admin").continuesOn).toBe("Admin");
    expect(toolOf(catalog, "Admin.settings").continuesOn).toBe("Settings");
    expect(toolOf(catalog, "Admin.settings").returns)
      .toEqual({ "x-capnweb-kind": "capability", "x-capnweb-service": "Settings" });
    // A handle with no methods, an untyped stub, a value carrying a capability and a value: no link.
    for (const id of ["Root.handle", "Root.anything", "Root.bundle", "Settings.read", "Door.close"]) {
      expect(toolOf(catalog, id), id).not.toHaveProperty("continuesOn");
    }
  });

  test("omit drops methods, and what only they reach", () => {
    const byName = emitToolCatalog(schema, { root: "Root", omit: ["admin", "knock"] });
    expect(byName.tools.map((tool) => tool.id)).toEqual([
      "Door.close", "Root.anything", "Root.bundle", "Root.handle", "Root.open", "Root.subscribe",
    ]);
    // Door is still reached through Inner; Settings only through Admin.settings, and Admin then has
    // no tools for Root.admin to continue on.
    const byId = emitToolCatalog(schema, { root: "Root", omit: ["Root.open", "Admin.settings"] });
    expect(byId.tools.map((tool) => tool.id)).toEqual([
      "Door.admin", "Door.close", "Inner.knock", "Root.admin", "Root.anything", "Root.bundle", "Root.handle",
      "Root.subscribe",
    ]);
    expect(toolOf(byId, "Root.admin")).not.toHaveProperty("continuesOn");
  });

  test("follows capabilities properties hold, without making properties tools", () => {
    const catalog = emitToolCatalog(schemaOf({
      Root: {
        ...service(method("ping", [])),
        properties: [schemaProperty("count", { kind: "number" }), schemaProperty("meta", ref("Meta")),
          schemaProperty("vault", stub("Vault"))],
      },
      Vault: { ...service(method("open", [])), properties: [schemaProperty("nested", stub("Nested"))] },
      Nested: service(method("deep", [])),
      Inner: service(method("knock", [])),
    }, { Meta: { kind: "object", properties: { inner: stub("Inner") } } }), { root: "Root" });
    expect(catalog.tools.map((tool) => tool.id)).toEqual(["Inner.knock", "Nested.deep", "Root.ping", "Vault.open"]);
    expect(() => emitToolCatalog(schemaOf({ Api: { ...service(), properties: [schemaProperty("p", stub("Gone"))] } }),
      { root: "Api" })).toThrow(/Gone: held by Api.p, but not a service/);
  });

  test("follows capabilities a readable stream carries, not a writable one's", () => {
    const catalog = emitToolCatalog(schemaOf({
      Root: service(method("handles", [], { kind: "readableStream", element: stub("Handle") }),
        method("sink", [], { kind: "writableStream", element: stub("Sent") })),
      Handle: service(method("close", [])),
      Sent: service(method("hidden", [])),
    }), { root: "Root" });
    expect(catalog.tools.map((tool) => tool.id)).toEqual(["Handle.close", "Root.handles", "Root.sink"]);
  });

  test("client-implemented services have no tools, even where a schema returns one", () => {
    const catalog = emitToolCatalog(schemaOf({
      Root: {
        ...service(method("callback", [], stub("Callback")), method("both", [], stub("Both"))),
        properties: [schemaProperty("sink", stub("Sink")), schemaProperty("dual", stub("Dual"))],
      },
      Callback: clientService(method("call", [], stub("Behind"))),
      Sink: clientService(method("write", [])),
      Behind: service(method("hidden", [])),
      Both: { ...service(method("go", [], stub("Further"))), direction: "both" },
      Dual: { ...service(method("act", [])), direction: "both" },
      Further: service(method("far", [])),
    }), { root: "Root" });
    expect(catalog.tools.map((tool) => tool.id))
      .toEqual(["Both.go", "Dual.act", "Further.far", "Root.both", "Root.callback"]);
    expect(toolOf(catalog, "Root.callback")).not.toHaveProperty("continuesOn");
    expect(() => emitToolCatalog(schemaOf({ Callback: clientService(method("call", [])) }), { root: "Callback" }))
      .toThrow(/Callback: implemented by the client, so it has no tools/);
  });

  test("refuses an unknown root, a dangling reference and a dangling capability", () => {
    expect(() => emitToolCatalog(schema, { root: "Nope" })).toThrow(/Nope: not a service/);
    expect(() => paramSchema(ref("Missing"))).toThrow(/Missing: referenced, but not a shape/);
    expect(() => emitToolCatalog(schemaOf({ Api: service(method("m", [], stub("Gone"))) }), { root: "Api" }))
      .toThrow(/Gone: returned by Api.m, but not a service/);
  });

  test("looks up only the schema's own names, not Object.prototype's", () => {
    expect(() => emitToolCatalog(schema, { root: "toString" })).toThrow(/toString: not a service/);
    expect(() => paramSchema(ref("constructor"))).toThrow(/constructor: referenced, but not a shape/);
    expect(() => emitToolCatalog(schemaOf({ Api: service(method("m", [], stub("hasOwnProperty"))) }), { root: "Api" }))
      .toThrow(/hasOwnProperty: returned by Api.m, but not a service/);
  });
});

describe("$defs", () => {
  const schema = schemaOf({
    Api: service(
      method("tree", [["outline", ref("Outline")]], ref("Outline")),
      method("plain", [["n", { kind: "number" }]], ref("Pair")),
      method("odd", [["x", ref("a/b~c")]]),
    ),
  }, {
    Outline: { kind: "object", properties: { children: { kind: "array", element: ref("Outline") }, title: ref("Title") } },
    Title: { kind: "union", branches: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }] },
    Pair: { kind: "tuple", elements: [ref("Title"), ref("Title")] },
    Unused: { kind: "string" },
    "a/b~c": { kind: "string" },
  });
  const catalog = emitToolCatalog(schema, { root: "Api" });

  test("hold exactly the named shapes a schema reaches, through recursion", () => {
    const tree = toolOf(catalog, "Api.tree");
    expect(Object.keys(tree.inputSchema.$defs!)).toEqual(["Outline", "Title"]);
    expect(tree.inputSchema.$defs!.Outline).toEqual({
      type: "object",
      properties: { children: { type: "array", items: { $ref: "#/$defs/Outline" } }, title: { $ref: "#/$defs/Title" } },
      required: ["children", "title"],
      additionalProperties: false,
    });
    expect(tree.returns).toEqual({ $ref: "#/$defs/Outline", $defs: tree.inputSchema.$defs });
    const plain = toolOf(catalog, "Api.plain");
    expect(plain.inputSchema).not.toHaveProperty("$defs");
    expect(Object.keys(plain.returns.$defs!)).toEqual(["Pair", "Title"]);
  });

  test("escape names for JSON Pointer and the URI fragment", () => {
    const odd = toolOf(catalog, "Api.odd");
    expect(odd.inputSchema.properties.x).toEqual({ $ref: "#/$defs/a~1b~0c" });
    expect(Object.keys(odd.inputSchema.$defs!)).toEqual(["a/b~c"]);
  });

  test("every $ref resolves within its tool", () => {
    for (const tool of catalog.tools) {
      expect(structuralErrors(tool.inputSchema), tool.id).toEqual([]);
      expect(structuralErrors(tool.returns), tool.id).toEqual([]);
    }
  });

  test("describe a named shape and an object's properties with their docs, deprecated as marked", () => {
    const docs = emitToolCatalog(schemaOf({ Api: service(method("m", [["x", ref("Role")], ["y", ref("Entry")]])) }, {
      Role: { doc: "Who may do what.", deprecated: "", kind: "literal", value: "admin" },
      Entry: {
        kind: "object",
        properties: { id: { kind: "number" }, name: { kind: "string" }, old: { kind: "string" } },
        propertyDocs: { id: { doc: "Its ID." }, old: { doc: "@deprecated Read name.", deprecated: "Read name." } },
      },
    }), { root: "Api" }).tools[0]!.inputSchema;
    expect(docs.$defs).toEqual({
      Entry: {
        type: "object",
        properties: {
          id: { type: "number", description: "Its ID." },
          name: { type: "string" },
          old: { type: "string", description: "@deprecated Read name.", deprecated: true },
        },
        required: ["id", "name", "old"],
        additionalProperties: false,
      },
      Role: { const: "admin", description: "Who may do what.", deprecated: true },
    });
    expect(structuralErrors(docs)).toEqual([]);
  });
});

test("the extractor's fixture, from its authenticated API", () => {
  const schema = extractSchema({
    entry: join(PACKAGE, "__tests__", "__fixtures__", "api.ts"),
    tsconfig: join(PACKAGE, "tsconfig.json"),
    entryName: "FixturePublicApi",
    constants: ["SERVICE_SALT"],
  });
  const catalog = emitToolCatalog(schema, { root: "FixtureAuthedApi" });
  expect(catalog.tools.map((tool) => tool.id)).toEqual([
    "FixtureAdmin.setBanner", "FixtureAuthedApi.findNotes", "FixtureAuthedApi.getAdmin",
    "FixtureAuthedApi.importArchive", "FixtureAuthedApi.openNotebook", "FixtureAuthedApi.setMood",
    "FixtureAuthedApi.setNickname", "Notebook.connect", "Notebook.file", "Notebook.lock", "Notebook.move",
    "Notebook.outline", "Notebook.subscribe", "Notebook.upload", "Notebook.watchTitle",
  ]);
  expect(toolOf(catalog, "FixtureAuthedApi.getAdmin").continuesOn).toBe("FixtureAdmin");
  expect(toolOf(catalog, "FixtureAuthedApi.openNotebook").inputSchema.properties.id)
    .toEqual({ type: "string", description: "The notebook's ID." });
  expect(toolOf(catalog, "Notebook.file").mutates).toBe(true);
  expect(toolOf(catalog, "FixtureAuthedApi.importArchive").inputSchema.properties.archive).toEqual({
    "x-capnweb-kind": "stream",
    "x-capnweb-stream": "readable",
    "x-capnweb-element": { type: "string", contentEncoding: "base64", "x-capnweb-kind": "bytes" },
  });
  expect(toolOf(catalog, "Notebook.move").returns).toEqual({
    anyOf: [{ $ref: "#/$defs/Mood" }, { type: "null", "x-capnweb-kind": "undefined" }],
    $defs: { Mood: { enum: ["busy", "calm"], description: "A string-literal union." } },
  });
  expect(JSON.stringify(emitToolCatalog(schema, { root: "FixtureAuthedApi" }))).toBe(JSON.stringify(catalog));
  // From the entry: deprecated methods keep their tag, and its properties are not tools.
  const entry = emitToolCatalog(schema, { root: "FixturePublicApi" });
  expect(toolOf(entry, "FixturePublicApi.legacy").deprecated).toBe("Use authenticate.");
  expect(toolOf(entry, "LegacyNotes.list").deprecated).toBe("");
  for (const name of ["version", "build"]) {
    expect(entry.tools.some((tool) => tool.id === `FixturePublicApi.${name}`), name).toBe(false);
  }
});

test("workshop-shared's API: every tool schema is structurally valid JSON Schema", () => {
  const shared = join(PACKAGE, "..", "workshop-shared");
  const schema = extractSchema({
    entry: join(shared, "src", "api.ts"),
    tsconfig: join(shared, "tsconfig.json"),
    entryName: "PublicApi",
    constants: ["SERVICE_SALT"],
  });
  const catalog = emitToolCatalog(schema, { root: "AuthenticatedApi" });
  const ids = catalog.tools.map((tool) => tool.id);
  expect(ids).toEqual(ids.toSorted());
  expect(ids).toContain("AdminApi.getSettings");
  expect(ids).toContain("GadgetClient.getTitle");
  expect(toolOf(catalog, "AuthenticatedApi.getAdminApi").continuesOn).toBe("AdminApi");
  expect(toolOf(catalog, "AuthenticatedApi.openWorkspace").continuesOn).toBe("Overseer");
  // Client-implemented subscribers and the pre-authentication API are not reached by calling.
  const services = new Set(catalog.tools.map((tool) => tool.service));
  for (const name of ["PublicApi", "ActionsSubscriber", "AiChatSubscriber", "NotificationSubscriber"]) {
    expect(services.has(name), name).toBe(false);
  }
  for (const name of services) expect(schema.services[name]!.direction, name).not.toBe("client");
  for (const tool of catalog.tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(structuralErrors(tool.inputSchema), `${tool.id} inputSchema`).toEqual([]);
    expect(structuralErrors(tool.returns), `${tool.id} returns`).toEqual([]);
  }
});

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `source` compiles as the ECMA-262 regular expression JSON Schema's `pattern` is. */
function isRegExp(source: string): boolean {
  try {
    return RegExp(source, "u") instanceof RegExp;
  } catch {
    return false;
  }
}

const TYPES = new Set(["string", "number", "boolean", "null", "array", "object"]);
const KEYWORDS = new Set(["$ref", "$defs", "description", "deprecated", "type", "const", "enum", "anyOf", "format", "contentEncoding",
  "pattern", "prefixItems", "items", "minItems", "properties", "required", "additionalProperties"]);

/**
 * What makes `root` not a structurally valid JSON Schema (draft 2020-12) of the subset the catalog
 * writes (a stream's `x-capnweb-element` is checked as a schema too): an unknown keyword, a keyword
 * of the wrong type, `$defs` below the root, a `required` name with no property, a `$ref` that does
 * not resolve in the root's `$defs`, or a `$defs` entry nothing refers to.
 */
function structuralErrors(root: JsonSchema): string[] {
  const errors: string[] = [];
  const defs = root.$defs ?? {};
  const used = new Set<string>();
  const check = (node: unknown, path: string, isRoot = false): void => {
    if (!isSchemaObject(node)) {
      errors.push(`${path}: not a schema object`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}/${key}`;
      if (key === "x-capnweb-element") {
        check(value, at);
      } else if (key.startsWith("x-capnweb-")) {
        if (typeof value !== "string") errors.push(`${at}: not a string`);
      } else if (!KEYWORDS.has(key)) {
        errors.push(`${at}: unknown keyword`);
      } else if (key === "$defs") {
        if (!isRoot) errors.push(`${at}: $defs below the root`);
        if (!isSchemaObject(value)) errors.push(`${at}: not an object`);
        else for (const [name, def] of Object.entries(value)) check(def, `${at}/${name}`);
      } else if (key === "$ref") {
        const match = typeof value === "string" ? /^#\/\$defs\/(.+)$/.exec(value) : null;
        const name = match && decodeURIComponent(match[1]!).replaceAll("~1", "/").replaceAll("~0", "~");
        if (!name || !Object.hasOwn(defs, name)) errors.push(`${at}: ${String(value)} does not resolve`);
        else used.add(name);
      } else if (key === "type") {
        if (typeof value !== "string" || !TYPES.has(value)) errors.push(`${at}: not a type`);
      } else if (key === "description" || key === "format" || key === "contentEncoding") {
        if (typeof value !== "string") errors.push(`${at}: not a string`);
      } else if (key === "deprecated") {
        if (value !== true) errors.push(`${at}: not true`);
      } else if (key === "pattern") {
        if (typeof value !== "string" || !isRegExp(value)) errors.push(`${at}: not a regular expression`);
      } else if (key === "const") {
        if (!["string", "number", "boolean"].includes(typeof value)) errors.push(`${at}: not a scalar`);
      } else if (key === "enum") {
        if (!Array.isArray(value) || !value.length) errors.push(`${at}: not a non-empty array`);
      } else if (key === "anyOf" || key === "prefixItems") {
        if (!Array.isArray(value) || !value.length) errors.push(`${at}: not a non-empty array`);
        else value.forEach((item, i) => check(item, `${at}/${i}`));
      } else if (key === "items" || key === "additionalProperties") {
        if (value !== false) check(value, at);
      } else if (key === "minItems") {
        if (!Number.isInteger(value) || (value as number) < 0) errors.push(`${at}: not a non-negative integer`);
      } else if (key === "properties") {
        if (!isSchemaObject(value)) errors.push(`${at}: not an object`);
        else for (const [name, property] of Object.entries(value)) check(property, `${at}/${name}`);
      } else if (key === "required") {
        const properties = isSchemaObject(node.properties) ? node.properties : {};
        if (!Array.isArray(value) || new Set(value).size !== value.length) errors.push(`${at}: not a unique array`);
        else for (const name of value) if (!Object.hasOwn(properties, name)) errors.push(`${at}: ${String(name)} is no property`);
      }
    }
  };
  check(root, "#", true);
  for (const name of Object.keys(defs)) if (!used.has(name)) errors.push(`#/$defs/${name}: unused`);
  return errors;
}
