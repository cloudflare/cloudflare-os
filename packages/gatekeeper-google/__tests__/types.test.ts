/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript6";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX, GMAIL_TYPES_MODULE_PREFIX,
  SHEETS_TYPES_MODULE_PREFIX, SLIDES_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "../src/type-bundle";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sourcePath(name: string): string {
  return join(SOURCE_DIR, name);
}

function source(name: string): string {
  return readFileSync(sourcePath(name), "utf8");
}

function compileAgentTypes(sourceText: string): string[] {
  const fileName = "/agent-types.ts";
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const baseHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: name => name === fileName || baseHost.fileExists(name),
    getSourceFile: (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name === fileName
        ? ts.createSourceFile(name, sourceText, languageVersion, true)
        : baseHost.getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile),
    readFile: name => name === fileName ? sourceText : baseHost.readFile(name),
  };
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** Guidance the agent must still be reading when it picks a tab to act on. */
const TAB_GUIDANCE = [
  "Call `listTabs()` before `getContent()`",
  "reads exactly one tab and never combines tabs",
  "pass an ID returned by `listTabs()`",
  "only when `listTabs()` returns exactly one tab",
];

/**
 * Fails to compile unless `GoogleDocTab` has exactly the flattened adjacency-list members.
 *
 * Mutual assignability alone misses an added or removed *optional* property, since excess
 * properties are permitted in both directions, so the key sets are compared as well.
 */
const TAB_SHAPE_CHECK = `
type ExpectedGoogleDocTab = {
  id: string; title: string; parentTabId?: string; index: number; nestingLevel: number;
};
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const tabShapeIsExact: Mutual<GoogleDocTab, ExpectedGoogleDocTab> = true;
const tabKeysAreExact: Mutual<keyof GoogleDocTab, keyof ExpectedGoogleDocTab> = true;
`;

/** The names a declaration declares at top level, which share one scope in a flat bundle. */
function topLevelNames(sourceText: string): string[] {
  const file = ts.createSourceFile("/names.ts", sourceText, ts.ScriptTarget.ESNext);
  return file.statements.flatMap(statement =>
    (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
      ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) && statement.name
      ? [statement.name.text]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap(declaration =>
          ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
        : []);
}

function duplicates(names: string[]): string[] {
  return names.filter((name, i) => names.indexOf(name) !== i);
}

function docBundle(): string {
  return [
    source("docs-read-types.txt"),
    stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

function driveBundle(): string {
  return [
    source("docs-read-types.txt"),
    source("sheets-read-types.txt"),
    source("slides-read-types.txt"),
    stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
  ].join("\n");
}

function sheetsBundle(): string {
  return [
    source("sheets-read-types.txt"),
    stripTypeModulePrefix(source("sheets-types.txt"), SHEETS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

function slidesBundle(): string {
  return [
    source("slides-read-types.txt"),
    stripTypeModulePrefix(source("slides-types.txt"), SLIDES_TYPES_MODULE_PREFIX),
  ].join("\n");
}

/** The vendor's flat declaration bundle, composed as `GatekeeperVendor.getTypeScriptTypes()` does. */
function vendorBundle(): string {
  return [
    stripTypeModulePrefix(source("types.txt"), GMAIL_TYPES_MODULE_PREFIX), docBundle(),
    sheetsBundle(), slidesBundle(), source("calendar-types.txt"), source("bigquery-types.txt"),
    stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
    source("chat-types.txt"),
  ].join("\n");
}

describe("embedded agent declarations", () => {
  it("compiles the exact Google Doc agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(docBundle())).toEqual([]);
  });

  it("compiles the exact Google Drive agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(driveBundle())).toEqual([]);
  });

  it("compiles the exact Google Slides agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(slidesBundle())).toEqual([]);
  });

  it("compiles the exact Google Sheets agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(sheetsBundle())).toEqual([]);
  });

  it.each([
    ["vendor", vendorBundle, sheetsBundle],
    ["Drive", driveBundle, () => source("sheets-read-types.txt")],
  ] as const)(
    "declares each Google Sheets name once in the flat %s bundle",
    (_name, bundle, sheets) => {
      const sheetsNames = topLevelNames(sheets());
      expect(sheetsNames).toContain("GoogleSpreadsheetReadSession");
      expect(duplicates(topLevelNames(bundle())).filter(name => sheetsNames.includes(name)))
        .toEqual([]);
    },
  );

  it("declares the flattened tab contract on the canonical read session", () => {
    const readTypes = source("docs-read-types.d.ts");
    expect(readTypes).toContain("export type GoogleDocTab = {");
    expect(readTypes).toContain("listTabs(): Promise<GoogleDocTab[]>;");
    expect(readTypes).toContain("getContent(tabId?: string): Promise<string>;");
  });

  it.each([["Doc", docBundle], ["Drive", driveBundle]] as const)(
    "carries the exact tab shape and its selection guidance into the %s bundle",
    (_name, bundle) => {
      const types = bundle();
      for (const phrase of TAB_GUIDANCE) expect(types).toContain(phrase);
      expect(compileAgentTypes(types + TAB_SHAPE_CHECK)).toEqual([]);
    },
  );

  it("keeps Drive Docs authority read-only", () => {
    const readTypes = source("docs-read-types.d.ts");
    expect(readTypes).toContain("export interface GoogleDocReadSession");
    expect(readTypes).not.toContain("replaceText");
    expect(readTypes).not.toContain("appendText");
    const writeTypes = source("docs-types.d.ts");
    expect(writeTypes).toContain(
      "export interface GoogleDocSession extends GoogleDocReadSession",
    );
    expect(writeTypes).toContain(
      "replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void>;",
    );
    expect(writeTypes).toContain("appendText(markdown: string, tabId?: string): Promise<void>;");
  });

  it("gives a directly bound spreadsheet its own session and Drive only the read session", () => {
    expect(topLevelNames(vendorBundle())).toContain("GoogleSpreadsheetSession");
    expect(compileAgentTypes(vendorBundle() + `
declare const sheet: GoogleSpreadsheetSession;
const sheetIds: Promise<Record<string, number>> = sheet.updateSheet([
  { op: "writeCells", range: "'Sales 2026'!A1:B1", values: [["=SUM(C1:C9)", null]] },
  { op: "clearRange", range: "Sales!A2:B3" },
]);
// @ts-expect-error A change names its range.
sheet.updateSheet([{ op: "clearRange" }]);
const minted: Promise<Record<string, number>> = sheet.updateSheet([
  { op: "addSheet", title: "Q4", ref: "q4", index: 1, rowCount: 100, columnCount: 5 },
  { op: "writeCells", range: "'Q4'!A1", values: [["Forecast"]] },
  { op: "renameSheet", sheetId: "q4", title: "Q4 2026" },
  { op: "duplicateSheet", sheetId: 0, title: "Copy", ref: "copy", index: 2 },
  { op: "insertRows", sheetId: "copy", at: 3, count: 2 },
  { op: "deleteRows", sheetId: 0, at: 5 },
  { op: "insertColumns", sheetId: 0, at: "C" },
  { op: "deleteColumns", sheetId: 0, at: "C", count: 2 },
  { op: "deleteSheet", sheetId: "copy" },
]);
// @ts-expect-error Columns are named by their letters.
sheet.updateSheet([{ op: "insertColumns", sheetId: 0, at: 3 }]);
// @ts-expect-error A sheet added needs a title.
sheet.updateSheet([{ op: "addSheet" }]);
`)
      // The agent's runtime provides the module Chat's declarations import.
      .filter(message => !message.includes("'cloudflare:workers'"))).toEqual([]);
    expect(compileAgentTypes(sheetsBundle() +
      "\nconst readable: GoogleSpreadsheetReadSession = null! as GoogleSpreadsheetSession;\n"))
      .toEqual([]);
    const driveNames = topLevelNames(driveBundle());
    expect(driveNames).toContain("GoogleSpreadsheetReadSession");
    expect(driveNames).not.toContain("GoogleSpreadsheetSession");
    expect(driveNames).not.toContain("SheetChange");
    expect(source("sheets-types.d.ts")).toContain(
      "export interface GoogleSpreadsheetSession extends GoogleSpreadsheetReadSession",
    );
  });

  it.each([
    ["vendor", vendorBundle],
    ["Drive", driveBundle],
  ] as const)("declares the format read types once in the flat %s bundle", (_name, bundle) => {
    const names = topLevelNames(bundle());
    const formatNames = [
      "SheetColor", "SheetBorderStyle", "SheetBorder", "SheetNumberFormat", "SheetCellFormat",
      "SpreadsheetFormats",
    ];
    // Slides declares colours, borders and text formats of its own in the same flat scope.
    expect(names).toContain("SlideColor");
    for (const name of formatNames) expect(names.filter(candidate => candidate === name)).toEqual([name]);
    expect(compileAgentTypes(bundle() + `
declare const sheet: GoogleSpreadsheetReadSession;
const read: Promise<SpreadsheetFormats> = sheet.readFormats("'Sales 2026'!A1:C3");
const format: SheetCellFormat | null = null! as SpreadsheetFormats["formats"][number][number];
const border: SheetBorder = { style: "SOLID_MEDIUM", color: "#ff0000" };
const set: SheetCellFormat = {
  bold: true, fontSize: 14, textColor: "ACCENT1", fillColor: "#ffffff", wrap: "CLIP",
  numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' }, borders: { top: border },
};
// @ts-expect-error A border has a style.
const unstyled: SheetBorder = { color: "#000000" };
// @ts-expect-error Wrapping is named as the agent names it.
const legacy: SheetCellFormat = { wrap: "OVERFLOW_CELL" };
`).filter(message => !message.includes("'cloudflare:workers'"))).toEqual([]);
  });

  it("hands out only read-only native sessions from Drive", () => {
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession>",
    );
    expect(driveTypes).not.toContain("GoogleDocSession>");
    expect(driveTypes).not.toContain("GoogleSpreadsheetSession>");
    expect(driveTypes).not.toContain("GooglePresentationSession>");
    expect(driveTypes).toContain("export interface GoogleDriveReadSession");
  });
});
