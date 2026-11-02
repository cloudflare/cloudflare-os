// Whether a GitHub Actions workflow can hold a credential or run inside another workflow, for
// proof-actions.
//
// A workflow holds no credential when it names no secret, passes none to a reusable workflow, runs
// no job in an environment (environment secrets reach any step of such a job), calls no reusable
// workflow (whose jobs may name an environment), and grants its token nothing beyond `read`. It
// must also not be a reusable workflow itself (`workflow_call`), since it would then run inside
// whatever workflow calls it.
//
// The structure is read by a deliberately small YAML reader: block mappings, block sequences, block
// scalars, single-line quoted and plain scalars, and single-line flow collections. Anything else,
// including anchors, aliases, merge keys, tags, multi-line flow collections, multi-line plain or
// quoted scalars, and line breaks other than LF and CRLF, is a parse error, and a parse error fails
// the proof. GitHub reads anchors and aliases, so a reader that skipped them could be shown a
// different permissions block than GitHub runs with.

type YamlMap = { kind: "map"; entries: Map<string, YamlNode> };

/** A YAML node as this reader sees it. Flow collections stay as their source text. */
export type YamlNode =
  | YamlMap
  | { kind: "seq"; items: YamlNode[] }
  | { kind: "scalar"; value: string }
  | { kind: "flow"; text: string };

const KEY = /^("(?:[^"\\]*)"|'(?:[^']|'')*'|[A-Za-z0-9_][A-Za-z0-9_. /-]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^[|>](?:[1-9][-+]?|[-+][1-9]?)?(?:[ \t]+#.*)?$/;

class Reader {
  readonly lines: string[];
  index = 0;

  constructor(text: string) {
    this.lines = text.replace(/\r\n/g, "\n").split("\n");
    // YAML parsers also break lines at a lone CR, NEL, LS and PS, so text after one is a new line to
    // them and part of this line here. Those, other control characters and a byte order mark fail.
    // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
    const odd = this.lines.findIndex((line) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(line));
    if (odd !== -1) this.fail("a control character, a line break other than LF or CRLF, or a byte order mark", odd);
  }

  fail(message: string, line = this.index): never {
    throw new Error(`line ${line + 1}: ${message}`);
  }

  /** The indent of the next line that is not blank or a comment, or -1 at the end. */
  peek(): number {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (/^\s*(#.*)?$/.test(line)) {
        this.index++;
        continue;
      }
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      if (line[indent] === "\t") this.fail("a tab in indentation");
      if (indent === 0 && /^(---|\.\.\.|%)/.test(line)) this.fail("a document marker or directive");
      return indent;
    }
    return -1;
  }

  text(indent: number): string {
    return this.lines[this.index].slice(indent);
  }
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** A key without its quotes. */
function keyName(raw: string): string {
  if (raw.startsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  return raw;
}

/** Strips a trailing ` # comment` from what follows a closed scalar, or fails on anything else. */
function expectEnd(reader: Reader, rest: string): void {
  if (!/^(?:[ \t]+#.*|[ \t]*)$/.test(rest)) reader.fail(`unexpected text after a scalar: ${JSON.stringify(rest)}`);
}

/** Whether the brackets of a one-line flow collection close, outside quotes. */
function flowCloses(text: string): boolean {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== "") {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return /^(?:[ \t]+#.*|[ \t]*)$/.test(text.slice(i + 1));
    } else if (c === "&" || c === "*" || c === "!") {
      // An anchor, alias or tag inside a flow collection; inside a plain flow scalar these
      // characters are legal, but nothing this proof accepts needs them.
      return false;
    }
  }
  return false;
}

/** Reads the value that follows `key:` or `- ` on one line. `owner` is that line's indent. */
function inlineValue(reader: Reader, raw: string, owner: number): YamlNode {
  const value = raw.trim();
  if (/^[&*!]/.test(value)) reader.fail("an anchor, alias or tag");
  if (BLOCK_SCALAR.test(value)) {
    reader.index++;
    const content: string[] = [];
    while (reader.index < reader.lines.length) {
      const line = reader.lines[reader.index];
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      if (line.trim() !== "" && indent <= owner) break;
      content.push(line);
      reader.index++;
    }
    return { kind: "scalar", value: content.join("\n") };
  }
  let node: YamlNode;
  if (value.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(value);
    if (!match) reader.fail("an unterminated double-quoted scalar");
    expectEnd(reader, match[2]);
    node = { kind: "scalar", value: match[1] };
  } else if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(.*)$/.exec(value);
    if (!match) reader.fail("an unterminated single-quoted scalar");
    expectEnd(reader, match[2]);
    node = { kind: "scalar", value: match[1].replaceAll("''", "'") };
  } else if (value.startsWith("{") || value.startsWith("[")) {
    if (!flowCloses(value)) reader.fail("a flow collection this reader does not accept");
    node = { kind: "flow", text: value.replace(/[ \t]+#.*$/, "") };
  } else {
    if (/^[%@`|>]/.test(value)) reader.fail(`a reserved indicator: ${value}`);
    node = { kind: "scalar", value: value.replace(/[ \t]+#.*$/, "") };
  }
  reader.index++;
  const next = reader.peek();
  if (next > owner) reader.fail("an indented line after a scalar (a multi-line scalar is not accepted)");
  return node;
}

function parseNode(reader: Reader, indent: number): YamlNode {
  return isSeqItem(reader.text(indent)) ? parseSeq(reader, indent) : parseMap(reader, indent);
}

/** The node after `key:` with nothing else on its line. */
function nestedValue(reader: Reader, owner: number): YamlNode {
  const next = reader.peek();
  if (next > owner) return parseNode(reader, next);
  // A block sequence may sit at its key's own indent.
  if (next === owner && isSeqItem(reader.text(owner))) return parseSeq(reader, owner);
  return { kind: "scalar", value: "" };
}

function parseMap(reader: Reader, indent: number): YamlMap {
  const entries = new Map<string, YamlNode>();
  while (reader.peek() === indent && !isSeqItem(reader.text(indent))) {
    const line = reader.index;
    const match = KEY.exec(reader.text(indent));
    if (!match) reader.fail(`not a mapping entry: ${reader.text(indent)}`);
    const key = keyName(match[1]);
    if (key === "<<") reader.fail("a quoted << key");
    const folded = key.toLowerCase();
    if ([...entries.keys()].some((existing) => existing.toLowerCase() === folded)) reader.fail(`a duplicate key: ${key}`, line);
    const rest = match[2] ?? "";
    if (rest.trim() === "" || rest.trim().startsWith("#")) {
      reader.index++;
      entries.set(key, nestedValue(reader, indent));
    } else {
      entries.set(key, inlineValue(reader, rest, indent));
    }
  }
  const next = reader.peek();
  if (next > indent) reader.fail("unexpected indentation");
  return { kind: "map", entries };
}

function parseSeq(reader: Reader, indent: number): YamlNode {
  const items: YamlNode[] = [];
  while (reader.peek() === indent && isSeqItem(reader.text(indent))) {
    const rest = reader.text(indent).slice(1);
    const content = rest.replace(/^[ \t]+/, "");
    if (content === "" || content.startsWith("#")) {
      reader.index++;
      const next = reader.peek();
      if (next <= indent) reader.fail("an empty sequence item");
      items.push(parseNode(reader, next));
    } else if (KEY.test(content)) {
      // `- key: value` opens a mapping at the column of `key`.
      const column = indent + 1 + (rest.length - content.length);
      reader.lines[reader.index] = " ".repeat(column) + content;
      items.push(parseMap(reader, column));
    } else {
      items.push(inlineValue(reader, content, indent));
    }
  }
  const next = reader.peek();
  if (next > indent) reader.fail("unexpected indentation");
  return { kind: "seq", items };
}

/** Parses a workflow file into its root mapping, or throws naming the line it cannot read. */
export function parseWorkflow(text: string): Map<string, YamlNode> {
  const reader = new Reader(text);
  const first = reader.peek();
  if (first !== 0) reader.fail("the document does not start with a mapping at column 0");
  const root = parseMap(reader, 0);
  if (reader.peek() !== -1) reader.fail("text after the root mapping");
  return root.entries;
}

/** The entry for `key`, compared without case (keys are unique that way, see parseMap). */
function entry(map: Map<string, YamlNode>, key: string): YamlNode | undefined {
  for (const [name, node] of map) if (name.toLowerCase() === key) return node;
  return undefined;
}

/** The text a double-quoted YAML scalar could decode to: escapes resolved, escaped breaks joined. */
function decodedEscapes(text: string): string {
  return text
    .replace(/\\\r?\n[ \t]*/g, "")
    .replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g,
      (_, x: string | undefined, u: string | undefined, big: string | undefined) =>
        String.fromCodePoint(Number.parseInt(x ?? u ?? big ?? "0", 16)));
}

const SECRETS = /\bsecrets\b/i;
const WORKFLOW_CALL = /\bworkflow_call\b/i;

/** Whether `word` is in `text` as written, with YAML escapes decoded, or after Unicode case mapping. */
function mentions(word: RegExp, text: string): boolean {
  // Case mapping, because `ſ` upper-cases to `S` and GitHub compares context names without case.
  return [text, decodedEscapes(text)].some((variant) =>
    word.test(variant) || word.test(variant.toUpperCase()) || word.test(variant.toLowerCase()));
}

/** Why `permissions` at `where` may grant more than read, or nothing when it cannot. */
function permissionReasons(node: YamlNode, where: string): string[] {
  if (node.kind === "flow") return node.text.replace(/\s/g, "") === "{}" ? [] : [`${where} permissions are not {} or a block mapping`];
  if (node.kind === "scalar") return node.value === "read-all" ? [] : [`${where} permissions are "${node.value}"`];
  if (node.kind === "seq") return [`${where} permissions are a sequence`];
  const reasons: string[] = [];
  for (const [scope, level] of node.entries) {
    if (level.kind !== "scalar" || (level.value !== "read" && level.value !== "none")) {
      reasons.push(`${where} permission ${scope} is ${level.kind === "scalar" ? level.value : `a ${level.kind}`}`);
    }
  }
  return reasons;
}

/**
 * Every way `text` (a workflow at the pull request's base) could hold a credential or run inside
 * another workflow, or could not be read. Empty means none.
 */
export function workflowReasons(text: string): string[] {
  const reasons: string[] = [];
  // Matched on the whole text, so a mention in a comment counts too: comments are not parsed here,
  // and inside a block scalar a shell comment is still expression text GitHub evaluates.
  if (mentions(SECRETS, text)) reasons.push("names secrets");
  // A reusable workflow runs inside its callers, producers among them, and the gate knows
  // workflows only by path.
  if (mentions(WORKFLOW_CALL, text)) reasons.push("can be called by another workflow (workflow_call)");
  let root: Map<string, YamlNode>;
  try {
    root = parseWorkflow(text);
  } catch (error) {
    return [...reasons, `cannot be parsed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const top = entry(root, "permissions");
  if (top === undefined) reasons.push("has no top-level permissions");
  else reasons.push(...permissionReasons(top, "top-level"));
  const jobs = entry(root, "jobs");
  if (jobs?.kind !== "map") return [...reasons, "has no jobs mapping"];
  for (const [id, job] of jobs.entries) {
    if (job.kind !== "map") {
      reasons.push(`job ${id} is not a block mapping`);
      continue;
    }
    if (entry(job.entries, "environment") !== undefined) reasons.push(`job ${id} runs in an environment`);
    if (entry(job.entries, "uses") !== undefined) reasons.push(`job ${id} calls a reusable workflow`);
    if (entry(job.entries, "secrets") !== undefined) reasons.push(`job ${id} passes secrets`);
    const permissions = entry(job.entries, "permissions");
    if (permissions !== undefined) reasons.push(...permissionReasons(permissions, `job ${id}`));
  }
  return reasons;
}
