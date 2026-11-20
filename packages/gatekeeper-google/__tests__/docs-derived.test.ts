// The guard that nothing the Doc store keeps of a tab is served once the code that derived it
// has changed, and the place where the digest of that code is recorded.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { DOC_DERIVED } from "../src/docs-derived";
import { runId } from "../src/docs-store";

const SRC = path.resolve(import.meta.dirname, "../src");

// The modules whose code decides a stored result, version or rendering, in the digest's order.
const DERIVED_BY: readonly string[] = [
  // The model: the tab an edit gives, and whether the model indexes a tab.
  "docs-model.ts",
  // The requests of an edit, the key a result is stored under and the refusal that is stored.
  "docs-replay.ts",
  // The table builders, and the shape and the cell count a stored summary holds.
  "docs-tables.ts",
  "docs-table-look.ts",
  // The renderer and the text builders: every rendering, its source map and the summary's counts.
  "markdown-converter.ts",
  // What the model and the renderer share of how Google counts text.
  "docs-content.ts",
  // The pruning and the write markers: what a tab holds when it is stored.
  "docs-replica.ts",
  // The cut of a tab into runs and their stored form: which runs a version lists.
  "docs-runs.ts",
  // The summaries and the shape of every derived row.
  "docs-store.ts",
  // What an edit asks of its stored tab as a whole and the piece it is built from: the
  // requests and the refusal a result holds.
  "docs-reading.ts",
];

// The modules the two entry points import a value from that decide nothing of a derived row.
const NOT_DERIVED_BY: Readonly<Record<string, string>> = {
  "docs-derived.ts": "It holds the digest, which would otherwise name itself.",
};

const read = (name: string) => readFileSync(path.join(SRC, name), "utf8");

/** The JavaScript the compiler emits for `source`, without its comments and its types. */
function emitted(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true,
    },
  }).outputText;
}

/** The modules of `src/` that `name` imports or re-exports a value from. */
function valueImports(name: string): string[] {
  let source = ts.createSourceFile(name, read(name), ts.ScriptTarget.ES2022, true);
  let found: string[] = [];
  for (let statement of source.statements) {
    let typeOnly: boolean;
    if (ts.isImportDeclaration(statement)) {
      let clause = statement.importClause;
      let named = clause?.namedBindings;
      typeOnly = clause !== undefined && (clause.isTypeOnly || (
        clause.name === undefined && named !== undefined && ts.isNamedImports(named) &&
        named.elements.length > 0 && named.elements.every(element => element.isTypeOnly)));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      let named = statement.exportClause;
      typeOnly = statement.isTypeOnly || (named !== undefined && ts.isNamedExports(named) &&
        named.elements.length > 0 && named.elements.every(element => element.isTypeOnly));
    } else continue;
    let specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (typeOnly || !specifier.startsWith(".")) continue;
    let file = `${path.normalize(specifier)}.ts`;
    if (existsSync(path.join(SRC, file))) found.push(file);
  }
  return found;
}

describe("DOC_DERIVED", () => {
  it("is the digest of the code that derives a stored result, version or rendering", () => {
    let digest = runId(DERIVED_BY.map(name => `${name}\n${emitted(read(name))}`).join(""));

    expect(
      DOC_DERIVED,
      "The code that derives what the Doc store keeps changed (or typescript6, which emits it, " +
      `did). Set DOC_DERIVED in src/docs-derived.ts to "${digest}". Nothing else is to be ` +
      "changed: stored results and renderings made by the earlier code are then served to no " +
      "one, each document folds its pending edits once more from its stored copy, and nothing " +
      "is fetched. A bump of typescript6 in the workspace catalog alone can move the digest; it " +
      "is recorded again the same way, with no version bumped.",
    ).toBe(digest);
  });

  it("moves with the code, and with no comment and no type", () => {
    let module = read(DERIVED_BY[0]);

    expect(emitted(`${module}\n// A comment.\n/** Another. */\nexport type Unused = { text: string };\n`))
      .toBe(emitted(module));
    expect(emitted(`${module}\nexport const added = 1;\n`)).not.toBe(emitted(module));
  });

  it("lists every module a stored row is derived by", () => {
    let reached = new Set(["docs-replay.ts", "docs-store.ts"]);
    for (let name of reached) {
      for (let imported of valueImports(name)) reached.add(imported);
    }

    // A module added to the graph is put in one list or the other, with its reason.
    let listed = [...DERIVED_BY, ...Object.keys(NOT_DERIVED_BY)];
    expect([...reached].filter(name => !listed.includes(name))).toEqual([]);
    expect(listed.filter(name => !reached.has(name))).toEqual([]);
    expect(DERIVED_BY.filter(name => name in NOT_DERIVED_BY)).toEqual([]);
    expect(new Set(DERIVED_BY).size).toBe(DERIVED_BY.length);
  });
});
