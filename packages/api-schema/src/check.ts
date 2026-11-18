// The argument check: whether the arguments of one call fit the shapes the schema records for its
// method's parameters. It is for a host that forwards calls it does not implement (a Gatekeeper
// serving a capability from its schema alone) and wants to refuse a malformed call in words the
// caller can act on before passing it on. It checks values only: a capability, function or stream
// is always refused, since such a host's callers pass plain data. It does not replace validation
// where the call lands, which checks again.
//
// Pure, as the emitters are: no `node:` imports, no file system, clock, randomness or environment.

import type { ApiShape, Schema, SchemaService, SchemaShape } from "./schema.ts";

/** The most problems checkArguments() reports for one call. */
export const MAX_ARGUMENT_PROBLEMS = 10;

/** How deep a value is followed (nested values, named shapes and union branches each count one). */
const MAX_DEPTH = 64;

/**
 * What is wrong with `args` as the arguments of `service.method`, checked against the shapes the
 * schema records. Each problem is one line naming the parameter and the path into it
 * (`options.limit: expected number`): a missing required argument, one too many, a value of
 * another shape, or an object key the shape does not declare. Empty when the arguments fit, and at
 * most {@link MAX_ARGUMENT_PROBLEMS} long. A capability, function or stream is always a problem,
 * since a value-only caller has none to pass; `any` and `unsupported` accept anything. Recursion
 * is bounded, so a value that refers to itself ends in a problem. Throws on a service, method or
 * shape the schema lacks.
 *
 * A missing argument is `undefined`, so an `undefined` past the last parameter is not one too
 * many, and one for a required parameter is a problem unless its shape accepts `undefined`. An
 * entry of a Map is at `[i][0]` (its key) and `[i][1]` (its value), an element of a Set at `[i]`,
 * both in iteration order.
 */
export function checkArguments(schema: Schema, service: string, method: string,
  args: readonly unknown[]): string[] {
  const found = serviceOf(schema, service).methods.find((m) => m.name === method);
  if (!found) throw new Error(`no method ${method} on service ${service} in the schema`);
  const problems: string[] = [];
  const checker = new Checker(schema, problems);
  found.params.forEach((param, i) => {
    if (param.optional && args[i] === undefined) return;
    checker.check(args[i], param.type, param.name, 0);
  });
  for (let i = found.params.length; i < args.length; i++) {
    if (args[i] !== undefined) {
      checker.add(`argument ${i + 1}: expected none, as ${service}.${method} takes ${found.params.length}`);
    }
  }
  return problems;
}

/**
 * The problems each union already tried has with the object or array at a path, by the union's
 * branches and then by depth and path. A value is tried against every branch of a union, so without
 * it a value nested under unions whose branches all recurse (a tree of tagged nodes) would be
 * checked once per branch of every union above it. A scalar has nothing nested to check again, so
 * it is tried each time and kept out: an entry for every optional key of every element of a long
 * array would hold many times what the argument does.
 *
 * It is of use only while a union above is still trying branches. So the outermost union (one the
 * call's own checker tries, not a branch's) is not in it, and empties it on returning: a long array
 * of objects that each fit a union holds one element's entries at a time. A long collection that
 * itself sits under a union (an optional array property) still keeps its elements' entries until
 * that union returns.
 */
type TriedUnions = Map<ApiShape[], Map<string, string[]>>;

class Checker {
  readonly #schema: Schema;
  readonly #problems: string[];
  readonly #tried: TriedUnions;
  /** Whether this is the call's own checker, not one a union made to try a branch. */
  readonly #outermost: boolean;

  constructor(schema: Schema, problems: string[], tried?: TriedUnions) {
    this.#schema = schema;
    this.#problems = problems;
    this.#tried = tried ?? new Map();
    this.#outermost = !tried;
  }

  get full(): boolean {
    return this.#problems.length >= MAX_ARGUMENT_PROBLEMS;
  }

  add(problem: string): void {
    if (!this.full) this.#problems.push(problem);
  }

  check(value: unknown, shape: ApiShape, path: string, depth: number): void {
    if (this.full) return;
    if (depth > MAX_DEPTH) return this.add(`${path}: nested more than ${MAX_DEPTH} levels deep`);
    const expect = (ok: boolean) => {
      if (!ok) this.add(`${path}: expected ${describeShape(this.#schema, shape)}`);
    };
    switch (shape.kind) {
      case "string":
      case "number":
      case "boolean":
      case "bigint":
      case "undefined":
        return expect(typeof value === shape.kind);
      case "void":
        return expect(value === undefined);
      case "null":
        return expect(value === null);
      case "any":
      case "unsupported":
        return;
      case "literal":
        return expect(value === shape.value);
      case "array":
        if (!Array.isArray(value)) return expect(false);
        for (let i = 0; i < value.length; i++) this.check(value[i], shape.element, `${path}[${i}]`, depth + 1);
        return;
      case "set":
        if (!(value instanceof Set)) return expect(false);
        [...value].forEach((element, i) => this.check(element, shape.element, `${path}[${i}]`, depth + 1));
        return;
      case "map":
        if (!(value instanceof Map)) return expect(false);
        [...value].forEach(([key, entry], i) => {
          this.check(key, shape.key, `${path}[${i}][0]`, depth + 1);
          this.check(entry, shape.value, `${path}[${i}][1]`, depth + 1);
        });
        return;
      case "tuple": {
        const min = shape.minLength ?? shape.elements.length;
        if (!Array.isArray(value) || value.length < min || (!shape.rest && value.length > shape.elements.length)) {
          return expect(false);
        }
        // By index, so that a hole is checked as the `undefined` it reads as.
        for (let i = 0; i < value.length; i++) {
          if (i >= min && i < shape.elements.length && value[i] === undefined) continue;
          this.check(value[i], shape.elements[i] ?? shape.rest!, `${path}[${i}]`, depth + 1);
        }
        return;
      }
      case "object": {
        if (!isPlainObject(value)) return expect(false);
        for (const [key, property] of Object.entries(shape.properties)) {
          this.check(Object.hasOwn(value, key) ? value[key] : undefined, property, member(path, key), depth + 1);
        }
        for (const key of Object.keys(value)) {
          if (Object.hasOwn(shape.properties, key)) continue;
          if (shape.index) this.check(value[key], shape.index, member(path, key), depth + 1);
          else this.add(`${member(path, key)}: expected no such key`);
        }
        return;
      }
      case "union":
        return this.#union(value, shape.branches, shape, path, depth);
      case "ref": {
        const named = shapeOf(this.#schema, shape.name);
        // A named union is described by the reference, which may say it by name.
        if (named.kind === "union") return this.#union(value, named.branches, shape, path, depth + 1);
        return this.check(value, named, path, depth + 1);
      }
      case "date":
        return expect(value instanceof Date && !Number.isNaN(value.getTime()));
      case "bytes":
        return expect(value instanceof Uint8Array);
      case "typedArray":
        return expect(!isTypedArrayName(shape.name) || isInstance(value, shape.name));
      case "error":
      case "arrayBuffer":
      case "dataView":
      case "regexp":
      case "blob":
      case "url":
      case "headers":
      case "request":
      case "response":
        return expect(isInstance(value, BUILTIN_TYPES[shape.kind]));
      case "stub":
      case "function":
      case "readableStream":
      case "writableStream":
        return this.add(`${path}: expected ${describeShape(this.#schema, shape)}, which can't be passed by value`);
    }
  }

  /**
   * A value fits a union when it fits some branch. When it fits none, but exactly one branch failed
   * only inside the value (its kind matched), that branch's problems are the useful ones; otherwise
   * the problem says what the union expects. `shape` is the union, or the reference that names it.
   */
  #union(value: unknown, branches: ApiShape[], shape: ApiShape, path: string, depth: number): void {
    if (this.#outermost || typeof value !== "object" || value === null) {
      const problems = this.#unionProblems(value, branches, shape, path, depth);
      if (this.#outermost) this.#tried.clear();
      return problems.forEach((problem) => this.add(problem));
    }
    const tried = this.#tried.get(branches) ?? new Map<string, string[]>();
    this.#tried.set(branches, tried);
    const at = `${depth} ${path}`;
    let problems = tried.get(at);
    if (!problems) {
      problems = this.#unionProblems(value, branches, shape, path, depth);
      tried.set(at, problems);
    }
    problems.forEach((problem) => this.add(problem));
  }

  #unionProblems(value: unknown, branches: ApiShape[], shape: ApiShape, path: string, depth: number): string[] {
    const inner: string[][] = [];
    for (const branch of branches) {
      const problems: string[] = [];
      new Checker(this.#schema, problems, this.#tried).check(value, branch, path, depth + 1);
      if (problems.length === 0) return [];
      inner.push(problems);
    }
    const nested = inner.filter((problems) => problems.every((problem) => !problem.startsWith(`${path}: `)));
    return nested.length === 1 ? nested[0]! : [`${path}: expected ${describeShape(this.#schema, shape)}`];
  }
}

/**
 * A brief name for what a shape accepts: a union's branches joined with `|`; a named union of
 * literals and primitives as its branches, a named object or array as "object" or "array", and
 * any other named shape by its name.
 */
function describeShape(schema: Schema, shape: ApiShape): string {
  switch (shape.kind) {
    case "void":
      return "undefined";
    case "any":
    case "unsupported":
      return "anything";
    case "literal":
      return JSON.stringify(shape.value);
    case "set":
      return "Set";
    case "map":
      return "Map";
    case "tuple": {
      const min = shape.minLength ?? shape.elements.length;
      if (shape.rest) return `an array of at least ${min}`;
      return min === shape.elements.length ? `an array of ${min}` : `an array of ${min} to ${shape.elements.length}`;
    }
    case "union": {
      // Only a value that fits no branch is described, so not `undefined`, which an optional key's
      // union holds: naming it would only be noise.
      const kinds = new Set(shape.branches.map((branch) => describeShape(schema, branch)));
      if (kinds.size > 1) kinds.delete("undefined");
      return [...kinds].join(" | ");
    }
    case "ref": {
      const named = shapeOf(schema, shape.name);
      if (named.kind === "union" && named.branches.every((branch) => SCALARS.has(branch.kind))) {
        return describeShape(schema, named);
      }
      return named.kind === "object" || named.kind === "array" ? named.kind : shape.name;
    }
    case "date":
      return "a valid Date";
    case "typedArray":
      return shape.name;
    case "stub":
      return "a capability";
    case "function":
      return "a function";
    case "readableStream":
    case "writableStream":
      return "a stream";
    case "error":
    case "bytes":
    case "arrayBuffer":
    case "dataView":
    case "regexp":
    case "blob":
    case "url":
    case "headers":
    case "request":
    case "response":
      return BUILTIN_TYPES[shape.kind];
    default:
      return shape.kind;
  }
}

/** Kinds a union is described by branch for: literals and primitives, each a word or two. */
const SCALARS = new Set<ApiShape["kind"]>(["literal", "string", "number", "boolean", "bigint", "null", "undefined",
  "void"]);

/** The global each built-in kind is an instance of. */
const BUILTIN_TYPES = {
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
} as const;

/**
 * Whether `value` is an instance of the global constructor `name`, which the global object may own
 * or inherit. True when this runtime has no such global, which leaves the value to the check where
 * the call lands.
 */
function isInstance(value: unknown, name: string): boolean {
  const ctor = (globalThis as Record<string, unknown>)[name];
  return typeof ctor !== "function" || value instanceof ctor;
}

/** The constructor every typed array's constructor extends. */
const TYPED_ARRAY: unknown = Object.getPrototypeOf(Uint8Array);

/**
 * Whether this runtime has a typed array called `name`. The name is the schema's, so it may be one
 * of another global, or of something every object inherits (`toString`): neither is a typed array.
 */
function isTypedArrayName(name: string): boolean {
  const ctor = (globalThis as Record<string, unknown>)[name];
  return typeof ctor === "function" && Object.getPrototypeOf(ctor) === TYPED_ARRAY;
}

/** An object written as a literal or parsed from JSON: not an array, class instance or capability. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$/u;

/** The path of `key` in the object at `path`: `.key` when it is an identifier, `["key"]` when not. */
function member(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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
