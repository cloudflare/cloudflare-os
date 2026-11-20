import type { Json } from "../automerge/json.ts";

/** For each character: whether it is inside quotes, and how many brackets and braces enclose it. */
function nesting(text: string): { quoted: boolean; depth: number }[] {
  const marks: { quoted: boolean; depth: number }[] = [];
  let quote = "";
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    const before = text[index - 1];
    if (quote !== "") {
      marks.push({ quoted: true, depth });
      if (char === "\\" && quote === '"') {
        marks.push({ quoted: true, depth });
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
    } else if ((char === '"' || char === "'") && (before === undefined || /[\s[{,(=!]/.test(before))) {
      // Elsewhere a quote is an apostrophe in plain text.
      quote = char;
      marks.push({ quoted: true, depth });
    } else {
      if (char === "]" || char === "}") depth -= 1;
      marks.push({ quoted: false, depth });
      if (char === "[" || char === "{") depth += 1;
    }
  }
  return marks;
}

function withoutComment(line: string): string {
  const marks = nesting(line);
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "#" && !marks[index]?.quoted && (index === 0 || /\s/.test(line[index - 1] ?? ""))) return line.slice(0, index);
  }
  return line;
}

/** Splits `key: rest` at the first colon that ends a key; `undefined` when the text has none. */
function splitKey(text: string): { key: string; rest: string } | undefined {
  const marks = nesting(text);
  for (let index = 0; index < text.length; index++) {
    const mark = marks[index];
    if (text[index] !== ":" || mark?.quoted || mark?.depth !== 0 || !/^(\s|$)/.test(text.slice(index + 1))) continue;
    const key = scalar(text.slice(0, index).trim());
    return typeof key === "string" ? { key, rest: text.slice(index + 1).trim() } : undefined;
  }
  return undefined;
}

function splitItems(text: string): string[] {
  const marks = nesting(text);
  const items: string[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && (text[index] !== "," || marks[index]?.quoted || marks[index]?.depth !== 0)) continue;
    items.push(text.slice(start, index).trim());
    start = index + 1;
  }
  return items.filter((item) => item !== "");
}

/** A mapping with each key as its own property, whatever the key, and no key twice. */
function mappingOf(entries: [string, Json][]): Json {
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size < entries.length) throw new Error(`a key is set twice among ${[...keys].join(", ")}`);
  return Object.fromEntries(entries);
}

/** A value written on one line: quoted or plain text, `[a, b]` or `{ a: b }`. */
function scalar(text: string): Json {
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, "$1");
  if (text.length > 1 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith("[") && text.endsWith("]")) return splitItems(text.slice(1, -1)).map(scalar);
  if (text.startsWith("{") && text.endsWith("}")) {
    return mappingOf(splitItems(text.slice(1, -1)).map((item) => {
      const entry = splitKey(item);
      if (!entry) throw new Error(`cannot read ${item} in ${text}`);
      return [entry.key, scalar(entry.rest)];
    }));
  }
  if (/^["'[{]/.test(text)) throw new Error(`cannot read a value that spans lines: ${text}`);
  // An anchor, alias or tag stands for a value this does not resolve.
  if (/^[&*!]/.test(text)) throw new Error(`cannot read an anchor, alias or tag: ${text}`);
  return text;
}

const isItem = (text: string) => text === "-" || text.startsWith("- ");

/**
 * Reads a workflow file into JSON, with every scalar as text, so that a check of a workflow sees
 * what GitHub sees: no comments, and the same value however it is quoted or ordered. It reads the
 * YAML these workflows use (block mappings and sequences, one-line flow values, block scalars) and
 * throws on anything else, so a file it cannot read fails its check.
 */
export function parseWorkflow(source: string): Json {
  const lines = source.split("\n");
  let next = 0;

  const peek = (): { indent: number; text: string } | undefined => {
    for (; next < lines.length; next++) {
      const text = withoutComment(lines[next] ?? "").trimEnd();
      if (text.trim() !== "") return { indent: text.length - text.trimStart().length, text: text.trimStart() };
    }
    return undefined;
  };

  const blockScalar = (indent: number): string => {
    const body: string[] = [];
    for (; next < lines.length; next++) {
      const line = lines[next] ?? "";
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
      body.push(line.trim());
    }
    return body.join("\n").trim();
  };

  /** The value of an entry at `indent` whose own line, already consumed, ended with `rest`. */
  const valueOf = (rest: string, indent: number): Json => {
    if (rest === "") {
      const child = peek();
      return child && child.indent > indent ? block(child.indent) : null;
    }
    if (/^[|>][+-]?\d?[+-]?$/.test(rest)) return blockScalar(indent);
    let value = scalar(rest);
    if (typeof value !== "string" || /^["']/.test(rest)) return value;
    for (let more = peek(); more && more.indent > indent; more = peek()) {
      value += ` ${more.text}`;
      next += 1;
    }
    return value;
  };

  const mapping = (indent: number): Json => {
    const entries: [string, Json][] = [];
    for (let line = peek(); line && line.indent === indent; line = peek()) {
      const entry = isItem(line.text) ? undefined : splitKey(line.text);
      if (!entry) throw new Error(`line ${next + 1}: expected a key, read ${line.text}`);
      next += 1;
      const child = entry.rest === "" ? peek() : undefined;
      // A sequence may sit at its key's own indent.
      entries.push([entry.key, child && child.indent === indent && isItem(child.text) ? sequence(indent) : valueOf(entry.rest, indent)]);
    }
    return mappingOf(entries);
  };

  const sequence = (indent: number): Json => {
    const items: Json[] = [];
    for (let line = peek(); line && line.indent === indent && isItem(line.text); line = peek()) {
      // Without its dash, an item reads as a block one level in.
      lines[next] = (lines[next] ?? "").replace("-", " ");
      const inner = peek();
      if (!inner || inner.indent <= indent) {
        items.push(null);
      } else if (isItem(inner.text) || splitKey(inner.text)) {
        items.push(block(inner.indent));
      } else {
        next += 1;
        items.push(valueOf(inner.text, indent));
      }
    }
    return items;
  };

  const block = (indent: number): Json => (isItem(peek()?.text ?? "") ? sequence(indent) : mapping(indent));

  const root = block(peek()?.indent ?? 0);
  if (peek()) throw new Error(`line ${next + 1}: unexpected indentation`);
  return root;
}
