// The JSON edge of `cf-os api`: argv tokens into the values a call takes, and the values capnweb
// hands back into JSON on stdout.
//
// capnweb carries `bigint`, `Date`, `Uint8Array`, `Error` and capabilities natively; JSON carries
// none of them. (`Set` and `Map` are revived and encoded as their declared shapes say, though
// capnweb 0.12 serializes neither, and no method of the API takes or returns one.) Results are
// encoded one way (`bigint` as a decimal string, bytes as `{"base64": ...}`, a capability as
// `{"$capability": true}`). JSON arguments and answers are revived against their declared shape from
// the table, so a `Date` nested in an object argument arrives as a `Date`, and a present value whose
// JSON does not fit its shape fails before anything is sent, naming the type expected there.

import { RpcStub } from "capnweb";
import { UsageError } from "./output.ts";
import type { ApiArg, ApiShape } from "./table.ts";
import { typeText, withoutUndefined } from "./type-text.ts";

/** Where argument tokens naming a file (`@<path>`) or stdin (`-`) are read. */
export interface ArgSource {
  /** The bytes of `path`, resolved against where the command was run. */
  readFile(path: string): Promise<Uint8Array>;
  /** All of stdin. */
  readStdin(): Promise<Uint8Array>;
}

/**
 * A `stream` argument: the file (or `-`, stdin) to send. Opened only when the call is made, so a dry
 * run names it without reading it.
 */
export class StreamArg {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}

/**
 * `value` as JSON-safe data. Every capability found inside it (a stub, or a function, which capnweb
 * passes by reference) is replaced by `{"$capability": true}` and pushed onto `found`, for the
 * caller to dispose once it has printed the result.
 */
export function encodeValue(value: unknown, found: Disposable[] = []): unknown {
  return encode(value, found) ?? null;
}

function encode(value: unknown, found: Disposable[]): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  // A stub is a Proxy over a function, so it is told apart before functions are.
  if (value instanceof RpcStub) {
    found.push(value as unknown as Disposable);
    return { $capability: true };
  }
  if (typeof value === "function") {
    if (Symbol.dispose in value) found.push(value as unknown as Disposable);
    return { $capability: true };
  }
  if (typeof value !== "object") return String(value);
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) {
    return { base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  if (value instanceof ArrayBuffer) return { base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof URL) return value.href;
  if (value instanceof ReadableStream || value instanceof WritableStream) return { $stream: true };
  if (value instanceof Set) return [...value].map((item) => encode(item, found) ?? null);
  if (value instanceof Map) {
    return [...value].map(([key, item]) => [encode(key, found) ?? null, encode(item, found) ?? null]);
  }
  if (Array.isArray(value)) return value.map((item) => encode(item, found) ?? null);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const encoded = encode(item, found);
    if (encoded !== undefined) result[key] = encoded;
  }
  return result;
}

/**
 * The argument `token` stands for, decoded by `arg`'s encoding. `shapes` resolves the named shapes a
 * `json` argument's shape refers to. Not for `callback` and `function` arguments, which take no
 * token.
 */
export async function decodeArg(
  arg: ApiArg,
  token: string | boolean,
  shapes: Record<string, ApiShape>,
  source: ArgSource,
): Promise<unknown> {
  const label = arg.flag ? `--${arg.flag}` : `<${arg.name}>`;
  if (typeof token === "boolean") {
    if (arg.encoding !== "boolean") throw new UsageError(`${label} needs a value.`);
    return token;
  }
  if (arg.nullable && token === "null" && arg.encoding !== "json") return null;
  switch (arg.encoding) {
    case "string":
      if (arg.choices && !arg.choices.includes(token)) {
        throw new UsageError(`${label} must be one of ${arg.choices.join(", ")}; got "${token}".`);
      }
      return token;
    case "number": {
      const value = token.trim() === "" ? Number.NaN : Number(token);
      if (Number.isNaN(value)) throw new UsageError(`${label} must be a number; got "${token}".`);
      return value;
    }
    case "boolean":
      if (token === "true") return true;
      if (token === "false") return false;
      throw new UsageError(`${label} must be true or false; got "${token}".`);
    case "bigint":
      if (!/^-?\d+$/.test(token)) throw new UsageError(`${label} must be a decimal integer; got "${token}".`);
      return BigInt(token);
    case "date":
      return parseDate(token, label);
    case "bytes":
      if (token === "-") return source.readStdin();
      if (token.startsWith("@")) return source.readFile(token.slice(1));
      return parseBase64(parseJson(token, label), label);
    case "json":
      return decodeJson(token, arg.shape ?? { kind: "any" }, shapes, source, label);
    case "stream":
      return new StreamArg(token);
    case "callback":
    case "function":
      throw new UsageError(`${label} is implemented by cf-os api and takes no value.`);
  }
}

/**
 * The JSON value `token` stands for, checked and revived against `shape` (see {@link revive}): inline
 * JSON, `@<file>`, or `-` for stdin. Where `shape` admits a string, a bare word that is not JSON is
 * that string (`new-chat hello`). `label` names the value in failures: `<name>`, `--<flag>`, or
 * `--answer <key>`.
 */
export async function decodeJson(
  token: string,
  shape: ApiShape,
  shapes: Record<string, ApiShape>,
  source: ArgSource,
  label: string,
): Promise<unknown> {
  const inline = token !== "-" && !token.startsWith("@");
  if (inline && admitsString(shape, shapes) && !isJson(token)) return token;
  const text = !inline
    ? Buffer.from(token === "-" ? await source.readStdin() : await source.readFile(token.slice(1))).toString("utf8")
    : token;
  return revive(parseJson(text, label), shape, shapes, label);
}

/**
 * An argument of a `call` on an untyped capability: the token as JSON, or the token itself when it
 * is not JSON. Unchecked: nothing says what the method takes.
 */
export function decodeUntyped(token: string): unknown {
  try {
    return JSON.parse(token);
  } catch {
    return token;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `shape` is `string`, or a union with a `string` branch: a JSON argument of that shape
 * takes a bare word that is not JSON as the string itself.
 */
export function admitsString(shape: ApiShape, shapes: Record<string, ApiShape>): boolean {
  const resolved = resolve(shape, shapes);
  return resolved.kind === "string" || (resolved.kind === "union" && resolved.branches.some((branch) => admitsString(branch, shapes)));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function parseDate(value: unknown, label: string): Date {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new UsageError(`${label} must be an ISO 8601 date, such as 2026-01-31T12:00:00Z; got ${JSON.stringify(value)}.`);
  }
  return date;
}

function parseBase64(value: unknown, label: string): Uint8Array {
  const base64 = isPlainObject(value) ? value.base64 : undefined;
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) {
    throw new UsageError(`${label} must be @<file>, - for stdin, or {"base64": "..."}.`);
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parsed JSON checked against `shape` and revived: every place `shape` declares a `Date`, bytes,
 * `bigint`, `Set` or `Map` becomes one. A present value whose JSON does not fit fails as a
 * {@link UsageError} naming `label` (`<x>.tags`, `<x>[1]`) and the type declared there, so nothing
 * is sent. Absent properties are not checked, and undeclared ones are kept: the server judges
 * those. A union's `undefined` branches are left out, since JSON has none, and the kinds JSON cannot
 * carry (streams, capabilities, `Error`, ...) are passed as they are.
 */
export function revive(value: unknown, shape: ApiShape, shapes: Record<string, ApiShape>, label = "value"): unknown {
  const resolved = resolve(shape, shapes);
  const mismatch = (expected: ApiShape = shape) =>
    new UsageError(`${label} must be ${typeText(expected)}; got ${jsonPreview(value)}.`);
  switch (resolved.kind) {
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== resolved.kind) throw mismatch();
      return value;
    case "null":
      if (value !== null) throw mismatch();
      return value;
    case "literal":
      if (value !== resolved.value) throw mismatch();
      return value;
    case "undefined":
    case "void":
      if (value !== undefined) throw mismatch();
      return value;
    case "bigint":
      if (!isBigint(value)) throw mismatch();
      return BigInt(value);
    case "date":
      return parseDate(value, label);
    case "bytes":
      if (isPlainObject(value) && "base64" in value) return parseBase64(value, label);
      throw new UsageError(`${label} must be bytes, as {"base64": "..."}; got ${jsonPreview(value)}.`);
    case "array":
      if (!Array.isArray(value)) throw mismatch();
      return value.map((item, index) => revive(item, resolved.element, shapes, `${label}[${index}]`));
    case "set":
      if (!Array.isArray(value)) throw mismatch();
      return new Set(value.map((item, index) => revive(item, resolved.element, shapes, `${label}[${index}]`)));
    case "map": {
      const entries = Array.isArray(value) ? value : isPlainObject(value) ? Object.entries(value) : null;
      if (!entries || !entries.every((entry) => Array.isArray(entry) && entry.length === 2)) throw mismatch();
      return new Map(entries.map(([key, item]: [unknown, unknown], index) => [
        revive(key, resolved.key, shapes, `${label}[${index}][0]`),
        revive(item, resolved.value, shapes, `${label}[${index}][1]`),
      ]));
    }
    case "tuple":
      if (!Array.isArray(value)) throw mismatch();
      return value.map((item, index) => {
        const element = resolved.elements[index] ?? resolved.rest;
        return element ? revive(item, element, shapes, `${label}[${index}]`) : item;
      });
    case "object": {
      if (!isPlainObject(value)) throw mismatch();
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const property = Object.hasOwn(resolved.properties, key) ? resolved.properties[key] : resolved.index;
        result[key] = property ? revive(item, property, shapes, `${label}.${key}`) : item;
      }
      return result;
    }
    case "union": {
      // An optional value's `undefined`: a present JSON value is one of the other branches, as the
      // help writes it (`key?: T`). One branch left is checked as itself, with its own message.
      const optional = resolved.branches.some((branch) => branch.kind === "undefined");
      const union = optional ? withoutUndefined(resolved) : resolved;
      if (union.kind !== "union") return revive(value, union, shapes, label);
      const candidates = union.branches.filter((branch) => fits(value, branch, shapes));
      if (candidates.length === 0) throw mismatch(shape.kind === "ref" ? shape : union);
      // Backtracking: `{ a: string } | { a: number }` both fit `{"a": 5}`, and only the second takes it.
      let first: unknown;
      for (const branch of candidates) {
        try {
          return revive(value, branch, shapes, label);
        } catch (error) {
          if (!(error instanceof UsageError)) throw error;
          first ??= error;
        }
      }
      throw first;
    }
    default:
      return value;
  }
}

/**
 * `value` for a failure: `an array`, `an object`, or its JSON (a string quoted), cut to 40
 * characters, so a pasted document is not repeated whole.
 */
function jsonPreview(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object" && value !== null) return "an object";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** Whether JSON `value` is a `bigint`: an integer number, or a string of decimal digits. */
function isBigint(value: unknown): value is string | number {
  return (typeof value === "string" && /^-?\d+$/.test(value)) || Number.isInteger(value);
}

function resolve(shape: ApiShape, shapes: Record<string, ApiShape>): ApiShape {
  let current = shape;
  for (let depth = 0; current.kind === "ref" && depth < 32; depth++) {
    current = shapes[current.name] ?? { kind: "any" };
  }
  return current;
}

/** Whether JSON `value` could be `shape`: the union branch to revive it against. */
function fits(value: unknown, shape: ApiShape, shapes: Record<string, ApiShape>): boolean {
  const resolved = resolve(shape, shapes);
  switch (resolved.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "undefined":
    case "void":
      return value === undefined;
    case "any":
      return true;
    case "literal":
      return value === resolved.value;
    case "bigint":
      return isBigint(value);
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
    case "bytes":
      return isPlainObject(value) && typeof value.base64 === "string";
    case "array":
    case "set":
    case "tuple":
      return Array.isArray(value);
    case "map":
      return Array.isArray(value) || isPlainObject(value);
    case "object": {
      // Discriminated by its literal-typed properties: `{ kind: "folder" }` fits only that branch.
      // Without one, by its keys: a branch declaring none of the value's keys is not the one meant,
      // so `{"id": 5}` against `{ id: string } | { oid: string }` fails as `id`, not passes as `oid`.
      if (!isPlainObject(value)) return false;
      const declaredKeys = Object.keys(resolved.properties);
      const present = Object.keys(value);
      if (!resolved.index && declaredKeys.length > 0 && present.length > 0 &&
          !present.some((key) => Object.hasOwn(resolved.properties, key))) return false;
      return Object.entries(resolved.properties).every(([key, property]) => {
        const declared = resolve(property, shapes);
        return declared.kind !== "literal" || value[key] === declared.value;
      });
    }
    case "union":
      return resolved.branches.some((branch) => fits(value, branch, shapes));
    default:
      return false;
  }
}
