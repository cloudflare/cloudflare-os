// `cf-os api`'s walk: argv against the generated command table, then the chain it spells, issued in
// one Cap'n Web session.
//
// `cf-os api open-workspace <id> get-chat-history <chatId>` is two segments. Each names a command on
// the capability reached so far and takes that command's positional arguments; its flags may come
// anywhere before the next segment. A command returning a capability moves the walk on to it, and
// so does the name of a capability held in a top-level property of the object a command returns
// (`get-gatekeeper-app context ui list-enabled-context-collections`), read by pipelining on that
// result: on the node the table types it as, by the command's argument when it says so (a
// gatekeeper app UI's, here `context`'s), or untyped, continued with `call <method>`. The whole
// chain is sent pipelined, nothing awaited between hops, and only its last result is awaited.
// Afterwards every stub the chain made, every capability inside the printed result and the session
// itself are disposed, however the command ends.
//
// A callback the chain passes may have methods that return a value, which the server waits for.
// `--answer <Callback>.<method>=<json|@file|->` answers the first call of such a method; a call left
// unanswered stops the run with exit 2, printing what it asked and the flag to rerun with.
//
// A command the table says creates something (`reportsId`) has the id of what it made read
// beside the chain, pipelined on the capability it returns, and printed on stderr, so a chain that
// goes on past it, or fails after it, still says what it made.
//
// A null partway through the chain leaves the rest not run, so the run fails, saying what was null,
// when it is null where the table says so (`nullWhen`), and the help of the command that was.

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { RpcPromise } from "capnweb";
import { callbackStub, drainingWriter, encodeArgs, functionStub, ndjsonEvents, type AnswerCall } from "./callbacks.ts";
import {
  admitsString, decodeArg, decodeJson, decodeUntyped, encodeValue, redactSecrets, StreamArg, type ArgSource,
} from "./codec.ts";
import { firstSentence } from "./doc-text.ts";
import { UsageError, type Output } from "./output.ts";
import { nodePrefixes, positionalArgs } from "./paths.ts";
import { DEV_SERVER_URL, defaultInstance, type DefaultInstance, type Remote, type Session } from "./session.ts";
import type {
  ApiArg, ApiByArgument, ApiCapabilityProperty, ApiCommand, ApiNode, ApiReportsId, ApiReturn, ApiTable, SecretPath,
} from "./table.ts";

/** The word that selects `create-account` (create-account.ts) in a command's place on the root. */
export const CREATE_ACCOUNT = "create-account";

/** The flags `cf-os api` itself takes, valid in any segment. */
export const RUNTIME_OPTIONS = {
  url: { type: "string" },
  auth: { type: "string" },
  username: { type: "string" },
  "dry-run": { type: "boolean" },
  timeout: { type: "string" },
  out: { type: "string" },
  answer: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/** The longest `--timeout`, in seconds: a Node timer holds at most 2^31-1 ms, and fires at once past it. */
const MAX_TIMEOUT = Math.floor((2 ** 31 - 1) / 1000);

/** The root help's API options after `--url`'s, which {@link urlHelp} writes. */
const RUNTIME_HELP = [
  "  --auth <mode>        access (default for https://): a Cloudflare Access token, from",
  "                       CF_ACCESS_TOKEN or `cloudflared access token`; token (default for http://):",
  "                       CFOS_API_TOKEN; password: --username and CFOS_API_PASSWORD",
  "  --username <name>    sign in as <name>, with a password (implies --auth password); on a local",
  "                       or test instance, `cf-os api create-account <name>` makes one",
  "  --answer <Callback.method>=<json|@file|->",
  "                       answer the first call of a callback method that returns a value (a",
  "                       command's help lists them under Answers); without one, the call fails,",
  "                       exit 2, saying what it asked",
  "  --dry-run            print the calls as JSON on stdout; connect to nothing",
  "  --timeout <seconds>  end a subscription (exit 0), or fail any other command, after this long:",
  `                       at most ${MAX_TIMEOUT}; without it, no limit`,
  "  --out <file|->       where returned bytes go: a byte stream (default: stdout, unless a",
  "                       terminal), or a byte value, decoded (default: printed as base64 JSON)",
  "  -h, --help           help for the capability or command reached so far",
  "  --                   makes the next token an argument or a command, even one that reads as an",
  "                       option (`set-title -- --dry-run` sets the title, for real): one `--` each",
];

/** How to find a command, as messages put it. */
const SEARCH = '`cf-os api search "<task>"`';

/** The one line that stands for {@link RUNTIME_HELP} everywhere but the root's help. */
const RUNTIME_HELP_POINTER = "API options: `cf-os api --help`";

/** The runtime flags, parsed. */
export interface RuntimeFlags {
  url?: string;
  auth?: string;
  username?: string;
  dryRun: boolean;
  /** Seconds. */
  timeout?: number;
  out?: string;
  /** `--answer`'s raw values, in order, from every segment. */
  answers: string[];
}

/** One segment of the chain. */
export type Hop =
  | {
    kind: "command";
    /** The command's name, as typed. */
    name: string;
    /** The capability it is called on. */
    node: string;
    command: ApiCommand;
    positionals: string[];
    /** Its own flags, by flag name. */
    flags: Record<string, string | boolean>;
    /** How many tokens of the walked path (Invocation.path) reach it, its name included. */
    at: number;
  }
  /** `call <method> [json-args...]` on an untyped capability. */
  | { kind: "call"; method: string; args: string[] }
  /** A capability property of the previous command's value result, read on it. */
  | {
    kind: "property";
    /** Its name as typed: the property in kebab-case. */
    name: string;
    /** Its name in api.ts. */
    property: string;
    /** What reading it continues on. */
    returns: ApiCapabilityProperty["returns"];
  };

/** What `--help` describes. */
export type HelpTarget =
  /** `call`: an untyped capability typed by an argument (ApiByArgument), which `call` continues too. */
  | { kind: "node"; node: string; call?: true }
  /** `at`: how many tokens of the walked path reach it, its name included. */
  | { kind: "command"; node: string; name: string; at: number }
  /**
   * `at`: how many tokens of the walked path reach the capability, `call` not included. `about`:
   * what the table says of it, for a capability property: its doc, and the nodes an argument types
   * it as.
   */
  | { kind: "untyped"; at: number; about?: string };

/** Where the walk stopped. */
export type WalkEnd =
  /** On a capability, with no command for it: its help is printed. */
  | { kind: "node"; node: string }
  /** On an untyped capability, with no `call` for it. */
  | { kind: "untyped" }
  /** On a command whose result is printed (or streamed, or subscribed to). */
  | { kind: "result"; returns: ApiReturn | { kind: "call" } };

/** argv, walked. */
export interface Invocation {
  /** A leading `public`: the chain starts on `PublicApi`, without signing in. */
  public: boolean;
  hops: Hop[];
  flags: RuntimeFlags;
  end: WalkEnd;
  /** `--help` was given: describe this instead of running anything. */
  help?: HelpTarget;
  /** The tokens walked, segment names and positionals, for usage lines. */
  path: string[];
  /**
   * Which tokens of `path`, by index, are positionals typed after a `--`: meant as typed, so never
   * said to name a command the line forgot a positional before, and typed after a `--` again in the
   * lines messages suggest.
   */
  literal?: number[];
  /** The tokens walked as typed, options and `--` included, for the lines messages suggest. */
  argv: string[];
  /** Where in `argv`, by index, each token of `path` was typed. */
  argvAt: number[];
  /**
   * For `--help` on a line that took a positional naming what follows it (a forgotten positional
   * before it), the usage error the line is without `--help`, printed before the help.
   */
  misread?: string;
}

interface Segment {
  kind: "prefix" | "command" | "call" | "property";
  hop?: Extract<Hop, { kind: "command" }>;
  /** For `property`, the node it continues on; absent for an untyped capability. */
  node?: string;
  options: ParseArgsOptionsConfig;
  flagTokens: string[];
  positionals: string[];
  /** Positional arguments it takes; `Infinity` for `call`. */
  needed: number;
  /** How many tokens of the walked path reach it: those of its own help line. */
  at: number;
}

/** Where the walk is. `call` on a node: an untyped capability typed by an argument, which `call` continues too. */
type Position = { kind: "node"; node: string; call?: true } | { kind: "untyped" } | { kind: "result"; after: string; returns: ApiReturn };

/**
 * `path` as it would be typed to walk the same way: quoted, with a `--` back before each token the
 * walk takes only after one: one that reads as a flag, `--` itself, and those at the indexes in
 * `literal` (Invocation.literal), which a `--` kept from being read as a command.
 */
function typedPath(path: string[], literal: number[] = []): string {
  return shellLine(path.flatMap((token, index) => token === "--" || isFlag(token) || literal.includes(index) ? ["--", token] : [token]));
}

/** The help command for what `path` reaches, as it would be typed ({@link typedPath}). */
function helpCommand(path: string[], literal: number[] = []): string {
  return `\`${["cf-os api", typedPath(path, literal), "--help"].filter((part) => part !== "").join(" ")}\``;
}

/**
 * `message` as one sentence, then where to read about the option it names (`node:util`'s messages
 * lack both): the root's help for a runtime option, the help `path` reaches for any other.
 */
function withHelpPointer(message: string, path: string[], literal: number[] = []): string {
  const option = /--(?:no-)?([\w-]+)/.exec(message)?.[1];
  const help = option !== undefined && Object.hasOwn(RUNTIME_OPTIONS, option)
    ? "`cf-os api --help` for the API options" : `${helpCommand(path, literal)} for its options`;
  return `${message.replace(/[^.!?]$/, "$&.")} Run ${help}.`;
}

function isFlag(token: string): boolean {
  return (token.startsWith("--") && token.length > 2) || token === "-h";
}

function commandOptions(command: ApiCommand): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = { ...RUNTIME_OPTIONS };
  for (const arg of command.args) {
    if (arg.flag) options[arg.flag] = { type: arg.encoding === "boolean" ? "boolean" : "string" };
  }
  return options;
}

function optionFor(options: ParseArgsOptionsConfig, name: string): { type: "string" | "boolean" } | undefined {
  if (Object.hasOwn(options, name)) return options[name];
  const negated = name.startsWith("no-") ? options[name.slice(3)] : undefined;
  return negated?.type === "boolean" && Object.hasOwn(options, name.slice(3)) ? negated : undefined;
}

/** Where a flag is read, for its messages: the command's help (`path`, `literal` as Invocation's) and its name. */
interface FlagPlace {
  /** The tokens of the help line of what takes the flag. */
  path: string[];
  literal?: number[];
  /** " for <command>", as messages name what takes it, or empty for a flag before any command. */
  on: string;
}

/**
 * The flag `tokens[i]` (one {@link isFlag} says is one), checked against `options` before parseArgs
 * reads it, so that none of node:util's wording reaches the user: its name, the token as parseArgs
 * is to read it (a string option's value joined with `=`, so one that starts with a dash is still
 * the value), and the index of the last token it takes. Throws {@link UsageError} for an option
 * `options` does not have (saying the nearest it does), a value given to a boolean (`--dry-run=true`,
 * `--help=x`), and a string option with no value, or followed by a token that reads as an option:
 * a flag is never taken for the value, so `--note --dry-run` cannot send a real call.
 */
function readFlag(tokens: string[], i: number, options: ParseArgsOptionsConfig, place: FlagPlace): { name: string; token: string; end: number } {
  const token = tokens[i]!;
  const name = token === "-h" ? "help" : token.slice(2).split("=")[0]!;
  const valued = token.includes("=");
  const pointer = (message: string) => new UsageError(withHelpPointer(message, place.path, place.literal));
  const option = optionFor(options, name);
  if (!option) {
    const meant = nearest(name, Object.keys(options));
    throw new UsageError(`Unknown option --${name}${place.on}.${meant ? ` Did you mean --${meant}?` : ""} ` +
      `Run ${helpCommand(place.path, place.literal)} for its options.`);
  }
  if (option.type === "boolean") {
    const base = Object.hasOwn(options, name) ? name : name.slice(3);
    if (valued && name === "help") throw new UsageError(`--help takes no value: run ${helpCommand(place.path, place.literal)}.`);
    if (valued) throw pointer(`--${name} takes no value: write --${base} or --no-${base}.`);
    return { name, token, end: i };
  }
  if (valued) return { name, token, end: i };
  if (i + 1 >= tokens.length) throw pointer(`--${name} needs a value.`);
  if (isFlag(tokens[i + 1]!)) {
    throw pointer(`--${name} needs a value, and ${tokens[i + 1]} reads as an option: write --${name}=${tokens[i + 1]} if that is the value.`);
  }
  return { name, token: `--${name}=${tokens[i + 1]}`, end: i + 1 };
}

/**
 * The command word of `tokens`, everything after `cf-os api` but the global options: the first token
 * walk and {@link parseSegment} read as a positional, past each flag and the value a string option of
 * `options` takes. An unknown flag is passed alone, as whatever reads the line then refuses it. Read
 * as they read it, so a token such as `-v`, a positional to them, is the word, never skipped.
 */
export function commandWord(tokens: string[], options: ParseArgsOptionsConfig): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return tokens[i + 1];
    if (!isFlag(token)) return token;
    const option = token === "-h" || token.includes("=") ? undefined : optionFor(options, token.slice(2));
    if (option?.type === "string" && i + 1 < tokens.length && !isFlag(tokens[i + 1]!)) i++;
  }
  return undefined;
}

/**
 * `tokens`, a command of the CLI's own (`search`, `types`, `create-account`) and its arguments,
 * every runtime option of the line among them, read against `options` as walk reads a segment: each
 * flag checked by {@link readFlag}, `--` making the one token after it a positional, and every other
 * token a positional. `--help` stops the reading where it appears, as it stops the walk. Throws
 * {@link UsageError} naming `command`'s help for a flag it does not take.
 */
export function parseSegment(tokens: string[], options: ParseArgsOptionsConfig, command: string):
  { values: Record<string, string | boolean | (string | boolean)[] | undefined>; positionals: string[] } {
  const place: FlagPlace = { path: [command], on: ` for ${command}` };
  const flagTokens: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      if (i + 1 < tokens.length) positionals.push(tokens[++i]!);
      continue;
    }
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }
    const flag = readFlag(tokens, i, options, place);
    if (flag.name === "help") return { values: { help: true }, positionals };
    flagTokens.push(flag.token);
    i = flag.end;
  }
  // Every flag is one `options` takes, as it takes it, so the strict parse refuses none.
  const { values } = parseArgs({ args: flagTokens, options, strict: true, allowPositionals: false, allowNegative: true });
  return { values, positionals };
}

/**
 * `--timeout`'s seconds, from its raw value; undefined for none. Throws {@link UsageError} for one
 * that is not a positive number of seconds, or is past what a Node timer holds.
 */
export function timeoutSeconds(raw: string | undefined): number | undefined {
  const timeout = raw === undefined ? undefined : Number(raw);
  if (timeout !== undefined && !(timeout > 0 && timeout <= MAX_TIMEOUT)) {
    throw new UsageError(`--timeout must be a positive number of seconds, at most ${MAX_TIMEOUT} (about 24 days); ` +
      `got "${raw}". Leave it out for no timeout.`);
  }
  return timeout;
}

/** The capability properties of a value result, by name; none for any other. */
function capabilitiesOf(returns: ApiReturn | { kind: "call" }): Record<string, ApiCapabilityProperty> {
  return returns.kind === "value" ? returns.capabilities ?? {} : {};
}

/**
 * The node `by` types a capability property of `command`'s result as, given `positionals`, the
 * command's positionals as typed so far; undefined when its argument is not typed yet or is none
 * of `by`'s values.
 */
function typedBy(command: ApiCommand, by: ApiByArgument, positionals: string[]): string | undefined {
  const value = positionals[positionalArgs(command).findIndex((arg) => arg.index === by.index)];
  return value !== undefined && Object.hasOwn(by.nodes, value) ? by.nodes[value] : undefined;
}

/** What reading `capability` on the result of `hop` continues on: the node its argument types it as, or as declared. */
function propertyReturns(hop: Extract<Hop, { kind: "command" }>, capability: ApiCapabilityProperty): ApiCapabilityProperty["returns"] {
  const node = capability.byArgument && typedBy(hop.command, capability.byArgument, hop.positionals);
  return node === undefined ? capability.returns : { kind: "stub", node, nullable: false };
}

/** The `<name>` of the positional `by` reads, for messages. */
function byArgumentName(command: ApiCommand, by: ApiByArgument): string {
  return `<${command.args.find((arg) => arg.index === by.index)!.name}>`;
}

/**
 * What help says of an untyped capability property of `command`'s result: its doc, then, when an
 * argument types it, for which values and how to list their commands, `line` being the command
 * line that reaches `command` with `value` in that argument's place.
 */
function untypedAbout(command: ApiCommand, capability: ApiCapabilityProperty, line: (value: string) => string): string {
  const by = capability.byArgument;
  const typed = by ? Object.entries(by.nodes) : [];
  return [
    capability.doc ?? "",
    ...typed.length ? [`With ${byArgumentName(command, by!)} ${typed.map(([value]) => value).join(" or ")}, it is typed ` +
      `(${typed.map(([, node]) => node).join(", ")}), checked command by command: \`${line(typed[0]![0])} --help\` lists ` +
      `${typed[0]![1]}'s.`] : [],
  ].filter(Boolean).join("\n\n");
}

/** What a chain-ending result is, for messages. */
function resultNoun(returns: ApiReturn): string {
  switch (returns.kind) {
    case "value":
      return returns.type === "void" ? "nothing" : "a value";
    case "stub":
      return "a capability";
    case "handle":
      return "a handle";
    case "stream":
      return "bytes";
    case "subscription":
      return "events";
    case "untyped":
      return "an untyped capability";
  }
}

/** `` `ui` is a capability ``, or `` `a` and `b` are capabilities ``: the properties `names`, for messages. */
function capabilityNames(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length === 1 ? `${quoted[0]} is a capability` : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} are capabilities`;
}

function describeReturn(returns: ApiReturn): string {
  switch (returns.kind) {
    case "value":
      if (returns.bytes) return `${returns.type}: bytes, printed as {"base64": "..."} JSON, or written decoded to --out <file|->`;
      return returns.type === "void" ? "nothing (prints null)" : `${returns.type}, printed as JSON`;
    case "stub":
      return `a capability on ${returns.node}${returns.nullable ? ", or null" : ""}: follow with one of its commands`;
    case "handle":
      return "a handle, disposed at once (prints null)";
    case "stream":
      return "bytes, written to --out (or stdout, unless it is a terminal)";
    case "subscription":
      return "events, one JSON line each on stdout, until --timeout or Ctrl-C (a reader that has gone, " +
        "as `| head` does, is noticed only at the next event, so pair one with --timeout)";
    case "untyped":
      return "an untyped capability: follow with `call <method> [json-args...]`";
  }
}

/** How many single-character edits turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** How close a name is to what was typed, as {@link closer} ranks it. */
interface Closeness {
  /** Whether one of the two starts with the other: a name cut short or run on. */
  cut: boolean;
  /** The edit distance between them. */
  distance: number;
}

/**
 * How close `name` is to `typed`: a name cut short or run on (`list-workspace`, `get-chat` for
 * `get-chat-history`) or a typo of it (an edit for every four characters typed, at least one).
 * A run-on name covers at least half of what was typed, so a short name (`list`) is no cut of every
 * longer token it starts (`list-chtas`, a typo of `list-chats`). None when it is neither.
 */
function closeness(typed: string, name: string): Closeness | undefined {
  const distance = editDistance(typed, name);
  const cut = typed.length >= 4 && (name.startsWith(typed) || (typed.startsWith(name) && name.length * 2 >= typed.length));
  return cut || distance <= Math.max(1, Math.floor(typed.length / 4)) ? { cut, distance } : undefined;
}

/**
 * Whether `a` is closer than `b`. A name cut short or run on comes first: it keeps what was typed,
 * where a typo of the same length can change its verb (`get-chat` is two edits from `new-chat`).
 */
function closer(a: Closeness, b: Closeness | undefined): boolean {
  return !b || (a.cut !== b.cut ? a.cut : a.distance < b.distance);
}

/** The one of `names` that `typed` most likely meant ({@link closer}); none when no name is close. */
function nearest(typed: string, names: Iterable<string>): string | undefined {
  let best: { name: string; close: Closeness } | undefined;
  for (const name of names) {
    const close = closeness(typed, name);
    if (close && closer(close, best?.close)) best = { name, close };
  }
  return best?.name;
}

/**
 * What `token`, no command of `node`, was likely meant to be, as the start of the usage error: the
 * command of that name on another capability and the line that reaches it, else the command
 * nearest it ({@link closer}), on `node` or elsewhere. Empty when nothing is near.
 */
function meantCommand(table: ApiTable, node: string, token: string): string {
  const elsewhere = [...nodePrefixes(table)].filter(([other]) => other !== node);
  const lineFor = (other: string, prefix: string[], name: string) => ["cf-os api", ...prefix, name,
    ...positionalArgs(table.nodes[other].commands[name]).map((arg) => `<${arg.name}>`)].join(" ");
  const there = elsewhere.find(([other]) => Object.hasOwn(table.nodes[other].commands, token));
  if (there) return `${token} is on ${there[0]}: \`${lineFor(there[0], there[1], token)}\`. `;
  // The closest of all ({@link closer}); of two as close, the one on `node`.
  let best: { other: string; prefix: string[]; name: string; close: Closeness } | undefined;
  for (const [other, prefix] of [[node, []] as [string, string[]], ...elsewhere]) {
    for (const name of Object.keys(table.nodes[other].commands)) {
      const close = closeness(token, name);
      if (close && closer(close, best?.close)) best = { other, prefix, name, close };
    }
  }
  if (!best) return "";
  if (best.other === node) return `Did you mean ${best.name}? `;
  return `Did you mean ${best.name}, on ${best.other}: \`${lineFor(best.other, best.prefix, best.name)}\`? `;
}

/**
 * Where among `typed`, positionals typed for `command`, the first is that names what follows it (a
 * command of the capability it returns, or a capability property of its result), and so was most
 * likely meant as that, not as the positional; -1 for none. Those at the indexes in `literal`, typed
 * after a `--`, are meant as typed.
 */
function misreadAt(table: ApiTable, command: ApiCommand, typed: string[], literal: number[] = []): number {
  const next = command.returns.kind === "stub" ? command.returns.node : undefined;
  const capabilities = capabilitiesOf(command.returns);
  return typed.findIndex((token, index) => !literal.includes(index) && (next === undefined
    ? Object.hasOwn(capabilities, token) : Object.hasOwn(table.nodes[next].commands, token)));
}

/**
 * A forgotten positional of `hop`, the last command of `path`: the token {@link misreadAt} finds
 * among its positionals, but for those typed after a `--` (`literal`, as Invocation.literal), what it
 * was taken for (`open-notebook's <id>`), and the fix, a sentence ending in the line that was meant:
 * `argv`, the line as typed (Invocation.argv, `argvAt` as Invocation.argvAt), options included and
 * a `--url` cut to its origin, with the positionals still needed put in before the token; undefined
 * for none.
 */
function forgottenPositional(table: ApiTable, path: string[], hop: Extract<Hop, { kind: "command" }>,
  literal: number[], argv: string[], argvAt: number[]): { token: string; taken: string; fix: string; named: string[]; literal: number[]; escapable: boolean } | undefined {
  const start = path.length - hop.positionals.length;
  const misread = misreadAt(table, hop.command, hop.positionals, literal.map((index) => index - start));
  if (misread === -1) return undefined;
  const named = path.slice(0, start);
  const needed = positionalArgs(hop.command).slice(misread).map((arg) => `<${arg.name}>`);
  const shown = withUrlOrigin(argv);
  const cut = argvAt[start + misread];
  const line = [`cf-os api ${shellLine(shown.slice(0, cut))}`, ...needed, shellLine(shown.slice(cut))].join(" ");
  const token = hop.positionals[misread];
  return {
    token, taken: `${hop.name}'s ${needed[0]}`, named, literal,
    escapable: holdsWord(positionalArgs(hop.command)[misread], token, table.shapes),
    fix: `${hop.name} needs ${needed.join(" ")} first, as in \`${line}\``,
  };
}

/**
 * Whether `arg` takes `word`, a bare word such as a command name, as itself: a string (one of its
 * choices, if it has them), a JSON argument whose shape admits a string, or a stream's path. Not a
 * number, date, boolean or bytes, which would refuse it.
 */
function holdsWord(arg: ApiArg, word: string, shapes: ApiTable["shapes"]): boolean {
  switch (arg.encoding) {
    case "string":
      return !arg.choices || arg.choices.includes(word);
    case "json":
      return admitsString(arg.shape ?? { kind: "any" }, shapes);
    case "stream":
      return true;
    default:
      return false;
  }
}

/**
 * `tokens`, typed on a line, with each `--url` value cut to its origin, as the CLI uses it (`<url>`
 * for one that is not a URL), so a line shown back never prints credentials or a query in it.
 */
function withUrlOrigin(tokens: string[]): string[] {
  let escaped = false;
  let url = false;
  return tokens.map((token) => {
    const value = url && !isFlag(token);
    url = false;
    if (value) return urlOrigin(token);
    const escapedToken = escaped;
    escaped = !escapedToken && token === "--";
    if (escapedToken) return token;
    if (token === "--url") url = true;
    return token.startsWith("--url=") ? `--url=${urlOrigin(token.slice("--url=".length))}` : token;
  });
}

/** `text`'s origin if it is a URL, else `<url>`. */
function urlOrigin(text: string): string {
  try {
    const { origin } = new URL(text);
    if (origin !== "null") return origin;
  } catch {
    // Not a URL: shown as a placeholder, since it may still hold a secret.
  }
  return "<url>";
}

/** Why a run with `misread`, a forgotten positional of `hop`, sent nothing, and how to fix it. */
function misreadMessage(hop: Extract<Hop, { kind: "command" }>, misread: NonNullable<ReturnType<typeof forgottenPositional>>): string {
  const next = hop.command.returns.kind === "stub" ? `a command of ${hop.command.returns.node}` : "a property of its result";
  return `"${misread.token}" was taken for ${misread.taken}, not as ${next}: nothing was sent. ` +
    `${misread.fix}; ${helpCommand(misread.named, misread.literal)} lists its arguments.`;
}

/**
 * Walks `tokens` -- everything after `cf-os api` but the global options -- against `table`. Throws
 * {@link UsageError} for anything the table does not allow. `--help` stops the walk where it
 * appears.
 */
export function parseInvocation(table: ApiTable, tokens: string[]): Invocation {
  return walk(table, tokens, true);
}

/**
 * {@link parseInvocation}, refusing a forgotten positional where the walk meets it if `refuseMisread`:
 * the line is walked again without that check, so a `--help` later on it still prints the help it
 * reaches, after the error (Invocation.misread).
 */
function walk(table: ApiTable, tokens: string[], refuseMisread: boolean): Invocation {
  const segments: Segment[] = [];
  let current: Segment = { kind: "prefix", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: 0, at: 0 };
  let position: Position = { kind: "node", node: table.root };
  let isPublic = false;
  let escaped = false;
  /** Which tokens of `path`, by index, are positionals typed after a `--` (Invocation.literal). */
  const literal: number[] = [];
  const path: string[] = [];
  /** Where in `tokens` each token of `path` was typed (Invocation.argvAt). */
  const argvAt: number[] = [];
  const hops: Hop[] = [];
  /** What help says of the untyped capability property the chain is on, when it is on one. */
  const about = (): { about?: string } => {
    const [before, property] = hops.slice(-2);
    if (before?.kind !== "command" || property?.kind !== "property") return {};
    const capability = capabilitiesOf(before.command.returns)[property.name]!;
    const at = [...segments, current].find((segment) => segment.hop === before)!.at;
    const text = untypedAbout(before.command, capability, (value) => {
      const positionals = positionalArgs(before.command).map((arg, index) =>
        arg.index === capability.byArgument!.index ? value : before.positionals[index]!);
      return `cf-os api ${typedPath([...path.slice(0, at), ...positionals, property.name], literal)}`;
    });
    return text ? { about: text } : {};
  };
  const helpFor = (): HelpTarget => current.kind === "command"
    ? { kind: "command", node: current.hop!.node, name: current.hop!.name, at: current.at }
    : current.kind === "call" ? { kind: "untyped", at: current.at - 1, ...about() }
    : current.kind === "property" ? (current.node === undefined ? { kind: "untyped", at: current.at, ...about() }
      : { kind: "node", node: current.node, ...position.kind === "node" && position.call ? { call: true as const } : {} })
    : { kind: "node", node: isPublic ? table.public : table.root };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // `--` makes the one token after it an argument or a command, even one that reads as a flag, so
    // a later command's own flags are still flags: `create-gadget -- export export md --chat-id 3`.
    const escapedToken = escaped;
    escaped = false;
    if (!escapedToken && token === "--") {
      escaped = true;
      continue;
    }
    if (!escapedToken && isFlag(token)) {
      const flag = readFlag(tokens, i, current.options, {
        path: path.slice(0, current.at), literal, on: current.kind === "command" ? ` for ${current.hop!.name}` : "",
      });
      if (flag.name === "help") {
        return { public: isPublic, hops, flags: { dryRun: false, answers: [] }, end: { kind: "result", returns: { kind: "call" } }, help: helpFor(), path, literal, argv: tokens, argvAt };
      }
      current.flagTokens.push(flag.token);
      i = flag.end;
      continue;
    }
    // A `call` segment's first positional is its method, even one named `call`.
    const continues = current.kind === "call" ? escapedToken || token !== "call" || current.positionals.length === 0
      : current.positionals.length < current.needed;
    if (continues) {
      if (escapedToken) literal.push(path.length);
      current.positionals.push(token);
      path.push(token);
      argvAt.push(i);
      continue;
    }
    // A positional that names what follows it was most likely meant as that, with the positional
    // forgotten: `open-workspace list-chats get-chat-history 1` would send "list-chats" as the id.
    // One typed after a `--` is taken as typed.
    if (current.kind === "command" && refuseMisread) {
      const misread = forgottenPositional(table, path, current.hop!, literal, tokens, argvAt);
      if (misread) {
        // `--` is offered only where the positional can hold the word: a number cannot.
        const error = new UsageError(`${misreadMessage(current.hop!, misread)}${misread.escapable
          ? ` If "${misread.token}" is meant as ${misread.taken}, put \`--\` before it.` : ""}`);
        let invocation: Invocation;
        try {
          invocation = walk(table, tokens, false);
        } catch {
          throw error;
        }
        if (!invocation.help) throw error;
        return { ...invocation, misread: error.message };
      }
    }
    segments.push(current);
    path.push(token);
    argvAt.push(i);
    if (current.kind === "prefix" && !isPublic && hops.length === 0 && token === "public") {
      isPublic = true;
      position = { kind: "node", node: table.public };
      current = { kind: "prefix", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: 0, at: path.length };
      continue;
    }
    if (position.kind === "result") {
      const capabilities = capabilitiesOf(position.returns);
      const capability = Object.hasOwn(capabilities, token) ? capabilities[token] : undefined;
      if (capability === undefined) {
        const names = Object.keys(capabilities);
        throw new UsageError(names.length > 0
          ? `${position.after} returns a value, which ends the chain, but its ${capabilityNames(names)}: ` +
            `continue with ${names.length === 1 ? `\`${names[0]}\`` : "one of them"}, not "${token}".`
          : `${position.after} returns ${resultNoun(position.returns)}, which ends the chain: nothing can follow it, but "${token}" does.`);
      }
      // The property is read on the result, pipelined: a segment of runtime flags only. One an
      // argument types is on that node, which `call` continues too, as it would the untyped one.
      const returns = propertyReturns(hops.at(-1) as Extract<Hop, { kind: "command" }>, capability);
      const node: string | undefined = returns.kind === "stub" ? returns.node : undefined;
      hops.push({ kind: "property", name: token, property: capability.property, returns });
      current = { kind: "property", node, options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: 0, at: path.length };
      position = node === undefined ? { kind: "untyped" }
        : { kind: "node", node, ...returns === capability.returns ? {} : { call: true as const } };
      continue;
    }
    if (position.kind === "node" && position.call && token === "call" && !Object.hasOwn(table.nodes[position.node].commands, token)) {
      (hops.at(-1) as Extract<Hop, { kind: "property" }>).returns = { kind: "untyped" };
      position = { kind: "untyped" };
    }
    if (position.kind === "untyped") {
      if (token !== "call") {
        const previous = hops.at(-1);
        const reached = previous?.kind === "property" ? `Its \`${previous.name}\` is` : "The previous command returns";
        throw new UsageError(`${reached} an untyped capability: continue with \`call <method> [json-args...]\`, not "${token}".`);
      }
      current = { kind: "call", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: Infinity, at: path.length };
      continue;
    }
    const node: ApiNode = table.nodes[position.node];
    const command: ApiCommand | undefined = Object.hasOwn(node.commands, token) ? node.commands[token] : undefined;
    if (!command) {
      throw new UsageError(`${position.node} has no command "${token}". ${meantCommand(table, position.node, token)}` +
        `Find one with ${SEARCH}, or run ${helpCommand(path.slice(0, -1), literal)} for ${position.node}'s.`);
    }
    const hop: Extract<Hop, { kind: "command" }> = {
      kind: "command", name: token, node: position.node, command, positionals: [], flags: {}, at: path.length,
    };
    current = {
      kind: "command", hop, options: commandOptions(command), flagTokens: [], positionals: hop.positionals,
      needed: positionalArgs(command).length, at: path.length,
    };
    hops.push(hop);
    const returns: ApiReturn = command.returns;
    position = returns.kind === "stub" ? { kind: "node", node: returns.node }
      : returns.kind === "untyped" ? { kind: "untyped" }
      : { kind: "result", after: token, returns };
  }
  segments.push(current);

  if (current.kind === "command" && current.positionals.length < current.needed) {
    const misread = forgottenPositional(table, path, current.hop!, literal, tokens, argvAt);
    if (misread) throw new UsageError(misreadMessage(current.hop!, misread));
    const missing = positionalArgs(current.hop!.command).slice(current.positionals.length).map((arg) => `<${arg.name}>`);
    throw new UsageError(`${current.hop!.name} needs ${missing.join(" ")}. Run ${helpCommand(path, literal)} for its arguments.`);
  }
  if (current.kind === "call" && current.positionals.length === 0) {
    throw new UsageError("call needs a method name: `call <method> [json-args...]`.");
  }

  const runtime: Record<string, string | boolean | string[] | undefined> = {};
  const finalHops: Hop[] = [];
  let hopIndex = 0;
  for (const segment of segments) {
    let values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    try {
      ({ values } = parseArgs({ args: segment.flagTokens, options: segment.options, strict: true, allowPositionals: false, allowNegative: true }));
    } catch (error) {
      throw new UsageError(withHelpPointer((error as Error).message, path.slice(0, segment.at), literal));
    }
    for (const [key, value] of Object.entries(values)) {
      // `--answer` may be given in any segment, and as often as there are methods to answer.
      if (key === "answer") runtime.answer = [...(runtime.answer as string[] | undefined) ?? [], ...value as string[]];
      else if (Object.hasOwn(RUNTIME_OPTIONS, key)) runtime[key] = value as string | boolean;
      else segment.hop!.flags[key] = value as string | boolean;
    }
    if (segment.kind === "command" || segment.kind === "property") finalHops.push(hops[hopIndex++]);
    if (segment.kind === "call") {
      const [method, ...args] = segment.positionals;
      if (method === "") throw new UsageError("call needs a method name: `call <method> [json-args...]`.");
      // capnweb's stub answers these names itself (`then`, `dup`, Object.prototype's), never sending them.
      if (method in RpcPromise.prototype) {
        throw new UsageError(`call ${method}: "${method}" is a built-in of the local stub, not a server method, ` +
          "so `call` cannot send it. Nothing was sent.");
      }
      finalHops.push({ kind: "call", method, args });
    }
  }

  const timeout = timeoutSeconds(runtime.timeout as string | undefined);
  if (runtime.out === "") throw new UsageError("--out needs a file, or - for stdout.");
  const flags: RuntimeFlags = {
    url: runtime.url as string | undefined,
    auth: runtime.auth as string | undefined,
    username: runtime.username as string | undefined,
    dryRun: runtime["dry-run"] === true,
    timeout,
    out: runtime.out as string | undefined,
    answers: (runtime.answer as string[] | undefined) ?? [],
  };
  const end: WalkEnd = position.kind === "node" ? { kind: "node", node: position.node }
    : position.kind === "untyped" ? (current.kind === "call" ? { kind: "result", returns: { kind: "call" } } : { kind: "untyped" })
    : { kind: "result", returns: position.returns };
  // Only bytes have somewhere to go: given with any other result, --out would be silently ignored.
  const returns = end.kind === "result" ? end.returns : undefined;
  if (flags.out !== undefined && returns && returns.kind !== "stream" && !(returns.kind === "value" && returns.bytes)) {
    const last = finalHops.at(-1)!;
    throw new UsageError(`${last.kind === "call" ? `call ${last.method}` : last.name} returns ` +
      `${returns.kind === "call" ? "an untyped value" : resultNoun(returns)}, not bytes: --out applies only to a command that returns bytes.`);
  }
  return { public: isPublic, hops: finalHops, flags, end, path, literal, argv: tokens, argvAt };
}

function wrap(text: string, indent: string, width = 100): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && indent.length + line.length + word.length + 1 > width) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line ? indent + line : "");
  }
  return lines;
}

/**
 * `--url`'s help, saying what the default instance is where the CLI runs (cloudflare-os's dev server,
 * a caller's `CFOS_API_URL`, or none and why), its description starting at `column`.
 */
export function urlHelp(instance: DefaultInstance, column: number): string[] {
  // A caller such as cloudflare-os-starter's `cf-os api` runs this CLI setting CFOS_API_URL or
  // CFOS_API_URL_UNAVAILABLE, so one static line could not be true both here and there.
  const text = instance.kind === "unavailable"
    ? `the instance; http:// only for a local dev server. No default here: ${instance.reason}`
    : instance.from === "CFOS_API_URL"
    ? `the instance (${shownOrigin(instance.url)}); http:// only for a local dev server`
    : `the instance (default: ${DEV_SERVER_URL}, where \`pnpm dev-server\` listens; CFOS_API_URL names another); ` +
      "http:// only for a local dev server";
  const indent = " ".repeat(column);
  const [first, ...rest] = wrap(text, indent);
  return [`${"  --url <origin>".padEnd(column)}${first.slice(column)}`, ...rest];
}

/**
 * `CFOS_API_URL`'s default for the help: its origin alone, as the CLI uses it, so credentials or a
 * query in the variable are never printed.
 */
function shownOrigin(url: string): string {
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch {
    // Not a URL: shown as no default, a run then failing with the variable's name.
  }
  return origin === undefined || origin === "null" ? "no default: CFOS_API_URL, which is not a URL"
    : `default: ${origin}, from CFOS_API_URL`;
}

/** {@link firstSentence}, cut to fit a help listing. */
function summary(doc: string): string {
  const sentence = firstSentence(doc);
  return sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence;
}

/** The placeholder of a JSON argument that admits a string, whose text {@link TEXT_RULE} explains. */
const TEXT_PLACEHOLDER = "<text|json|@file|->";

/** How a {@link TEXT_PLACEHOLDER} argument is read, as codec.ts decodeValue reads it. */
const TEXT_RULE = `${TEXT_PLACEHOLDER}: JSON, inline, from @file or from - (stdin). Text that is not JSON is that ` +
  "string, less a file's or stdin's final line ending, even text that starts with {, [ or \" ('[draft] hello'). " +
  "Text that starts with @, is - or is JSON (42, true) is quoted as a JSON string ('\"@alice\"'). " +
  "An empty file or stdin is refused; inline '' is the empty string.";

/** How a plain string argument is read, as codec.ts decodeArg reads it: the help of a command with one says so. */
const STRING_RULE = "A string is taken as typed: @, - and quotes are part of it ('\"@x\"' sends the quotes too), " +
  "so a model id goes as list-models prints it (@cf/...). For a file's text, let the shell read it: \"$(cat file)\". " +
  "Where it admits null, the bare null is null.";

/** Whether `arg` is a plain string, which {@link STRING_RULE} describes. */
function isPlainString(arg: ApiArg): boolean {
  return arg.encoding === "string" && !arg.choices;
}

function placeholder(arg: ApiArg, shapes: ApiTable["shapes"]): string {
  if (arg.choices) return arg.choices.join("|");
  switch (arg.encoding) {
    case "date":
      return "<iso-date>";
    case "bytes":
      return "<@file|-|json>";
    case "json":
      return arg.shape && admitsString(arg.shape, shapes) ? TEXT_PLACEHOLDER : "<json|@file|->";
    case "stream":
      return "<@file|->";
    default:
      return `<${arg.flag ? arg.encoding : arg.name}>`;
  }
}

function synopsis(command: ApiCommand, shapes: ApiTable["shapes"]): string {
  return [
    ...positionalArgs(command).map((arg) => `<${arg.name}>`),
    ...command.args.filter((arg) => arg.flag).map((arg) =>
      arg.encoding === "boolean" ? `[--${arg.flag}]` : `[--${arg.flag} ${placeholder(arg, shapes)}]`),
  ].join(" ");
}

function table2(rows: [string, string][]): string[] {
  const width = Math.min(Math.max(...rows.map(([left]) => left.length)), 36);
  return rows.flatMap(([left, right]) => left.length > width
    ? [`  ${left}`, ...right ? [`  ${" ".repeat(width)}  ${right}`] : []]
    : [`  ${left.padEnd(width)}  ${right}`.trimEnd()]);
}

/**
 * What a listing shows after a command that does not end the chain: where it leads (`→ Overseer`),
 * or, for a value holding capabilities, where each of them does (`→ ui: call`).
 */
function leadsTo(command: ApiCommand): string {
  const { returns } = command;
  if (returns.kind === "value" && returns.capabilities) {
    return ` → ${Object.entries(returns.capabilities).map(([name, capability]) => `${name}: ${capabilityTarget(command, capability)}`).join(", ")}`;
  }
  return returns.kind === "stub" || returns.kind === "untyped" ? ` → ${target(returns)}` : "";
}

/** Where a capability property of `command`'s result leads, in a listing: by an argument, `A, B by <id>, else call`. */
function capabilityTarget(command: ApiCommand, capability: ApiCapabilityProperty): string {
  const by = capability.byArgument;
  if (!by) return target(capability.returns);
  return `${Object.values(by.nodes).join(", ")} by ${byArgumentName(command, by)}, else ${target(capability.returns)}`;
}

/** Where a capability leads, in a listing: its node, or `call` for an untyped one. */
function target(returns: ApiCapabilityProperty["returns"]): string {
  return returns.kind === "stub" ? returns.node : "call";
}

/**
 * How to go on to each capability property of a chain's value result, `hop`'s, the chain typed as
 * `path`.
 */
function propertyLines(hop: Extract<Hop, { kind: "command" }>, path: string[]): string[] {
  return Object.entries(capabilitiesOf(hop.command.returns)).map(([name, capability]) => `cf-os api ${typedPath([...path, name])} ` +
    (propertyReturns(hop, capability).kind === "stub" ? "<command>" : "call <method> [json-args...]"));
}

/** `tokens` as a shell would need them typed. */
function shellLine(tokens: string[]): string {
  return tokens.map((token) => /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`).join(" ");
}

/**
 * A command of `node` to show as the way to finish a chain on it: one that reads a value and takes
 * no arguments (`get-metadata`), since whoever is told it may well run it as it is. None when the
 * names promise no such read.
 */
function exampleCommand(table: ApiTable, node: string): string | undefined {
  return Object.entries(table.nodes[node].commands).find(([name, command]) => /^(get|list)-/.test(name) &&
    positionalArgs(command).length === 0 && command.returns.kind === "value" &&
    !command.args.some((arg) => arg.encoding === "callback" || arg.encoding === "function"))?.[0];
}

/**
 * Why a walk that stopped on a capability ran nothing, and how to finish it: the message of the
 * usage error for `cf-os api new-workspace`, which an agent might otherwise take for a call made.
 */
export function incompleteChain(table: ApiTable, invocation: Invocation): string {
  const { end, path, literal = [], argv, argvAt } = invocation;
  const hop = invocation.hops.at(-1);
  const typed = `cf-os api ${typedPath(path, literal)}`.trimEnd();
  const help = helpCommand(path, literal);
  if (!hop || hop.kind === "call") {
    return `${typed} names no command, so nothing was sent. Find one with ${SEARCH}; ${help} lists them.`;
  }
  // A property hop is read on the command before it.
  const reached = hop.kind === "property"
    ? `${(invocation.hops.at(-2) as Extract<Hop, { kind: "command" }>).name}'s \`${hop.name}\` is`
    : `${hop.name} returns`;
  if (end.kind === "untyped") {
    return `${reached} an untyped capability, so the chain goes on: nothing was sent. ` +
      `Finish it with \`call <method> [json-args...]\`, as in \`${typed} call <method>\`; ${help} says more.`;
  }
  const node = (end as { node: string }).node;
  const misread = hop.kind === "command" ? forgottenPositional(table, path, hop, literal, argv, argvAt) : undefined;
  if (misread) {
    return `"${misread.token}" was taken for ${misread.taken}, not as a command of ${node}, ` +
      `so the chain goes on: nothing was sent. ${misread.fix}; ${helpCommand(misread.named, literal)} lists ${node}'s commands.`;
  }
  const example = exampleCommand(table, node);
  return `${reached} a capability (${node}), so the chain goes on: nothing was sent. ` +
    `Finish it with one of ${node}'s commands${example ? `, as in \`${typed} ${example}\`` : ""}; ` +
    `${help} lists them.`;
}

/**
 * `node`'s commands, one line each, after what the `→` marks mean when any of them carries one. The
 * listing of a capability's help, and of the help of a command that returns one.
 */
function nodeCommandLines(table: ApiTable, node: string): string[] {
  const commands = Object.values(table.nodes[node].commands);
  return [
    ...commands.some((command) => command.returns.kind === "stub") ? [
      "A command marked `→ X` returns capability X: follow it on the same line with one of X's commands.",
      "On its own it sends nothing.",
    ] : [],
    ...commands.some((command) => command.returns.kind === "untyped") ? [
      "One marked `→ call` returns an untyped capability, finished with `call <method> [json-args...]`.",
    ] : [],
    ...commands.some((command) => command.returns.kind === "value" && command.returns.capabilities) ? [
      "One marked `→ p: X` prints a value whose property p is capability X; to use that, follow it on",
      "the same line with `p` and one of X's commands (`call <method> [json-args...]` for `p: call`).",
    ] : [],
    ...commands.some((command) => Object.values(capabilitiesOf(command.returns)).some((capability) => capability.byArgument)) ? [
      "`p: v:X, ... by <a>, else call` is capability v:X when argument <a> is v, else untyped.",
    ] : [],
    ...commands.some(leadsTo) ? [""] : [],
    ...table2(Object.entries(table.nodes[node].commands).map(([name, command]) => [
      `${name} ${positionalArgs(command).map((arg) => `<${arg.name}>`).join(" ")}`.trim() + leadsTo(command),
      summary(command.doc),
    ])),
  ];
}

/** What `cf-os api --help` opens with: how an agent finds a command without walking the help. */
const AGENT_BANNER = [
  "AGENTS: do not walk the commands with --help. Find the one for a task with",
  '  cf-os api search "<describe the task>"',
  "which prints the five best matches as JSON, each a whole command line; then run `<command> --help`.",
];

/**
 * Help for capability `node`, reached by `path` (`public` alone for `PublicApi`). The root's lists
 * the API options, `--url`'s line saying what `instance`, the default instance, is.
 */
export function nodeHelp(table: ApiTable, node: string, path: string[], instance: DefaultInstance = defaultInstance({}),
  call = false): string {
  const entry = table.nodes[node];
  const prefix = ["cf-os", "api", ...path].join(" ");
  const isRoot = path.length === 0;
  return [
    ...isRoot ? [...AGENT_BANNER, ""] : [],
    `Usage: ${prefix} <command> [arguments] [options]`,
    "",
    ...entry.doc ? [...wrap(entry.doc, ""), ""] : [],
    `Commands on ${node}${isRoot ? ", after signing in" : ""}:`,
    ...nodeCommandLines(table, node),
    // A capability an argument typed (ApiByArgument) is the untyped one, which `call` still calls.
    ...call ? ["", ...wrap(`\`${prefix} call <method> [json-args...]\` also calls one of its methods by name, unchecked.`, "")] : [],
    ...isRoot ? [
      "", `\`cf-os api public <command>\` calls ${table.public} without signing in (run \`cf-os api public --help\`).`,
      "`cf-os api types [<service>]` prints the API as TypeScript declarations, to write code against.",
      `\`cf-os api ${CREATE_ACCOUNT} <username>\` creates a user to act as with --username, on a local or test instance.`,
    ] : [],
    "",
    `Run \`${prefix} <command> --help\` for a command's arguments.`,
    "",
    ...isRoot ? ["API options:", ...urlHelp(instance, 23), ...RUNTIME_HELP] : [RUNTIME_HELP_POINTER],
  ].join("\n");
}

function describeArg(arg: ApiArg): string {
  return [arg.type, arg.doc].filter(Boolean).join(". ");
}

/**
 * An argument's help row, then a row under it for each documented named type it is declared as, and
 * one naming the secrets it may hold.
 */
function argRows(label: string, description: string, arg: ApiArg): [string, string][] {
  return [[label, description], ...Object.entries(arg.typeDocs ?? {}).map(([type, doc]): [string, string] =>
    ["", `${type}: ${doc}`]), ...arg.secrets ? [["", secretsHelp(arg.secrets)] as [string, string]] : []];
}

/** What help says of an argument holding secrets: where they are, and how to keep them out of argv and dry runs. */
function secretsHelp(paths: SecretPath[]): string {
  // A whole secret value is the one path: none is kept inside another.
  if (paths.some((path) => path.length === 0)) {
    return 'Secret: --dry-run prints {"$secret": true} in its place; @file or - keeps it off the command line.';
  }
  return `Secrets in it: ${paths.map((path) => path.join(".")).join(", ")}. --dry-run prints {"$secret": true} ` +
    "in their place; @file or - keeps them off the command line.";
}

/** What help says of a command that reports the id of what it creates, `node` being what it returns. */
function reportsIdHelp(table: ApiTable, node: string, { noun, method, property }: ApiReportsId): string {
  const read = Object.entries(table.nodes[node].commands).find(([, command]) => command.method === method)?.[0] ?? method;
  return `It also prints \`Created ${noun} <${property}>.\` on stderr, read with \`${read}\` on the result beside ` +
    "the chain, even when a later command of the chain fails: a chain that goes on past it does not lose what it made.";
}

/**
 * Help for command `name` on capability `node`, reached by `path`: `name` is its `at`th token, and
 * any after it are the positionals typed so far, those at the indexes in `literal` after a `--`
 * (Invocation.literal).
 */
export function commandHelp(table: ApiTable, node: string, name: string, path: string[], at = path.lastIndexOf(name) + 1,
  literal: number[] = []): string {
  const command = table.nodes[node].commands[name];
  // A callback method returning nothing is an event; one returning a value is answered (--answer).
  // Each argument's rows are one table, as each is one interface.
  const callbacks = command.args.filter((arg) => arg.encoding === "callback" || arg.encoding === "function");
  const events = callbacks.map((arg): [string, string][] => arg.encoding === "function"
    ? [[`${arg.name}(${(arg.params ?? []).join(", ")})`, arg.doc]]
    : table.callbacks[arg.callback!].methods.filter((method) => !method.answer)
      .map((method) => [`${method.name}(${method.params.join(", ")})`, summary(method.doc)])).filter((rows) => rows.length);
  const answers = callbacks.map((arg): [string, string][] => arg.encoding === "function" ? []
    : table.callbacks[arg.callback!].methods.flatMap((method): [string, string][] => method.answer
      ? [[`${arg.callback}.${method.name}(${method.params.join(", ")})`, `returns ${method.answer.type}`]] : [])).filter((rows) => rows.length);
  const flags = command.args.filter((arg) => arg.flag);
  const positionals = positionalArgs(command);
  const next = command.returns.kind === "stub" ? command.returns.node : undefined;
  const capabilities = capabilitiesOf(command.returns);
  // A command of the next capability typed where a positional goes (`open-workspace new-chat --help`),
  // or a capability property of the result (`get-gatekeeper-app ui --help`), was taken for that
  // positional; this help is not the one meant, so it says which is.
  const typed = path.slice(at);
  const misread = misreadAt(table, command, typed, literal.map((index) => index - at));
  const asTyped = misread === -1 ? typed.length : misread;
  /** This command's line, the positionals typed before `kept` as typed and the rest as placeholders. */
  const line = (kept: number) => ["cf-os api", typedPath(path.slice(0, at + kept), literal),
    ...positionals.slice(kept).map((arg) => `<${arg.name}>`)].filter(Boolean).join(" ");
  return [
    ...misread === -1 ? [] : [
      `"${typed[misread]}" was taken for ${name}'s <${positionals[misread]!.name}>, not as ${next === undefined ? "a property of its result" : "a command"}. For its help, run:`,
      `  ${line(misread)} ${typed[misread]} --help`,
      "",
    ],
    `Usage: ${["cf-os api", typedPath(path.slice(0, at), literal), synopsis(command, table.shapes)].filter(Boolean).join(" ")}`,
    "",
    `${node}.${command.method}`,
    ...command.doc ? ["", ...wrap(command.doc, "")] : [],
    ...positionals.length ? ["", "Arguments:", ...table2(positionals.flatMap((arg) => argRows(`<${arg.name}>`, `${placeholder(arg, table.shapes) === `<${arg.name}>` ? "" : `${placeholder(arg, table.shapes)}: `}${describeArg(arg)}`, arg)))] : [],
    ...flags.length ? ["", "Options:", ...table2(flags.flatMap((arg) => argRows(
      arg.encoding === "boolean" ? `--${arg.flag}, --no-${arg.flag}` : `--${arg.flag} ${placeholder(arg, table.shapes)}`,
      describeArg(arg), arg)))] : [],
    ...command.args.some(isPlainString) ? ["", ...wrap(STRING_RULE, "")] : [],
    ...command.args.some((arg) => placeholder(arg, table.shapes) === TEXT_PLACEHOLDER) ? ["", ...wrap(TEXT_RULE, "")] : [],
    ...events.length ? ["", 'Events (one JSON line each, {"event": <name>, "args": {<parameter>: <value>}}):', ...events.flatMap(table2)] : [],
    ...answers.length ? ["", ...wrap("Answers (the server may ask; give each with --answer '<name>=<json|@file|->', which answers " +
      "its first call; otherwise the call fails, exit 2, saying what it asked):", ""), ...answers.flatMap(table2)] : [],
    "",
    ...wrap(`Returns ${describeReturn(command.returns)}.${command.nullWhen ? ` It is null when ${command.nullWhen}.` : ""}`, ""),
    ...command.reportsId && next ? wrap(reportsIdHelp(table, next, command.reportsId), "") : [],
    ...next ? [
      "", `Then, on ${next}:`, ...nodeCommandLines(table, next),
      "", `Run \`${line(asTyped)} <command> --help\` for one's arguments.`,
    ] : [],
    // Each capability the printed value holds, which the chain may go on to by naming it: on the
    // node an argument typed as given types it as, if one does.
    ...Object.entries(capabilities).flatMap(([property, capability]) => {
      const reached = capability.returns.kind === "stub" ? capability.returns.node
        : capability.byArgument && typedBy(command, capability.byArgument, typed.slice(0, asTyped));
      return reached !== undefined ? [
        "", `Then, on its \`${property}\` (${reached}):`, ...nodeCommandLines(table, reached),
        "", `Run \`${line(asTyped)} ${property} <command> --help\` for one's arguments.`,
      ] : [
        "", `Then, on its \`${property}\`, an untyped capability, whose methods \`call\` invokes by name, unchecked:`,
        `  ${line(asTyped)} ${property} call <method> [json-args...]`,
        ...[untypedAbout(command, capability, (value) =>
          `cf-os api ${typedPath([...path.slice(0, at), ...positionals.map((arg, index) =>
            arg.index === capability.byArgument!.index ? value : index < asTyped ? typed[index]! : `<${arg.name}>`), property], literal)}`)]
          .flatMap((about) => about ? ["", ...wrap(about, "")] : []),
      ];
    }),
    "",
    RUNTIME_HELP_POINTER,
  ].join("\n");
}

/**
 * Help for an untyped capability, reached by `path`, with what the table says of it (`about`,
 * HelpTarget's).
 */
export function untypedHelp(path: string[], about?: string): string {
  return [
    `Usage: ${["cf-os", "api", ...path].join(" ")} call <method> [json-args...]`,
    "",
    ...about ? [...wrap(about, ""), ""] : [],
    "An untyped capability: the API does not say what it offers. `call` invokes a method by name, each",
    "argument JSON, inline, from @file or from - (stdin); text that is not JSON is passed as that string",
    "(less a file's or stdin's final line ending), but text that starts with {, [ or \" and does not parse",
    "is refused, as is an empty file or stdin. Text that starts with @, is -, is JSON or starts as JSON is",
    "quoted as a JSON string ('\"@alice\"').",
    "Nothing else is checked. A name the local stub answers itself (then, toString, ...) is refused.",
    "",
    RUNTIME_HELP_POINTER,
  ].join("\n");
}

/** One match of `cf-os api search`. */
export interface SearchMatch {
  /** The whole command line, from `cf-os api`, a placeholder for each positional along the way. */
  command: string;
  /** The first sentence of its doc, whole. */
  summary: string;
}

/** Words a task is described with that pick out no command. */
const STOP_WORDS = new Set(["a", "an", "and", "all", "by", "for", "from", "i", "in", "into", "it", "its", "me",
  "my", "of", "on", "or", "the", "this", "to", "with"]);

/** Stems that mean the same to a search: the API's verbs for creating something all say `new`. */
const SAME_TERM: Record<string, string> = { add: "new", creat: "new", mak: "new" };

/** `text`'s words, lowercased and crudely stemmed, so `chats` meets `chat` and `starts` `start`. */
function searchTerms(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean).map((word) => {
    let stem = word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ss") ? word : word.replace(/s$/, "");
    if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
    else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
    if (stem.length > 3) stem = stem.replace(/e$/, "");
    return stem;
  });
}

/**
 * How well `term` matches `words`: 1 when they hold it, a little less when they hold a word
 * {@link SAME_TERM} folds together with it (`add` and `new-gatekeeper`), so the verb a task names
 * outranks its synonyms.
 */
function termMatch(term: string, words: Set<string>): number {
  if (words.has(term)) return 1;
  const folded = SAME_TERM[term] ?? term;
  return [...words].some((word) => (SAME_TERM[word] ?? word) === folded) ? 0.75 : 0;
}

/**
 * What a search finds beside the table's commands: `create-account`, and signing in as a user, which
 * is runtime flags, in no command's doc. `words` score as a command's name does, and the summary as
 * a doc does, so broad words (`user`, `test`) are left to the summary and outrank no command named
 * by them. `phrase` scores as `words` too, but only for a task that says it, its words in a row (or
 * their synonyms), but for stop words: "create a user" names create-account; "user" alone, or
 * "create a workspace for a user", does not.
 */
const BUILT_INS: { command: string; words: string; phrase?: string; summary: string }[] = [
  {
    command: `cf-os api ${CREATE_ACCOUNT} <username>`,
    words: `${CREATE_ACCOUNT} signup up register`,
    phrase: "create user",
    summary: "Creates a password user account to act as, on a local or test instance; the password comes from CFOS_API_PASSWORD.",
  },
  {
    command: `cf-os api --url ${DEV_SERVER_URL} --username <username> <command>`,
    words: "sign-in log-in login act-as user local dev server localhost",
    summary: "Runs <command> signed in as <username>, the password from CFOS_API_PASSWORD, here on a local dev server " +
      "(cloudflare-os's `pnpm dev-server`).",
  },
];

/**
 * The words a command's arguments add to its doc's first sentence for a search of `terms`, each
 * with what it scores: each callback method the server may ask it to answer, as
 * `<Callback>.<method>` (`ObserverConfigCallback.configure` on `open-workspace`), its words 2 each
 * as a doc's are, and the name of each option the task names whole, so a task worded after either
 * finds it. An option counts only whole but for its stop words, and scores 2 in all, as one word of
 * a doc does, as its words are incidental to what the command does: `--binding-name` makes
 * create-gadget no command about bindings, nor `--chat-id` one about chats (under list-chats, named
 * by "chat"), but "copy secrets" finds add-model by its `--copy-secrets-from`.
 */
function argumentWords(table: ApiTable, command: ApiCommand, terms: string[]): Map<string, number> {
  const words = new Map<string, number>();
  const add = (word: string, weight: number) => words.set(word, Math.max(words.get(word) ?? 0, weight));
  for (const arg of command.args) {
    const option = arg.flag ? searchTerms(arg.name).filter((word) => !STOP_WORDS.has(word)) : [];
    if (option.every((word) => terms.some((term) => termMatch(term, new Set([word])) > 0))) {
      for (const word of option) add(word, 2 / option.length);
    }
    if (arg.encoding !== "callback") continue;
    for (const method of table.callbacks[arg.callback!].methods.filter((asked) => asked.answer)) {
      for (const word of searchTerms(`${arg.callback}.${method.name}`)) add(word, 2);
    }
  }
  return words;
}

/**
 * The commands that best match `query`, best first, at most `limit`. A query word scores where it
 * best matches (three quarters as well for a synonym): 3 in the command's own name, 2 in its doc's
 * first sentence, what {@link argumentWords} says, 1 in the hops that lead to it or the first
 * sentence of the capability it is on; a {@link BUILT_INS} entry scores as a command whose name is
 * its words, and wins a tie, as no doc names what it does. Other ties go to the command whose own name and doc
 * say more of the task's words, as the hops before it say what it acts on, not what it does, then
 * to the shorter command line. A method several capabilities inherit, one name and one first
 * sentence on each, ties with itself on all of these, and only where it sits tells its copies
 * apart: they keep the places they share, the one whose hops and capability say more of the task's
 * words first ("remove a gatekeeper" finds a gatekeeper's remove before a gadget's). Local and
 * deterministic: it reads the table, nothing else.
 */
export function searchCommands(table: ApiTable, query: string, limit = 5): SearchMatch[] {
  const terms = [...new Set(searchTerms(query))].filter((term) => !STOP_WORDS.has(term));
  const matches: (SearchMatch & { score: number; said: number; copies?: string; placed?: number; builtIn?: true })[] = [];
  for (const builtIn of BUILT_INS) {
    const own = new Set(searchTerms(builtIn.words));
    const phrase = searchTerms(builtIn.phrase ?? "");
    if (phrase.length > 0 && terms.some((_, at) => phrase.every((word, index) =>
      at + index < terms.length && termMatch(terms[at + index], new Set([word])) > 0))) {
      for (const word of phrase) own.add(word);
    }
    const said = new Set(searchTerms(builtIn.summary));
    const score = terms.reduce((total, term) => total + Math.max(3 * termMatch(term, own), 2 * termMatch(term, said)), 0);
    if (score > 0) matches.push({ command: builtIn.command, summary: builtIn.summary, score, said: 0, builtIn: true });
  }
  for (const [node, segments] of nodePrefixes(table)) {
    // The hops' words, and the value of an argument that types the node, but no placeholder's.
    const hopWords = segments.filter((segment) => !segment.startsWith("<")).join(" ");
    const around = new Set(searchTerms(`${hopWords} ${node} ${firstSentence(table.nodes[node].doc)}`));
    for (const [name, command] of Object.entries(table.nodes[node].commands)) {
      const own = new Set(searchTerms(`${name} ${command.method}`));
      const said = new Set(searchTerms(firstSentence(command.doc)));
      const argued = [...argumentWords(table, command, terms)];
      const argument = (term: string) => Math.max(0, ...argued.map(([word, weight]) => weight * termMatch(term, new Set([word]))));
      const score = terms.reduce((total, term) => total +
        Math.max(3 * termMatch(term, own), 2 * termMatch(term, said), argument(term), termMatch(term, around)), 0);
      if (score === 0) continue;
      const line = ["cf-os", "api", ...segments, name, ...positionalArgs(command).map((arg) => `<${arg.name}>`)].join(" ");
      const saying = terms.filter((term) => termMatch(term, own) > 0 || termMatch(term, said) > 0).length;
      const placed = terms.filter((term) => termMatch(term, around) > 0).length;
      const copies = JSON.stringify([name, command.method, firstSentence(command.doc), score, saying]);
      matches.push({ command: line, summary: firstSentence(command.doc), score, said: saying, copies, placed });
    }
  }
  const ranked = matches.toSorted((a, b) => b.score - a.score || Number(b.builtIn ?? false) - Number(a.builtIn ?? false) ||
    b.said - a.said || a.command.length - b.command.length);
  const places = Map.groupBy(ranked.keys(), (at) => ranked[at].copies);
  for (const [copies, at] of places) {
    if (copies === undefined || at.length < 2) continue;
    const placed = at.map((index) => ranked[index]).toSorted((a, b) => b.placed! - a.placed!);
    // Its copies' shared places, reordered among them by what their hops and capability say.
    at.forEach((index, which) => ranked[index] = placed[which]);
  }
  return ranked.slice(0, limit).map(({ command, summary: said }) => ({ command, summary: said }));
}

/** Help for `cf-os api search`. */
export function searchHelp(): string {
  return [
    'Usage: cf-os api search "<describe the task>"',
    "",
    'The five commands that best match the task, as JSON on stdout: [{"command", "summary"}], each',
    "command a whole line from `cf-os api`, with a placeholder for every argument it needs. Run",
    "`<command> --help` for its arguments. It reads the command table only: it connects to nothing.",
  ].join("\n");
}

/**
 * The query when `tokens` -- everything after `cf-os api` but the global options -- are a search
 * (`search` is the first word that is not an option), else undefined. Runtime options are accepted
 * and ignored, as a search connects to nothing; `help` is true for `--help`.
 */
export function parseSearch(tokens: string[]): { query: string; help: boolean } | undefined {
  if (commandWord(tokens, RUNTIME_OPTIONS) !== "search") return undefined;
  const { values, positionals } = parseSegment(tokens, RUNTIME_OPTIONS, "search");
  return { query: positionals.slice(1).join(" "), help: values.help === true };
}

/**
 * The service when `tokens` -- everything after `cf-os api` but the global options -- ask for the
 * agent declarations (`types` is the first word that is not an option), else undefined. Runtime
 * options are accepted and ignored, as for a search; `help` is true for `--help`.
 */
export function parseTypes(tokens: string[]): { service?: string; help: boolean } | undefined {
  if (commandWord(tokens, RUNTIME_OPTIONS) !== "types") return undefined;
  const parsed = parseSegment(tokens, RUNTIME_OPTIONS, "types");
  const [, service, extra] = parsed.positionals;
  if (extra !== undefined) {
    throw new UsageError(`types takes one service, but "${extra}" follows "${service}". Run \`cf-os api types --help\`.`);
  }
  return { service, help: parsed.values.help === true };
}

/** A `callback` or `function` argument, minted when the call is made. */
class CallbackArg {
  readonly arg: ApiArg;
  constructor(arg: ApiArg) {
    this.arg = arg;
  }
}

/** One call of the chain, its arguments decoded, or a property read on the previous call's result. */
export interface Call {
  /** The method called, or the property read. */
  method: string;
  /** Decoded arguments, trailing `undefined`s trimmed. Streams and callbacks are placeholders. */
  args: unknown[];
  /** What it returns; `call` for an untyped call. */
  returns: ApiReturn | { kind: "call" };
  /** A property read, pipelined on the previous call's result: no call, and no arguments. */
  property?: true;
  /** The secrets its arguments may hold, by argument index ({@link ApiArg.secrets}), for `--dry-run`. */
  secrets?: Map<number, SecretPath[]>;
  /** How to report the id of what it creates ({@link ApiCommand.reportsId}). */
  reportsId?: ApiReportsId;
}

/** What {@link decodeCalls} decodes: the chain's calls, and the `--answer`s by `<Callback>.<method>`. */
export interface Decoded {
  calls: Call[];
  /** Each answer's value, checked and revived against its method's result shape. */
  answers: Map<string, unknown>;
  /** The secrets each answer may hold, by the same key, for `--dry-run`. */
  answerSecrets: Map<string, SecretPath[]>;
}

/**
 * The chain's calls, every argument decoded from its tokens (files and stdin read), and its
 * `--answer`s, each decoded as the JSON its callback method returns. Before connecting, so a bad
 * one sends nothing.
 */
export async function decodeCalls(table: ApiTable, invocation: Invocation, source: ArgSource): Promise<Decoded> {
  const calls: Call[] = [];
  let stdinUsed = false;
  const guarded: ArgSource = {
    readFile: (path) => source.readFile(path),
    checkFile: (path, typed) => source.checkFile(path, typed),
    readStdin: () => {
      if (stdinUsed) throw new UsageError("Only one argument can read stdin (-).");
      stdinUsed = true;
      return source.readStdin();
    },
  };
  for (const hop of invocation.hops) {
    if (hop.kind === "call") {
      const args: unknown[] = [];
      for (const [index, token] of hop.args.entries()) {
        args.push(await decodeUntyped(token, guarded, `call ${hop.method} argument ${index + 1}`));
      }
      calls.push({ method: hop.method, args, returns: { kind: "call" } });
      continue;
    }
    if (hop.kind === "property") {
      calls.push({ method: hop.property, args: [], returns: hop.returns, property: true });
      continue;
    }
    const args: unknown[] = [];
    const secrets = new Map(hop.command.args.flatMap((arg) => arg.secrets ? [[arg.index, arg.secrets] as const] : []));
    let next = 0;
    for (const arg of hop.command.args) {
      if (arg.encoding === "callback" || arg.encoding === "function") {
        if (!arg.flag) args[arg.index] = new CallbackArg(arg);
        continue;
      }
      const token = arg.flag ? hop.flags[arg.flag] : hop.positionals[next++];
      if (token === undefined) continue;
      if (arg.encoding === "stream" && token === "-") {
        if (stdinUsed) throw new UsageError("Only one argument can read stdin (-).");
        stdinUsed = true;
      }
      args[arg.index] = await decodeArg(arg, token, table.shapes, guarded);
    }
    while (args.length && args.at(-1) === undefined) args.pop();
    calls.push({
      method: hop.command.method, args: Array.from(args), returns: hop.command.returns, ...secrets.size ? { secrets } : {},
      ...hop.command.reportsId ? { reportsId: hop.command.reportsId } : {},
    });
  }
  const answers = new Map<string, unknown>();
  const answerSecrets = new Map<string, SecretPath[]>();
  for (const raw of invocation.flags.answers) {
    // A gatekeeper app UI's callback is named after its vendor: `context:Decision.accept`.
    const match = /^((?:[a-z0-9_]+:)?[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)=([^]*)$/.exec(raw);
    if (!match) throw new UsageError(`--answer needs <Callback>.<method>=<json|@file|->; got "${raw}".`);
    const [, callback, name, value] = match;
    const key = `${callback}.${name}`;
    const method = Object.hasOwn(table.callbacks, callback)
      ? table.callbacks[callback].methods.find((candidate) => candidate.name === name) : undefined;
    if (!method?.answer) {
      const keys = Object.entries(table.callbacks).flatMap(([interfaceName, entry]) =>
        entry.methods.filter((candidate) => candidate.answer).map((candidate) => `${interfaceName}.${candidate.name}`));
      throw new UsageError(`--answer ${key}: no callback method of the API by that name returns a value` +
        (keys.length ? `. Those that do: ${keys.join(", ")}.` : ", and none does."));
    }
    if (answers.has(key)) throw new UsageError(`--answer ${key} is given twice.`);
    answers.set(key, await decodeJson(value, method.answer.shape, table.shapes, guarded, `--answer ${key}`));
    if (method.answer.secrets) answerSecrets.set(key, method.answer.secrets);
  }
  return { calls, answers, answerSecrets };
}

/** One entry of {@link dryRunChain}. */
export type DryRunCall =
  | { method: string; args: unknown[]; reportsId?: { method: string; property: string } }
  | { property: string };

/**
 * The chain as `--dry-run` prints it: methods and JSON-encoded arguments, and the properties read,
 * nothing secret: what the table marks secret in an argument is `{"$secret": true}`
 * ({@link redactSecrets}). A call that reports the id of what it creates says, in `reportsId`, the
 * method also called on its result, beside the chain, and the property of that call's result read.
 */
export function dryRunChain(calls: Call[]): DryRunCall[] {
  return calls.map((call) => call.property ? { property: call.method } : {
    method: call.method,
    args: call.args.map((arg, index) => arg instanceof CallbackArg
      ? { [arg.arg.encoding === "function" ? "$function" : "$callback"]: arg.arg.callback ?? arg.arg.name }
      : arg instanceof StreamArg ? { $stream: arg.path }
      : encodeValue(redactSecrets(arg, call.secrets?.get(index) ?? []))),
    ...call.reportsId ? { reportsId: { method: call.reportsId.method, property: call.reportsId.property } } : {},
  });
}

/** The `--answer`s as `--dry-run` prints them, by key, JSON-encoded, their secrets redacted as the chain's are. */
export function dryRunAnswers({ answers, answerSecrets }: Decoded): Record<string, unknown> {
  return Object.fromEntries([...answers].map(([key, value]) =>
    [key, encodeValue(redactSecrets(value, answerSecrets.get(key) ?? []))]));
}

/** What running the chain needs beyond the session. */
export interface RunIo {
  /** Results (JSON on stdout) and messages (stderr). */
  out: Output;
  /** Raw stdout, for NDJSON events and stream bytes. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  /** A stream argument's bytes: a file, resolved against where the command was run, or `-`. */
  openStream(path: string): ReadableStream<Uint8Array>;
  /** Where `--out <file>` writes, resolved against where the command was run. */
  outputPath(path: string): string;
  /** Calls `listener` on SIGINT; returns the function that stops listening. */
  onInterrupt(listener: () => void): () => void;
}

/** Thrown when `--timeout` runs out for a command that is not a subscription. */
class TimedOut extends Error {}

/** Thrown when SIGINT stops the run. */
class Interrupted extends Error {}

/** Thrown when whoever reads stdout has gone (EPIPE): nothing more can be printed. */
class Closed extends Error {}

/** Thrown when the server called a callback method for an answer the run refused (`--answer`). */
class Unanswered extends Error {}

/** A callback call the run refused to answer: its arguments, encoded, and whether an answer was used up. */
interface Refused {
  key: string;
  args: Record<string, unknown>;
  again: boolean;
}

/** What a refused call asked and how to answer it: the message of the run's usage error. */
function refusedMessage(table: ApiTable, refused: Refused): string {
  const [callback, method] = refused.key.split(".");
  const type = table.callbacks[callback].methods.find((candidate) => candidate.name === method)!.answer!.type;
  return refused.again
    ? [
      `${refused.key} asked again, and its --answer answers only the first call, so cf-os api refused this one and stopped. It asked:`,
      JSON.stringify(refused.args),
      `Run the command again with an --answer '${refused.key}=<json|@file|->' that settles it the first time it asks, the JSON of type ${type}.`,
    ].join("\n")
    : [
      `${refused.key} asked for an answer, and the command gave none (--answer), so cf-os api refused it and stopped. It asked:`,
      JSON.stringify(refused.args),
      `Run the command again with --answer '${refused.key}=<json|@file|->', the JSON of type ${type}.`,
    ].join("\n");
}

/**
 * Runs the decoded calls in a session from `connect`, prints the last result, and disposes
 * everything the chain made. A call that reports the id of what it creates has it printed on stderr
 * before the result, or before the failure is thrown. A callback method that returns a value gets
 * the decoded `--answer` for its first call; any other call of one is refused, stopping the run
 * with a usage error that says what it asked. Resolves to the exit code: 0; 1 when a null partway
 * through the chain left a later command not run; or 130 on SIGINT. A failure is thrown, its
 * message explained by the session when the connection never opened.
 */
export async function execute(
  table: ApiTable,
  invocation: Invocation,
  { calls, answers }: Decoded,
  connect: () => Promise<Session>,
  io: RunIo,
): Promise<number> {
  const last = calls.at(-1)!;
  const kind = last.returns.kind;
  const { out } = invocation.flags;
  // Refused before connecting: bytes on a terminal are noise, and the instance need not be woken.
  let sink: "stdout" | string | undefined;
  if (kind === "stream") {
    if (out === undefined && io.stdout.isTTY) {
      throw new UsageError(`${last.method} returns bytes: pass --out <file>, or --out - to write them to this terminal.`);
    }
    sink = out === undefined || out === "-" ? "stdout" : io.outputPath(out);
  } else if (out !== undefined) {
    // A byte value: parseInvocation refuses --out for any other result.
    sink = out === "-" ? "stdout" : io.outputPath(out);
  }

  const { promise: stop, resolve: stopped } = Promise.withResolvers<"timeout" | "interrupt" | "closed" | "unanswered">();
  const disposables: Disposable[] = [];
  const emit = ndjsonEvents(drainingWriter(io.stdout));
  // An answer settles its method's first call only: a second ask is a new question. A server asks
  // again when the first answer did not do, usually saying why in its arguments, so replaying the
  // answer would hide that; refusing prints what it asked.
  const used = new Set<string>();
  const refused: Refused[] = [];
  const answer: AnswerCall = (key, callArgs) => {
    if (answers.has(key) && !used.has(key)) {
      used.add(key);
      io.out.log(`Answered ${key} from --answer; it asked: ${JSON.stringify(encodeArgs(callArgs))}`);
      return answers.get(key);
    }
    const again = answers.has(key);
    refused.push({ key, args: encodeArgs(callArgs), again });
    stopped("unanswered");
    throw new Error(again ? `cf-os api answers ${key} once (--answer)` : `cf-os api has no --answer for ${key}`);
  };
  const args = calls.map((call) => call.args.map((arg) => {
    if (arg instanceof StreamArg) return io.openStream(arg.path);
    if (!(arg instanceof CallbackArg)) return arg;
    const stub = arg.arg.encoding === "function"
      ? functionStub(arg.arg.name, arg.arg.params ?? [], emit)
      : callbackStub(arg.arg.callback!, table.callbacks[arg.arg.callback!], emit, answer);
    disposables.push(stub);
    return stub;
  }));

  const timer = invocation.flags.timeout === undefined ? undefined
    : setTimeout(() => stopped("timeout"), invocation.flags.timeout * 1000);
  const stopListening = io.onInterrupt(() => stopped("interrupt"));
  // `head -n 1` on the events, or on a stream's bytes, ends the run like Ctrl-C would, but cleanly:
  // without a listener the EPIPE is an unhandled 'error' event, and nothing gets disposed. Left in
  // place once the run is over, because the last write's EPIPE arrives on a later tick; any other
  // error is still thrown, as it would be with no listener.
  io.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    stopped("closed");
  });
  /** `promise`, unless the run is stopped first. */
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([
    promise,
    stop.then((reason) => {
      throw reason === "timeout" ? new TimedOut(`timed out after ${invocation.flags.timeout}s.`)
        : reason === "closed" ? new Closed() : reason === "unanswered" ? new Unanswered() : new Interrupted();
    }),
  ]);

  let session: Session | undefined;
  // Kept so that a session which opens after the run was stopped is still closed: its socket would
  // otherwise hold the process open.
  const connecting = connect();
  const chain: Remote[] = [];
  /** Every call's promise and every property read, aligned with `calls`. */
  const promises: Remote[] = [];
  /** The id reports ({@link ApiReportsId}), each settling once printed or failed; never rejecting. */
  const reports: Promise<void>[] = [];
  let result: unknown;
  try {
    session = await race(connecting);
    let current: Remote = invocation.public ? session.main : (await race(session.authenticate())).api;
    if (!invocation.public) chain.push(current);
    for (const [index, call] of calls.entries()) {
      // A property read has no disposer of its own: it is released with the result it is read on,
      // so it goes on `promises`, for firstNull, and never on the chain.
      current = call.property ? current[call.method] : current[call.method](...args[index]);
      promises.push(current);
      if (!call.property) chain.push(current);
      if (call.reportsId) reports.push(reportId(current, call.reportsId, chain, io));
    }
    try {
      result = await race(Promise.resolve(current));
    } catch (error) {
      if (error instanceof TimedOut || error instanceof Interrupted || error instanceof Closed || error instanceof Unanswered) throw error;
      // What the chain made before it failed is reported first: the id is how to reach it again.
      await race(Promise.all(reports));
      // A pipelined call on a null capability fails. The null is why, and a later command was not
      // run, so the chain did not do what it says: no result, and a failure.
      const nullAt = await race(firstNull(calls, promises));
      if (nullAt !== undefined) {
        io.out.log(stoppedAtNull(invocation, nullAt));
        return 1;
      }
      throw error;
    }
    await race(Promise.all(reports));
    if (kind === "subscription") {
      io.out.log(`Subscribed with ${last.method}; printing events${invocation.flags.timeout ? ` for ${invocation.flags.timeout}s` : ""} (Ctrl-C to stop).`);
      const broken = new Promise<never>((_, reject) => session!.main.onRpcBroken?.((error: unknown) => reject(error)));
      // Disposing the session at the end breaks it too, after nobody is listening.
      broken.catch(() => {});
      const reason = await Promise.race([stop, broken]);
      if (reason === "unanswered") throw new Unanswered();
      return reason === "interrupt" ? 130 : 0;
    }
    if (kind === "stream") {
      await race(writeStream(result as ReadableStream<Uint8Array>, sink!, io));
    } else if (sink !== undefined && result instanceof Uint8Array) {
      await race(writeStream(ReadableStream.from([result]), sink, io));
    } else if (kind === "handle" || kind === "stub") {
      io.out.json(null);
    } else {
      const found: Disposable[] = [];
      io.out.json(encodeValue(result, found));
      disposables.push(...found);
      // The capabilities printed are released as the run ends: using one takes a longer chain.
      const names = Object.keys(capabilitiesOf(last.returns));
      if (names.length > 0 && result !== null && result !== undefined) {
        const hop = invocation.hops.at(-1) as Extract<Hop, { kind: "command" }>;
        io.out.log(`Its ${capabilityNames(names)}, released as this command ends; to use ${names.length === 1 ? "it" : "one"}, ` +
          `continue the chain on it: ${propertyLines(hop, invocation.path).map((line) => `\`${line}\``).join(" or ")}.`);
      }
    }
    return 0;
  } catch (error) {
    // Whatever else failed once a call was refused (the server's own failure, passing the refusal on)
    // follows from the refusal, which is what the command must change.
    if (error instanceof Unanswered || refused.length > 0) throw new UsageError(refused.map((call) => refusedMessage(table, call)).join("\n\n"));
    // A subscription's --timeout ends it with 0 only once it is subscribed, which returns above; one
    // that runs out before then fails like any other command's.
    const stoppedCode = (stoppedBy: unknown): number | undefined =>
      stoppedBy instanceof Interrupted ? 130 : stoppedBy instanceof Closed ? 0 : undefined;
    const code = stoppedCode(error);
    if (code !== undefined) return code;
    if (error instanceof TimedOut || !session) throw error;
    // The diagnosis is another request to the instance, so it can be stopped too.
    let explained: unknown;
    try {
      explained = await race(session.explain(error));
    } catch (stoppedBy) {
      const stoppedAt = stoppedCode(stoppedBy);
      if (stoppedAt !== undefined) return stoppedAt;
      throw stoppedBy instanceof TimedOut ? error : stoppedBy;
    }
    throw explained;
  } finally {
    clearTimeout(timer);
    stopListening();
    disposeValue(result);
    for (const disposable of [...disposables, ...chain.toReversed()]) dispose(disposable);
    if (session) dispose(session.main);
    else connecting.then((late) => dispose(late.main), () => {});
  }
}

/**
 * Reads, pipelined on `created` (a capability a call returned), the id `reportsId` names, and prints
 * `Created <noun> <id>.` on stderr. The read joins `chain`, to be disposed with it. Resolves once
 * printed, or once the read failed, which prints nothing: then the call itself failed (or returned
 * null), and the chain's own failure says so.
 */
function reportId(created: Remote, reportsId: ApiReportsId, chain: Remote[], io: RunIo): Promise<void> {
  const read: Remote = created[reportsId.method]();
  chain.push(read);
  return Promise.resolve(read).then((value: unknown) => {
    const id = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[reportsId.property] : undefined;
    if (typeof id === "string" || typeof id === "number") io.out.log(`Created ${reportsId.noun} ${id}.`);
    disposeValue(value);
  }, () => {});
}

/**
 * The index of the first nullable hop of the chain whose result is null: a capability, or a value
 * whose property the next hop reads.
 */
async function firstNull(calls: Call[], promises: Remote[]): Promise<number | undefined> {
  for (const [index, call] of calls.entries()) {
    if (index === calls.length - 1) break;
    const nullable = call.returns.kind === "stub" ? call.returns.nullable
      : call.returns.kind === "value" && call.returns.nullable === true && calls[index + 1]!.property === true;
    if (!nullable) continue;
    try {
      const value: unknown = await promises[index];
      if (value === null) return index;
      disposeValue(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Why `invocation`'s chain stopped at its hop `at`, which was null: that hop, when it is null as
 * the table says (ApiCommand.nullWhen), and the first command after it, which was not run, by the
 * names typed; then the help of the command whose doc says when it is null, the null one or the one
 * whose result a null property was read on.
 */
function stoppedAtNull({ hops, path, literal }: Invocation, at: number): string {
  const named = (hop: Hop) => `\`${hop.kind === "call" ? `call ${hop.method}` : hop.name}\``;
  const hop = hops[at]!;
  const when = hop.kind === "command" && hop.command.nullWhen ? ` (${hop.command.nullWhen})` : "";
  const what = hop.kind === "property" ? `${named(hops[at - 1]!)}'s ${named(hop)} is null` : `${named(hop)} returned null${when}`;
  // A property the next hop reads on a null value is not there to read.
  const read = hops[at + 1]?.kind === "property" ? `, so it has no ${named(hops[at + 1]!)}` : "";
  // A chain never ends on a property, which would leave it open: a command follows.
  const next = hops.slice(at + 1).find((later) => later.kind !== "property")!;
  // Only a command's result is nullable, and a property is read on one.
  const documented = (hop.kind === "property" ? hops[at - 1] : hop) as Extract<Hop, { kind: "command" }>;
  return `${what}${read}: ${named(next)} was not run. See ${helpCommand(path.slice(0, documented.at), literal)}.`;
}

async function writeStream(stream: ReadableStream<Uint8Array>, sink: string, io: RunIo): Promise<void> {
  if (sink !== "stdout") {
    await pipeline(Readable.fromWeb(stream as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(sink));
    io.out.log(`Wrote ${sink}.`);
    return;
  }
  for await (const chunk of stream) {
    if (!io.stdout.write(chunk)) await once(io.stdout, "drain");
  }
}

/** Disposes a returned value: a stub, or an object whose disposer releases the stubs inside it. */
function disposeValue(value: unknown): void {
  if ((typeof value === "object" || typeof value === "function") && value !== null && Symbol.dispose in value) {
    dispose(value as Disposable);
  }
}

function dispose(disposable: Disposable): void {
  try {
    disposable[Symbol.dispose]();
  } catch {
    // Already broken or disposed: there is nothing left to release.
  }
}
