// Holds the copy of a Google Doc the gatekeeper keeps to its contract: a pruned tab renders as
// the tab Google sent and takes every batch as it does, shares nothing with it, and comes back
// from the store as it went in.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlankGoogleDoc, DOCUMENT_FIELDS, GoogleDocsApi, NEW_DOCUMENT_NAMED_STYLES,
  type GoogleDocsDocument, type GoogleDocsTab, type Paragraph, type ParagraphElement,
  type StructuralElement, type Table, type TableCellBorder, type TextStyle,
} from "../src/docs-api";
import {
  applyDocsRequests, hasModelIndexes, type ModelParagraphStyle, type ModelTextStyle,
} from "../src/docs-model";
import { storedDocCopy } from "../src/docs-copy";
import {
  DOC_COPY_FORMAT_VERSION, DOC_COPY_UNREADABLE, DOC_TAB_FIELDS, fetchedDoc,
  googleDocNamedRangeIds, googleDocNamedRanges, isDocCopyUnreadable, pruneTab,
} from "../src/docs-replica";
import { heldDoc } from "../src/docs-store";
import { docTabToMarkdown, type DocTabSnapshot } from "../src/markdown-converter";
import { buildTab, cellOf, MODELS, seeded, type BlockSpec } from "./doc-fixture";
import { fakeDocStore } from "./doc-store-fake";
import {
  DOCS_API_FIELD_NAMES, docsGetResponse, parseFieldMask, poisonOutsideMask, rawDocsDocument,
  selectFields,
} from "./docs-fields";
import { prunedTab, readFixtures } from "./docs-live-fixtures";
import { locateQuote } from "./locate-quote-whole";

const FIXTURES = readFixtures();

/** Every recorded tab, named by its recording and its place in it. */
const RECORDED: { name: string; tab: GoogleDocsTab }[] = FIXTURES.flatMap(fixture => [
  { name: `${fixture.name}, before`, tab: fixture.before },
  ...fixture.steps.map(step => ({ name: `${fixture.name}, after ${step.name}`, tab: step.after })),
]);

// --- A tab as Google sends it: with what the gatekeeper does not read

/**
 * The parts of which the copy keeps no suggestion ids (it keeps those of text runs, the other
 * paragraph elements, tables, rows and cells).
 */
const SUGGESTIBLE: ReadonlySet<string> = new Set([
  "sectionBreak", "tableOfContents",
]);

/**
 * A deep copy of `tab` with fields the gatekeeper does not read added throughout, as
 * `documents.get` sends many: an unknown key on every object, Google's own fields where the copy
 * keeps a part only in part or as `{}`, and the tab's other collections. No kept field is touched.
 */
function dressed(tab: GoogleDocsTab): GoogleDocsTab {
  let copy = structuredClone(tab);
  let dress = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (let item of value) dress(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    let held = value as Record<string, unknown>;
    // Suggested changes are keyed by their ids, so a key added beside them would be one more.
    if (/^suggested\w*Changes$/.test(key)) {
      for (let inner of Object.values(held)) dress(inner, "change");
      return;
    }
    for (let [name, inner] of Object.entries(held)) dress(inner, name);
    held.zzUnread = { deep: [1] };
    if (key === "paragraphStyle" && !("headingId" in held)) held.direction = "LEFT_TO_RIGHT";
    if (key === "textStyle") {
      held.weightedFontFamily = { fontFamily: "Arial", weight: 400 };
      held.baselineOffset = "NONE";
      Object.assign(held, { smallCaps: false, backgroundColor: {} });
    }
    if (key === "bullet") held.textStyle = { bold: true, fontSize: { magnitude: 11, unit: "PT" } };
    if (key === "horizontalRule") held.textStyle = { bold: true };
    if (key === "nestingLevels") {
      held.indentStart = { magnitude: 36, unit: "PT" };
      held.indentFirstLine = { magnitude: 18, unit: "PT" };
      held.bulletAlignment = "START";
      held.glyphFormat = "%0.";
      held.textStyle = { underline: true };
    }
    // Of a named style the copy keeps three fields of the text style and no paragraph style.
    if (key === "styles") {
      held.paragraphStyle = { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" };
      if (held.textStyle) {
        Object.assign(held.textStyle, {
          underline: true, smallCaps: false, fontSize: { magnitude: 11, unit: "PT" },
          foregroundColor: { color: { rgbColor: { red: 0.4 } } }, backgroundColor: {},
          link: { url: "https://example.com/" },
        });
      }
    }
    if (key === "sectionBreak") {
      held.sectionStyle = { sectionType: "CONTINUOUS", columnSeparatorStyle: "NONE" };
    }
    if (key === "tableOfContents") {
      held.content = [{
        startIndex: 1, endIndex: 2,
        paragraph: { elements: [], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } },
      }];
    }
    if (key === "tableRowStyle") held.preventOverflow = false;
    if (key === "person") held.personId = "kix.person";
    if (key === "richLink") held.richLinkId = "kix.richLink";
    if (key === "richLinkProperties") held.mimeType = "application/vnd.google-apps.document";
    if (key === "dateElement") {
      // Google sends a date's suggested property changes as `{}` where there are none.
      held.dateId = "kix.date";
      held.suggestedDateElementPropertiesChanges ??= {};
    }
    if (key === "dateElementProperties") {
      Object.assign(held, {
        timestamp: "2026-01-05T00:00:00Z", locale: "en", timeZoneId: "Etc/UTC",
        dateFormat: "DATE_FORMAT_ISO8601", timeFormat: "TIME_FORMAT_DISABLED",
      });
    }
    if (SUGGESTIBLE.has(key)) {
      Object.assign(held, {
        suggestedInsertionIds: ["suggest.in"], suggestedDeletionIds: ["suggest.out"],
        suggestedTextStyleChanges: { "suggest.in": { textStyle: { bold: true } } },
      });
    }
    if (key === "table") Object.assign(held, { rows: 2, columns: 4 });
  };
  dress(copy.body, "body");
  // The lists are keyed by their ids, so a key added beside them would be one more list.
  for (let list of Object.values(copy.lists)) dress(list, "list");
  dress(copy.namedStyles, "namedStyles");
  return Object.assign(copy, {
    documentStyle: { pageSize: { width: { magnitude: 612, unit: "PT" } } },
    inlineObjects: { "inline.1": { inlineObjectProperties: { embeddedObject: { title: "Chart" } } } },
    positionedObjects: { "positioned.1": { positionedObjectProperties: { positioning: {} } } },
    footnotes: { "footnote.1": { content: [{ endIndex: 1, paragraph: { elements: [] } }] } },
    headers: { "header.1": { content: [] } },
  });
}

// --- A tab of every element the rendering names

// The characters that stand, in a spec's runs, for the elements `buildTab` has no spec for.
const EQUATION = "\ue001";
const PAGE_BREAK = "\ue002";
const COLUMN_BREAK = "\ue003";
const IMAGE = "\ue004";
const DROPDOWN = "\ue005";

/** The elements `buildTab` has no spec for, under the character `withElements` replaces. */
const ELEMENTS: Record<string, Omit<ParagraphElement, "startIndex" | "endIndex">> = {
  [EQUATION]: { equation: {} },
  [PAGE_BREAK]: { pageBreak: { textStyle: { bold: true } } },
  [COLUMN_BREAK]: { columnBreak: { textStyle: { italic: true } } },
  [IMAGE]: {
    inlineObjectElement: {
      inlineObjectId: "inline.1", textStyle: { strikethrough: true },
      suggestedInsertionIds: ["suggest.image.in"], suggestedDeletionIds: ["suggest.image.out"],
    },
  },
  [DROPDOWN]: {
    dropdown: {
      dropdownId: "dropdown.1",
      textStyle: { bold: true },
      dropdownProperties: {
        dropdownDefinitionId: "definition.1", selectedOptionId: "option.2", displayValue: "Done",
      },
    },
  },
};

/** Every paragraph of `content`, in body order, those of the tables' cells included. */
function* paragraphsOf(content: readonly StructuralElement[]): Generator<Paragraph> {
  for (let { paragraph, table } of content) {
    if (paragraph) yield paragraph;
    for (let row of table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* paragraphsOf(cell.content ?? []);
    }
  }
}

/** Replace, in place, each text run that is one of `ELEMENTS`' characters by its element. */
function withElements(tab: GoogleDocsTab): void {
  for (let paragraph of paragraphsOf(tab.body.content)) {
    paragraph.elements = paragraph.elements.map(element => {
      let stands = element.textRun && ELEMENTS[element.textRun.content];
      if (!stands) return element;
      return { startIndex: element.startIndex, endIndex: element.endIndex, ...structuredClone(stands) };
    });
  }
}

/** The paragraph of `tab` whose text starts with `text`. */
function paragraphStarting(tab: GoogleDocsTab, text: string): Paragraph {
  for (let paragraph of paragraphsOf(tab.body.content)) {
    if (paragraph.elements[0]?.textRun?.content.startsWith(text)) return paragraph;
  }
  throw new Error(`no paragraph starts with ${JSON.stringify(text)}`);
}

/** The table of the body of `tab` whose first cell's text starts with `text`. */
function tableStarting(tab: GoogleDocsTab, text: string): Table {
  for (let { table } of tab.body.content) {
    let first = table?.tableRows?.[0]?.tableCells?.[0]?.content?.[0]?.paragraph;
    if (table && first?.elements[0]?.textRun?.content.startsWith(text)) return table;
  }
  throw new Error(`no table starts with ${JSON.stringify(text)}`);
}

/** A text style with the fields the model keeps beside those the gatekeeper's types name. */
const MODEL_STYLE = {
  underline: true,
  foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.25, blue: 0.125 } } },
  fontSize: { magnitude: 16, unit: "PT" },
} as TextStyle;

const BORDER = {
  color: { color: { rgbColor: { red: 1, green: 0.5, blue: 0.25 } } },
  width: { magnitude: 2, unit: "PT" },
  dashStyle: "DASH",
};

const LISTS: GoogleDocsTab["lists"] = {
  bullets: {
    listProperties: {
      nestingLevels: [{ glyphSymbol: "\u25cf", startNumber: 1 }, { glyphSymbol: "\u25cb", startNumber: 1 }],
    },
  },
  checks: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
  numbers: {
    listProperties: {
      nestingLevels: [{ glyphType: "DECIMAL", startNumber: 3 }, { glyphType: "ALPHA", startNumber: 2 }],
    },
  },
};

/** The cases of the rendering: their blocks, and a change for a field `buildTab` cannot set. */
const CASES: { name: string; blocks: BlockSpec[]; set?: (tab: GoogleDocsTab) => void }[] = [
  {
    name: "text in each style, and a link of each kind",
    blocks: [{
      runs: [
        "plain ",
        { text: "bold ", style: { bold: true } },
        { text: "italic ", style: { italic: true } },
        { text: "struck ", style: { strikethrough: true } },
        { text: "coloured ", style: MODEL_STYLE },
        { text: "web ", style: { link: { url: "https://example.com/a" } } },
        { text: "heading ", style: { link: { headingId: "h.1" } } },
        { text: "bookmark ", style: { link: { bookmarkId: "b.1" } } },
        { text: "other heading ", style: { link: { heading: { id: "h.2", tabId: "t.2" } } } },
        { text: "other bookmark ", style: { link: { bookmark: { id: "b.2", tabId: "t.2" } } } },
        { text: "tab", style: { link: { tabId: "t.3" } } },
        "\n",
      ],
    }],
  },
  {
    name: "chips and the elements that are not text",
    blocks: [
      {
        runs: [
          "chips ",
          { person: { name: "Ada Lovelace", email: "ada@example.com" }, style: { bold: true } },
          { person: { email: "grace@example.com" } },
          { richLink: { title: "Plan", uri: "https://example.com/plan" }, style: { italic: true } },
          { date: "Jan 5, 2026", style: { bold: true } },
          { dropdown: "Open" },
          DROPDOWN,
          { footnote: { id: "footnote.1", number: "1" }, style: { italic: true } },
          { autoText: "PAGE_NUMBER", style: { bold: true } },
          { autoText: "PAGE_COUNT" },
          EQUATION, PAGE_BREAK, COLUMN_BREAK, IMAGE,
          "\n",
        ],
      },
      { runs: [{ horizontalRule: true }, "\n"] },
    ],
  },
  {
    name: "a paragraph with positioned images",
    blocks: [{ runs: ["anchored\n"] }],
    set: tab => {
      paragraphStarting(tab, "anchored").positionedObjectIds = ["positioned.1", "positioned.2"];
    },
  },
  {
    name: "a title, a subtitle and a heading of each level",
    blocks: [
      { runs: ["Title\n"], namedStyleType: "TITLE" },
      { runs: ["Subtitle\n"], namedStyleType: "SUBTITLE" },
      ...[1, 2, 3, 4, 5, 6].map(level => (
        { runs: [`Level ${level}\n`], namedStyleType: `HEADING_${level}` })),
    ],
    set: tab => {
      paragraphStarting(tab, "Level 2").paragraphStyle.headingId = "h.level2";
    },
  },
  {
    name: "an aligned and an indented paragraph",
    blocks: [{ runs: ["centred\n"] }, { runs: ["indented\n"] }],
    set: tab => {
      Object.assign(paragraphStarting(tab, "centred").paragraphStyle, { alignment: "CENTER" });
      Object.assign(paragraphStarting(tab, "indented").paragraphStyle, {
        indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { magnitude: 18, unit: "PT" },
      });
    },
  },
  {
    name: "bulleted, checkbox and numbered lists, nested",
    blocks: [
      { runs: ["bullet\n"], bullet: { listId: "bullets" } },
      { runs: ["nested bullet\n"], bullet: { listId: "bullets", nestingLevel: 1 } },
      { runs: ["between lists\n"] },
      { runs: ["check\n"], bullet: { listId: "checks" } },
      { runs: ["third\n"], bullet: { listId: "numbers" } },
      { runs: ["second letter\n"], bullet: { listId: "numbers", nestingLevel: 1 } },
      { runs: ["fourth\n"], bullet: { listId: "numbers" } },
    ],
  },
  {
    name: "a table of contents and a section break inside the body",
    blocks: [
      { runs: ["before the contents\n"] },
      { structure: "tableOfContents", length: 12 },
      { runs: ["before the break\n"] },
      { structure: "sectionBreak" },
      { runs: ["after the break\n"] },
    ],
  },
  {
    name: "tables: merged cells, a look, a header row, a table in a cell, suggestions",
    blocks: [
      {
        table: [
          [
            {
              paragraphs: [{ runs: ["merged\n"] }],
              tableCellStyle: {
                rowSpan: 1, columnSpan: 2, contentAlignment: "MIDDLE",
                backgroundColor: { color: { rgbColor: { red: 0.9, green: 0.8, blue: 0.7 } } },
                paddingTop: { magnitude: 1, unit: "PT" }, paddingRight: { magnitude: 2, unit: "PT" },
                paddingBottom: { magnitude: 3, unit: "PT" }, paddingLeft: { magnitude: 4, unit: "PT" },
                borderTop: BORDER, borderRight: BORDER, borderBottom: BORDER, borderLeft: BORDER,
              },
            },
            "\n",
            "plain\n",
          ],
          [
            { paragraphs: [{ runs: ["tall\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 1 } },
            {
              paragraphs: [
                { runs: ["holds a table\n"] },
                { table: [["inner\n", { paragraphs: [{ runs: [IMAGE, "\n"] }] }]] },
                { runs: ["\n"] },
              ],
            },
            { paragraphs: [{ runs: ["suggested cell\n"] }], suggested: "insertion" },
          ],
          ["\n", "leaving row\n", "c\n"],
          ["suggested row\n", "b\n", { paragraphs: [{ runs: ["leaving\n"] }], suggested: "deletion" }],
        ],
        headerRows: 1,
        suggestedRows: { 2: "deletion", 3: "insertion" },
        columns: [120, null, 80],
        heights: [0, 30, 0, 0],
      },
      { runs: ["between tables\n"] },
      { table: [["suggested table\n"]] },
      { runs: ["after the tables\n"] },
    ],
    set: tab => {
      Object.assign(tableStarting(tab, "suggested table"), {
        suggestedInsertionIds: ["suggest.table"], suggestedDeletionIds: ["suggest.gone"],
      });
    },
  },
  {
    name: "named styles that give bold, italic and strikethrough",
    blocks: [
      { runs: ["styled heading\n"], namedStyleType: "HEADING_1" },
      { runs: ["styled subtitle\n"], namedStyleType: "SUBTITLE" },
      { runs: ["styled text\n"] },
    ],
    set: tab => {
      tab.namedStyles = {
        styles: [
          { namedStyleType: "NORMAL_TEXT", textStyle: { strikethrough: true, bold: false } },
          { namedStyleType: "HEADING_1", textStyle: { bold: true } },
          { namedStyleType: "SUBTITLE", textStyle: { italic: true, strikethrough: false } },
          { namedStyleType: "TITLE" },
        ],
      };
    },
  },
];

/** The tab of `blocks`, with the elements and the fields set by hand in place. */
function caseTab(blocks: BlockSpec[], changes: ((tab: GoogleDocsTab) => void)[]): GoogleDocsTab {
  let tab = buildTab(structuredClone(blocks), structuredClone(LISTS));
  withElements(tab);
  for (let change of changes) change(tab);
  return tab;
}

/** One tab of every case at once, a child tab: the tab with the most kinds of element. */
const RICHEST: GoogleDocsTab = {
  ...caseTab(CASES.flatMap(({ blocks }) => blocks), CASES.flatMap(({ set }) => set ?? [])),
  title: "Every element",
  parentTabId: "t.parent",
  nestingLevel: 1,
};

const RENDERED: { name: string; tab: GoogleDocsTab }[] = [
  ...CASES.map(({ name, blocks, set }) => ({ name, tab: caseTab(blocks, set ? [set] : []) })),
  { name: "every element at once", tab: RICHEST },
];

// --- A tab of every field the copy keeps

/** One of each field a pruned tab may hold and nothing else, none at a value pruning could invent. */
function everyFieldTab(): GoogleDocsTab {
  let look: ModelTextStyle = {
    bold: true, italic: true, strikethrough: true, underline: true,
    link: { url: "https://example.com/" },
    foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.25, blue: 1 } } },
    fontSize: { magnitude: 16, unit: "PT" },
  };
  let links: TextStyle["link"][] = [
    { tabId: "t.other" }, { bookmarkId: "kix.bookmark" }, { headingId: "h.heading" },
    { bookmark: { id: "kix.bookmark", tabId: "t.other" } },
    { heading: { id: "h.heading", tabId: "t.other" } },
  ];
  let paragraphStyle: ModelParagraphStyle = {
    namedStyleType: "HEADING_2", headingId: "h.heading", alignment: "CENTER",
    indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { magnitude: 18, unit: "PT" },
  };
  let kinds: Omit<ParagraphElement, "startIndex" | "endIndex">[] = [
    { textRun: { content: "Text", textStyle: look } },
    {
      textRun: {
        content: "new", textStyle: {}, suggestedInsertionIds: ["suggest.typed"],
        suggestedDeletionIds: ["suggest.struck"], suggestedTextStyleChanges: { "suggest.bold": {} },
      },
    },
    ...links.map(link => ({ textRun: { content: "to", textStyle: { link } } })),
    { autoText: { type: "PAGE_NUMBER", textStyle: look } },
    { horizontalRule: { suggestedDeletionIds: ["suggest.rule"] } },
    { pageBreak: { textStyle: look } },
    { columnBreak: { textStyle: look } },
    { footnoteReference: { footnoteId: "kix.note", footnoteNumber: "7", textStyle: look } },
    { equation: {} },
    { inlineObjectElement: { inlineObjectId: "kix.inline", textStyle: look } },
    {
      person: {
        textStyle: look, personProperties: { name: "Person 1", email: "person1@example.com" },
        suggestedDeletionIds: ["suggest.person"],
        suggestedPersonPropertiesChanges: { "suggest.person.name": {} },
      },
    },
    {
      richLink: {
        textStyle: look, richLinkProperties: { title: "Link 1", uri: "https://example.com/1" },
        suggestedInsertionIds: ["suggest.link"], suggestedTextStyleChanges: { "suggest.link.style": {} },
        suggestedRichLinkPropertiesChanges: { "suggest.link.title": {} },
      },
    },
    {
      dateElement: {
        textStyle: look, dateElementProperties: { displayText: "Jan 5, 2026" },
        suggestedDeletionIds: ["suggest.date"],
        suggestedDateElementPropertiesChanges: { "suggest.date.format": {} },
      },
    },
    {
      dropdown: {
        dropdownId: "kix.dropdown", textStyle: look, suggestedInsertionIds: ["suggest.dropdown"],
        dropdownProperties: {
          dropdownDefinitionId: "kix.definition", selectedOptionId: "kix.option", displayValue: "Open",
        },
        suggestedDropdownPropertiesChanges: { "suggest.dropdown.option": {} },
      },
    },
    { textRun: { content: "\n", textStyle: {} } },
  ];
  let paragraph: Paragraph = {
    elements: kinds.map((kind, index) => ({ startIndex: 1 + index, endIndex: 2 + index, ...kind })),
    paragraphStyle,
    bullet: { listId: "kix.list", nestingLevel: 1 },
    positionedObjectIds: ["kix.positioned"],
    suggestedParagraphStyleChanges: { "suggest.centred": {} },
    suggestedBulletChanges: { "suggest.listed": {} },
  };
  let border: TableCellBorder = {
    color: { color: { rgbColor: { red: 1, green: 0.5, blue: 0.25 } } },
    width: { magnitude: 2, unit: "UNIT_UNSPECIFIED" }, dashStyle: "DASH",
  };
  let padding = { magnitude: 8, unit: "PT" };
  let suggested = { suggestedInsertionIds: ["suggest.in"], suggestedDeletionIds: ["suggest.out"] };
  let table: Table = {
    tableRows: [{
      startIndex: 31, endIndex: 35,
      tableCells: [{
        startIndex: 32, endIndex: 35,
        content: [{
          startIndex: 33, endIndex: 35,
          paragraph: {
            elements: [{ startIndex: 33, endIndex: 35, textRun: { content: "a\n", textStyle: {} } }],
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          },
        }],
        tableCellStyle: {
          rowSpan: 2, columnSpan: 3, contentAlignment: "MIDDLE",
          backgroundColor: { color: { rgbColor: { red: 0.25, green: 1, blue: 0.5 } } },
          paddingTop: padding, paddingRight: padding, paddingBottom: padding, paddingLeft: padding,
          borderTop: border, borderRight: border, borderBottom: border, borderLeft: border,
        },
        ...suggested,
      }],
      tableRowStyle: { tableHeader: true, minRowHeight: { magnitude: 24, unit: "PT" } },
      ...suggested,
    }],
    tableStyle: {
      tableColumnProperties: [{ widthType: "FIXED_WIDTH", width: { magnitude: 120, unit: "PT" } }],
    },
    ...suggested,
  };
  let tab: GoogleDocsTab = {
    tabId: "t.child", title: "Every field", parentTabId: "t.parent", index: 2, nestingLevel: 1,
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 30, paragraph },
        { startIndex: 30, endIndex: 36, table },
        { startIndex: 36, endIndex: 37, tableOfContents: {} },
      ],
    },
    lists: {
      "kix.list": {
        listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphSymbol: "●", startNumber: 3 }] },
      },
    },
    namedRanges: {},
    namedStyles: {
      styles: [
        { namedStyleType: "HEADING_2", textStyle: { bold: true, italic: true, strikethrough: true } },
      ],
    },
  };
  // Google leaves out the start index of the section break that opens a body.
  Reflect.deleteProperty(tab.body.content[0], "startIndex");
  return tab;
}

const EVERY_FIELD: GoogleDocsTab = everyFieldTab();

/** Every tab the pruning is held to: recorded, built for a case, and holding every kept field. */
const CORPUS: { name: string; tab: GoogleDocsTab }[] = [
  ...RECORDED, ...RENDERED, { name: "one of each kept field", tab: EVERY_FIELD },
];

// --- Tabs worn down at random

/** The seed of the worn copies. */
const SEED = 20261116;

/** The fields the pruning refuses a tab without, by name; a body's `content` is one more. */
const REFUSED_WITHOUT = new Set(["elements", "paragraphStyle", "body", "lists"]);

/** What names and places a tab, and its named ranges: a worn copy holds them as the tab does. */
const WORN_AS_IT_IS = new Set([
  "tabId", "title", "parentTabId", "index", "nestingLevel", "namedRanges",
]);

/**
 * Copies of `tab` worn down at random: of each object a field dropped or emptied, never one the
 * pruning refuses a tab without, nor what names and places the tab.
 */
function wornCopies(tab: GoogleDocsTab, seed: number, count: number): GoogleDocsTab[] {
  let random = seeded(seed);
  // `under` is the key the object sits under, and nothing for the tab itself.
  let wear = (value: unknown, under?: string): unknown => {
    if (Array.isArray(value)) return value.map(item => wear(item, under));
    if (!value || typeof value !== "object") return value;
    let worn: Record<string, unknown> = {};
    for (let [key, inner] of Object.entries(value)) {
      if (under === undefined && WORN_AS_IT_IS.has(key)) {
        worn[key] = structuredClone(inner);
        continue;
      }
      let draw = random();
      let holds = inner !== null && typeof inner === "object";
      if (REFUSED_WITHOUT.has(key) || (under === "body" && key === "content")) {
        worn[key] = wear(inner, key);
      } else if (draw < 0.10 && under !== "lists") {
        continue;
      } else if (draw < 0.15 && Array.isArray(inner)) {
        worn[key] = [];
      } else if (draw < 0.15 && holds &&
          !Object.keys(inner as object).some(name => REFUSED_WITHOUT.has(name))) {
        worn[key] = {};
      } else {
        worn[key] = wear(inner, key);
      }
    }
    return worn;
  };
  return Array.from({ length: count }, () => wear(tab) as GoogleDocsTab);
}

// --- Walking

/** Every object and array under `value`, itself included. */
function partsOf(value: unknown, into = new Set<object>()): Set<object> {
  if (!value || typeof value !== "object") return into;
  into.add(value);
  for (let inner of Object.values(value)) partsOf(inner, into);
  return into;
}

/** `value` with every object and array under it frozen. */
function deepFrozen<T>(value: T): T {
  for (let part of partsOf(value)) Object.freeze(part);
  return value;
}

/** Where two JSON texts first differ, as a path of keys (never a value), or nothing. */
function firstDifference(left: string, right: string): string | undefined {
  if (left === right) return undefined;
  let differs = (a: unknown, b: unknown, path: string): string | undefined => {
    let nested = a !== null && b !== null && typeof a === "object" && typeof b === "object";
    if (!nested || Array.isArray(a) !== Array.isArray(b)) return a === b ? undefined : path;
    let [keysA, keysB] = [Object.keys(a as object), Object.keys(b as object)];
    for (let at = 0; at < Math.max(keysA.length, keysB.length); at++) {
      let key = keysA[at] ?? keysB[at];
      if (keysA[at] !== keysB[at]) return `${path}.${key}`;
      let found = differs(
        (a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (found) return found;
    }
    return undefined;
  };
  return differs(JSON.parse(left), JSON.parse(right), "tab") ?? "tab";
}

/** The fields pruned `tabs` hold, by the key each object sits under (`lists.*` for a list). */
function keptFields(tabs: readonly GoogleDocsTab[]): Record<string, string> {
  let fields = new Map<string, Set<string>>();
  let visit = (value: unknown, under: string): void => {
    if (Array.isArray(value)) {
      for (let item of value) visit(item, under);
      return;
    }
    if (!value || typeof value !== "object") return;
    let keys = fields.get(under) ?? new Set<string>();
    fields.set(under, keys);
    for (let [key, inner] of Object.entries(value)) {
      // The keys of the lists and of suggested changes are ids, which no version names.
      if (under === "lists" || /^suggested\w*Changes$/.test(under)) {
        visit(inner, `${under}.*`);
      } else {
        keys.add(key);
        visit(inner, key);
      }
    }
  };
  for (let tab of tabs) visit(tab, "tab");
  return Object.fromEntries([...fields].toSorted(([a], [b]) => a < b ? -1 : 1)
    .map(([under, keys]) => [under, [...keys].toSorted().join(" ")]));
}

/** `style` as pruning leaves the style of a text run. */
function prunedStyle(style: TextStyle): TextStyle {
  let pruned = pruneTab(buildTab([{ runs: [{ text: "\n", style }] }]));
  return pruned.body.content[1].paragraph!.elements[0].textRun!.textStyle;
}

/** The rendering of `tab`, its source map's run styles pruned as the tab's are. */
function renderingOf(tab: GoogleDocsTab): DocTabSnapshot {
  let rendering = docTabToMarkdown(tab);
  for (let block of rendering.sourceMap.blocks) {
    for (let segment of block.segments) {
      if ("textStyle" in segment) segment.textStyle = prunedStyle(segment.textStyle);
    }
  }
  return rendering;
}

/** A document of `tabs`, as `documents.get` gives one. */
function documentOf(tabs: GoogleDocsTab[]): GoogleDocsDocument {
  return { documentId: "doc-1", title: "A document", revisionId: "revision-1", tabs };
}

/** The named ranges of a tab that two writes marked and something else named a range in. */
const MARKED: GoogleDocsTab["namedRanges"] = {
  "gadgets-write-first": {
    namedRanges: [
      { namedRangeId: "range.1", name: "gadgets-write-first" },
      { namedRangeId: "range.2", name: "gadgets-write-first" },
    ],
  },
  "someone else's": { namedRanges: [{ namedRangeId: "range.3", name: "someone else's" }] },
  "gadgets-write-second": { namedRanges: [{ namedRangeId: "range.4" }] },
};

// --- Pruning

describe("pruning a tab", () => {
  it("has recordings and cases to hold it to", () => {
    expect(RECORDED.length).toBeGreaterThan(FIXTURES.length);
    expect(RENDERED.length).toBeGreaterThan(1);
  });

  it("returns a recorded tab unchanged but for its named ranges, and a pruned tab as it is", () => {
    let ranges = { foreign: { namedRanges: [{ namedRangeId: "range.1", name: "foreign" }] } };
    for (let { name, tab } of RECORDED) {
      let sent = { ...tab, title: "Meeting notes", namedRanges: ranges };
      let pruned = pruneTab(sent);
      expect(pruned, name).toStrictEqual({ ...tab, title: "Meeting notes", namedRanges: {} });
      expect(pruneTab(pruned), name).toStrictEqual(pruned);
    }
    for (let { name, tab } of RENDERED) {
      let pruned = pruneTab(dressed(tab));
      expect(pruneTab(pruned), name).toStrictEqual(pruned);
    }
  });

  it("drops everything the gatekeeper does not read and no field it does", () => {
    for (let { name, tab } of [...RECORDED, ...RENDERED]) {
      expect(pruneTab(dressed(tab)), name).toStrictEqual(pruneTab(tab));
    }
  });

  it("keeps a tab's title, a person's name and address and a rich link's title and address", () => {
    let pruned = pruneTab(dressed(RICHEST));
    expect(pruned.title).toBe("Every element");
    expect(pruned.parentTabId).toBe("t.parent");
    let elements = [...paragraphsOf(pruned.body.content)].flatMap(paragraph => paragraph.elements);
    expect(elements.flatMap(element => element.person?.personProperties ?? [])).toStrictEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
      { email: "grace@example.com" },
    ]);
    expect(elements.flatMap(element => element.richLink?.richLinkProperties ?? []))
      .toStrictEqual([{ title: "Plan", uri: "https://example.com/plan" }]);
  });

  it("returns a tab that holds one of each kept field as it is", () => {
    expect(pruneTab(EVERY_FIELD)).toStrictEqual(EVERY_FIELD);
    expect(pruneTab(dressed(EVERY_FIELD))).toStrictEqual(EVERY_FIELD);
    // Its names are their own stand-ins, so a recording changes its title alone.
    expect(prunedTab(EVERY_FIELD)).toStrictEqual({ ...EVERY_FIELD, title: "" });
  });

  it("shares no object or array with the tab it was given", () => {
    let recorded = FIXTURES.find(fixture => fixture.name === "around-tables")!.steps.at(-1)!.after;
    for (let tab of [recorded, RICHEST, dressed(RICHEST)]) {
      let sent = partsOf(tab);
      let shared = [...partsOf(pruneTab(tab))].filter(part => sent.has(part));
      expect(shared).toStrictEqual([]);

      // And so a tab that cannot change prunes to one that can, everywhere.
      let pruned = pruneTab(deepFrozen(structuredClone(tab)));
      for (let part of partsOf(pruned)) {
        if (Array.isArray(part)) part.push(null);
        else Object.assign(part, { changed: true });
      }
    }
  });
});

/** A tab of `content`, with `more` laid over it: what the types would not let a test write. */
function tabOf(content: unknown, more: Record<string, unknown> = {}): GoogleDocsTab {
  return {
    tabId: "t.0", title: "Tab", index: 0, nestingLevel: 0,
    body: { content }, lists: {}, namedRanges: {}, ...more,
  } as GoogleDocsTab;
}

/** A tab of one paragraph of `elements`, with `more` laid over the paragraph. */
function paragraphTab(elements: unknown, more: Record<string, unknown> = {}): GoogleDocsTab {
  return tabOf([{ endIndex: 2, paragraph: { elements, paragraphStyle: {}, ...more } }]);
}

describe("pruning by the table", () => {
  it("refuses a paragraph without its elements or its style, a tab without its body or its " +
      "lists, and a body without its content, and one with any of those null", () => {
    // Each part holds a text beside what it lacks. The table's refusal is the name of the field
    // and nothing of the document; a tab without its lists is refused by the engine, in its words.
    let text = { zzSecret: "text of the document" };
    let refused: [string, GoogleDocsTab, string?][] = [
      ["a paragraph without its elements", paragraphTab(undefined, text), "elements"],
      ["a paragraph without its style",
        paragraphTab([], { paragraphStyle: undefined, ...text }), "paragraphStyle"],
      ["a tab without its body", tabOf([], { body: undefined, ...text }), "body"],
      ["a body without its content", tabOf([], { body: text }), "content"],
      ["a tab without its lists", tabOf([], { lists: undefined, ...text })],
    ];
    let nulls: [string, GoogleDocsTab][] = [
      ["a paragraph's elements", paragraphTab(null)],
      ["a paragraph's style", paragraphTab([], { paragraphStyle: null })],
      ["a tab's body", tabOf([], { body: null })],
      ["a body's content", tabOf(null)],
      ["a tab's lists", tabOf([], { lists: null })],
      ["a paragraph's positioned objects", paragraphTab([], { positionedObjectIds: null })],
    ];
    for (let [name, tab, field] of [...refused, ...nulls]) {
      expect(() => pruneTab(tab), name).toThrow(TypeError);
      if (field) {
        expect(() => pruneTab(tab), name)
          .toThrow(new RegExp(`^Google Docs returned a part without its ${field}$`));
      }
    }
  });

  it("keeps a list under its id, whatever the id is", () => {
    // Parsed JSON holds `__proto__` as a key of its own, which an assignment would not write.
    let lists = JSON.parse(`{ "__proto__": { "zzUnread": 1 }, "kix.a": {} }`);
    let tab = tabOf([], { lists });
    let pruned = `{"listProperties":{"nestingLevels":[]}}`;
    expect(JSON.stringify(pruneTab(tab).lists)).toBe(`{"__proto__":${pruned},"kix.a":${pruned}}`);
  });

  it("writes an empty style for a text run without one, and no levels for a list without " +
      "them", () => {
    let tab = tabOf(
      [{ endIndex: 2, paragraph: {
        elements: [{ endIndex: 2, textRun: { content: "x" } }], paragraphStyle: {},
      } }],
      { lists: { a: {}, b: { listProperties: {} } } },
    );
    let pruned = pruneTab(tab);
    expect(pruned.body.content[0].paragraph!.elements)
      .toStrictEqual([{ endIndex: 2, textRun: { content: "x", textStyle: {} } }]);
    expect(pruned.lists).toStrictEqual({
      a: { listProperties: { nestingLevels: [] } },
      b: { listProperties: { nestingLevels: [] } },
    });
  });

  it("keeps a start index only where Google sent one", () => {
    // Google leaves out a start index of 0. One it sent is kept, 0 included.
    for (let start of [{}, { startIndex: 0 }, { startIndex: 7 }]) {
      let content = [
        {
          ...start,
          endIndex: 2,
          paragraph: {
            elements: [{ ...start, endIndex: 2, textRun: { content: "x\n", textStyle: {} } }],
            paragraphStyle: {},
          },
        },
        {
          ...start,
          endIndex: 4,
          table: {
            tableRows: [
              { ...start, endIndex: 4, tableCells: [{ ...start, endIndex: 4, content: [] }] },
            ],
          },
        },
      ];
      expect(pruneTab(tabOf(content)).body.content).toStrictEqual(content);
    }
  });

  it("writes {} for a part that is only there", () => {
    let unread = { zzUnread: { deep: [1] }, content: [{ endIndex: 3, paragraph: {} }] };
    let tab = tabOf(
      [
        { endIndex: 1, sectionBreak: unread },
        { endIndex: 2, tableOfContents: unread },
        ...paragraphTab([
          { endIndex: 3, horizontalRule: { textStyle: { bold: true }, ...unread } },
          { endIndex: 4, equation: unread },
        ]).body.content,
      ],
      { namedRanges: MARKED },
    );
    expect(pruneTab(tab)).toStrictEqual(tabOf(
      [
        { endIndex: 1, sectionBreak: {} },
        { endIndex: 2, tableOfContents: {} },
        ...paragraphTab([{ endIndex: 3, horizontalRule: {} }, { endIndex: 4, equation: {} }])
          .body.content,
      ],
    ));
    // The named ranges are `{}` in the copy also where the tab came with none.
    expect(pruneTab(tabOf([], { namedRanges: undefined })).namedRanges).toStrictEqual({});
  });
});

// The whitelist and `DOC_COPY_FORMAT_VERSION` move together: a stored copy whose revision Google
// confirms is not fetched again.
it("keeps which style changes a row's and a cell's suggestions make, by ID alone", () => {
  let tab = buildTab([{ table: [["a\n", "b\n"]] }]);
  let table = tab.body.content.find(element => element.table)!.table!;
  let row = table.tableRows![0];
  row.suggestedTableRowStyleChanges = { "suggest.r": { tableRowStyle: { minRowHeight: {} } } };
  row.tableCells![1].suggestedTableCellStyleChanges = { "suggest.c": { tableCellStyle: {} } };
  let pruned = pruneTab(tab).body.content.find(element => element.table)!.table!.tableRows![0];
  expect(pruned.suggestedTableRowStyleChanges).toEqual({ "suggest.r": {} });
  expect(pruned.tableCells![1].suggestedTableCellStyleChanges).toEqual({ "suggest.c": {} });
  // Where Google sends none, the copy holds none.
  expect(pruned.tableCells![0]).not.toHaveProperty("suggestedTableCellStyleChanges");
});

it("keeps exactly these fields under this format version", () => {
  let tabs = [RICHEST, ...RECORDED.map(({ tab }) => tab)].map(tab => pruneTab(dressed(tab)));
  expect({ version: DOC_COPY_FORMAT_VERSION, fields: keptFields(tabs) }).toStrictEqual({
    version: 12,
    fields: {
      autoText: "textStyle type",
      backgroundColor: "color",
      body: "content",
      bookmark: "id tabId",
      borderBottom: "color dashStyle width",
      borderLeft: "color dashStyle width",
      borderRight: "color dashStyle width",
      borderTop: "color dashStyle width",
      bullet: "listId nestingLevel",
      color: "color rgbColor",
      columnBreak: "textStyle",
      content: "endIndex paragraph sectionBreak startIndex table tableOfContents",
      dateElement: "dateElementProperties textStyle",
      dateElementProperties: "displayText",
      dropdown: "dropdownId dropdownProperties textStyle",
      dropdownProperties: "displayValue dropdownDefinitionId selectedOptionId",
      elements: "autoText columnBreak dateElement dropdown endIndex equation footnoteReference " +
        "horizontalRule inlineObjectElement pageBreak person richLink startIndex textRun",
      equation: "",
      fontSize: "magnitude unit",
      footnoteReference: "footnoteId footnoteNumber textStyle",
      foregroundColor: "color",
      heading: "id tabId",
      horizontalRule: "",
      indentFirstLine: "magnitude unit",
      indentStart: "magnitude unit",
      inlineObjectElement: "inlineObjectId suggestedDeletionIds suggestedInsertionIds textStyle",
      link: "bookmark bookmarkId heading headingId tabId url",
      listProperties: "nestingLevels",
      // The keys of `lists` are the lists' ids, which no version names.
      lists: "",
      "lists.*": "listProperties",
      minRowHeight: "magnitude unit",
      namedRanges: "",
      namedStyles: "styles",
      nestingLevels: "glyphSymbol glyphType startNumber",
      paddingBottom: "magnitude unit",
      paddingLeft: "magnitude unit",
      paddingRight: "magnitude unit",
      paddingTop: "magnitude unit",
      pageBreak: "textStyle",
      paragraph: "bullet elements paragraphStyle positionedObjectIds suggestedBulletChanges " +
        "suggestedParagraphStyleChanges",
      paragraphStyle: "alignment headingId indentFirstLine indentStart namedStyleType",
      person: "personProperties textStyle",
      personProperties: "email name",
      rgbColor: "blue green red",
      richLink: "richLinkProperties textStyle",
      richLinkProperties: "title uri",
      sectionBreak: "",
      styles: "namedStyleType textStyle",
      // The keys of suggested changes are their ids, and the copy keeps nothing of a change.
      suggestedBulletChanges: "",
      "suggestedBulletChanges.*": "",
      suggestedParagraphStyleChanges: "",
      "suggestedParagraphStyleChanges.*": "",
      suggestedTextStyleChanges: "",
      "suggestedTextStyleChanges.*": "",
      tab: "body index lists namedRanges namedStyles nestingLevel parentTabId tabId title",
      table: "suggestedDeletionIds suggestedInsertionIds tableRows tableStyle",
      tableCellStyle: "backgroundColor borderBottom borderLeft borderRight borderTop columnSpan " +
        "contentAlignment paddingBottom paddingLeft paddingRight paddingTop rowSpan",
      tableCells: "content endIndex startIndex suggestedDeletionIds suggestedInsertionIds " +
        "tableCellStyle",
      tableColumnProperties: "width widthType",
      tableOfContents: "",
      tableRowStyle: "minRowHeight tableHeader",
      tableRows: "endIndex startIndex suggestedDeletionIds suggestedInsertionIds tableCells " +
        "tableRowStyle",
      tableStyle: "tableColumnProperties",
      textRun: "content suggestedDeletionIds suggestedInsertionIds suggestedTextStyleChanges " +
        "textStyle",
      textStyle: "bold fontSize foregroundColor italic link strikethrough underline",
      width: "magnitude unit",
    },
  });
});

// --- The copy

describe("the copy of a document", () => {
  let recorded = FIXTURES[0].before;
  // A tab as Google sends one, with no start index on the opening section break; a tab read back
  // from the store holds none either, unless the model made it.
  let sent = (tab: GoogleDocsTab): GoogleDocsTab => {
    let [{ startIndex: _, ...opening }, ...rest] = tab.body.content;
    return { ...tab, body: { content: [opening as GoogleDocsTab["body"]["content"][number], ...rest] } };
  };
  let marked: GoogleDocsTab = { ...sent(RICHEST), tabId: "t.marked", namedRanges: MARKED };
  let plain: GoogleDocsTab = { ...recorded, tabId: "t.plain", title: "Café ✓ 🙂" };
  let emptyRun: GoogleDocsTab = {
    ...sent(buildTab([{ runs: ["a", "", "b\n"] }])), tabId: "t.empty-run",
  };
  let child: GoogleDocsTab = { ...plain, tabId: "t.child", parentTabId: "t.plain", nestingLevel: 1 };
  /** The identity the outline holds of `tab`: its place and name, and no key for a parent it lacks. */
  let identityOf = ({ tabId, title, parentTabId, index, nestingLevel }: GoogleDocsTab) =>
    ({ tabId, title, ...(parentTabId === undefined ? {} : { parentTabId }), index, nestingLevel });

  it("reads back from the store what it kept", () => {
    let store = fakeDocStore();
    let tabs = [dressed(marked), plain, child, emptyRun];
    // The store empties the document it is handed, and two fixtures share a body: each is copied.
    let head = store.keep(
      "doc", store.fetched(documentOf(tabs.map(tab => structuredClone(tab))), 0),
      { edits: [], roots: [] });
    let read = storedDocCopy(store, "doc", head);
    // The write markers each tab held, in the order Google listed them.
    let markers = [
      [
        { writeId: "first", id: "range.1" },
        { writeId: "first", id: "range.2" },
        { writeId: "second", id: "range.4" },
      ],
      [], [], [],
    ];

    expect(read.outline).toStrictEqual([marked, plain, child, emptyRun].map(identityOf));
    expect(read.outline[1].title).toBe("Café ✓ 🙂");
    for (let [at, tab] of [marked, plain, child, emptyRun].entries()) {
      let version = read.tab(tab.tabId)!;
      expect(store.tab(version)).toEqual(pruneTab(tab));
      expect(version.writeMarkers).toStrictEqual(markers[at]);
      expect(version).toMatchObject(identityOf(tab));
    }
    // Whether the model indexes a tab is asked of the store, which worked it out at the keep.
    expect(store.unindexed(read.tab("t.plain")!)).toBe(false);
    expect(store.unindexed(read.tab("t.empty-run")!)).toBe(true);
    expect(read.tab("t.other")).toBeUndefined();
  });

  it("tells a copy that could not be read back from any other failure", () => {
    expect(isDocCopyUnreadable(new Error(DOC_COPY_UNREADABLE))).toBe(true);
    expect(isDocCopyUnreadable(new Error("storage refused the write"))).toBe(false);
    expect(isDocCopyUnreadable(DOC_COPY_UNREADABLE)).toBe(false);
  });
});

describe("the named styles of a new document", () => {
  it("are those every recording began with", () => {
    for (let fixture of FIXTURES) {
      expect(fixture.before.namedStyles, fixture.name).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
    }
  });

  it("hold nothing pruning drops", () => {
    let tab = { ...buildTab([{ runs: ["\n"] }]), namedStyles: NEW_DOCUMENT_NAMED_STYLES };
    expect(pruneTab(tab).namedStyles).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
  });

  it("a document not created yet has the named styles of a new one", async () => {
    let { tabs: [tab] } = await new BlankGoogleDoc("Notes").getDocument("");
    expect(tab.namedStyles).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
    // Its own copy of them: a tab is never changed, and neither is the constant.
    expect(tab.namedStyles).not.toBe(NEW_DOCUMENT_NAMED_STYLES);
    expect(hasModelIndexes(tab)).toBe(true);
    expect(pruneTab(tab)).toStrictEqual(tab);
  });
});

// --- The fields asked of Google

/**
 * `tabs` as `getDocument` returns them from a fake Google holding `answer(rawDocsDocument(…))`,
 * answered under the read's mask (`masked`) or whole, in one request.
 */
async function fetched(
  tabs: GoogleDocsTab[],
  options: { masked: boolean; answer?: (whole: unknown) => unknown },
): Promise<GoogleDocsDocument> {
  let whole = rawDocsDocument(documentOf(tabs));
  let held = options.answer ? options.answer(whole) : whole;
  let requests = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    requests++;
    return docsGetResponse(
      new URL(input), options.masked ? new Headers(init?.headers) : new Headers(), held);
  });
  let document = await new GoogleDocsApi(async () => "token").getDocument("doc-1");
  expect(requests).toBe(1);
  return document;
}

/**
 * What is kept of `document`: each tab's id with the JSON of the tab pruned, and the id of the
 * copy a read holds of it, which names every tab's runs, lists, place and write markers.
 * `document` is left as it is: the walk of a fetched document reads a copy.
 */
function storedCopy(document: GoogleDocsDocument): { tabs: [string, string][]; id: string } {
  return {
    tabs: document.tabs.map(tab => [tab.tabId, JSON.stringify(pruneTab(tab))]),
    id: heldDoc("doc", fetchedDoc(structuredClone(document), 0)).id,
  };
}

/** What names and places `tab`. */
function placed({ tabId, title, parentTabId, index, nestingLevel }: GoogleDocsTab) {
  return { tabId, title, parentTabId, index, nestingLevel };
}

/** What `run` returns, or the message of what it throws. */
function outcome<T>(run: () => T): T | string {
  try {
    return run();
  } catch (error) {
    return (error as Error).message;
  }
}

/** Every object that sits under the key `key` anywhere in `value`, those in a list included. */
function heldUnder(value: unknown, key: string): Record<string, unknown>[] {
  let found: Record<string, unknown>[] = [];
  let visit = (inner: unknown, under: string): void => {
    if (Array.isArray(inner)) {
      for (let item of inner) visit(item, under);
    } else if (inner && typeof inner === "object") {
      if (under === key) found.push(inner as Record<string, unknown>);
      for (let [name, deeper] of Object.entries(inner)) visit(deeper, name);
    }
  };
  visit(value, "");
  return found;
}

/** How many times `text` holds `piece`. */
function occurrences(text: string, piece: string): number {
  return text.split(piece).length - 1;
}

/** The trimmed content of the first text run of `tab` that has any: a quote a comment could name. */
function firstQuote(tab: GoogleDocsTab): string | undefined {
  for (let paragraph of paragraphsOf(tab.body.content)) {
    for (let element of paragraph.elements) {
      let text = element.textRun?.content?.trim();
      if (text) return text;
    }
  }
  return undefined;
}

describe("the fields asked of documents.get", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The text Google was asked with and took. A change to it is a change to what every read asks
  // of Google, to be checked against Google before it ships (`check:docs-fields-mask`).
  it("is this text", () => {
    let fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/docs-fields-mask.txt");
    expect(DOCUMENT_FIELDS).toBe(readFileSync(fixture, "utf8").trim());
  });

  it("fits where a mask has been seen to fit", () => {
    // The longest mask Google has been seen to take in a URL.
    expect(DOCUMENT_FIELDS.length).toBeLessThanOrEqual(10_964);
    // Letters, commas and parentheses need no encoding in a header or in a query.
    expect(DOCUMENT_FIELDS).toMatch(/^[A-Za-z(),]+$/);
  });

  it("names only fields the Docs API has", () => {
    let names = new Set(DOCUMENT_FIELDS.match(/[A-Za-z]+/g));
    expect(names).toContain("documentTab");
    expect([...names].filter(name => !DOCS_API_FIELD_NAMES.has(name))).toStrictEqual([]);
    // No wildcard, and the two maps keyed by id whole.
    expect(() => parseFieldMask(DOCUMENT_FIELDS)).not.toThrow();
  });

  it("asks for the lists and the named ranges whole, for child tabs and nested tables whole " +
      "below the depth it names, and for a part kept as {} whole", () => {
    expect(DOC_TAB_FIELDS).toContain(",lists,namedRanges,");
    expect(DOCUMENT_FIELDS.endsWith("),childTabs)))")).toBe(true);
    expect(occurrences(DOCUMENT_FIELDS, "childTabs(")).toBe(2);
    expect(occurrences(DOCUMENT_FIELDS, `documentTab(${DOC_TAB_FIELDS})`)).toBe(3);
    // A cell's content field by field in a table of the body, and whole in a table of a cell.
    expect(occurrences(DOC_TAB_FIELDS, "tableCells(startIndex,endIndex,content(")).toBe(1);
    expect(occurrences(DOC_TAB_FIELDS, "tableCells(startIndex,endIndex,content,tableCellStyle"))
      .toBe(1);
    expect(occurrences(DOCUMENT_FIELDS, "tableCells(startIndex,endIndex,content(")).toBe(3);
    expect(occurrences(DOCUMENT_FIELDS, "tableCells(startIndex,endIndex,content,tableCellStyle"))
      .toBe(3);
    for (let part of ["sectionBreak", "tableOfContents", "horizontalRule", "equation"]) {
      // By its name alone wherever the mask spells a body out, never by a field: that the part is
      // there must not rest on what Google answers for a part none of whose fields were asked.
      expect(occurrences(DOCUMENT_FIELDS, part), part).toBe(6);
      expect(occurrences(DOCUMENT_FIELDS, `${part}(`), part).toBe(0);
    }
  });

  it("gives the copy the whole answer gives", async () => {
    for (let { name, tab } of CORPUS) {
      let sent = dressed(tab);
      for (let [kind, asSent] of Object.entries({
        plain: tab, dressed: sent, marked: { ...sent, namedRanges: structuredClone(MARKED) },
      })) {
        let masked = await fetched([asSent], { masked: true });
        let whole = await fetched([asSent], { masked: false });
        let { tabs: _, ...document } = masked;
        expect(document, `${name}, ${kind}`).toStrictEqual(
          { documentId: "doc-1", title: "A document", revisionId: "revision-1" });
        expect(masked.tabs.map(placed), `${name}, ${kind}`).toStrictEqual(whole.tabs.map(placed));
        expect(storedCopy(masked), `${name}, ${kind}`).toStrictEqual(storedCopy(whole));
        expect(masked.tabs.map(googleDocNamedRanges), `${name}, ${kind}`)
          .toStrictEqual(whole.tabs.map(googleDocNamedRanges));
      }
    }
    // A worn tab is pruned and not copied: the copy asks whether the model can index it, which
    // refuses a text run without its content.
    for (let [name, tab] of Object.entries({ RICHEST, EVERY_FIELD })) {
      for (let [at, worn] of wornCopies(dressed(tab), SEED, 100).entries()) {
        let { tabs: [masked] } = await fetched([worn], { masked: true });
        let { tabs: [whole] } = await fetched([worn], { masked: false });
        expect(
          firstDifference(JSON.stringify(pruneTab(masked)), JSON.stringify(pruneTab(whole))),
          `${name}, worn copy ${at}`,
        ).toBeUndefined();
      }
    }
  });

  it("reads a masked answer's tabs as it reads a whole one's", async () => {
    // Tabs four deep, one more than the mask names, and a table in a cell of a table in a cell
    // of a table, one more than it names: what lies deeper is asked for whole.
    let tables = buildTab([
      { table: [[cellOf({ table: [[cellOf({ table: [["deepest\n"]] })]] })]] },
      { runs: ["After the tables\n"] },
    ]);
    /** The styles of the paragraphs of the body of `tab`, those of its tables' cells left out. */
    let bodyStyles = (tab: GoogleDocsTab) =>
      tab.body.content.flatMap(({ paragraph }) => paragraph ? [paragraph.paragraphStyle] : []);
    let under = (tab: GoogleDocsTab, tabId: string, parentTabId: string): GoogleDocsTab =>
      ({ ...dressed(tab), tabId, parentTabId, index: 0, nestingLevel: Number(tabId.slice(2)) });
    let { parentTabId: _, ...top } = dressed(RICHEST);
    let tabs = [
      { ...top, tabId: "t.0", index: 0, nestingLevel: 0 },
      under(tables, "t.1", "t.0"),
      under(EVERY_FIELD, "t.2", "t.1"),
      under(tables, "t.3", "t.2"),
      { ...dressed(FIXTURES[0].before), tabId: "t.4", index: 1, nestingLevel: 0 },
    ];
    let masked = await fetched(tabs, { masked: true });
    let whole = await fetched(tabs, { masked: false });
    expect(masked.tabs.map(placed)).toStrictEqual(tabs.map(placed));
    expect(whole.tabs.map(placed)).toStrictEqual(tabs.map(placed));
    expect(storedCopy(masked)).toStrictEqual(storedCopy(whole));

    // The tab at the fourth level arrives with what the gatekeeper does not read, and those
    // above it without.
    expect(masked.tabs[3]).toStrictEqual(whole.tabs[3]);
    expect(bodyStyles(masked.tabs[3])).toStrictEqual(bodyStyles(tabs[3]));
    expect(bodyStyles(masked.tabs[3])[0]).toHaveProperty("zzUnread");
    for (let tab of masked.tabs.slice(0, 3)) {
      expect(bodyStyles(tab).length, tab.tabId).toBeGreaterThan(0);
      for (let style of bodyStyles(tab)) expect(style, tab.tabId).not.toHaveProperty("zzUnread");
    }
    // So do the cells of the table at the third level, and those of the two above it without.
    let [outer, inner, deepest] = heldUnder(masked.tabs[1], "table");
    expect([outer, inner, deepest].map(table => "rows" in table)).toStrictEqual([false, false, true]);
    expect([outer, inner, deepest].map(table => "zzUnread" in heldUnder(table, "tableCells")[0]))
      .toStrictEqual([false, false, true]);
    expect(deepest).toStrictEqual(heldUnder(whole.tabs[1], "table")[2]);
  });

  it("gives a part the copy keeps as {} with what it holds, which the copy leaves out", async () => {
    let entry = (startIndex: number) => ({
      startIndex,
      endIndex: startIndex + 2,
      paragraph: {
        elements: [{ startIndex, endIndex: startIndex + 2, textRun: { content: "x\n", textStyle: {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      },
    });
    let tab = tabOf([
      { endIndex: 1, sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } },
      { startIndex: 1, endIndex: 6, tableOfContents: { content: [entry(2), entry(4)] } },
      {
        startIndex: 6,
        endIndex: 9,
        paragraph: {
          elements: [
            { startIndex: 6, endIndex: 7, horizontalRule: { textStyle: { bold: true } } },
            {
              startIndex: 7,
              endIndex: 8,
              equation: {
                suggestedInsertionIds: ["suggest.in"], suggestedDeletionIds: ["suggest.out"],
              },
            },
            { startIndex: 8, endIndex: 9, textRun: { content: "\n", textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      },
    ]);
    let { tabs: [masked] } = await fetched([tab], { masked: true });
    let { tabs: [whole] } = await fetched([tab], { masked: false });
    expect(whole).toStrictEqual(tab);
    // Each is asked for by its name alone, so it comes as it is.
    let [sectionBreak, tableOfContents, paragraph] = masked.body.content;
    expect(sectionBreak).toStrictEqual(tab.body.content[0]);
    expect(tableOfContents).toStrictEqual(tab.body.content[1]);
    expect(paragraph.paragraph?.elements.slice(0, 2))
      .toStrictEqual(tab.body.content[2].paragraph?.elements.slice(0, 2));
    let copy = pruneTab(masked);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(pruneTab(whole)));
    expect(copy.body.content[0]).toStrictEqual({ endIndex: 1, sectionBreak: {} });
    expect(copy.body.content[1]).toStrictEqual({ startIndex: 1, endIndex: 6, tableOfContents: {} });
    // An element keeps the suggestions it is part of, and nothing else of what it holds.
    expect(copy.body.content[2].paragraph?.elements.slice(0, 2)).toStrictEqual([
      { startIndex: 6, endIndex: 7, horizontalRule: {} },
      {
        startIndex: 7, endIndex: 8,
        equation: { suggestedInsertionIds: ["suggest.in"], suggestedDeletionIds: ["suggest.out"] },
      },
    ]);
  });

  // The approval that cannot build from the copy builds from a tab as fetched.
  it("renders a tab as fetched under the mask as it renders the pruned tab", async () => {
    for (let { name, tab } of CORPUS) {
      let { tabs: [sent] } = await fetched([dressed(tab)], { masked: true });
      expect(renderingOf(sent), name).toStrictEqual(docTabToMarkdown(pruneTab(sent)));
      // A tab that holds only what the copy keeps needs no help: under the mask a text style
      // comes with the fields the copy keeps of it.
      let { tabs: [plain] } = await fetched([tab], { masked: true });
      expect(docTabToMarkdown(plain), name).toStrictEqual(docTabToMarkdown(pruneTab(plain)));
    }
  });

  // Both sides start from the tab as fetched: `getDocument` places a tab by where it sits in
  // the answer, which is not where the recording's tab says it is.
  it("takes a batch in the model on a tab as fetched under the mask as on the pruned tab", async () => {
    for (let fixture of FIXTURES) {
      let before = fixture.before;
      for (let step of fixture.steps) {
        let { tabs: [sent] } = await fetched([dressed(before)], { masked: true });
        for (let options of MODELS) {
          expect(
            pruneTab(applyDocsRequests(sent, step.requests, options)),
            `${fixture.name}, ${step.name} ${JSON.stringify(options)}`,
          ).toStrictEqual(applyDocsRequests(pruneTab(sent), step.requests, options));
        }
        before = step.after;
      }
    }
  });

  // Every field outside the mask holds a value of the wrong kind and the fake answers whole: what
  // the readers give does not depend on those fields. A write's bytes are not compared: a builder
  // forwards a fetched run's text style whole, so they follow the answer.
  it("reads nothing the mask does not ask for", async () => {
    let poison = (whole: unknown) => poisonOutsideMask(whole, DOCUMENT_FIELDS);
    for (let { name, tab } of CORPUS) {
      let sent = { ...dressed(tab), namedRanges: structuredClone(MARKED) };
      let clean = await fetched([sent], { masked: false });
      let poisoned = await fetched([sent], { masked: false, answer: poison });
      let { tabs: [cleanTab], ...document } = clean;
      let { tabs: [poisonedTab], ...poisonedDocument } = poisoned;
      expect(poisonedDocument, name).toStrictEqual(document);
      expect(placed(poisonedTab), name).toStrictEqual(placed(cleanTab));
      expect(storedCopy(poisoned), name).toStrictEqual(storedCopy(clean));
      expect(googleDocNamedRanges(poisonedTab), name).toStrictEqual(googleDocNamedRanges(cleanTab));
      expect(googleDocNamedRangeIds(poisonedTab, "gadgets-write-first"), name)
        .toStrictEqual(["range.1", "range.2"]);
      expect(renderingOf(poisonedTab), name).toStrictEqual(renderingOf(cleanTab));
      let quote = firstQuote(cleanTab);
      if (quote !== undefined) {
        expect(outcome(() => locateQuote(poisonedTab, quote)), name)
          .toStrictEqual(outcome(() => locateQuote(cleanTab, quote)));
      }
    }
    for (let fixture of FIXTURES) {
      let before = fixture.before;
      for (let step of fixture.steps) {
        let { tabs: [cleanTab] } = await fetched([dressed(before)], { masked: false });
        let { tabs: [poisonedTab] } =
          await fetched([dressed(before)], { masked: false, answer: poison });
        for (let options of MODELS) {
          expect(
            pruneTab(applyDocsRequests(poisonedTab, step.requests, options)),
            `${fixture.name}, ${step.name} ${JSON.stringify(options)}`,
          ).toStrictEqual(pruneTab(applyDocsRequests(cleanTab, step.requests, options)));
        }
        before = step.after;
      }
    }
  });

  it("is held to tabs that hold fields outside the mask at every depth", async () => {
    let held: unknown;
    let whole: unknown;
    await fetched([dressed(EVERY_FIELD)], {
      masked: false,
      answer: answer => {
        whole = answer;
        return held = poisonOutsideMask(answer, DOCUMENT_FIELDS);
      },
    });
    expect(heldUnder(held, "documentTab")[0].documentStyle).toBe("unasked");
    expect(heldUnder(held, "paragraphStyle").map(style => style.direction))
      .toContainEqual({ unasked: true });
    expect(heldUnder(held, "textRun").map(run => (run.textStyle as TextStyle & {
      weightedFontFamily: unknown;
    }).weightedFontFamily)).toContain("unasked");
    expect(heldUnder(held, "table").map(table => table.rows)).toContainEqual({ unasked: true });
    let selection = parseFieldMask(DOCUMENT_FIELDS);
    expect(selectFields(held, selection)).toStrictEqual(selectFields(whole, selection));
    // A quote is looked up in most tabs, so that comparison is one of ranges and not of refusals.
    let quoted = CORPUS.filter(({ tab }) => {
      let quote = firstQuote(tab);
      return quote !== undefined && typeof outcome(() => locateQuote(tab, quote)) !== "string";
    });
    expect(quoted.length).toBeGreaterThan(CORPUS.length / 2);
  });
});
