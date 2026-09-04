/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript6";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
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

function docBundle(): string {
  return [
    source("docs-read-types.txt"),
    stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

function driveBundle(): string {
  return [
    source("docs-read-types.txt"),
    source("sheets-types.txt"),
    stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
  ].join("\n");
}

describe("embedded agent declarations", () => {
  it("compiles the exact Google Doc agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(docBundle())).toEqual([]);
  });

  it("compiles the exact Google Drive agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(driveBundle())).toEqual([]);
  });

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

  it("hands out only read-only native sessions from Drive", () => {
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>",
    );
    expect(driveTypes).not.toContain("GoogleDocSession>");
    expect(driveTypes).not.toContain("GoogleSpreadsheetSession>");
    expect(driveTypes).toContain("export interface GoogleDriveReadSession");
  });
});
