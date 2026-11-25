// A Google Doc's gatekeeper, sessions and Drive editors keep nothing of a document between two
// requests: a census of the source's fields and variables, then what a second read does.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  pendingDocKeys, replayGoogleDoc, type GoogleDocPendingAction, type GoogleDocReplayQueue,
} from "../src/doc-actions";
import type { GoogleDocsDocument } from "../src/docs-api";
import { storedDocCopy, StoredDocCopy, type DocCopy } from "../src/docs-copy";
import { replayCost } from "../src/docs-model";
import { DOC_COPY_UNREADABLE } from "../src/docs-replica";
import { DocStore, docStoreCost } from "../src/docs-store";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { buildTab, para } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";

const SRC = path.resolve(import.meta.dirname, "../src");

const parsed = (name: string): ts.SourceFile =>
  ts.createSourceFile(name, readFileSync(path.join(SRC, name), "utf8"), ts.ScriptTarget.ES2022, true);

/** Every node under `root`, itself included. */
function nodesOf(root: ts.Node): ts.Node[] {
  let found: ts.Node[] = [];
  let visit = (node: ts.Node) => {
    found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** The names of the properties class `name` of `file` declares, in order. */
function fieldsOf(file: string, name: string): string[] {
  let declared = parsed(file).statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name);
  if (!declared) throw new Error(`${file} declares no class ${name}`);
  return declared.members.filter(ts.isPropertyDeclaration).map(member => member.name.getText());
}

/** Function `name` of `file`, declared at its top level. */
function functionOf(file: string, name: string): ts.FunctionDeclaration {
  let declared = parsed(file).statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declared?.body) throw new Error(`${file} declares no function ${name}`);
  return declared;
}

/** The parameters of function `name` of `file`, and the variables its body declares at its top level. */
function declaredBy(file: string, name: string): { parameters: string[]; variables: string[] } {
  let declared = functionOf(file, name);
  return {
    parameters: declared.parameters.map(parameter => parameter.name.getText()),
    variables: declared.body!.statements.filter(ts.isVariableStatement).flatMap(statement =>
      statement.declarationList.declarations.map(declaration => declaration.name.getText())),
  };
}

/** Method `name` of class `owner` of `file`. */
function methodOf(file: string, owner: string, name: string): ts.MethodDeclaration {
  let declared = nodesOf(parsed(file)).find((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && node.name.getText() === name &&
    ts.isClassDeclaration(node.parent) && node.parent.name?.text === owner);
  if (!declared) throw new Error(`${owner} of ${file} declares no method ${name}`);
  return declared;
}

describe("what is kept between two requests, by the source's own text", () => {
  it("a bound Doc's gatekeeper keeps these fields and no other", () => {
    expect(fieldsOf("docs.ts", "GoogleDocGatekeeperImpl")).toEqual(Object.keys({
      "#store": "the storage handle, a format string and a digest",
      "#copy": "a fetch in flight, a counter and a flag (the next test)",
      "#spentRevision": "a revision id",
      "#moves": "a number",
      "#fetched": "a revision id and a number",
      "#simulationCache": "a number",
      "#writes": "the turns of the writes that are waiting",
      "#actions": "the lock approvals and rejections take",
      "#tokens": "an access token",
      "#commentJournal": "the storage handle, for the comment writes' records",
      "#commentAttempts": "the storage handle, for the comment writes' attempt markers",
      "#comments": "the comment writes' definitions bound to that journal",
      "#reads": "the reads waiting on a comment write",
    }));
    expect(fieldsOf("docs-store.ts", "DocStore")).toEqual(["#storage", "#format", "#made", "#sizes"]);
  });

  it("the copy's lifecycle keeps a fetch in flight and nothing of a document", () => {
    expect(fieldsOf("docs-copy.ts", "StoredDocCopy")).toEqual(Object.keys({
      "#store": "the store",
      "#doc": "the document's key",
      "#storage": "the storage handle, for the keys nothing reads",
      "#source": "the function that fetches",
      "#ttlMs": "a number",
      "#unchanged": "the function that asks for the revision",
      "#pending": "the function that reads the pending records",
      "#now": "the clock",
      "#epoch": "a counter",
      "#flights": "the fetch in flight, until it is answered",
      "#unreadGone": "a flag",
    }));
  });

  it("a Doc session keeps its dependencies and nothing it read", () => {
    expect(fieldsOf("docs.ts", "GoogleDocSessionImpl")).toEqual([
      "#docsApi", "#driveApi", "#documentId", "#approvalQueue", "#read", "#changes", "#source",
      "#comments",
    ]);
    expect(fieldsOf("docs.ts", "GoogleDocReadSessionImpl")).toEqual(["#session"]);
    expect(fieldsOf("docs.ts", "GoogleDocEditSessionImpl")).toEqual(["#session"]);
    expect(fieldsOf("doc-comments.ts", "DocCommentSession")).toEqual(["#deps"]);
  });

  it("a Drive session and its folder core keep their dependencies and nothing they read", () => {
    expect(fieldsOf("google.ts", "GoogleDriveSessionImpl")).toEqual(Object.keys({
      "#core": "the session's core (below)",
      "#driveApi": "an API client", "#docsApi": "an API client", "#sheetsApi": "an API client",
      "#slidesApi": "an API client",
      "#convertPdf": "a function",
      "#scope": "the binding's scope: a kind and an id",
      "#location": "the saved path: folder ids",
      "#approvalQueue": "a stub",
      "#writes": "functions of the connection",
      "#editors": "the binding's editors (the next test)",
      "#docCopies": "a function of the connection's editors: what the store keeps of a file",
      "#docRefused": "a function of the connection's editors, told of a refused file: it holds no document",
    }));
    expect(fieldsOf("drive-session.ts", "DriveFolderSessionCore")).toEqual(Object.keys({
      "#location": "the saved path: folder ids",
      "#refused": "the function a refusal of a file tells, the session's `#docRefused`",
    }));
  });

  it("a Drive binding's editors keep queues, counters and sources, and no document", () => {
    expect(fieldsOf("drive-editors.ts", "DriveFileEditors")).toEqual(Object.keys({
      "#options": "the binding's dependencies",
      "#files": "a queue a file",
      "#docCaches": "a file's writes counted, its revision moves, and its source (the next test)",
      "#docLimits": "the limits of the store's copies (below): no document and no record of one",
    }));
    expect(fieldsOf("docs-copy.ts", "DriveDocCopyLimits")).toEqual(Object.keys({
      "#options": "the store's maker, two functions of the binding, the caps (two numbers), " +
        "the binding's KV and the clock",
      "#passed": "the hour of the last finished expiry pass: a number",
    }));
    // A keep reads the copies' records and lets them go: none is declared outside it.
    expect(declaredBy("docs-copy.ts", "copiesOverCap")).toEqual({
      parameters: ["copies", "keeping", "pending", "caps"],
      variables: Object.keys({
        left: "a number", bytes: "a number",
        candidates: "the records but the kept one's, for the length of the call",
        over: "the keys of the copies to remove, with the cap each is taken for",
      }),
    });
  });

  it("a Drive connection's object has no alarm: nothing wakes it to remove a stored copy", () => {
    let source = parsed("google.ts");
    let classOf = (node: ts.Node): string | undefined => {
      for (let at: ts.Node | undefined = node; at; at = at.parent) {
        if (ts.isClassDeclaration(at)) return at.name?.text;
      }
      return undefined;
    };
    let connection = source.statements.find((statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "GoogleDriveGatekeeperImpl");
    expect(connection).toBeDefined();
    expect(connection!.members.map(member => member.name?.getText())).not.toContain("alarm");
    // The file's alarms are the account object's: no other class sets one.
    let setters = nodesOf(source).filter((node): node is ts.Identifier =>
      ts.isIdentifier(node) && node.text === "setAlarm");
    expect(setters.length).toBeGreaterThan(0);
    expect([...new Set(setters.map(classOf))]).toEqual(["UserAccount"]);
    // Nor do the modules a connection's Docs are stored and edited through.
    for (let file of ["docs-copy.ts", "docs-store.ts", "drive-editors.ts", "docs.ts", "drive-session.ts"]) {
      expect(readFileSync(path.join(SRC, file), "utf8"), file).not.toMatch(/\bsetAlarm\b/);
    }
  });

  it("a Drive source keeps which snapshot was approved, and a fetched document only until " +
    "its read is decided", () => {
    expect(declaredBy("docs.ts", "driveDocSource").variables).toEqual(Object.keys({
      writes: "a function",
      queued: "a function",
      revisionMoves: "a function",
      fetchedAfter: "weak: counters and a clock, by snapshot",
      fetched: "weak: the held document of a snapshot fetched and not kept yet, its runs' JSON as bytes",
      spent: "weak: the snapshots a batch was built from",
      inFlight: "the fetch in flight",
      approved: "a snapshot: a revision id, a clock and a view, which holds the copy's record",
      next: "a function",
    }));
    // The bound Doc's source declares its two functions and no variable.
    expect(declaredBy("docs.ts", "storedDocSource").variables).toEqual([]);
  });

  it("the factories of a copy's views keep ids and no content", () => {
    // `head` is the copy's record: its id, revision, clocks, outline and base versions' ids.
    expect(declaredBy("docs-copy.ts", "storedDocCopy"))
      .toEqual({ parameters: ["store", "doc", "head", "options"], variables: [] });
    expect(declaredBy("docs-copy.ts", "unkeptDocCopy"))
      .toEqual({ parameters: ["stored", "outline"], variables: [] });
    expect(declaredBy("docs-copy.ts", "driveDocCopies")).toEqual({
      parameters: ["store", "doc", "pending", "limits"],
      variables: Object.keys({ tried: "a function: the trial of a document it is handed" }),
    });
    // The store object: a storage handle, a format string and a digest. `store` is the
    // function that makes it.
    expect(declaredBy("docs-copy.ts", "lazyDocStore"))
      .toEqual({ parameters: ["storage"], variables: ["made", "store"] });
    expect(declaredBy("docs.ts", "docSourceUnder"))
      .toEqual({ parameters: ["source", "folder"], variables: [] });
    expect(declaredBy("doc-actions.ts", "replayDoc")).toEqual({
      parameters: ["queue", "copy", "context"],
      variables: Object.keys({
        active: "the pending records that carry no reason",
        targets: "a function",
        view: "the records by the entity each targets",
        targeted: "a set of tab ids",
        invalidated: "a set of record ids",
        live: "a function",
        settle: "a function",
        tree: "the fold of the outline",
        outline: "the tabs' identities",
        listed: "a set of tab ids",
        tabFold: "the tab fold, made in the call",
        answered: "the versions answered, by tab id",
      }),
    });
  });

  it("a replay, and the tab in hand it holds, is reachable from the read that made it alone", () => {
    let source = parsed("docs.ts");
    let calls = nodesOf(source).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText() === "this.#replay");
    expect(calls.length).toBeGreaterThan(0);
    for (let call of calls) {
      // Read for its outline where it is made, or named `replay` in `#simulate`.
      let outline = ts.isPropertyAccessExpression(call.parent) && call.parent.name.text === "outline";
      let named = ts.isVariableDeclaration(call.parent) && call.parent.name.getText() === "replay";
      expect(outline || named, call.parent.getText()).toBe(true);
    }
    // In `#simulate` the replay is read through, and neither returned, stored nor passed on.
    let simulate = methodOf("docs.ts", "GoogleDocSessionImpl", "#simulate");
    let uses = nodesOf(simulate.body!).filter(node =>
      ts.isIdentifier(node) && node.text === "replay" && !ts.isVariableDeclaration(node.parent));
    expect(uses.length).toBeGreaterThan(0);
    for (let use of uses) {
      expect(ts.isPropertyAccessExpression(use.parent) && use.parent.expression === use,
        use.parent.getText()).toBe(true);
    }
    let selected = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "GoogleDocSelectedTab");
    expect(selected?.getText()).toContain("DocVersion");
    expect(selected?.getText()).not.toContain("GoogleDocReplay");
  });

  it("no Docs module keeps a map or a variable between two requests", () => {
    const FILES = [
      "docs.ts", "doc-actions.ts", "docs-replay.ts", "docs-replica.ts", "docs-copy.ts",
      "docs-store.ts", "docs-reading.ts", "docs-table-actions.ts", "docs-tables.ts",
      "docs-table-look.ts", "doc-comments.ts", "docs-model.ts", "markdown-converter.ts",
      "drive-editors.ts",
    ];
    /** Whether `node` makes a collection where the module is loaded, outside any function. */
    let collects = (node: ts.Node): boolean => {
      if (ts.isFunctionLike(node)) return false;
      if (ts.isNewExpression(node) &&
          ["Map", "WeakMap", "Set", "WeakSet"].includes(node.expression.getText())) return true;
      return node.forEachChild(collects) ?? false;
    };
    let kept: Record<string, string[]> = {};
    for (let file of FILES) {
      for (let statement of parsed(file).statements) {
        if (!ts.isVariableStatement(statement)) continue;
        let constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (let declaration of statement.declarationList.declarations) {
          if (constant && !collects(declaration)) continue;
          (kept[file] ??= []).push(declaration.name.getText());
        }
      }
    }
    expect(kept).toEqual({
      // The text of the bundle's type declarations, joined once.
      "docs.ts": ["googleDocTypesCode"],
      // Weak: it names the tabs the model returned, and keeps none alive.
      "docs-model.ts": ["indexed"],
      // Weak: how many runs a tab still in a caller's hand is. It keeps none alive.
      "docs-store.ts": ["runsOfTab"],
      // A constant: the editor of each action tag.
      "drive-editors.ts": ["EDITOR_BY_NAME"],
    });
    // The two objects that change as the module runs hold counts and nothing else.
    for (let counters of [docStoreCost, replayCost]) {
      expect(Object.values(counters).every(count => typeof count === "number")).toBe(true);
    }
  });

  it("a session with no storage is the one place a source holds a document", () => {
    // `inHandDocCopies` closes over a held document: only for a session with no storage.
    expect(declaredBy("docs-copy.ts", "inHandDocCopies")).toEqual({ parameters: [], variables: [] });
    expect(declaredBy("docs-copy.ts", "inHandDocCopy"))
      .toEqual({ parameters: ["document"], variables: [] });
    let makers = nodesOf(parsed("docs-copy.ts")).filter(node =>
      ts.isIdentifier(node) && node.text === "inHandDocCopy" &&
      !ts.isFunctionDeclaration(node.parent));
    let within = functionOf("docs-copy.ts", "inHandDocCopies");
    expect(makers.length).toBeGreaterThan(0);
    for (let maker of makers) {
      expect(maker.pos >= within.pos && maker.end <= within.end, maker.parent.getText()).toBe(true);
    }
    // Called only by a Drive session with no store and a read-only Doc session.
    let callers: string[] = [];
    let sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter(file => /\.tsx?$/.test(file)).toSorted();
    for (let file of sources) {
      for (let node of nodesOf(parsed(file))) {
        if (!ts.isCallExpression(node) || node.expression.getText() !== "inHandDocCopies") continue;
        let owner: ts.Node = node;
        while (!ts.isClassDeclaration(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
        let method: ts.Node = node;
        while (!ts.isMethodDeclaration(method) && !ts.isConstructorDeclaration(method) &&
            !ts.isSourceFile(method)) method = method.parent;
        callers.push([
          file, ts.isClassDeclaration(owner) ? owner.name?.text : "",
          ts.isMethodDeclaration(method) ? method.name.getText() : "constructor",
        ].join(" "));
      }
    }
    expect(callers).toEqual([
      "docs.ts GoogleDocReadSessionImpl constructor",
      "google.ts GoogleDriveSessionImpl #docCopiesOf",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The same, by what a second read does
// ---------------------------------------------------------------------------

const DOC = "doc";
const TAB = "tab-1";
const line = (at: number) => `Line ${String(at).padStart(5, "0")}.`;

/** A document of one tab of 20,000 paragraphs. */
const large = (): GoogleDocsDocument => ({
  documentId: "doc-1", title: "Large", revisionId: "r1",
  tabs: [buildTab(Array.from({ length: 20_000 }, (_, at) => para(line(at))))],
});

const EDIT: GoogleDocPendingAction = {
  id: 1,
  action: {
    type: "replaceText", tabId: TAB, oldMarkdown: line(7), newMarkdown: "Changed.",
    submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, display: { tab: "x" },
  },
};

/** A bound Doc's copy over its own store with `pending` queued, kept across reads as when awake. */
async function boundHost(pending: GoogleDocPendingAction[] = []) {
  let storage = fakeDocStorage();
  let store = new DocStore(storage);
  let fetches = 0;
  let lifecycle = new StoredDocCopy({
    store, doc: DOC, storage, ttlMs: 60_000,
    fetch: async () => {
      fetches++;
      return large();
    },
    pending: () => pendingDocKeys(store, DOC, pending),
  });
  let queue: GoogleDocReplayQueue = {
    pending: () => pending,
    invalidate: (_record, reason) => { throw new Error(reason); },
  };
  let { copy } = await lifecycle.current();
  /** The tab as a pending read answers it, through `view`. */
  let read = (view: DocCopy = copy) =>
    view.markdown(replayGoogleDoc(queue, view, "A read").tab(TAB)!);
  return { storage, store, lifecycle, copy, read, fetches: () => fetches };
}

/** What `run` adds to the store's counts. */
function spent<T>(run: () => T): { value: T } & Record<"decoded" | "rendered" | "stored" | "found", number> {
  let before = { ...docStoreCost };
  let value = run();
  return {
    value,
    decoded: docStoreCost.runsDecoded - before.runsDecoded,
    rendered: docStoreCost.runsRendered - before.runsRendered,
    stored: docStoreCost.resultsStored - before.resultsStored,
    found: docStoreCost.resultsFound - before.resultsFound,
  };
}

describe("a bound Doc's copy, read twice through the same objects", () => {
  it("a second read decodes the tab again once its Markdown is gone from storage", async () => {
    let { storage, read } = await boundHost();
    let first = read();
    // Stored: the same read again decodes and renders nothing.
    expect(spent(read)).toMatchObject({ value: first, decoded: 0, rendered: 0 });

    let { runs } = storage.sql.exec<{ runs: number }>("SELECT count(*) AS runs FROM doc_seq").one();
    expect(runs).toBe(133);
    storage.sql.exec("DELETE FROM doc_md").toArray();
    // Nothing remembered: each run is decoded and rendered again.
    expect(spent(read)).toMatchObject({ value: first, decoded: runs, rendered: runs });
  });

  it("a second read makes a pending edit again once its result is gone from storage", async () => {
    let { storage, read } = await boundHost([EDIT]);
    let first = spent(read);
    expect(first).toMatchObject({ stored: 1, found: 0 });
    expect(first.value).toContain("Changed.\n");
    expect(spent(read)).toMatchObject({ value: first.value, stored: 0, found: 1, decoded: 0 });

    storage.sql.exec("DELETE FROM doc_result").toArray();
    expect(spent(read)).toMatchObject({ value: first.value, stored: 1, found: 0 });
  });

  it("a read fails once the copy's rows are gone, whatever the view remembers", async () => {
    let { storage, lifecycle, copy, read, fetches } = await boundHost();
    read();
    storage.sql.exec("DELETE FROM doc_copy").toArray();

    // The ids the view carries are asked of storage before each use.
    expect(copy.held()).toBe(false);
    expect(() => copy.tab(TAB)).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(read).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(lifecycle.held()).toBeUndefined();
    expect(fetches()).toBe(1);
    expect(read((await lifecycle.current()).copy)).toContain(`${line(7)}\n`);
    expect(fetches()).toBe(2);
  });

  it("what a kept view remembers is its record", async () => {
    let { store, copy } = await boundHost();
    let head = store.head(DOC)!;
    // The one size a view has: the record it is built from, for a tab of 20,000 paragraphs.
    expect(JSON.stringify(head).length).toBeLessThan(4_096);
    let rebuilt = storedDocCopy(store, DOC, head);
    expect(rebuilt.outline).toEqual(copy.outline);
    expect(rebuilt.tab(TAB)).toEqual(copy.tab(TAB));
    expect(rebuilt.markdown(rebuilt.tab(TAB)!)).toBe(copy.markdown(copy.tab(TAB)!));
  });
});
