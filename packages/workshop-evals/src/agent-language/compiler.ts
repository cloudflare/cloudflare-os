import ts from "typescript-compiler";
import { performance } from "node:perf_hooks";
export type Variant = "js" | "checkjs" | "ts" | "baml";
export const declarations = `
interface Ticket { id: string; priority: "high" | "low"; owner: { name: string } | null; created: string; points: number; status: "open" | "closed" }
interface Env {
 TICKETS: {
  list(): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | null>;
  close(input: {id: string; resolution: "fixed" | "duplicate"; metadata?: {tags: string[]}}): Promise<{ok: boolean}>;
  flaky(): Promise<{ok: true; ids: string[]} | {ok: false; error: "timeout"}>;
 };
 COUNTER: { read(): Promise<number>; write(value: number): Promise<void>; increment(): Promise<void> };
 MCP: { query(input: {filter: {priority: "high" | "low"}; limit?: number}): Promise<{items: Ticket[]}> };
}
interface Self { report(value: unknown): Promise<void> }
interface Context { waitUntil(promise: Promise<unknown>): void }
interface Console { log(...data: unknown[]): void }
declare const console: Console;
`;
const options: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  types: [],
  skipLibCheck: false,
};
/** An in-memory compiler host; generated programs cannot resolve host files or packages. */
export function validate(
  source: string,
  variant: Exclude<Variant, "baml">,
  environment = declarations,
) {
  const start = performance.now();
  const diagnostics: string[] = [];
  const file = variant === "ts" ? "/agent.ts" : "/agent.js";
  let checked = source;
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    variant === "ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if (variant !== "js") {
    if (/@ts-(?:ignore|nocheck|expect-error)|@type\s*\{\s*(?:any|\*)\s*\}/.test(source))
      diagnostics.push("Policy: type-check suppression is prohibited");
    const visit = (n: ts.Node) => {
      if (
        n.kind === ts.SyntaxKind.AnyKeyword ||
        ts.isAsExpression(n) ||
        ts.isTypeAssertionExpression(n) ||
        ts.isNonNullExpression(n)
      )
        diagnostics.push("Policy: any, casts and non-null assertions are prohibited");
      ts.forEachChild(n, visit);
    };
    visit(parsed);
    if (variant === "checkjs") {
      const fn = parsed.statements.find(
        (n) =>
          ts.isFunctionDeclaration(n) &&
          n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
      );
      if (
        !fn ||
        !ts.isFunctionDeclaration(fn) ||
        fn.parameters.length !== 3 ||
        fn.parameters.some((p) => !ts.isIdentifier(p.name))
      )
        diagnostics.push(
          "Host typing requires a default function with three identifier parameters",
        );
      else {
        const names = fn.parameters.map((p) => p.name.getText(parsed));
        const doc = `/** @param {Self} ${names[0]} @param {Env} ${names[1]} @param {Context} ${names[2]} */\n`;
        checked = source.slice(0, fn.getStart(parsed)) + doc + source.slice(fn.getStart(parsed));
      }
    }
  }
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const libDir = ts.getDefaultLibFilePath(options).replace(/[^/]+$/, "");
  host.readFile = (name) =>
    name === file
      ? checked
      : name === "/environment.d.ts"
        ? environment
        : name.startsWith(libDir)
          ? originalRead(name)
          : undefined;
  host.fileExists = (name) => host.readFile(name) !== undefined;
  host.getSourceFile = (name, languageVersion) => {
    const text = host.readFile(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true);
  };
  const program = ts.createProgram([file, "/environment.d.ts"], options, host);
  const errors =
    variant === "js" ? program.getSyntacticDiagnostics() : ts.getPreEmitDiagnostics(program);
  for (const d of errors) {
    const pos =
      d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    diagnostics.push(
      `TS${d.code}${pos ? `:${Math.max(1, pos.line + 1 - (variant === "checkjs" ? 1 : 0))}:${pos.character + 1}` : ""} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
  }
  return {
    diagnostics,
    javascript:
      variant === "ts"
        ? ts.transpileModule(source, { compilerOptions: options }).outputText
        : source,
    validationMs: performance.now() - start,
  };
}
