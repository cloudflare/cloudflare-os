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
import type { ApiArg, ApiShape, SecretPath } from "./table.ts";
import { typeText, withoutUndefined } from "./type-text.ts";

/** Where argument tokens naming a file (`@<path>`) or stdin (`-`) are read. */
export interface ArgSource {
  /**
   * The bytes of `path`, resolved against where the command was run. Fails with a UsageError whose
   * `cause` is the file system's error, so a missing file can be told apart.
   */
  readFile(path: string): Promise<Uint8Array>;
  /** All of stdin. */
  readStdin(): Promise<Uint8Array>;
  /**
   * Fails, as {@link readFile} does, unless `path` is a file that can be read; reads nothing, so a
   * stream argument is checked before connecting without being opened. `typed` is the token that
   * named it, for the failure.
   */
  checkFile(path: string, typed: string): Promise<void>;
}

/**
 * How deeply a JSON value may nest: Cap'n Web refuses to serialize past 256 levels, counting the
 * call's own, so a deeper value could not be sent, and printing one for `--dry-run` would overflow
 * the stack.
 */
const MAX_JSON_DEPTH = 128;

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

/** What `--dry-run` prints in place of a secret ({@link redactSecrets}). */
export const SECRET = { $secret: true } as const;

/**
 * A decoded value as `--dry-run` may print it: the parts at `paths` (the table's
 * {@link ApiArg.secrets}) with every leaf replaced by {@link SECRET}, their structure kept (an
 * object's or a map's keys, an array's or a set's length, `null` and `undefined`, which hold
 * nothing). A path that leads nowhere in this value redacts nothing. The value itself is not
 * changed.
 */
export function redactSecrets(value: unknown, paths: readonly SecretPath[]): unknown {
  let result = value;
  for (const path of paths) result = redactAt(result, path);
  return result;
}

function redactAt(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return redactAll(value);
  const [segment, ...rest] = path;
  if (segment === "*") return eachValue(value, (item) => redactAt(item, rest));
  if (!isObjectLiteral(value) || !Object.hasOwn(value, segment!)) return value;
  return { ...value, [segment!]: redactAt(value[segment!], rest) };
}

function redactAll(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const redacted = eachValue(value, redactAll);
  return redacted === value ? SECRET : redacted;
}

/**
 * A copy of a container (an array, a set, a map, a plain object) with `map` applied to each of its
 * values, or `value` itself when it is not one.
 */
function eachValue(value: unknown, map: (item: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map(map);
  if (value instanceof Set) return new Set([...value].map(map));
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, map(item)]));
  if (isObjectLiteral(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)]));
  return value;
}

/** Whether `value` is an object of plain data, as JSON revives one: not a `Date`, bytes or a collection. */
function isObjectLiteral(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    case "number":
      return parseNumber(token, label);
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
    case "stream": {
      // `@file`, as for bytes; a bare path names the file too. `@-` is a file named `-`, not stdin.
      const path = !token.startsWith("@") ? token : token === "@-" ? "./-" : token.slice(1);
      if (token !== "-") await source.checkFile(path, token);
      return new StreamArg(path);
    }
    case "callback":
    case "function":
      throw new UsageError(`${label} is implemented by cf-os api and takes no value.`);
  }
}

/**
 * The JSON value `token` stands for, checked and revived against `shape` (see {@link revive}): inline
 * JSON, `@<file>`, or `-` for stdin. Where `shape` admits a string, text that is not JSON is that
 * string ({@link decodeValue}). `label` names the value in failures: `<name>`, `--<flag>`, or
 * `--answer <key>`; one read from a file or stdin is named there by its kind, not quoted.
 */
export async function decodeJson(
  token: string,
  shape: ApiShape,
  shapes: Record<string, ApiShape>,
  source: ArgSource,
  label: string,
): Promise<unknown> {
  const asText = admitsString(shape, shapes);
  const inline = token !== "-" && !token.startsWith("@");
  const value = await decodeValue(token, source, label, asText ? "any" : "none");
  try {
    return revive(value, shape, shapes, label, inline);
  } catch (error) {
    // JSON that is not the string the shape also takes (42, true, an object) may have been meant as text.
    if (!asText || typeof value === "string" || !(error instanceof UsageError)) throw error;
    throw new UsageError(`${error.message} ` + (inline
      ? `To send it as text, type it as a JSON string: '${JSON.stringify(token).replaceAll("'", "'\\''")}'.`
      : `To send ${token === "-" ? "stdin's" : "the file's"} text as text, pass it through \`jq -Rs .\` first.`));
  }
}

/**
 * An argument of a `call` on an untyped capability, by the token rules of a typed JSON argument
 * that admits a string, but that text that starts as JSON does and does not parse fails: nothing
 * says the method takes text, so it is far likelier broken JSON ({@link decodeValue}). Unchecked
 * otherwise. `label` names it in failures.
 */
export async function decodeUntyped(token: string, source: ArgSource, label: string): Promise<unknown> {
  return decodeValue(token, source, label, "plain");
}

/** Text that starts as JSON does: for a `call` argument, whatever follows, it is meant as JSON. */
const STARTS_AS_JSON = /^\s*[[{"]/;

/**
 * The JSON value of `token`'s text: the token itself, or what `@<file>` or `-` (stdin) holds, read
 * the same either way. Text that is not JSON is that string (`new-chat hello`), less a file's or
 * stdin's final line ending, as `asText` allows: `any` text (`new-chat '[draft] hello'`), `plain`
 * text only, so text that starts as JSON does and does not parse fails, or `none`. A file or stdin
 * that holds nothing but whitespace fails, as an empty stdin or a failed redirect is far likelier
 * than empty text meant. Nesting past {@link MAX_JSON_DEPTH} fails, and so does a number the server
 * would not get as typed ({@link numberFault}).
 */
async function decodeValue(token: string, source: ArgSource, label: string, asText: "any" | "plain" | "none"): Promise<unknown> {
  const inline = token !== "-" && !token.startsWith("@");
  const text = inline ? token : await readNonEmpty(token, source, label, asText !== "none");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (asText === "any" || (asText === "plain" && !STARTS_AS_JSON.test(text))) {
      return inline ? text : text.replace(/\r?\n$/, "");
    }
    const quote = asText === "plain" ? ` Text that starts with {, [ or " is read as JSON: to send it as text, quote it as a JSON string ` +
      `('"[draft] ..."', or a file's through \`jq -Rs .\`).` : "";
    throw new UsageError(`${label} is not valid JSON: ${jsonFault(text, (error as Error).message)}.${quote}`);
  }
  if (deeperThan(value, MAX_JSON_DEPTH)) {
    throw new UsageError(`${label} is nested more than ${MAX_JSON_DEPTH} levels deep, more than cf-os api sends.`);
  }
  // JSON.parse has already turned `1e999` into Infinity, so each number is judged by its source, in
  // a second parse: one with a reviver recurses, so it waits until the depth is known to be safe.
  let fault: { source: string; value: number; why: string } | undefined;
  JSON.parse(text, ((_key: string, item: unknown, context?: { source?: string }) => {
    const why = typeof item === "number" && context?.source !== undefined ? numberFault(context.source, item) : undefined;
    if (why !== undefined) fault ??= { source: context!.source!, value: item as number, why };
    return item;
  }) as (key: string, item: unknown) => unknown);
  // A file's numbers are not quoted, as nothing read from one is.
  if (fault) {
    throw new UsageError(`${label} holds ${inline ? fault.source : "a number"}, which ${fault.why === "inexact"
      ? `a double does not hold as typed${inline ? `: it would be sent as ${fault.value}` : ", so it would be sent changed"}`
      : `is a whole number past Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}), which the server cannot tell from its neighbours`}.`);
  }
  return value;
}

/**
 * What `@<file>` or `-` holds, as UTF-8 text, which must hold more than whitespace: an empty stdin
 * or a failed redirect is far likelier than empty text meant. Where a string is wanted (`quotable`),
 * an `@<file>` that names no file (nothing there, or a directory, as a lone `@` names the working
 * one) says how the token is typed as the string itself, which may be what was meant.
 */
async function readNonEmpty(token: string, source: ArgSource, label: string, quotable: boolean): Promise<string> {
  const text = await readText(token, source, label).catch((error: unknown) => {
    const { code } = ((error as Error).cause ?? {}) as NodeJS.ErrnoException;
    if (!quotable || (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR")) throw error;
    throw new UsageError(`${(error as Error).message} To send ${token} itself, type it as a JSON string: ` +
      `'${JSON.stringify(token).replaceAll("'", "'\\''")}'.`, { cause: (error as Error).cause });
  });
  if (text.trim() === "") {
    throw new UsageError(`${label}: ${token === "-" ? "stdin" : token} is empty${text === "" ? "" : " but for whitespace"}. ` +
      `Inline '' is the empty string, where one is wanted.`);
  }
  return text;
}

/** What `@<file>` or `-` holds, as UTF-8 text. */
async function readText(token: string, source: ArgSource, label: string): Promise<string> {
  const bytes = token === "-" ? await source.readStdin() : await source.readFile(token.slice(1));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label}: ${token === "-" ? "stdin" : token} is not UTF-8 text.`);
  }
}

/** Whether JSON `value` holds objects or arrays more than `levels` deep. */
function deeperThan(value: unknown, levels: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  return levels === 0 || Object.values(value).some((item) => deeperThan(item, levels - 1));
}

/**
 * Why `text` is not JSON, and where, from `message`, V8's: never quoting `text`, which may be a
 * file's secrets. V8 gives most failures a position; for an unexpected character it quotes the text
 * instead, so the position is found as where a prefix of it first fails that way.
 */
function jsonFault(text: string, message: string): string {
  const positioned = /^(.+?) (?:in|after) JSON at position (\d+)/.exec(message);
  if (positioned) return `${positioned[1][0].toLowerCase()}${positioned[1].slice(1)} at ${lineColumn(text, Number(positioned[2]))}`;
  if (message.startsWith("Unexpected token")) return `unexpected character at ${lineColumn(text, unexpectedAt(text))}`;
  return message.startsWith("Unexpected end") ? "it ends before its value does" : "it does not parse";
}

/** Whether JSON.parse throws "Unexpected token" on `text`: it holds a character no JSON has there. */
function hasUnexpected(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch (error) {
    return (error as Error).message.startsWith("Unexpected token");
  }
}

/** Where the character is that makes JSON.parse throw "Unexpected token" on `text`. */
function unexpectedAt(text: string): number {
  // The prefix of `high` characters fails at the character, that of `low` does not reach it.
  let low = 0;
  let high = text.length;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (hasUnexpected(text.slice(0, middle))) high = middle;
    else low = middle;
  }
  return high - 1;
}

/** `position` in `text`, as `line 3, column 12`. */
function lineColumn(text: string, position: number): string {
  const lines = text.slice(0, position).split("\n");
  return `line ${lines.length}, column ${lines.at(-1)!.length + 1}`;
}

/**
 * Whether `shape` is `string`, or a union with a `string` branch: a JSON argument of that shape
 * takes text that is not JSON as the string itself.
 */
export function admitsString(shape: ApiShape, shapes: Record<string, ApiShape>): boolean {
  const resolved = resolve(shape, shapes);
  return resolved.kind === "string" || (resolved.kind === "union" && resolved.branches.some((branch) => admitsString(branch, shapes)));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${jsonFault(text, (error as Error).message)}.`);
  }
}

/**
 * A decimal number, such as `3`, `-2.5` or `1e3`, that a double holds as typed: hex, `Infinity` and
 * digits a double would drop (`9007199254740993`, sent as ...992) are refused, not sent changed. So
 * is a whole number past `Number.MAX_SAFE_INTEGER` even where a double holds it (`9007199254740992`):
 * the server cannot tell it from its neighbours, which are the same double.
 */
function parseNumber(token: string, label: string): number {
  const value = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token) ? Number(token) : Number.NaN;
  if (!Number.isFinite(value)) throw new UsageError(`${label} must be a number, in decimal (3, -2.5, 1e3); got "${token}".`);
  const fault = numberFault(token, value);
  if (fault === "inexact") {
    throw new UsageError(`${label} must be a number a double holds as typed: ${token} would be sent as ${value}.`);
  }
  if (fault === "unsafe") {
    throw new UsageError(`${label} must be a number a double holds exactly: a whole number is at most ` +
      `${Number.MAX_SAFE_INTEGER} (Number.MAX_SAFE_INTEGER) either way from 0; got "${token}".`);
  }
  return value;
}

/**
 * Why `value`, a number typed as decimal `token`, would not reach the server as typed: `inexact`
 * when a double drops digits of it (or it overflows to Infinity), `unsafe` when it is a whole number
 * past `Number.MAX_SAFE_INTEGER`; undefined when it would. The rule of {@link parseNumber}, for
 * numbers inside JSON too.
 */
function numberFault(token: string, value: number): "inexact" | "unsafe" | undefined {
  const [digits, power] = decimal(token);
  const [heldDigits, heldPower] = decimal(String(value));
  if (!Number.isFinite(value) || digits !== heldDigits || power !== heldPower) return "inexact";
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? "unsafe" : undefined;
}

/** Decimal `text`'s significant digits, and the power of ten of the last: `-1.50` is `["15", -1]`. */
function decimal(text: string): [string, number] {
  const [mantissa, exponent = "0"] = text.toLowerCase().replace(/^[+-]/, "").split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const significant = `${whole}${fraction}`.replace(/^0+/, "");
  const digits = significant.replace(/0+$/, "");
  return digits === "" ? ["", 0] : [digits, Number(exponent) - fraction.length + significant.length - digits.length];
}

/**
 * An ISO 8601 date (`2026-01-31`, midnight UTC) or date and time, which must name its zone (`Z`,
 * `+02:00`, `+0200` or `+02`): a time without one would be read in the local zone of wherever the CLI
 * runs. RFC 3339's space for the `T` and lowercase `t` and `z` are taken too, as SQL and `date` print
 * them. A day or time that does not exist (`2026-02-30`) is refused rather than rolled over.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|([+-])(\d{2})(?::?(\d{2}))?)?)?$/;

/** `value` as a date, by {@link ISO_DATE}, or why it is none. */
function isoDate(value: unknown): Date | "shape" | "day" | "time" | "zone" {
  const match = typeof value === "string" ? ISO_DATE.exec(value) : null;
  if (!match) return "shape";
  const [, year, month, day, hour, minute, second = "00", fraction = "", zone, sign, zoneHours = "00", zoneMinutes = "00"] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return "day";
  if (hour === undefined) return calendar;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(zoneHours) > 23 || Number(zoneMinutes) > 59) {
    return "time";
  }
  if (zone === undefined) return "zone";
  // Written in the one form `Date` must parse, whichever of the forms above it was typed in.
  const offset = sign === undefined ? "Z" : `${sign}${zoneHours}:${zoneMinutes}`;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${offset}`);
}

/** `value` as a date, by {@link ISO_DATE}, or a failure naming `label` that quotes `value` only if `quote`. */
function parseDate(value: unknown, label: string, quote = true): Date {
  const date = isoDate(value);
  if (date instanceof Date) return date;
  const it = quote ? String(value) : "it";
  const why = date === "shape" ? `got ${shown(value, quote)}` : date === "day" ? `${it} is no such date` : date === "time"
    ? `${it} is no such time` : `${it} has no zone: add Z for UTC, or an offset such as +02:00`;
  throw new UsageError(`${label} must be an ISO 8601 date, such as 2026-01-31 or 2026-01-31T12:00:00Z; ${why}.`);
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
 * carry (streams, capabilities, `Error`, ...) are passed as they are. A failure quotes the value
 * that does not fit unless `quote` is false, for one read from a file or stdin, which may hold
 * secrets: then it names only its kind (`got a string`).
 */
export function revive(value: unknown, shape: ApiShape, shapes: Record<string, ApiShape>, label = "value", quote = true): unknown {
  const resolved = resolve(shape, shapes);
  const mismatch = (expected: ApiShape = shape) =>
    new UsageError(`${label} must be ${typeText(expected)}; got ${shown(value, quote)}.`);
  const inner = (item: unknown, itemShape: ApiShape, itemLabel: string) => revive(item, itemShape, shapes, itemLabel, quote);
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
      return parseDate(value, label, quote);
    case "bytes":
      if (isPlainObject(value) && "base64" in value) return parseBase64(value, label);
      throw new UsageError(`${label} must be bytes, as {"base64": "..."}; got ${shown(value, quote)}.`);
    case "array":
      if (!Array.isArray(value)) throw mismatch();
      return value.map((item, index) => inner(item, resolved.element, `${label}[${index}]`));
    case "set":
      if (!Array.isArray(value)) throw mismatch();
      return new Set(value.map((item, index) => inner(item, resolved.element, `${label}[${index}]`)));
    case "map": {
      const entries = Array.isArray(value) ? value : isPlainObject(value) ? Object.entries(value) : null;
      if (!entries || !entries.every((entry) => Array.isArray(entry) && entry.length === 2)) throw mismatch();
      return new Map(entries.map(([key, item]: [unknown, unknown], index) => [
        inner(key, resolved.key, `${label}[${index}][0]`),
        inner(item, resolved.value, `${label}[${index}][1]`),
      ]));
    }
    case "tuple":
      if (!Array.isArray(value)) throw mismatch();
      return value.map((item, index) => {
        const element = resolved.elements[index] ?? resolved.rest;
        return element ? inner(item, element, `${label}[${index}]`) : item;
      });
    case "object": {
      if (!isPlainObject(value)) throw mismatch();
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const property = Object.hasOwn(resolved.properties, key) ? resolved.properties[key] : resolved.index;
        // Defined, not assigned: a `__proto__` key stays a property, as JSON.parse keeps it, rather
        // than replacing the prototype (which would hide the object from redactSecrets).
        Object.defineProperty(result, key, {
          value: property ? inner(item, property, `${label}.${key}`) : item,
          enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    }
    case "union": {
      // An optional value's `undefined`: a present JSON value is one of the other branches, as the
      // help writes it (`key?: T`). One branch left is checked as itself, with its own message.
      const optional = resolved.branches.some((branch) => branch.kind === "undefined");
      const union = optional ? withoutUndefined(resolved) : resolved;
      if (union.kind !== "union") return revive(value, union, shapes, label, quote);
      const candidates = union.branches.filter((branch) => fits(value, branch, shapes));
      if (candidates.length === 0) throw mismatch(shape.kind === "ref" ? shape : union);
      // Backtracking: `{ a: string } | { a: number }` both fit `{"a": 5}`, and only the second takes it.
      let first: unknown;
      for (const branch of candidates) {
        try {
          return revive(value, branch, shapes, label, quote);
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
 * JSON `value` for a failure: `an array`, `an object`, or, if `quote`, its JSON (a string quoted)
 * cut to 40 characters, so a pasted document is not repeated whole; else its kind (`a string`).
 */
function shown(value: unknown, quote: boolean): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object" && value !== null) return "an object";
  if (!quote) return value === null ? "null" : typeof value === "number" ? "a number" : typeof value === "boolean" ? "a boolean" : "a string";
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
      return isoDate(value) instanceof Date;
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
