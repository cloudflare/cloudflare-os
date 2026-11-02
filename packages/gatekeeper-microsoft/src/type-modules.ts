/** A top-level `export type` or `export interface`, with its doc comment, and where it ends. */
const DECLARATION = /^(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n)?export (?:type|interface) (\w+)/gm;

/** Where the declaration starting at `from` ends: past its closing brace (an interface) or semicolon (a type), outside any nesting. */
function declarationEnd(code: string, from: number): number {
  let depth = 0;
  for (let index = code.indexOf("export ", from); index < code.length; index++) {
    const char = code[index];
    if (char === "{" || char === "(" || char === "[" || char === "<") depth++;
    else if (char === "}" || char === ")" || char === "]" || char === ">") {
      // `=>` isn't a closing bracket.
      if (char === ">" && code[index - 1] === "=") continue;
      depth--;
      if (depth === 0 && char === "}" && code[index + 1] === "\n" && /export interface/.test(code.slice(from, index))) return index + 1;
    } else if (char === ";" && depth === 0) {
      return index + 1;
    }
  }
  return code.length;
}

/**
 * Every resource's agent types, as one declaration. The resources share some types (`Cursor`,
 * `EmailAddress`, `Person`), declared word for word in each module so each reads on its own; here
 * each is kept once. A shared name declared differently is a mistake, and throws.
 */
export function mergeTypeModules(modules: readonly string[]): string {
  const seen = new Map<string, string>();
  const parts: string[] = [];
  for (const code of modules) {
    let kept = "";
    let last = 0;
    for (const match of code.matchAll(DECLARATION)) {
      const start = match.index;
      if (start < last) continue;
      const end = declarationEnd(code, start);
      const text = code.slice(start, end);
      const name = match[1]!;
      const earlier = seen.get(name);
      if (earlier === undefined) {
        seen.set(name, text);
      } else if (earlier === text) {
        kept += code.slice(last, start);
        last = end;
      } else {
        throw new Error(`The resources' agent types declare ${name} differently.`);
      }
    }
    parts.push(kept + code.slice(last));
  }
  return parts.join("\n");
}
