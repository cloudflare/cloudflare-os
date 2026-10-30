import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a stream parameter is read from a file or from stdin", async (t) => {
  const h = harness(t, { stdin: "from stdin" });
  writeFileSync(join(h.root, "archive.txt"), "from a file");
  assert.equal(await h.api("import-archive", "archive.txt"), 0);
  assert.equal(await h.api("import-archive", "-"), 0);
  assert.deepEqual(h.json, ["from a file", "from stdin"]);
  await assert.rejects(h.api("import-archive", "missing.txt"), /could not read missing\.txt: ENOENT/);
});

test("`call` invokes a method by name on an untyped capability, arguments as JSON or strings", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "connect", "call", "echo", "1", '"x"', "plain", '{"a": [1]}'), 0);
  assert.deepEqual(h.json, [[1, "x", "plain", { a: [1] }]]);
  await eventually(() => h.log.disposed.includes("untyped"), "the untyped capability's disposal");

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
  assert.equal(await access.api("--dry-run", "import-archive", "missing.txt", "--url", "https://other.example.com"), 0);
  assert.deepEqual(access.json, [{
    url: "wss://other.example.com/api",
    auth: { mode: "access" },
    on: "FixtureAuthedApi",
    chain: [{ method: "importArchive", args: [{ $stream: "missing.txt" }] }],
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

test("a failing call disposes every stub of the chain and the session", async (t) => {
  const h = harness(t);
  await assert.rejects(h.api("get-admin", "set-banner", "hi"), /banner refused: hi/);
  await eventually(() => ["admin", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
  assert.equal(h.listening(), false);
});

test("a null capability in the chain ends it with null", async (t) => {
  const h = harness(t, { options: { noAdmin: true } });
  assert.equal(await h.api("get-admin", "set-banner", "hi"), 0);
  assert.deepEqual(h.json, [null]);
  assert.deepEqual(callsOf(h.log, "setBanner"), []);
});

test("a handle is disposed at once and prints null", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "lock"), 0);
  assert.deepEqual(h.json, [null]);
  await eventually(() => h.log.disposed.includes("lock"), "the handle's disposal");
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
  await assert.rejects(h.api("search", "x", "--nope"), /Unknown option '--nope'\..*[.!?] Run `cf-os api search --help` for its options\.$/);
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
    (error: Error) => !(error instanceof UsageError) && /reads the secret from CFOS_API_PASSWORD, which is not set/.test(error.message));
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
  await usageError(real.api("open-gadget", "g1", "revoke-share-link", "L1", "false", "--dry-run"), "<keepUsers> must be string[]; got false.");
  await usageError(real.api("connect-account", "google", "--resource-url-patterns", "false", "--dry-run"),
    "--resource-url-patterns must be string[]; got false.");
  assert.equal(real.server.opened, 0);
});

const CONFIGURE = "ObserverConfigCallback.configure";
const CHOICE_TYPE = "ObserverAccountChoice[], where ObserverAccountChoice = { accountId: number; gatekeeperId: number }";
const NEEDS = [{ gatekeeperId: 3, vendorId: "google", resourceTitle: "Inbox" }];
const ANSWER = `${CONFIGURE}=[{"gatekeeperId": 3, "accountId": 7}]`;

/** {@link harness} with the real table against {@link workshopRoot}: openGadget, which may ask configure. */
function workshop(t: { after: (fn: () => void) => void }, options: WorkshopOptions = {}, stdin = "") {
  return harness(t, { table: realTable, root: (log) => workshopRoot(log, options), stdin });
}

test("open-gadget passes its configuration callback, which the owner's open never calls", async (t) => {
  const h = workshop(t);
  assert.equal(await h.api("open-gadget", "g1", "get-metadata"), 0);
  assert.deepEqual(h.json, [{ id: "g1", title: "Workspace g1" }]);
  assert.deepEqual(callsOf(h.log, "openGadget"), [["g1", null, true]]);
  assert.deepEqual(callsOf(h.log, "configure"), []);
  await eventually(() => ["overseer", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a callback asking for an answer the command did not give is refused, exit 2, printing what it asked and the flag", async (t) => {
  const h = workshop(t, { needs: NEEDS });
  await usageError(h.api("open-gadget", "g1", "get-metadata"),
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
  assert.equal(await h.api("open-gadget", "g1", "get-metadata", "--answer", ANSWER), 0);
  assert.deepEqual(callsOf(h.log, "configure"), [[[{ gatekeeperId: 3, accountId: 7 }]]]);
  assert.deepEqual(h.json, [{ id: "g1", title: "Workspace g1" }]);
  assert.match(h.stderr(), /^Answered ObserverConfigCallback\.configure from --answer; it asked: \{"needs":\[/m);
});

test("a second call of an answered method is refused, printing its arguments, the failure among them", async (t) => {
  const h = workshop(t, { needs: NEEDS, reask: true });
  await usageError(h.api("open-gadget", "g1", "get-metadata", "--answer", ANSWER),
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
  assert.equal(await fromFile.api("open-gadget", "g1", "get-metadata", "--answer", `${CONFIGURE}=@choices.json`), 0);
  assert.deepEqual(callsOf(fromFile.log, "configure"), [[[{ gatekeeperId: 3, accountId: 8 }]]]);

  const fromStdin = workshop(t, { needs: NEEDS }, '[{"gatekeeperId": 3, "accountId": 9}]');
  assert.equal(await fromStdin.api("open-gadget", "g1", "get-metadata", "--answer", `${CONFIGURE}=-`), 0);
  assert.deepEqual(callsOf(fromStdin.log, "configure"), [[[{ gatekeeperId: 3, accountId: 9 }]]]);

  const wrong = workshop(t, { needs: NEEDS });
  await usageError(wrong.api("open-gadget", "g1", "get-metadata", "--answer", `${CONFIGURE}=[{"gatekeeperId": 3, "accountId": "7"}]`),
    `--answer ${CONFIGURE}[0].accountId must be number; got "7".`);
  assert.equal(wrong.server.opened, 0);
});

test("--dry-run prints the answers beside the chain, connecting to nothing", async (t) => {
  const h = workshop(t, { needs: NEEDS });
  assert.equal(await h.api("--dry-run", "open-gadget", "g1", "get-metadata", "--answer", ANSWER), 0);
  assert.deepEqual(h.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "token" },
    on: "AuthenticatedApi",
    chain: [{ method: "openGadget", args: ["g1", null, { $callback: "ObserverConfigCallback" }] }, { method: "getMetadata", args: [] }],
    answers: { [CONFIGURE]: [{ gatekeeperId: 3, accountId: 7 }] },
  }]);
  assert.equal(h.server.opened, 0);
});
