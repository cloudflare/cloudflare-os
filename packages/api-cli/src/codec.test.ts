import assert from "node:assert/strict";
import test from "node:test";
import { RpcStub, RpcTarget } from "capnweb";
import { table } from "../generator/__fixtures__/generated/commands.ts";
import { UsageError } from "./output.ts";
import { decodeArg, decodeJson, decodeUntyped, encodeValue, revive, StreamArg, type ArgSource } from "./codec.ts";
import type { ApiArg, ApiShape } from "./table.ts";

test("results encode as JSON: bigint, bytes, Date, Set, Map, Error, undefined", () => {
  assert.deepEqual(encodeValue({
    big: 2n ** 70n,
    bytes: new Uint8Array([0, 255]),
    view: new Uint16Array([1]),
    when: new Date("2026-03-04T05:06:07Z"),
    tags: new Set(["a", 1n]),
    index: new Map<unknown, unknown>([["k", new Date(0)]]),
    error: new TypeError("boom"),
    gone: undefined,
    list: [undefined, null, Number.POSITIVE_INFINITY],
    url: new URL("https://os.example.com/x"),
  }), {
    big: "1180591620717411303424",
    bytes: { base64: "AP8=" },
    view: { base64: "AQA=" },
    when: "2026-03-04T05:06:07.000Z",
    tags: ["a", "1"],
    index: [["k", "1970-01-01T00:00:00.000Z"]],
    error: { name: "TypeError", message: "boom" },
    list: [null, null, "Infinity"],
    url: "https://os.example.com/x",
  });
  assert.equal(encodeValue(undefined), null);
});

test("capabilities inside a result are marked and handed back for disposal", () => {
  let disposed = 0;
  class Target extends RpcTarget {
    [Symbol.dispose](): void {
      disposed++;
    }
  }
  const stub = new RpcStub(new Target());
  const found: Disposable[] = [];
  assert.deepEqual(encodeValue({ handle: stub, nested: [stub] }, found), { handle: { $capability: true }, nested: [{ $capability: true }] });
  assert.equal(found.length, 2);
  found[0][Symbol.dispose]();
  assert.equal(disposed, 1);
  assert.deepEqual(encodeValue(new ReadableStream()), { $stream: true });
});

const files: Record<string, string> = { "note.json": '{"created": "2026-01-01T00:00:00Z"}', "blob.bin": "\u0001\u0002" };
const source: ArgSource = {
  readFile: async (path) => {
    if (!(path in files)) throw new Error(`no ${path}`);
    return new TextEncoder().encode(files[path]);
  },
  readStdin: async () => new TextEncoder().encode('{"size": "42"}'),
};

function arg(fields: Partial<ApiArg> & Pick<ApiArg, "encoding">): ApiArg {
  return { name: "x", index: 0, type: "T", doc: "", ...fields };
}

function decode(fields: Partial<ApiArg> & Pick<ApiArg, "encoding">, token: string | boolean): Promise<unknown> {
  return decodeArg(arg(fields), token, {}, source);
}

test("scalar tokens decode by their encoding, and a bad one is a usage error naming the argument", async () => {
  assert.equal(await decode({ encoding: "string" }, "hello"), "hello");
  assert.equal(await decode({ encoding: "number" }, "-2.5"), -2.5);
  assert.equal(await decode({ encoding: "boolean" }, "false"), false);
  assert.equal(await decode({ encoding: "boolean", flag: "pinned" }, true), true);
  assert.equal(await decode({ encoding: "bigint" }, "-12345678901234567890"), -12345678901234567890n);
  assert.deepEqual(await decode({ encoding: "date" }, "2026-01-31"), new Date("2026-01-31T00:00:00.000Z"));
  assert.equal(await decode({ encoding: "string", nullable: true }, "null"), null);
  assert.equal(await decode({ encoding: "string", choices: ["a", "b"] }, "b"), "b");

  const fails = async (fields: Partial<ApiArg> & Pick<ApiArg, "encoding">, token: string, message: RegExp) =>
    assert.rejects(decode(fields, token), (error: Error) => error instanceof UsageError && message.test(error.message));
  await fails({ encoding: "string", choices: ["a", "b"] }, "c", /<x> must be one of a, b; got "c"/);
  await fails({ encoding: "number", flag: "limit" }, "ten", /--limit must be a number/);
  await fails({ encoding: "number" }, "", /must be a number/);
  await fails({ encoding: "boolean" }, "yes", /must be true or false/);
  await fails({ encoding: "bigint" }, "1.5", /must be a decimal integer/);
  await fails({ encoding: "date" }, "yesterday", /must be an ISO 8601 date/);
  await fails({ encoding: "bytes" }, "AQID", /is not valid JSON/);
  await fails({ encoding: "bytes" }, '{"base64": "*"}', /must be @<file>, - for stdin, or \{"base64": "..."\}/);
});

test("bytes come from @file, stdin or base64 JSON; a stream argument names its file without opening it", async () => {
  assert.deepEqual(await decodeArg(arg({ encoding: "bytes" }), "@blob.bin", {}, source), new Uint8Array([1, 2]));
  assert.deepEqual(await decodeArg(arg({ encoding: "bytes" }), '{"base64": "AQID"}', {}, source), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await decodeArg(arg({ encoding: "bytes" }), "-", {}, source), new TextEncoder().encode('{"size": "42"}'));
  const stream = await decodeArg(arg({ encoding: "stream" }), "archive.zip", {}, source);
  assert.ok(stream instanceof StreamArg);
  assert.equal(stream.path, "archive.zip");
  await assert.rejects(decodeArg(arg({ encoding: "callback" }), "x", {}, source), /takes no value/);
});

test("JSON arguments are revived against their shape: named shapes, unions by their literal tags", async () => {
  const note = await decodeArg(arg({ encoding: "json", shape: { kind: "ref", name: "Note" } }),
    '{"id": 1, "created": "2026-01-01T00:00:00Z", "size": "9007199254740993", "body": {"base64": "AQ=="}, "tags": ["t"], "extra": "kept"}',
    table.shapes, source) as Record<string, unknown>;
  assert.deepEqual(note, {
    id: 1,
    created: new Date("2026-01-01T00:00:00Z"),
    size: 9007199254740993n,
    body: new Uint8Array([1]),
    tags: ["t"],
    extra: "kept",
  });
  const destination = { kind: "ref", name: "Destination" } as const;
  assert.deepEqual(revive({ kind: "folder", path: "/a" }, destination, table.shapes), { kind: "folder", path: "/a" });
  assert.deepEqual(
    await decodeArg(arg({ encoding: "json", shape: { kind: "object", properties: { created: { kind: "date" } } } }), "@note.json", {}, source),
    { created: new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(
    await decodeArg(arg({ encoding: "json", shape: { kind: "object", properties: { size: { kind: "bigint" } } } }), "-", {}, source),
    { size: 42n });
  // Containers: a Set and a Map from arrays, a tuple element by position, a record by its index.
  assert.deepEqual(revive([["a", "2026-01-01T00:00:00Z"]], { kind: "map", key: { kind: "string" }, value: { kind: "date" } }, {}),
    new Map([["a", new Date("2026-01-01T00:00:00Z")]]));
  assert.deepEqual(revive(["1", "2"], { kind: "set", element: { kind: "bigint" } }, {}), new Set([1n, 2n]));
  assert.deepEqual(revive(["x", "3"], { kind: "tuple", elements: [{ kind: "string" }, { kind: "bigint" }] }, {}), ["x", 3n]);
  assert.deepEqual(revive({ a: "4" }, { kind: "object", properties: {}, index: { kind: "bigint" } }, {}), { a: 4n });
  // A union picks the branch the value fits; a value fitting none fails, naming the union.
  const union: ApiShape = { kind: "union", branches: [{ kind: "null" }, { kind: "date" }] };
  assert.deepEqual(revive("2026-01-01T00:00:00Z", union, {}), new Date("2026-01-01T00:00:00Z"));
  assert.equal(revive(null, union, {}), null);
  assert.throws(() => revive(7, union, {}), usage("value must be Date | null; got 7."));
});

/** A matcher for a {@link UsageError} whose message is exactly `message`. */
function usage(message: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof UsageError, `not a UsageError: ${String(error)}`);
    assert.equal(error.message, message);
    return true;
  };
}

const stringArray: ApiShape = { kind: "array", element: { kind: "string" } };

test("a JSON argument of the wrong type fails before anything is sent, naming the type expected there", async () => {
  const list = arg({ encoding: "json", shape: stringArray });
  await assert.rejects(decodeArg(list, "false", {}, source), usage("<x> must be string[]; got false."));
  await assert.rejects(decodeArg(list, '["a", 5]', {}, source), usage("<x>[1] must be string; got 5."));
  assert.deepEqual(await decodeArg(list, '["a", "b"]', {}, source), ["a", "b"]);

  const note = arg({ encoding: "json", shape: { kind: "ref", name: "Note" } });
  await assert.rejects(decodeArg(note, '{"tags": false}', table.shapes, source), usage("<x>.tags must be string[]; got false."));
  await assert.rejects(decodeArg(note, '{"id": "x"}', table.shapes, source), usage('<x>.id must be number; got "x".'));
  const destination = arg({ encoding: "json", shape: { kind: "ref", name: "Destination" } });
  await assert.rejects(decodeArg(destination, '{"kind": "folder", "path": 3}', table.shapes, source),
    usage("<x>.path must be string; got 3."));
  await assert.rejects(decodeArg(destination, '{"kind": "attic"}', table.shapes, source),
    usage("<x> must be Destination; got an object."));
});

test("a union's undefined branch is left out of the check; other unions backtrack, in branch order", () => {
  // An optional property's type, `string[] | undefined`: a present value is a string[].
  const optional: ApiShape = { kind: "union", branches: [stringArray, { kind: "undefined" }] };
  assert.throws(() => revive(false, optional, {}), usage("value must be string[]; got false."));
  assert.deepEqual(revive(["a"], optional, {}), ["a"]);
  // Both branches fit an object; the first fails deeper, so the second is tried.
  const either: ApiShape = {
    kind: "union",
    branches: [
      { kind: "object", properties: { a: { kind: "string" } } },
      { kind: "object", properties: { a: { kind: "number" } } },
    ],
  };
  assert.deepEqual(revive({ a: 5 }, either, {}), { a: 5 });
  assert.throws(() => revive({ a: true }, either, {}), usage("value.a must be string; got true."));
  // Without a literal discriminant, a branch declaring none of the value's keys is not tried, so a
  // wrong-typed property fails against the branch that declares it rather than passing as undeclared.
  const handle: ApiShape = {
    kind: "union",
    branches: [
      { kind: "object", properties: { id: { kind: "string" } } },
      { kind: "object", properties: { oid: { kind: "string" }, mimeType: { kind: "string" } } },
    ],
  };
  assert.throws(() => revive({ id: 5 }, handle, {}), usage("value.id must be string; got 5."));
  assert.throws(() => revive({ oid: 5, mimeType: "x" }, handle, {}), usage("value.oid must be string; got 5."));
  assert.deepEqual(revive({ oid: "o", mimeType: "x" }, handle, {}), { oid: "o", mimeType: "x" });
  const scalar: ApiShape = { kind: "union", branches: [{ kind: "number" }, { kind: "string" }] };
  assert.throws(() => revive(true, scalar, {}), usage("value must be number | string; got true."));
});

test("scalars, bigints, bytes and containers are checked as they are revived", () => {
  assert.equal(revive(12, { kind: "bigint" }, {}), 12n);
  assert.equal(revive("12", { kind: "bigint" }, {}), 12n);
  assert.throws(() => revive(1.5, { kind: "bigint" }, {}), usage("value must be bigint; got 1.5."));
  const withBody: ApiShape = { kind: "object", properties: { body: { kind: "bytes" } } };
  assert.throws(() => revive({ body: 5 }, withBody, {}), usage('value.body must be bytes, as {"base64": "..."}; got 5.'));
  assert.throws(() => revive("x", { kind: "literal", value: "y" }, {}), usage('value must be "y"; got "x".'));
  assert.throws(() => revive(0, { kind: "null" }, {}), usage("value must be null; got 0."));
  assert.throws(() => revive({}, stringArray, {}), usage("value must be string[]; got an object."));
  assert.throws(() => revive([1], { kind: "object", properties: {} }, {}), usage("value must be {}; got an array."));
  assert.throws(() => revive([[1]], { kind: "map", key: { kind: "string" }, value: { kind: "number" } }, {}),
    usage("value must be Map<string, number>; got an array."));
  assert.throws(() => revive(["x", 3], { kind: "tuple", elements: [{ kind: "string" }, { kind: "string" }] }, {}),
    usage("value[1] must be string; got 3."));
  // Extra tuple elements, undeclared properties, and what JSON cannot carry are passed as they are.
  assert.deepEqual(revive(["x", 1], { kind: "tuple", elements: [{ kind: "string" }] }, {}), ["x", 1]);
  assert.deepEqual(revive({ extra: 1 }, { kind: "object", properties: {} }, {}), { extra: 1 });
  assert.equal(revive(5, { kind: "stub" }, {}), 5);
  assert.equal(revive(5, { kind: "unsupported", reason: "r" }, {}), 5);
});

test("a failure previews the value: long JSON cut short, arrays and objects by kind", () => {
  const long = "x".repeat(60);
  assert.throws(() => revive(long, { kind: "number" }, {}), usage(`value must be number; got "${"x".repeat(36)}....`));
  assert.throws(() => revive({ a: 1 }, { kind: "string" }, {}), usage("value must be string; got an object."));
});

test("decodeJson labels its failures as told, and reads @file and - as a JSON argument does", async () => {
  await assert.rejects(decodeJson("[1]", stringArray, {}, source, "--answer X.y"), usage("--answer X.y[0] must be string; got 1."));
  const created = { kind: "object", properties: { created: { kind: "date" } } } as const;
  assert.deepEqual(await decodeJson("@note.json", created, {}, source, "--answer X.y"), { created: new Date("2026-01-01T00:00:00Z") });
  const size = { kind: "object", properties: { size: { kind: "bigint" } } } as const;
  assert.deepEqual(await decodeJson("-", size, {}, source, "--answer X.y"), { size: 42n });
  await assert.rejects(decodeJson("nope", stringArray, {}, source, "--answer X.y"),
    (error: Error) => error instanceof UsageError && error.message.startsWith("--answer X.y is not valid JSON"));
});

test("a JSON argument that admits a string takes a bare word as that string; JSON is still JSON", async () => {
  const message = arg({ encoding: "json", shape: { kind: "union", branches: [{ kind: "ref", name: "Note" }, { kind: "string" }] } });
  assert.equal(await decodeArg(message, "hello there", table.shapes, source), "hello there");
  assert.equal(await decodeArg(message, '"quoted"', table.shapes, source), "quoted");
  assert.deepEqual(await decodeArg(message, '{"id": 2}', table.shapes, source), { id: 2 });
  // Without a string branch a bare word is still an error, and @file and - are never words.
  await assert.rejects(decodeArg(arg({ encoding: "json", shape: { kind: "ref", name: "Note" } }), "hello", table.shapes, source),
    /is not valid JSON/);
  await assert.rejects(decodeArg(message, "@missing.json", table.shapes, source));
});

test("an untyped call's arguments are JSON, or the token itself when it is not", () => {
  assert.deepEqual(["1", '"x"', "plain", "[1, {\"a\": null}]", "true"].map(decodeUntyped), [1, "x", "plain", [1, { a: null }], true]);
});
