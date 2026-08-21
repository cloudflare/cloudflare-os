/// <reference types="node" />

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript6";

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

describe("embedded agent declarations", () => {
  it("keeps docs-read-types.txt linked to its TypeScript declaration", () => {
    const textUrl = sourcePath("docs-read-types.txt");
    expect(lstatSync(textUrl).isSymbolicLink()).toBe(true);
    expect(readlinkSync(textUrl)).toBe("docs-read-types.d.ts");
    expect(source("docs-read-types.txt")).toBe(source("docs-read-types.d.ts"));
  });

  it("keeps the Google Doc declaration aligned after module-only imports and exports", () => {
    const modulePrefix =
      'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
      'export type { DocMetadata, GoogleDocReadSession } from "./docs-read-types";\n\n';
    const docsTypes = source("docs-types.d.ts");
    expect(docsTypes.startsWith(modulePrefix)).toBe(true);
    expect(source("docs-types.txt")).toBe(docsTypes.slice(modulePrefix.length));
  });

  it("compiles the exact Google Doc agent declaration bundle without module dependencies", () => {
    const types = [source("docs-read-types.txt"), source("docs-types.txt")].join("\n");

    expect(compileAgentTypes(types)).toEqual([]);
  });

  it("keeps the Drive declaration aligned after module-only imports", () => {
    const modulePrefix =
      'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
      'import type { GoogleSpreadsheetSession } from "./sheets-types";\n\n';
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes.startsWith(modulePrefix)).toBe(true);
    expect(source("drive-types.txt")).toBe(driveTypes.slice(modulePrefix.length));
  });

  it("keeps Drive Docs authority read-only", () => {
    const readTypes = source("docs-read-types.d.ts");
    expect(readTypes).toContain("export interface GoogleDocReadSession");
    expect(readTypes).not.toContain("replaceText");
    expect(readTypes).not.toContain("appendText");
    expect(source("docs-types.d.ts")).toContain(
      "export interface GoogleDocSession extends GoogleDocReadSession",
    );
  });

  it("exposes only typed native content sessions from Drive", () => {
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetSession>",
    );
    expect(driveTypes).not.toContain("GoogleDocSession>");
  });

  it("splits Drive creation authority from read-only sessions", () => {
    const types = [
      "declare class RpcTarget {}",
      source("docs-read-types.txt"),
      source("docs-types.txt"),
      source("sheets-types.d.ts"),
      source("drive-types.txt"),
      `
        declare const account: GoogleDriveSession;
        declare const sharedDrive: GoogleDriveSession;
        declare const file: GoogleDriveReadSession;
        declare const nestedDoc: GoogleDocReadSession;
        declare const directDoc: GoogleDocSession;
        declare const sheet: GoogleSpreadsheetSession;

        account.createGoogleDoc({ name: "Quarterly plan" });
        account.createGoogleSheet({ name: "Forecast", parentId: "folder-1" });
        account.createFolder({ name: "Archive" });
        account.getCreationResult({ id: 1, kind: "googleDoc", name: "Quarterly plan" });
        sharedDrive.createGoogleDoc({ name: "Quarterly plan" });
        sharedDrive.createGoogleSheet({ name: "Forecast" });
        sharedDrive.createFolder({ name: "Archive", parentId: "folder-2" });
        sharedDrive.getCreationResult({ id: 2, kind: "folder", name: "Archive" });

        // @ts-expect-error Exact-file Drive sessions remain read-only.
        file.createGoogleDoc({ name: "Denied" });
        // @ts-expect-error Exact-file Drive sessions cannot query creation actions.
        file.getCreationResult({ id: 1, kind: "googleDoc", name: "Denied" });
        // @ts-expect-error Nested Docs sessions expose no Drive creation methods.
        nestedDoc.createFolder({ name: "Denied" });
        // @ts-expect-error Direct Docs bindings retain only their existing document API.
        directDoc.createGoogleDoc({ name: "Denied" });
        // @ts-expect-error Nested and direct Sheets sessions expose no Drive creation methods.
        sheet.createGoogleSheet({ name: "Denied" });
      `,
    ].join("\n");

    expect(compileAgentTypes(types)).toEqual([]);
  });
});
