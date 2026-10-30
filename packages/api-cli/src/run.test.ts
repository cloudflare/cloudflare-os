import assert from "node:assert/strict";
import test from "node:test";
import { table as realTable } from "../generated/commands.ts";
import { table } from "../generator/__fixtures__/generated/commands.ts";
import { UsageError } from "./output.ts";
import {
  commandHelp, decodeCalls, dryRunChain, incompleteChain, nodeHelp, parseInvocation, parseSearch, searchCommands, untypedHelp, urlHelp,
  type Hop,
} from "./run.ts";
import type { DefaultInstance } from "./session.ts";

/** What CFOS_API_URL_UNAVAILABLE says in a starter whose deployment file is not configured. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

/** `text` with every run of whitespace one space, so wrapped help reads as one line. */
const flat = (text: string) => text.replace(/\s+/g, " ");

const noFiles = {
  readFile: async () => assert.fail("read a file"),
  readStdin: async () => assert.fail("read stdin"),
};

function names(hops: Hop[]): string[] {
  return hops.map((hop) => hop.kind === "command" ? hop.name : `call ${hop.method}`);
}

test("segments take their command's positionals; flags may sit anywhere before the next segment", () => {
  const invocation = parseInvocation(table, ["--dry-run", "open-notebook", "--timeout", "5", "n1", "subscribe", "--since", "2026-01-01", "--url=http://localhost:8787"]);
  assert.deepEqual(names(invocation.hops), ["open-notebook", "subscribe"]);
  const [open, subscribe] = invocation.hops as Extract<Hop, { kind: "command" }>[];
  assert.deepEqual(open.positionals, ["n1"]);
  assert.deepEqual(subscribe.flags, { since: "2026-01-01" });
  assert.deepEqual(invocation.flags, { url: "http://localhost:8787", auth: undefined, username: undefined, dryRun: true, timeout: 5, out: undefined, answers: [] });
  assert.deepEqual(invocation.end, { kind: "result", returns: { kind: "subscription" } });
  assert.deepEqual(invocation.path, ["open-notebook", "n1", "subscribe"]);
  assert.equal(invocation.public, false);
});

test("a leading `public` starts on PublicApi; a capability or untyped result left open ends the walk there", () => {
  const publicChain = parseInvocation(table, ["public", "download", "3"]);
  assert.equal(publicChain.public, true);
  assert.deepEqual(names(publicChain.hops), ["download"]);
  assert.deepEqual(parseInvocation(table, []).end, { kind: "node", node: "FixtureAuthedApi" });
  assert.deepEqual(parseInvocation(table, ["public"]).end, { kind: "node", node: "FixturePublicApi" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n"]).end, { kind: "node", node: "Notebook" });
  assert.deepEqual(parseInvocation(table, ["get-admin"]).end, { kind: "node", node: "FixtureAdmin" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect"]).end, { kind: "untyped" });
  // `public` is only a segment in first place: elsewhere it is a positional like any other.
  assert.deepEqual((parseInvocation(table, ["open-notebook", "public"]).hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["public"]);
});

test("`call` segments continue an untyped capability, taking every token up to the next `call`", () => {
  const invocation = parseInvocation(table, ["open-notebook", "n", "connect", "call", "a", "1", "x", "call", "b"]);
  assert.deepEqual(invocation.hops.slice(2), [{ kind: "call", method: "a", args: ["1", "x"] }, { kind: "call", method: "b", args: [] }]);
  assert.deepEqual(invocation.end, { kind: "result", returns: { kind: "call" } });
  assert.throws(() => parseInvocation(table, ["open-notebook", "n", "connect", "outline"]), /continue with `call <method>/);
  assert.throws(() => parseInvocation(table, ["open-notebook", "n", "connect", "call"]), /call needs a method name/);
});

test("`--` makes the rest positionals, so values that look like flags pass through", () => {
  const invocation = parseInvocation(table, ["find-notes", "--", "--limit"]);
  assert.deepEqual((invocation.hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["--limit"]);
});

function usage(tokens: string[], message: RegExp): void {
  assert.throws(() => parseInvocation(table, tokens), (error: Error) => error instanceof UsageError && message.test(error.message));
}

test("what the table does not allow is a usage error that says what to run", () => {
  usage(["nope"], /FixtureAuthedApi has no command "nope"\. Find one with `cf-os api search "<task>"`, or run `cf-os api --help`/);
  usage(["public", "nope"], /FixturePublicApi has no command "nope"\. .* run `cf-os api public --help` for FixturePublicApi's\./);
  usage(["find-notes"], /find-notes needs <query>/);
  usage(["find-notes", "q", "--bogus"], /Unknown option --bogus for find-notes/);
  usage(["--bogus"], /Unknown option --bogus\./);
  usage(["set-mood", "calm", "lock"], /set-mood returns nothing, which ends the chain/);
  usage(["find-notes", "q", "--timeout", "0"], /--timeout must be a positive number/);
  // node:util's own messages become one sentence, with where to read about the option after it: the
  // root's help for a runtime option, the segment's own for a command's, typed as a shell needs it.
  usage(["find-notes", "q", "--dry-run=yes"], /^Option '--dry-run' does not take an argument\. Run `cf-os api --help` for the API options\.$/);
  usage(["find-notes", "q", "--limit"], /^--limit needs a value\. Run `cf-os api find-notes --help` for its options\.$/);
  usage(["open-notebook", "my notes", "outline", "--bogus"], /^Unknown option --bogus for outline\. Run `cf-os api open-notebook 'my notes' outline --help` for its options\.$/);
  usage(["open-notebook", "my notes", "nope"], /run `cf-os api open-notebook 'my notes' --help` for Notebook's\.$/);
  // A positional only `--` let through cuts the pointer short: no `--help` can follow a `--`.
  usage(["open-notebook", "--", "--weird", "nope"], /run `cf-os api open-notebook --help` for Notebook's\.$/);
  usage(["open-notebook", "--", "--", "nope"], /run `cf-os api open-notebook --help` for Notebook's\.$/);
});

test("a chain left open says how to finish it, in commands that run as typed", () => {
  // A token only `--` let through gets its `--` back in the example, which then walks as suggested,
  // and cuts the help pointer short, since `--help` cannot follow a `--`.
  for (const token of ["--weird", "--", "-h"]) {
    const message = incompleteChain(realTable, parseInvocation(realTable, ["open-gadget", "--", token]));
    const example = /as in `cf-os api ([^`]*)`/.exec(message)![1].split(" ").map((word) => word.replace(/^'(.*)'$/, "$1"));
    assert.deepEqual(example, ["open-gadget", "--", token, "get-metadata"]);
    const walked = parseInvocation(realTable, example);
    assert.deepEqual(names(walked.hops), ["open-gadget", "get-metadata"]);
    assert.deepEqual((walked.hops[0] as Extract<Hop, { kind: "command" }>).positionals, [token]);
    assert.match(message, /; `cf-os api open-gadget --help` lists them\.$/);
  }
  assert.match(incompleteChain(realTable, parseInvocation(realTable, ["open-gadget", "my id"])), /as in `cf-os api open-gadget 'my id' get-metadata`; `cf-os api open-gadget 'my id' --help` lists them\.$/);
});

test("--help stops the walk at the segment it is in", () => {
  assert.deepEqual(parseInvocation(table, ["--help", "nope"]).help, { kind: "node", node: "FixtureAuthedApi" });
  assert.deepEqual(parseInvocation(table, ["public", "-h"]).help, { kind: "node", node: "FixturePublicApi" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "--help"]).help, { kind: "command", node: "FixtureAuthedApi", name: "open-notebook", at: 1 });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "file", "-h"]).help, { kind: "command", node: "Notebook", name: "file", at: 3 });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect", "call", "x", "--help"]).help, { kind: "untyped" });
});

test("calls are decoded with unset optionals undefined, trailing ones trimmed, callbacks and streams as placeholders", async () => {
  const decode = async (tokens: string[]) => (await decodeCalls(table, parseInvocation(table, tokens), noFiles)).calls;
  assert.deepEqual((await decode(["find-notes", "q", "--arg-url", "u"]))[0].args, ["q", undefined, "u"]);
  assert.deepEqual((await decode(["find-notes", "q"]))[0].args, ["q"]);
  assert.deepEqual(dryRunChain(await decode(["open-notebook", "n", "subscribe", "--since", "2026-01-01"])), [
    { method: "openNotebook", args: ["n"] },
    { method: "subscribe", args: [{ $callback: "NotesSubscriber" }, "2026-01-01T00:00:00.000Z"] },
  ]);
  assert.deepEqual(dryRunChain(await decode(["open-notebook", "n", "watch-title"])).at(-1), { method: "watchTitle", args: [{ $function: "callback" }] });
  assert.deepEqual(dryRunChain(await decode(["import-archive", "a.zip"])), [{ method: "importArchive", args: [{ $stream: "a.zip" }] }]);
  await assert.rejects(decodeCalls(table, parseInvocation(table, ["open-notebook", "n", "file", "-", "-"]), {
    readFile: noFiles.readFile,
    readStdin: async () => new TextEncoder().encode("{}"),
  }), /Only one argument can read stdin/);
});

test("help lists a capability's commands and a command's arguments, events and result", () => {
  const root = nodeHelp(realTable, realTable.root, []);
  // The root opens with how an agent finds a command, in three lines.
  assert.match(root, /^AGENTS: do not walk the commands with --help\. Find the one for a task with\n {2}cf-os api search "<describe the task>"\nwhich prints the five best matches as JSON, each a whole command line; then run `<command> --help`\.\n\nUsage: cf-os api <command>/);
  assert.match(root, new RegExp(`Commands on ${realTable.root}, after signing in:`));
  assert.match(root, /\n {2}open-gadget <id> → Overseer /);
  assert.match(root, /A command marked `→ X` returns capability X: follow it on the same line/);
  assert.doesNotMatch(nodeHelp(table, "FixtureAdmin", ["get-admin"]), /marked `→ X`/);
  assert.match(root, /`cf-os api public <command>` calls PublicApi without signing in/);
  assert.match(root, /\n`cf-os api create-account <username>` creates a user to act as with --username, on a local or test instance\.\n/);
  assert.match(root, /--username <name> +sign in as <name>, with a password[^]*`cf-os api create-account <name>` makes one/);
  assert.match(root, /--auth <mode> {8}access \(default for https:\/\/\)/);
  assert.doesNotMatch(root, /API options: `cf-os api --help`/);
  // `→ call` is explained only where a listed command carries it.
  assert.match(nodeHelp(realTable, "GadgetClient", ["x"]), /One marked `→ call` returns an untyped capability, finished with `call <method>/);
  assert.doesNotMatch(root, /`→ call`/);

  // Everywhere but the root, the API options are one line pointing at the root's help, and no banner.
  const publicHelp = nodeHelp(table, "FixturePublicApi", ["public"]);
  assert.match(publicHelp, /\n\nAPI options: `cf-os api --help`$/);
  assert.doesNotMatch(publicHelp, /AGENTS:|--auth <mode>/);
  assert.match(untypedHelp(["x"]), /\n\nAPI options: `cf-os api --help`$/);

  const file = commandHelp(table, "Notebook", "file", ["open-notebook", "n", "file"]);
  assert.match(file, /^Usage: cf-os api open-notebook n file <note> <destination>\n/);
  assert.match(file, /<note> +<json\|@file\|->: Note = \{ body: Uint8Array; /);
  assert.match(commandHelp(realTable, "AuthenticatedApi", "subscribe-connected-accounts", ["subscribe-connected-accounts"]),
    /--filter <json\|@file\|-> +ConnectedAccountsFilter = \{ [^}]*resourceUrl\?: string/);
  assert.match(file, /Returns nothing \(prints null\)\./);
  const findNotes = commandHelp(table, "FixtureAuthedApi", "find-notes", ["find-notes"]);
  assert.match(findNotes, /\[--limit <number>\] \[--arg-url <string>\]/);
  const subscribe = commandHelp(table, "Notebook", "subscribe", ["open-notebook", "n", "subscribe"]);
  assert.match(subscribe, /Events \(one JSON line each/);
  assert.match(subscribe, /removed\(id\)/);
  assert.match(subscribe, /Returns events, one JSON line each on stdout, until --timeout or Ctrl-C\./);
  const upload = commandHelp(table, "Notebook", "upload", ["upload"]);
  assert.match(upload, /--pinned, --no-pinned/);
  assert.match(upload, /\n\nAPI options: `cf-os api --help`$/);
  assert.doesNotMatch(upload, /--auth <mode>/);
});

test("help for a command that returns a capability lists that capability's commands", () => {
  const open = commandHelp(table, "FixtureAuthedApi", "open-notebook", ["open-notebook"]);
  assert.match(open, /Returns a capability on Notebook: follow with one of its commands\.\n\nThen, on Notebook:\n/);
  assert.match(open, /\n {2}file <note> <destination> +An object and an object union\./);
  assert.match(open, /\n {2}connect → call /);
  assert.match(open, /One marked `→ call` returns an untyped capability/);
  assert.doesNotMatch(commandHelp(table, "Notebook", "lock", ["lock"]), /Then, on/);
  // It says how to reach one of those commands' help, with what was typed so far.
  assert.match(open, /\n\nRun `cf-os api open-notebook <id> <command> --help` for one's arguments\.\n/);
  assert.match(commandHelp(table, "FixtureAuthedApi", "open-notebook", ["open-notebook", "my notes"]),
    /Run `cf-os api open-notebook 'my notes' <command> --help` for one's arguments\./);
  // A next command typed where the positional goes was taken for it: the help says so, and which help was meant.
  const misread = commandHelp(table, "FixtureAuthedApi", "open-notebook", ["open-notebook", "file"], 1);
  assert.match(misread, /^"file" was taken for open-notebook's <id>, not as a command\. For its help, run:\n {2}cf-os api open-notebook <id> file --help\n\nUsage: /);
  assert.doesNotMatch(open, /was taken for/);
  // The positional is the command's own name: `at` says which token is the command.
  assert.match(commandHelp(table, "FixtureAuthedApi", "open-notebook", ["open-notebook", "open-notebook"], 1),
    /Run `cf-os api open-notebook open-notebook <command> --help`/);
  // The real one: open-gadget's help lists Overseer's commands.
  assert.match(commandHelp(realTable, realTable.root, "open-gadget", ["open-gadget"]), /Then, on Overseer:[^]*\n {2}new-chat <initialMessage> <modelId> /);
});

test("search ranks commands by the task's words, as whole command lines, best first", () => {
  const matches = searchCommands(realTable, "start a chat in a workspace");
  assert.equal(matches.length, 5);
  assert.deepEqual(matches[0], {
    command: "cf-os api open-gadget <id> new-chat <initialMessage> <modelId>",
    summary: matches[0].summary,
  });
  assert.match(matches[0].summary, /^Starts a new chat/);
  assert.equal(searchCommands(realTable, "list chats")[0].command, "cf-os api open-gadget <id> list-chats");
  // A path through a capability-returning hop carries that hop's arguments; `public` its segment.
  assert.equal(searchCommands(table, "set banner")[0].command, "cf-os api get-admin set-banner <text>");
  assert.equal(searchCommands(table, "download")[0].command, "cf-os api public download <id>");
  assert.equal(searchCommands(table, "file into a notebook")[0].command, "cf-os api open-notebook <id> file <note> <destination>");
  // Creation verbs are one word, "add" finding new-gatekeeper, but the verb a task names comes first.
  assert.equal(searchCommands(realTable, "create a blueprint")[0].command, "cf-os api open-gadget <id> get-gadget <id> create-blueprint");
  assert.ok(searchCommands(realTable, "add a gatekeeper connection to a workspace")
    .some((match) => match.command === "cf-os api open-gadget <id> new-gatekeeper <accountId> <resourceUrl>"));
  // A capability's CamelCase name is words: "client" meets GadgetClient's commands.
  assert.ok(searchCommands(realTable, "gadget client title").some((match) => match.command.endsWith(" get-gadget <id> get-title")));
  // Summaries are whole first sentences, not cut for a listing or at "e.g.".
  const login = searchCommands(realTable, "begin a sign-in via an authentication gatekeeper")[0];
  assert.equal(login.command, "cf-os api public start-gatekeeper-login <vendorId>");
  assert.match(login.summary, /^Begin a sign-in via an authentication gatekeeper \(e\.g\. .*\)\.$/);
  assert.ok(searchCommands(realTable, "add-gateway-model").every((match) => !match.summary.endsWith("...")));
  // Words that pick out nothing match nothing; the output is plain JSON.
  assert.deepEqual(searchCommands(table, "the of a"), []);
  assert.deepEqual(JSON.parse(JSON.stringify(matches)), matches);
});

test("search finds create-account for making a user, and signing in as one, which are no generated command", () => {
  for (const task of ["create a test user", "make an account for bob", "sign up a new user", "create a user account", "register a user",
    "create a user", "create user bob", "add a user", "new user", "make a user"]) {
    assert.equal(searchCommands(realTable, task)[0].command, "cf-os api create-account <username>", task);
  }
  for (const task of ["sign in to a local dev server", "act as another user", "log in as a user", "log in as bob", "sign in as alice"]) {
    assert.equal(searchCommands(realTable, task)[0].command, "cf-os api --url http://localhost:8787 --username <username> <command>", task);
  }
  assert.match(searchCommands(realTable, "create a test user")[0].summary, /on a local or test instance; the password comes from CFOS_API_PASSWORD\.$/);
  // A task about a workspace's members still finds the workspace's command first.
  assert.ok(!searchCommands(realTable, "add bob to the workspace")[0].command.includes("create-account"));
  // Nor do broad words alone find it ahead of the commands they name; the dev server's host finds signing in.
  for (const task of ["create workspace for user", "test", "test a new model", "user", "make user admin"]) {
    assert.ok(!searchCommands(realTable, task)[0].command.includes("create-account"), task);
  }
  for (const task of ["localhost", "connect to localhost"]) {
    assert.equal(searchCommands(realTable, task)[0].command, "cf-os api --url http://localhost:8787 --username <username> <command>", task);
  }
});

test("`search` is a search only as the first word that is not an option", () => {
  assert.deepEqual(parseSearch(["search", "list", "chats"]), { query: "list chats", help: false });
  assert.deepEqual(parseSearch(["--url", "https://x", "search", "list chats", "--dry-run"]), { query: "list chats", help: false });
  assert.deepEqual(parseSearch(["search", "-h"]), { query: "", help: true });
  assert.equal(parseSearch(["open-notebook", "search"]), undefined);
  assert.equal(parseSearch([]), undefined);
  assert.throws(() => parseSearch(["search", "x", "--timeout"]), (error: Error) => error instanceof UsageError &&
    /^Option '--timeout <value>' argument missing\. Run `cf-os api --help` for the API options\.$/.test(error.message));
});

test("the root help's --url line says what the default instance is where the CLI runs, and names no --config", () => {
  const root = nodeHelp(realTable, realTable.root, []);
  assert.match(root, /\n {2}--answer <Callback\.method>=<json\|@file\|->\n/);
  assert.doesNotMatch(root, /--config/);
  assert.ok(flat(root).includes("--url <origin> the instance (default: http://localhost:8787, where `pnpm dev-server` listens; " +
    "CFOS_API_URL names another); http:// only for a local dev server"));
  const named = nodeHelp(realTable, realTable.root, [], { kind: "url", url: "https://os.example.com", from: "CFOS_API_URL" });
  assert.ok(flat(named).includes("--url <origin> the instance (default: https://os.example.com, from CFOS_API_URL); " +
    "http:// only for a local dev server"));
  // In a starter with no deployment origin, the reason stands in for a default: no fallback is advertised.
  const none = nodeHelp(realTable, realTable.root, [], { kind: "unavailable", reason: REASON });
  assert.ok(flat(none).includes(`--url <origin> the instance; http:// only for a local dev server. No default here: ${REASON}`));
  assert.doesNotMatch(none, /localhost:8787/);
});

test("urlHelp's lines fit 100 columns, at the root's column and create-account's", () => {
  const instances: DefaultInstance[] = [
    { kind: "url", url: "http://localhost:8787", from: "dev-server" },
    { kind: "url", url: "https://os.example.com", from: "CFOS_API_URL" },
    { kind: "unavailable", reason: REASON },
  ];
  for (const instance of instances) {
    for (const column of [23, 25]) {
      const lines = urlHelp(instance, column);
      assert.match(lines[0], new RegExp(`^ {2}--url <origin> {${column - 16}}the instance`));
      for (const line of lines) assert.ok(line.length <= 100, `${line.length}: ${line}`);
      for (const line of lines.slice(1)) assert.match(line, new RegExp(`^ {${column}}\\S`));
    }
  }
});

test("--answer may be given in any segment, its values kept in order; search accepts and ignores it", () => {
  const invocation = parseInvocation(table, ["--answer", "A.b=1", "open-notebook", "n", "--answer=C.d=2", "outline"]);
  assert.deepEqual(invocation.flags.answers, ["A.b=1", "C.d=2"]);
  assert.deepEqual(parseSearch(["search", "x", "--answer", "A.b=1"]), { query: "x", help: false });
});

test("a command's help lists answer methods under Answers, and only methods that return nothing under Events", () => {
  const open = commandHelp(realTable, realTable.root, "open-gadget", ["open-gadget"]);
  assert.match(open, /\nAnswers \(/);
  assert.ok(flat(open).includes("Answers (the server may ask; give each with --answer '<name>=<json|@file|->', which answers its " +
    "first call; otherwise the call fails, exit 2, saying what it asked):"));
  assert.match(open, /ObserverConfigCallback\.configure\(needs\)\s+returns ObserverAccountChoice\[\], where ObserverAccountChoice = \{ accountId: number; gatekeeperId: number \}/);
  assert.doesNotMatch(open, /Events \(/);
  const subscribe = commandHelp(realTable, "Overseer", "subscribe-to-chat", ["open-gadget", "g", "subscribe-to-chat"]);
  assert.match(subscribe, /Events \(/);
  assert.doesNotMatch(subscribe, /Answers \(/);
});

/** Asserts that `promise` rejects with the usage error `message`, exactly. */
async function fails(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: Error) => error instanceof UsageError && error.message === message);
}

test("--answer is decoded before connecting, against its method's result shape", async () => {
  const key = "ObserverConfigCallback.configure";
  const decode = (answers: string[], extra: string[] = [], source = noFiles, on = realTable) => decodeCalls(on,
    parseInvocation(on, [...on === realTable ? ["open-gadget", "g", "get-metadata"] : ["set-mood", "calm"], ...extra,
      ...answers.flatMap((answer) => ["--answer", answer])]), source);
  const { answers } = await decode([`${key}=[{"gatekeeperId": 3, "accountId": 7}]`]);
  assert.deepEqual(answers.get(key), [{ gatekeeperId: 3, accountId: 7 }]);

  await fails(decode(["nope"]), '--answer needs <Callback>.<method>=<json|@file|->; got "nope".');
  await fails(decode(["Nope.nothing=1"]),
    `--answer Nope.nothing: no callback method of the API by that name returns a value. Those that do: ${key}.`);
  await fails(decode([`${key}=[]`, `${key}=[]`]), `--answer ${key} is given twice.`);
  await fails(decode([`${key}=[{"gatekeeperId": "x", "accountId": 1}]`]),
    `--answer ${key}[0].gatekeeperId must be number; got "x".`);
  await fails(decode([`${key}=1`], [], noFiles, table),
    `--answer ${key}: no callback method of the API by that name returns a value, and none does.`);
});

test("an --answer read from stdin shares the one stdin with the arguments", async () => {
  const stdin = { readFile: noFiles.readFile, readStdin: async () => new TextEncoder().encode("[]") };
  const invocation = parseInvocation(realTable, ["open-gadget", "g", "get-metadata", "--answer", "ObserverConfigCallback.configure=-"]);
  assert.deepEqual((await decodeCalls(realTable, invocation, stdin)).answers.get("ObserverConfigCallback.configure"), []);
  const both = parseInvocation(realTable, ["connect-account", "google", "--resource-url-patterns", "-", "--answer", "ObserverConfigCallback.configure=-"]);
  await assert.rejects(decodeCalls(realTable, both, stdin), (error: Error) =>
    error instanceof UsageError && error.message === "Only one argument can read stdin (-).");
});
