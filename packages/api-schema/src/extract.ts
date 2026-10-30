// The schema extractor: loads a Cap'n Web API's TypeScript declarations with the TypeScript
// compiler API and walks the capability graph from an entry interface, producing the `Schema`
// that `schema.ts` describes.
//
// Types are classified with capnweb-validate's rules (its `transform/type-introspector.ts`):
// values versus capabilities (`RpcStub<X>`, `RpcPromise<X>`, interfaces extending `RpcTarget`,
// method-only interfaces), functions, streams and `any` tails. Unlike capnweb-validate, the output
// keeps names and JSDoc, and is deterministic: services, shapes, properties and union branches are
// sorted, so the committed schema does not move with TypeScript's internal type ordering.
//
// typescript6 = npm:typescript@6.0.3: the TypeScript 7 package ships no JS compiler API.

import { dirname } from "node:path";
import ts from "typescript6";
import type { ApiShape, ApiShapeParam, Schema, SchemaMethod, SchemaParam, SchemaService } from "./schema.ts";

/** What to extract. */
export interface ExtractOptions {
  /** The file declaring the entry interface. */
  entry: string;
  /** A tsconfig to load it under (its `extends` and `types` resolved as tsc would)... */
  tsconfig?: string;
  /** ...or the compiler options themselves. */
  compilerOptions?: ts.CompilerOptions;
  /** The exported interface to walk from. */
  entryName: string;
  /** Exported `new Uint8Array([...])` constants to record. */
  constants?: string[];
  /**
   * Whether a declaration file is Cap'n Web's or the Workers runtime's rather than the API's: a stub
   * of one of their base classes (`RpcStub<RpcTarget>`) promises no methods, so it is untyped, and
   * the members their types declare (a `WorkerEntrypoint`'s `fetch`, the global `DurableObject`
   * interface's `alarm`) are not part of an interface extending or reaching them. Defaults to
   * {@link isInstalledRuntime}; a linked or vendored copy, or capnweb's own sources, needs its own.
   */
  isRuntimeFile?: (fileName: string) => boolean;
}

/**
 * capnweb and the Workers runtime types, by where a package manager installs them (TypeScript reads
 * a file at its real path, which for pnpm is inside its store, still under `node_modules/<name>/`).
 */
export function isInstalledRuntime(fileName: string): boolean {
  return /[\\/]node_modules[\\/](capnweb|@cloudflare[\\/]workers-types)[\\/]/.test(fileName);
}

/** Loads `entry` and extracts the schema of everything reachable from `entryName`. */
export function extractSchema(options: ExtractOptions): Schema {
  const program = ts.createProgram({ rootNames: [options.entry], options: loadCompilerOptions(options) });
  const source = program.getSourceFile(options.entry);
  if (!source) throw new Error(`${options.entry}: not found`);
  // A type the checker cannot resolve becomes `any`, which would quietly turn capabilities, streams
  // and whole interfaces into untyped values: a missing dependency install looks like that.
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(`${options.entry} does not type-check, so its types cannot be read (are its dependencies installed?):\n` +
      formatDiagnostics(diagnostics));
  }
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  const entrySymbol = exports.find((symbol) => symbol.getName() === options.entryName);
  if (!entrySymbol) throw new Error(`${options.entry}: no exported ${options.entryName}`);

  const isRuntimeFile = options.isRuntimeFile ?? isInstalledRuntime;
  const isRuntime = (declaration: ts.Declaration) => isRuntimeFile(declaration.getSourceFile().fileName);
  const extractor = new Extractor(checker, isRuntime);
  const entryType = checker.getDeclaredTypeOfSymbol(entrySymbol);
  const entry = extractor.service(entryType);
  const constants: Record<string, number[]> = {};
  for (const name of options.constants ?? []) constants[name] = byteConstant(exports, name, options.entry);
  return {
    entry,
    constants,
    services: sortKeys(extractor.services),
    shapes: sortKeys(extractor.shapes),
  };
}

function loadCompilerOptions(options: ExtractOptions): ts.CompilerOptions {
  if (!options.tsconfig) return { ...options.compilerOptions, noEmit: true };
  const read = ts.readConfigFile(options.tsconfig, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(options.tsconfig), undefined,
    options.tsconfig);
  // A config written for TypeScript 7 may carry options (`singleThreaded`) that 6.x reports as
  // unknown, and nothing here depends on them. Any other problem with the config is fatal.
  const errors = parsed.errors.filter((error) => error.code !== UNKNOWN_COMPILER_OPTION);
  if (errors.length) throw new Error(`${options.tsconfig}:\n${formatDiagnostics(errors)}`);
  return { ...parsed.options, ...options.compilerOptions, noEmit: true };
}

/** "Unknown compiler option '{0}'." */
const UNKNOWN_COMPILER_OPTION = 5023;

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  const shown = ts.formatDiagnostics(diagnostics.slice(0, 10), {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n",
  });
  return diagnostics.length > 10 ? `${shown}... and ${diagnostics.length - 10} more` : shown;
}

/** The bytes of `export const NAME = new Uint8Array([...])`, which must be numeric literals. */
function byteConstant(exports: ts.Symbol[], name: string, file: string): number[] {
  const declaration = exports.find((symbol) => symbol.getName() === name)?.valueDeclaration;
  const init = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  const list = init && ts.isNewExpression(init) && init.expression.getText() === "Uint8Array"
    ? init.arguments?.[0] : undefined;
  if (!list || !ts.isArrayLiteralExpression(list) || !list.elements.every(ts.isNumericLiteral)) {
    throw new Error(`${file}: ${name} is not an exported \`new Uint8Array([...])\` of numeric literals`);
  }
  return list.elements.map((element) => Number((element as ts.NumericLiteral).text));
}

function sortKeys<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => compare(a, b)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalized JSDoc: the comment, then (unless `withTags` is false) its tags as text, trimmed, with
 * `\n` newlines. A parameter's comment is its `@param` text.
 */
function docOf(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, withTags = true): string {
  if (!symbol) return "";
  const parts = [ts.displayPartsToString(symbol.getDocumentationComment(checker))];
  for (const tag of withTags ? symbol.getJsDocTags(checker) : []) {
    const text = ts.displayPartsToString(tag.text);
    parts.push(text ? `@${tag.name} ${text}` : `@${tag.name}`);
  }
  return normalizeDoc(parts.filter((part) => part.trim()).join("\n"));
}

/**
 * Trims the end of every line (keeping indentation, which marks code blocks) and the whole, unifies
 * newlines, and folds runs of blank lines into one.
 */
export function normalizeDoc(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** Brands capnweb's stub and target types carry, never part of an interface's surface. */
const BRANDS = new Set(["__RPC_STUB_BRAND", "__RPC_TARGET_BRAND", "__WORKER_ENTRYPOINT_BRAND",
  "__DURABLE_OBJECT_BRAND"]);

/** Pass-by-value built-ins, honoured only for the global (lib) declaration of the name. */
const BUILTINS: Record<string, ApiShape> = {
  Date: { kind: "date" },
  ArrayBuffer: { kind: "arrayBuffer" },
  DataView: { kind: "dataView" },
  RegExp: { kind: "regexp" },
  Uint8Array: { kind: "bytes" },
  Blob: { kind: "blob" },
  ReadableStream: { kind: "readableStream" },
  WritableStream: { kind: "writableStream" },
  URL: { kind: "url" },
  Headers: { kind: "headers" },
  Request: { kind: "request" },
  Response: { kind: "response" },
  Error: { kind: "error" },
  EvalError: { kind: "error" },
  RangeError: { kind: "error" },
  ReferenceError: { kind: "error" },
  SyntaxError: { kind: "error" },
  TypeError: { kind: "error" },
  URIError: { kind: "error" },
  AggregateError: { kind: "error" },
};
for (const name of ["Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]) {
  BUILTINS[name] = { kind: "typedArray", name };
}

const MAX_DEPTH = 64;

/** One walk of the graph: the services and named shapes found so far, by name. */
class Extractor {
  readonly services = new Map<string, SchemaService>();
  readonly shapes = new Map<string, ApiShape>();
  readonly #checker: ts.TypeChecker;
  /** Whether a declaration is Cap'n Web's or the Workers runtime's, not the API author's. */
  readonly #isRuntime: (declaration: ts.Declaration) => boolean;
  /** The name each service or named shape type was given, so a revisit is a reference. */
  readonly #names = new Map<ts.Type, string>();
  readonly #taken = new Set<string>();

  constructor(checker: ts.TypeChecker, isRuntime: (declaration: ts.Declaration) => boolean) {
    this.#checker = checker;
    this.#isRuntime = isRuntime;
  }

  /** Records the capability interface `type` (once) and returns its name. */
  service(type: ts.Type): string {
    const known = this.#names.get(type);
    if (known) return known;
    const name = this.#nameFor(type);
    const service: SchemaService = { doc: docOf(this.#checker, type.aliasSymbol ?? type.getSymbol()), methods: [] };
    this.services.set(name, service);
    for (const prop of this.#members(type)) service.methods.push(this.#method(name, prop));
    return name;
  }

  /** An interface's surface: its own and inherited members, less capnweb's brands and machinery. */
  #members(type: ts.Type): ts.Symbol[] {
    return this.#checker.getPropertiesOfType(type).filter((prop) => {
      const name = prop.getName();
      if (name.startsWith("__@") || BRANDS.has(name) || name === "constructor" || name.startsWith("#")) return false;
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
      if (declaration && this.#isRuntime(declaration)) return false;
      return !(declaration && isPrivate(declaration));
    }).toSorted((a, b) => compare(a.getName(), b.getName()));
  }

  #method(service: string, prop: ts.Symbol): SchemaMethod {
    const where = `${service}.${prop.getName()}`;
    let type = this.#checker.getTypeOfSymbol(prop);
    if (prop.flags & ts.SymbolFlags.Optional) type = this.#checker.getNonNullableType(type);
    const signatures = type.getCallSignatures();
    if (signatures.length === 0) throw new Error(`${where}: a property, not a method; the schema describes methods only`);
    if (signatures.length > 1) throw new Error(`${where}: overloaded; the schema records one signature per method`);
    const signature = signatures[0]!;
    const params = signature.getParameters().map((param): SchemaParam => {
      const { name, type: shape, optional } = this.#param(param, where);
      return { name, type: shape, optional, doc: docOf(this.#checker, param, false) };
    });
    return {
      name: prop.getName(),
      doc: docOf(this.#checker, prop),
      params,
      returns: this.#shape(this.#awaited(signature.getReturnType()), 0),
    };
  }

  #param(param: ts.Symbol, where: string): ApiShapeParam {
    const declaration = param.valueDeclaration;
    if (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken) {
      throw new Error(`${where}: rest parameter ${param.getName()}; the schema records fixed parameters only`);
    }
    const optional = !!declaration && ts.isParameter(declaration)
      && (!!declaration.questionToken || !!declaration.initializer);
    const shape = this.#shape(this.#checker.getTypeOfSymbol(param), 0);
    // `x?: T` is `T | undefined`; `optional` says so already.
    return { name: param.getName(), type: optional ? withoutUndefined(shape) : shape, optional };
  }

  /** `Promise<T>` (nested too) as `T`: capnweb awaits results. `#shape` applies it per union branch. */
  #awaited(type: ts.Type, depth = 0): ts.Type {
    if (depth > MAX_DEPTH) return type;
    const symbol = type.getSymbol();
    if (symbol && (symbol.getName() === "Promise" || symbol.getName() === "PromiseLike") && isGlobal(symbol)) {
      const args = this.#checker.getTypeArguments(type as ts.TypeReference);
      if (args.length === 1) return this.#awaited(args[0]!, depth + 1);
    }
    return type;
  }

  #shape(type: ts.Type, depth: number): ApiShape {
    if (depth > MAX_DEPTH) return { kind: "unsupported", reason: "nested too deeply" };
    const flags = type.getFlags();
    const F = ts.TypeFlags;
    if (flags & F.StringLiteral) return { kind: "literal", value: (type as ts.StringLiteralType).value };
    if (flags & F.NumberLiteral) return { kind: "literal", value: (type as ts.NumberLiteralType).value };
    if (flags & F.BigIntLiteral) return { kind: "bigint" };
    if (flags & F.BooleanLiteral) {
      return { kind: "literal", value: (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true" };
    }
    if (flags & (F.TemplateLiteral | F.StringMapping | F.String)) return { kind: "string" };
    if (flags & (F.Number | F.Enum)) return { kind: "number" };
    if (flags & F.Boolean) return { kind: "boolean" };
    if (flags & F.BigInt) return { kind: "bigint" };
    if (flags & F.Null) return { kind: "null" };
    if (flags & F.Undefined) return { kind: "undefined" };
    if (flags & F.Void) return { kind: "void" };
    if (flags & (F.Any | F.Unknown)) return { kind: "any" };
    if (flags & F.Never) return { kind: "unsupported", reason: "never" };
    if (flags & F.NonPrimitive) return { kind: "unsupported", reason: "the `object` keyword has no shape" };
    if (flags & F.TypeParameter) {
      const constraint = this.#checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? this.#shape(constraint, depth + 1) : { kind: "any" };
    }

    const stub = this.#stub(type, depth);
    if (stub) return stub;

    const awaited = this.#awaited(type);
    if (awaited !== type) return this.#shape(awaited, depth + 1);

    if (flags & F.Union) {
      // `Alias | undefined` (an optional `x?: Alias` too) is a fresh union with no alias, its
      // members the alias's own spread out. TypeScript keeps the union as written in `origin`
      // (internal; `typeToString` prints from it), whose members still carry their names.
      const origin = (type as { origin?: ts.Type }).origin;
      if (!userName(type) && origin && origin.getFlags() & F.Union) {
        return union((origin as ts.UnionType).types.map((t) => this.#shape(t, depth + 1)));
      }
      return this.#named(type, () => union((type as ts.UnionType).types.map((t) => this.#shape(t, depth + 1))));
    }
    if (flags & F.Intersection) {
      const primitive = (type as ts.IntersectionType).types.find((t) => t.getFlags() & PRIMITIVE);
      if (primitive) return this.#shape(primitive, depth + 1);
      return this.#named(type, () => this.#object(type, depth));
    }
    if (this.#checker.isTupleType(type)) return this.#tuple(type as ts.TypeReference, depth);
    if (this.#checker.isArrayType(type)) {
      const [element] = this.#checker.getTypeArguments(type as ts.TypeReference);
      return { kind: "array", element: element ? this.#shape(element, depth + 1) : { kind: "any" } };
    }
    if (flags & F.Object) {
      const builtin = this.#builtin(type, depth);
      if (builtin) return builtin;
      if (type.getCallSignatures().length > 0 && this.#checker.getPropertiesOfType(type).length === 0) {
        return this.#function(type, depth);
      }
      return this.#named(type, () => this.#object(type, depth));
    }
    return { kind: "unsupported", reason: `unsupported type ${this.#checker.typeToString(type)}` };
  }

  /**
   * A capability, or undefined for a value: an `RpcStub<X>`/`RpcPromise<X>` (by capnweb's stub
   * brand, whose type is `X`), an interface extending `RpcTarget` (by its target brand), or a
   * method-only interface. A stub over a function is that function.
   */
  #stub(type: ts.Type, depth: number): ApiShape | undefined {
    const flags = type.getFlags();
    if (!(flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return undefined;
    const brand = this.#checker.getPropertyOfType(type, "__RPC_STUB_BRAND");
    if (brand) {
      const target = this.#checker.getTypeOfSymbol(brand);
      if (target.getFlags() & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
        || this.#isBareRpcBase(target)) {
        return { kind: "stub" };
      }
      if (target.getCallSignatures().length > 0 && this.#checker.getPropertiesOfType(target).length === 0) {
        return this.#function(target, depth);
      }
      return { kind: "stub", service: this.service(target) };
    }
    if (this.#checker.getPropertyOfType(type, "__RPC_TARGET_BRAND")) {
      return { kind: "stub", service: this.service(type) };
    }
    if (!(flags & ts.TypeFlags.Object) || this.#checker.isArrayType(type) || this.#checker.isTupleType(type)) {
      return undefined;
    }
    if (this.#builtinName(type) || this.#checker.getIndexInfosOfType(type).length > 0) return undefined;
    const props = this.#checker.getPropertiesOfType(type);
    const methodOnly = props.length > 0
      && props.every((prop) => this.#checker.getTypeOfSymbol(prop).getCallSignatures().length > 0);
    return methodOnly ? { kind: "stub", service: this.service(type) } : undefined;
  }

  /** `RpcTarget` (or a Workers base class) itself, which promises no methods: an untyped stub. */
  #isBareRpcBase(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    return !!symbol && ["RpcTarget", "WorkerEntrypoint", "DurableObject"].includes(symbol.getName())
      && !!symbol.declarations?.every(this.#isRuntime);
  }

  #function(type: ts.Type, depth: number): ApiShape {
    const signature = type.getCallSignatures()[0]!;
    return {
      kind: "function",
      params: signature.getParameters().map((param) => this.#param(param, this.#checker.typeToString(type))),
      returns: this.#shape(this.#awaited(signature.getReturnType()), depth + 1),
    };
  }

  #builtinName(type: ts.Type): string | undefined {
    const symbol = type.getSymbol();
    const name = symbol?.getName();
    if (!symbol || !name || !isGlobal(symbol)) return undefined;
    return name in BUILTINS || name === "Map" || name === "ReadonlyMap" || name === "Set" || name === "ReadonlySet"
      ? name : undefined;
  }

  #builtin(type: ts.Type, depth: number): ApiShape | undefined {
    const name = this.#builtinName(type);
    if (!name) return undefined;
    const args = this.#checker.getTypeArguments(type as ts.TypeReference);
    const arg = (i: number): ApiShape => args[i] ? this.#shape(args[i], depth + 1) : { kind: "any" };
    if (name === "Map" || name === "ReadonlyMap") return { kind: "map", key: arg(0), value: arg(1) };
    if (name === "Set" || name === "ReadonlySet") return { kind: "set", element: arg(0) };
    return BUILTINS[name];
  }

  #tuple(type: ts.TypeReference, depth: number): ApiShape {
    const args = this.#checker.getTypeArguments(type);
    const flags = (type.target as ts.TupleType).elementFlags;
    const elements: ApiShape[] = [];
    let minLength = 0;
    let rest: ApiShape | undefined;
    args.forEach((arg, i) => {
      const shape = this.#shape(arg, depth + 1);
      if (rest) {
        throw new Error(`${this.#checker.typeToString(type)}: an element after the variadic one; `
          + "the schema records a variadic tail only");
      }
      if (flags[i]! & ts.ElementFlags.Variable) {
        rest = shape.kind === "array" ? shape.element : shape;
        return;
      }
      elements.push(shape);
      if (flags[i]! & ts.ElementFlags.Required) minLength = elements.length;
    });
    return {
      kind: "tuple",
      elements,
      ...(minLength === elements.length ? {} : { minLength }),
      ...(rest ? { rest } : {}),
    };
  }

  #object(type: ts.Type, depth: number): ApiShape {
    const properties: Record<string, ApiShape> = {};
    const props = this.#checker.getPropertiesOfType(type).filter((prop) => {
      const name = prop.getName();
      return !name.startsWith("__@") && !BRANDS.has(name);
    }).toSorted((a, b) => compare(a.getName(), b.getName()));
    for (const prop of props) {
      let shape = this.#shape(this.#checker.getTypeOfSymbol(prop), depth + 1);
      if (prop.flags & ts.SymbolFlags.Optional) shape = union([shape, { kind: "undefined" }]);
      properties[prop.getName()] = shape;
    }
    const index = this.#checker.getIndexTypeOfType(type, ts.IndexKind.String)
      ?? this.#checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return { kind: "object", properties, ...(index ? { index: this.#shape(index, depth + 1) } : {}) };
  }

  /**
   * A named object or union type (an interface, or an alias declared outside TypeScript's lib)
   * resolved once into {@link shapes} and referred to by name; an anonymous one inline.
   */
  #named(type: ts.Type, resolve: () => ApiShape): ApiShape {
    const known = this.#names.get(type);
    if (known) return { kind: "ref", name: known };
    if (!userName(type)) return resolve();
    // Named before resolving, so a recursive reference finds the name.
    const name = this.#nameFor(type);
    this.shapes.set(name, resolve());
    return { kind: "ref", name };
  }

  /**
   * The type's own name, or, when another type already has it (two instantiations of one generic),
   * the type as TypeScript prints it.
   */
  #nameFor(type: ts.Type): string {
    const base = userName(type) ?? this.#checker.typeToString(type);
    let name = base;
    if (this.#taken.has(name)) name = this.#checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    for (let n = 2; this.#taken.has(name); n++) name = `${base}#${n}`;
    this.#taken.add(name);
    this.#names.set(type, name);
    return name;
  }
}

const PRIMITIVE = ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt
  | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.BigIntLiteral;

/** A type's declared name, unless it is anonymous or TypeScript's own (`Record`, `Partial`, ...). */
function userName(type: ts.Type): string | undefined {
  for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
    const name = symbol?.getName();
    if (!symbol || !name || name === "__type" || name === "__object") continue;
    if (symbol.declarations?.some((d) => /[\\/]lib\.[\w.-]+\.d\.ts$/.test(d.getSourceFile().fileName))) return undefined;
    return name;
  }
  return undefined;
}

/**
 * A union's shape: nested unions flattened, duplicate branches dropped (`RpcStub<any>` resolves to
 * two identical stub branches), `true | false` as `boolean`, branches sorted.
 */
function union(shapes: ApiShape[]): ApiShape {
  const branches = new Map<string, ApiShape>();
  for (const shape of shapes.flatMap((s) => s.kind === "union" ? s.branches : [s])) {
    branches.set(JSON.stringify(shape), shape);
  }
  const t = JSON.stringify({ kind: "literal", value: true });
  const f = JSON.stringify({ kind: "literal", value: false });
  if (branches.has(t) && branches.has(f)) {
    branches.delete(t);
    branches.delete(f);
    branches.set(JSON.stringify({ kind: "boolean" }), { kind: "boolean" });
  }
  const sorted = [...branches].toSorted(([a], [b]) => compare(a, b)).map(([, shape]) => shape);
  return sorted.length === 1 ? sorted[0]! : { kind: "union", branches: sorted };
}

function withoutUndefined(shape: ApiShape): ApiShape {
  return shape.kind === "union" ? union(shape.branches.filter((branch) => branch.kind !== "undefined")) : shape;
}

/**
 * True for a global declaration of the symbol's name (lib, or `declare global`), so a user type
 * merely named `Date` or `Promise` is not taken for the built-in.
 */
function isGlobal(symbol: ts.Symbol): boolean {
  for (const declaration of symbol.getDeclarations() ?? []) {
    for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
      if (ts.isModuleDeclaration(node)) return (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
      if (ts.isSourceFile(node)) return !ts.isExternalModule(node);
    }
  }
  return false;
}

function isPrivate(declaration: ts.Declaration): boolean {
  return ts.canHaveModifiers(declaration) && !!ts.getModifiers(declaration)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
}
