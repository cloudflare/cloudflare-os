/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript6";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_READ_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX,
  GMAIL_TYPES_MODULE_PREFIX, SHEETS_TYPES_MODULE_PREFIX, SLIDES_TYPES_MODULE_PREFIX,
  stripTypeModulePrefix,
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
    source("comment-types.txt"),
    stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

/** What a read-only Drive binding receives. */
function driveReadBundle(): string {
  return [
    source("docs-read-types.txt"),
    source("sheets-read-types.txt"),
    source("slides-read-types.txt"),
    source("comment-types.txt"),
    stripTypeModulePrefix(source("drive-read-types.txt"), DRIVE_READ_TYPES_MODULE_PREFIX),
  ].join("\n");
}

/** What a read and write Drive binding receives. */
function driveWriteBundle(): string {
  return [
    driveReadBundle(),
    stripTypeModulePrefix(source("sheets-types.txt"), SHEETS_TYPES_MODULE_PREFIX),
    stripTypeModulePrefix(source("slides-types.txt"), SLIDES_TYPES_MODULE_PREFIX),
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
    stripTypeModulePrefix(source("drive-read-types.txt"), DRIVE_READ_TYPES_MODULE_PREFIX),
    stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
    source("chat-types.txt"),
  ].join("\n");
}

describe("embedded agent declarations", () => {
  it("exposes binary uploads and removable draft attachments without message write authority", () => {
    const types = source("types.txt");
    expect(compileAgentTypes(types + `
declare const draft: GmailDraft;
declare const message: GmailMessage;
const file: GmailAttachmentInput = {
  filename: "report.pdf", mimeType: "application/pdf", content: new ArrayBuffer(1),
};
const compose: GmailComposeOptions = {attachments: [file]};
const reply: GmailReplyOptions = {attachments: [file]};
const initial: GmailDraftInput = {attachments: [file]};
const added: Promise<GmailDraftAttachment> = draft.addAttachment(file);
const entries: Promise<GmailDraftAttachmentEntry[]> = draft.attachments();
declare const draftAttachment: GmailDraftAttachment;
const readable: GmailAttachment = draftAttachment;
const removed: Promise<void> = draftAttachment.remove();
// @ts-expect-error Patches cannot replace all attachments.
const patch: GmailDraftPatch = {attachments: [file]};
// @ts-expect-error Message attachment capabilities remain read-only.
readable.remove();
// @ts-expect-error Uploads take exact binary buffers, not base64 strings.
const encoded: GmailAttachmentInput = {filename: "file", mimeType: "text/plain", content: "YQ=="};
// @ts-expect-error Messages cannot add attachments.
message.addAttachment(file);
`).filter(message => !message.includes("'cloudflare:workers'"))).toEqual([]);
  });

  it("compiles the exact Google Doc agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(docBundle())).toEqual([]);
  });

  it("compiles the exact Google Drive agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(driveReadBundle())).toEqual([]);
    expect(compileAgentTypes(driveWriteBundle())).toEqual([]);
  });

  it("compiles the exact Google Slides agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(slidesBundle())).toEqual([]);
  });

  it("compiles the exact Google Sheets agent declaration bundle without module dependencies", () => {
    expect(compileAgentTypes(sheetsBundle())).toEqual([]);
  });

  it.each([
    ["Doc", docBundle], ["Drive", driveReadBundle], ["Drive read and write", driveWriteBundle],
    ["vendor", vendorBundle],
  ] as const)("declares each comment shape once in the flat %s bundle", (_name, bundle) => {
    const names = topLevelNames(bundle());
    const shapes = topLevelNames(source("comment-types.txt"));
    expect(shapes).toEqual(["DriveCommentAuthor", "DriveCommentReply", "DriveComment", "DocSuggestion"]);
    for (const name of shapes) expect(names.filter(declared => declared === name), name).toHaveLength(1);
  });

  it.each([
    ["vendor", vendorBundle, sheetsBundle],
    ["Drive", driveReadBundle, () => source("sheets-read-types.txt")],
    ["Drive read and write", driveWriteBundle, () => source("sheets-read-types.txt")],
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

  it.each([["Doc", docBundle], ["Drive", driveReadBundle]] as const)(
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

  it("lets a directly bound Doc add a tab, and only a bound Doc", () => {
    expect(source("docs-types.d.ts")).toContain(
      "addTab(title: string, options?: { parentTabId?: string; index?: number }): Promise<string>;",
    );
    expect(source("docs-read-types.d.ts")).not.toContain("addTab");
    expect(compileAgentTypes(docBundle() + `
declare const doc: GoogleDocSession;
async function use(): Promise<void> {
  const tabId: string = await doc.addTab("Notes");
  const child: string = await doc.addTab("Details", { parentTabId: tabId, index: 0 });
  await doc.appendText("Hello", child);
}
// @ts-expect-error A new tab has a title.
doc.addTab();
// @ts-expect-error A new tab is placed by its parent's ID, not by an object.
doc.addTab("Notes", { parentTabId: { id: "t.0" } });
`)).toEqual([]);
  });

  it("gives a spreadsheet's write session to its own binding and to a read and write Drive one", () => {
    expect(topLevelNames(vendorBundle())).toContain("GoogleSpreadsheetSession");
    expect(compileAgentTypes(vendorBundle() + `
declare const sheet: GoogleSpreadsheetSession;
const queued: Promise<void> = sheet.updateSpreadsheet([
  { op: "writeCells", range: "'Sales 2026'!A1:B1", values: [["=SUM(C1:C9)", null]] },
  { op: "clearRange", range: "Sales!A2:B3" },
]);
// @ts-expect-error A change names its range.
sheet.updateSpreadsheet([{ op: "clearRange" }]);
sheet.updateSpreadsheet([
  { op: "addSheet", title: "Q4", index: 1, rowCount: 100, columnCount: 5 },
  { op: "writeCells", range: "'Q4'!A1", values: [["Forecast"]] },
  { op: "renameSheet", sheet: "Q4", title: "Q4 2026" },
  { op: "duplicateSheet", sheet: "Sales", title: "Copy", index: 2 },
  { op: "insertRows", sheet: "Copy", at: 3, count: 2 },
  { op: "deleteRows", sheet: "Sales", at: 5 },
  { op: "insertColumns", sheet: "Sales", at: "C" },
  { op: "deleteColumns", sheet: "Sales", at: "C", count: 2 },
  { op: "deleteSheet", sheet: "Copy" },
]);
// @ts-expect-error Columns are named by their letters.
sheet.updateSpreadsheet([{ op: "insertColumns", sheet: "Sales", at: 3 }]);
// @ts-expect-error A sheet is named by its title, not its ID.
sheet.updateSpreadsheet([{ op: "deleteSheet", sheet: 0 }]);
// @ts-expect-error A sheet added needs a title.
sheet.updateSpreadsheet([{ op: "addSheet" }]);
`)
      // The agent's runtime provides the module Chat's declarations import.
      .filter(message => !message.includes("'cloudflare:workers'"))).toEqual([]);
    expect(compileAgentTypes(sheetsBundle() +
      "\nconst readable: GoogleSpreadsheetReadSession = null! as GoogleSpreadsheetSession;\n"))
      .toEqual([]);
    // Only a read and write Drive binding's bundle carries the spreadsheet write types.
    const readNames = topLevelNames(driveReadBundle());
    expect(readNames).toContain("GoogleSpreadsheetReadSession");
    expect(readNames).not.toContain("GoogleSpreadsheetSession");
    expect(readNames).not.toContain("SheetChange");
    const writeNames = topLevelNames(driveWriteBundle());
    expect(writeNames).toContain("GoogleSpreadsheetSession");
    expect(writeNames).toContain("SheetChange");
    expect(source("sheets-types.d.ts")).toContain(
      "export interface GoogleSpreadsheetSession extends GoogleSpreadsheetReadSession",
    );
  });

  it.each([
    ["vendor", vendorBundle],
    ["Drive", driveReadBundle],
    ["Drive read and write", driveWriteBundle],
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

  it("hands out read-only native sessions from a read-only Drive binding", () => {
    const readTypes = source("drive-read-types.d.ts");
    expect(readTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(readTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>",
    );
    expect(readTypes).toContain(
      "openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession>",
    );
    expect(readTypes).toContain("export interface GoogleDriveReadSession");
    expect(readTypes).not.toContain("GoogleDocSession>");
    expect(readTypes).not.toContain("GoogleSpreadsheetSession>");
    expect(readTypes).not.toContain("GooglePresentationSession>");
    expect(topLevelNames(driveReadBundle())).not.toContain("GooglePresentationSession");
    expect(topLevelNames(driveReadBundle())).not.toContain("GoogleSpreadsheetSession");
  });

  it("hands out editable spreadsheets and presentations from every read and write Drive session", () => {
    const writeTypes = source("drive-types.d.ts");
    expect(writeTypes.split("openGoogleSlides(fileId: string): Promise<GooglePresentationSession>;"))
      .toHaveLength(4);
    expect(writeTypes.split("openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetSession>;"))
      .toHaveLength(4);
    expect(writeTypes).not.toContain("GoogleDocSession>");
    expect(topLevelNames(driveWriteBundle())).toContain("GooglePresentationSession");
    expect(topLevelNames(driveWriteBundle())).toContain("GoogleSpreadsheetSession");
    expect(compileAgentTypes(driveWriteBundle() + `
      declare const drive: GoogleDriveSession;
      declare const folder: GoogleDriveFolderSession;
      declare const file: GoogleDriveFileSession;
      async function edit() {
        for (const binding of [drive, folder, file]) {
          const deck = await binding.openGoogleSlides("deck");
          await deck.updateSlides([{ op: "editText", slideId: "s", elementId: "e", find: "a", replace: "b" }]);
          const sheet = await binding.openGoogleSheet("sheet");
          await sheet.updateSpreadsheet([{ op: "clearRange", range: "Sheet1!A1:B2" }]);
        }
      }
    `)).toEqual([]);
  });

  it("declares comment reads on both read-only Drive sessions, and no write", () => {
    const readTypes = source("drive-read-types.d.ts");
    expect(readTypes.split("listComments(fileId: string): Promise<Cursor<DriveComment>>;"))
      .toHaveLength(3);
    // A comment's and a reply's times are dates; only a comment carries the text it is attached to.
    const commentTypes = source("comment-types.d.ts");
    expect(commentTypes.split("modifiedTime?: Date;")).toHaveLength(3);
    expect(commentTypes.split("quotedText?: string;")).toHaveLength(2);
    const names = topLevelNames(driveReadBundle());
    for (const name of [
      "DriveBindingAccess", "DriveComment", "DriveCommentReply", "GoogleDriveReadSession",
      "GoogleDriveFolderReadSession",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of [
      "DriveCommentWrites", "DriveCommentOptions", "DriveSuggestEditOptions",
      "GoogleDriveSession",
      "GoogleDriveFileSession", "GoogleDriveFolderSession", "DriveSharing", "DriveAccess",
      "DriveGrantee", "DriveShareRole", "DriveRole", "DriveShareOptions",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(readTypes).not.toMatch(/^\s+(comment|suggestEdit|reply|resolve)\(/m);
    // An unused `@ts-expect-error` is itself a diagnostic, so a write method on a read shape, or a
    // comment time typed as a string, fails this.
    expect(compileAgentTypes(driveReadBundle() + `
declare const drive: GoogleDriveReadSession;
declare const folder: GoogleDriveFolderReadSession;
async function use(): Promise<void> {
  const cursor = await drive.listComments("file-1");
  const page: DriveComment[] | null = await cursor.next();
  const resolved: boolean | undefined = page?.[0]?.resolved;
  const quoted: string | undefined = page?.[0]?.quotedText;
  const created: Date | undefined = page?.[0]?.createdTime;
  const modified: Date | undefined = page?.[0]?.replies[0]?.modifiedTime;
  const pending: true | undefined = page?.[0]?.replies[0]?.pending;
  const action: "resolve" | "reopen" | undefined = page?.[0]?.replies[0]?.action;
  await (await folder.listComments("file-2")).next();
  const child: GoogleDriveFolderReadSession = await folder.openFolder("folder-1");
  const scope: DriveScope = await drive.getScope();
  const access: "read" | "write" = scope.access;
  const folderAccess: DriveBindingAccess = (await folder.getScope()).access;
}
// @ts-expect-error A scope always says its binding's access.
const bare: DriveScope = { kind: "account" };
// @ts-expect-error A read-only binding has no comment().
drive.comment("file-1", "Why?");
// @ts-expect-error A read-only binding has no suggestEdit().
drive.suggestEdit("file-1", "May", "June");
// @ts-expect-error A read-only binding has no reply().
drive.reply("file-1", "doco.x", "Agreed.");
// @ts-expect-error A read-only binding has no resolve().
drive.resolve("file-1", "doco.x");
// @ts-expect-error A read-only folder binding has no comment().
folder.comment("file-1", "Why?");
// @ts-expect-error A read-only folder binding has no resolve().
folder.resolve("file-1", "doco.x");
// @ts-expect-error Drive marks a reply as resolving or reopening, nothing else.
const deleting: DriveCommentReply = { id: "r", author: { displayName: "A", me: false }, text: "", createdTime: new Date(0), action: "delete" };
// @ts-expect-error A comment's times are dates, not strings.
const stamped: DriveCommentReply = { id: "r", author: { displayName: "A", me: false }, text: "", createdTime: "2026-10-20T10:00:00Z" };
`)).toEqual([]);
  });

  it("declares the comment writes once, for every read and write Drive session", () => {
    const writeTypes = source("drive-types.d.ts");
    for (const signature of [
      "comment(fileId: string, text: string, options?: DriveCommentOptions): Promise<DriveComment>;",
      "fileId: string, oldText: string, newText: string, options?: DriveSuggestEditOptions,\n  ): Promise<DocSuggestion>;",
      "reply(fileId: string, commentId: string, text: string): Promise<DriveCommentReply>;",
      "resolve(fileId: string, commentId: string, text?: string): Promise<DriveCommentReply>;",
    ]) {
      expect(writeTypes.split(signature), signature).toHaveLength(2);
    }
    expect(topLevelNames(stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX)))
      .toEqual([
        "DriveCommentOptions", "DriveSuggestEditOptions", "DriveCommentWrites",
        "DriveShareRole",
        "DriveRole", "DriveGrantee", "DriveShareOptions", "DriveAccess", "DriveSharing",
        "GoogleDriveSession", "GoogleDriveFileSession", "GoogleDriveFolderSession",
      ]);
    expect(duplicates(topLevelNames(driveWriteBundle()))).toEqual([]);
    expect(compileAgentTypes(driveWriteBundle() + `
declare const drive: GoogleDriveSession;
declare const file: GoogleDriveFileSession;
declare const folder: GoogleDriveFolderSession;
async function use(): Promise<void> {
  const queued: DriveComment = await drive.comment("file-1", "Why?", { quote: "May", tabId: "t.0" });
  const suggested: DocSuggestion = await file.suggestEdit("file-1", "May", "June", { note: "It moved." });
  const replaced: string = suggested.oldText;
  const pendingSuggestion: true = suggested.pending;
  // @ts-expect-error A suggestion is not a comment.
  const asComment: DriveComment = await drive.suggestEdit("file-1", "May", "June");
  const reply: DriveCommentReply = await folder.reply("file-1", "doco.x", "Agreed.");
  await file.resolve("file-1", "doco.x");
  await drive.resolve("file-1", "doco.x", "Fixed.");
  await (await file.listComments("file-1")).next();
  const child: GoogleDriveFolderSession = await folder.openFolder("folder-1");
  await child.comment("file-2", "Here too.");
  const readable: GoogleDriveReadSession = drive;
  const readableFile: GoogleDriveReadSession = file;
  const readableFolder: GoogleDriveFolderReadSession = folder;
  if ((await folder.getScope()).access === "write") await folder.comment("file-1", "Why?");
}
// @ts-expect-error A comment is attached only by quoting, never by a raw anchor.
drive.comment("file-1", "Why?", { anchor: "kix.1" });
declare const readOnly: GoogleDriveReadSession;
// @ts-expect-error A read-only session is not a read and write one.
const widened: GoogleDriveSession = readOnly;
`)).toEqual([]);
  });

  it("gives a directly bound Doc its own comments", () => {
    const docTypes = source("docs-types.d.ts");
    for (const signature of [
      "listComments(): Promise<DriveComment[]>;",
      "comment(text: string, options: DocCommentOptions): Promise<DriveComment>;",
      "oldText: string, newText: string, options?: DocSuggestEditOptions,\n  ): Promise<DocSuggestion>;",
      "reply(commentId: string, text: string): Promise<DriveCommentReply>;",
      "resolve(commentId: string, text?: string): Promise<DriveCommentReply>;",
    ]) {
      expect(docTypes.split(signature), signature).toHaveLength(2);
    }
    expect(compileAgentTypes(docBundle() + `
declare const doc: GoogleDocSession;
async function use(): Promise<void> {
  const comments: DriveComment[] = await doc.listComments();
  const queued: DriveComment = await doc.comment("Why?", { quote: "May", tabId: "t.0" });
  const once: DriveComment = await doc.comment("Why?", { quote: "May" });
  const suggested: DocSuggestion = await doc.suggestEdit("May", "June", { note: "It moved." });
  const reply: DriveCommentReply = await doc.reply(comments[0].id, "Agreed.");
  await doc.resolve(comments[0].id);
  await doc.resolve(comments[0].id, "Fixed.");
  const id: string = (await doc.getMetadata()).id;
}
// @ts-expect-error A comment on a bound Doc quotes the text it is about.
doc.comment("Why?");
// @ts-expect-error A comment on a bound Doc quotes the text it is about.
doc.comment("Why?", {});
// @ts-expect-error A bound Doc's methods take no file ID.
doc.comment("doc-1", "Why?", { quote: "May" });
// @ts-expect-error A bound Doc's methods take no file ID.
doc.reply("doc-1", "doco.x", "Agreed.");
// @ts-expect-error A bound Doc's methods take no file ID.
doc.suggestEdit("doc-1", "May", "June", {});
`)).toEqual([]);
  });

  it("declares sharing once, for every read and write Drive session, and moves for two of them", () => {
    const writeTypes = source("drive-types.d.ts");
    for (const signature of [
      "listAccess(fileId: string): Promise<DriveAccess[]>;",
      "fileId: string, grantee: DriveGrantee, role: DriveShareRole, options?: DriveShareOptions,\n  ): Promise<DriveAccess>;",
      "fileId: string, access: string | DriveGrantee, role: DriveShareRole,\n  ): Promise<DriveAccess>;",
      "unshare(fileId: string, access: string | DriveGrantee): Promise<void>;",
    ]) {
      expect(writeTypes.split(signature), signature).toHaveLength(2);
    }
    // The account and folder sessions each declare a move; the file session declares none.
    expect(writeTypes.split("move(fileId: string, folderId: string): Promise<void>;"))
      .toHaveLength(3);
    // The file says nothing of how changes are queued for the user's approval.
    for (const word of ["submitAction", "applyAction", "revert", "journal"]) {
      expect(writeTypes, word).not.toContain(word);
    }
    // The compiler is all that holds these seams for typed callers: an unused `@ts-expect-error`
    // is itself a diagnostic, so a refused call that the types accept fails this.
    expect(compileAgentTypes(driveWriteBundle() + `
declare const drive: GoogleDriveSession;
declare const file: GoogleDriveFileSession;
declare const folder: GoogleDriveFolderSession;
async function stories(): Promise<void> {
  const access: DriveAccess[] = await drive.listAccess("file-1");
  const others = access.filter(entry => !entry.me && !entry.inherited && !entry.pending);
  const source: string | undefined = access[0].inheritedFrom;
  const pending: DriveAccess = await drive.share(
    "file-1", { type: "user", emailAddress: "bob@example.com" }, "writer", { message: "Here it is." });
  await file.share("file-1", { type: "group", emailAddress: "team@example.com" }, "commenter", { notify: false });
  await folder.share("child-1", { type: "domain", domain: "example.com" }, "reader", { discoverable: true });
  await drive.share("file-1", { type: "anyone" }, "reader");
  const changed: DriveAccess = await drive.updateAccess("file-1", others[0].id, "reader");
  await drive.updateAccess("file-1", { type: "user", emailAddress: "bob@example.com" }, "writer");
  await file.unshare("file-1", others[0].id);
  await file.unshare("file-1", { type: "group", emailAddress: "team@example.com" });
  const address: string | undefined = others[0].emailAddress;
  const shown: string | undefined = others[0].displayName;
  await drive.share("file-2", { type: "user", emailAddress: address ?? "bob@example.com" }, "reader");
  const scope: DriveScope = await folder.getScope();
  if (scope.kind === "folder") {
    await folder.share(scope.folderId, { type: "anyone" }, "reader");
    if (scope.parentFolderId !== undefined) await folder.move("child-1", scope.parentFolderId);
  }
  await folder.move("child-1", "child-folder");
  const child: GoogleDriveFolderSession = await folder.openFolder("child-folder");
  await child.share("grandchild", { type: "anyone" }, "reader");
  await drive.move("file-1", "folder-9");
  await drive.move("file-1", "root");
  const role: DriveRole = access[0].role;
}
// @ts-expect-error A single-file binding cannot move its file.
file.move("file-1", "folder-9");
// @ts-expect-error Ownership cannot be given.
drive.share("file-1", { type: "user", emailAddress: "bob@example.com" }, "owner");
// @ts-expect-error A shared drive's manager role cannot be given.
drive.updateAccess("file-1", "1", "organizer");
// @ts-expect-error A grantee is not named by a Drive ID.
drive.share("file-1", { type: "user", id: "1" }, "reader");
// @ts-expect-error Access is named by its ID or by a grantee.
drive.unshare("file-1", 7);
// @ts-expect-error No expiry.
drive.share("file-1", { type: "anyone" }, "reader", { expires: "2027-01-01" });
// @ts-expect-error No ownership transfer.
drive.share("file-1", { type: "anyone" }, "reader", { transferOwnership: true });
// @ts-expect-error A move takes one destination and nothing else.
drive.move("file-1", "folder-9", { driveId: "d" });
// @ts-expect-error A domain grantee carries no address.
const mixed: DriveGrantee = { type: "domain", emailAddress: "a@example.com" };
// @ts-expect-error A grantee's address is spelled emailAddress.
drive.share("file-1", { type: "user", email: "bob@example.com" }, "reader");
declare const entry: DriveAccess;
// @ts-expect-error An entry's address is spelled emailAddress.
entry.email;
// @ts-expect-error An entry's name is spelled displayName.
entry.name;
// The literal above also lacks its domain, so this one holds the seam on the address alone.
// @ts-expect-error A domain grantee carries no address, even with its domain.
const mixedWithDomain: DriveGrantee = { type: "domain", domain: "example.com", emailAddress: "a@example.com" };
`)).toEqual([]);
  });

  it("gives a read-only Drive session no sharing and no move, and a folder scope its parent", () => {
    const readTypes = source("drive-read-types.d.ts");
    expect(readTypes).not.toMatch(/^\s+(listAccess|share|updateAccess|unshare|move)\(/m);
    expect(compileAgentTypes(driveReadBundle() + `
declare const drive: GoogleDriveReadSession;
declare const folder: GoogleDriveFolderReadSession;
async function use(): Promise<void> {
  const scope = await folder.getScope();
  const parent: string | undefined = scope.kind === "folder" ? scope.parentFolderId : undefined;
}
// @ts-expect-error A read-only binding has no sharing.
drive.listAccess("file-1");
// @ts-expect-error A read-only binding has no share().
drive.share("file-1", { type: "anyone" }, "reader");
// @ts-expect-error A read-only binding has no move().
drive.move("file-1", "folder-9");
// @ts-expect-error A read-only folder binding has no unshare().
folder.unshare("file-1", "1");
// @ts-expect-error A read-only folder binding has no move().
folder.move("file-1", "folder-9");
`)).toEqual([]);
  });

  it("points each Sheets and Slides session at its comments with a read-only Drive URL", () => {
    for (const [name, bundle] of [
      ["sheets-types.d.ts", sheetsBundle], ["slides-types.d.ts", slidesBundle],
    ] as const) {
      expect(source(name), name).toContain("https://drive.google.com/file/d/<id>/view");
      // The URL an agent is given to read with asks for no more than read-only access.
      expect(source(name), name).not.toContain("/view?access=write");
      expect(compileAgentTypes(bundle()), name).toEqual([]);
    }
  });

  it("streams PDF text from both Drive sessions", () => {
    const readTypes = source("drive-read-types.d.ts");
    expect(readTypes).toContain("export type DrivePdfText = {");
    expect(readTypes.split("readPdf(fileId: string): Promise<DrivePdfText>;")).toHaveLength(3);
    for (const [bundle, account, folder] of [
      [driveReadBundle, "GoogleDriveReadSession", "GoogleDriveFolderReadSession"],
      [driveWriteBundle, "GoogleDriveSession", "GoogleDriveFolderSession"],
    ] as const) {
      expect(compileAgentTypes(bundle() + `
declare const drive: ${account};
declare const folder: ${folder};
async function read(): Promise<string> {
  const { text, hasText } = await drive.readPdf("file-1");
  const flag: boolean = hasText;
  const reader = (await folder.readPdf("file-2")).text.getReader();
  const first: Uint8Array | undefined = (await reader.read()).value;
  await reader.cancel();
  return new Response(text).text();
}
// @ts-expect-error The text is a stream, not a string.
const whole: DrivePdfText = { text: "", hasText: true };
// @ts-expect-error Nothing is cut, so there is no truncation flag.
const cut: DrivePdfText = { text: new ReadableStream(), hasText: true, truncated: false };
`), account).toEqual([]);
    }
  });

  it("streams a file's bytes from both Drive sessions, whole or by range", () => {
    for (const [bundle, account, folder] of [
      [driveReadBundle, "GoogleDriveReadSession", "GoogleDriveFolderReadSession"],
      [driveWriteBundle, "GoogleDriveSession", "GoogleDriveFolderSession"],
    ] as const) {
      expect(compileAgentTypes(bundle() + `
declare const drive: ${account};
declare const folder: ${folder};
declare const worktree: { writeBytes(path: string, content: ReadableStream<Uint8Array>): Promise<void> };
async function readCsv(): Promise<string> {
  const whole = await drive.readFile("file-1");
  const text = await new Response(whole.content).text();
  const first = await folder.readFile("file-2", { offset: 16, length: 1024 });
  const rest: boolean = first.offset + first.length < first.size;
  const changed: boolean = first.modifiedTime.getTime() > 0;
  await worktree.writeBytes("data/file-2.bin", first.content);
  return text + first.mimeType + rest + changed;
}
// @ts-expect-error The content is a stream, not the bytes themselves.
const held: DriveFileBytes = { mimeType: "text/csv", size: 1, modifiedTime: new Date(), offset: 0, length: 1, content: new Uint8Array(1) };
`), account).toEqual([]);
    }
  });
});
