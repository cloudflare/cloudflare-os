/// <reference types="node" />

// The recorder of Google Docs' answers, run against the model in place of Google: what it
// builds, records, prunes and compares, and what its command line does. Nothing here calls
// Google or touches the committed recordings.

import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, Table, TableCell, TableCellBorder,
} from "../src/docs-api";
import { applyDocsRequests, NotModelledError } from "../src/docs-model";
import type { ModelParagraphStyle, ModelTextStyle } from "../src/docs-model";
import { docTabToMarkdown, POSITIONED_ITEM_BEFORE } from "../src/markdown-converter";
import { BULLET_LIST, buildTab, para, presetLevels } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import {
  comparable, prunedTab, readFixtures, rowsGoogleSizes,
} from "./docs-live-fixtures";
import type { DocsLiveFixture } from "./docs-live-fixtures";
import {
  drift, googleTransport, main, recordScenario, SCENARIOS, stepRequests,
} from "./docs-live-recorder";
import type { DocsTransport, Scenario, ScenarioStep } from "./docs-live-recorder";

const FIXTURES = readFixtures();
const CHIP_PLACEHOLDER = "\uE907";
const TAB_TITLE = "Tab 1";

function fixtureOf(name: string): DocsLiveFixture | undefined {
  return FIXTURES.find(fixture => fixture.name === name);
}

function scenarioOf(name: string): Scenario {
  let scenario = SCENARIOS.find(candidate => candidate.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return scenario;
}

/** A new document's tab as Google returns it, which every recording starts from. */
function newDocument(): GoogleDocsTab {
  return structuredClone(FIXTURES[0].before);
}

/** The paragraphs of a tab's body, in order. */
function bodyParagraphs(tab: GoogleDocsTab): Paragraph[] {
  return tab.body.content.flatMap(element => element.paragraph ?? []);
}

function textOf(paragraph: Paragraph): string {
  return paragraph.elements.map(element => element.textRun?.content ?? "").join("");
}

/** The paragraph of the body whose text is `text` and a line break. */
function paragraphOf(tab: GoogleDocsTab, text: string): Paragraph {
  let found = bodyParagraphs(tab).find(paragraph => textOf(paragraph) === `${text}\n`);
  if (!found) throw new Error(`no paragraph ${text}`);
  return found;
}

/** The texts of the body paragraphs that hold a positioned object. */
function anchors(tab: GoogleDocsTab): string[] {
  return bodyParagraphs(tab).filter(paragraph => paragraph.positionedObjectIds?.length)
    .map(paragraph => textOf(paragraph).trim());
}

/**
 * The hand-made template as far as a request-built tab can stand in for it: a table with a
 * row of chips, three paragraphs of text of which the middle one anchors a positioned image,
 * a paragraph, and a bulleted list of one level last. `positioned` names the paragraph that
 * anchors the image, `null` for none.
 */
function template(positioned: string | null = "Anchor of the image"): GoogleDocsTab {
  let tab = buildTab([
    { runs: ["\n"] },
    {
      table: [
        ["Person\n", "Date\n", "Dropdown\n", "Placeholder\n"],
        [
          { paragraphs: [{ runs: [{ person: { name: "Person 1", email: "person1@example.com" } }, "\n"] }] },
          { paragraphs: [{ runs: [{ date: "Jan 5, 2026" }, "\n"] }] },
          { paragraphs: [{ runs: [{ dropdown: "Open" }, "\n"] }] },
          { paragraphs: [{ runs: [`${CHIP_PLACEHOLDER}\n`] }] },
        ],
      ],
    },
    { runs: ["Before the image\n"] },
    { runs: ["Anchor of the image\n"] },
    { runs: ["After the image\n"] },
    { runs: ["Suggested\n"] },
    { runs: ["First item\n"], bullet: { listId: "L1" } },
    { runs: ["Second item\n"], bullet: { listId: "L1" } },
  ], structuredClone(BULLET_LIST));
  if (positioned !== null) paragraphOf(tab, positioned).positionedObjectIds = ["image-1"];
  return tab;
}

/** A transport that keeps its documents in memory and answers each batch with the model. */
function modelTransport(start: { created?: GoogleDocsTab; copied?: GoogleDocsTab } = {}) {
  let documents = new Map<string, GoogleDocsTab>();
  let calls: string[] = [];
  let sent: GoogleDocsRequest[][] = [];
  let discarded: string[] = [];
  let made = 0;
  let held = (documentId: string) => {
    let tab = documents.get(documentId);
    if (!tab) throw new Error(`no document ${documentId}`);
    return tab;
  };
  let make = (call: string, tab: GoogleDocsTab) => {
    calls.push(call);
    let documentId = `document-${++made}`;
    // Google reads a document's tab back with a title, which no recording keeps.
    documents.set(documentId, { ...structuredClone(tab), title: TAB_TITLE });
    return documentId;
  };
  let transport: DocsTransport = {
    create: async () => make("create", start.created ?? newDocument()),
    copy: async () => make("copy", start.copied ?? template()),
    async read(documentId) {
      calls.push("read");
      return structuredClone(held(documentId));
    },
    async send(documentId, requests) {
      calls.push("send");
      sent.push(requests);
      documents.set(documentId, applyDocsRequests(held(documentId), requests));
    },
    async suggest(documentId, requests) {
      calls.push("suggest");
      sent.push(requests);
      held(documentId);
    },
    async discard(documentId) {
      calls.push("discard");
      held(documentId);
      documents.delete(documentId);
      discarded.push(documentId);
    },
  };
  return { transport, calls, sent, discarded, documents };
}

/**
 * Record `scenario` against the model. A scenario with a setup starts from a new document, which
 * the setup is sent to, as it does against Google Docs; any other starts from its committed
 * `before` when it has one. The model makes no suggestion, so a scenario that makes some starts
 * from its committed `before`, without its setup and its suggestions.
 */
async function recordedByModel(scenario: Scenario, start: { copied?: GoogleDocsTab } = {}) {
  let recorded = fixtureOf(scenario.name);
  let { setup: _setup, suggest: _suggest, ...unsuggested } = scenario;
  let replayed: Scenario = scenario.suggest ? unsuggested : scenario;
  let model = modelTransport({ created: replayed.setup ? undefined : recorded?.before, ...start });
  let fresh = await recordScenario(
    replayed, model.transport, { recorded, templateId: "template", pauseMs: 0 });
  return { fresh, recorded, ...model };
}

describe("the batch of a step", () => {
  it("builds from each recorded document the batch its recording holds", () => {
    let equal = 0;
    let marked: string[] = [];
    for (let fixture of FIXTURES) {
      let { steps } = scenarioOf(fixture.name);
      let tab = fixture.before;
      for (let [index, step] of fixture.steps.entries()) {
        let label = `${fixture.name} / ${step.name}`;
        let built = stepRequests(steps[index], tab);
        if (steps[index].batch === "recorded") {
          // The builders build another batch for it, which is why it sends the recorded one.
          expect(built, label).not.toEqual(step.requests);
          marked.push(label);
        } else {
          expect(built, label).toEqual(step.requests);
          equal++;
        }
        tab = step.after;
      }
    }
    expect(equal).toBe(199);
    expect(marked).toEqual([
      "bullets-nesting-2 / a child under the middle item",
      "bullets-nesting-2 / children appended after the list",
      "bullets-nesting-2 / a top-level item nested",
      "bullets-nesting / an item nested under the last",
      "list-text-edits / a nested item split in two",
      "list-text-edits / a child at the end of the list",
      "list-text-edits / a numbered child in the middle",
      "outdent-after-nested / a top-level item appended after the nested one",
      "outdent-after-nested / a top-level item written after the nested one",
      "outdent-after-nested / a level-one item written after a level-two one",
    ]);
  });

  it("refuses a replacement whose text is not in the tab exactly once", () => {
    let tab = buildTab([{ runs: ["same\n"] }, { runs: ["same\n"] }]);
    expect(() => stepRequests({ name: "twice", replace: ["same", "other"] }, tab))
      .toThrow("oldMarkdown matches multiple locations");
    expect(() => stepRequests({ name: "absent", replace: ["missing", "other"] }, tab))
      .toThrow("oldMarkdown was not found");
  });

  it("refuses an append to a tab that does not end in a paragraph", () => {
    let tab = buildTab([{ runs: ["Text\n"] }, { structure: "tableOfContents" }]);
    expect(() => stepRequests({ name: "more", append: "More" }, tab))
      .toThrow("appendText: the selected tab does not end in a paragraph");
  });

  it("fails an unguarded step with what else a builder throws, asked once", () => {
    let asked = 0;
    let step: ScenarioStep = {
      name: "another refusal", batch: "unguarded",
      table: () => {
        asked++;
        throw new Error("another refusal");
      },
    };
    expect(() => stepRequests(step, buildTab([{ runs: ["Text\n"] }]))).toThrow("another refusal");
    expect(asked).toBe(1);
  });
});

describe("a pruned tab", () => {
  it("replaces the names a recording holds", () => {
    let ada = { person: { name: "Ada Lovelace", email: "ada@corp.example" } };
    let tab = prunedTab(buildTab([
      { runs: [ada, " and ", { person: { email: "grace@corp.example" } }, "\n"] },
      {
        runs: [
          { richLink: { title: "Quarterly plan", uri: "https://docs.example/d/plan" } }, " for ", ada,
          "\n",
        ],
      },
    ]));

    let chips = bodyParagraphs(tab).flatMap(paragraph => paragraph.elements)
      .flatMap(element => element.person?.personProperties ?? element.richLink?.richLinkProperties ?? []);
    expect(chips).toEqual([
      { name: "Person 1", email: "person1@example.com" },
      { email: "person2@example.com" },
      { title: "Link 1", uri: "https://example.com/1" },
      { name: "Person 1", email: "person1@example.com" },
    ]);
    expect(JSON.stringify(tab)).not.toMatch(/Ada|Lovelace|grace|corp\.example|Quarterly|docs\.example/);
    expect(prunedTab(tab)).toEqual(tab);
  });
});

/** A cell of one paragraph, with a style as Google sends one on every cell. */
function styledCell(text: string, tableCellStyle: TableCell["tableCellStyle"] = {}) {
  return { paragraphs: [{ runs: [`${text}\n`] }], tableCellStyle };
}

/** A tab with one of everything `comparable` reads, each test changing one thing of it. */
function comparedTab(): GoogleDocsTab {
  let tab = buildTab([
    { runs: ["Heading\n"], namedStyleType: "HEADING_1" },
    { runs: ["one\n"], bullet: { listId: "kix.bullets" } },
    { runs: ["first\n"], bullet: { listId: "kix.numbers" } },
    { runs: ["Anchor ", { footnote: { id: "kix.note", number: "1" } }, "\n"] },
    {
      table: [
        [
          styledCell("a", { backgroundColor: { color: { rgbColor: { red: 1, green: 0.2 } } } }),
          styledCell("b"),
        ],
        [styledCell("c"), styledCell("d")],
      ],
      heights: [18, 0],
      suggestedRows: { 1: "insertion" },
    },
    { runs: ["End\n"] },
  ], {
    "kix.bullets": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
    "kix.numbers": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    "kix.unused": { listProperties: { nestingLevels: [{ glyphSymbol: "○" }] } },
    "kix.spare": { listProperties: { nestingLevels: [{ glyphType: "ROMAN" }] } },
  });
  let [heading, , , anchor] = bodyParagraphs(tab);
  heading.paragraphStyle.headingId = "h.one";
  anchor.positionedObjectIds = ["kix.positioned"];
  anchor.elements.splice(1, 0, {
    startIndex: 0, endIndex: 0, inlineObjectElement: { inlineObjectId: "kix.inline" },
  });
  tableOf(tab).suggestedInsertionIds = ["suggest.table"];
  cellOf(tab, 0, 1).suggestedDeletionIds = ["suggest.cut"];
  return tab;
}

/** `comparedTab()` after `change`. */
function changed(change: (tab: GoogleDocsTab) => void): GoogleDocsTab {
  let tab = comparedTab();
  change(tab);
  return tab;
}

/** The first table of a tab's body. */
function tableOf(tab: GoogleDocsTab): Table {
  let table = tab.body.content.find(element => element.table)?.table;
  if (!table) throw new Error("no table");
  return table;
}

function cellOf(tab: GoogleDocsTab, row: number, column: number): TableCell {
  let cell = tableOf(tab).tableRows?.[row]?.tableCells?.[column];
  if (!cell) throw new Error(`no cell ${row}, ${column}`);
  return cell;
}

/** The cell style a test gives the second cell of `comparedTab()`, which has none of its own. */
function restyled(tableCellStyle: TableCell["tableCellStyle"]): (tab: GoogleDocsTab) => void {
  return tab => {
    cellOf(tab, 0, 1).tableCellStyle = tableCellStyle;
  };
}

/** The border a cell has when nothing sets it, written out. */
const DEFAULT_BORDER: TableCellBorder = {
  color: { color: { rgbColor: {} } }, width: { magnitude: 1, unit: "PT" }, dashStyle: "SOLID",
};

function styleOf(paragraph: Paragraph): ModelParagraphStyle {
  return paragraph.paragraphStyle;
}

/** Give the list `from` the id `to`, in the tab's lists and on its items. */
function renameList(tab: GoogleDocsTab, from: string, to: string): void {
  tab.lists = Object.fromEntries(
    Object.entries(tab.lists).map(([id, list]) => [id === from ? to : id, list]));
  for (let { bullet } of bodyParagraphs(tab)) {
    if (bullet?.listId === from) bullet.listId = to;
  }
}

describe("two documents compared", () => {
  let tableStart = comparedTab().body.content.find(element => element.table)?.startIndex ?? -1;
  let firstRow = new Map([[tableStart, new Set([0])]]);

  it.each<[string, (tab: GoogleDocsTab) => void]>([
    ["the ids of lists in use", tab => {
      renameList(tab, "kix.bullets", "kix.other");
      renameList(tab, "kix.numbers", "kix.bullets");
    }],
    ["the id of a list no paragraph uses", tab => renameList(tab, "kix.unused", "kix.idle")],
    ["the ids and the order of two lists no paragraph uses", tab => {
      let { "kix.unused": circles, "kix.spare": romans, ...lists } = tab.lists;
      tab.lists = { "kix.y": romans, ...lists, "kix.z": circles };
    }],
    ["the ids of a positioned object, an inline object and a suggestion", tab => {
      let anchor = bodyParagraphs(tab)[3];
      anchor.positionedObjectIds = ["kix.another"];
      anchor.elements[1].inlineObjectElement = { inlineObjectId: "kix.picture" };
      let table = tableOf(tab);
      table.suggestedInsertionIds = ["suggest.table.other"];
      cellOf(tab, 0, 1).suggestedDeletionIds = ["suggest.cut.other"];
      let row = table.tableRows?.[1];
      for (let part of [row, ...row?.tableCells ?? []]) {
        if (part) part.suggestedInsertionIds = ["suggest.other"];
      }
    }],
    ["a heading's id", tab => {
      bodyParagraphs(tab)[0].paragraphStyle.headingId = "h.two";
    }],
    ["a start index left out", tab => {
      Reflect.deleteProperty(tab.body.content[0], "startIndex");
    }],
    ["a run of one style split in two", tab => {
      let end = bodyParagraphs(tab)[4];
      end.elements = [
        { ...end.elements[0], endIndex: end.elements[0].startIndex + 2, textRun: { content: "En", textStyle: {} } },
        { ...end.elements[0], startIndex: end.elements[0].startIndex + 2, textRun: { content: "d\n", textStyle: {} } },
      ];
    }],
    ["an indent of zero, one with no magnitude, and the default alignment", tab => {
      let [heading, item] = bodyParagraphs(tab);
      Object.assign(styleOf(heading), { indentStart: { magnitude: 0, unit: "PT" }, alignment: "START" });
      Object.assign(styleOf(item), { indentFirstLine: { unit: "PT" } });
    }],
    ["a cell's defaults written out", restyled({
      backgroundColor: {}, contentAlignment: "TOP", borderTop: DEFAULT_BORDER,
      borderLeft: { ...DEFAULT_BORDER, color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } },
      paddingTop: { magnitude: 5, unit: "PT" }, paddingLeft: { magnitude: 5, unit: "PT" },
    })],
    ["a colour component as the float Google stores", tab => {
      cellOf(tab, 0, 0).tableCellStyle = {
        backgroundColor: { color: { rgbColor: { red: 1, green: Math.fround(0.2) } } },
      };
    }],
  ])("reads two documents that differ only in %s as equal", (_what, change) => {
    let other = changed(change);
    expect(other).not.toEqual(comparedTab());
    expect(comparable(other)).toEqual(comparable(comparedTab()));
  });

  it("leaves out the least height of the rows a merge left Google to size, and of no other", () => {
    let other = changed(tab => {
      let rows = tab.body.content.find(element => element.table)?.table?.tableRows ?? [];
      rows[0].tableRowStyle = { minRowHeight: { magnitude: 36.5, unit: "PT" } };
    });
    expect(comparable(other, firstRow)).toEqual(comparable(comparedTab(), firstRow));
    expect(comparable(other)).not.toEqual(comparable(comparedTab()));
    expect(comparable(other, new Map([[tableStart, new Set([1])]])))
      .not.toEqual(comparable(comparedTab(), new Map([[tableStart, new Set([1])]])));
  });

  it.each<[string, (tab: GoogleDocsTab) => void]>([
    ["an index", tab => {
      bodyParagraphs(tab)[4].elements[0].endIndex += 1;
    }],
    ["a text", tab => {
      let run = bodyParagraphs(tab)[4].elements[0].textRun;
      if (run) run.content = "Ends\n";
    }],
    ["a text style", tab => {
      let run = bodyParagraphs(tab)[4].elements[0].textRun;
      if (run) run.textStyle = { underline: true } as ModelTextStyle;
    }],
    ["the style of the second of two runs", tab => {
      let end = bodyParagraphs(tab)[4];
      let [run] = end.elements;
      end.elements = [
        { ...run, endIndex: run.startIndex + 2, textRun: { content: "En", textStyle: {} } },
        {
          ...run, startIndex: run.startIndex + 2,
          textRun: { content: "d\n", textStyle: { bold: true } },
        },
      ];
    }],
    ["an indent", tab => {
      styleOf(bodyParagraphs(tab)[4]).indentStart = { magnitude: 36, unit: "PT" };
    }],
    ["a first line's indent", tab => {
      styleOf(bodyParagraphs(tab)[4]).indentFirstLine = { magnitude: 18, unit: "PT" };
    }],
    ["an alignment", tab => {
      styleOf(bodyParagraphs(tab)[4]).alignment = "CENTER";
    }],
    ["a cell style", restyled({ contentAlignment: "MIDDLE" })],
    ["a cell's padding", restyled({ paddingTop: { magnitude: 8, unit: "PT" } })],
    ["the unit of a cell's padding", restyled({ paddingTop: { magnitude: 5, unit: "MM" } })],
    ["a dashed border", restyled({ borderTop: { ...DEFAULT_BORDER, dashStyle: "DASH" } })],
    ["a coloured border", restyled({
      borderTop: { ...DEFAULT_BORDER, color: { color: { rgbColor: { red: 1 } } } },
    })],
    ["a border's width", restyled({
      borderTop: { ...DEFAULT_BORDER, width: { magnitude: 2, unit: "PT" } },
    })],
    ["the unit of a border's width", restyled({
      borderTop: { ...DEFAULT_BORDER, width: { magnitude: 1, unit: "MM" } },
    })],
    ["a cell's shading", restyled({ backgroundColor: { color: { rgbColor: { blue: 1 } } } })],
    ["the cell a suggestion is on", tab => {
      let [first, second] = [cellOf(tab, 0, 0), cellOf(tab, 0, 1)];
      first.suggestedDeletionIds = second.suggestedDeletionIds;
      delete second.suggestedDeletionIds;
    }],
    ["a suggestion of its own on one cell of a suggested row", tab => {
      cellOf(tab, 1, 1).suggestedInsertionIds = ["suggest.second"];
    }],
    ["a colour component", tab => {
      cellOf(tab, 0, 0).tableCellStyle = {
        backgroundColor: { color: { rgbColor: { red: 1, green: 0.2, blue: 0 } } },
      };
    }],
    ["the paragraph a positioned object is on", tab => {
      let [, , , anchor, end] = bodyParagraphs(tab);
      end.positionedObjectIds = anchor.positionedObjectIds;
      delete anchor.positionedObjectIds;
    }],
    ["a second positioned object on one paragraph", tab => {
      bodyParagraphs(tab)[3].positionedObjectIds?.push("kix.second");
    }],
    ["a footnote's id", tab => {
      let note = bodyParagraphs(tab)[3].elements.find(element => element.footnoteReference);
      if (note?.footnoteReference) note.footnoteReference.footnoteId = "kix.other";
    }],
    ["a second list in use", tab => {
      bodyParagraphs(tab)[2].bullet = { listId: "kix.bullets" };
    }],
    ["the definition of a list no paragraph uses", tab => {
      tab.lists["kix.unused"].listProperties.nestingLevels[0].glyphSymbol = "■";
    }],
    ["one more list no paragraph uses", tab => {
      tab.lists["kix.third"] = structuredClone(tab.lists["kix.unused"]);
    }],
  ])("tells apart two documents that differ in %s", (_what, change) => {
    expect(comparable(changed(change), firstRow)).not.toEqual(comparable(comparedTab(), firstRow));
  });

  it("names the rows a merge leaves Google to size", () => {
    let tabId = "t.0";
    let merge = (table: number, rowIndex: number, rowSpan: number): GoogleDocsRequest => ({
      mergeTableCells: {
        tableRange: {
          tableCellLocation: { tableStartLocation: { index: table, tabId }, rowIndex, columnIndex: 0 },
          rowSpan, columnSpan: 2,
        },
      },
    });
    let size = (table: number, rowIndices: number[]): GoogleDocsRequest => ({
      updateTableRowStyle: {
        tableStartLocation: { index: table, tabId }, rowIndices,
        tableRowStyle: { minRowHeight: { magnitude: 20, unit: "PT" } }, fields: "minRowHeight",
      },
    });

    expect(rowsGoogleSizes([merge(5, 1, 2)])).toEqual(new Map([[5, new Set([1, 2])]]));
    // Rows the same batch then sizes are sized by the batch, not by Google.
    expect(rowsGoogleSizes([merge(5, 1, 2), size(5, [1])])).toEqual(new Map([[5, new Set([2])]]));
    expect(rowsGoogleSizes([merge(5, 1, 2), size(5, [1, 2])])).toEqual(new Map());
    // A size set before the merge does not outlast it.
    expect(rowsGoogleSizes([size(5, [1]), merge(5, 1, 1)])).toEqual(new Map([[5, new Set([1])]]));
    expect(rowsGoogleSizes([merge(5, 0, 1), merge(40, 2, 2), size(40, [3])]))
      .toEqual(new Map([[5, new Set([0])], [40, new Set([2])]]));
    expect(rowsGoogleSizes([size(5, [0])])).toEqual(new Map());
  });
});

const TOKEN = "a-token-nobody-prints";
const TEXT_PATH = "body.content[1].paragraph.elements[0].textRun.content";

/** Put a word in front of the text a tab starts with. */
function rewritten(tab: GoogleDocsTab): void {
  let run = tab.body.content[1].paragraph?.elements[0].textRun;
  if (!run) throw new Error("the tab does not start with text");
  run.content = `Other ${run.content}`;
}

/** A copy of the committed recording of the scenario `name`. */
function recordedOf(name: string): DocsLiveFixture {
  let fixture = fixtureOf(name);
  if (!fixture) throw new Error(`no recording of ${name}`);
  return structuredClone(fixture);
}

/** A copy of the committed recording of `paragraph-splits`. */
function recordedSplits(): DocsLiveFixture {
  return recordedOf("paragraph-splits");
}

/** Where a request starts: the index it inserts at, or the start of its range. */
function startOf(request: GoogleDocsRequest): number | undefined {
  let [body]: { location?: { index: number }; range?: { startIndex: number } }[] =
    Object.values(request);
  return body.location?.index ?? body.range?.startIndex;
}

/** The lines of a tab's Markdown that name the template's image. */
function imageLines(tab: GoogleDocsTab): string[] {
  return docTabToMarkdown(tab).markdown.split("\n").filter(line => line.includes("the image"));
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  let error = await promise.then(() => undefined, (thrown: unknown) => thrown);
  if (!(error instanceof Error)) throw new Error("the promise did not reject with an error");
  return error;
}

describe("a recording", () => {
  it("records every scenario against the model", async () => {
    for (let scenario of SCENARIOS) {
      // Its last step waits for Google: a test below records it as far as it goes.
      if (scenario.name === "positioned-list-item") continue;
      let { fresh, recorded, discarded, documents } = await recordedByModel(scenario);

      expect(fresh.name).toBe(scenario.name);
      expect(fresh.before, scenario.name).toEqual(prunedTab(fresh.before));
      expect(fresh.steps.map(step => step.name)).toEqual(scenario.steps.map(step => step.name));
      for (let step of fresh.steps) {
        expect(step.requests.length, `${scenario.name} / ${step.name}`).toBeGreaterThan(0);
        expect(step.after, `${scenario.name} / ${step.name}`).toEqual(prunedTab(step.after));
      }
      expect(discarded, scenario.name).toEqual(["document-1"]);
      expect(documents.size).toBe(0);
      // A recorded scenario is recorded again as it was, its recorded batches included.
      if (recorded) expect(drift(recorded, fresh), scenario.name).toEqual([]);
    }
  });

  it("sends a scenario's setup before it reads the document, and records no step for it", async () => {
    let given: GoogleDocsTab[] = [];
    let setupBatch: GoogleDocsRequest[] = [
      { insertText: { location: { index: 1, tabId: newDocument().tabId }, text: "Set up" } },
    ];
    let scenario: Scenario = {
      name: "with-a-setup",
      setup: tab => {
        given.push(tab);
        return setupBatch;
      },
      steps: [{ name: "first", append: "One" }, { name: "second", append: "Two" }],
    };
    let { transport, calls, sent } = modelTransport();
    let fresh = await recordScenario(scenario, transport, { pauseMs: 0 });

    expect(calls).toEqual(
      ["create", "read", "send", "read", "send", "read", "send", "read", "discard"]);
    expect(given).toEqual([{ ...newDocument(), title: TAB_TITLE }]);
    expect(sent[0]).toBe(setupBatch);
    expect(docTabToMarkdown(fresh.before).markdown).toBe("Set up\n");
    expect(fresh.steps.map(step => step.name)).toEqual(["first", "second"]);
    for (let step of fresh.steps) expect(step.requests).not.toEqual(setupBatch);
    expect(docTabToMarkdown(fresh.steps[1].after).markdown).toBe("Set up\n\nOne\n\nTwo\n");

  });

  it("sends a scenario's suggestions after its setup, each on the tab as just read", async () => {
    let given: GoogleDocsTab[] = [];
    let { tabId } = newDocument();
    let setupBatch: GoogleDocsRequest[] =
      [{ insertText: { location: { index: 1, tabId }, text: "Set up" } }];
    let suggestion = (text: string) => (tab: GoogleDocsTab): GoogleDocsRequest[] => {
      given.push(tab);
      return [{ insertText: { location: { index: 1, tabId }, text } }];
    };
    let scenario: Scenario = {
      name: "with-suggestions",
      setup: () => setupBatch,
      suggest: [suggestion("A"), suggestion("B")],
      steps: [{ name: "first", append: "One" }],
    };
    let { transport, calls, sent } = modelTransport();
    let fresh = await recordScenario(scenario, transport, { pauseMs: 0 });

    expect(calls).toEqual([
      "create", "read", "send", "read", "suggest", "read", "suggest", "read", "send", "read",
      "discard",
    ]);
    expect(sent.slice(1, 3)).toEqual([
      [{ insertText: { location: { index: 1, tabId }, text: "A" } }],
      [{ insertText: { location: { index: 1, tabId }, text: "B" } }],
    ]);
    // Each suggestion is written for the tab the setup left; the model's stand-in makes none.
    expect(given.map(tab => docTabToMarkdown(tab).markdown)).toEqual(["Set up\n", "Set up\n"]);
    expect(fresh.steps.map(step => step.name)).toEqual(["first"]);
  });

  it("records the list item that holds a positioned image as far as the model answers", async () => {
    let scenario = scenarioOf("positioned-list-item");
    let { fresh } = await recordedByModel({ ...scenario, steps: scenario.steps.slice(0, -1) });
    let [deeper, topLevel] = fresh.steps;
    let { tabId } = fresh.before;

    expect(imageLines(fresh.before)).toEqual(
      ["- Before the image", "    - [Image] Anchor of the image", "    - After the image"]);
    let listId = paragraphOf(fresh.before, "Anchor of the image").bullet?.listId ?? "";
    expect(fresh.before.lists[listId].listProperties.nestingLevels).toEqual(presetLevels());
    expect(imageLines(deeper.after)).toEqual(
      ["- Before the image", "    - [Image] Anchor of the image", "      - After the image"]);
    expect(imageLines(topLevel.after)).toEqual(
      ["- Before the image", "    - [Image] Anchor of the image", "- After the image"]);
    for (let tab of [fresh.before, deeper.after, topLevel.after]) {
      expect(anchors(tab)).toEqual(["Anchor of the image"]);
    }

    // What the builders send beside the anchored item, as the tab reads: their empty
    // paragraph goes in directly behind it, and nothing starts where it starts.
    let anchored = fresh.before.body.content.find(element => element.paragraph?.positionedObjectIds);
    let behind = deeper.requests.filter(request =>
      "insertText" in request && /^\t+\n$/.test(request.insertText.text));
    expect(behind.map(startOf)).toEqual([anchored?.endIndex]);
    expect(deeper.requests.map(startOf)).not.toContain(anchored?.startIndex);

    // The step that waits for Google: the anchored item is taken in, an empty paragraph is
    // inserted at its start and deleted after the bullets, and the model has no answer.
    let reached = topLevel.after;
    let item = reached.body.content.find(element => element.paragraph?.positionedObjectIds);
    let itemStart = item?.startIndex ?? -1;
    let last = stepRequests(scenario.steps[2], reached);
    expect(last).toContainEqual({ insertText: { location: { index: itemStart, tabId }, text: "\n" } });
    expect(last.at(-1)).toEqual({
      deleteContentRange: { range: { startIndex: itemStart, endIndex: itemStart + 1, tabId } },
    });
    let refusal: unknown;
    try {
      applyDocsRequests(reached, last);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(NotModelledError);
    expect(refusal).toMatchObject({ invariant: false });

    let whole = modelTransport();
    let failure = await rejection(
      recordScenario(scenario, whole.transport, { templateId: "template", pauseMs: 0 }));
    expect(failure.message).toContain(
      "positioned-list-item / an item one level in, behind an empty paragraph: not modelled");
    expect(failure.cause).toBeInstanceOf(NotModelledError);
    expect(whole.discarded).toEqual(["document-1"]);

    await expect(recordedByModel(scenario, { copied: template(null) })).rejects.toThrow(
      "the template has no paragraph that anchors a positioned image");
    // The paragraph before this one is a table's, and the list needs one of text.
    await expect(recordedByModel(scenario, { copied: template("Before the image") })).rejects
      .toThrow("directly before and directly after the paragraph that anchors its positioned image");
  });

  it.each<[string, BlockSpec, ((tab: GoogleDocsTab) => void)?]>([
    ["a list item", { runs: ["An item\n"], bullet: { listId: "L1" } }],
    ["an empty paragraph", { runs: ["\n"] }],
    ["a paragraph that holds a chip", { runs: ["On ", { date: "Jan 5, 2026" }, "\n"] }],
    ["a table", { table: [["a\n"]] }],
    ["a paragraph that anchors an object itself", { runs: ["Another anchor\n"] }, tab => {
      paragraphOf(tab, "Another anchor").positionedObjectIds = ["image-2"];
    }],
  ])("makes no list around an anchored paragraph that has %s beside it", (_what, beside, change) => {
    let { setup } = scenarioOf("positioned-list-item");
    let text = para("Text");
    let anchor = para("Anchor");
    // Directly before the anchored paragraph, then directly after it. A paragraph opens and
    // closes each tab, as one lies on both sides of a table.
    for (let blocks of [[beside, anchor, text], [text, anchor, beside, text]]) {
      let tab = buildTab([{ runs: ["\n"] }, ...blocks], structuredClone(BULLET_LIST));
      paragraphOf(tab, "Anchor").positionedObjectIds = ["image-1"];
      change?.(tab);
      expect(() => setup?.(tab)).toThrow(
        "directly before and directly after the paragraph that anchors its positioned image");
    }
    let plain = buildTab([text, anchor, text]);
    paragraphOf(plain, "Anchor").positionedObjectIds = ["image-1"];
    expect(setup?.(plain)).toHaveLength(3);
  });

  it("builds an unguarded step only where the builders refuse it", async () => {
    let scenario = scenarioOf("positioned-list-item");
    let { fresh } = await recordedByModel({ ...scenario, steps: scenario.steps.slice(0, -1) });
    let tabs = [fresh.before, ...fresh.steps.map(step => step.after)];
    expect(SCENARIOS.flatMap(({ name, steps }) =>
      steps.filter(step => step.batch === "unguarded").map(() => name)))
      .toEqual(["positioned-list-item", "positioned-list-item"]);

    for (let [index, step] of scenario.steps.entries()) {
      if (step.batch !== "unguarded") continue;
      expect(() => stepRequests({ ...step, batch: undefined }, tabs[index]))
        .toThrow(POSITIONED_ITEM_BEFORE);
      expect(stepRequests(step, tabs[index]).length).toBeGreaterThan(0);
    }
    // A step the builders build as the tab reads: the mark cannot outlive the refusal.
    expect(stepRequests(scenario.steps[0], tabs[0]).length).toBeGreaterThan(0);
    expect(() => stepRequests({ ...scenario.steps[0], batch: "unguarded" }, tabs[0]))
      .toThrow("is marked unguarded, and the builders build it");
  });

  it("discards the document when a step fails", async () => {
    let model = modelTransport();
    let { send } = model.transport;
    model.transport.send = async (documentId, requests) => {
      if (model.sent.length === 1) throw new Error("the server refuses the batch");
      await send(documentId, requests);
    };
    let scenario: Scenario = {
      name: "refused-step", steps: [{ name: "first", append: "One" }, { name: "second", append: "Two" }],
    };

    let failure = await rejection(recordScenario(scenario, model.transport, { pauseMs: 0 }));
    expect(failure.message).toBe("refused-step / second: the server refuses the batch");
    expect(model.discarded).toEqual(["document-1"]);
  });

  it("fails a scenario whose step the builders build no request for", async () => {
    let model = modelTransport();
    let scenario: Scenario = {
      name: "nothing-to-send",
      steps: [{ name: "a text", append: "Text" }, { name: "the text as it is", replace: ["Text", "Text"] }],
    };

    let failure = await rejection(recordScenario(scenario, model.transport, { pauseMs: 0 }));
    expect(failure.message).toBe("nothing-to-send / the text as it is: the builders build no request");
    expect(model.sent).toHaveLength(1);
    expect(model.discarded).toEqual(["document-1"]);
  });

  it("refuses a template scenario with no template, and a step that sends its recorded batch with no recording", async () => {
    let model = modelTransport();
    await expect(recordScenario(scenarioOf("chip-row-copies"), model.transport, { pauseMs: 0 }))
      .rejects.toThrow("starts from a copy of the template document: give its id with --template");
    expect(model.calls).toEqual([]);

    let failure = await rejection(
      recordScenario(scenarioOf("bullets-nesting"), model.transport, { pauseMs: 0 }));
    let none = "bullets-nesting / an item nested under the last: the step sends the batch its " +
      "committed recording holds, and there is none";
    expect(failure.message).toBe(none);
    expect(model.discarded).toEqual(["document-1"]);

    // Nor is there one when the recording holds another step in its place.
    let recorded = recordedOf("bullets-nesting");
    let at = recorded.steps.findIndex(step => step.name === "an item nested under the last");
    recorded.steps[at].name = "another step";
    failure = await rejection(
      recordScenario(scenarioOf("bullets-nesting"), model.transport, { recorded, pauseMs: 0 }));
    expect(failure.message).toBe(none);
    expect(model.discarded).toEqual(["document-1", "document-2"]);
  });
});

describe("the drift of a recording", () => {
  it("reports a batch the builders build otherwise, and an answer that differs, by step", () => {
    let fresh = recordedSplits();
    fresh.steps[1].requests.pop();
    rewritten(fresh.steps[3].after);

    expect(drift(recordedSplits(), fresh)).toEqual([
      "a body paragraph split: the builders send another batch",
      `two paragraphs joined: Google answers differently, at ${TEXT_PATH}`,
    ]);
    expect(drift(recordedSplits(), recordedSplits())).toEqual([]);

    let shorter = { ...recordedSplits(), steps: recordedSplits().steps.slice(0, -1) };
    expect(drift(recordedSplits(), shorter)).toEqual(
      ["body becomes a heading with bold: the step is missing from the new recording"]);
    expect(drift(shorter, recordedSplits())).toEqual(
      ["body becomes a heading with bold: the step is not in the committed recording"]);

    let renamed = recordedSplits();
    renamed.steps[1].name = "another name";
    expect(drift(recordedSplits(), renamed)).toEqual(
      ["a body paragraph split: the step is named \"another name\" in the new recording"]);
  });

  it("reports a document that starts differently", () => {
    let fresh = recordedSplits();
    rewritten(fresh.before);
    expect(drift(recordedSplits(), fresh))
      .toEqual([`the document starts differently, at ${TEXT_PATH}`]);

    // One document written two ways starts the same: here, a start index written out.
    let written = recordedSplits();
    written.before.body.content[0].startIndex = 0;
    expect(written.before).not.toEqual(recordedSplits().before);
    expect(drift(recordedSplits(), written)).toEqual([]);
  });

  it("leaves the height of a row a merge left Google to size out of the drift", () => {
    let before = prunedTab(buildTab([
      { runs: ["\n"] }, { table: [["a\n", "b\n"], ["c\n", "d\n"]] }, { runs: ["\n"] },
    ]));
    let index = before.body.content.find(element => element.table)?.startIndex ?? -1;
    let { tabId } = before;
    let requests: GoogleDocsRequest[] = [{
      mergeTableCells: {
        tableRange: {
          tableCellLocation: { tableStartLocation: { index, tabId }, rowIndex: 0, columnIndex: 0 },
          rowSpan: 1, columnSpan: 2,
        },
      },
    }];
    let recorded: DocsLiveFixture = {
      name: "a-merge", before,
      steps: [{ name: "a merge", requests, after: prunedTab(applyDocsRequests(before, requests)) }],
    };
    let resized = (row: number) => {
      let fresh = structuredClone(recorded);
      let rows = tableOf(fresh.steps[0].after).tableRows ?? [];
      rows[row].tableRowStyle = { minRowHeight: { magnitude: 36.5, unit: "PT" } };
      return fresh;
    };

    expect(drift(recorded, resized(0))).toEqual([]);
    expect(drift(recorded, resized(1))).toEqual([
      "a merge: Google answers differently, at body.content[2].table.tableRows[1].tableRowStyle",
    ]);
  });
});

/** The temporary directories the tests of the command line made, removed after each. */
const temporary: string[] = [];

/** `main` over the model's transport, a temporary directory that holds `recordings`, and a token file. */
function commandLine(recordings: readonly DocsLiveFixture[] = []) {
  let root = mkdtempSync(join(tmpdir(), "docs-live-"));
  temporary.push(root);
  let tokenFile = join(root, "token.txt");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  let directory = join(root, "recordings");
  mkdirSync(directory);
  for (let fixture of recordings) {
    writeFileSync(join(directory, `${fixture.name}.json`), `${JSON.stringify(fixture)}\n`);
  }
  let lines: string[] = [];
  let tokens: string[] = [];
  let model = modelTransport();
  let run = (...argv: string[]) => main(argv, {
    transport: token => {
      tokens.push(token);
      return model.transport;
    },
    directory, print: line => lines.push(line), pauseMs: 0,
  });
  let files = (): Record<string, string> => Object.fromEntries(readdirSync(directory).toSorted()
    .map(file => [file, readFileSync(join(directory, file), "utf8")]));
  return { directory, tokenFile, lines, tokens, model, run, files };
}

describe("the command line", () => {
  afterEach(() => {
    for (let root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("checks recordings against a fresh one, writes nothing, and fails one that drifted", async () => {
    let altered = recordedSplits();
    rewritten(altered.steps[0].after);
    let drifted = commandLine([altered]);
    let held = drifted.files();
    expect(await drifted.run(drifted.tokenFile, "--check")).toBe(1);
    expect(drifted.lines).toEqual(
      [`paragraph-splits: headings and body: Google answers differently, at ${TEXT_PATH}`]);
    expect(drifted.files()).toEqual(held);
    expect(drifted.model.documents.size).toBe(0);
    expect(drifted.tokens).toEqual([TOKEN]);
    expect(drifted.lines.join("\n")).not.toContain(TOKEN);

    // One recording that is as it was does not hide another that drifted.
    let mixed = commandLine([altered, recordedOf("table-looks")]);
    expect(await mixed.run(mixed.tokenFile, "--check")).toBe(1);
    expect(mixed.lines).toEqual([
      `paragraph-splits: headings and body: Google answers differently, at ${TEXT_PATH}`,
      "table-looks: as recorded",
    ]);
    let clean = commandLine([recordedOf("table-looks")]);
    expect(await clean.run(clean.tokenFile, "--check")).toBe(0);
  });

  it("writes a recording as compact JSON", async () => {
    let line = commandLine();
    expect(await line.run(line.tokenFile, "--only", "paragraph-splits")).toBe(0);
    expect(line.lines).toEqual(["paragraph-splits: recorded, 6 steps"]);
    expect(Object.keys(line.files())).toEqual(["paragraph-splits.json"]);
    let text = line.files()["paragraph-splits.json"];
    let written = JSON.parse(text) as DocsLiveFixture;
    expect(text).toBe(`${JSON.stringify(written)}\n`);
    expect(drift(recordedSplits(), written)).toEqual([]);
    expect(text).not.toContain(TOKEN);

    // Before it replaces a file it says where the new recording differs from it.
    rewritten(written.steps[0].after);
    writeFileSync(join(line.directory, "paragraph-splits.json"), `${JSON.stringify(written)}\n`);
    expect(await line.run(line.tokenFile, "--only", "paragraph-splits")).toBe(0);
    expect(line.lines.slice(1)).toEqual([
      `paragraph-splits: headings and body: Google answers differently, at ${TEXT_PATH}`,
      "paragraph-splits: recorded, 6 steps",
    ]);
    expect(line.files()["paragraph-splits.json"]).toBe(text);

    // A scenario of the template is left alone until the template's id is given.
    line.lines.length = 0;
    expect(await line.run(line.tokenFile, "--only", "chip-row-copies")).toBe(0);
    expect(line.lines).toEqual([
      "chip-row-copies: skipped, it starts from a copy of the template document (--template <docId>)",
    ]);
    expect(await line.run(line.tokenFile, "--template", "template-id", "--only", "chip-row-copies"))
      .toBe(0);
    expect(line.lines.at(-1)).toBe("chip-row-copies: recorded, 2 steps");
    expect(line.model.calls.filter(call => call === "copy")).toHaveLength(1);

    // A scenario that fails is reported and leaves no file.
    expect(await line.run(line.tokenFile, "--only", "bullets-nesting")).toBe(1);
    expect(line.lines.at(-1)).toContain("bullets-nesting: failed: bullets-nesting / an item nested");
    expect(Object.keys(line.files())).toEqual(["chip-row-copies.json", "paragraph-splits.json"]);
    expect(line.model.documents.size).toBe(0);
  });

  it("refuses a token file of more than one line before any request", async () => {
    let line = commandLine();
    writeFileSync(line.tokenFile, `${TOKEN}\nanother line\n`);
    expect(await line.run(line.tokenFile, "--only", "paragraph-splits")).toBe(2);
    expect(line.tokens).toEqual([]);
    expect(line.lines.join("\n")).not.toContain(TOKEN);
  });

  it("reads a directory's recordings in the order of their file names, and refuses a misnamed one", () => {
    let [first, second] = FIXTURES;
    let line = commandLine([second, first]);
    expect(readFixtures(line.directory)).toEqual([first, second]);

    writeFileSync(join(line.directory, "another-name.json"), `${JSON.stringify(first)}\n`);
    expect(() => readFixtures(line.directory))
      .toThrow(`another-name.json holds a recording named "${first.name}"`);
  });

  it("prints the usage and the scenario names for arguments it cannot read", async () => {
    let line = commandLine();
    let unreadable = [
      [], ["--check"], [line.tokenFile, "--only"], [line.tokenFile, "--only", "no-such-scenario"],
      [line.tokenFile, "--template"], [line.tokenFile, "--template", "--check"],
      [line.tokenFile, "--bogus", "value"], [line.tokenFile, "stray"],
      [join(line.directory, "no-token.txt")],
    ];
    for (let argv of unreadable) {
      line.lines.length = 0;
      expect(await line.run(...argv), argv.join(" ")).toBe(2);
      expect(line.lines).toEqual([
        "usage: pnpm --filter @gadgets/google-gatekeeper record:docs-fixtures <token-file> " +
        "[--only name] [--check] [--template <docId>]",
        `scenarios: ${SCENARIOS.map(scenario => scenario.name).join(", ")}`,
      ]);
    }
    expect(line.tokens).toEqual([]);
    expect(line.model.calls).toEqual([]);
    expect(line.files()).toEqual({});
  });
});

/** A tab as `documents.get` answers with it. */
function answeredTab({ tabId, title, body }: GoogleDocsTab) {
  return { tabProperties: { tabId, title }, documentTab: { body } };
}

describe("the transport that calls Google", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token in the Authorization header alone, and names the call and the status of a failure", async () => {
    let seen: { url: string; method?: string; authorization: string | null; body: string }[] = [];
    let answer: { status: number; body: unknown; text?: string } = { status: 200, body: { id: "copy-1" } };
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      seen.push({
        url: input, method: init.method,
        authorization: new Headers(init.headers).get("Authorization"), body: String(init.body),
      });
      return new Response(answer.text ?? JSON.stringify(answer.body), { status: answer.status });
    });
    let transport = googleTransport(TOKEN);
    let files = "https://www.googleapis.com/drive/v3/files";
    let authorization = `Bearer ${TOKEN}`;

    expect(await transport.copy("template/1", "Recording: one")).toBe("copy-1");
    await transport.discard("copy-1");
    expect(seen).toEqual([
      {
        url: `${files}/template%2F1/copy?fields=id&supportsAllDrives=true`, method: "POST",
        authorization, body: JSON.stringify({ name: "Recording: one" }),
      },
      {
        url: `${files}/copy-1?fields=id&supportsAllDrives=true`, method: "PATCH",
        authorization, body: JSON.stringify({ trashed: true }),
      },
    ]);

    // A document is created under the title given, read as its first tab, and sent a batch
    // as it is.
    let documents = "https://docs.googleapis.com/v1/documents";
    let [first, second] = [newDocument(), { ...newDocument(), tabId: "t.second" }];
    let batch: GoogleDocsRequest[] = [
      { insertText: { location: { index: 1, tabId: first.tabId }, text: "One" } },
    ];
    seen.length = 0;
    answer = { status: 200, body: { documentId: "doc-1" } };
    expect(await transport.create("Recording: two")).toBe("doc-1");
    answer = { status: 200, body: { documentId: "doc-1", tabs: [answeredTab(first), answeredTab(second)] } };
    expect(await transport.read("doc-1")).toMatchObject({ tabId: first.tabId, body: first.body });
    answer = { status: 200, body: {} };
    await transport.send("doc-1", batch);
    expect(seen).toEqual([
      {
        url: `${documents}?fields=documentId`, method: "POST",
        authorization, body: JSON.stringify({ title: "Recording: two" }),
      },
      {
        url: `${documents}/doc-1?includeTabsContent=true&prettyPrint=false`, method: undefined,
        authorization, body: "undefined",
      },
      {
        url: `${documents}/doc-1:batchUpdate`, method: "POST",
        authorization, body: JSON.stringify({ requests: batch }),
      },
    ]);

    answer = { status: 200, body: {} };
    expect((await rejection(transport.copy("template", "Recording: one"))).message)
      .toBe("copying the template document gave no document id");
    answer = { status: 403, body: { error: { message: "what Google answered" } } };
    expect((await rejection(transport.copy("template", "Recording: one"))).message)
      .toBe("copying the template document failed [http=403]");
    expect((await rejection(transport.discard("copy-1"))).message)
      .toBe("moving the document to the trash failed [http=403]");
    // An answer that is not JSON is named, never quoted.
    answer = { status: 200, body: undefined, text: "<html>what Google answered" };
    expect((await rejection(transport.copy("template", "Recording: one"))).message)
      .toBe("copying the template document answered something that is not JSON [http=200]");
    for (let { url, body } of seen) expect(url + body).not.toContain(TOKEN);
  });
});
