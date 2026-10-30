import assert from "node:assert/strict";
import test from "node:test";
import { table as realTable } from "../generated/commands.ts";
import { table } from "../generator/__fixtures__/generated/commands.ts";
import { UsageError } from "./output.ts";
import { nodePrefixes } from "./paths.ts";
import {
  commandHelp, decodeCalls, dryRunAnswers, dryRunChain, incompleteChain, nodeHelp, parseInvocation, parseSearch, parseTypes, searchCommands, untypedHelp, urlHelp,
  type HelpTarget, type Hop,
} from "./run.ts";
import type { DefaultInstance } from "./session.ts";

/** What CFOS_API_URL_UNAVAILABLE says in a starter whose deployment file is not configured. */
const REASON = "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.";

/** `text` with every run of whitespace one space, so wrapped help reads as one line. */
const flat = (text: string) => text.replace(/\s+/g, " ");

const noFiles = {
  readFile: async () => assert.fail("read a file"),
  readStdin: async () => assert.fail("read stdin"),
  // Checking a stream's file reads nothing.
  checkFile: async () => {},
};

function names(hops: Hop[]): string[] {
  return hops.map((hop) => hop.kind === "call" ? `call ${hop.method}` : hop.name);
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

test("a capability in a property of a value result continues the chain, named as a segment of runtime flags only", () => {
  const untyped = parseInvocation(table, ["get-frame", "ui", "--dry-run", "call", "echo", "1"]);
  assert.deepEqual(names(untyped.hops), ["get-frame", "ui", "call echo"]);
  assert.deepEqual(untyped.hops[1], { kind: "property", name: "ui", property: "ui", returns: { kind: "untyped" } });
  assert.deepEqual(untyped.end, { kind: "result", returns: { kind: "call" } });
  assert.equal(untyped.flags.dryRun, true);
  const typed = parseInvocation(table, ["get-notebook-ref", "notebook", "outline"]);
  assert.deepEqual(names(typed.hops), ["get-notebook-ref", "notebook", "outline"]);
  assert.deepEqual(typed.end, { kind: "result", returns: table.nodes.Notebook!.commands.outline!.returns });
  // Left there, the chain is open, as after a command returning a capability.
  assert.deepEqual(parseInvocation(table, ["get-notebook-ref", "notebook"]).end, { kind: "node", node: "Notebook" });
  assert.deepEqual(parseInvocation(table, ["get-frame", "ui"]).end, { kind: "untyped" });
  // --help there is the help of what the property holds.
  assert.deepEqual(parseInvocation(table, ["get-notebook-ref", "notebook", "-h"]).help, { kind: "node", node: "Notebook" });
  assert.deepEqual(parseInvocation(table, ["get-frame", "ui", "--help"]).help, { kind: "untyped", at: 2 });

  // Only after a value that holds it; any other word there still ends the chain, naming the properties.
  usage(["find-notes", "q", "ui"], /^find-notes returns a value, which ends the chain: nothing can follow it, but "ui" does\.$/);
  usage(["open-notebook", "n", "notebook"], /^Notebook has no command "notebook"\./);
  usage(["get-frame", "nope"], /^get-frame returns a value, which ends the chain, but its `ui` is a capability: continue with `ui`, not "nope"\.$/);
  usage(["get-frame", "ui", "echo"], /^Its `ui` is an untyped capability: continue with `call <method> \[json-args\.\.\.\]`, not "echo"\.$/);
  usage(["get-notebook-ref", "notebook", "nope"], /^Notebook has no command "nope"\. .* run `cf-os api get-notebook-ref notebook --help` for Notebook's\.$/);
  usage(["get-frame", "ui", "--limit", "1"], /^Unknown option --limit\. Run `cf-os api get-frame ui --help` for its options\.$/);
});

test("`--` makes the rest positionals, so values that look like flags pass through", () => {
  const invocation = parseInvocation(table, ["find-notes", "--", "--limit"]);
  assert.deepEqual((invocation.hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["--limit"]);
});

test("a value option never takes the next flag for its value, so --dry-run and --help are never swallowed", () => {
  const needs = (tokens: string[], message: string) => assert.throws(() => parseInvocation(realTable, tokens),
    (error: Error) => error instanceof UsageError && error.message === message);
  needs(["open-workspace", "g", "create-share-link", "use", "--note", "--dry-run"],
    "--note needs a value, and --dry-run reads as an option: write --note=--dry-run if that is the value. " +
    "Run `cf-os api open-workspace g create-share-link --help` for its options.");
  needs(["open-workspace", "g", "create-share-link", "use", "--note", "--help"],
    "--note needs a value, and --help reads as an option: write --note=--help if that is the value. " +
    "Run `cf-os api open-workspace g create-share-link --help` for its options.");
  needs(["list-models", "--kind", "--username", "x"],
    "--kind needs a value, and --username reads as an option: write --kind=--username if that is the value. " +
    "Run `cf-os api list-models --help` for its options.");
  usage(["find-notes", "q", "--arg-url", "-h"], /^--arg-url needs a value, and -h reads as an option: write --arg-url=-h /);
  usage(["--url", "--dry-run", "find-notes", "q"], /^--url needs a value, .* Run `cf-os api --help` for the API options\.$/);
  // Written with `=`, it is the value; a single dash is no flag (`--limit -1`); after `--`, nothing is.
  const share = parseInvocation(realTable, ["open-workspace", "g", "create-share-link", "use", "--note=--dry-run"]);
  assert.deepEqual((share.hops[1] as Extract<Hop, { kind: "command" }>).flags, { note: "--dry-run" });
  assert.equal(share.flags.dryRun, false);
  assert.deepEqual((parseInvocation(table, ["find-notes", "q", "--limit", "-1"]).hops[0] as Extract<Hop, { kind: "command" }>).flags,
    { limit: "-1" });
});

test("`call` refuses a name the local stub answers itself, before anything is sent, a dry run too", () => {
  for (const name of ["then", "toString", "constructor", "__proto__", "dup", "hasOwnProperty"]) {
    const refused = new RegExp(`^call ${name}: "${name}" is a built-in of the local stub, not a server method, ` +
      "so `call` cannot send it\\. Nothing was sent\\.$");
    usage(["open-notebook", "n", "connect", "call", name], refused);
    usage(["--dry-run", "get-frame", "ui", "call", "echo", "call", name, "1"], refused);
  }
  // Any other name is the server's to judge.
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect", "call", "getDocument"]).hops.at(-1),
    { kind: "call", method: "getDocument", args: [] });
});

test("--out is refused before connecting unless the chain ends on bytes: a stream, or a byte value", () => {
  assert.equal(parseInvocation(realTable, ["get-avatar", "alice", "--out", "avatar.png"]).flags.out, "avatar.png");
  assert.equal(parseInvocation(table, ["get-photo", "p", "--out", "-"]).flags.out, "-");
  assert.equal(parseInvocation(table, ["public", "download", "3", "--out", "x"]).flags.out, "x");
  const refused = (returns: string) => new RegExp(`^${returns}, not bytes: --out applies only to a command that returns bytes\\.$`);
  usage(["find-notes", "q", "--out", "x"], refused("find-notes returns a value"));
  usage(["set-mood", "calm", "--out", "x"], refused("set-mood returns nothing"));
  usage(["open-notebook", "n", "subscribe", "--out", "x"], refused("subscribe returns events"));
  usage(["open-notebook", "n", "connect", "call", "echo", "--out", "x"], refused("call echo returns an untyped value"));
  assert.throws(() => parseInvocation(realTable, ["list-workspaces", "--out", "x.bin"]),
    (error: Error) => error instanceof UsageError && refused("list-workspaces returns a value").test(error.message));
  // A chain left open is not judged here: it fails saying how to finish it.
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "--out", "x"]).end, { kind: "node", node: "Notebook" });
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
  // A misused option is refused in the CLI's own words, never node:util's, with where to read about
  // it after: the root's help for a runtime option, the segment's own for a command's, typed as a
  // shell needs it; `--help` takes no value either, as no boolean does.
  usage(["find-notes", "q", "--dry-run=yes"], /^--dry-run takes no value: write --dry-run or --no-dry-run\. Run `cf-os api --help` for the API options\.$/);
  usage(["--no-dry-run=yes", "find-notes", "q"], /^--no-dry-run takes no value: write --dry-run or --no-dry-run\./);
  usage(["open-notebook", "my notes", "outline", "--help=foo"], /^--help takes no value: run `cf-os api open-notebook 'my notes' outline --help`\.$/);
  usage(["find-notes", "q", "--limit"], /^--limit needs a value\. Run `cf-os api find-notes --help` for its options\.$/);
  usage(["open-notebook", "my notes", "outline", "--bogus"], /^Unknown option --bogus for outline\. Run `cf-os api open-notebook 'my notes' outline --help` for its options\.$/);
  usage(["open-notebook", "my notes", "nope"], /run `cf-os api open-notebook 'my notes' --help` for Notebook's\.$/);
  // A positional only `--` let through gets its `--` back in the pointer, which `--help` can follow.
  usage(["open-notebook", "--", "--weird", "nope"], /run `cf-os api open-notebook -- --weird --help` for Notebook's\.$/);
  usage(["open-notebook", "--", "--", "nope"], /run `cf-os api open-notebook -- -- --help` for Notebook's\.$/);
});

test("a chain left open says how to finish it, in commands that run as typed", () => {
  // A token only `--` let through gets its `--` back in the example, which then walks as suggested,
  // and in the help pointer.
  for (const token of ["--weird", "--", "-h"]) {
    const message = incompleteChain(realTable, parseInvocation(realTable, ["open-workspace", "--", token]));
    const example = /as in `cf-os api ([^`]*)`/.exec(message)![1].split(" ").map((word) => word.replace(/^'(.*)'$/, "$1"));
    assert.deepEqual(example, ["open-workspace", "--", token, "get-metadata"]);
    const walked = parseInvocation(realTable, example);
    assert.deepEqual(names(walked.hops), ["open-workspace", "get-metadata"]);
    assert.deepEqual((walked.hops[0] as Extract<Hop, { kind: "command" }>).positionals, [token]);
    assert.ok(message.endsWith(`; \`cf-os api open-workspace -- ${token} --help\` lists them.`), message);
  }
  assert.match(incompleteChain(realTable, parseInvocation(realTable, ["open-workspace", "my id"])), /as in `cf-os api open-workspace 'my id' get-metadata`; `cf-os api open-workspace 'my id' --help` lists them\.$/);
  // One left open on a property names the command it is read on: on the node an argument types it
  // as, or untyped.
  assert.equal(incompleteChain(realTable, parseInvocation(realTable, ["get-gatekeeper-app", "context", "ui"])),
    "get-gatekeeper-app's `ui` is a capability (context:ContextApi), so the chain goes on: nothing was sent. Finish it with " +
    "one of context:ContextApi's commands, as in `cf-os api get-gatekeeper-app context ui get-viewer-info`; " +
    "`cf-os api get-gatekeeper-app context ui --help` lists them.");
  assert.equal(incompleteChain(realTable, parseInvocation(realTable, ["get-gatekeeper-app", "websearch", "ui"])),
    "get-gatekeeper-app's `ui` is an untyped capability, so the chain goes on: nothing was sent. Finish it with " +
    "`call <method> [json-args...]`, as in `cf-os api get-gatekeeper-app websearch ui call <method>`; " +
    "`cf-os api get-gatekeeper-app websearch ui --help` says more.");
  assert.equal(incompleteChain(table, parseInvocation(table, ["get-notebook-ref", "notebook"])),
    "get-notebook-ref's `notebook` is a capability (Notebook), so the chain goes on: nothing was sent. Finish it with " +
    "one of Notebook's commands; `cf-os api get-notebook-ref notebook --help` lists them.");
});

test("--help stops the walk at the segment it is in", () => {
  assert.deepEqual(parseInvocation(table, ["--help", "nope"]).help, { kind: "node", node: "FixtureAuthedApi" });
  assert.deepEqual(parseInvocation(table, ["public", "-h"]).help, { kind: "node", node: "FixturePublicApi" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "--help"]).help, { kind: "command", node: "FixtureAuthedApi", name: "open-notebook", at: 1 });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "file", "-h"]).help, { kind: "command", node: "Notebook", name: "file", at: 3 });
  // The help's usage line is the path to the capability, so `call` is not repeated in it.
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect", "call", "x", "--help"]).help, { kind: "untyped", at: 3 });
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
  // A property read is no call: it has no arguments, and the dry run says which property it reads.
  const frame = await decode(["get-frame", "ui", "call", "echo", "1"]);
  assert.deepEqual(frame[1], { method: "ui", args: [], returns: { kind: "untyped" }, property: true });
  assert.deepEqual(dryRunChain(frame), [{ method: "getFrame", args: [] }, { property: "ui" }, { method: "echo", args: [1] }]);
  await assert.rejects(decodeCalls(table, parseInvocation(table, ["open-notebook", "n", "file", "-", "-"]), {
    ...noFiles,
    readStdin: async () => new TextEncoder().encode("{}"),
  }), /Only one argument can read stdin/);
});

test("--dry-run prints what the table marks secret as {\"$secret\": true}, in arguments and answers; help names it", async () => {
  const remote = JSON.stringify({
    url: "https://r.example", token: "sk-1", headers: { "X-Key": "h-1", "X-Kept": null },
    mirrors: [{ url: "https://m.example", token: "sk-2" }],
  });
  const decoded = await decodeCalls(table, parseInvocation(table, ["add-remote", remote]), noFiles);
  // The call itself carries the values; only what is printed is redacted.
  assert.equal((decoded.calls[0]!.args[0] as { token: string }).token, "sk-1");
  assert.deepEqual(dryRunChain(decoded.calls), [{
    method: "addRemote",
    args: [{
      url: "https://r.example", token: { $secret: true }, headers: { "X-Key": { $secret: true }, "X-Kept": null },
      mirrors: [{ url: { $secret: true }, token: { $secret: true } }],
    }],
  }]);

  const key = "ObserverConfigCallback.configure";
  const marked = structuredClone(realTable);
  marked.callbacks.ObserverConfigCallback!.methods.find((method) => method.answer)!.answer!.secrets = [["*", "accountId"]];
  const answered = await decodeCalls(marked, parseInvocation(marked, ["open-workspace", "g", "get-metadata", "--answer",
    `${key}=[{"gatekeeperId": 3, "accountId": 7}]`]), noFiles);
  assert.deepEqual(answered.answers.get(key), [{ gatekeeperId: 3, accountId: 7 }]);
  assert.deepEqual(dryRunAnswers(answered), { [key]: [{ gatekeeperId: 3, accountId: { $secret: true } }] });

  assert.match(flat(commandHelp(table, "FixtureAuthedApi", "add-remote", ["add-remote"])),
    /<remote> <json\|@file\|->: Remote = [^\n]* Remote: A server notes are mirrored to\. Secrets in it: headers, mirrors\.\*, token\. --dry-run prints \{"\$secret": true\} in their place; @file or - keeps them off the command line\./);
  assert.doesNotMatch(commandHelp(table, "Notebook", "file", ["file"]), /Secret/);
});

test("help lists a capability's commands and a command's arguments, events and result", () => {
  const root = nodeHelp(realTable, realTable.root, []);
  // The root opens with how an agent finds a command, in three lines.
  assert.match(root, /^AGENTS: do not walk the commands with --help\. Find the one for a task with\n {2}cf-os api search "<describe the task>"\nwhich prints the five best matches as JSON, each a whole command line; then run `<command> --help`\.\n\nUsage: cf-os api <command>/);
  assert.match(root, new RegExp(`Commands on ${realTable.root}, after signing in:`));
  assert.match(root, /\n {2}open-workspace <id> → Overseer /);
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
  assert.match(flat(untypedHelp(["x"])), /each argument JSON, inline, from @file or from - \(stdin\)/);

  const file = commandHelp(table, "Notebook", "file", ["open-notebook", "n", "file"]);
  assert.match(file, /^Usage: cf-os api open-notebook n file <note> <destination>\n/);
  assert.match(file, /<note> +<json\|@file\|->: Note = \{ body: Uint8Array; /);
  assert.match(commandHelp(realTable, "AuthenticatedApi", "subscribe-connected-accounts", ["subscribe-connected-accounts"]),
    /--filter <json\|@file\|-> +ConnectedAccountsFilter = \{ [^}]*resourceUrl\?: string/);
  assert.match(file, /Returns nothing \(prints null\)\./);
  // A documented named type's first sentence sits under the argument declared as it, in its column;
  // an undocumented one (Note) has no such row.
  assert.match(file, /\n {2}<destination> +<json\|@file\|->: Destination = [^\n]*\n {17}Destination: Where a note is filed\.\n/);
  assert.doesNotMatch(file, /\n +Note: /);
  assert.match(commandHelp(table, "FixtureAuthedApi", "set-mood", ["set-mood"]),
    /\n {2}<mood> +busy\|calm: Mood\n {10}Mood: How the notebook's owner feels\.\n/);
  assert.match(commandHelp(table, "Notebook", "move", ["move"]), /\n {2}--destination <json\|@file\|->  [^\n]*\n {32}Destination: Where a note is filed\.\n/);
  assert.match(flat(commandHelp(realTable, realTable.root, "get-avatar", ["get-avatar"])),
    /Returns Uint8Array \| null: bytes, printed as \{"base64": "\.\.\."\} JSON, or written decoded to --out <file\|->\./);
  const findNotes = commandHelp(table, "FixtureAuthedApi", "find-notes", ["find-notes"]);
  assert.match(findNotes, /\[--limit <number>\] \[--arg-url <string>\]/);
  // A plain string argument is taken as typed, which its command's help says, and how to read a file instead.
  const setTitle = flat(commandHelp(realTable, "Overseer", "set-title", ["open-workspace", "w", "set-title"]));
  assert.match(setTitle, /<title> string /);
  assert.ok(setTitle.includes("A string is taken as typed: @, - and quotes are part of it ('\"@x\"' sends the quotes too), " +
    "so a model id goes as list-models prints it (@cf/...). For a file's text, let the shell read it: \"$(cat file)\"."));
  assert.doesNotMatch(setTitle, /@file|<text\|json/);
  // A literal's choices are words, typed as they are: no rule for them.
  const setMood = commandHelp(table, "FixtureAuthedApi", "set-mood", ["set-mood"]);
  assert.doesNotMatch(setMood, /@file|taken as typed/);
  // A command whose null stops a chain says, in words, when it is null.
  assert.match(flat(commandHelp(realTable, realTable.root, "get-admin-api", ["get-admin-api"])),
    /Returns a capability on AdminApi, or null: follow with one of its commands\. It is null when the caller is not a deployment admin; `am-i-admin` says whether it is\./);
  assert.match(flat(commandHelp(table, "FixtureAuthedApi", "get-admin", ["get-admin"])), /It is null when the caller is not an admin; `find-notes` needs none\./);
  assert.doesNotMatch(commandHelp(table, "FixtureAuthedApi", "get-frame", ["get-frame"]), /It is null when/);
  const subscribe = commandHelp(table, "Notebook", "subscribe", ["open-notebook", "n", "subscribe"]);
  assert.match(subscribe, /Events \(one JSON line each/);
  assert.match(subscribe, /removed\(id\)/);
  assert.match(flat(subscribe), /Returns events, one JSON line each on stdout, until --timeout or Ctrl-C \(a reader that has gone, as `\| head` does, is noticed only at the next event, so pair one with --timeout\)\./);
  // A JSON argument that takes text says how its text is read; one that does not, nothing of it.
  const newChat = flat(commandHelp(realTable, "Overseer", "new-chat", ["open-workspace", "w", "new-chat"]));
  assert.match(newChat, /<initialMessage> <text\|json\|@file\|->: /);
  assert.match(newChat, /<text\|json\|@file\|->: JSON, inline, from @file or from - \(stdin\)\. Text that is not JSON is that string, less a file's or stdin's final line ending, even text that starts with \{, \[ or " \('\[draft\] hello'\)\./);
  assert.doesNotMatch(file, /Text that is not JSON/);
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
  // One that creates what it returns says it prints the id, read with the command the table names.
  assert.match(flat(commandHelp(table, "FixtureAuthedApi", "new-notebook", ["new-notebook"])),
    /follow with one of its commands\. It also prints `Created notebook <title>\.` on stderr, read with `outline` on the result beside the chain, even when a later command of the chain fails/);
  assert.doesNotMatch(open, /Created/);
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
  // The real one: open-workspace's help lists Overseer's commands.
  assert.match(commandHelp(realTable, realTable.root, "open-workspace", ["open-workspace"]), /Then, on Overseer:[^]*\n {2}new-chat <initialMessage> <modelId> /);
});

test("help and listings show where a value's capabilities lead, and how to go on to each", () => {
  const root = nodeHelp(table, table.root, []);
  assert.match(root, /\n {2}get-frame → ui: call +A value holding/);
  assert.match(root, /\n {2}get-notebook-ref → notebook: Notebook\s+A value holding/);
  assert.match(flat(root), /One marked `→ p: X` prints a value whose property p is capability X; to use that, follow it on the same line with `p`/);
  assert.doesNotMatch(nodeHelp(table, "Notebook", ["open-notebook", "n"]), /`→ p: X`/);

  const frame = commandHelp(table, "FixtureAuthedApi", "get-frame", ["get-frame"]);
  assert.match(frame, /Returns \{ html: string; ui: RpcStub<any> \} \| null, printed as JSON\.\n\nThen, on its `ui`, an untyped capability, /);
  assert.match(frame, /\n {2}cf-os api get-frame ui call <method> \[json-args\.\.\.\]\n/);
  const ref = commandHelp(table, "FixtureAuthedApi", "get-notebook-ref", ["get-notebook-ref"]);
  assert.match(ref, /\n\nThen, on its `notebook` \(Notebook\):\n[^]*\n {2}outline +/);
  assert.match(ref, /\n\nRun `cf-os api get-notebook-ref notebook <command> --help` for one's arguments\.\n/);
  // With a positional still to type, its placeholder stands in the line.
  assert.match(commandHelp(realTable, realTable.public, "start-gatekeeper-login", ["public", "start-gatekeeper-login"]),
    /Then, on its `attempt` \(LoginAttempt\):\n {2}receive [^]*Run `cf-os api public start-gatekeeper-login <vendorId> attempt <command> --help`/);
  assert.match(commandHelp(realTable, realTable.root, "get-gatekeeper-app", ["get-gatekeeper-app", "websearch"]),
    /\n {2}cf-os api get-gatekeeper-app websearch ui call <method> \[json-args\.\.\.\]\n/);
  // An argument typed as a value that types the property lists that node's commands.
  assert.match(commandHelp(realTable, realTable.root, "get-gatekeeper-app", ["get-gatekeeper-app", "context"]),
    /\n\nThen, on its `ui` \(context:ContextApi\):\n[^]*\n {2}create-context-skill <collectionId> <path> <doc>\n[^]*Run `cf-os api get-gatekeeper-app context ui <command> --help`/);
  // The property typed where the positional goes was taken for it, as a next command would be.
  const misread = commandHelp(realTable, realTable.root, "get-gatekeeper-app", ["get-gatekeeper-app", "ui"], 1);
  assert.match(misread, /^"ui" was taken for get-gatekeeper-app's <id>, not as a property of its result\. For its help, run:\n {2}cf-os api get-gatekeeper-app <id> ui --help\n/);
  assert.match(misread, /\n {2}cf-os api get-gatekeeper-app <id> ui call <method> \[json-args\.\.\.\]\n/);

  // Search prints whole lines through a property, preferring a command's own result where both reach a node.
  assert.deepEqual(nodePrefixes(realTable).get("LoginAttempt"), ["public", "start-gatekeeper-login", "<vendorId>", "attempt"]);
  assert.deepEqual(nodePrefixes(table).get("Notebook"), ["open-notebook", "<id>"]);
  assert.equal(searchCommands(realTable, "receive the sign-in token of a login attempt")[0].command,
    "cf-os api public start-gatekeeper-login <vendorId> attempt receive");
});

test("search ranks commands by the task's words, as whole command lines, best first", () => {
  const matches = searchCommands(realTable, "start a chat in a workspace");
  assert.equal(matches.length, 5);
  assert.deepEqual(matches[0], {
    command: "cf-os api open-workspace <id> new-chat <initialMessage> <modelId>",
    summary: matches[0].summary,
  });
  assert.match(matches[0].summary, /^Starts a new chat/);
  assert.equal(searchCommands(realTable, "list chats")[0].command, "cf-os api open-workspace <id> list-chats");
  // A path through a capability-returning hop carries that hop's arguments; `public` its segment.
  assert.equal(searchCommands(table, "set banner")[0].command, "cf-os api get-admin set-banner <text>");
  assert.equal(searchCommands(table, "download")[0].command, "cf-os api public download <id>");
  assert.equal(searchCommands(table, "file into a notebook")[0].command, "cf-os api open-notebook <id> file <note> <destination>");
  // Creation verbs are one word, "add" finding new-gatekeeper, but the verb a task names comes first.
  assert.equal(searchCommands(realTable, "create a blueprint")[0].command, "cf-os api open-workspace <id> get-gadget <id> create-blueprint");
  assert.ok(searchCommands(realTable, "add a gatekeeper connection to a workspace")
    .some((match) => match.command === "cf-os api open-workspace <id> new-gatekeeper <accountId> <resourceUrl>"));
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

/** Where the first command line `wanted` matches is in `searchTable`'s results for `task`, from 1; 0 when none is. */
function rankOf(searchTable: typeof table, task: string, wanted: RegExp): number {
  return searchCommands(searchTable, task, Infinity).findIndex((match) => wanted.test(match.command)) + 1;
}

test("search reads a command's option names and the callback methods it may be asked to answer as its doc's words", () => {
  // An option's name, not its flag (`--arg-url`'s "arg" is no word of find-notes); a positional's name is not read.
  assert.equal(searchCommands(table, "since")[0].command, "cf-os api open-notebook <id> subscribe");
  assert.equal(searchCommands(table, "limit")[0].command, "cf-os api find-notes <query>");
  assert.equal(rankOf(table, "url", /find-notes/), 1);
  assert.equal(rankOf(table, "arg", /find-notes/), 0);
  assert.equal(rankOf(table, "query", /find-notes/), 0);
  // An option's name counts only whole, and as one word of a doc: its words make no command about them.
  assert.equal(searchCommands(realTable, "gadget bindings")[0].command, "cf-os api open-workspace <id> get-gadget <id> list-bindings");
  assert.ok(rankOf(realTable, "gadget bindings", / create-gadget </) > 3);
  assert.ok(rankOf(realTable, "binding name", / create-gadget </) >= 1);
  // A stop word in an option's name is not needed to name it: "copy secrets" names `--copy-secrets-from`.
  for (const task of ["copy secrets", "copy secrets from"]) {
    assert.ok(searchCommands(realTable, task).some((match) => / add-model </.test(match.command)), task);
  }
  assert.equal(rankOf(realTable, "copy", / add-model </), 0);
  for (const task of ["list chats", "get chat history"]) {
    assert.ok(!searchCommands(realTable, task).some((match) => / get-gadget <id> /.test(match.command)), task);
  }
  for (const task of ["chat id", "list chats ids"]) {
    assert.equal(searchCommands(realTable, task)[0].command, "cf-os api open-workspace <id> list-chats", task);
    assert.ok(!searchCommands(realTable, task, 3).some((match) => / get-gadget <id> /.test(match.command)), task);
  }
  // A method the server may ask to answer is read as `<Callback>.<method>`; one whose calls are events is not.
  const asking = structuredClone(table);
  asking.callbacks.ConsentPrompt = { doc: "", methods: [
    { name: "approve", params: ["what"], doc: "", answer: { shape: { kind: "boolean" }, type: "boolean" } },
    { name: "notice", params: ["what"], doc: "" },
  ] };
  asking.nodes.Notebook.commands.lock.args = [
    { name: "prompt", index: 0, encoding: "callback", callback: "ConsentPrompt", type: "RpcStub<ConsentPrompt>", doc: "" },
  ];
  assert.equal(searchCommands(asking, "consent prompt")[0].command, "cf-os api open-notebook <id> lock");
  assert.equal(searchCommands(asking, "approve")[0].command, "cf-os api open-notebook <id> lock");
  assert.equal(rankOf(asking, "notice", / lock$/), 0);
  // As a doc's words: 2, under the 3 of a command named by the word.
  assert.equal(searchCommands(realTable, "configure observers")[0].command, "cf-os api open-workspace <id>");
  assert.equal(rankOf(realTable, "observer", /^cf-os api open-workspace <id>$/), 2);
});

test("search finds the commands for agents' everyday tasks in the API's own words", () => {
  const gatekeeperApp = /^cf-os api (get-gatekeeper-app|provision-ambient-account) /;
  const openWorkspace = /^cf-os api open-workspace <id>$/;
  // Each task, what it should find, and the rank that must reach: the first, or among the first `top`.
  const cases: [string, RegExp, number][] = [
    // Skills/Context collections, a gatekeeper app.
    ...["skill", "skills", "skills collection", "create skill", "collection", "SKILL.md", "context collections",
      "list my skills collections", "open the Skills app"].map((task): [string, RegExp, number] => [task, gatekeeperApp, 1]),
    // Scheduling: the scheduler's app, or the hooks a schedule is.
    ...["schedule", "scheduler", "scheduled tasks", "Scheduled Tasks", "schedule a task"].map((task): [string, RegExp, number] =>
      [task, /^cf-os api (get-gatekeeper-app|provision-ambient-account) | (list|enable|disable|delete)-hook/, 1]),
    ["schedule", / list-hooks$/, 3],
    ["list scheduled tasks", / list-hooks$/, 3],
    ["remove a schedule", / delete-hook <id>$/, 1],
    ["remove a schedule", / disable-hook <id>$/, 2],
    ["enable a scheduled task", / enable-hook <id>$/, 1],
    // MCP servers and other connectors.
    ["mcp", /^cf-os api list-gatekeeper-vendors$/, 1],
    ["connector", /^cf-os api list-gatekeeper-vendors$/, 1],
    ["Model Context Protocol", /^cf-os api list-gatekeeper-vendors$/, 1],
    ["add an MCP server and list its tools", /^cf-os api list-gatekeeper-vendors$/, 1],
    ["add an MCP server and list its tools", / new-gatekeeper </, 3],
    ["connect an mcp server", /^cf-os api connect-account /, 1],
    // Workspaces.
    ["list my workspaces", /^cf-os api list-workspaces$/, 1],
    ["list workspaces", /^cf-os api list-workspaces$/, 1],
    ["show my workspaces", /^cf-os api list-workspaces$/, 3],
    ["rename a workspace", /^cf-os api open-workspace <id> set-title </, 1],
    ["rename workspace", /^cf-os api open-workspace <id> set-title </, 1],
    // Sharing, and redeeming a share link's key.
    ["share workspace with another user", / add-collaborator </, 3],
    ["share a workspace", / create-share-link </, 3],
    ["share a workspace", / add-collaborator </, 5],
    ["invite user to workspace", / add-collaborator </, 1],
    ["give another user access to my workspace", / add-collaborator </, 1],
    ["share with bob by username", / add-collaborator </, 1],
    ["unshare remove user from workspace", / remove-collaborator </, 1],
    ["stop sharing workspace with user", / remove-collaborator </, 3],
    ["list who has access to workspace", / list-collaborators$/, 1],
    ...["redeem share link", "redeem a share link", "open workspace with share key", "join workspace from link",
      "join a shared workspace", "open a workspace shared with me", "configure observers"]
      .map((task): [string, RegExp, number] => [task, openWorkspace, 1]),
    ["observer verification", openWorkspace, 3],
    ["choose accounts to observe a shared workspace", openWorkspace, 3],
    ["share key", openWorkspace, 3],
  ];
  for (const [task, wanted, top] of cases) {
    const rank = rankOf(realTable, task, wanted);
    assert.ok(rank >= 1 && rank <= top, `"${task}" ranks ${wanted} ${rank || "nowhere"}, wanted ${top === 1 ? "first" : `in the first ${top}`}`);
  }
  // A share link's key says where it is redeemed.
  assert.match(flat(commandHelp(realTable, "Overseer", "create-share-link", ["open-workspace", "w", "create-share-link"])),
    /redeems the key by passing it as `shareKey` to `open-workspace` \(on AuthenticatedApi\)/);
});

test("search finds the commands for gadget-worded tasks, by what the API says of gadgets", () => {
  // A workspace holds the user's gadgets, a gadget is one workpiece of it: listing them is the
  // workspace's workpiece list, found by default beside the workspaces it is read on, and deleting
  // one is removing that workpiece, not deleting the whole workspace.
  const workpieces = /^cf-os api open-workspace <id> subscribe-to-workpieces$/;
  const cases: [string, RegExp, number][] = [
    ["list my gadgets", /^cf-os api list-workspaces$/, 1],
    ["list my gadgets", workpieces, 5],
    ["list gadgets", workpieces, 5],
    ["list the gadgets in a workspace", workpieces, 5],
    ["gadget id", workpieces, 2],
    ["delete gadget", /^cf-os api open-workspace <id> get-gadget <id> remove$/, 1],
    ["remove a gadget from a workspace", /^cf-os api open-workspace <id> get-gadget <id> remove$/, 1],
    ["rename a gadget", /^cf-os api open-workspace <id> get-gadget <id> set-title <title>$/, 1],
    ["create a gadget", /^cf-os api open-workspace <id> create-gadget <title>$/, 1],
    ["built-in gadgets", /^cf-os api list-output-formats$/, 1],
    ["what gadgets ship with this instance", /^cf-os api list-output-formats$/, 2],
    ["gadget console logs", / subscribe-to-console-logs$/, 1],
    ["call a method on a gadget", / get-gadget <id> connect-to-gadget$/, 1],
    ["import gadget data", / connect-to-gadget$/, 2],
    ["export gadget data", / get-gadget <id> export <id>$/, 5],
    // A gadget and a gatekeeper share remove and set-title, and one doc: where each sits tells them apart.
    ["remove a gatekeeper from the workspace", /^cf-os api open-workspace <id> get-gatekeeper-by-id <id> remove$/, 1],
    ["delete a gatekeeper", /^cf-os api open-workspace <id> get-gatekeeper-by-id <id> remove$/, 1],
    ["remove gatekeeper", /^cf-os api open-workspace <id> get-gatekeeper-by-id <id> remove$/, 1],
    ["rename a gatekeeper", /^cf-os api open-workspace <id> get-gatekeeper-by-id <id> set-title <title>$/, 1],
    ["gatekeeper title", / get-gatekeeper-by-id <id> [gs]et-title/, 1],
    // Round 3's workspace-worded tasks still find theirs.
    ["list my workspaces", /^cf-os api list-workspaces$/, 1],
    ["rename a workspace", /^cf-os api open-workspace <id> set-title <title>$/, 1],
    ["share a workspace", / create-share-link </, 3],
    ["list schedules", / list-hooks$/, 1],
    ["wait for the agent to finish", / wait-for-agent <chatId>$/, 1],
  ];
  for (const [task, wanted, top] of cases) {
    const rank = rankOf(realTable, task, wanted);
    assert.ok(rank >= 1 && rank <= top, `"${task}" ranks ${wanted} ${rank || "nowhere"}, wanted ${top === 1 ? "first" : `in the first ${top}`}`);
  }
  assert.ok(rankOf(realTable, "delete gadget", / delete-self$/) > 1);
  // The New menu's blueprints are no gadget of the user's: listing those finds the workpiece list first.
  for (const task of ["list my gadgets", "list gadgets"]) {
    const formats = rankOf(realTable, task, /^cf-os api list-output-formats$/);
    assert.ok(formats === 0 || formats > rankOf(realTable, task, workpieces), task);
  }
  assert.equal(searchCommands(realTable, "create a skill")[0]!.command,
    "cf-os api get-gatekeeper-app context ui create-context-skill <collectionId> <path> <doc>");
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
    /^--timeout needs a value\. Run `cf-os api --help` for the API options\.$/.test(error.message));
  // A `--` lets through the one token after it, as in a chain, not every token after it.
  assert.deepEqual(parseSearch(["search", "x", "--", "--limit"]), { query: "x --limit", help: false });
  assert.throws(() => parseSearch(["search", "--", "x", "--limit", "3"]), /^Error: Unknown option --limit for search\./);
});

test("search, types and create-account check their options as a generated command does, never in node:util's words", () => {
  const refused = (parse: () => unknown, message: string) => assert.throws(parse, (error: Error) => error instanceof UsageError &&
    error.message === message && !/To specify a positional|place it at the end|argument is ambiguous/.test(error.message), message);
  refused(() => parseSearch(["search", "x", "--limit", "3"]), "Unknown option --limit for search. Run `cf-os api search --help` for its options.");
  refused(() => parseSearch(["search", "x", "--dryrun"]),
    "Unknown option --dryrun for search. Did you mean --dry-run? Run `cf-os api search --help` for its options.");
  refused(() => parseTypes(["types", "--nope"]), "Unknown option --nope for types. Run `cf-os api types --help` for its options.");
  refused(() => parseTypes(["types", "--url", "--dry-run"]),
    "--url needs a value, and --dry-run reads as an option: write --url=--dry-run if that is the value. Run `cf-os api --help` for the API options.");
  refused(() => parseTypes(["types", "--help=x"]), "--help takes no value: run `cf-os api types --help`.");
  refused(() => parseSearch(["search", "x", "--dry-run=true"]),
    "--dry-run takes no value: write --dry-run or --no-dry-run. Run `cf-os api --help` for the API options.");
  // A generated command refuses `--help=<value>` as it does `--dry-run=true`.
  refused(() => parseInvocation(realTable, ["list-workspaces", "--help=foo"]), "--help takes no value: run `cf-os api list-workspaces --help`.");
  // The runtime options are still taken, and ignored.
  assert.deepEqual(parseTypes(["--username", "bob", "types", "Overseer", "--timeout", "3"]), { service: "Overseer", help: false });
  // A single-dash token is a positional, as walk reads it, so it is the command word, not skipped.
  assert.equal(parseSearch(["-v", "search", "workspaces"]), undefined);
  assert.equal(parseTypes(["-v", "types"]), undefined);
  assert.deepEqual(parseSearch(["search", "-v", "workspaces"]), { query: "-v workspaces", help: false });
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
  const open = commandHelp(realTable, realTable.root, "open-workspace", ["open-workspace"]);
  assert.match(open, /\nAnswers \(/);
  assert.ok(flat(open).includes("Answers (the server may ask; give each with --answer '<name>=<json|@file|->', which answers its " +
    "first call; otherwise the call fails, exit 2, saying what it asked):"));
  assert.match(open, /ObserverConfigCallback\.configure\(needs\)\s+returns ObserverAccountChoice\[\], where ObserverAccountChoice = \{ accountId: number; gatekeeperId: number \}/);
  assert.doesNotMatch(open, /Events \(/);
  const subscribe = commandHelp(realTable, "Overseer", "subscribe-to-chat", ["open-workspace", "g", "subscribe-to-chat"]);
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
    parseInvocation(on, [...on === realTable ? ["open-workspace", "g", "get-metadata"] : ["set-mood", "calm"], ...extra,
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
  const stdin = { ...noFiles, readStdin: async () => new TextEncoder().encode("[]") };
  const invocation = parseInvocation(realTable, ["open-workspace", "g", "get-metadata", "--answer", "ObserverConfigCallback.configure=-"]);
  assert.deepEqual((await decodeCalls(realTable, invocation, stdin)).answers.get("ObserverConfigCallback.configure"), []);
  const both = parseInvocation(realTable, ["connect-account", "google", "--resource-url-patterns", "-", "--answer", "ObserverConfigCallback.configure=-"]);
  await assert.rejects(decodeCalls(realTable, both, stdin), (error: Error) =>
    error instanceof UsageError && error.message === "Only one argument can read stdin (-).");
});

test("--timeout is at most 2147483 seconds, what a timer holds, and finite: else a usage error, a dry run too", () => {
  assert.equal(parseInvocation(table, ["find-notes", "q", "--timeout", "2147483"]).flags.timeout, 2147483);
  for (const value of ["2147484", "1e10", "1e999", "Infinity"]) {
    usage(["--dry-run", "find-notes", "q", "--timeout", value],
      new RegExp(`^--timeout must be a positive number of seconds, at most 2147483 \\(about 24 days\\); got "${value}"\\. ` +
        "Leave it out for no timeout\\.$"));
  }
});

test("a positional that names a command of the capability returned is said to have been taken for it", () => {
  // The fixture's open-notebook <id> returns a Notebook, which has an `outline`.
  assert.equal(incompleteChain(table, parseInvocation(table, ["open-notebook", "outline"])),
    '"outline" was taken for open-notebook\'s <id>, not as a command of Notebook, so the chain goes on: nothing was sent. ' +
    "open-notebook needs <id> first, as in `cf-os api open-notebook <id> outline`; " +
    "`cf-os api open-notebook --help` lists Notebook's commands.");
  const blueprint = incompleteChain(realTable, parseInvocation(realTable, ["new-workspace-from-blueprint", "format.document", "get-metadata"]));
  assert.match(blueprint, /^"get-metadata" was taken for new-workspace-from-blueprint's <bindings>, not as a command of Overseer/);
  assert.match(blueprint, /as in `cf-os api new-workspace-from-blueprint format\.document <bindings> get-metadata`;/);
  assert.doesNotMatch(blueprint, /get-metadata get-metadata/);
});

test("a positional taken for a command of the capability returned is said so when a positional is still missing", () => {
  assert.throws(() => parseInvocation(realTable, ["new-workspace-from-blueprint", "get-metadata"]), (error: Error) => error instanceof UsageError &&
    error.message === '"get-metadata" was taken for new-workspace-from-blueprint\'s <blueprintId>, not as a command of Overseer: nothing was sent. ' +
    "new-workspace-from-blueprint needs <blueprintId> <bindings> first, as in " +
    "`cf-os api new-workspace-from-blueprint <blueprintId> <bindings> get-metadata`; " +
    "`cf-os api new-workspace-from-blueprint --help` lists its arguments.");
  usage(["find-notes"], /^find-notes needs <query>\. /);
});

test("a positional taken for a command of the capability returned is refused when the chain goes on, unless after a `--`", () => {
  // Complete as typed, so it would be sent: "list-chats" as the workspace id.
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "list-chats", "get-chat-history", "1"]), (error: Error) => error instanceof UsageError &&
    error.message === '"list-chats" was taken for open-workspace\'s <id>, not as a command of Overseer: nothing was sent. ' +
    "open-workspace needs <id> first, as in `cf-os api open-workspace <id> list-chats get-chat-history 1`; " +
    "`cf-os api open-workspace --help` lists its arguments. If \"list-chats\" is meant as open-workspace's <id>, put `--` before it.");
  // Said so before what follows is looked up on the capability the command returns.
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "w", "get-gadget", "get-binding", "x"]), (error: Error) =>
    error instanceof UsageError && error.message.startsWith('"get-binding" was taken for get-gadget\'s <id>, not as a command of GadgetClient: ') &&
    error.message.includes("as in `cf-os api open-workspace w get-gadget <id> get-binding x`"));
  usage(["open-notebook", "outline", "outline"], /^"outline" was taken for open-notebook's <id>, not as a command of Notebook: nothing was sent\. /);
  // A capability property of the result, as a command of a capability is.
  assert.throws(() => parseInvocation(realTable, ["get-gatekeeper-app", "ui", "call", "m"]), (error: Error) => error instanceof UsageError &&
    error.message.startsWith('"ui" was taken for get-gatekeeper-app\'s <id>, not as a property of its result: nothing was sent. '));
  // `--` is offered only where the positional can hold the word: not get-gadget's number <id>, nor
  // <bindings>, JSON that admits no string, where `--` would only fail again.
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "1", "get-gadget", "export", "export", "md"]), (error: Error) =>
    error instanceof UsageError && error.message.startsWith('"export" was taken for get-gadget\'s <id>') && !error.message.includes("put `--`"));
  assert.throws(() => parseInvocation(realTable, ["new-workspace-from-blueprint", "format.document", "get-metadata", "get-metadata"]), (error: Error) =>
    error instanceof UsageError && error.message.startsWith('"get-metadata" was taken for new-workspace-from-blueprint\'s <bindings>') &&
    !error.message.includes("put `--`"));
  // After a `--` it is meant as typed.
  const escaped = parseInvocation(realTable, ["open-workspace", "--", "list-chats", "get-chat-history", "1"]);
  assert.deepEqual(names(escaped.hops), ["open-workspace", "get-chat-history"]);
  assert.deepEqual((escaped.hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["list-chats"]);
});

test("an unknown command or option says which was meant: a near name, or where the command lives", () => {
  usage(["find-note", "q"], /^FixtureAuthedApi has no command "find-note"\. Did you mean find-notes\? /);
  usage(["outline"], /^FixtureAuthedApi has no command "outline"\. outline is on Notebook: `cf-os api open-notebook <id> outline`\. /);
  usage(["find-notes", "q", "--limt", "3"], /^Unknown option --limt for find-notes\. Did you mean --limit\? /);
  usage(["find-notes", "q", "--dryrun"], /^Unknown option --dryrun for find-notes\. Did you mean --dry-run\? /);
  usage(["--bogus"], /^Unknown option --bogus\. Run /);
  const real = (tokens: string[], message: RegExp) => assert.throws(() => parseInvocation(realTable, tokens),
    (error: Error) => error instanceof UsageError && message.test(error.message));
  real(["list-chats"], /list-chats is on Overseer: `cf-os api open-workspace <id> list-chats`/);
  real(["open-workspace", "g", "list-actions", "--option", "{}"], /Did you mean --options\?/);
  real(["list-workspace"], /Did you mean list-workspaces\?/);
  // A name cut short wins over a typo that changes its verb: get-chat is two edits from new-chat.
  real(["get-chat"], /Did you mean get-chat-[a-z-]+, on Overseer: `cf-os api open-workspace <id> get-chat-/);
  // A short name a typo starts with is no run-on: list-chtas is list-chats, not a bare `list`.
  real(["open-workspace", "g", "list-chtas"], /^Overseer has no command "list-chtas"\. Did you mean list-chats\? /);
  real(["list-worksapces"], /Did you mean list-workspaces\? /);
});

test("the root help says what `--` does, and that an option after it is a value", () => {
  assert.match(flat(nodeHelp(realTable, realTable.root, [])),
    /-- makes the next token an argument or a command, even one that reads as an option \(`set-title -- --dry-run` sets the title, for real\): one `--` each/);
});

test("`call` needs a method name that is not empty", () => {
  usage(["open-notebook", "n", "connect", "call", ""], /^call needs a method name: `call <method> \[json-args\.\.\.\]`\.$/);
});

test("the --url line shows CFOS_API_URL's origin only: no credentials, path or query", () => {
  const help = flat(urlHelp({ kind: "url", url: "http://x:pw@localhost:9/p?token=abc", from: "CFOS_API_URL" }, 23).join("\n"));
  assert.match(help, /default: http:\/\/localhost:9, from CFOS_API_URL/);
  assert.doesNotMatch(help, /pw|token=|abc|\/p\b/);
  assert.match(flat(urlHelp({ kind: "url", url: "not a url pw", from: "CFOS_API_URL" }, 23).join("\n")), /CFOS_API_URL, which is not a URL/);
});

test("`--` lets through the one token after it, so a later segment's options are still options", () => {
  // A gadget titled "export", then GadgetClient's own `export`, with its flag.
  const gadget = parseInvocation(realTable, ["open-workspace", "abc", "create-gadget", "--", "export", "export", "md", "--chat-id", "3"]);
  assert.deepEqual(names(gadget.hops), ["open-workspace", "create-gadget", "export"]);
  const [, create, exported] = gadget.hops as Extract<Hop, { kind: "command" }>[];
  assert.deepEqual(create.positionals, ["export"]);
  assert.deepEqual(exported.positionals, ["md"]);
  assert.deepEqual(exported.flags, { "chat-id": "3" });
  // Each token that reads as an option takes its own `--`, `--` itself included.
  const call = parseInvocation(table, ["get-frame", "ui", "call", "echo", "--", "--a", "--", "--", "--", "-h", "--dry-run"]);
  assert.deepEqual(call.hops.at(-1), { kind: "call", method: "echo", args: ["--a", "--", "-h"] });
  assert.equal(call.flags.dryRun, true);
  // `call` itself, which would start a new call.
  assert.deepEqual(parseInvocation(table, ["get-frame", "ui", "call", "echo", "--", "call"]).hops.at(-1), { kind: "call", method: "echo", args: ["call"] });
});

test("a positional typed after a `--` is never said to be a forgotten one, whatever the chain ends on", () => {
  assert.equal(incompleteChain(realTable, parseInvocation(realTable, ["open-workspace", "abc", "create-gadget", "--", "export"])),
    "create-gadget returns a capability (GadgetClient), so the chain goes on: nothing was sent. " +
    "Finish it with one of GadgetClient's commands, as in `cf-os api open-workspace abc create-gadget -- export get-export-formats`; " +
    "`cf-os api open-workspace abc create-gadget -- export --help` lists them.");
  assert.throws(() => parseInvocation(realTable, ["new-workspace-from-blueprint", "--", "get-metadata"]), (error: Error) =>
    error instanceof UsageError && error.message === "new-workspace-from-blueprint needs <bindings>. " +
      "Run `cf-os api new-workspace-from-blueprint -- get-metadata --help` for its arguments.");
});

test("a command's help does not say a positional typed after a `--` was taken for a command", () => {
  const help = (tokens: string[]) => {
    const invocation = parseInvocation(realTable, tokens);
    const target = invocation.help as Extract<NonNullable<typeof invocation.help>, { kind: "command" }>;
    return commandHelp(realTable, target.node, target.name, invocation.path, target.at, invocation.literal);
  };
  assert.match(help(["open-workspace", "abc", "create-gadget", "export", "--help"]), /^"export" was taken for create-gadget's <title>/);
  assert.match(help(["open-workspace", "abc", "create-gadget", "--", "export", "--help"]), /^Usage: cf-os api open-workspace abc create-gadget /);
});

test("a forgotten positional's suggested line shows --url as its origin: no credentials, path or query", () => {
  const message = (tokens: string[]) => {
    try {
      parseInvocation(realTable, ["open-workspace", "list-chats", "get-chat-history", "1", ...tokens]);
    } catch (error) {
      if (error instanceof UsageError) return error.message;
    }
    assert.fail("not refused");
  };
  const url = "https://user:hunter2@os.example.com/p?token=abc#frag";
  for (const tokens of [["--url", url, "--dry-run"], [`--url=${url}`, "--dry-run"]]) {
    const shown = message(tokens);
    assert.match(shown, /get-chat-history 1 --url(?: |=)https:\/\/os\.example\.com --dry-run`/);
    assert.doesNotMatch(shown, /hunter2|user:|token|abc|frag|\/p\b/);
  }
  assert.match(message(["--url", "not a url hunter2"]), /--url '<url>'`/);
  // A `--url` after a `--` is a value, and kept.
  assert.match(message(["--", "--url", "x"]), /-- --url x`/);
});

test("a forgotten positional's suggested line puts back the `--` a later positional needs", () => {
  assert.throws(() => parseInvocation(realTable, ["new-workspace-from-blueprint", "get-metadata", "--", "--x", "get-metadata"]),
    (error: Error) => error instanceof UsageError &&
      error.message.includes("as in `cf-os api new-workspace-from-blueprint <blueprintId> <bindings> get-metadata -- --x get-metadata`"));
  // So does the rest of the line, a `--` before the next command's name included.
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "list-chats", "--", "--x", "get-chat-history", "1"]),
    (error: Error) => error instanceof UsageError &&
      error.message.includes("as in `cf-os api open-workspace <id> list-chats -- --x get-chat-history 1`"));
});

test("--help on a line with a forgotten positional prints the help reached, after the error the line is", () => {
  const invocation = parseInvocation(realTable, ["open-workspace", "list-chats", "get-chat-history", "--help"]);
  assert.deepEqual(invocation.help, { kind: "command", node: "Overseer", name: "get-chat-history", at: 3 });
  assert.match(invocation.misread!, /^"list-chats" was taken for open-workspace's <id>, not as a command of Overseer: nothing was sent\. /);
  // A line that fails before its `--help` fails with the forgotten positional's error.
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "list-chats", "nope", "--help"]),
    (error: Error) => error instanceof UsageError && error.message.startsWith('"list-chats" was taken for open-workspace\'s <id>'));
  assert.equal(parseInvocation(realTable, ["open-workspace", "list-chats", "--help"]).misread, undefined);
});

test("a forgotten positional's suggested line keeps the options typed before it", () => {
  assert.throws(() => parseInvocation(realTable, ["open-workspace", "--dry-run", "--share-key", "K123", "list-chats", "get-chat-history", "1"]),
    (error: Error) => error instanceof UsageError &&
      error.message.includes("as in `cf-os api open-workspace --dry-run --share-key K123 <id> list-chats get-chat-history 1`"));
  assert.match(incompleteChain(realTable, parseInvocation(realTable, ["open-workspace", "--dry-run", "get-metadata", "--timeout", "5"])),
    /as in `cf-os api open-workspace --dry-run <id> get-metadata --timeout 5`;/);
});

test("a command's usage line puts back the `--` an earlier positional was typed after", () => {
  const invocation = parseInvocation(realTable, ["open-workspace", "--", "list-chats", "get-metadata", "--help"]);
  const target = invocation.help as Extract<NonNullable<typeof invocation.help>, { kind: "command" }>;
  const help = commandHelp(realTable, target.node, target.name, invocation.path, target.at, invocation.literal);
  const usage = /^Usage: cf-os api (.*)$/m.exec(help)![1];
  assert.equal(usage, "open-workspace -- list-chats get-metadata");
  assert.deepEqual(names(parseInvocation(realTable, usage.split(" ")).hops), ["open-workspace", "get-metadata"]);
});

test("an argument types a capability property as a gatekeeper app UI's node, which `call` still continues untyped", async () => {
  // A value the table maps is the app's node, its commands checked as any node's.
  const typed = parseInvocation(table, ["get-panel", "sketch", "ui", "pick", "red"]);
  assert.deepEqual(names(typed.hops), ["get-panel", "ui", "pick"]);
  assert.deepEqual(typed.hops[1], { kind: "property", name: "ui", property: "ui", returns: { kind: "stub", node: "sketch:SketchApi", nullable: false } });
  assert.deepEqual(typed.end, { kind: "result", returns: { kind: "value", type: "void" } });
  usage(["get-panel", "sketch", "ui", "erase"], /^sketch:SketchApi has no command "erase"\./);
  assert.deepEqual(parseInvocation(table, ["get-panel", "sketch", "ui"]).end, { kind: "node", node: "sketch:SketchApi" });
  // The JSON argument is revived against the app's own shapes, prefixed in the table.
  const [, , draw] = (await decodeCalls(table, parseInvocation(table,
    ["get-panel", "sketch", "ui", "draw", '{"at": "2026-01-02T03:04:05.000Z", "color": "red", "width": 2}', "--label", '{"text": "hi"}']), noFiles)).calls;
  assert.deepEqual(draw!.args, [{ at: new Date("2026-01-02T03:04:05.000Z"), color: "red", width: 2 }, { text: "hi" }]);
  await assert.rejects(decodeCalls(table, parseInvocation(table, ["get-panel", "sketch", "ui", "pick", "green"]), noFiles),
    (error: unknown) => error instanceof UsageError && /green/.test(error.message) && /blue, red|blue\|red/.test(error.message));

  // `call` continues the typed node as the untyped capability it is, and any other value stays untyped.
  const call = parseInvocation(table, ["get-panel", "sketch", "ui", "call", "pick", "green"]);
  assert.deepEqual(call.hops.slice(1), [
    { kind: "property", name: "ui", property: "ui", returns: { kind: "untyped" } },
    { kind: "call", method: "pick", args: ["green"] },
  ]);
  assert.deepEqual(call.end, { kind: "result", returns: { kind: "call" } });
  const other = parseInvocation(table, ["get-panel", "paint", "ui", "call", "pick"]);
  assert.deepEqual(other.hops[1], { kind: "property", name: "ui", property: "ui", returns: { kind: "untyped" } });
  usage(["get-panel", "paint", "ui", "pick"], /^Its `ui` is an untyped capability: continue with `call <method> \[json-args\.\.\.\]`, not "pick"\.$/);

  // Help: the typed node's listing, saying `call` works too; the untyped one's, saying what types it.
  assert.deepEqual(parseInvocation(table, ["get-panel", "sketch", "ui", "--help"]).help, { kind: "node", node: "sketch:SketchApi", call: true });
  const listing = nodeHelp(table, "sketch:SketchApi", ["get-panel", "sketch", "ui"], undefined, true);
  assert.match(listing, /^Usage: cf-os api get-panel sketch ui <command> \[arguments\] \[options\]\n/);
  assert.match(listing, /\n {2}pick <color> +Picks the pen's colour\.\n/);
  assert.match(flat(listing), /`cf-os api get-panel sketch ui call <method> \[json-args\.\.\.\]` also calls one of its methods by name, unchecked\./);
  const untyped = parseInvocation(table, ["get-panel", "paint", "ui", "--help"]).help as Extract<HelpTarget, { kind: "untyped" }>;
  assert.equal(untyped.about, "The panel's capability, typed by `kind`.\n\nWith <kind> sketch, it is typed (sketch:SketchApi), " +
    "checked command by command: `cf-os api get-panel sketch ui --help` lists sketch:SketchApi's.");
  assert.match(untypedHelp(["get-panel", "paint", "ui"], untyped.about), /^Usage: [^\n]*\n\nThe panel's capability, typed by `kind`\.\n\nWith <kind> sketch/);
  assert.equal((parseInvocation(table, ["get-panel", "paint", "ui", "call", "x", "--help"]).help as { about?: string }).about, untyped.about);
  const panel = commandHelp(table, "FixtureAuthedApi", "get-panel", ["get-panel"]);
  assert.match(flat(panel), /cf-os api get-panel <kind> ui call <method> \[json-args\.\.\.\] The panel's capability, typed by `kind`\. With <kind> sketch,[^]*`cf-os api get-panel sketch ui --help`/);
  assert.match(commandHelp(table, "FixtureAuthedApi", "get-panel", ["get-panel", "sketch"]), /\n\nThen, on its `ui` \(sketch:SketchApi\):\n[^]*\n {2}pick <color> /);
  assert.match(nodeHelp(table, table.root, []), /\n {2}get-panel <kind> → ui: sketch:SketchApi by <kind>, else call\n +A gatekeeper app's frame/);

  // Search lines reach the app's commands with the value in the argument's place, and find them by it.
  assert.deepEqual(nodePrefixes(table).get("sketch:SketchApi"), ["get-panel", "sketch", "ui"]);
  assert.equal(searchCommands(table, "pick the pen colour")[0]!.command, "cf-os api get-panel sketch ui pick <color>");
  assert.equal(searchCommands(realTable, "create a skill")[0]!.command,
    "cf-os api get-gatekeeper-app context ui create-context-skill <collectionId> <path> <doc>");
  assert.equal(searchCommands(realTable, "skills")[0]!.command,
    "cf-os api get-gatekeeper-app context ui create-context-skill <collectionId> <path> <doc>");
  assert.ok(searchCommands(realTable, "list scheduled tasks").some((match) => match.command === "cf-os api get-gatekeeper-app scheduler ui list"));
  // And an app's command typed on another node is pointed at its line.
  usage(["pick"], /^FixtureAuthedApi has no command "pick"\. pick is on sketch:SketchApi: `cf-os api get-panel sketch ui pick <color>`\. /);
});
