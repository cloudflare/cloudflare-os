// EXPERIMENTAL: the tool-catalog emitter. Turns a `Schema` into one tool per method a client can
// call from a root capability, each with a JSON Schema (draft 2020-12) for its arguments and its
// result: the input an MCP server, a tool search index or any other function-calling host needs.
// Nothing consumes it yet, and its shape may change; the catalog says so (`experimental: true`).
//
// A tool is a method of a service reachable from the root by calling: the root's own methods, and
// those of every service a method returns as a capability, transitively. A service that appears
// only as a parameter is implemented by the client (a subscriber, a callback), so it has no tools.
//
// Values that cannot travel as JSON keep a JSON Schema that says what they are, through the
// `x-capnweb-*` annotations: a capability, function or stream is marked so a host knows it must
// supply (or receive) a live reference rather than a value, and a `Date`, `Uint8Array` or `bigint`
// is given its usual JSON spelling (an ISO date-time, base64, a decimal string) marked so the host
// can convert it.
//
// Pure, as a forge plugin is (github.com/cloudflare/forge): no `node:` imports, no file
// system, clock, randomness or environment. Tools are sorted by ID, `$defs` by name, and every
// other list follows the schema's own (sorted or declared) order, so the same schema always yields
// the same catalog.

import type { ApiShape, Schema, SchemaMethod } from "../schema.ts";

/** The JSON Schema dialect every schema in the catalog is written in. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** What to emit. */
export interface ToolCatalogOptions {
  /** The service whose methods, and the methods of what they return, become tools. */
  root: string;
  /**
   * Methods to leave out, with whatever is reachable only through them: `"method"` on every
   * service, or `"Service.method"` on one.
   */
  omit?: string[];
}

/** EXPERIMENTAL: the callable surface of a Cap'n Web API, as tools. */
export interface ToolCatalog {
  /** Always `true`: the catalog's format may still change. */
  experimental: true;
  /** The dialect of every `inputSchema` and `returns`. */
  jsonSchemaDialect: typeof JSON_SCHEMA_DIALECT;
  /** The service the tools are reached from. */
  root: string;
  /** Sorted by `id`. */
  tools: Tool[];
}

/** One callable method. */
export interface Tool {
  /** `<service>.<method>`. */
  id: string;
  service: string;
  method: string;
  /** The method's doc comment. */
  description: string;
  /** The arguments, as one object keyed by parameter name, in declaration order. */
  inputSchema: ToolInputSchema;
  /** The awaited result, self-contained like `inputSchema`. */
  returns: JsonSchema;
  /**
   * The service the result is a capability of, when it is one (possibly `null`) and that service
   * has tools: the next link of a pipelined chain, such as `getAdminApi` then `getSettings`.
   */
  continuesOn?: string;
}

/** A tool's arguments: a closed object whose `$defs` hold exactly the named shapes it reaches. */
export interface ToolInputSchema extends JsonSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
}

/** The subset of JSON Schema (draft 2020-12) the catalog writes, and its `x-capnweb-*` annotations. */
export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  type?: "string" | "number" | "boolean" | "null" | "array" | "object";
  const?: string | number | boolean;
  enum?: (string | number | boolean)[];
  anyOf?: JsonSchema[];
  format?: string;
  contentEncoding?: string;
  pattern?: string;
  prefixItems?: JsonSchema[];
  items?: JsonSchema | false;
  minItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | false;
  /**
   * What a value is to Cap'n Web, where JSON alone cannot say: `capability`, `function`, `stream`,
   * `undefined`, `bigint`, `date`, `bytes`, `map`, `set`, `typedArray`, `unsupported`, or another
   * pass-by-value built-in's kind (`error`, `blob`, `url`, `request`, ...).
   */
  "x-capnweb-kind"?: string;
  /** A capability's service: a key of the schema's `services`, absent for an untyped one. */
  "x-capnweb-service"?: string;
  /** A stream's direction. */
  "x-capnweb-stream"?: "readable" | "writable";
  /** A typed array's constructor (`Int32Array`, ...). */
  "x-capnweb-type"?: string;
  /** Why the extractor could not represent the type. */
  "x-capnweb-reason"?: string;
}

/** Emits the tool catalog of everything callable from `options.root`. */
export function emitToolCatalog(schema: Schema, options: ToolCatalogOptions): ToolCatalog {
  if (!own(schema.services, options.root)) throw new Error(`${options.root}: not a service of the schema`);
  const omit = new Set(options.omit ?? []);
  const omitted = (service: string, method: string) => omit.has(method) || omit.has(`${service}.${method}`);

  // Breadth-first from the root over the capabilities methods return.
  const reached: { service: string; method: SchemaMethod }[] = [];
  const seen = new Set([options.root]);
  const queue = [options.root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const method of own(schema.services, next)!.methods) {
      if (omitted(next, method.name)) continue;
      reached.push({ service: next, method });
      for (const service of returnedServices(schema, method.returns)) {
        if (seen.has(service)) continue;
        if (!own(schema.services, service)) {
          throw new Error(`${service}: returned by ${next}.${method.name}, but not a service of the schema`);
        }
        seen.add(service);
        queue.push(service);
      }
    }
  }

  const withTools = new Set(reached.map(({ service }) => service));
  const tools = reached.map(({ service, method }): Tool => {
    const tool: Tool = {
      id: `${service}.${method.name}`,
      service,
      method: method.name,
      description: method.doc,
      inputSchema: inputSchema(schema, method),
      returns: closed(schema, (refs) => toJsonSchema(method.returns, refs)),
    };
    const continuesOn = capabilityOf(schema, method.returns);
    if (continuesOn !== undefined && withTools.has(continuesOn)) tool.continuesOn = continuesOn;
    return tool;
  });
  tools.sort((a, b) => compare(a.id, b.id));
  return { experimental: true, jsonSchemaDialect: JSON_SCHEMA_DIALECT, root: options.root, tools };
}

/** A method's parameters as one closed object. */
function inputSchema(schema: Schema, method: SchemaMethod): ToolInputSchema {
  return closed(schema, (refs) => {
    // `Object.fromEntries` defines each key, so even a parameter named `__proto__` is a property.
    const properties: Record<string, JsonSchema> = Object.fromEntries(method.params.map((param) => {
      const property = toJsonSchema(param.type, refs);
      return [param.name, param.doc ? { ...property, description: param.doc } : property];
    }));
    const required = method.params.filter((param) => !param.optional).map((param) => param.name);
    return { type: "object", properties, required, additionalProperties: false };
  });
}

/**
 * Builds a schema with `build`, which records the named shapes it refers to in `refs`, then adds
 * those shapes, and the ones they refer to in turn, as `$defs`: so every `$ref` resolves within
 * the schema, and nothing else is in `$defs`.
 */
function closed<T extends JsonSchema>(schema: Schema, build: (refs: Set<string>) => T): T {
  const refs = new Set<string>();
  const root = build(refs);
  const defs = new Map<string, JsonSchema>();
  // `refs` grows as the shapes it names are converted; a Set iterates what is added mid-loop.
  for (const name of refs) {
    const shape = own(schema.shapes, name);
    if (!shape) throw new Error(`${name}: referenced, but not a shape of the schema`);
    defs.set(name, toJsonSchema(shape, refs));
  }
  if (!defs.size) return root;
  const names = [...defs.keys()].toSorted(compare);
  return { ...root, $defs: Object.fromEntries(names.map((name) => [name, defs.get(name)!])) };
}

/** JSON's spelling of `undefined` (an absent value, or `null` where a value must be). */
const UNDEFINED: JsonSchema = { type: "null", "x-capnweb-kind": "undefined" };

/** One shape as JSON Schema, recording the named shapes it refers to in `refs`. */
function toJsonSchema(shape: ApiShape, refs: Set<string>): JsonSchema {
  switch (shape.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { type: shape.kind };
    case "undefined":
    case "void":
      return { ...UNDEFINED };
    case "any":
      return {};
    case "bigint":
      return { type: "string", pattern: "^-?[0-9]+$", "x-capnweb-kind": "bigint" };
    case "date":
      return { type: "string", format: "date-time", "x-capnweb-kind": "date" };
    case "bytes":
      return { type: "string", contentEncoding: "base64", "x-capnweb-kind": "bytes" };
    case "literal":
      return { const: shape.value };
    case "ref":
      refs.add(shape.name);
      return { $ref: `#/$defs/${pointerSegment(shape.name)}` };
    case "union": {
      const literals = shape.branches.flatMap((branch) => branch.kind === "literal" ? [branch.value] : []);
      if (literals.length === shape.branches.length) return { enum: literals };
      return { anyOf: shape.branches.map((branch) => toJsonSchema(branch, refs)) };
    }
    case "array":
      return { type: "array", items: toJsonSchema(shape.element, refs) };
    case "set":
      return { type: "array", items: toJsonSchema(shape.element, refs), "x-capnweb-kind": "set" };
    case "map": {
      const entry: JsonSchema = {
        type: "array",
        prefixItems: [toJsonSchema(shape.key, refs), toJsonSchema(shape.value, refs)],
        minItems: 2,
        items: false,
      };
      return { type: "array", items: entry, "x-capnweb-kind": "map" };
    }
    case "tuple": {
      // `prefixItems` must not be empty, so an empty tuple is only its (absent) rest.
      const tuple: JsonSchema = { type: "array" };
      if (shape.elements.length) tuple.prefixItems = shape.elements.map((element) => toJsonSchema(element, refs));
      const minItems = shape.minLength ?? shape.elements.length;
      if (minItems) tuple.minItems = minItems;
      tuple.items = shape.rest ? toJsonSchema(shape.rest, refs) : false;
      return tuple;
    }
    case "object": {
      // An optional property's `present` shape is its own without `undefined`; a required one has none.
      const fields = Object.entries(shape.properties)
        .map(([name, property]) => ({ name, property, present: withoutUndefined(property) }));
      // `Object.fromEntries` defines each key, so even a property named `__proto__` is one.
      const properties: Record<string, JsonSchema> = Object.fromEntries(
        fields.map(({ name, property, present }) => [name, toJsonSchema(present ?? property, refs)]),
      );
      const required = fields.flatMap(({ name, present }) => present ? [] : [name]);
      const object: JsonSchema = { type: "object", properties };
      if (required.length) object.required = required;
      object.additionalProperties = shape.index ? toJsonSchema(shape.index, refs) : false;
      return object;
    }
    case "stub":
      return shape.service === undefined
        ? { "x-capnweb-kind": "capability" }
        : { "x-capnweb-kind": "capability", "x-capnweb-service": shape.service };
    case "function":
      return { "x-capnweb-kind": "function" };
    case "readableStream":
      return { "x-capnweb-kind": "stream", "x-capnweb-stream": "readable" };
    case "writableStream":
      return { "x-capnweb-kind": "stream", "x-capnweb-stream": "writable" };
    case "typedArray":
      return { "x-capnweb-kind": "typedArray", "x-capnweb-type": shape.name };
    case "unsupported":
      return { "x-capnweb-kind": "unsupported", "x-capnweb-reason": shape.reason };
    case "error":
    case "arrayBuffer":
    case "dataView":
    case "regexp":
    case "blob":
    case "url":
    case "headers":
    case "request":
    case "response":
      return { "x-capnweb-kind": shape.kind };
  }
}

/**
 * An optional property's shape without its `undefined` branch (itself, when it is only
 * `undefined`), or `undefined` when the property is required: its shape admits no `undefined`.
 */
function withoutUndefined(shape: ApiShape): ApiShape | undefined {
  if (shape.kind === "undefined") return shape;
  if (shape.kind !== "union" || !shape.branches.some((branch) => branch.kind === "undefined")) return undefined;
  const branches = shape.branches.filter((branch) => branch.kind !== "undefined");
  return branches.length === 1 ? branches[0]! : { kind: "union", branches };
}

/**
 * The services of the capabilities a result carries, wherever they sit in it: the result itself, a
 * union branch, an element or a property, through named shapes. A function's parameters and
 * result are the function's business, not the caller's, so they are not followed.
 */
function returnedServices(schema: Schema, shape: ApiShape, visited = new Set<string>()): string[] {
  switch (shape.kind) {
    case "stub":
      return shape.service === undefined ? [] : [shape.service];
    case "ref": {
      if (visited.has(shape.name)) return [];
      visited.add(shape.name);
      const named = own(schema.shapes, shape.name);
      return named ? returnedServices(schema, named, visited) : [];
    }
    case "union":
      return shape.branches.flatMap((branch) => returnedServices(schema, branch, visited));
    case "array":
    case "set":
      return returnedServices(schema, shape.element, visited);
    case "map":
      return [...returnedServices(schema, shape.key, visited), ...returnedServices(schema, shape.value, visited)];
    case "tuple":
      return [...shape.elements, ...(shape.rest ? [shape.rest] : [])]
        .flatMap((element) => returnedServices(schema, element, visited));
    case "object":
      return [...Object.values(shape.properties), ...(shape.index ? [shape.index] : [])]
        .flatMap((property) => returnedServices(schema, property, visited));
    default:
      return [];
  }
}

/** The service a result is a capability of, possibly `null` or `undefined`, through named shapes. */
function capabilityOf(schema: Schema, shape: ApiShape, visited = new Set<string>()): string | undefined {
  if (shape.kind === "stub") return shape.service;
  if (shape.kind === "ref") {
    if (visited.has(shape.name)) return undefined;
    visited.add(shape.name);
    const named = own(schema.shapes, shape.name);
    return named && capabilityOf(schema, named, visited);
  }
  if (shape.kind !== "union") return undefined;
  const present = shape.branches.filter((branch) => branch.kind !== "null" && branch.kind !== "undefined");
  return present.length === 1 ? capabilityOf(schema, present[0]!, visited) : undefined;
}

/**
 * `record[name]` when it is the record's own entry: a schema's names are data, so `toString` or
 * `constructor` must not find what `Object.prototype` holds.
 */
function own<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** A name as a JSON Pointer segment (RFC 6901) inside a URI fragment (RFC 3986). */
function pointerSegment(name: string): string {
  return encodeURIComponent(name.replaceAll("~", "~0").replaceAll("/", "~1"));
}

/** Code-unit order: the same everywhere, unlike `localeCompare`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
