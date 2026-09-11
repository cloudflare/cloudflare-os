// The one place the build reads a module's syntax. A regex over JavaScript has no end of ways to
// be misled -- a specifier in a comment, a keyword in a string, an escape in a path, a comment
// ended by a line terminator the pattern did not list -- so the imports are read from the syntax
// tree the TypeScript compiler builds instead, which a comment or a string cannot reach into.
// TypeScript 6, because the workspace `tsc` is TypeScript 7 (tsgo), which ships no compiler API.

import ts from "typescript6";

/** What the build needs to know about one module's imports, read from its syntax tree. */
export interface ModuleScan {
  /**
   * Every module specifier written as a string literal, decoded: the operand of a static
   * `import`/`export ... from` declaration or of `import x = require("...")`, of a literal
   * `import()` or `require()` call, and of a type-position `import("...")`, which the compiled
   * output never shows.
   */
  specifiers: string[];
  /** The keyword of the first `import()` or `require()` whose operand is not one string literal. */
  dynamic?: "import" | "require";
}

/**
 * Reads `source`, the module at `path`, for its imports. The path's extension decides whether it
 * is parsed as TypeScript or JavaScript. Never throws: a malformed module yields the best tree the
 * parser can make of it, and the bundler is the judge of its syntax afterwards.
 */
export function scanModule(path: string, source: string): ModuleScan {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const scan: ModuleScan = { specifiers: [] };
  const specifier = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) scan.specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        specifier(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) specifier(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      // A bare `require` only: `foo.require(...)` is a method of that name, not the keyword.
      const keyword = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import"
          : ts.isIdentifier(node.expression) && node.expression.text === "require" ? "require"
          : undefined;
      if (keyword !== undefined) {
        // The first argument names the module; `import("./x", { with: ... })` is a literal import.
        const [operand] = node.arguments;
        if (operand !== undefined && ts.isStringLiteralLike(operand)) {
          scan.specifiers.push(operand.text);
        } else {
          scan.dynamic ??= keyword;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return scan;
}
