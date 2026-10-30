import assert from "node:assert/strict";
import test from "node:test";
import { RpcStub, RpcTarget } from "capnweb";
import { table } from "../generator/__fixtures__/generated/commands.ts";
import { UsageError } from "./output.ts";
import {
  decodeArg, decodeJson, decodeUntyped, encodeValue, redactSecrets, revive, SECRET, StreamArg, type ArgSource,
} from "./codec.ts";
import type { ApiArg, ApiShape } from "./table.ts";
import { typeText } from "./type-text.ts";

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

test("secrets are redacted at their paths, every leaf of each, keeping structure and the value given", () => {
  const value = {
    url: "https://a.example",
    token: "sk-1",
    headers: { "X-A": "one", "X-B": null },
    mirrors: [{ url: "m", token: "sk-2", mirrors: [{ token: "sk-3" }] }, { url: "n" }],
    when: new Date(0),
  };
  const before = structuredClone(value);
  const redacted = redactSecrets(value, [["headers"], ["mirrors", "*", "token"], ["token"], ["absent", "x"]]);
  assert.deepEqual(redacted, {
    url: "https://a.example",
    token: SECRET,
    // A record keeps its keys; a withheld (null) value holds nothing to hide.
    headers: { "X-A": SECRET, "X-B": null },
    mirrors: [{ url: "m", token: SECRET, mirrors: [{ token: "sk-3" }] }, { url: "n" }],
    when: new Date(0),
  });
  assert.deepEqual(value, before);
  // A whole value: each leaf, of any kind, through arrays, sets and maps.
  assert.deepEqual(redactSecrets({ a: [1, 2n, true, new Date(0), new Uint8Array([1])], s: new Set(["x"]),
    m: new Map([["k", "v"]]), n: undefined }, [[]]),
  { a: [SECRET, SECRET, SECRET, SECRET, SECRET], s: new Set([SECRET]), m: new Map([["k", SECRET]]), n: undefined });
  assert.equal(redactSecrets("sk", [[]]), SECRET);
  assert.equal(redactSecrets(null, [[]]), null);
  assert.deepEqual(encodeValue(redactSecrets({ token: "sk" }, [["token"]])), { token: { $secret: true } });
  assert.equal(redactSecrets(value, []), value);
  // A `__proto__` key in the JSON stays a property of the revived object, which is still redacted.
  const config = revive(JSON.parse('{"apiToken": "sk-4", "__proto__": {"custom": true}}'),
    { kind: "object", properties: { apiToken: { kind: "string" } } }, {});
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  const redactedConfig = redactSecrets(config, [["apiToken"]]) as Record<string, unknown>;
  assert.equal(redactedConfig.apiToken, SECRET);
  assert.ok(Object.hasOwn(redactedConfig, "__proto__"));
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
  checkFile: async (path) => {
    if (!(path in files) && path !== "archive.zip") throw new Error(`no ${path}`);
  },
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
  // A gatekeeper app UI's shape is named with its vendor prefix in the table, and by its own name here.
  const color = arg({ encoding: "json", shape: { kind: "array", element: { kind: "ref", name: "sketch:Color" } } });
  const colors: Record<string, ApiShape> = {
    "sketch:Color": { kind: "union", branches: [{ kind: "literal", value: "red" }, { kind: "literal", value: "blue" }] },
  };
  await assert.rejects(decodeArg(color, '["green"]', colors, source), usage('<x>[0] must be Color; got "green".'));
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

test("an untyped call's arguments follow a JSON argument's token rules, a bare word that is not JSON a string", async () => {
  const untyped = (token: string) => decodeUntyped(token, source, "call m argument 1");
  assert.deepEqual(await Promise.all(["1", '"x"', "plain", "[1, {\"a\": null}]", "true"].map(untyped)), [1, "x", "plain", [1, { a: null }], true]);
  // @file and - are read, as JSON; a literal @ or - is a JSON string.
  assert.deepEqual(await untyped("@note.json"), { created: "2026-01-01T00:00:00Z" });
  assert.deepEqual(await untyped("-"), { size: "42" });
  assert.equal(await untyped('"@alice"'), "@alice");
  assert.equal(await untyped('"-"'), "-");
  await assert.rejects(untyped("@missing.json"), /no missing\.json/);
  // What starts as JSON and does not parse is a mistake, not a string; so is a file that is not JSON.
  for (const token of ["{bad json", '{"a": 1,}', "[1", '"open']) {
    await assert.rejects(untyped(token), (error: Error) =>
      error instanceof UsageError && error.message.startsWith("call m argument 1 is not valid JSON: "), token);
  }
  // A file that is not JSON is its text, as a bare word is.
  assert.equal(await untyped("@blob.bin"), "\u0001\u0002");
});

/** A source holding `contents`, by path, and `stdin`; `checkFile` fails as readFile does for a path it lacks. */
function sourceOf(contents: Record<string, string | Uint8Array>, stdin = ""): ArgSource {
  const bytes = (value: string | Uint8Array) => typeof value === "string" ? new TextEncoder().encode(value) : value;
  return {
    readFile: async (path) => {
      if (!(path in contents)) {
        throw new UsageError(`could not read @${path}: no such file (ENOENT).`, { cause: Object.assign(new Error(path), { code: "ENOENT" }) });
      }
      if (contents[path] === "<denied>") {
        throw new UsageError(`could not read @${path}: permission denied (EACCES).`, { cause: Object.assign(new Error(path), { code: "EACCES" }) });
      }
      return bytes(contents[path]);
    },
    readStdin: async () => bytes(stdin),
    checkFile: async (path, typed) => {
      if (!(path in contents)) throw new UsageError(`could not read ${typed}: no such file (ENOENT).`);
    },
  };
}

const chatMessage = arg({ encoding: "json", shape: { kind: "union", branches: [{ kind: "ref", name: "Note" }, { kind: "string" }] } });

test("text from @file or stdin for an argument that admits a string is that text when it is not JSON", async () => {
  const texts = sourceOf({ "msg.txt": "Message from a file.\nSecond line.\n", "crlf.txt": "Hi\r\n", "note.json": '{"id": 2}', "quoted.json": '"quoted"\n' },
    "Hello from stdin\n");
  // One trailing newline is the file's last line ending, not the text's.
  assert.equal(await decodeArg(chatMessage, "@msg.txt", table.shapes, texts), "Message from a file.\nSecond line.");
  assert.equal(await decodeArg(chatMessage, "@crlf.txt", table.shapes, texts), "Hi");
  assert.equal(await decodeArg(chatMessage, "-", table.shapes, texts), "Hello from stdin");
  // JSON is still JSON, from a file as inline.
  assert.deepEqual(await decodeArg(chatMessage, "@note.json", table.shapes, texts), { id: 2 });
  assert.equal(await decodeArg(chatMessage, "@quoted.json", table.shapes, texts), "quoted");
  // An argument with no string branch takes JSON only.
  await assert.rejects(decodeArg(arg({ encoding: "json", shape: { kind: "ref", name: "Note" } }), "@msg.txt", table.shapes, texts),
    (error: Error) => error instanceof UsageError && error.message.startsWith("<x> is not valid JSON: "));
});

test("an empty file or stdin is refused, not sent as the empty string; inline '' is one", async () => {
  const texts = sourceOf({ "empty.txt": "", "newline.txt": "\n", "blank.txt": "  \r\n" });
  for (const [token, from] of [["@empty.txt", "@empty.txt is empty"], ["@newline.txt", "@newline.txt is empty but for whitespace"],
    ["@blank.txt", "@blank.txt is empty but for whitespace"], ["-", "stdin is empty"]] as const) {
    await assert.rejects(decodeArg(chatMessage, token, table.shapes, texts), (error: Error) =>
      error instanceof UsageError && error.message === `<x>: ${from}. Inline '' is the empty string, where one is wanted.`, token);
    await assert.rejects(decodeUntyped(token, texts, "call m argument 1"), UsageError, token);
  }
  assert.equal(await decodeArg(chatMessage, "", table.shapes, texts), "");
});

test("a plain string argument is taken as typed: @, - and JSON are nothing special in it", async () => {
  const title = arg({ encoding: "string", flag: "title" });
  const texts = sourceOf({ "title.txt": "Title from a file\n" }, "Title from stdin\n");
  for (const token of ["Plain title", "@title.txt", "-", "@cf/zai-org/glm-5.2", '"@alice"', "42", '{"a": 1}', ""]) {
    assert.equal(await decodeArg(title, token, {}, texts), token, token);
  }
  // Where the type admits null, the bare null is null.
  assert.equal(await decodeArg(arg({ encoding: "string", nullable: true }), "null", {}, texts), null);
  // A literal's choices are words, typed as they are.
  await assert.rejects(decodeArg(arg({ encoding: "string", choices: ["a", "b"] }), "@title.txt", {}, texts), /<x> must be one of a, b; got "@title\.txt"/);
});

test("an @token that names no file, where text is wanted, says how to type it as that text", async () => {
  const texts = sourceOf({ "secret.txt": "<denied>" });
  const hint = (token: string, quoted: string) => (error: Error) => error instanceof UsageError &&
    error.message === `could not read ${token}: no such file (ENOENT). To send ${token} itself, type it as a JSON string: ${quoted}.`;
  const handle = "@alice";
  await assert.rejects(decodeArg(chatMessage, handle, table.shapes, texts), hint(handle, `'"${handle}"'`));
  await assert.rejects(decodeUntyped(handle, texts, "call m argument 1"), hint(handle, `'"${handle}"'`));
  // The hint is typed as the shell takes it, a single quote and all.
  await assert.rejects(decodeArg(chatMessage, "@it's", table.shapes, texts), hint("@it's", `'"@it'\\''s"'`));
  assert.equal(await decodeArg(chatMessage, `"${handle}"`, table.shapes, texts), handle);
  // A file that is there but cannot be read was meant as one; JSON with no string branch, or bytes, takes no string.
  const model = "@cf/zai-org/glm-5.2";
  await assert.rejects(decodeArg(chatMessage, "@secret.txt", table.shapes, texts), (error: Error) =>
    error.message === "could not read @secret.txt: permission denied (EACCES).");
  await assert.rejects(decodeArg(arg({ encoding: "json", shape: { kind: "ref", name: "Note" } }), model, table.shapes, texts), (error: Error) =>
    error.message === `could not read ${model}: no such file (ENOENT).`);
  await assert.rejects(decodeArg(arg({ encoding: "bytes" }), model, {}, texts), (error: Error) =>
    error.message === `could not read ${model}: no such file (ENOENT).`);
});

test("JSON that a text argument takes as neither text nor its other types says how to send it as text", async () => {
  const texts = sourceOf({ "n.txt": "42\n" }, "true\n");
  const refused = (message: string) => (error: Error) => error instanceof UsageError && error.message === message;
  await assert.rejects(decodeArg(chatMessage, "42", table.shapes, texts), refused(
    "<x> must be Note | string; got 42. To send it as text, type it as a JSON string: '\"42\"'."));
  await assert.rejects(decodeArg(chatMessage, "@n.txt", table.shapes, texts), refused(
    "<x> must be Note | string; got a number. To send the file's text as text, pass it through `jq -Rs .` first."));
  await assert.rejects(decodeArg(chatMessage, "-", table.shapes, texts), refused(
    "<x> must be Note | string; got a boolean. To send stdin's text as text, pass it through `jq -Rs .` first."));
  assert.equal(await decodeArg(chatMessage, '"42"', table.shapes, texts), "42");
  // Where no string is taken, the type error is all there is to say.
  await assert.rejects(decodeArg(arg({ encoding: "json", shape: { kind: "ref", name: "Note" } }), "42", table.shapes, texts),
    refused("<x> must be Note; got 42."));
});

test("text that starts as JSON does but does not parse is text for a typed argument, and refused for `call`, inline and from a file alike", async () => {
  const texts = sourceOf({ "broken.json": '{"id": 2,}\n', "draft.txt": "[draft] hello\n" });
  for (const [token, text] of [["@broken.json", '{"id": 2,}'], ["@draft.txt", "[draft] hello"], ['{"id": 2,}', '{"id": 2,}'],
    ["[WIP] look at this", "[WIP] look at this"], ['"open', '"open']]) {
    assert.equal(await decodeArg(chatMessage, token, table.shapes, texts), text, token);
    await assert.rejects(decodeUntyped(token, texts, "call m argument 1"), (error: Error) =>
      error instanceof UsageError && error.message.startsWith("call m argument 1 is not valid JSON: ") &&
      / Text that starts with \{, \[ or " is read as JSON: to send it as text, quote it as a JSON string/.test(error.message), token);
  }
  // Quoted as a JSON string, it is text there too.
  assert.equal(await decodeUntyped('"[draft] hello"', texts, "call m argument 1"), "[draft] hello");
});

test("a JSON failure says where it is, never quoting what was read", async () => {
  const secret = "API_KEY=sk-live-SUPERSECRET\n";
  const texts = sourceOf({ "fake.env": secret, "broken.json": '{\n  "id": 1,\n  "title": SUPERSECRET\n}' }, secret);
  const note = arg({ encoding: "json", flag: "options", shape: { kind: "ref", name: "Note" } });
  for (const [token, where] of [["@fake.env", "line 1, column 1"], ["-", "line 1, column 1"], ["@broken.json", "line 3, column 12"]]) {
    await assert.rejects(decodeArg(note, token, table.shapes, texts), (error: Error) => {
      assert.ok(error instanceof UsageError);
      assert.doesNotMatch(error.message, /SUPERSECRET|API_KEY|sk-live/);
      assert.match(error.message, new RegExp(`^--options is not valid JSON: .*at ${where}\\.`));
      return true;
    }, token);
  }
  await assert.rejects(decodeUntyped("@fake.env", sourceOf({ "fake.env": "{API_KEY: 1}" }), "call m argument 1"),
    (error: Error) => error instanceof UsageError && !/API_KEY/.test(error.message));
});

test("a value read from @file or stdin that does not fit its type is named by its kind, never quoted", async () => {
  const shape: ApiShape = {
    kind: "object",
    properties: { when: { kind: "date" }, n: { kind: "number" }, tags: { kind: "array", element: { kind: "string" } } },
  };
  const config = arg({ encoding: "json", flag: "config", shape });
  const texts = sourceOf({
    "date.json": '{"when": {"apiKey": "sk-live-SECRET"}}', "day.json": '{"when": "2026-02-30"}', "string.json": '"sk-live-SECRET-0123456789abcdef"',
    "number.json": '{"n": "sk-live-SECRET"}', "tag.json": '{"tags": ["a", 5]}', "bytes.json": '{"body": "sk-live-SECRET"}',
  }, '{"when": "sk-live-SECRET"}');
  const date = "--config.when must be an ISO 8601 date, such as 2026-01-31 or 2026-01-31T12:00:00Z";
  for (const [token, message] of [
    ["@date.json", `${date}; got an object.`],
    ["-", `${date}; got a string.`],
    ["@day.json", `${date}; it is no such date.`],
    ["@string.json", `--config must be ${typeText(shape)}; got a string.`],
    ["@number.json", "--config.n must be number; got a string."],
    ["@tag.json", "--config.tags[1] must be string; got a number."],
  ] as const) {
    await assert.rejects(decodeArg(config, token, {}, texts), (error: Error) => {
      assert.ok(error instanceof UsageError);
      assert.doesNotMatch(error.message, /SECRET|2026-02-30/);
      assert.equal(error.message, message);
      return true;
    }, token);
  }
  const withBody = arg({ encoding: "json", flag: "config", shape: { kind: "object", properties: { body: { kind: "bytes" } } } });
  await assert.rejects(decodeArg(withBody, "@bytes.json", {}, texts),
    usage('--config.body must be bytes, as {"base64": "..."}; got a string.'));
  // Inline, the value is what was typed, and quoted.
  await assert.rejects(decodeArg(config, '{"n": "five"}', {}, texts), usage('--config.n must be number; got "five".'));
  await assert.rejects(decodeArg(config, '{"when": "2026-02-30"}', {}, texts), usage(`${date}; 2026-02-30 is no such date.`));
});

test("a file or stdin that is not UTF-8 text is refused, where it would be read as JSON or text", async () => {
  const binary = sourceOf({ "blob.bin": new Uint8Array([0xff, 0xfe, 0x00]) });
  await assert.rejects(decodeArg(chatMessage, "@blob.bin", table.shapes, binary),
    (error: Error) => error instanceof UsageError && error.message === "<x>: @blob.bin is not UTF-8 text.");
});

test("a Date is a real day, and a time names its zone", async () => {
  const date = (token: string) => decode({ encoding: "date" }, token);
  assert.deepEqual(await date("2026-01-31"), new Date("2026-01-31T00:00:00.000Z"));
  assert.deepEqual(await date("2026-10-24T12:00Z"), new Date("2026-10-24T12:00:00.000Z"));
  assert.deepEqual(await date("2026-10-24T12:00:00.5+02:00"), new Date("2026-10-24T10:00:00.500Z"));
  assert.deepEqual(await date("2024-02-29"), new Date("2024-02-29T00:00:00.000Z"));
  // RFC 3339's space and lowercase forms, and ISO 8601's offsets without a colon or minutes.
  for (const token of ["2026-01-31 12:00:00Z", "2026-01-31t12:00:00z", "2026-01-31T14:00:00+0200", "2026-01-31T14:00+02", "2026-01-31T12:00:00.000-00:00"]) {
    assert.deepEqual(await date(token), new Date("2026-01-31T12:00:00.000Z"), token);
  }
  const refused = (token: string, why: RegExp) => assert.rejects(date(token),
    (error: Error) => error instanceof UsageError && error.message.startsWith("<x> must be an ISO 8601 date") && why.test(error.message), token);
  for (const token of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-04-31", "2026-01-01T24:00Z", "2026-01-01T12:60Z"]) {
    await refused(token, /is no such (?:date|time)/);
  }
  for (const token of ["2026-10-24T12:00", "2026-10-24T12:00:00"]) await refused(token, /has no zone: add Z for UTC, or an offset such as \+02:00/);
  await refused("yesterday", /got "yesterday"/);
  // In a JSON argument too.
  assert.throws(() => revive("2026-02-30", { kind: "date" }, {}), (error: Error) => error instanceof UsageError && /is no such date/.test(error.message));
});

test("a number argument is a finite decimal that survives as typed", async () => {
  const number = (token: string) => decode({ encoding: "number" }, token);
  for (const [token, value] of [["-2.5", -2.5], ["1e3", 1000], ["0.1", 0.1], ["9007199254740991", 9007199254740991], ["1.50", 1.5], [".5", 0.5], ["+3", 3]] as const) {
    assert.equal(await number(token), value, token);
  }
  for (const token of ["Infinity", "-Infinity", "1e999", "NaN", "0x10", "0b1", "1_000", " 5", "9007199254740993", "0.1000000000000000055511151231257827", "1e-400",
    "9007199254740992", "-9007199254740992", "123456789012345680", "1e21"]) {
    await assert.rejects(number(token), (error: Error) => error instanceof UsageError && error.message.startsWith("<x> must be a number"), token);
  }
});

test("a number inside JSON is held to the number argument's rule, and one from a file is not quoted", async () => {
  const options = arg({ encoding: "json", flag: "options", shape: { kind: "object", properties: { beforeId: { kind: "number" } } } });
  const refused = (token: string, message: string, from = sourceOf({})) => assert.rejects(decodeArg(options, token, {}, from),
    (error: Error) => error instanceof UsageError && error.message === message, token);
  await refused('{"beforeId": 1e999}', "--options holds 1e999, which a double does not hold as typed: it would be sent as Infinity.");
  await refused('{"beforeId": 9007199254740993}',
    "--options holds 9007199254740993, which a double does not hold as typed: it would be sent as 9007199254740992.");
  await refused('{"beforeId": 9007199254740992}', "--options holds 9007199254740992, which is a whole number past " +
    "Number.MAX_SAFE_INTEGER (9007199254740991), which the server cannot tell from its neighbours.");
  await refused("@ids.json", "--options holds a number, which a double does not hold as typed, so it would be sent changed.",
    sourceOf({ "ids.json": '{"beforeId": 123456789012345678901}' }));
  // Untyped arguments and answers go the same way, and a number held as typed passes, however written.
  await assert.rejects(decodeUntyped("[1e999]", source, "call m argument 1"), /call m argument 1 holds 1e999, /);
  await assert.rejects(decodeJson("-1e400", { kind: "number" }, {}, source, "--answer k"), /--answer k holds -1e400, /);
  assert.deepEqual(await decodeArg(options, '{"beforeId": 1.50, "n": [9007199254740991, -0, 1e3]}', {}, source),
    { beforeId: 1.5, n: [9007199254740991, -0, 1000] });
});

test("JSON nested deeper than the API carries is refused as it is decoded, however deep", async () => {
  const deep = (levels: number) => `{"x": ${"[".repeat(levels)}${"]".repeat(levels)}}`;
  const object = arg({ encoding: "json", flag: "options", shape: { kind: "object", properties: {} } });
  assert.deepEqual(await decodeArg(object, deep(100), {}, source), { x: JSON.parse(deep(100)).x });
  for (const levels of [200, 20_000]) {
    await assert.rejects(decodeArg(object, deep(levels), {}, source),
      (error: Error) => error instanceof UsageError && error.message === "--options is nested more than 128 levels deep, more than cf-os api sends.");
    await assert.rejects(decodeUntyped(deep(levels), source, "call m argument 1"), UsageError);
  }
});

test("a stream argument takes @file as a byte argument does, or a bare path; it is checked, not read", async () => {
  const archive = sourceOf({ "archive.zip": "zip" });
  for (const token of ["@archive.zip", "archive.zip"]) {
    const stream = await decodeArg(arg({ encoding: "stream" }), token, {}, archive);
    assert.ok(stream instanceof StreamArg);
    assert.equal(stream.path, "archive.zip");
  }
  assert.equal((await decodeArg(arg({ encoding: "stream" }), "-", {}, archive) as StreamArg).path, "-");
  await assert.rejects(decodeArg(arg({ encoding: "stream" }), "@missing.zip", {}, archive), /could not read @missing\.zip: no such file/);
});
