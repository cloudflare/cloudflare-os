// The declaration emitter. Turns a `Schema` into the TypeScript declarations an agent writes code
// against: the surface a Gatekeeper or a code-mode agent holds as a stub of one root service.
//
// `full` is one self-contained `.d.ts`: the root service, and every service and named shape
// reachable from it through method parameters and results and property types, each declared once.
// `fragments` holds the same declarations split per service, for an agent that cannot hold the
// whole surface at once: a service's interface with the named shapes it reaches without crossing
// into another service, which appears by name only, to be fetched as its own fragment. A live
// introspection method on a stub (github.com/cloudflare/capnweb/issues/177) would answer with
// that stub's service's fragment rendered with it as the root and without `omit`. Every fragment
// is rendered from `root`'s point of view instead: declaration names (the suffix of a rewritten
// one) and positions (whether a shape is one the caller receives, supplies or both) come from the
// walk of the whole graph from the root, so the fragments of one root agree with one another and
// with `full`, but a service's fragment from another root can differ from the stub's own answer
// in those names and positions. With `omit`, they are a narrower view still, which such a method
// would have to apply the same omission to. For the same reason the positions are not the
// schema's `direction`, which is relative to the schema's entry: walked by the same rule, they
// agree with it (`"out"` the server's, `"in"` the client's) when the root is the entry and
// nothing is omitted, and where they differ the root's view is what these declarations describe.
//
// The declarations describe what a holder of a stub sees:
//
// - A service is an `export interface` whose every method returns a promise, because every call
//   over Cap'n Web is asynchronous, whatever the implementation returns. A method returning a
//   capability returns `Pipelined<Service>`: a promise of it whose methods can already be called
//   before it resolves, `root.open(id).list()`, as on capnweb's `RpcPromise` (promise pipelining:
//   the second call is sent without waiting for the first's result). A value parameter of a call
//   the holder makes is `Awaitable<T>`, the value or a promise of it, because capnweb resolves a
//   promise argument before delivering the call: `root.set(root.get())` sends both calls at once.
//   Only a parameter as a whole: capnweb also resolves a promise nested inside an argument, which
//   is left to its own types, as is a promise for a capability (`Pipelined<T>` is already a `T`).
// - A property is a `readonly` member. On a stub, reading it is a call (`root.version`,
//   `root.child.list()`), so it is typed as a method's result is: a promise, or `Pipelined<Service>`
//   for a capability, as capnweb's `RpcStub` types it, and an optional one is always there, a
//   promise of `undefined` when the implementation has none. An implementation supplies the value
//   itself, which capnweb sends as it is rather than awaiting it, from a getter (capnweb refuses to
//   read an `RpcTarget`'s instance property), and may leave an optional one out.
// - A service the caller holds (the root, or one it receives) has `[Symbol.dispose]()`, the one
//   member of capnweb's stubs these declarations carry: disposing a stub releases the capability,
//   and is how an API cancels what a returned handle stands for (a subscription), with `using` or
//   by a call. capnweb's `dup()` and `onRpcBroken()` are left to capnweb's own types.
// - A service the caller implements (a subscriber it passes in) is the other way round: it has no
//   `[Symbol.dispose]()` to implement, the values its methods are given are ones the caller
//   receives, and its results ones the caller supplies, so its methods return `Awaitable<T>`: an
//   implementation returns its result as is, or writes the method `async`. Passed as a parameter, a
//   service is passed by reference, so it is implemented as a class extending capnweb's
//   `RpcTarget` (a plain object is passed by value); capnweb's own types demand that with a brand
//   which these declarations, independent of capnweb, cannot name. A service reached both ways is
//   rendered for both: its `[Symbol.dispose]()` optional, its methods unpipelined, returning an
//   `Awaitable<T>` that a caller calling them awaits, and taking `Awaitable<T>` parameters (a method,
//   unlike a function type, accepts an implementation whose parameters are narrower).
// - A capability in a value is its service's interface, and a function passed by reference is a
//   function type. One the caller calls (returned to it, or given to a subscriber it implements)
//   returns a promise and takes `Awaitable<T>` parameters, for the same reasons; one the caller
//   writes and supplies (a callback it passes in, or one its subscriber returns) returns an
//   `Awaitable<T>`, as capnweb's own `RpcStub` types accept: a callback such as
//   `(metadata) => { ... }` type-checks as written. A named shape reached in both positions takes
//   the second, which a caller calling it still awaits.
// - A named shape is an `export type`, whatever its kind: one rule for objects, unions and
//   anything else the extractor hoists, and no interface merging with a declaration of the same
//   name elsewhere.
// - A value the schema calls `any` (an `any` or `unknown`) is `unknown`, so that code using it
//   narrows or casts on purpose; an `unsupported` shape is `unknown` with the reason in a comment.
// - A stream is a `ReadableStream<T>` or `WritableStream<T>` of its element type, or of any chunk
//   when the schema has none. A readable stream's chunks travel as the stream does, a writable
//   one's the other way: the holder of a writable stream supplies them.
// - Every doc the schema keeps is a JSDoc block on what it documents: a service, member or
//   parameter (`@param`), a named shape's `export type`, an object shape's property. Its tags are
//   in the JSDoc, `@deprecated`, `@mutates` and the others the schema keeps in `tags`, from the
//   schema's fields when its doc text does not already carry them.
//
// The schema's names are kept where they are TypeScript identifiers. The others (the extractor
// names a second instantiation of a generic by its printed form, `Foo<Bar>`, or `Name#2`, and an
// untyped `RpcStub<{}>` by `{}`) become identifiers, as do names that would shadow a global type
// these declarations use (`Promise`, `Date`, ...) or a helper alias they declare (`Pipelined`,
// `Awaitable`), or
// are reserved words or type operators, deterministically and without collisions: a valid name
// always keeps itself, and a rewritten one takes the first free `_2`, `_3`, ... suffix.
//
// Pure, as a forge plugin is (github.com/cloudflare/forge): no `node:` imports, no file
// system, clock, randomness or environment. Declarations are sorted by name (the root service
// first, the helper aliases last) and members follow the schema's sorted order, properties before
// methods and `[Symbol.dispose]()` last, so the same schema always yields the same text.

import type { ApiShape, ApiShapeParam, Schema, SchemaMethod, SchemaProperty, SchemaService, SchemaShape, ShapeDoc } from "../schema.ts";

/** What to emit. */
export interface DeclarationOptions {
  /** The service the agent holds a stub of, declared first. */
  root: string;
  /**
   * Methods to leave out, with whatever is reachable only through them: `"method"` on every
   * service, or `"Service.method"` on one.
   */
  omit?: string[];
  /** Text for a leading comment block, such as where the file was generated from. */
  header?: string;
}

/** The declarations reachable from the root. */
export interface Declarations {
  /** One self-contained `.d.ts`. */
  full: string;
  /**
   * Per reachable service, by its declared name: its interface and the named shapes it reaches
   * without crossing into another service. A shape reached from several services is in each of
   * their fragments, so a fragment is read on its own, not concatenated with another.
   */
  fragments: Record<string, string>;
}

/**
 * The name of the alias an untyped capability (`RpcStub<any>`) renders as, declared only when one is
 * reached.
 */
export const UNTYPED_STUB = "UntypedStub";

/** The name of the alias a call returning a capability renders with, declared only when used. */
export const PIPELINED = "Pipelined";

/**
 * The name of the alias for a value or a promise of it (a parameter of a call, the result of a
 * callback or an implemented method), declared only when used.
 */
export const AWAITABLE = "Awaitable";

/**
 * Renders the declarations reachable from `options.root`. Throws on a root, a service or a shape
 * the schema does not have.
 */
export function emitDeclarations(schema: Schema, options: DeclarationOptions): Declarations {
  const omitted = new Set(options.omit ?? []);
  const isOmitted = (service: string, method: SchemaMethod) =>
    omitted.has(method.name) || omitted.has(`${service}.${method.name}`);
  const methodsOf = (name: string): SchemaMethod[] =>
    serviceOf(schema, name).methods.filter((method) => !isOmitted(name, method));

  const all = reach(schema, [{ service: options.root, position: "out" }], methodsOf, true);
  const names = assignNames(all);
  const render = new Renderer(schema, names, methodsOf, all);

  const full: string[] = [];
  if (options.header) full.push(lineComment(options.header));
  full.push(...render.declarations(options.root, all));

  const fragments: Record<string, string> = {};
  for (const service of [...all.services].toSorted((a, b) => compare(names.service(a), names.service(b)))) {
    const roots = [...all.servicePositions.get(service)!].map((position) => ({ service, position }));
    fragments[names.service(service)] = render.declarations(service, reach(schema, roots, methodsOf, false))
      .join("\n");
  }
  return { full: full.join("\n"), fragments };
}

/** What a walk of the graph reached, by schema name. */
interface Reached {
  services: Set<string>;
  shapes: Set<string>;
  /** Per shape, the positions it is reached in. */
  positions: Map<string, Set<Position>>;
  /** Per service, the positions its capability is reached in: `"out"` held, `"in"` implemented. */
  servicePositions: Map<string, Set<Position>>;
  untypedStub: boolean;
}

/**
 * Where a value travels, seen from the holder of the root stub: `"in"` is a value it supplies (a
 * parameter of a method it calls, the result of a function or service method it implements),
 * `"out"` one it receives. A shape reached in both is rendered for both: `"both"`.
 */
type Position = "in" | "out" | "both";

/** A function's or a service's parameters travel the other way from its results. */
function flip(position: Position): Position {
  return position === "in" ? "out" : position === "out" ? "in" : "both";
}

/**
 * The services and named shapes reachable from `roots` (each walked in the position its capability
 * is in) through their (non-omitted) methods and their properties: across every capability when
 * `crossServices`, or stopping at another service's name when not. A service's results and property
 * values travel in the position of its capability, its parameters the other way: a held service's
 * results are received, a subscriber's are supplied.
 */
function reach(schema: Schema, roots: { service: string; position: Position }[],
  methodsOf: (service: string) => SchemaMethod[], crossServices: boolean): Reached {
  const reached: Reached = {
    services: new Set(),
    shapes: new Set(),
    positions: new Map(),
    servicePositions: new Map(),
    untypedStub: false,
  };
  const pending: { service: string; position: Position }[] = [];
  const visitService = (service: string, position: Position) => {
    serviceOf(schema, service);
    const positions = reached.servicePositions.get(service) ?? new Set();
    if (positions.has(position)) return;
    reached.services.add(service);
    reached.servicePositions.set(service, positions.add(position));
    pending.push({ service, position });
  };
  const visit = (shape: ApiShape, position: Position): void => {
    const each = (shapes: ApiShape[]) => shapes.forEach((inner) => visit(inner, position));
    switch (shape.kind) {
      case "array":
      case "set":
        return visit(shape.element, position);
      case "map":
        return each([shape.key, shape.value]);
      case "tuple":
        return each([...shape.elements, ...shape.rest ? [shape.rest] : []]);
      case "object":
        return each([...Object.values(shape.properties), ...shape.index ? [shape.index] : []]);
      case "union":
        return each(shape.branches);
      case "readableStream":
        if (shape.element) visit(shape.element, position);
        return;
      case "writableStream":
        if (shape.element) visit(shape.element, flip(position));
        return;
      case "ref": {
        const positions = reached.positions.get(shape.name) ?? new Set();
        if (positions.has(position)) return;
        reached.shapes.add(shape.name);
        reached.positions.set(shape.name, positions.add(position));
        return visit(shapeOf(schema, shape.name), position);
      }
      case "function":
        shape.params.forEach((param) => visit(param.type, flip(position)));
        return visit(shape.returns, position);
      case "stub":
        if (shape.service === undefined) reached.untypedStub = true;
        else if (crossServices) visitService(shape.service, position);
        else serviceOf(schema, shape.service);
        return;
    }
  };
  roots.forEach(({ service, position }) => visitService(service, position));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const method of methodsOf(next.service)) {
      method.params.forEach((param) => visit(param.type, flip(next.position)));
      visit(method.returns, next.position);
    }
    for (const property of serviceOf(schema, next.service).properties ?? []) visit(property.type, next.position);
  }
  return reached;
}

function serviceOf(schema: Schema, name: string): SchemaService {
  const service = Object.hasOwn(schema.services, name) ? schema.services[name] : undefined;
  if (!service) throw new Error(`no service ${name} in the schema`);
  return service;
}

function shapeOf(schema: Schema, name: string): SchemaShape {
  const shape = Object.hasOwn(schema.shapes, name) ? schema.shapes[name] : undefined;
  if (!shape) throw new Error(`no shape ${name} in the schema`);
  return shape;
}

/** The declared name of each reached service and shape. */
interface Names {
  service(name: string): string;
  shape(name: string): string;
}

/**
 * Names every reached declaration: valid names first, each keeping itself, then the others,
 * rewritten into identifiers and suffixed past any name already taken, in schema-name order.
 */
function assignNames(reached: Reached): Names {
  const taken = new Set(RESERVED_TYPE_NAMES);
  const entries = [
    ...[...reached.services].map((name) => ({ key: `service:${name}`, name })),
    ...[...reached.shapes].map((name) => ({ key: `shape:${name}`, name })),
  ].toSorted((a, b) => compare(a.name, b.name) || compare(a.key, b.key));
  const assigned = new Map<string, string>();
  for (const { key, name } of entries) {
    if (!IDENTIFIER.test(name) || taken.has(name)) continue;
    taken.add(name);
    assigned.set(key, name);
  }
  for (const { key, name } of entries) {
    if (assigned.has(key)) continue;
    const base = toIdentifier(name);
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
    taken.add(candidate);
    assigned.set(key, candidate);
  }
  return {
    service: (name) => assigned.get(`service:${name}`)!,
    shape: (name) => assigned.get(`shape:${name}`)!,
  };
}

/** `{}` as `Empty`, `[]` as `Array`, and every other run of non-identifier characters as `_`. */
function toIdentifier(name: string): string {
  const words = name.replace(/\{\s*\}/g, " Empty ").replace(/\[\s*\]/g, " Array ")
    .split(/[^\p{ID_Continue}$\u200C\u200D]+/u).filter((word) => word.length > 0).join("_");
  if (!words) return "Unnamed";
  return /^[\p{ID_Start}_$]/u.test(words) ? words : `_${words}`;
}

/** An identifier, as ECMAScript defines one, short of escapes. */
const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$/u;

/** Words that cannot name a declaration or a parameter. */
const RESERVED_WORDS = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
];

/**
 * Names a declaration may not take: reserved words, the type operators that a type reference
 * cannot start with, TypeScript's own type names, the global types
 * the declarations refer to (an API's own `Response` would otherwise shadow the global one in this
 * module), and the helper aliases.
 */
const RESERVED_TYPE_NAMES = [
  ...RESERVED_WORDS, "as", "infer", "keyof", "readonly", "unique", "any", "bigint", "boolean", "never", "number",
  "object", "string", "symbol", "undefined", "unknown", "Array", "ArrayBuffer", "BigInt64Array", "BigUint64Array",
  "Blob", "DataView", "Date", "Error", "Float32Array", "Float64Array", "Headers", "Int16Array", "Int32Array",
  "Int8Array", "Map", "Promise", "ReadableStream", "RegExp", "Request", "Response", "Set", "URL", "Uint16Array",
  "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WritableStream", AWAITABLE, PIPELINED, UNTYPED_STUB,
];

/** The global type each built-in shape kind without parameters renders as. */
const BUILTIN_TYPES: Record<string, string> = {
  date: "Date",
  bytes: "Uint8Array",
  error: "Error",
  arrayBuffer: "ArrayBuffer",
  dataView: "DataView",
  regexp: "RegExp",
  blob: "Blob",
  url: "URL",
  headers: "Headers",
  request: "Request",
  response: "Response",
};

const TYPED_ARRAYS = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]);

class Renderer {
  readonly #schema: Schema;
  readonly #names: Names;
  readonly #methodsOf: (service: string) => SchemaMethod[];
  /** Where each shape and service is reached from the root, so every fragment renders it the same. */
  readonly #reached: Reached;
  /** Whether the declarations being rendered use the `Pipelined` alias. */
  #pipelined = false;
  /** Whether the declarations being rendered use the `Awaitable` alias. */
  #awaitable = false;

  constructor(schema: Schema, names: Names, methodsOf: (service: string) => SchemaMethod[], reached: Reached) {
    this.#schema = schema;
    this.#names = names;
    this.#methodsOf = methodsOf;
    this.#reached = reached;
  }

  /**
   * `first`'s interface, then the other reached services', the shapes', and the helper aliases
   * they use.
   */
  declarations(first: string, reached: Reached): string[] {
    this.#pipelined = false;
    this.#awaitable = false;
    const services = byName([...reached.services].filter((name) => name !== first), this.#names.service);
    const declarations = [
      this.#service(first),
      ...services.map((name) => this.#service(name)),
      ...byName(reached.shapes, this.#names.shape).map((name) => {
        const shape = shapeOf(this.#schema, name);
        const type = this.#type(shape, "", positionOf(this.#reached.positions, name));
        return `${docComment(shapeDocText(shape), "")}export type ${this.#names.shape(name)} = ${type};\n`;
      }),
    ];
    return [
      ...declarations,
      ...this.#awaitable ? [AWAITABLE_DECLARATION] : [],
      ...this.#pipelined ? [PIPELINED_DECLARATION] : [],
      ...reached.untypedStub ? [UNTYPED_STUB_DECLARATION] : [],
    ];
  }

  #service(name: string): string {
    const service = this.#schema.services[name]!;
    const position = positionOf(this.#reached.servicePositions, name);
    const members = [
      ...(service.properties ?? []).map((property) => this.#property(property, position)),
      ...this.#methodsOf(name).map((method) => this.#method(method, position)),
    ];
    if (position !== "in") members.push(position === "out" ? DISPOSE : DISPOSE_OPTIONAL);
    const body = members.length ? `{\n${members.join("")}}` : "{}";
    const doc = withTags(service.doc, [], { ...service.tags, deprecated: service.deprecated });
    return `${docComment(doc, "")}export interface ${this.#names.service(name)} ${body}\n`;
  }

  /**
   * A property of a service whose capability is in `position`: on a held one a call's result,
   * there whether or not it is optional; on an implemented one the value itself, which an
   * implementation may leave out when it is optional; on one reached both ways either, an
   * `Awaitable<T>` that a caller reading it awaits, of `T | undefined` when it is optional, as a
   * held one's promise is.
   */
  #property(property: SchemaProperty, position: Position): string {
    const doc = docComment(withTags(property.doc, [], { ...property.tags, deprecated: property.deprecated }), "  ");
    const key = propertyKey(property.name);
    if (position === "out") {
      const type = property.optional ? orUndefined(property.type) : property.type;
      return `${doc}  readonly ${key}: ${this.#result(type, "  ")};\n`;
    }
    const type = position === "in" ? this.#type(property.type, "  ", position)
      : this.#awaitableOf(property.optional ? orUndefined(property.type) : property.type, "  ", position);
    return `${doc}  readonly ${key}${property.optional ? "?" : ""}: ${type};\n`;
  }

  /** A method of a service whose capability is in `position`. */
  #method(method: SchemaMethod, position: Position): string {
    const names = paramNames(method.params);
    const extra = method.params.flatMap((param, i) =>
      param.doc && !documentsParam(method.doc, param.name) ? [`@param ${names[i]} ${param.doc}`] : []);
    const doc = withTags(method.doc, extra,
      { ...method.tags, deprecated: method.deprecated, mutates: method.mutates ? "" : undefined });
    const returns = position === "out" ? this.#result(method.returns, "  ")
      : this.#awaitableOf(method.returns, "  ", position);
    const params = this.#params(method.params, "  ", flip(position), position !== "in");
    return `${docComment(doc, "  ")}  ${methodKey(method.name)}(${params}): ${returns};\n`;
  }

  /**
   * What calling a method or function the holder calls returns: a promise of the result, which
   * for a capability can be pipelined on.
   */
  #result(shape: ApiShape, indent: string): string {
    if (shape.kind !== "stub" || shape.service === undefined) return `Promise<${this.#type(shape, indent, "out")}>`;
    this.#pipelined = true;
    return `${PIPELINED}<${this.#names.service(shape.service)}>`;
  }

  /** `Awaitable<T>`: a value, or a promise of it. */
  #awaitableOf(shape: ApiShape, indent: string, position: Position): string {
    this.#awaitable = true;
    return `${AWAITABLE}<${this.#type(shape, indent, position)}>`;
  }

  /**
   * A parameter list; with `called`, of a call the holder makes, whose value parameters take a
   * promise too. An optional parameter followed by a required one (a parameter with a default can
   * be) is spelled `name: T | undefined`, which TypeScript accepts in that position.
   */
  #params(params: ApiShapeParam[], indent: string, position: Position, called: boolean): string {
    const lastRequired = params.findLastIndex((param) => !param.optional);
    const names = paramNames(params);
    return params.map((param, i) => {
      const value = called && param.type.kind !== "stub" && param.type.kind !== "function";
      const type = value ? this.#awaitableOf(param.type, indent, position) : this.#type(param.type, indent, position);
      if (!param.optional) return `${names[i]}: ${type}`;
      return i < lastRequired
        ? `${names[i]}: ${value ? type : this.#operand(param.type, indent, position)} | undefined`
        : `${names[i]}?: ${type}`;
    }).join(", ");
  }

  /**
   * A type expression, with `indent` the indentation of the line it starts on and `position` where
   * its value travels.
   */
  #type(shape: ApiShape, indent: string, position: Position): string {
    switch (shape.kind) {
      case "string":
      case "number":
      case "boolean":
      case "bigint":
      case "null":
      case "undefined":
      case "void":
        return shape.kind;
      case "any":
        return "unknown";
      case "literal":
        return typeof shape.value === "string" ? JSON.stringify(shape.value) : String(shape.value);
      case "array":
        return `${this.#operand(shape.element, indent, position)}[]`;
      case "set":
        return `Set<${this.#type(shape.element, indent, position)}>`;
      case "map":
        return `Map<${this.#type(shape.key, indent, position)}, ${this.#type(shape.value, indent, position)}>`;
      case "tuple":
        return this.#tuple(shape, indent, position);
      case "object":
        return this.#object(shape, indent, position);
      case "union":
        return shape.branches.map((branch) => this.#operand(branch, indent, position)).join(" | ");
      case "ref":
        return this.#names.shape(shape.name);
      case "typedArray":
        return TYPED_ARRAYS.has(shape.name) ? shape.name : `unknown /* ${inlineComment(shape.name)} */`;
      case "stub":
        return shape.service === undefined ? UNTYPED_STUB : this.#names.service(shape.service);
      case "function":
        return this.#function(shape, indent, position);
      case "unsupported":
        return `unknown /* ${inlineComment(shape.reason)} */`;
      case "readableStream":
        return shape.element ? `ReadableStream<${this.#type(shape.element, indent, position)}>` : "ReadableStream";
      case "writableStream":
        return shape.element ? `WritableStream<${this.#type(shape.element, indent, flip(position))}>` : "WritableStream";
      default:
        return BUILTIN_TYPES[shape.kind]!;
    }
  }

  /**
   * A function type. One the holder writes may return its result as is, one it calls returns a
   * promise.
   */
  #function(shape: Extract<ApiShape, { kind: "function" }>, indent: string, position: Position): string {
    const params = this.#params(shape.params, indent, flip(position), position === "out");
    if (position === "out") return `(${params}) => ${this.#result(shape.returns, indent)}`;
    return `(${params}) => ${this.#awaitableOf(shape.returns, indent, position)}`;
  }

  /** A type expression as an operand of `[]`, `|` or a tuple's `?`: parenthesized unless atomic. */
  #operand(shape: ApiShape, indent: string, position: Position): string {
    const text = this.#type(shape, indent, position);
    const compound = (shape.kind === "union" && shape.branches.length > 1) || shape.kind === "function"
      || (shape.kind === "literal" && typeof shape.value === "number" && shape.value < 0);
    return compound ? `(${text})` : text;
  }

  #tuple(shape: Extract<ApiShape, { kind: "tuple" }>, indent: string, position: Position): string {
    const required = shape.minLength ?? shape.elements.length;
    const elements = shape.elements.map((element, i) =>
      i < required ? this.#type(element, indent, position) : `${this.#operand(element, indent, position)}?`);
    if (shape.rest) elements.push(`...${this.#operand(shape.rest, indent, position)}[]`);
    return `[${elements.join(", ")}]`;
  }

  /**
   * An object type, one member per line. A property whose union includes `undefined` is optional.
   * With properties beside it, an index signature's type is widened to theirs, as TypeScript
   * requires of a type literal.
   */
  #object(shape: Extract<ApiShape, { kind: "object" }>, indent: string, position: Position): string {
    const inner = `${indent}  `;
    const members: string[] = [];
    for (const [key, value] of Object.entries(shape.properties)) {
      const type = withoutUndefined(value);
      const optional = type !== value;
      const rendered = type ? this.#type(type, inner, position) : "undefined";
      const doc = Object.hasOwn(shape.propertyDocs ?? {}, key) ? shape.propertyDocs![key] : undefined;
      members.push(`${docComment(shapeDocText(doc), inner)}${inner}${propertyKey(key)}${optional ? "?" : ""}: ${rendered};`);
    }
    if (shape.index) {
      const values = [shape.index, ...Object.values(shape.properties)]
        .flatMap((value) => value.kind === "union" ? value.branches : [value]);
      const types = [...new Set(values.map((value) => this.#operand(value, inner, position)))];
      members.push(`${inner}[key: string]: ${types.join(" | ")};`);
    }
    return members.length ? `{\n${members.join("\n")}\n${indent}}` : "{}";
  }
}

/** The position a shape or service reached in `positions` is rendered for. */
function positionOf(positions: Map<string, Set<Position>>, name: string): Position {
  const reached = positions.get(name)!;
  return reached.size === 1 ? [...reached][0]! : "both";
}

const DISPOSE = `  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
`;

/** On a service both held and implemented: an implementation need not have it. */
const DISPOSE_OPTIONAL = `  /** Disposes of this stub, releasing the capability it holds. Absent on an implementation. */
  [Symbol.dispose]?(): void;
`;

const AWAITABLE_DECLARATION = `/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, \`root.set(root.get())\`. And what a function or a method the caller
 * implements may return: its result as is, or from an \`async\` function.
 */
export type ${AWAITABLE}<T> = T | Promise<T>;
`;

const PIPELINED_DECLARATION = `/**
 * What a call returning a capability returns: a promise of the capability, whose methods can be
 * called before it resolves (promise pipelining): \`root.open(id).list()\` sends both calls at
 * once, the second to whatever the first returns. Disposing it disposes the capability.
 */
export type ${PIPELINED}<T> = Promise<T> & T;
`;

const UNTYPED_STUB_DECLARATION = `/**
 * A capability whose interface the API does not declare (an \`RpcStub<any>\`). \`unknown\`, so that
 * calling it takes a deliberate cast to the interface it is known to have: \`any\` would let every
 * call through unchecked, and an invented interface would be a guess.
 */
export type ${UNTYPED_STUB} = unknown;
`;

/**
 * `shape` less its `undefined` branches (`shape` itself when it has none), or undefined when nothing
 * else is left.
 */
function withoutUndefined(shape: ApiShape): ApiShape | undefined {
  if (shape.kind === "undefined") return undefined;
  if (shape.kind !== "union" || !shape.branches.some((branch) => branch.kind === "undefined")) return shape;
  const branches = shape.branches.filter((branch) => branch.kind !== "undefined");
  return branches.length === 0 ? undefined : branches.length === 1 ? branches[0] : { kind: "union", branches };
}

/** `shape` or `undefined`. */
function orUndefined(shape: ApiShape): ApiShape {
  const branches = shape.kind === "union" ? shape.branches : [shape];
  if (branches.some((branch) => branch.kind === "undefined")) return shape;
  return { kind: "union", branches: [...branches, { kind: "undefined" }] };
}

/** Parameter names as identifiers, a reserved word prefixed with `_`, each distinct. */
function paramNames(params: ApiShapeParam[]): string[] {
  const used = new Set<string>();
  return params.map((param) => {
    const identifier = toIdentifier(param.name);
    const base = RESERVED_WORDS.includes(identifier) ? `_${identifier}` : identifier;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  });
}

/**
 * A doc's text, then the `extra` lines, then a line for each tag in `tags` whose text is defined
 * (`""` for a bare tag) and which the doc does not already carry, so a tag is neither lost nor
 * repeated.
 */
function withTags(doc: string, extra: string[], tags: Record<string, string | undefined>): string {
  const present = new Set(doc.split(/\r\n?|\n/).map((line) => /^@(\S+)/.exec(line.trim())?.[1]));
  const missing = Object.entries(tags).flatMap(([name, text]) =>
    text === undefined || present.has(name) ? [] : [text ? `@${name} ${text}` : `@${name}`]);
  return [doc, ...extra, ...missing].filter((part) => part).join("\n");
}

/** A named shape's or an object property's JSDoc text, with its tags. */
function shapeDocText(doc: ShapeDoc | undefined): string {
  return withTags(doc?.doc ?? "", [], { ...doc?.tags, deprecated: doc?.deprecated });
}

/** Whether a method's doc already carries an `@param` line for `name`. */
function documentsParam(doc: string, name: string): boolean {
  return doc.split("\n").some((line) => {
    const match = /^@param\s+(?:\{[^}]*\}\s*)?\[?([^\s\]=]+)/.exec(line.trim());
    return match?.[1] === name;
  });
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A method's key: `new(...)` unquoted in an interface is a construct signature, not a method. */
function methodKey(name: string): string {
  return name === "new" ? JSON.stringify(name) : propertyKey(name);
}

/**
 * A JSDoc block holding `text` line for line (indentation kept, for code blocks), or nothing. A
 * `*\/` inside the text would end the block early and turn the rest of it into declarations.
 */
function docComment(text: string, indent: string): string {
  if (!text) return "";
  const lines = text.replace(/\*\//g, "*\\/").split(/\r\n?|\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

/** Text for a `/* ... *\/` comment on one line. */
function inlineComment(text: string): string {
  return text.replace(/\*\//g, "*\\/").replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** `text` as `//` lines, split at every line terminator, which would otherwise end the comment. */
function lineComment(text: string): string {
  return `${text.split(/\r\n?|[\n\u2028\u2029]/).map((line) => `// ${line}`.trimEnd()).join("\n")}\n`;
}

/** `keys` sorted by the names they are declared as. */
function byName(keys: Iterable<string>, name: (key: string) => string): string[] {
  return [...keys].toSorted((a, b) => compare(name(a), name(b)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
