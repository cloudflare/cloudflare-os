// Generators and a reference decoder for the property tests of the live code preview
// (streaming-json-parser.test.ts, code-preview.test.ts): the writeFile / editFile / executeCode
// tool inputs an agent streams, serialized as the model providers emit them, and cut into the
// deltas the provider delivers.

import * as fc from "fast-check";

/** A tool call whose input the code preview streams, with the field it streams. */
export type PreviewedToolCall = {
  toolName: "writeFile" | "editFile" | "executeCode";
  /** The tool's arguments, in schema order (the order models emit them); the streamed one is last. */
  input: Record<string, string>;
  /** Escape every non-ASCII code unit as `\uXXXX` (as e.g. Python's `json.dumps` does). */
  asciiOnly: boolean;
  /** `", "` and `": "` separators rather than JSON.stringify's compact ones. */
  spaced: boolean;
};

/** The input field each tool's preview streams. */
export const STREAMED_FIELD = {writeFile: "content", editFile: "replacement", executeCode: "code"};

// Lines of the source files agents write: quotes, backslashes (escaped quotes, regexes, Windows
// paths, a shell line continuation), a literal `\u` escape in source text, accented and CJK text,
// and astral emoji (surrogate pairs, one with a skin-tone modifier).
const SOURCE_LINES = [
  "export function greet(name) {",
  "  return `Hello, ${name}!`;",
  "}",
  'const quote = "She said \\"hi\\"";',
  "const re = /^\\d+(\\.\\d+)?$/;",
  "const dir = 'C:\\\\Users\\\\me\\\\';",
  "npm run build && \\",
  "console.log('caf\\u00e9');",
  '<p class="note">Café ☕ — naïve résumé</p>',
  "// 日本語のコメント",
  "label: '😀 done 🎉',",
  "👍🏽",
  '{"items": [1, 2, 3]}',
  "</script>",
];
const LINE_BREAKS = ["\n", "\n  ", "\r\n", "\t", " "];

const sourceText = (minLines: number) =>
  fc.array(fc.tuple(fc.constantFrom(...SOURCE_LINES), fc.constantFrom(...LINE_BREAKS)),
           {minLength: minLines, maxLength: 10})
      .map(lines => lines.map(([line, br]) => line + br).join(""));

const filename = fc.constantFrom("index.html", "app.ts", "src/components/Chart.tsx",
                                 "styles.css", "data/notes 2024.json", "docs/résumé.md");
// The optional chat binding name of the target workpiece.
const workpiece = fc.constantFrom("app", "todoList", "weather_widget");

/** A previewed tool call as an agent issues it. */
export const previewedToolCall: fc.Arbitrary<PreviewedToolCall> = fc.record({
  call: fc.oneof(
      fc.record({workpiece, filename, content: sourceText(0)},
                {requiredKeys: ["filename", "content"]})
          .map(input => ({toolName: "writeFile" as const, input})),
      fc.record({workpiece, filename, textToReplace: sourceText(1), replacement: sourceText(0)},
                {requiredKeys: ["filename", "textToReplace", "replacement"]})
          .map(input => ({toolName: "editFile" as const, input})),
      sourceText(1).map(code => ({toolName: "executeCode" as const, input: {code}}))),
  asciiOnly: fc.boolean(),
  spaced: fc.boolean(),
}).map(({call, asciiOnly, spaced}) => ({...call, asciiOnly, spaced}));

/** Delta sizes, in UTF-16 code units, cycled over the serialized input. */
export const deltaSizes = fc.array(fc.integer({min: 1, max: 12}), {minLength: 1, maxLength: 16});

/**
 * Serializes `call`'s input, returning the JSON text and the index of the first character of the
 * streamed string value's body (just past its opening quote).
 */
export function serialize(call: PreviewedToolCall): {json: string, valueStart: number} {
  let encode = (s: string) => {
    let json = JSON.stringify(s);
    return call.asciiOnly
        ? json.replace(/[\u0080-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
        : json;
  };
  let entries = Object.entries(call.input)
      .map(([key, value]) => encode(key) + (call.spaced ? ": " : ":") + encode(value));
  let json = "{" + entries.join(call.spaced ? ", " : ",") + "}";
  // The streamed value is last: `"<body>"}`.
  let valueStart = json.length - encode(call.input[STREAMED_FIELD[call.toolName]]).length;
  return {json, valueStart};
}

/** Cuts `json` into consecutive deltas of the given sizes, cycled. */
export function cutDeltas(json: string, sizes: number[]): string[] {
  let deltas: string[] = [];
  for (let pos = 0, i = 0; pos < json.length; i++) {
    let size = sizes[i % sizes.length];
    deltas.push(json.slice(pos, pos + size));
    pos += size;
  }
  return deltas;
}

/**
 * The streamed value decodable from the first `received` characters of `json`: its body so far,
 * less an escape sequence still cut off at the end. (A `\uXXXX` half of a surrogate pair decodes
 * on its own, so this may end in a lone high surrogate.)
 */
export function decodableValue(json: string, valueStart: number, received: number): string {
  let body = json.slice(valueStart, Math.min(received, json.length - 2));
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") continue;
    let length = body[i + 1] === "u" ? 6 : 2;
    if (i + length > body.length) {
      body = body.slice(0, i);
      break;
    }
    i += length - 1;
  }
  return JSON.parse('"' + body + '"');
}
