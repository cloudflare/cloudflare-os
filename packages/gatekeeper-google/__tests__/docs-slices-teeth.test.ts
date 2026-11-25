// Each part of the guard a slice is read through is needed: models built from the source with a
// part changed are found out by the comparison with the whole tab. And no read of the body goes
// around it: a census of the source lists every use of the body's list with its reason.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import type { ModelOptions } from "../src/docs-model";
import { BULLETED, bullets, deleteRange, insertText } from "./docs-model-draws";
import {
  everyStretch, FAMILY_KINDS, familyOf, GUARD_MUTANTS, ingestedTab, LISTS_PLACES, MIXED_PLACES,
  mismatchesFromEverySlice, mutantModel, namedPosition, pairsCorpus, SLICE_TABS, sliceOf,
} from "./docs-slice-shadow";
import type { SliceApply, SliceTabName, Stretches } from "./docs-slice-shadow";
import { WIDER } from "./wider-run";

/** A batch of the corpus: its tab, and the stretches it is run from where not every one. */
type Batch = { tab: GoogleDocsTab; requests: GoogleDocsRequest[]; stretches?: Stretches };

/** Every how many pairs a model is run on, and the ranges a range kind takes: the two widths. */
const SHARE = WIDER ? 2 : 8;
const RANGES = WIDER ? 150 : 20;

const NAMES = Object.keys(SLICE_TABS) as SliceTabName[];
const { MIXED, LISTS } = SLICE_TABS;
const mixed = MIXED.body.content;

/** The paragraph that directly follows MIXED's section break of two indexes. */
const afterBreak = mixed[MIXED_PLACES.longBreak + 1];

/**
 * An insertion after the long section break, from every stretch that opens with the break: the one
 * shape on which a slice's first element can be told from the element that opens a body.
 */
const FROM_THE_BREAK: Batch = {
  tab: MIXED, requests: [insertText(afterBreak.startIndex, "x")],
  stretches: everyStretch(mixed.length)
    .filter(([from, to]) => from === MIXED_PLACES.longBreak && to >= from + 2),
};

/** The batches built by hand that are run always, whatever the width. */
const ALWAYS: Batch[] = [
  // The hole of a guard that reads the side off the lookup: the slice's first element
  // removed, then a request below the slice.
  {
    tab: MIXED,
    requests: [
      deleteRange(mixed[MIXED_PLACES.table].startIndex, mixed[MIXED_PLACES.table].endIndex),
      insertText(1, "x"),
    ],
  },
  // Bullets behind a list that continues outside the slice.
  {
    tab: LISTS,
    requests: [bullets(
      LISTS.body.content[LISTS_PLACES.plain].startIndex,
      LISTS.body.content[LISTS_PLACES.plain].endIndex, BULLETED)],
  },
  // A request at an index below every stretch that starts after the section break.
  { tab: MIXED, requests: [insertText(mixed[1].startIndex + 1, "x")] },
  FROM_THE_BREAK,
];

/** What each model is run on: a share of the pairs, the batches run always, a tenth of the families. */
const CORPUS: Batch[] = [
  ...pairsCorpus().filter((_, position) => position % SHARE === 0)
    .map(({ tab, requests }) => ({ tab, requests })),
  ...ALWAYS,
  ...NAMES.flatMap(name => FAMILY_KINDS.flatMap(kind =>
    familyOf(SLICE_TABS[name], kind, RANGES)
      .filter((_, position) => position % 10 === 0)
      .map(request => ({ tab: SLICE_TABS[name], requests: [request] })))),
];

const NONE: ModelOptions = {};

/** What the comparison finds for `apply` over `batches`: every mismatch with its batch. */
function found(batches: readonly Batch[], apply: SliceApply) {
  let ran = 0;
  let widenings = 0;
  let mismatches: { batch: Batch; from: number; to: number }[] = [];
  for (let batch of batches) {
    let counted = mismatchesFromEverySlice(batch.tab, batch.requests, NONE, apply, batch.stretches);
    ran += counted.ran;
    widenings += counted.widenings;
    for (let stretch of counted.mismatches) mismatches.push({ batch, ...stretch });
  }
  return { ran, widenings, mismatches };
}

/** Whether `tab` holds, past its first element, a section break longer than one index. */
const holdsLongBreak = (tab: GoogleDocsTab) => tab.body.content.some((element, position) =>
  position > 0 && element.sectionBreak !== undefined && element.endIndex - element.startIndex > 1);

/** A batch run from one stretch. */
type Placed = Batch & { from: number; to: number };

/** Where the first paragraph of the stretch `[from, to)` starts, in the body or in a cell. */
function firstParagraph(tab: GoogleDocsTab, from: number, to: number): number | undefined {
  for (let element of ingestedTab(tab).body.content.slice(from, to)) {
    if (element.paragraph) return element.startIndex;
    let inCell = element.table?.tableRows?.[0]?.tableCells?.[0]?.content?.[0];
    if (inCell) return inCell.startIndex;
  }
  return undefined;
}

/** What `entry` throws for a batch on its stretch, by what the error holds, or nothing. */
function thrownBy(entry: SliceApply, { tab, requests, from, to }: Placed) {
  try {
    entry(sliceOf(tab, from, to, "model"), requests);
  } catch (thrown) {
    let { name, invariant, what } = thrown as { name?: string; invariant?: boolean; what?: string };
    return { name, invariant, what };
  }
  return undefined;
}

/** For each tab, an insertion at the first paragraph of each stretch that opens it, or does not. */
function batchesAtFirstParagraphs(opening: boolean): Placed[][] {
  return NAMES.map(name => {
    let tab = SLICE_TABS[name];
    return everyStretch(tab.body.content.length)
      .filter(([from]) => opening ? from === 0 : from > 0)
      .flatMap(([from, to]): Placed[] => {
        let index = firstParagraph(tab, from, to);
        return index === undefined ? []
          : [{ tab, requests: [insertText(index, "x")], stretches: [[from, to]], from, to }];
      });
  });
}

/** The entry of the model built from the source text with the parts `name` names replaced. */
const entryOf = (name: keyof typeof GUARD_MUTANTS) =>
  mutantModel(GUARD_MUTANTS[name]).applyDocsRequestsToSlice;

describe("each part of the guard is needed", () => {
  it("the model built from its text as it is finds no mismatch, and widens", () => {
    let unchanged = mutantModel([]).applyDocsRequestsToSlice;
    let { ran, widenings, mismatches } = found(CORPUS, unchanged);

    // The harness alone changes nothing, and a built model's edge is told as one: its class is its
    // own.
    expect(mismatches).toEqual([]);
    expect(widenings).toBeGreaterThan(0);
    expect(ran).toBeGreaterThan(CORPUS.length * 30);
    // What the stretches that start with the break read is in them.
    expect(found([FROM_THE_BREAK], unchanged)).toEqual({ ran: 6, widenings: 0, mismatches: [] });
  });

  it.each(["lookup-before", "lookup-after", "element-before"] as const)(
    "without %s, a slice gives another outcome than its tab", name => {
      expect(found(CORPUS, entryOf(name)).mismatches.length).toBeGreaterThan(0);
    });

  it("without body-opening, a slice that starts with a long section break is counted short", () => {
    let entry = entryOf("body-opening");
    // The rule differs from the body's only where a slice opens with a section break longer than one.
    let fromBreak = found([FROM_THE_BREAK], entry);
    expect(fromBreak.mismatches).toHaveLength(fromBreak.ran);
    expect(fromBreak.ran).toBe(6);
    // A stretch that starts after the break does not reach the rule.
    let after = everyStretch(mixed.length).filter(([from]) => from === MIXED_PLACES.longBreak + 1);
    expect(found([{ ...FROM_THE_BREAK, stretches: after }], entry).mismatches).toEqual([]);

    // Over the corpus it errs only on a tab that holds such a break past its first element,
    // from a stretch that starts with it, as started or as widened, where an index moves.
    let { mismatches } = found(CORPUS, entry);
    expect(mismatches.length).toBeGreaterThan(0);
    for (let { batch, from, to } of mismatches) {
      expect(holdsLongBreak(batch.tab), `[${from}, ${to}) of ${JSON.stringify(batch.requests)}`).toBe(true);
    }
    // And the corpus holds tabs without one, on which it errs nowhere.
    expect(CORPUS.some(batch => !holdsLongBreak(batch.tab))).toBe(true);
  });

  it("with the side read off the lookup, a slice that starts past what a batch names errs", () => {
    let entry = entryOf("side-by-lookup");
    let { mismatches } = found(CORPUS, entry);

    // It errs only where an earlier request removed the slice's first element, so every mismatch
    // is of a stretch that starts after the lowest element the batch names.
    expect(mismatches.length).toBeGreaterThan(0);
    for (let { batch, from, to } of mismatches) {
      let named = namedPosition(batch.tab, batch.requests)!;
      expect(named < from || named >= to, JSON.stringify(batch.requests)).toBe(true);
    }
    // Started from the lowest element a batch names alone, the same corpus finds none.
    let named = CORPUS.flatMap(batch => {
      let position = namedPosition(batch.tab, batch.requests);
      return position === undefined ? [] : [{ ...batch, stretches: [[position, position + 1]] as const }];
    });
    expect(named.length).toBeGreaterThan(CORPUS.length / 2);
    expect(found(named, entry).mismatches).toEqual([]);
  });

  it("the exit check is needed", () => {
    // A request that moves an index, so that the slice is re-indexed as the batch ends: an
    // insertion at the first index of the stretch's first paragraph, body or cell.
    let fromZero = entryOf("reindex-from-zero");
    let unchecked = entryOf("reindex-from-zero, unchecked");
    let unchanged = mutantModel([]).applyDocsRequestsToSlice;

    for (let [position, later] of batchesAtFirstParagraphs(false).entries()) {
      expect(later.length, NAMES[position]).toBeGreaterThanOrEqual(27);
      // Re-indexed from 0, a slice that is not the tab's first does not read from its origin:
      // the check refuses it, as a fault of the model.
      for (let batch of later) {
        expect(thrownBy(fromZero, batch), `${NAMES[position]} [${batch.from}, ${batch.to})`).toEqual({
          name: "NotModelledError", invariant: true,
          what: "a slice whose elements do not follow one another from its origin",
        });
        expect(thrownBy(unchanged, batch)).toBeUndefined();
        expect(thrownBy(unchecked, batch)).toBeUndefined();
      }
      expect(found(later, unchanged).mismatches).toEqual([]);
      // Without the check, elements counted from 0 get out: what it keeps from being stored.
      expect(found(later, unchecked).mismatches.length, NAMES[position]).toBeGreaterThan(0);
    }
    // A slice that opens the tab is counted from 0 either way.
    for (let batch of batchesAtFirstParagraphs(true).flat()) expect(thrownBy(fromZero, batch)).toBeUndefined();
  });
});

// --- The census of the model's source

const MODEL_TEXT = readFileSync(path.resolve(import.meta.dirname, "../src/docs-model.ts"), "utf8");

const parsed = (text: string): ts.SourceFile =>
  ts.createSourceFile("docs-model.ts", text, ts.ScriptTarget.ES2022, true);

/** Every node under `root`, itself included. */
function nodesOf(root: ts.Node): ts.Node[] {
  let nodes: ts.Node[] = [];
  let visit = (node: ts.Node) => {
    nodes.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return nodes;
}

/** The function declaration, or the method of a class, that holds `node`, by name. */
function enclosing(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
    if ((ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at)) && ts.isClassDeclaration(at.parent)) {
      let method = ts.isConstructorDeclaration(at) ? "constructor" : at.name.getText();
      return `${at.parent.name?.text}.${method}`;
    }
  }
  return "(the module)";
}

/** The class that holds `node`, by name. */
function classOf(node: ts.Node): string | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isClassDeclaration(at)) return at.name?.text;
  }
  return undefined;
}

/** `node` without the parentheses, assertions and `!` around it. */
function unwrapped(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  return node;
}

/** Whether `node` is an expression named `container`: the identifier, or a member of that name. */
function namedContainer(node: ts.Node): boolean {
  return ts.isIdentifier(node) ? node.text === "container"
    : ts.isPropertyAccessExpression(node) && node.name.text === "container";
}

/**
 * Every use of an expression named `container` in `text`, as `function: use`, in order. The
 * use is told by the node's parent: a member's name, `[]` for an element access, `of`, `...`,
 * `===`, `arg:<callee>` for an argument, `place` for the property of a place being built and
 * `{}` for a place taken apart. Throws on a parent it has no name for.
 */
function containerUses(text: string): string[] {
  let uses: string[] = [];
  for (let node of nodesOf(parsed(text))) {
    if (!namedContainer(node)) continue;
    let parent = node.parent;
    if (ts.isIdentifier(node)) {
      // The name of a member read is the read's, and a declared name is no use.
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) continue;
      if (ts.isParameter(parent) || ts.isPropertySignature(parent)) continue;
      if (ts.isShorthandPropertyAssignment(parent) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)) {
        uses.push(`${enclosing(node)}: place`);
        continue;
      }
      if (ts.isBindingElement(parent)) {
        uses.push(`${enclosing(node)}: {}`);
        continue;
      }
    }
    while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
      node = parent;
      parent = parent.parent;
    }
    let use: string | undefined;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) use = parent.name.text;
    else if (ts.isElementAccessExpression(parent) && parent.expression === node) use = "[]";
    else if (ts.isForOfStatement(parent) && parent.expression === node) use = "of";
    else if (ts.isSpreadElement(parent)) use = "...";
    else if (ts.isBinaryExpression(parent) && [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(parent.operatorToken.kind)) use = "===";
    else if (ts.isCallExpression(parent) && parent.arguments.some(argument => argument === node)) {
      use = `arg:${parent.expression.getText()}`;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) use = "place";
    if (use === undefined) {
      throw new Error(`a use of a list the census has no name for, in ${enclosing(node)}: ${parent.getText()}`);
    }
    uses.push(`${enclosing(node)}: ${use}`);
  }
  return uses;
}

/** Whether a callee is the draft's map of settled counts, which a list keys by what it is. */
const keysSettled = (callee: string) => /(^|\.)settled\.(get|set)$/.test(callee);

/** What in `text` holds or hands on a list of elements under another name than `container`. */
function otherNames(text: string): string[] {
  let source = parsed(text);
  let nodes = nodesOf(source);
  let faults: string[] = [];
  // A callee is resolved by name: a function of the file, or a method of the class that
  // guards the body, called on a draft's body.
  let declared = new Map<string | undefined, ts.SignatureDeclaration>(
    source.statements.filter(ts.isFunctionDeclaration)
      .map(declaration => [declaration.name?.text, declaration] as const));
  for (let method of nodes.filter(ts.isMethodDeclaration)) {
    if (enclosing(method.name).startsWith("SliceBody.")) {
      declared.set(`draft.body.${method.name.getText()}`, method);
    }
  }
  /** The fault of handing a list as argument `position` of `call`, if it is one. */
  let handed = (call: ts.CallExpression, position: number): void => {
    let callee = call.expression.getText();
    if (keysSettled(callee)) return;
    let parameter = declared.get(callee)?.parameters[position];
    if (!parameter) faults.push(`${enclosing(call)} hands a list to ${callee}, which the census cannot resolve`);
    else if (parameter.name.getText() !== "container") {
      faults.push(`${enclosing(call)} hands a list to ${callee}, which holds it as ${parameter.name.getText()}`);
    }
  };
  for (let node of nodes) {
    if (ts.isParameter(node) && /^(readonly )?StructuralElement\[\]$/.test(node.type?.getText() ?? "") &&
      node.name.getText() !== "container") {
      faults.push(`${enclosing(node)} holds a list of elements as ${node.name.getText()}`);
    }
    if (ts.isCallExpression(node)) {
      for (let [position, argument] of node.arguments.entries()) {
        let given = unwrapped(argument);
        if (namedContainer(given) || given.getText() === "this.#content") handed(node, position);
      }
      // What `entry` answers is bound as `{ container, position }` and no other way.
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "entry") {
        let binding = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : undefined;
        if (binding !== "{ container, position }") {
          faults.push(`${enclosing(node)} takes what entry answers as ${binding ?? node.parent.getText()}`);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && namedContainer(unwrapped(node.initializer))) {
      faults.push(`${enclosing(node)} holds a list as ${node.name.getText()}`);
    }
    if (ts.isBindingElement(node) && node.propertyName?.getText() === "container") {
      faults.push(`${enclosing(node)} holds a list as ${node.name.getText()}`);
    }
  }
  return faults;
}

/** The text of the function `name` of the model's source. */
function functionText(name: string): string {
  let declared = parsed(MODEL_TEXT).statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declared) throw new Error(`the model declares no function ${name}`);
  return declared.getText();
}

/** `text` with `line` added after its first line that holds `after`. */
function withLine(text: string, after: string, line: string): string {
  let lines = text.split("\n");
  let position = lines.findIndex(candidate => candidate.includes(after));
  if (position === -1) throw new Error(`no line holds ${after}`);
  return [...lines.slice(0, position + 1), line, ...lines.slice(position + 1)].join("\n");
}

/**
 * Why a use of a list that can be the body's reads nothing outside what a lookup answered:
 * (1) it reads or changes positions a lookup answered, or is the search a lookup is answered
 * with; (2) it compares, or keys by, what the list is; (3) it hands the list to a function
 * that holds it under the same name; (4) it is a walk of every element of a list handed
 * whole, by the class that guards the body or of a cell's list.
 */
type Reason = 1 | 2 | 3 | 4;

/** Every use of an expression named `container` in the model: the function, the use, and why. */
const USES: readonly (readonly [fn: string, use: string, reason: Reason, why: string])[] = [
  ["SliceBody.entry", "place", 1, "the body's list leaves its class here, with the position the guard judged"],
  ["SliceBody.is", "===", 2, "whether a list is the body's own"],
  ["touched", "{}", 1, "takes apart the place a lookup answered"],
  ["touched", "arg:walkContent", 3, "the elements a request wrote, from the position a lookup found"],
  ["touched", "arg:draft.body.is", 3, "asks the body whether the list is its own"],
  ["touched", "arg:lower", 3, "the list the watermark comes down in"],
  ["lower", "arg:settled.set", 2, "a cell's holder keys its count of settled entries"],
  ["lower", "arg:settled.set", 2, "the list keys its count of settled entries"],
  ["allParagraphs", "of", 4, "every paragraph of a list handed whole"],
  ["settledEndingAfter", "length", 1, "the bound of the search: what none found means is the guard's to say"],
  ["settledEndingAfter", "arg:draft.settled.get", 2, "the list keys its count of settled entries"],
  ["settledEndingAfter", "arg:firstEndingAfter", 3, "the search among the settled entries"],
  ["cellHolding", "[]", 1, "the table at the position a lookup found"],
  ["cellHolding", "place", 1, "a cell's place keeps the list its table stands in"],
  ["paragraphAt", "{}", 1, "binds what the guard answered, under its name"],
  ["paragraphAt", "arg:paragraphIn", 3, "goes on from the position the guard answered"],
  ["paragraphIn", "arg:settledEndingAfter", 3, "the search of a cell's list"],
  ["paragraphIn", "[]", 1, "the element at the position found"],
  ["paragraphIn", "place", 1, "the paragraph's place keeps the list it stands in"],
  ["paragraphIn", "arg:cellHolding", 3, "the table at the position found, to enter its cell"],
  ["tableAt", "{}", 1, "binds what the guard answered, under its name"],
  ["tableAt", "arg:tableIn", 3, "goes on from the position the guard answered"],
  ["tableIn", "arg:settledEndingAfter", 3, "the search of a cell's list"],
  ["tableIn", "[]", 1, "the element at the position found"],
  ["tableIn", "place", 1, "the table's place keeps the list it stands in"],
  ["tableIn", "arg:cellHolding", 3, "the table at the position found, to enter its cell"],
  ["firstEndingAfter", "length", 1, "the bound of the search where no count is given"],
  ["firstEndingAfter", "[]", 1, "the halving reads entries below the count it is given"],
  ["paragraphsInRange", "===", 2, "whether the range's two ends lie in one list"],
  ["paragraphsInRange", "===", 2, "whether the range's two ends lie in one list"],
  ["paragraphsInRange", "slice", 1, "the elements between the two positions the lookups found"],
  ["walkContent", "length", 4, "the end of a walk of a list handed whole"],
  ["walkContent", "[]", 4, "each element of the positions it is handed"],
  ["walkFootnotes", "arg:allParagraphs", 4, "every paragraph of a list handed whole"],
  ["splitAtLineBreaks", "splice", 1, "the paragraphs split off stand after the position found"],
  ["deleteContentRange", "splice", 1, "removes the table at the position found"],
  ["deleteContentRange", "arg:lower", 3, "the list the watermark comes down in"],
  ["deleteContentRange", "{}", 1, "binds what the guard answered, under its name"],
  ["deleteContentRange", "[]", 1, "the element at the position the guard answered"],
  ["deleteContentRange", "===", 2, "whether the range's two ends lie in one list"],
  ["deleteContentRange", "===", 2, "whether the range's two ends lie in one list"],
  ["deleteContentRange", "slice", 1, "the elements between the two positions the lookups found"],
  ["deleteContentRange", "splice", 1, "removes the paragraphs between the two positions found"],
  ["createParagraphBullets", "[]", 1,
    "the element before the position found, in a cell's list, which is whole: the body's is the guard's"],
  ["insertTable", "splice", 1, "the cut paragraph and the table stand at the position found"],
  ["tableTouched", "[]", 1, "whether the table still stands at the position found"],
  ["tableTouched", "arg:lower", 3, "the list the watermark comes down in"],
  ["deleteTableRow", "splice", 1, "removes the table at the position found"],
  ["deleteTableRow", "arg:lower", 3, "the list the watermark comes down in"],
  ["deleteTableRow", "arg:lower", 3, "the list the watermark comes down in"],
  ["deleteTableColumn", "splice", 1, "removes the table at the position found"],
];

/** The functions a walk of every element of a list handed whole may stand in. */
const WALKS = ["walkContent", "allParagraphs", "walkFootnotes"];

/** Whether `table` gives the fourth reason only in the functions that walk a list whole. */
const walksWhereAllowed = (table: readonly (readonly [string, string, Reason, string])[]) =>
  table.every(([fn, , reason]) => reason !== 4 || WALKS.includes(fn));

/** The uses of `uses` that the table does not hold, each line of the table counted once. */
function beyondTable(uses: readonly string[]): string[] {
  let left = USES.map(([fn, use]) => `${fn}: ${use}`);
  return uses.filter(use => {
    let position = left.indexOf(use);
    if (position === -1) return true;
    left.splice(position, 1);
    return false;
  });
}

describe("the census of the model's source", () => {
  const nodes = nodesOf(parsed(MODEL_TEXT));

  it("names the body's list only inside the class that guards it", () => {
    let named = nodes.filter(node => ts.isPrivateIdentifier(node) && node.text === "#content");

    // The field's own declaration and every read of it.
    expect(named.length).toBeGreaterThan(5);
    expect(new Set(named.map(classOf))).toEqual(new Set(["SliceBody"]));
  });

  it("reads no body off a draft's tab", () => {
    let bodies = nodes.filter(ts.isPropertyAccessExpression)
      .filter(node => node.name.text === "body")
      .map(node => `${enclosing(node)}: ${node.expression.getText()}`);

    // A draft's body is the guarded class; the two others are a tab's, whole.
    expect(bodies.filter(body => !body.endsWith(": draft")).toSorted())
      .toEqual(["copiedDraftAfter: copy", "followsTab: tab"]);
    expect(bodies.filter(body => body.endsWith(": draft")).length).toBeGreaterThan(10);
    expect(MODEL_TEXT).toContain('  tab: Pick<TabSlice, "tabId" | "lists" | "namedStyles">;');
  });

  it("holds a list of elements under one name", () => {
    expect(otherNames(MODEL_TEXT)).toEqual([]);

    let holders = nodes.filter(ts.isParameter)
      .filter(parameter => parameter.name.getText() === "container").map(enclosing);
    expect(holders).toEqual([
      "SliceBody.is", "lower", "allParagraphs", "settledEndingAfter", "cellHolding", "paragraphIn",
      "tableIn", "firstEndingAfter", "walkContent", "walkFootnotes",
    ]);

    // A cell's list is the only other list of elements: reached off its cell and handed on.
    let cells = nodes.filter(ts.isCallExpression).flatMap(call => call.arguments
      .filter(argument => /\bcontent \?\? \[\]$/.test(argument.getText()))
      .map(argument => `${enclosing(call)}: ${call.expression.getText()}(${argument.getText()})`));
    expect(cells).toEqual([
      "allParagraphs: allParagraphs(cell.content ?? [])",
      "paragraphIn: paragraphIn(held.cell.content ?? [])",
      "tableIn: tableIn(held.cell.content ?? [])",
      "walkTable: walkContent(cell.content ?? [])",
      "newRowChip: loneChipCopy(reference.content ?? [])",
      "mergeTableCells: joined.push(...cell.content ?? [])",
    ]);
  });

  it("lists every use of a list that can be the body's, with its reason", () => {
    expect(containerUses(MODEL_TEXT)).toEqual(USES.map(([fn, use]) => `${fn}: ${use}`));
    expect(USES).toHaveLength(51);
    for (let [fn, use, , why] of USES) expect(why.length, `${fn}: ${use}`).toBeGreaterThan(20);
    expect(walksWhereAllowed(USES)).toBe(true);
  });

  it("fails on a use, a name or a reason it does not hold", () => {
    // A read of what stands outside the positions a lookup found, however it is written.
    for (let line of [
      "return place.container.length - 1 === place.position;",
      "for (let element of place.container) {}",
      "return place.container.some(element => element.table);",
      "return place.container.indexOf(place.element);",
      "return [...place.container];",
    ]) {
      expect(beyondTable(containerUses(`function probe(place: ParagraphPlace) { ${line} }`)), line)
        .toHaveLength(1);
    }
    // Inside a lookup, and inside the two searches a lookup is answered with.
    let lookup = functionText("paragraphAt");
    expect(beyondTable(containerUses(lookup))).toEqual([]);
    for (let line of ["  if (container[position + 1]) return undefined;",
      "  if (container.length - 1 === position) return undefined;"]) {
      expect(beyondTable(containerUses(withLine(lookup, "draft.body.entry", line))), line)
        .not.toEqual([]);
    }
    for (let [search, after] of [["settledEndingAfter", "let count"], ["firstEndingAfter", "let low"]]) {
      expect(beyondTable(containerUses(functionText(search)))).toEqual([]);
      for (let line of ["  container.at(-1);", "  container[container.length - 1];"]) {
        expect(beyondTable(containerUses(withLine(functionText(search), after, line))), `${search}: ${line}`)
          .not.toEqual([]);
      }
    }
    // A walk of every element outside the three functions that walk a list handed whole.
    expect(walksWhereAllowed([...USES, ["paragraphAt", "of", 4, "a walk of every element"]])).toBe(false);

    // A list under another name, or handed to a function that holds it under one.
    for (let text of [
      "function search(list: readonly Indexed[]) {}\nfunction caller(container: StructuralElement[]) { search(container); }",
      "function walk(content: readonly Indexed[]) {}\nclass SliceBody { #content = []; reindex() { walk(this.#content); } }",
      "function reader(content: StructuralElement[]) {}",
      "function lookup(draft: Draft, index: number) { let { container: content, position } = draft.body.entry(draft, index); }",
      "function lookup(draft: Draft, index: number) { let found = draft.body.entry(draft, index); }",
      "function reader(place: ParagraphPlace) { let list = place.container; }",
    ]) {
      expect(otherNames(text), text).not.toEqual([]);
    }
  });
});
