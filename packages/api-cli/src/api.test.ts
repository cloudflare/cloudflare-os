import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import type { RpcTarget } from "capnweb";
import { table as realTable } from "../generated/commands.ts";
import { table } from "../generator/__fixtures__/generated/commands.ts";
import { run, type ApiDeps } from "./api.ts";
import { UsageError, type Output } from "./output.ts";
import { passwordHash } from "./session.ts";
import type { ApiTable } from "./table.ts";
import {
  callsOf, eventually, fixtureRoot, messagePortServer, serverLog, workshopRoot, type FixtureOptions, type ServerLog, type WorkshopOptions,
} from "./test-server.ts";

const NOTE_JSON = JSON.stringify({
  id: 1,
  title: "t",
  created: "2026-01-02T03:04:05Z",
  size: "12345678901234567890",
  body: { base64: "AQID" },
});

/** What CFOS_API_URL_UNAVAILABLE says in a starter whose deployment file is not configured. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

/** `text` with every run of whitespace one space, so wrapped help reads as one line. */
const flat = (text: string) => text.replace(/\s+/g, " ");

/**
 * `cf-os api` against an in-process server, as main.ts runs it: every token after `api`. The
 * default instance is `https://os.example.com` (CFOS_API_URL), with token sign-in unless `env` says
 * otherwise. Relative paths resolve in a scratch directory under the OS temp directory.
 */
function harness(
  t: { after: (fn: () => void) => void },
  { env, stdin = "", tty = false, options = {}, table: commands = table, root }: {
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    tty?: boolean;
    options?: FixtureOptions;
    table?: ApiTable;
    root?: (log: ServerLog) => RpcTarget;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "api-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const log = serverLog();
  const server = messagePortServer(log, () => root ? root(log) : fixtureRoot(log, options));
  t.after(() => server.close());
  const chunks: Buffer[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: tty });
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const json: unknown[] = [];
  const lines: string[] = [];
  const out: Output = { json: (data) => json.push(data), log: (text) => lines.push(text) };
  const spawned: string[][] = [];
  const fetched: string[] = [];
  let interrupt: (() => void) | undefined;
  const deps: ApiDeps = {
    table: commands,
    env: { CFOS_API_URL: "https://os.example.com", ...env ?? { CFOS_API_TOKEN: "good-token" } },
    open: server.open,
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      return { status: 1, stdout: "", stderr: "not logged in" };
    },
    fetch: async (url) => {
      fetched.push(url);
      return { status: 200, headers: new Headers() };
    },
    probe: async () => ({ kind: "silent" }),
    stdout,
    stdin: Readable.from([Buffer.from(stdin)]),
    onInterrupt: (listener) => {
      interrupt = listener;
      return () => {
        interrupt = undefined;
      };
    },
  };
  return {
    root: cwd,
    json,
    stderr: () => lines.join("\n"),
    log,
    server,
    spawned,
    fetched,
    stdout: () => Buffer.concat(chunks).toString("utf8"),
    stdoutStream: stdout,
    interrupt: () => {
      assert.ok(interrupt, "nothing is listening for SIGINT");
      interrupt();
    },
    listening: () => interrupt !== undefined,
    api: (...tokens: string[]) => run(tokens, { cwd, out }, deps),
  };
}

test("a chain is sent pipelined in one session, its result printed and every stub disposed", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n1", "outline"), 0);
  assert.deepEqual(h.json, [{ title: "n1", children: [{ title: "child", children: [] }] }]);
  assert.equal(h.server.opened, 1);
  assert.deepEqual(callsOf(h.log, "authenticate"), [["good-token"]]);
  // The flag is whether `outline` had already been sent when the server ran `openNotebook`: it had,
  // because nothing waited for `openNotebook`'s result before calling on it.
  assert.deepEqual(callsOf(h.log, "openNotebook"), [["n1", true]]);
  await eventually(() => ["notebook", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
  assert.equal(h.listening(), false);
});

test("optional parameters are flags, anywhere in their segment; unset ones are undefined, trailing ones trimmed", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("find-notes", "q", "--limit", "5", "--arg-url", "x"), 0);
  assert.equal(await h.api("find-notes", "--arg-url=x", "q"), 0);
  assert.equal(await h.api("find-notes", "q"), 0);
  assert.equal(await h.api("find-notes", "-5", "--limit", "-1"), 0);
  assert.deepEqual(callsOf(h.log, "findNotes"), [["q", 5, "x"], ["q", undefined, "x"], ["q"], ["-5", -1]]);
  assert.deepEqual(h.json[0], [{ id: 1, title: "q" }]);
});

test("JSON arguments are revived against their declared shape, inline, from @file or from stdin", async (t) => {
  const h = harness(t, { stdin: NOTE_JSON });
  writeFileSync(join(h.root, "dest.json"), '{"kind": "folder", "path": "/a"}');
  assert.equal(await h.api("open-notebook", "n", "file", NOTE_JSON, "@dest.json"), 0);
  assert.equal(await h.api("open-notebook", "n", "file", "-", '{"kind": "inbox"}'), 0);
  const [[note, destination], [fromStdin, inbox]] = callsOf(h.log, "file") as Record<string, unknown>[][];
  for (const received of [note, fromStdin]) {
    assert.ok(received.created instanceof Date);
    assert.equal((received.created as Date).toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(received.size, 12345678901234567890n);
    assert.deepEqual(received.body, new Uint8Array([1, 2, 3]));
  }
  assert.deepEqual(destination, { kind: "folder", path: "/a" });
  assert.deepEqual(inbox, { kind: "inbox" });
});

test("scalars, bytes and booleans decode by their encoding, and a bad token fails before connecting", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.root, "content.bin"), Buffer.from([9, 8, 7]));
  assert.equal(await h.api("set-nickname", "null"), 0);
  assert.equal(await h.api("set-mood", "busy"), 0);
  assert.equal(await h.api("open-notebook", "n", "upload", "@content.bin", "--pinned"), 0);
  assert.equal(await h.api("open-notebook", "n", "upload", '{"base64": "AQ=="}', "--no-pinned"), 0);
  assert.deepEqual(callsOf(h.log, "setNickname"), [[null]]);
  assert.deepEqual(callsOf(h.log, "setMood"), [["busy"]]);
  assert.deepEqual(callsOf(h.log, "upload"), [[new Uint8Array([9, 8, 7]), true], [new Uint8Array([1]), false]]);
  const opened = h.server.opened;
  await assert.rejects(h.api("set-mood", "angry"), (error: Error) =>
    error instanceof UsageError && /must be one of busy, calm/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "file", "{", "{}"), UsageError);
  assert.equal(h.server.opened, opened);
});

test("a subscription prints NDJSON events until --timeout, then disposes its handle and exits 0", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "subscribe", "--timeout", "0.3"), 0);
  const events = h.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["added", "removed", "ready"]);
  assert.deepEqual(events[0].args, { note: {
    id: 1,
    title: "First",
    created: "2026-01-02T03:04:05.000Z",
    size: "12345678901234567890",
    body: { base64: "AQID" },
    tags: ["a"],
  } });
  assert.deepEqual(events[1].args, { id: 7 });
  assert.deepEqual(events[2].args, {});
  assert.deepEqual(callsOf(h.log, "subscriberFailed"), []);
  await eventually(() => ["subscription", "notebook", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a bare-function callback's events are named after its parameter", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "watch-title", "--timeout", "0.2"), 0);
  assert.deepEqual(h.stdout().trim().split("\n").map((line) => JSON.parse(line)), [{ event: "callback", args: { title: "title of n" } }]);
  await eventually(() => h.log.disposed.includes("watch"), "the handle's disposal");
});

test("SIGINT ends a subscription with 130, disposing its handle", async (t) => {
  const h = harness(t);
  const running = h.api("open-notebook", "n", "subscribe");
  await eventually(() => h.stdout().trim().split("\n").length === 3, "the events");
  h.interrupt();
  assert.equal(await running, 130);
  await eventually(() => ["subscription", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a reader of stdout going away (EPIPE) ends a subscription with 0, disposing its handle", async (t) => {
  const h = harness(t);
  const running = h.api("open-notebook", "n", "subscribe");
  await eventually(() => h.stdout().trim().split("\n").length === 3, "the events");
  h.stdoutStream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.equal(await running, 0);
  await eventually(() => ["subscription", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("an EPIPE that arrives after the result is written, a tick later as pipes report it, is no crash", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("set-mood", "calm"), 0);
  assert.doesNotThrow(() => h.stdoutStream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
  // Anything else on stdout is still the failure it would be without the listener.
  assert.throws(() => h.stdoutStream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" })), /EIO/);
});

test("a subscription whose --timeout runs out before it is subscribed fails, rather than exiting 0", async (t) => {
  const h = harness(t, { env: { CFOS_API_PASSWORD: "pw" } });
  await assert.rejects(h.api("--username", "someone", "open-notebook", "n", "subscribe", "--timeout", "0.001"), /timed out/);
  assert.equal(h.stdout(), "");
});

test("a session that opens after --timeout has run out is still closed", async (t) => {
  // The password's argon2id takes far longer than the timeout, so the run is over before it connects.
  const h = harness(t, { env: { CFOS_API_PASSWORD: "pw" } });
  await assert.rejects(h.api("--username", "someone", "set-mood", "calm", "--timeout", "0.001"), /timed out/);
  await eventually(() => h.server.opened === 1 && h.log.disposed.includes("root"), "the late session's disposal");
  assert.deepEqual(callsOf(h.log, "setMood"), []);
});

test("a returned stream goes to --out, or to stdout when it is not a terminal, and nowhere on one", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("public", "download", "7", "--out", "note.txt"), 0);
  assert.equal(readFileSync(join(h.root, "note.txt"), "utf8"), "note 7\nsecond chunk\n");
  assert.equal(await h.api("public", "download", "8"), 0);
  assert.equal(h.stdout(), "note 8\nsecond chunk\n");
  // `public` signs nothing in.
  assert.deepEqual(callsOf(h.log, "authenticate"), []);

  const terminal = harness(t, { tty: true });
  await assert.rejects(terminal.api("public", "download", "7"), /pass --out <file>, or --out -/);
  assert.equal(terminal.server.opened, 0);
});

test("a byte value goes to --out decoded, or to stdout for -; a null writes nothing and prints null", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("get-photo", "p1", "--out", "photo.bin"), 0);
  assert.equal(readFileSync(join(h.root, "photo.bin"), "utf8"), "photo p1");
  assert.equal(h.stderr(), `Wrote ${join(h.root, "photo.bin")}.`);
  assert.equal(await h.api("get-photo", "p2", "--out", "-"), 0);
  assert.equal(h.stdout(), "photo p2");
  assert.equal(await h.api("get-photo", "none", "--out", "none.bin"), 0);
  assert.deepEqual(h.json, [null]);
  assert.equal(existsSync(join(h.root, "none.bin")), false);
  // Without --out, it is printed as JSON, as any value is.
  assert.equal(await h.api("get-photo", "p3"), 0);
  assert.deepEqual(h.json, [null, { base64: Buffer.from("photo p3").toString("base64") }]);

  // The real table's byte results take it too.
  const real = harness(t, { table: realTable, root: workshopRoot });
  assert.equal(await real.api("get-avatar", "alice", "--out", "avatar.png"), 0);
  assert.equal(readFileSync(join(real.root, "avatar.png"), "utf8"), "avatar of alice");
});

test("--out given with a result that is not bytes is refused before connecting, in a dry run too", async (t) => {
  const h = harness(t);
  await usageError(h.api("find-notes", "q", "--out", "x.bin"),
    "find-notes returns a value, not bytes: --out applies only to a command that returns bytes.");
  await usageError(h.api("--dry-run", "open-notebook", "n", "lock", "--out", "x.bin"),
    "lock returns a handle, not bytes: --out applies only to a command that returns bytes.");
  await usageError(h.api("open-notebook", "n", "connect", "call", "echo", "--out", "-"),
    "call echo returns an untyped value, not bytes: --out applies only to a command that returns bytes.");
  const real = harness(t, { table: realTable, root: workshopRoot });
  await usageError(real.api("list-workspaces", "--out", "x.bin"),
    "list-workspaces returns a value, not bytes: --out applies only to a command that returns bytes.");
  for (const run of [h, real]) {
    assert.equal(run.server.opened, 0);
    assert.deepEqual(run.json, []);
  }
});

test("a stream parameter is read from a file or from stdin", async (t) => {
  const h = harness(t, { stdin: "from stdin" });
  writeFileSync(join(h.root, "archive.txt"), "from a file");
  assert.equal(await h.api("import-archive", "archive.txt"), 0);
  assert.equal(await h.api("import-archive", "-"), 0);
  assert.deepEqual(h.json, ["from a file", "from stdin"]);
  await usageError(h.api("import-archive", "missing.txt"), "could not read missing.txt: no such file (ENOENT).");
});

test("`call` invokes a method by name on an untyped capability, arguments as JSON, @file, - or strings", async (t) => {
  const h = harness(t, { stdin: '{"from": "stdin"}' });
  writeFileSync(join(h.root, "args.json"), '["from a file"]');
  assert.equal(await h.api("open-notebook", "n", "connect", "call", "echo", "1", '"x"', "plain", '{"a": [1]}', "@args.json", "-", '"@literal"'), 0);
  assert.deepEqual(h.json, [[1, "x", "plain", { a: [1] }, ["from a file"], { from: "stdin" }, "@literal"]]);
  await eventually(() => h.log.disposed.includes("untyped"), "the untyped capability's disposal");

  // What starts as JSON and does not parse fails before connecting, rather than going as a string.
  await assert.rejects(h.api("open-notebook", "n", "connect", "call", "echo", "ok", "{bad json"), (error: Error) =>
    error instanceof UsageError && error.message.startsWith("call echo argument 2 is not valid JSON: "));
  await usageError(h.api("open-notebook", "n", "connect", "call", "echo", "@missing.json"),
    `could not read @missing.json: no such file (ENOENT). To send @missing.json itself, type it as a JSON string: '"@missing.json"'.`);
  // A directory is no file either, and a lone @ names the working one.
  mkdirSync(join(h.root, "docs"));
  for (const token of ["@docs", "@"]) {
    await usageError(h.api("open-notebook", "n", "connect", "call", "echo", token), `could not read ${token}: it is a directory, ` +
      `not a file (EISDIR). To send ${token} itself, type it as a JSON string: '"${token}"'.`);
  }

  await assert.rejects(h.api("open-notebook", "n", "connect"), (error: Error) =>
    error instanceof UsageError && /call <method> \[json-args\.\.\.\]/.test(error.message));
  assert.equal(h.server.opened, 1);
});

test("--dry-run prints the chain without connecting, spawning or hashing, and no secret", async (t) => {
  const password = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" } });
  assert.equal(await password.api("--username", "alice", "open-notebook", "n", "subscribe", "--since", "2026-01-01T00:00:00Z", "--dry-run"), 0);
  assert.deepEqual(password.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "password", username: "alice" },
    on: "FixtureAuthedApi",
    chain: [
      { method: "openNotebook", args: ["n"] },
      { method: "subscribe", args: [{ $callback: "NotesSubscriber" }, "2026-01-01T00:00:00.000Z"] },
    ],
  }]);
  assert.doesNotMatch(JSON.stringify(password.json), /hunter2/);

  const access = harness(t, { env: { CF_ACCESS_TOKEN: "secret.access.token" } });
  writeFileSync(join(access.root, "archive.txt"), "unread");
  assert.equal(await access.api("--dry-run", "import-archive", "archive.txt", "--url", "https://other.example.com"), 0);
  assert.deepEqual(access.json, [{
    url: "wss://other.example.com/api",
    auth: { mode: "access" },
    on: "FixtureAuthedApi",
    chain: [{ method: "importArchive", args: [{ $stream: "archive.txt" }] }],
  }]);
  assert.doesNotMatch(JSON.stringify(access.json), /secret/);

  const publicChain = harness(t, { env: {} });
  assert.equal(await publicChain.api("public", "download", "3", "--dry-run"), 0);
  assert.deepEqual(publicChain.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "access" },
    on: "FixturePublicApi",
    chain: [{ method: "download", args: [3] }],
  }]);
  for (const h of [password, access, publicChain]) {
    assert.equal(h.server.opened, 0);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.fetched, []);
  }
});

test("--dry-run prints a secret the table marks as {\"$secret\": true}, and the call sends it as given", async (t) => {
  const real = harness(t, { table: realTable });
  const config = { provider: "openai", model: "m", apiToken: "sk-test-fake-123", extraHeaders: { "X-Test": "secret-header" } };
  writeFileSync(join(real.root, "config.json"), JSON.stringify(config));
  const profile = '{"type": "agent", "id": "x", "name": "X"}';
  assert.equal(await real.api("--dry-run", "add-model", profile, "@config.json"), 0);
  assert.deepEqual((real.json[0] as { chain: unknown[] }).chain, [{
    method: "addModel",
    args: [{ type: "agent", id: "x", name: "X" }, {
      provider: "openai", model: "m", apiToken: { $secret: true }, extraHeaders: { "X-Test": { $secret: true } },
    }],
  }]);
  assert.doesNotMatch(JSON.stringify(real.json), /sk-test|secret-header/);
  assert.equal(real.server.opened, 0);

  const h = harness(t);
  const remote = { url: "https://r.example", token: "sk-1", headers: { "X-Key": "h-1" } };
  assert.equal(await h.api("add-remote", JSON.stringify(remote)), 0);
  assert.deepEqual(callsOf(h.log, "addRemote"), [[remote]]);
});

test("a failing call disposes every stub of the chain and the session", async (t) => {
  const h = harness(t);
  await assert.rejects(h.api("get-admin", "set-banner", "hi"), /banner refused: hi/);
  await eventually(() => ["admin", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
  assert.equal(h.listening(), false);
});

test("a null capability partway through the chain fails it, exit 1, naming the command that was not run", async (t) => {
  const h = harness(t, { options: { noAdmin: true } });
  assert.equal(await h.api("get-admin", "set-banner", "hi"), 1);
  assert.deepEqual(h.json, []);
  assert.equal(h.stdout(), "");
  // When the table says when it is null, so does the failure, then where to read more.
  assert.equal(h.stderr(), "`get-admin` returned null (the caller is not an admin; `find-notes` needs none): " +
    "`set-banner` was not run. See `cf-os api get-admin --help`.");
  assert.deepEqual(callsOf(h.log, "setBanner"), []);
});

test("a plain string argument is taken as typed, end to end: @ and - are nothing special in it", async (t) => {
  const real = workshop(t, {}, "Title from stdin\n");
  writeFileSync(join(real.root, "title.txt"), "Title from a file\n");
  assert.equal(await real.api("open-workspace", "w1", "set-title", "@title.txt"), 0);
  assert.equal(await real.api("open-workspace", "w1", "set-title", "-"), 0);
  assert.deepEqual(callsOf(real.log, "setTitle"), [["@title.txt"], ["-"]]);
  // A Workers AI model id goes as `list-models` gives it, unquoted.
  const model = "@cf/zai-org/glm-5.2";
  assert.equal(await real.api("open-workspace", "w1", "retry-agent", "1", model, "--dry-run"), 0);
  assert.deepEqual((real.json.at(-1) as { chain: unknown[] }).chain.at(-1), { method: "retryAgent", args: [1, model] });
});

test("a null partway through the real API's chain says why, as its method's @nullWhen does, and the help of the command", async (t) => {
  const real = workshop(t);
  assert.equal(await real.api("get-admin-api", "get-settings"), 1);
  assert.equal(real.stdout(), "");
  assert.deepEqual(real.json, []);
  assert.equal(real.stderr(), "`get-admin-api` returned null (the caller is not a deployment admin; `am-i-admin` says whether " +
    "it is): `get-settings` was not run. See `cf-os api get-admin-api --help`.");
});

test("a capability in a property of a value result is called pipelined on it, in one call naming the property", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("get-frame", "ui", "call", "echo", "1", "x"), 0);
  assert.deepEqual(h.json, [[1, "x"]]);
  // The flag is whether the call on `ui` had already been sent when the server ran getFrame.
  assert.deepEqual(callsOf(h.log, "getFrame"), [[true]]);
  assert.ok(h.log.sent.some((message) => message.includes('["ui","echo"]')), "one call, its path through the property");
  assert.equal(await h.api("get-notebook-ref", "notebook", "outline"), 0);
  assert.deepEqual(h.json[1], { title: "ref", children: [{ title: "child", children: [] }] });
  assert.deepEqual(callsOf(h.log, "getNotebookRef"), [[true]]);
  assert.equal(h.server.opened, 2);
  // A property read has no disposer of its own: what it read is released with the result it was
  // read on, once, and the run disposes the rest as for any chain.
  await eventually(() => ["untyped", "notebook"].every((name) => h.log.disposed.includes(name)) &&
    h.log.disposed.filter((name) => name === "root").length === 2, "disposal");
  assert.equal(h.log.disposed.filter((name) => name === "untyped").length, 1);
  assert.equal(h.log.disposed.filter((name) => name === "notebook").length, 1);
});

test("a null value whose property the chain reads fails it, as a null capability does", async (t) => {
  const h = harness(t, { options: { noFrame: true } });
  assert.equal(await h.api("get-frame", "ui", "call", "echo"), 1);
  assert.deepEqual(h.json, []);
  // Without a @nullWhen, it names the help that says what the result is.
  assert.equal(h.stderr(), "`get-frame` returned null, so it has no `ui`: `call echo` was not run. See `cf-os api get-frame --help`.");
  assert.deepEqual(callsOf(h.log, "echo"), []);
  // A chain that ends on the nullable result prints its null, a value like any other.
  assert.equal(await h.api("get-frame"), 0);
  assert.deepEqual(h.json, [null]);
});

test("a chain ending on a value holding capabilities prints it, and says on stderr how to go on to them", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("get-frame"), 0);
  assert.deepEqual(h.json, [{ html: "<p>frame</p>", ui: { $capability: true } }]);
  assert.equal(h.stderr(), "Its `ui` is a capability, released as this command ends; to use it, continue the chain on it: " +
    "`cf-os api get-frame ui call <method> [json-args...]`.");
  await eventually(() => h.log.disposed.includes("untyped"), "the printed capability's release");

  const none = harness(t, { options: { noFrame: true } });
  assert.equal(await none.api("get-frame"), 0);
  assert.deepEqual(none.json, [null]);
  assert.equal(none.stderr(), "");

  // Ending on the property itself sends nothing, exit 2, as ending on any capability does.
  const open = harness(t);
  await usageError(open.api("get-notebook-ref", "notebook"),
    "get-notebook-ref's `notebook` is a capability (Notebook), so the chain goes on: nothing was sent. Finish it with " +
    "one of Notebook's commands; `cf-os api get-notebook-ref notebook --help` lists them.");
  await assert.rejects(open.api("get-frame", "ui"), (error: Error) =>
    error instanceof UsageError && error.message.startsWith("get-frame's `ui` is an untyped capability, so the chain goes on: nothing was sent."));
  assert.equal(open.server.opened, 0);
});

test("a gatekeeper app UI's commands are typed by the argument naming it, and sent pipelined on its property", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("get-panel", "sketch", "ui", "draw", '{"at": "2026-01-02T03:04:05.000Z", "color": "red", "width": 2}',
    "--label", '{"text": "hi"}'), 0);
  assert.deepEqual(h.json, [{ text: "hi" }]);
  // Revived against the app's shapes: the date arrives as a Date. The call on `ui` was sent before getPanel ran.
  assert.deepEqual(callsOf(h.log, "draw"), [[{ at: new Date("2026-01-02T03:04:05.000Z"), color: "red", width: 2 }, { text: "hi" }]]);
  assert.deepEqual(callsOf(h.log, "getPanel"), [["sketch", true]]);
  assert.ok(h.log.sent.some((message) => message.includes('["ui","draw"]')), "one call, its path through the property");
  // Its arguments are checked before anything is sent.
  await assert.rejects(h.api("get-panel", "sketch", "ui", "pick", "green"), UsageError);
  assert.equal(h.server.opened, 1);
  // `call` still calls it by name, unchecked, and the dry run is the same chain either way.
  assert.equal(await h.api("get-panel", "sketch", "ui", "call", "pick", "green"), 0);
  assert.deepEqual(callsOf(h.log, "pick"), [["green"]]);
  const dry = harness(t);
  assert.equal(await dry.api("--dry-run", "get-panel", "sketch", "ui", "pick", "red"), 0);
  assert.deepEqual((dry.json[0] as { chain: unknown }).chain,
    [{ method: "getPanel", args: ["sketch"] }, { property: "ui" }, { method: "pick", args: ["red"] }]);
  // Ending on the value, the way on names a command for the typed node, `call` for any other.
  assert.equal(await h.api("get-panel", "sketch"), 0);
  assert.match(h.stderr(), /continue the chain on it: `cf-os api get-panel sketch ui <command>`\.$/);
  await eventually(() => h.log.disposed.includes("sketch"), "the app UI's release");
});

test("--dry-run shows a property read in the chain", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("--dry-run", "get-frame", "ui", "call", "echo", "1"), 0);
  assert.deepEqual((h.json[0] as { chain: unknown }).chain,
    [{ method: "getFrame", args: [] }, { property: "ui" }, { method: "echo", args: [1] }]);
  assert.equal(h.server.opened, 0);
});

test("a handle is disposed at once and prints null", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "lock"), 0);
  assert.deepEqual(h.json, [null]);
  await eventually(() => h.log.disposed.includes("lock"), "the handle's disposal");
});

test("a command that creates something prints its id on stderr, read beside the chain, a later failure included", async (t) => {
  const h = harness(t);
  // A chain going on past the capability to a command that returns nothing would otherwise lose it.
  assert.equal(await h.api("new-notebook", "lock"), 0);
  assert.deepEqual(h.json, [null]);
  assert.equal(h.stderr(), "Created notebook made.");
  // The id is read with the table's method, pipelined on the capability: one more call, in the same session.
  assert.deepEqual(callsOf(h.log, "newNotebook"), [[]]);
  assert.deepEqual(callsOf(h.log, "outline"), [["made"]]);
  assert.deepEqual(callsOf(h.log, "lock"), [[]]);
  assert.equal(h.server.opened, 1);
  await eventually(() => ["lock", "notebook", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");

  // Printed before the failure of a later command of the chain is thrown.
  const failing = harness(t);
  await assert.rejects(failing.api("new-notebook", "connect", "call", "nosuch"), (error: Error) => {
    assert.equal(failing.stderr(), "Created notebook made.");
    return !(error instanceof UsageError);
  });
  await eventually(() => ["notebook", "authed", "root"].every((name) => failing.log.disposed.includes(name)), "disposal");

  // With the real table: new-workspace reports the workspace's id, its result on stdout unchanged.
  const real = harness(t, { table: realTable, root: workshopRoot });
  assert.equal(await real.api("new-workspace", "get-metadata"), 0);
  assert.deepEqual(real.json, [{ id: "new-1", title: "Workspace new-1" }]);
  assert.equal(real.stderr(), "Created workspace new-1.");
  assert.equal(callsOf(real.log, "getMetadata").length, 2);
});

test("--dry-run shows the id a command reports beside its call", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("--dry-run", "new-notebook", "lock"), 0);
  assert.deepEqual((h.json[0] as { chain: unknown }).chain, [
    { method: "newNotebook", args: [], reportsId: { method: "outline", property: "title" } },
    { method: "lock", args: [] },
  ]);
  assert.equal(h.stderr(), "");
  assert.equal(h.server.opened, 0);
});

test("--timeout fails a call that is not a subscription, and still disposes the session", async (t) => {
  const h = harness(t, { options: { hang: true } });
  await assert.rejects(h.api("set-mood", "calm", "--timeout", "0.05"), /timed out after 0\.05s/);
  assert.deepEqual(callsOf(h.log, "setMood"), [["calm"]]);
  await eventually(() => ["authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("ending on a capability is a usage error that says nothing was sent and how to finish the chain", async (t) => {
  const h = harness(t);
  const incomplete = async (...tokens: string[]) => {
    const error = await h.api(...tokens).then(() => assert.fail("no usage error"), (thrown: unknown) => thrown);
    assert.ok(error instanceof UsageError);
    return error.message;
  };
  assert.equal(await incomplete("open-notebook", "my notes"),
    "open-notebook returns a capability (Notebook), so the chain goes on: nothing was sent. Finish it with one of " +
    "Notebook's commands; `cf-os api open-notebook 'my notes' --help` lists them.");
  // An example only where a command's name promises a read: whoever is told it may run it as it is.
  assert.match(await incomplete("get-admin"), /Finish it with one of FixtureAdmin's commands; /);
  assert.match(await incomplete("open-notebook", "n", "connect"),
    /^connect returns an untyped capability, so the chain goes on: nothing was sent\. Finish it with `call <method> \[json-args\.\.\.\]`/);
  assert.equal(await incomplete(), 'cf-os api names no command, so nothing was sent. Find one with `cf-os api search "<task>"`; ' +
    "`cf-os api --help` lists them.");
  assert.match(await incomplete("public"), /^cf-os api public names no command/);
  assert.equal(h.server.opened, 0);
});

test("search prints the best matches as JSON, whole command lines, and connects to nothing", async (t) => {
  const h = harness(t);
  // Runtime options are taken and ignored, wherever they are.
  assert.equal(await h.api("--url", "https://example.invalid", "search", "subscribe", "to", "a", "notebook", "--dry-run"), 0);
  const matches = h.json[0] as { command: string; summary: string }[];
  assert.deepEqual(matches[0], { command: "cf-os api open-notebook <id> subscribe", summary: "A callback interface." });
  assert.ok(matches.length <= 5);
  assert.equal(await h.api("search", "--help"), 0);
  assert.match(h.stdout(), /^Usage: cf-os api search "<describe the task>"/);
  await assert.rejects(h.api("search"), /search needs a task/);
  // An option it does not take is refused as a generated command refuses one, never in node:util's words.
  await assert.rejects(h.api("search", "x", "--nope"), /^Error: Unknown option --nope for search\. Run `cf-os api search --help` for its options\.$/);
  await assert.rejects(h.api("search", "x", "--limit", "3"), /^Error: Unknown option --limit for search\. Run `cf-os api search --help` for its options\.$/);
  // `search` is a word only in a command's first place.
  await assert.rejects(h.api("open-notebook", "n", "search"), /Notebook has no command "search"/);
  assert.equal(h.server.opened, 0);
});

test("--help prints the help of the command or capability reached so far, on stdout", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "--help"), 0);
  assert.match(h.stdout(), /Usage: cf-os api open-notebook <id>/);
  assert.match(h.stdout(), /Returns a capability on Notebook/);
  assert.equal(await h.api("public", "-h"), 0);
  assert.match(h.stdout(), /Commands on FixturePublicApi:/);
  assert.equal(await h.api("open-notebook", "n", "subscribe", "--help"), 0);
  assert.match(h.stdout(), /added\(note\) +A note was added\./);
  // On a line with a forgotten positional, after the error the line is without `--help`.
  assert.equal(await h.api("open-notebook", "file", "outline", "--help"), 0);
  assert.match(h.stdout(), /\n"file" was taken for open-notebook's <id>, not as a command of Notebook: nothing was sent\. [^\n]*\n\nUsage: cf-os api open-notebook file outline/);
  assert.equal(h.server.opened, 0);
});

test("a token after a chain-ending result, or an unknown command, is a usage error", async (t) => {
  const h = harness(t);
  await assert.rejects(h.api("set-mood", "calm", "ping"), (error: Error) =>
    error instanceof UsageError && /set-mood returns nothing, which ends the chain/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "outline", "lock"), (error: Error) =>
    error instanceof UsageError && /outline returns a value, which ends the chain/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "nope"), (error: Error) => error instanceof UsageError &&
    /Notebook has no command "nope"\. Find one with `cf-os api search "<task>"`, or run `cf-os api open-notebook n --help` for Notebook's\./
      .test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "outline", "--limit", "1"), /Unknown option --limit for outline/);
  await assert.rejects(h.api("open-notebook"), /open-notebook needs <id>/);
  assert.equal(h.server.opened, 0);
});

test("create-account makes a password account on PublicApi, which --username then signs in as", async (t) => {
  const h = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" } });
  const dev = ["--url", "http://localhost:8787"];
  assert.equal(await h.api("create-account", "alice", "--display-name", "Alice A", ...dev), 0);
  assert.deepEqual(h.json, [{ username: "alice", displayName: "Alice A" }]);
  const hash = Buffer.from(await passwordHash("alice", "hunter2", table.constants.SERVICE_SALT)).toString("hex");
  assert.deepEqual(callsOf(h.log, "createAccount"), [["alice", "Alice A", hash]]);
  // No sign-in, nor an Access token for a dev server; and the session is closed.
  assert.deepEqual(callsOf(h.log, "authenticate"), []);
  assert.deepEqual(h.spawned, []);
  await eventually(() => h.log.disposed.includes("root"), "the session's disposal");
  assert.match(h.stderr(), /Created alice\. Act as it with `cf-os api --username alice <command>` and --url http:\/\/localhost:8787/);

  assert.equal(await h.api("--username", "alice", "set-mood", "calm", ...dev), 0);
  assert.deepEqual(callsOf(h.log, "login"), [["alice", hash]]);
  assert.deepEqual(callsOf(h.log, "setMood"), [["calm"]]);
  // Neither the password, its hash nor the session token createAccount returned is printed.
  assert.doesNotMatch(JSON.stringify(h.json) + h.stderr() + h.stdout(), new RegExp(`hunter2|${hash}|session-token`));

  // --display-name defaults to the username; a second account of a name is refused, naming why.
  assert.equal(await h.api("create-account", "carol", ...dev), 0);
  assert.deepEqual(h.json.at(-1), { username: "carol", displayName: "carol" });
  await assert.rejects(h.api("create-account", "alice", ...dev), (error: Error) =>
    !(error instanceof UsageError) && error.message.startsWith("could not create the account alice: the name is taken."));
});

test("create-account surfaces a refusal, needs CFOS_API_PASSWORD, and --dry-run prints no secret", async (t) => {
  const closed = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" }, options: { signupsClosed: true } });
  await assert.rejects(closed.api("create-account", "alice", "--url", "http://localhost:8787"),
    /^Error: could not create the account alice: New signups are currently disabled on this deployment\.$/);

  const unset = harness(t, { env: {} });
  await assert.rejects(unset.api("create-account", "alice", "--url", "http://localhost:8787"),
    (error: Error) => error instanceof UsageError && /reads the secret from CFOS_API_PASSWORD, which is not set/.test(error.message));
  assert.equal(unset.server.opened, 0);

  const dry = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" } });
  assert.equal(await dry.api("create-account", "alice", "--dry-run"), 0);
  assert.deepEqual(dry.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "access" },
    on: "FixturePublicApi",
    chain: [{ method: "createAccount", args: ["alice", "alice", { $passwordHash: "CFOS_API_PASSWORD" }] }],
  }]);
  assert.doesNotMatch(JSON.stringify(dry.json), /hunter2/);
  assert.equal(dry.server.opened, 0);
  assert.deepEqual(dry.spawned, []);

  assert.equal(await dry.api("create-account", "--help"), 0);
  assert.match(dry.stdout(), /^Usage: cf-os api create-account <username>/);
  await assert.rejects(dry.api("create-account"), (error: Error) => error instanceof UsageError && /needs <username>/.test(error.message));
});

test("create-account on an https:// instance not behind Access connects with --auth token, needing no CFOS_API_TOKEN", async (t) => {
  const h = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" } });
  const staging = ["--url", "https://staging.example.com", "--auth", "token"];
  assert.equal(await h.api("create-account", "alice", ...staging, "--dry-run"), 0);
  assert.deepEqual((h.json.at(-1) as { auth: unknown }).auth, { mode: "token" });
  assert.equal(await h.api("create-account", "alice", ...staging), 0);
  assert.deepEqual(h.json.at(-1), { username: "alice", displayName: "alice" });
  assert.deepEqual(h.spawned, []);
});

/** The usage error `promise` rejects with, its message exactly `message`. */
async function usageError(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.ok(error instanceof UsageError, `not a usage error: ${error?.stack ?? String(error)}`);
    assert.equal(error.message, message);
    return true;
  });
}

test("without --url the instance is CFOS_API_URL's, else the local dev server's; --url beats both", async (t) => {
  const dev = harness(t, { env: { CFOS_API_URL: "" } });
  assert.equal(await dev.api("--dry-run", "set-mood", "calm"), 0);
  assert.deepEqual(dev.json[0], { url: "ws://localhost:8787/api", auth: { mode: "token" }, on: "FixtureAuthedApi", chain: [{ method: "setMood", args: ["calm"] }] });

  const named = harness(t, { env: {} });
  assert.equal(await named.api("--dry-run", "set-mood", "calm"), 0);
  assert.deepEqual(named.json[0], { url: "wss://os.example.com/api", auth: { mode: "access" }, on: "FixtureAuthedApi", chain: [{ method: "setMood", args: ["calm"] }] });

  const explicit = harness(t);
  assert.equal(await explicit.api("--url", "http://localhost:9999", "--dry-run", "set-mood", "calm"), 0);
  assert.equal((explicit.json[0] as { url: string }).url, "ws://localhost:9999/api");
});

test("with no instance (CFOS_API_URL_UNAVAILABLE), a run that needs one fails with exactly its reason; the rest work", async (t) => {
  const h = harness(t, { env: { CFOS_API_URL: "", CFOS_API_URL_UNAVAILABLE: REASON, CFOS_API_TOKEN: "good-token" } });
  assert.equal(await h.api("search", "list notes"), 0);
  assert.ok(Array.isArray(h.json.at(-1)));
  assert.equal(await h.api("types"), 0);
  assert.equal(await h.api("--help"), 0);
  assert.ok(flat(h.stdout()).includes(`No default here: ${REASON}`));
  const helpEnd = h.stdout().length;
  assert.equal(await h.api("create-account", "--help"), 0);
  assert.ok(flat(h.stdout().slice(helpEnd)).includes(`No default here: ${REASON}`));
  assert.equal(await h.api("open-notebook", "--help"), 0);
  assert.equal(await h.api("--url", "http://localhost:9999", "--dry-run", "set-mood", "calm"), 0);
  assert.equal((h.json.at(-1) as { url: string }).url, "ws://localhost:9999/api");

  await usageError(h.api("--dry-run", "set-mood", "calm"), REASON);
  await usageError(h.api("open-notebook", "n", "outline"), REASON);
  await usageError(h.api("create-account", "bob", "--dry-run"), REASON);
  assert.equal(h.server.opened, 0);

  // CFOS_API_URL, when a caller sets it as well, is the instance.
  const both = harness(t, { env: { CFOS_API_URL: "https://os.example.com", CFOS_API_URL_UNAVAILABLE: REASON } });
  assert.equal(await both.api("--dry-run", "set-mood", "calm"), 0);
  assert.equal((both.json[0] as { url: string }).url, "wss://os.example.com/api");
});

test("a JSON argument of the wrong type fails before connecting, naming the type it must be", async (t) => {
  const h = harness(t);
  const note = '{"id": "x", "title": "t", "created": "2026-01-02T03:04:05Z", "size": "1", "body": {"base64": "AQ=="}}';
  await usageError(h.api("open-notebook", "n", "file", note, '{"kind": "inbox"}'), '<note>.id must be number; got "x".');
  assert.equal(h.server.opened, 0);

  const real = harness(t, { table: realTable });
  // revoke-share-link is Overseer's: on the root it would fail as an unknown command, before any check.
  await usageError(real.api("open-workspace", "g1", "revoke-share-link", "L1", "false", "--dry-run"), "<keepUsers> must be string[]; got false.");
  await usageError(real.api("connect-account", "google", "--resource-url-patterns", "false", "--dry-run"),
    "--resource-url-patterns must be string[]; got false.");
  assert.equal(real.server.opened, 0);
});

const CONFIGURE = "ObserverConfigCallback.configure";
const CHOICE_TYPE = "ObserverAccountChoice[], where ObserverAccountChoice = { accountId: number; gatekeeperId: number }";
const NEEDS = [{ gatekeeperId: 3, vendorId: "google", resourceTitle: "Inbox" }];
const ANSWER = `${CONFIGURE}=[{"gatekeeperId": 3, "accountId": 7}]`;

/** {@link harness} with the real table against {@link workshopRoot}: openWorkspace, which may ask configure. */
function workshop(t: { after: (fn: () => void) => void }, options: WorkshopOptions = {}, stdin = "") {
  return harness(t, { table: realTable, root: (log) => workshopRoot(log, options), stdin });
}

test("open-workspace passes its configuration callback, which the owner's open never calls", async (t) => {
  const h = workshop(t);
  assert.equal(await h.api("open-workspace", "g1", "get-metadata"), 0);
  assert.deepEqual(h.json, [{ id: "g1", title: "Workspace g1" }]);
  assert.deepEqual(callsOf(h.log, "openWorkspace"), [["g1", null, true]]);
  assert.deepEqual(callsOf(h.log, "configure"), []);
  await eventually(() => ["overseer", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a callback asking for an answer the command did not give is refused, exit 2, printing what it asked and the flag", async (t) => {
  const h = workshop(t, { needs: NEEDS });
  await usageError(h.api("open-workspace", "g1", "get-metadata"),
    `${CONFIGURE} asked for an answer, and the command gave none (--answer), so cf-os api refused it and stopped. It asked:\n` +
    `{"needs":[{"gatekeeperId":3,"vendorId":"google","resourceTitle":"Inbox"}]}\n` +
    `Run the command again with --answer '${CONFIGURE}=<json|@file|->', the JSON of type ${CHOICE_TYPE}.`);
  assert.deepEqual(callsOf(h.log, "getMetadata"), []);
  await eventually(() => h.log.disposed.includes("root"), "the session's disposal");
  assert.equal(h.stdout(), "");
  assert.deepEqual(h.json, []);
});

test("--answer answers the callback's first call, and says on stderr what it asked", async (t) => {
  const h = workshop(t, { needs: NEEDS });
  assert.equal(await h.api("open-workspace", "g1", "get-metadata", "--answer", ANSWER), 0);
  assert.deepEqual(callsOf(h.log, "configure"), [[[{ gatekeeperId: 3, accountId: 7 }]]]);
  assert.deepEqual(h.json, [{ id: "g1", title: "Workspace g1" }]);
  assert.match(h.stderr(), /^Answered ObserverConfigCallback\.configure from --answer; it asked: \{"needs":\[/m);
});

test("a second call of an answered method is refused, printing its arguments, the failure among them", async (t) => {
  const h = workshop(t, { needs: NEEDS, reask: true });
  await usageError(h.api("open-workspace", "g1", "get-metadata", "--answer", ANSWER),
    `${CONFIGURE} asked again, and its --answer answers only the first call, so cf-os api refused this one and stopped. It asked:\n` +
    `{"needs":[{"gatekeeperId":3,"vendorId":"google","resourceTitle":"Inbox","failure":{"accountId":0,"reason":"expired"}}]}\n` +
    `Run the command again with an --answer '${CONFIGURE}=<json|@file|->' that settles it the first time it asks, ` +
    `the JSON of type ${CHOICE_TYPE}.`);
  assert.equal(h.stderr().split("\n").filter((line) => line.startsWith("Answered")).length, 1);
  assert.deepEqual(callsOf(h.log, "configure"), [[[{ gatekeeperId: 3, accountId: 7 }]]]);
  assert.deepEqual(callsOf(h.log, "getMetadata"), []);
  await eventually(() => h.log.disposed.includes("root"), "the session's disposal");
});

test("an answer may come from @file or stdin, and one of the wrong type fails before connecting", async (t) => {
  const fromFile = workshop(t, { needs: NEEDS });
  writeFileSync(join(fromFile.root, "choices.json"), '[{"gatekeeperId": 3, "accountId": 8}]');
  assert.equal(await fromFile.api("open-workspace", "g1", "get-metadata", "--answer", `${CONFIGURE}=@choices.json`), 0);
  assert.deepEqual(callsOf(fromFile.log, "configure"), [[[{ gatekeeperId: 3, accountId: 8 }]]]);

  const fromStdin = workshop(t, { needs: NEEDS }, '[{"gatekeeperId": 3, "accountId": 9}]');
  assert.equal(await fromStdin.api("open-workspace", "g1", "get-metadata", "--answer", `${CONFIGURE}=-`), 0);
  assert.deepEqual(callsOf(fromStdin.log, "configure"), [[[{ gatekeeperId: 3, accountId: 9 }]]]);

  const wrong = workshop(t, { needs: NEEDS });
  await usageError(wrong.api("open-workspace", "g1", "get-metadata", "--answer", `${CONFIGURE}=[{"gatekeeperId": 3, "accountId": "7"}]`),
    `--answer ${CONFIGURE}[0].accountId must be number; got "7".`);
  assert.equal(wrong.server.opened, 0);
});

test("--dry-run prints the answers beside the chain, connecting to nothing", async (t) => {
  const h = workshop(t, { needs: NEEDS });
  assert.equal(await h.api("--dry-run", "open-workspace", "g1", "get-metadata", "--answer", ANSWER), 0);
  assert.deepEqual(h.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "token" },
    on: "AuthenticatedApi",
    chain: [{ method: "openWorkspace", args: ["g1", null, { $callback: "ObserverConfigCallback" }] }, { method: "getMetadata", args: [] }],
    answers: { [CONFIGURE]: [{ gatekeeperId: 3, accountId: 7 }] },
  }]);
  assert.equal(h.server.opened, 0);
});

test("a stream's file is checked before connecting, a dry run too: @file as for bytes, never a directory", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.root, "archive.txt"), "from a file");
  assert.equal(await h.api("import-archive", "@archive.txt"), 0);
  assert.deepEqual(h.json, ["from a file"]);
  const opened = h.server.opened;
  for (const dryRun of [[], ["--dry-run"]]) {
    await usageError(h.api(...dryRun, "import-archive", "."), "could not read .: it is a directory, not a file (EISDIR).");
    await usageError(h.api(...dryRun, "import-archive", "@missing.txt"), "could not read @missing.txt: no such file (ENOENT).");
  }
  assert.equal(h.server.opened, opened);
});

test("an --out that cannot be written is refused before connecting, a dry run too", async (t) => {
  const h = harness(t);
  for (const dryRun of [[], ["--dry-run"]]) {
    await usageError(h.api(...dryRun, "get-photo", "p", "--out", "."), `--out ${h.root}: it is a directory, not a file.`);
    await usageError(h.api(...dryRun, "get-photo", "p", "--out", "nowhere/photo.bin"),
      `--out ${join(h.root, "nowhere", "photo.bin")}: its directory ${join(h.root, "nowhere")} does not exist.`);
    await usageError(h.api(...dryRun, "get-photo", "p", "--out="), "--out needs a file, or - for stdout.");
  }
  assert.equal(h.server.opened, 0);
});

test("an --out the file system cannot resolve is refused before connecting, not read as a new file", async (t) => {
  const h = harness(t);
  const long = "a".repeat(300);
  symlinkSync("loop", join(h.root, "loop"));
  symlinkSync(join(h.root, "nowhere", "photo.bin"), join(h.root, "dangling"));
  mkdirSync(join(h.root, "there"));
  symlinkSync(join(h.root, "there", "photo.bin"), join(h.root, "ahead"));
  for (const dryRun of [[], ["--dry-run"]]) {
    await usageError(h.api(...dryRun, "get-photo", "p", "--out", long), `--out ${join(h.root, long)}: the name is too long (ENAMETOOLONG).`);
    await usageError(h.api(...dryRun, "get-photo", "p", "--out", "loop"),
      `--out ${join(h.root, "loop")}: too many levels of symbolic links (ELOOP).`);
    // A link to a file not yet made is written through: where it points is what is checked.
    await usageError(h.api(...dryRun, "get-photo", "p", "--out", "dangling"),
      `--out ${join(h.root, "nowhere", "photo.bin")}: its directory ${join(h.root, "nowhere")} does not exist.`);
  }
  assert.equal(h.server.opened, 0);
  assert.equal(await h.api("--dry-run", "get-photo", "p", "--out", "ahead"), 0);
});

test("--dry-run of JSON nested too deep fails as a usage error, not a stack overflow", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.root, "deep.json"), `{"x": ${"[".repeat(3000)}${"]".repeat(3000)}}`);
  await usageError(h.api("--dry-run", "open-notebook", "n", "connect", "call", "echo", "@deep.json"),
    "call echo argument 1 is nested more than 128 levels deep, more than cf-os api sends.");
});
