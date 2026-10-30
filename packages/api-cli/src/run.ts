// `cf-os api`'s walk: argv against the generated command table, then the chain it spells, issued in
// one Cap'n Web session.
//
// `cf-os api open-gadget <id> get-chat-history <chatId>` is two segments. Each names a command on
// the capability reached so far and takes that command's positional arguments; its flags may come
// anywhere before the next segment. A command returning a capability moves the walk on to it. The
// whole chain is sent pipelined, nothing awaited between hops, and only its last result is awaited.
// Afterwards every stub the chain made, every capability inside the printed result and the session
// itself are disposed, however the command ends.
//
// A callback the chain passes may have methods that return a value, which the server waits for.
// `--answer <Callback>.<method>=<json|@file|->` answers the first call of such a method; a call left
// unanswered stops the run with exit 2, printing what it asked and the flag to rerun with.

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { callbackStub, drainingWriter, encodeArgs, functionStub, ndjsonEvents, type AnswerCall } from "./callbacks.ts";
import { admitsString, decodeArg, decodeJson, decodeUntyped, encodeValue, StreamArg, type ArgSource } from "./codec.ts";
import { UsageError, type Output } from "./output.ts";
import { nodePrefixes, PUBLIC_SEGMENT } from "./paths.ts";
import { DEV_SERVER_URL, defaultInstance, type DefaultInstance, type Remote, type Session } from "./session.ts";
import type { ApiArg, ApiCommand, ApiNode, ApiReturn, ApiTable } from "./table.ts";

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
  "  --timeout <seconds>  end a subscription (exit 0), or fail any other command, after this long",
  "  --out <file|->       where a returned byte stream goes (default: stdout, unless a terminal)",
  "  -h, --help           help for the capability or command reached so far",
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
  }
  /** `call <method> [json-args...]` on an untyped capability. */
  | { kind: "call"; method: string; args: string[] };

/** What `--help` describes. */
export type HelpTarget =
  | { kind: "node"; node: string }
  /** `at`: how many tokens of the walked path reach it, its name included. */
  | { kind: "command"; node: string; name: string; at: number }
  | { kind: "untyped" };

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
}

interface Segment {
  kind: "prefix" | "command" | "call";
  hop?: Extract<Hop, { kind: "command" }>;
  options: ParseArgsOptionsConfig;
  flagTokens: string[];
  positionals: string[];
  /** Positional arguments it takes; `Infinity` for `call`. */
  needed: number;
  /** How many tokens of the walked path reach it: those of its own help line. */
  at: number;
}

type Position = { kind: "node"; node: string } | { kind: "untyped" } | { kind: "result"; after: string; returns: ApiReturn };

/**
 * Where the first token of `path` is that the walk takes only after a `--`: one that reads as a
 * flag, or `--` itself. -1 when there is none.
 */
function escapedFrom(path: string[]): number {
  return path.findIndex((token) => token === "--" || isFlag(token));
}

/** `path` as it would be typed to walk the same way: quoted, with `--` back where it is needed. */
function typedPath(path: string[]): string {
  const at = escapedFrom(path);
  return shellLine(at === -1 ? path : [...path.slice(0, at), "--", ...path.slice(at)]);
}

/**
 * The help command for what `path` reaches, as it would be typed. A token only `--` let through cuts
 * it short, since nothing after a `--` can be `--help`: the help is then that of the segment before.
 */
function helpCommand(path: string[]): string {
  const at = escapedFrom(path);
  return `\`cf-os api ${shellLine([...at === -1 ? path : path.slice(0, at), "--help"])}\``;
}

/**
 * `message` as one sentence, then where to read about the option it names (`node:util`'s messages
 * lack both): the root's help for a runtime option, the help `path` reaches for any other.
 */
function withHelpPointer(message: string, path: string[]): string {
  const option = /--(?:no-)?([\w-]+)/.exec(message)?.[1];
  const help = option !== undefined && Object.hasOwn(RUNTIME_OPTIONS, option)
    ? "`cf-os api --help` for the API options" : `${helpCommand(path)} for its options`;
  return `${message.replace(/[^.!?]$/, "$&.")} Run ${help}.`;
}

function isFlag(token: string): boolean {
  return (token.startsWith("--") && token.length > 2) || token === "-h";
}

/** The positional (required, token-taking) arguments of `command`, in order. */
function positionalArgs(command: ApiCommand): ApiArg[] {
  return command.args.filter((arg) => !arg.flag && arg.encoding !== "callback" && arg.encoding !== "function");
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

function describeReturn(returns: ApiReturn): string {
  switch (returns.kind) {
    case "value":
      return returns.type === "void" ? "nothing (prints null)" : `${returns.type}, printed as JSON`;
    case "stub":
      return `a capability on ${returns.node}${returns.nullable ? ", or null" : ""}: follow with one of its commands`;
    case "handle":
      return "a handle, disposed at once (prints null)";
    case "stream":
      return "bytes, written to --out (or stdout, unless it is a terminal)";
    case "subscription":
      return "events, one JSON line each on stdout, until --timeout or Ctrl-C";
    case "untyped":
      return "an untyped capability: follow with `call <method> [json-args...]`";
  }
}

/**
 * Walks `tokens` -- everything after `cf-os api` but the global options -- against `table`. Throws
 * {@link UsageError} for anything the table does not allow. `--help` stops the walk where it
 * appears.
 */
export function parseInvocation(table: ApiTable, tokens: string[]): Invocation {
  const segments: Segment[] = [];
  let current: Segment = { kind: "prefix", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: 0, at: 0 };
  let position: Position = { kind: "node", node: table.root };
  let isPublic = false;
  let escaped = false;
  const path: string[] = [];
  const hops: Hop[] = [];
  const helpFor = (): HelpTarget => current.kind === "command"
    ? { kind: "command", node: current.hop!.node, name: current.hop!.name, at: current.at }
    : current.kind === "call" ? { kind: "untyped" }
    : { kind: "node", node: isPublic ? table.public : table.root };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!escaped && token === "--") {
      escaped = true;
      continue;
    }
    if (!escaped && isFlag(token)) {
      const name = token === "-h" ? "help" : token.slice(2).split("=")[0];
      if (name === "help") {
        return { public: isPublic, hops, flags: { dryRun: false, answers: [] }, end: { kind: "result", returns: { kind: "call" } }, help: helpFor(), path };
      }
      const option = optionFor(current.options, name);
      if (!option) {
        const on = current.kind === "command" ? ` for ${current.hop!.name}` : "";
        throw new UsageError(`Unknown option --${name}${on}. Run ${helpCommand(path.slice(0, current.at))} for its options.`);
      }
      if (option.type === "string" && !token.includes("=")) {
        if (i + 1 >= tokens.length) throw new UsageError(withHelpPointer(`--${name} needs a value.`, path.slice(0, current.at)));
        // Joined, so parseArgs takes a value that starts with a dash (`--limit -1`) as the value.
        current.flagTokens.push(`--${name}=${tokens[++i]}`);
      } else {
        current.flagTokens.push(token);
      }
      continue;
    }
    const continues = current.kind === "call" ? token !== "call" : current.positionals.length < current.needed;
    if (continues) {
      current.positionals.push(token);
      path.push(token);
      continue;
    }
    segments.push(current);
    path.push(token);
    if (current.kind === "prefix" && !isPublic && hops.length === 0 && token === "public") {
      isPublic = true;
      position = { kind: "node", node: table.public };
      current = { kind: "prefix", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: 0, at: path.length };
      continue;
    }
    if (current.kind === "call" && current.positionals.length === 0) {
      throw new UsageError("call needs a method name: `call <method> [json-args...]`.");
    }
    if (position.kind === "result") {
      throw new UsageError(`${position.after} returns ${resultNoun(position.returns)}, which ends the chain: nothing can follow it, but "${token}" does.`);
    }
    if (position.kind === "untyped") {
      if (token !== "call") {
        throw new UsageError(`The previous command returns an untyped capability: continue with \`call <method> [json-args...]\`, not "${token}".`);
      }
      current = { kind: "call", options: { ...RUNTIME_OPTIONS }, flagTokens: [], positionals: [], needed: Infinity, at: path.length };
      continue;
    }
    const node: ApiNode = table.nodes[position.node];
    const command: ApiCommand | undefined = Object.hasOwn(node.commands, token) ? node.commands[token] : undefined;
    if (!command) {
      throw new UsageError(`${position.node} has no command "${token}". Find one with ${SEARCH}, or run ${helpCommand(path.slice(0, -1))} for ${position.node}'s.`);
    }
    const hop: Extract<Hop, { kind: "command" }> = { kind: "command", name: token, node: position.node, command, positionals: [], flags: {} };
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
    const missing = positionalArgs(current.hop!.command).slice(current.positionals.length).map((arg) => `<${arg.name}>`);
    throw new UsageError(`${current.hop!.name} needs ${missing.join(" ")}. Run ${helpCommand(path)} for its arguments.`);
  }
  if (current.kind === "call" && current.positionals.length === 0) {
    throw new UsageError("call needs a method name: `call <method> [json-args...]`.");
  }

  const runtime: Record<string, string | boolean | string[] | undefined> = {};
  const finalHops: Hop[] = [];
  let commandIndex = 0;
  for (const segment of segments) {
    let values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    try {
      ({ values } = parseArgs({ args: segment.flagTokens, options: segment.options, strict: true, allowPositionals: false, allowNegative: true }));
    } catch (error) {
      throw new UsageError(withHelpPointer((error as Error).message, path.slice(0, segment.at)));
    }
    for (const [key, value] of Object.entries(values)) {
      // `--answer` may be given in any segment, and as often as there are methods to answer.
      if (key === "answer") runtime.answer = [...(runtime.answer as string[] | undefined) ?? [], ...value as string[]];
      else if (Object.hasOwn(RUNTIME_OPTIONS, key)) runtime[key] = value as string | boolean;
      else segment.hop!.flags[key] = value as string | boolean;
    }
    if (segment.kind === "command") finalHops.push(hops[commandIndex++]);
    if (segment.kind === "call") {
      const [method, ...args] = segment.positionals;
      finalHops.push({ kind: "call", method, args });
    }
  }

  const timeout = runtime.timeout === undefined ? undefined : Number(runtime.timeout);
  if (timeout !== undefined && !(timeout > 0)) {
    throw new UsageError(`--timeout must be a positive number of seconds; got "${runtime.timeout}".`);
  }
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
  return { public: isPublic, hops: finalHops, flags, end, path };
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
    ? `the instance (default: ${instance.url}, from CFOS_API_URL); http:// only for a local dev server`
    : `the instance (default: ${DEV_SERVER_URL}, where \`pnpm dev-server\` listens; CFOS_API_URL names another); ` +
      "http:// only for a local dev server";
  const indent = " ".repeat(column);
  const [first, ...rest] = wrap(text, indent);
  return [`${"  --url <origin>".padEnd(column)}${first.slice(column)}`, ...rest];
}

/** The first sentence of `doc`, whole: one that `e.g.` or `i.e.` does not end. */
function firstSentence(doc: string): string {
  const first = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return /^(.*?(?<!\b(?:e\.g|i\.e))[.!?])(\s|$)/.exec(first)?.[1] ?? first;
}

/** {@link firstSentence}, cut to fit a help listing. */
function summary(doc: string): string {
  const sentence = firstSentence(doc);
  return sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence;
}

function placeholder(arg: ApiArg, shapes: ApiTable["shapes"]): string {
  if (arg.choices) return arg.choices.join("|");
  switch (arg.encoding) {
    case "date":
      return "<iso-date>";
    case "bytes":
      return "<@file|-|json>";
    case "json":
      return arg.shape && admitsString(arg.shape, shapes) ? "<text|json|@file|->" : "<json|@file|->";
    case "stream":
      return "<file|->";
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

/** What a listing shows after a command that does not end the chain: where it leads. */
function leadsTo(command: ApiCommand): string {
  return command.returns.kind === "stub" ? ` → ${command.returns.node}` : command.returns.kind === "untyped" ? " → call" : "";
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
 * usage error for `cf-os api new-gadget`, which an agent might otherwise take for a call made.
 */
export function incompleteChain(table: ApiTable, invocation: Invocation): string {
  const { end, path } = invocation;
  const hop = invocation.hops.at(-1);
  const typed = `cf-os api ${typedPath(path)}`.trimEnd();
  const help = helpCommand(path);
  if (!hop || hop.kind !== "command") {
    return `${typed} names no command, so nothing was sent. Find one with ${SEARCH}; ${help} lists them.`;
  }
  if (end.kind === "untyped") {
    return `${hop.name} returns an untyped capability, so the chain goes on: nothing was sent. ` +
      `Finish it with \`call <method> [json-args...]\`, as in \`${typed} call <method>\`; ${help} says more.`;
  }
  const node = (end as { node: string }).node;
  const example = exampleCommand(table, node);
  return `${hop.name} returns a capability (${node}), so the chain goes on: nothing was sent. ` +
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
export function nodeHelp(table: ApiTable, node: string, path: string[], instance: DefaultInstance = defaultInstance({})): string {
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
 * Help for command `name` on capability `node`, reached by `path`: `name` is its `at`th token, and
 * any after it are the positionals typed so far.
 */
export function commandHelp(table: ApiTable, node: string, name: string, path: string[], at = path.lastIndexOf(name) + 1): string {
  const command = table.nodes[node].commands[name];
  const before = path.slice(0, at - 1);
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
  // A command of the next capability typed where a positional goes (`open-gadget new-chat --help`)
  // was taken for that positional; this help is not the one meant, so it says which is.
  const typed = path.slice(at);
  const misread = next === undefined ? -1 : typed.findIndex((token) => Object.hasOwn(table.nodes[next].commands, token));
  /** This command's line, the positionals typed before `kept` as typed and the rest as placeholders. */
  const line = (kept: number) => ["cf-os api", typedPath([...before, name, ...typed.slice(0, kept)]),
    ...positionals.slice(kept).map((arg) => `<${arg.name}>`)].filter(Boolean).join(" ");
  return [
    ...misread === -1 ? [] : [
      `"${typed[misread]}" was taken for ${name}'s <${positionals[misread]!.name}>, not as a command. For its help, run:`,
      `  ${line(misread)} ${typed[misread]} --help`,
      "",
    ],
    `Usage: ${["cf-os", "api", ...before, name, synopsis(command, table.shapes)].filter(Boolean).join(" ")}`,
    "",
    `${node}.${command.method}`,
    ...command.doc ? ["", ...wrap(command.doc, "")] : [],
    ...positionals.length ? ["", "Arguments:", ...table2(positionals.map((arg) => [`<${arg.name}>`, `${placeholder(arg, table.shapes) === `<${arg.name}>` ? "" : `${placeholder(arg, table.shapes)}: `}${describeArg(arg)}`]))] : [],
    ...flags.length ? ["", "Options:", ...table2(flags.map((arg) => [
      arg.encoding === "boolean" ? `--${arg.flag}, --no-${arg.flag}` : `--${arg.flag} ${placeholder(arg, table.shapes)}`,
      describeArg(arg),
    ]))] : [],
    ...events.length ? ["", 'Events (one JSON line each, {"event": <name>, "args": {<parameter>: <value>}}):', ...events.flatMap(table2)] : [],
    ...answers.length ? ["", ...wrap("Answers (the server may ask; give each with --answer '<name>=<json|@file|->', which answers " +
      "its first call; otherwise the call fails, exit 2, saying what it asked):", ""), ...answers.flatMap(table2)] : [],
    "",
    ...wrap(`Returns ${describeReturn(command.returns)}.`, ""),
    ...next ? [
      "", `Then, on ${next}:`, ...nodeCommandLines(table, next),
      "", `Run \`${line(misread === -1 ? typed.length : misread)} <command> --help\` for one's arguments.`,
    ] : [],
    "",
    RUNTIME_HELP_POINTER,
  ].join("\n");
}

/** Help for an untyped capability, reached by `path`. */
export function untypedHelp(path: string[]): string {
  return [
    `Usage: ${["cf-os", "api", ...path].join(" ")} call <method> [json-args...]`,
    "",
    "An untyped capability: the API does not say what it offers. `call` invokes a method by name, each",
    "argument parsed as JSON, or passed as a string when it is not JSON. Nothing is checked.",
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
 * The commands that best match `query`, best first, at most `limit`. A query word scores where it
 * best matches (three quarters as well for a synonym): 3 in the command's own name, 2 in its doc's first sentence, 1 in the hops that lead to it or the
 * first sentence of the capability it is on; a {@link BUILT_INS} entry scores as a command whose
 * name is its words, and wins a tie, as no doc names what it does. Other ties go to the shorter
 * command line. Local and deterministic: it reads the table, nothing else.
 */
export function searchCommands(table: ApiTable, query: string, limit = 5): SearchMatch[] {
  const terms = [...new Set(searchTerms(query))].filter((term) => !STOP_WORDS.has(term));
  const matches: (SearchMatch & { score: number; builtIn?: true })[] = [];
  for (const builtIn of BUILT_INS) {
    const own = new Set(searchTerms(builtIn.words));
    const phrase = searchTerms(builtIn.phrase ?? "");
    if (phrase.length > 0 && terms.some((_, at) => phrase.every((word, index) =>
      at + index < terms.length && termMatch(terms[at + index], new Set([word])) > 0))) {
      for (const word of phrase) own.add(word);
    }
    const said = new Set(searchTerms(builtIn.summary));
    const score = terms.reduce((total, term) => total + Math.max(3 * termMatch(term, own), 2 * termMatch(term, said)), 0);
    if (score > 0) matches.push({ command: builtIn.command, summary: builtIn.summary, score, builtIn: true });
  }
  for (const [node, prefix] of nodePrefixes(table)) {
    const segments: string[] = [];
    let at = table.root;
    for (const [index, segment] of prefix.entries()) {
      segments.push(segment);
      if (index === 0 && segment === PUBLIC_SEGMENT) {
        at = table.public;
        continue;
      }
      const hop = table.nodes[at].commands[segment];
      segments.push(...positionalArgs(hop).map((arg) => `<${arg.name}>`));
      at = (hop.returns as { node: string }).node;
    }
    const around = new Set(searchTerms(`${prefix.join(" ")} ${node} ${firstSentence(table.nodes[node].doc)}`));
    for (const [name, command] of Object.entries(table.nodes[node].commands)) {
      const own = new Set(searchTerms(`${name} ${command.method}`));
      const said = new Set(searchTerms(firstSentence(command.doc)));
      const score = terms.reduce((total, term) =>
        total + Math.max(3 * termMatch(term, own), 2 * termMatch(term, said), termMatch(term, around)), 0);
      if (score === 0) continue;
      const line = ["cf-os", "api", ...segments, name, ...positionalArgs(command).map((arg) => `<${arg.name}>`)].join(" ");
      matches.push({ command: line, summary: firstSentence(command.doc), score });
    }
  }
  return matches.toSorted((a, b) => b.score - a.score || Number(b.builtIn ?? false) - Number(a.builtIn ?? false) ||
    a.command.length - b.command.length)
    .slice(0, limit).map(({ command, summary: said }) => ({ command, summary: said }));
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
  const loose = parseArgs({ args: tokens, options: RUNTIME_OPTIONS, strict: false, allowPositionals: true });
  if (loose.positionals[0] !== "search") return undefined;
  try {
    const { values, positionals } = parseArgs({ args: tokens, options: RUNTIME_OPTIONS, strict: true, allowPositionals: true });
    return { query: positionals.slice(1).join(" "), help: values.help === true };
  } catch (error) {
    throw new UsageError(withHelpPointer((error as Error).message, ["search"]));
  }
}

/**
 * The service when `tokens` -- everything after `cf-os api` but the global options -- ask for the
 * agent declarations (`types` is the first word that is not an option), else undefined. Runtime
 * options are accepted and ignored, as for a search; `help` is true for `--help`.
 */
export function parseTypes(tokens: string[]): { service?: string; help: boolean } | undefined {
  const loose = parseArgs({ args: tokens, options: RUNTIME_OPTIONS, strict: false, allowPositionals: true });
  if (loose.positionals[0] !== "types") return undefined;
  let parsed: { values: { help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: tokens, options: RUNTIME_OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(withHelpPointer((error as Error).message, ["types"]));
  }
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

/** One call of the chain, its arguments decoded. */
export interface Call {
  method: string;
  /** Decoded arguments, trailing `undefined`s trimmed. Streams and callbacks are placeholders. */
  args: unknown[];
  /** What it returns; `call` for an untyped call. */
  returns: ApiReturn | { kind: "call" };
}

/** What {@link decodeCalls} decodes: the chain's calls, and the `--answer`s by `<Callback>.<method>`. */
export interface Decoded {
  calls: Call[];
  /** Each answer's value, checked and revived against its method's result shape. */
  answers: Map<string, unknown>;
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
    readStdin: () => {
      if (stdinUsed) throw new UsageError("Only one argument can read stdin (-).");
      stdinUsed = true;
      return source.readStdin();
    },
  };
  for (const hop of invocation.hops) {
    if (hop.kind === "call") {
      calls.push({ method: hop.method, args: hop.args.map(decodeUntyped), returns: { kind: "call" } });
      continue;
    }
    const args: unknown[] = [];
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
    calls.push({ method: hop.command.method, args: Array.from(args), returns: hop.command.returns });
  }
  const answers = new Map<string, unknown>();
  for (const raw of invocation.flags.answers) {
    const match = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)=([^]*)$/.exec(raw);
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
  }
  return { calls, answers };
}

/** The chain as `--dry-run` prints it: methods and JSON-encoded arguments, nothing secret. */
export function dryRunChain(calls: Call[]): { method: string; args: unknown[] }[] {
  return calls.map((call) => ({
    method: call.method,
    args: call.args.map((arg) => arg instanceof CallbackArg
      ? { [arg.arg.encoding === "function" ? "$function" : "$callback"]: arg.arg.callback ?? arg.arg.name }
      : arg instanceof StreamArg ? { $stream: arg.path }
      : encodeValue(arg)),
  }));
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
 * everything the chain made. A callback method that returns a value gets the decoded `--answer`
 * for its first call; any other call of one is refused, stopping the run with a usage error that
 * says what it asked. Resolves to the exit code: 0, or 130 on SIGINT. A failure is thrown, its
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
  // Refused before connecting: bytes on a terminal are noise, and the instance need not be woken.
  let sink: "stdout" | string | undefined;
  if (kind === "stream") {
    if (invocation.flags.out === undefined && io.stdout.isTTY) {
      throw new UsageError(`${last.method} returns bytes: pass --out <file>, or --out - to write them to this terminal.`);
    }
    sink = invocation.flags.out === undefined || invocation.flags.out === "-" ? "stdout" : io.outputPath(invocation.flags.out);
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
  let result: unknown;
  try {
    session = await race(connecting);
    let current: Remote = invocation.public ? session.main : (await race(session.authenticate())).api;
    if (!invocation.public) chain.push(current);
    for (const [index, call] of calls.entries()) {
      current = current[call.method](...args[index]);
      chain.push(current);
    }
    try {
      result = await race(Promise.resolve(current));
    } catch (error) {
      if (error instanceof TimedOut || error instanceof Interrupted || error instanceof Closed || error instanceof Unanswered) throw error;
      // A pipelined call on a null capability fails; the null is the answer.
      const nullAt = await race(firstNull(calls, chain.slice(invocation.public ? 0 : 1)));
      if (nullAt) {
        io.out.log(`${nullAt} returned null: there is nothing to call the rest of the chain on.`);
        io.out.json(null);
        return 0;
      }
      throw error;
    }
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
    } else if (kind === "handle" || kind === "stub") {
      io.out.json(null);
    } else {
      const found: Disposable[] = [];
      io.out.json(encodeValue(result, found));
      disposables.push(...found);
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

/** The first nullable hop of the chain whose result is null, by method name. */
async function firstNull(calls: Call[], promises: Remote[]): Promise<string | undefined> {
  for (const [index, call] of calls.entries()) {
    if (index === calls.length - 1) break;
    if (call.returns.kind !== "stub" || !call.returns.nullable) continue;
    try {
      if (await promises[index] === null) return call.method;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
