/// <reference types="node" />

// Records what Google Docs does with the batches the gatekeeper's builders send: each scenario
// makes a document, sends its edits one batch at a time, each built by the production builders
// as approval builds it, and reads the document after each. `scripts/record-docs-fixtures.ts`
// runs it against Google; the tests run it against the model.
//
// The scenarios that start from the template copy a document made by hand, which holds what
// no request makes. After the empty paragraph Google Docs keeps at its start it holds, in this
// order and with these exact texts:
//   1. a table of two rows and four columns: `Person`, `Date`, `Dropdown` and `Placeholder`
//      in the first row and, alone in the cells of the second, a person chip, a date chip, a
//      dropdown chip and a placeholder chip;
//   2. three paragraphs in a row, `Before the image`, `Anchor of the image` and
//      `After the image`, the middle one anchoring a positioned image (one that text wraps
//      around, not one in line), which is the only positioned image of the tab;
//   3. a paragraph `Inline image` that ends in an image placed in line;
//   4. a paragraph `Suggested` with a word typed after it in suggesting mode;
//   5. last in the tab, a bulleted list of the two items `First item` and `Second item`,
//      made with the editor's toolbar.
// A list item written in a table cell is not a scenario: the cell path refuses to make one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleDocsApi } from "../src/docs-api";
import type {
  DocsLocation, DocsRange, GoogleDocsRequest, GoogleDocsTab, StructuralElement,
} from "../src/docs-api";
import { docEditRequests, findUniqueMarkdown } from "../src/docs-replay";
import type { DocEdit } from "../src/docs-replay";
import { replacementPath, tableIdentity } from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import { docTabToMarkdown, POSITIONED_ITEM_BEFORE } from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";
import {
  comparable, FIXTURE_DIRECTORY, prunedTab, rowsGoogleSizes,
} from "./docs-live-fixtures";
import { isBearerToken } from "./docs-fields-check";
import type { DocsLiveFixture } from "./docs-live-fixtures";

/** The calls a recording makes, so that a test can stand the model in for Google. */
export type DocsTransport = {
  /** Create an empty document and give its id. */
  create(title: string): Promise<string>;
  /** Copy the template document and give the copy's id. */
  copy(templateId: string, title: string): Promise<string>;
  /** The document's first tab, as `GoogleDocsApi.getDocument` gives it. */
  read(documentId: string): Promise<GoogleDocsTab>;
  /** Send one batch. */
  send(documentId: string, requests: GoogleDocsRequest[]): Promise<void>;
  /** Send one batch as one suggestion, as an editor suggesting would make it. */
  suggest(documentId: string, requests: GoogleDocsRequest[]): Promise<void>;
  /** Move the document to the trash. */
  discard(documentId: string): Promise<void>;
};

/** One edit of a scenario, as an agent asks for it. */
export type ScenarioStep = {
  name: string;
  /**
   * `"recorded"` for a step that sends the batch its committed recording holds, not the one
   * the builders build, which differs: the recording shows what Google does with requests the
   * builders do not send, such as a range bulleted without a paragraph that sets its levels,
   * or a list item's marker written as text.
   *
   * `"unguarded"` for a step the builders refuse with `POSITIONED_ITEM_BEFORE`: it sends the
   * batch they build when no block of the tab is marked as anchoring a positioned object,
   * which is the batch they would send without that refusal. Google's answer to it is the
   * record the refusal waits for.
   */
  batch?: "recorded" | "unguarded";
} & (
  /** Markdown appended to the tab. */
  | { append: string }
  /** `oldMarkdown`, found once in the tab as it reads, replaced by `newMarkdown`. */
  | { replace: readonly [oldMarkdown: string, newMarkdown: string] }
  /** A table change; `expected(n)` is the identity of the tab's table `n` as it reads. */
  | { table: (tab: DocTabSnapshot, expected: (table: number) => string) => TableChange }
);

/** A scenario: a new document, or a copy of the template, and the edits made to it in order. */
export type Scenario = {
  name: string;
  /** Set when it starts from a copy of the hand-made template, which holds what no request makes. */
  template?: true;
  /**
   * Requests written out by hand, for the tab as the document was created or copied, that
   * give it what a request can make and no builder does (a pinned header row; a list around
   * a paragraph the builders may not edit). They are sent as one batch
   * before `before` is read and are no step of the recording, whose steps hold only batches
   * the builders built.
   */
  setup?: (tab: GoogleDocsTab) => GoogleDocsRequest[];
  /**
   * Suggestions made after the setup and before `before` is read, in order: each a batch
   * written by hand for the tab as just read, sent as one suggestion (`writeMode: SUGGEST`).
   * Like the setup, they are no step of the recording.
   */
  suggest?: readonly ((tab: GoogleDocsTab) => GoogleDocsRequest[])[];
  steps: readonly ScenarioStep[];
};

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

const TABLE_2X2 = [["alpha", "beta"], ["gamma", "delta"]];
const BOLD = { bold: true };
const LINK = "[link](https://example.com/)";
const FORMATTED_ITEM = `    1. **bold** and ${LINK} and *italic*`;

/** The scenarios with a committed recording, under the names of their files. */
const RECORDED_SCENARIOS: readonly Scenario[] = [
  // A list item appended or written directly after a list of the same preset.
  {
    name: "bullets-join-same-preset",
    steps: [
      { name: "intro", append: "Intro paragraph" },
      { name: "a bulleted list", append: "- one\n- two" },
      { name: "one more item appended", append: "- three" },
      { name: "an item written after the second", replace: ["- two", "- two\n- two and a half"] },
      { name: "a paragraph after the list becomes its item", append: "Tail" },
      { name: "tail to item", replace: ["Tail", "- Tail"] },
    ],
  },
  // A list of the other preset directly after a list.
  {
    name: "bullets-other-preset",
    steps: [
      { name: "a bulleted list", append: "- one\n- two" },
      { name: "a numbered list after it", append: "1. first\n2. second" },
      { name: "a bulleted item after the numbered list", append: "- again" },
      { name: "a numbered item between", replace: ["- two", "- two\n\n1. between"] },
    ],
  },
  // A paragraph directly before a list becomes an item: it never joins the list after it.
  {
    name: "bullets-never-following",
    steps: [
      { name: "a paragraph and a list", append: "Lead\n\n- one\n- two" },
      { name: "the paragraph becomes an item", replace: ["Lead", "- Lead"] },
      { name: "a numbered lead", append: "Second lead\n\n1. n1\n2. n2" },
      { name: "the second paragraph becomes a numbered item", replace: ["Second lead", "1. Second lead"] },
    ],
  },
  // Nesting levels written as leading tabs.
  {
    name: "bullets-nesting",
    steps: [
      { name: "a nested list", append: "- a\n  - b\n    - c\n  - d\n- e" },
      { name: "an item nested deeper", replace: ["  - d", "    - d"] },
      {
        name: "an item nested under the last", replace: ["- e", "- e\n  - f\n    - g"],
        // Bulleted with no paragraph that sets its levels: the builders send an empty one first.
        batch: "recorded",
      },
      { name: "a nested numbered list", append: "1. x\n   1. y\n      1. z\n2. w" },
    ],
  },
  // How a numbered list goes on.
  {
    name: "bullets-numbering",
    steps: [
      { name: "a numbered list", append: "1. a\n2. b\n3. c" },
      { name: "a fourth item appended", append: "4. d" },
    ],
  },
  // A replacement across a list boundary.
  {
    name: "bullets-across-boundary",
    steps: [
      { name: "two lists around a paragraph", append: "- one\n- two\n\nMiddle para\n\n1. n1\n2. n2" },
      { name: "the paragraph joins the list before", replace: ["- two\n\nMiddle para", "- two\n- Middle para"] },
      { name: "the last item leaves the list", replace: ["- Middle para", "Middle para"] },
      {
        name: "item and paragraph rewritten together",
        replace: ["- two\n\nMiddle para\n\n1. n1", "- two changed\n\nMiddle changed\n\n1. n1 changed"],
      },
      { name: "the paragraph joins the list after", replace: ["Middle changed", "1. Middle changed"] },
    ],
  },
  // A table to write lists in. The cell path refuses to make a list item, so no step does.
  {
    name: "bullets-in-cell",
    steps: [
      { name: "a paragraph", append: "Before the table" },
      { name: "a table", table: () => ({ type: "insertTable", rows: 2, columns: 2, cells: TABLE_2X2 }) },
    ],
  },
  // Paragraph splits and joins, with headings.
  {
    name: "paragraph-splits",
    steps: [
      { name: "headings and body", append: "# Heading one\n\nBody text here.\n\n## Sub heading\n\nMore body." },
      { name: "a body paragraph split", replace: ["Body text here.", "Body text\n\nhere."] },
      { name: "a heading split", replace: ["# Heading one", "# Heading\n\none"] },
      { name: "two paragraphs joined", replace: ["Body text\n\nhere.", "Body text here."] },
      { name: "a heading becomes body", replace: ["## Sub heading", "Sub heading"] },
      { name: "body becomes a heading with bold", replace: ["More body.", "### More **body**."] },
    ],
  },
  // What a named style gives text, and links cleared, written and repointed.
  {
    name: "named-styles-and-links",
    steps: [
      {
        name: "styled text",
        append: `###### Six *word* here\n\nA ${LINK} word and **bold** text\n\nSubtitle-like line`,
      },
      { name: "the link cleared", replace: [LINK, "link"] },
      { name: "a link written", replace: ["**bold**", "[**bold**](https://example.org/)"] },
      { name: "the link repointed", replace: ["https://example.org/", "https://example.net/"] },
    ],
  },
  // A numbered list as a read shows one, "1." on every item.
  {
    name: "bullets-numbering-2",
    steps: [
      { name: "a numbered list", append: "1. a\n1. b\n1. c" },
      { name: "a fourth item appended", append: "1. d" },
      { name: "an item written in the middle", replace: ["1. b", "1. b\n1. b2"] },
      { name: "a paragraph splits the list", replace: ["1. b2", "Break"] },
      { name: "an item after the break", replace: ["Break", "Break\n\n1. restart"] },
      { name: "the break becomes an item again", replace: ["Break", "1. Break"] },
    ],
  },
  // Where a nested item written after an item lands.
  {
    name: "bullets-nesting-2",
    steps: [
      { name: "a flat list", append: "- a\n- b\n- c" },
      {
        name: "a child under the middle item", replace: ["- b", "- b\n  - b1"],
        // Bulleted with no paragraph that sets its level: the builders send an empty one first.
        batch: "recorded",
      },
      {
        name: "children appended after the list", append: "  - tail child\n    - tail grandchild",
        // Bulleted with no paragraph that sets its levels: the builders send an empty one first.
        batch: "recorded",
      },
      {
        name: "a top-level item nested", replace: ["- c", "  - c"],
        // Bulleted with no paragraph that sets its level: the builders send an empty one first.
        batch: "recorded",
      },
    ],
  },
  // Nesting in one write: a whole list with its children.
  {
    name: "bullets-nesting-3",
    steps: [
      { name: "a paragraph", append: "Intro" },
      {
        name: "the paragraph becomes a nested list",
        replace: ["Intro", "- top\n  - child\n    - grandchild\n- next"],
      },
      { name: "a numbered nested list appended", append: "1. n\n   1. n child\n1. m" },
      { name: "an item between with a child", replace: ["- next", "- next\n  - next child\n- last"] },
    ],
  },
  // Text in the cells of a table, and the rows and columns added beside styled text.
  {
    name: "bullets-in-cell-2",
    steps: [
      { name: "a paragraph", append: "Before the table" },
      { name: "a table", table: () => ({ type: "insertTable", rows: 2, columns: 2, cells: TABLE_2X2 }) },
      {
        name: "bold and a link in a cell",
        replace: [
          "<p>delta</p>", "<p><strong>delta</strong> and <a href=\"https://example.com/\">link</a></p>",
        ],
      },
      {
        name: "the link cleared in the cell",
        replace: ["<a href=\"https://example.com/\">link</a>", "link"],
      },
      {
        name: "a row inserted below the styled row",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 2, cells: [["new one", "new two"]], expected: expected(0),
        }),
      },
      {
        name: "a column inserted right of the styled column",
        table: (_tab, expected) => ({
          type: "insertTableColumns", at: 2, cells: [["x1"], ["x2"], ["x3"]], expected: expected(0),
        }),
      },
    ],
  },
  // What a heading's own style drops, and what a change of named style resets.
  {
    name: "named-styles-2",
    steps: [
      {
        name: "styled text",
        append: "###### Six *word* here\n\n### Three **bold** and *italic* and ~~struck~~\n\n" +
          "Body with **bold** word",
      },
      { name: "heading 6 renamed to heading 2", replace: ["###### Six word here", "## Six word here"] },
      {
        name: "heading 3 renamed to heading 1",
        replace: [
          "### Three **bold** and *italic* and ~~struck~~",
          "# Three **bold** and *italic* and ~~struck~~",
        ],
      },
      {
        name: "heading 1 to body",
        replace: [
          "# Three **bold** and *italic* and ~~struck~~",
          "Three **bold** and *italic* and ~~struck~~",
        ],
      },
      {
        name: "body to heading 6 with italic written",
        replace: ["Body with **bold** word", "###### Body with **bold** *word*"],
      },
      { name: "text written beside styled text", replace: ["Six word", "Six more word"] },
    ],
  },
  // Cell looks: partial borders, padding, alignment, widths set and unset, a merge and its undoing.
  {
    name: "table-looks",
    steps: [
      { name: "a paragraph", append: "Above" },
      {
        name: "a table",
        table: () => ({
          type: "insertTable", rows: 3, columns: 3,
          cells: [["a1", "a2", "a3"], ["b1", "b2", "b3"], ["c1", "c2", "c3"]],
        }),
      },
      {
        name: "partial borders",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 0, column: 0, rows: 2, columns: 2,
          style: { borders: { top: "3pt dashed #ff0000", bottom: "1pt solid #0000ff" } },
          expected: expected(0),
        }),
      },
      {
        name: "padding and alignment",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 1, column: 1, rows: 2, columns: 2,
          style: { verticalAlign: "middle", padding: { left: "12pt", top: "8pt" } },
          expected: expected(0),
        }),
      },
      {
        name: "widths set",
        table: (_tab, expected) => ({
          type: "setTableColumnWidths", at: 0, count: 3, width: 120, expected: expected(0),
        }),
      },
      {
        name: "one width unset",
        table: (_tab, expected) => ({
          type: "setTableColumnWidths", at: 1, count: 1, width: null, expected: expected(0),
        }),
      },
      {
        name: "a block merged",
        table: (_tab, expected) => ({
          type: "mergeTableCells", row: 0, column: 1, rows: 2, columns: 2, expected: expected(0),
        }),
      },
      {
        name: "the merge undone",
        table: (_tab, expected) => ({
          type: "unmergeTableCells", row: 0, column: 1, expected: expected(0),
        }),
      },
      {
        name: "cell text restyled",
        replace: ["<p>c1</p>", "<p><strong>c1</strong> and <em>more</em></p>"],
      },
      {
        name: "a second table after text",
        table: () => ({ type: "insertTable", rows: 1, columns: 2, cells: [["s1", "s2"]] }),
      },
    ],
  },
  // Items leaving a list, and a list changing its kind.
  {
    name: "lists-to-paragraphs",
    steps: [
      { name: "a list", append: "- one\n- two\n- three\n- four" },
      { name: "a middle item leaves the list", replace: ["- two", "two"] },
      { name: "the last item leaves the list", replace: ["- four", "four"] },
      { name: "the first item becomes numbered", replace: ["- one", "1. one"] },
      { name: "the paragraph returns as an item", replace: ["two", "- two"] },
      { name: "a bulleted item becomes numbered", replace: ["- three", "1. three"] },
    ],
  },
  // Text edits inside list items, and siblings and children written in the middle.
  {
    name: "list-text-edits",
    steps: [
      {
        name: "nested lists",
        append: "- alpha item\n  - beta item\n    - gamma item\n- omega item\n\n" +
          "1. first\n  1. inner\n1. second",
      },
      { name: "bold inside a nested item", replace: ["beta item", "beta **bold** item"] },
      { name: "a sibling after the first item", replace: ["- alpha item", "- alpha item\n- inserted sibling"] },
      {
        name: "a nested item split in two", replace: ["    - gamma item", "    - gamma\n    - item"],
        // The second item's marker written as text: the builders write the item as an item.
        batch: "recorded",
      },
      {
        name: "a child and then a top-level item",
        replace: ["- omega item", "- omega item\n  - omega child\n- after omega"],
      },
      {
        name: "a child at the end of the list", replace: ["- after omega", "- after omega\n  - last child"],
        // Bulleted with no paragraph that sets its level: the builders send an empty one first.
        batch: "recorded",
      },
      {
        name: "a numbered child in the middle", replace: ["1. first", "1. first\n  1. first child"],
        // Bulleted with no paragraph that sets its level: the builders send an empty one first.
        batch: "recorded",
      },
      { name: "a nested item removed", replace: ["  - beta **bold** item\n", ""] },
    ],
  },
  // Paragraphs and list items directly above and below a table.
  {
    name: "around-tables",
    steps: [
      { name: "a paragraph", append: "Top" },
      {
        name: "a table",
        table: () => ({ type: "insertTable", rows: 2, columns: 2, cells: [["a", "b"], ["c", "d"]] }),
      },
      { name: "a paragraph below", append: "Bottom" },
      { name: "a paragraph written under the top one", replace: ["Top", "Top\n\nSecond top"] },
      { name: "the paragraph above the table becomes an item", replace: ["Second top", "- Second top"] },
      {
        name: "the paragraph below the table becomes an item",
        replace: ["Bottom", "- Bottom\n- Bottom two"],
      },
      { name: "a heading above the table", replace: ["- Second top", "## Second top"] },
      {
        name: "a table after the first paragraph",
        table: () => ({ type: "insertTable", rows: 1, columns: 1, cells: [["solo"]], after: "Top" }),
      },
      { name: "text appended", append: `The end, with **bold** and a ${LINK}.` },
    ],
  },
  // Inline formatting and the other kinds of block the converter writes.
  {
    name: "markdown-features",
    steps: [
      {
        name: "mixed formatting",
        append: "Para with `code` and **bold *nested italic*** and ~~strike~~ and " +
          "[a link](https://example.com/).\n\nLine one\nLine two\n\n#### Heading four\n\n" +
          "Trailing paragraph",
      },
      { name: "formatting removed", replace: ["**bold *nested italic***", "bold nested italic"] },
      { name: "strike to bold", replace: ["~~strike~~", "**strike**"] },
      { name: "a link around formatted text", replace: ["**strike**", "[**strike**](https://example.org/)"] },
      {
        name: "a paragraph inserted between",
        replace: ["#### Heading four", "Inserted *paragraph*\n\n#### Heading four"],
      },
      {
        name: "two paragraphs replaced by a list",
        replace: ["Inserted *paragraph*\n\n#### Heading four", "- item *one*\n- item two"],
      },
      {
        name: "everything after the first paragraph replaced",
        replace: ["- item *one*\n- item two", "Final"],
      },
    ],
  },
  // An item shallower than the one before it, bulleted on its own.
  {
    name: "outdent-after-nested",
    steps: [
      { name: "a nested list", append: "- a\n  - b\n    - c" },
      {
        name: "a top-level item appended after the nested one", append: "- d",
        // Bulleted without the items before it, which the builders take in to set its level.
        batch: "recorded",
      },
      { name: "a paragraph", append: "Para" },
      { name: "a numbered nested list", append: "1. n\n  1. n child" },
      {
        name: "a top-level item written after the nested one",
        replace: ["  1. n child", "  1. n child\n1. m"],
        // Bulleted without the items before it, which the builders take in to set its level.
        batch: "recorded",
      },
      {
        name: "a level-one item written after a level-two one", replace: ["    - c", "    - c\n  - b2"],
        // Bulleted without the items before it, which the builders take in to set its level.
        batch: "recorded",
      },
    ],
  },
  // Items written deeper than the item before them.
  {
    name: "nesting-deeper",
    steps: [
      { name: "a flat list", append: "- a\n- b\n- c" },
      { name: "a child under the middle item", replace: ["- b", "- b\n  - b1"] },
      { name: "a grandchild", replace: ["  - b1", "  - b1\n    - b2"] },
      { name: "children at the end of the list", replace: ["- c", "- c\n  - c1\n    - c2"] },
      { name: "a paragraph", append: "Para" },
      { name: "a list that starts nested", append: "  - x\n    - y" },
      { name: "a top-level item nested", replace: ["- a", "- a\n- a2"] },
      { name: "the new item nested", replace: ["- a2", "  - a2"] },
    ],
  },
  // Items written shallower than the item before them.
  {
    name: "nesting-outdent",
    steps: [
      { name: "a nested list", append: "- a\n  - b\n    - c" },
      { name: "a top-level item appended after the nested one", append: "- d" },
      { name: "a paragraph", append: "Para" },
      { name: "a numbered nested list", append: "1. n\n  1. n child" },
      {
        name: "a top-level item written after the nested one",
        replace: ["  1. n child", "  1. n child\n1. m"],
      },
      { name: "a level-one item written after a level-two one", replace: ["    - c", "    - c\n  - b2"] },
      { name: "a deep child then a top-level item, appended", append: "    1. deep\n1. top" },
    ],
  },
  // Nesting in a numbered list.
  {
    name: "nesting-numbered",
    steps: [
      { name: "a numbered list", append: "1. a\n1. b\n1. c" },
      { name: "a child in the middle", replace: ["1. b", "1. b\n  1. b1"] },
      { name: "a grandchild", replace: ["  1. b1", "  1. b1\n    1. b2"] },
      { name: "a top-level item after the grandchild", replace: ["    1. b2", "    1. b2\n1. b3"] },
      { name: "a nested item appended", append: "  1. tail" },
      { name: "a top-level item appended", append: "1. end" },
    ],
  },
  // Children and top-level items written into nested lists of both kinds.
  {
    name: "nested-list-edits",
    steps: [
      {
        name: "nested lists",
        append: "- alpha item\n  - beta item\n- omega item\n\n1. first\n  1. inner\n1. second",
      },
      { name: "a child at the end of the list", replace: ["- omega item", "- omega item\n  - last child"] },
      { name: "a numbered child in the middle", replace: ["1. first", "1. first\n  1. first child"] },
      { name: "a top-level item after the last child", replace: ["  - last child", "  - last child\n- final"] },
      { name: "a top-level numbered item nested", replace: ["1. second", "  1. second"] },
      { name: "bullets appended after the numbered list", append: "  - other kind\n- and top" },
    ],
  },
  // Deep lists, lists that start nested, and items on both sides of the ones a write keeps.
  {
    name: "nesting-stress",
    steps: [
      { name: "a deep list", append: "- a\n  - b\n    - c\n    - d\n  - e" },
      { name: "a top-level item appended behind four nested ones", append: "- f" },
      { name: "a top-level item in the middle", replace: ["    - d", "    - d\n- mid"] },
      {
        name: "new items on both sides of kept ones",
        replace: ["  - b\n    - c", "    - new deep\n  - b\n    - c\n- new top"],
      },
      { name: "a paragraph", append: "Para" },
      { name: "a list that starts nested", append: "  - x\n    - y" },
      { name: "a top-level item after a list that starts nested", replace: ["    - y", "    - y\n- z"] },
      { name: "a paragraph again", append: "Para two" },
      {
        name: "a list with a heading and formatting",
        append: `1. one\n  1. ## Heading item\n${FORMATTED_ITEM}`,
      },
      { name: "a top-level numbered item behind them", append: "1. two" },
      {
        name: "a second-level item behind a third-level one",
        replace: [FORMATTED_ITEM, `${FORMATTED_ITEM}\n  1. sibling`],
      },
      { name: "a paragraph once more", append: "Para three" },
      {
        name: "two lists of different kinds, both nested first",
        append: "  - bullet child\n\n  1. numbered child\n1. numbered top",
      },
    ],
  },
  // Table structure: rows, columns, merge and unmerge, widths, heights, a look, deletions.
  {
    name: "table-structure",
    steps: [
      { name: "a paragraph", append: "Above" },
      {
        name: "a table",
        table: () => ({
          type: "insertTable", rows: 2, columns: 3, cells: [["h1", "h2", "h3"], ["c1", "c2", "c3"]],
        }),
      },
      {
        name: "a row inserted",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 1, cells: [["n1", "n2", "n3"]], expected: expected(0),
        }),
      },
      {
        name: "a column inserted",
        table: (_tab, expected) => ({
          type: "insertTableColumns", at: 3, cells: [["h4"], ["n4"], ["c4"]], expected: expected(0),
        }),
      },
      {
        name: "cells merged",
        table: (_tab, expected) => ({
          type: "mergeTableCells", row: 0, column: 0, rows: 1, columns: 2, expected: expected(0),
        }),
      },
      {
        name: "cells unmerged",
        table: (_tab, expected) => ({
          type: "unmergeTableCells", row: 0, column: 0, expected: expected(0),
        }),
      },
      {
        name: "column widths",
        table: (_tab, expected) => ({
          type: "setTableColumnWidths", at: 0, count: 2, width: 90, expected: expected(0),
        }),
      },
      {
        name: "row heights",
        table: (_tab, expected) => ({
          type: "setTableRowHeights", at: 1, count: 1, height: 40, expected: expected(0),
        }),
      },
      {
        name: "a cell look",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 4,
          style: { background: "#ffe599", border: "2pt solid #000000" }, expected: expected(0),
        }),
      },
      {
        name: "a row deleted",
        table: (_tab, expected) => ({
          type: "deleteTableRows", at: 1, count: 1, expected: expected(0),
        }),
      },
      {
        name: "a column deleted",
        table: (_tab, expected) => ({
          type: "deleteTableColumns", at: 1, count: 1, expected: expected(0),
        }),
      },
      { name: "a paragraph after the table", append: "Below" },
      { name: "the table deleted", table: (_tab, expected) => ({ type: "deleteTable", expected: expected(0) }) },
    ],
  },
  // Text a suggestion inserts, deletes or makes bold, in a paragraph and in a cell, with edits
  // beside it that keep it: the copy holds every suggestion where Google holds it.
  {
    name: "suggestions-beside-edits",
    setup: suggestedTextSetup,
    suggest: [
      tab => [{ insertText: { location: textAt(tab, "beta"), text: "NEW " } }],
      tab => [{ deleteContentRange: { range: textRange(tab, "gamma ") } }],
      tab => [{ updateTextStyle: { range: textRange(tab, "delta"), textStyle: BOLD, fields: "bold" } }],
      tab => [{ insertText: { location: textAt(tab, "two"), text: "fresh " } }],
      tab => [{ deleteContentRange: { range: textRange(tab, "three ") } }],
      tab => [{ updateTextStyle: { range: textRange(tab, "four"), textStyle: BOLD, fields: "bold" } }],
    ],
    steps: [
      {
        name: "a table inserted before the suggestions",
        table: () =>
          ({ type: "insertTable", rows: 1, columns: 2, cells: [["x", "y"]], after: "Intro" }),
      },
      {
        name: "a row inserted in that table",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 1, cells: [["z", "w"]], expected: expected(0),
        }),
      },
      { name: "a word replaced before the suggested insertion", replace: ["Alpha", "Omega"] },
      { name: "a word replaced right after the suggested insertion", replace: ["beta", "BETA"] },
      {
        name: "a word replaced in the cell before its suggested insertion", replace: ["one", "ONE"],
      },
      {
        name: "a word replaced in the cell right after its suggested insertion",
        replace: ["two", "TWO"],
      },
      { name: "a paragraph appended", append: "Tail" },
    ],
  },
  // A paragraph whose alignment a suggestion changes and one a suggestion makes a list item,
  // with their text and the paragraphs around them edited.
  {
    name: "suggested-paragraph-changes",
    setup: tab => [{
      insertText: { location: { index: 1, tabId: tab.tabId }, text: "First\nSecond\nThird" },
    }],
    suggest: [
      tab => [{
        updateParagraphStyle: {
          range: textRange(tab, "Second"), paragraphStyle: { alignment: "CENTER" },
          fields: "alignment",
        },
      }],
      tab => [{
        createParagraphBullets: {
          range: textRange(tab, "Third"), bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      }],
    ],
    steps: [
      { name: "the paragraph before them edited", replace: ["First", "Prime"] },
      { name: "a word added to the centred paragraph", replace: ["Second", "Second line"] },
      { name: "a word added to the bulleted paragraph", replace: ["Third", "Third line"] },
      // Not a step: a paragraph appended after the bulleted one, which the builders refuse.
      // Google gives the bulleted paragraph the bullet, and the new paragraph the suggestions.
    ],
  },
];

const TABLE_3X3 = [["a1", "a2", "a3"], ["b1", "b2", "b3"], ["c1", "c2", "c3"]];
const BEFORE_ANCHOR = "Before the image";
const AFTER_ANCHOR = "After the image";

/** Whether a body element is a paragraph of text alone that is no list item and anchors nothing. */
function isPlainText(element: StructuralElement | undefined): element is StructuralElement {
  let paragraph = element?.paragraph;
  return !!paragraph && !paragraph.bullet && !paragraph.positionedObjectIds?.length &&
    paragraph.elements.every(part => part.textRun) &&
    paragraph.elements.map(part => part.textRun?.content ?? "").join("").trim() !== "";
}

/**
 * The setup of `header-rows`: on a tab of one paragraph, a table of two rows and two columns
 * with a text in each cell, whose first row is pinned as a header row.
 */
function pinnedTable(tab: GoogleDocsTab): GoogleDocsRequest[] {
  let { tabId } = tab;
  let paragraphs = tab.body.content.filter(element => !element.sectionBreak);
  if (paragraphs.length !== 1 || !paragraphs[0].paragraph) {
    throw new Error("the document is not one paragraph, as a new document is");
  }
  // The table goes in front of the paragraph's line break, which leaves a paragraph before it.
  let tableStart = paragraphs[0].startIndex + 1;
  let requests: GoogleDocsRequest[] = [
    { insertTable: { rows: 2, columns: 2, location: { index: paragraphs[0].startIndex, tabId } } },
  ];
  let texts = [["h1", "h2"], ["c1", "c2"]];
  // Last cell first, so that no text moves a cell still to be written. A row of two empty
  // cells takes five indexes, and a cell's paragraph starts three after the table does.
  for (let row = 1; row >= 0; row--) {
    for (let column = 1; column >= 0; column--) {
      let index = tableStart + 3 + row * 5 + column * 2;
      requests.push({ insertText: { location: { index, tabId }, text: texts[row][column] } });
    }
  }
  requests.push({
    pinTableHeaderRows: { tableStartLocation: { index: tableStart, tabId }, pinnedHeaderRowsCount: 1 },
  });
  return requests;
}

/**
 * The setup of `suggestions-beside-edits`: on a tab of one paragraph, the paragraphs `Intro`
 * and `Alpha beta gamma delta`, then a table of two rows and two columns whose first cell holds
 * `one two three four`.
 */
function suggestedTextSetup(tab: GoogleDocsTab): GoogleDocsRequest[] {
  let { tabId } = tab;
  let paragraphs = tab.body.content.filter(element => !element.sectionBreak);
  if (paragraphs.length !== 1 || !paragraphs[0].paragraph) {
    throw new Error("the document is not one paragraph, as a new document is");
  }
  let at = paragraphs[0].startIndex;
  let tableStart = at + 1;
  let requests: GoogleDocsRequest[] = [
    { insertTable: { rows: 2, columns: 2, location: { index: at, tabId } } },
  ];
  // Last cell first, as `pinnedTable` writes them; then the paragraphs before the table.
  let texts = [["one two three four", "c2"], ["c3", "c4"]];
  for (let row = 1; row >= 0; row--) {
    for (let column = 1; column >= 0; column--) {
      let index = tableStart + 3 + row * 5 + column * 2;
      requests.push({ insertText: { location: { index, tabId }, text: texts[row][column] } });
    }
  }
  requests.push(
    { insertText: { location: { index: at, tabId }, text: "Intro\nAlpha beta gamma delta" } });
  return requests;
}

/** Every text run of `elements`, those in the cells of their tables included. */
function* textRuns(
  elements: readonly StructuralElement[],
): Generator<{ startIndex: number; content: string }> {
  for (let element of elements) {
    for (let part of element.paragraph?.elements ?? []) {
      if (part.textRun) yield { startIndex: part.startIndex, content: part.textRun.content };
    }
    for (let row of element.table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* textRuns(cell.content ?? []);
    }
  }
}

/** The range of `text`, which one text run of the tab holds once and no other run holds. */
function textRange(tab: GoogleDocsTab, text: string): DocsRange {
  let found: number[] = [];
  for (let run of textRuns(tab.body.content)) {
    let at = run.content.indexOf(text);
    if (at !== -1) found.push(run.startIndex + at);
    if (at !== -1 && run.content.indexOf(text, at + 1) !== -1) found.push(-1);
  }
  if (found.length !== 1) throw new Error(`the tab holds ${JSON.stringify(text)} other than once`);
  return { startIndex: found[0], endIndex: found[0] + text.length, tabId: tab.tabId };
}

/** Where `text` starts, as `textRange` finds it. */
function textAt(tab: GoogleDocsTab, text: string): DocsLocation {
  let { startIndex, tabId } = textRange(tab, text);
  return { index: startIndex, tabId };
}

/**
 * The setup of `positioned-list-item`: the paragraph that anchors the template's positioned
 * image and the paragraphs directly before and after it become one list, as the preset makes
 * one: the first at the top level, the anchored one and the third two levels in.
 */
function listAroundAnchor(tab: GoogleDocsTab): GoogleDocsRequest[] {
  let { tabId } = tab;
  let body = tab.body.content;
  let at = body.findIndex(element => element.paragraph?.positionedObjectIds?.length);
  if (at < 0) throw new Error("the template has no paragraph that anchors a positioned image");
  let [before, anchored, after] = [body[at - 1], body[at], body[at + 1]];
  if (!isPlainText(before) || !isPlainText(after)) {
    throw new Error(
      "the template has no paragraph of text, which is no list item, directly before and " +
      "directly after the paragraph that anchors its positioned image");
  }
  return [
    // The third paragraph first, so that its tabs do not move the second.
    { insertText: { location: { index: after.startIndex, tabId }, text: "\t\t" } },
    { insertText: { location: { index: anchored.startIndex, tabId }, text: "\t\t" } },
    {
      createParagraphBullets: {
        // Up to the third paragraph's line break, four tabs on.
        range: { startIndex: before.startIndex, endIndex: after.endIndex + 3, tabId },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    },
  ];
}

/** The scenarios that wait for a recording. */
const WAITING_SCENARIOS: readonly Scenario[] = [
  // A column added beside one that shares the page's width, in a table with a fixed column.
  {
    name: "column-width-narrowing",
    steps: [
      { name: "a paragraph", append: "Above" },
      {
        name: "a table",
        table: () => ({
          type: "insertTable", rows: 2, columns: 3, cells: [["a1", "a2", "a3"], ["b1", "b2", "b3"]],
        }),
      },
      {
        name: "one column fixed",
        table: (_tab, expected) => ({
          type: "setTableColumnWidths", at: 0, count: 1, width: 120, expected: expected(0),
        }),
      },
      {
        name: "a column inserted beside an even one",
        table: (_tab, expected) => ({
          type: "insertTableColumns", at: 3, cells: [["a4"], ["b4"]], expected: expected(0),
        }),
      },
    ],
  },
  // A border set on one cell, which the cell on its other side shows too.
  {
    name: "cell-border-mirroring",
    steps: [
      { name: "a paragraph", append: "Above" },
      { name: "a table", table: () => ({ type: "insertTable", rows: 3, columns: 3, cells: TABLE_3X3 }) },
      {
        name: "a border on the right of the middle cell",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 1, column: 1, rows: 1, columns: 1,
          style: { borders: { right: "3pt solid #ff0000" } }, expected: expected(0),
        }),
      },
      {
        name: "a border on its top",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 1, column: 1, rows: 1, columns: 1,
          style: { borders: { top: "2pt dashed #0000ff" } }, expected: expected(0),
        }),
      },
      {
        name: "both borders cleared",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 1, column: 1, rows: 1, columns: 1,
          style: { borders: { right: "none", top: "none" } }, expected: expected(0),
        }),
      },
      {
        name: "a border along the table's left edge",
        table: (_tab, expected) => ({
          type: "setTableCellStyle", row: 0, column: 0, rows: 3, columns: 1,
          style: { borders: { left: "2pt dotted #00ff00" } }, expected: expected(0),
        }),
      },
    ],
  },
  // A merged cell with rows and columns added and deleted where they do not cross it.
  {
    name: "merge-with-lines-around",
    steps: [
      { name: "a paragraph", append: "Above" },
      { name: "a table", table: () => ({ type: "insertTable", rows: 3, columns: 3, cells: TABLE_3X3 }) },
      {
        name: "a corner merged",
        table: (_tab, expected) => ({
          type: "mergeTableCells", row: 0, column: 0, rows: 2, columns: 2, expected: expected(0),
        }),
      },
      {
        name: "a row inserted below the merge",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 3, cells: [["d1", "d2", "d3"]], expected: expected(0),
        }),
      },
      {
        name: "a column inserted right of the merge",
        table: (_tab, expected) => ({
          type: "insertTableColumns", at: 3, cells: [["a4"], ["b4"], ["c4"], ["d4"]],
          expected: expected(0),
        }),
      },
      {
        name: "a row deleted below the merge",
        table: (_tab, expected) => ({
          type: "deleteTableRows", at: 2, count: 1, expected: expected(0),
        }),
      },
      {
        name: "the merge undone",
        table: (_tab, expected) => ({
          type: "unmergeTableCells", row: 0, column: 0, expected: expected(0),
        }),
      },
    ],
  },
  // A tab typed at the start of a list item's text: one insertText, no bullet request.
  {
    name: "tab-typed-into-list-item",
    steps: [
      { name: "a list of two levels", append: "- one\n  - two\n- three" },
      { name: "a tab typed at the start of a top-level item", replace: ["- one", "- \tone"] },
      { name: "a tab typed at the start of a nested item", replace: ["  - two", "  - \ttwo"] },
    ],
  },
  // New list items whose text starts with a tab: bulleted without it and given it afterwards
  // in the same batch, or written with it into a paragraph that inherits its bullet.
  {
    name: "tab-starts-new-list-item",
    steps: [
      { name: "a list of two levels", append: "- one\n  - two\n- three" },
      { name: "an item appended", append: "- \tfour" },
      { name: "a nested item appended", append: "  - \tfive" },
      {
        name: "an item written between two items",
        replace: ["- three\n- \tfour", "- three\n- \tbetween\n- \tfour"],
      },
      { name: "a deeper item written between two items", replace: ["- three", "- three\n  - \tdeep"] },
      { name: "an item split off the last item", replace: ["  - \tfive", "  - \tfive\n  - \tsplit"] },
      {
        name: "numbered items whose tabs are formatted",
        append: "Tail\n\n1. **\t**n1\n   1. \t**n2**",
      },
    ],
  },
  // List items whose text starts with a tab, bulleted again to place a shallower item behind
  // them: their tabs count toward their levels and are written back in the same batch.
  {
    name: "tab-item-bulleted-again",
    steps: [
      { name: "a list of two levels", append: "- one\n  - two\n  - three" },
      {
        name: "an item that starts with a tab split off a nested item, with a shallower item behind it",
        replace: ["  - three", "  - three\n  - \tfour\n- five"],
      },
      {
        name: "a tab typed into a nested item whose next item moves up a level",
        replace: ["  - two\n  - three", "  - \ttwo\n- three"],
      },
      {
        name: "an item given a second tab, with a shallower item behind it",
        replace: ["  - \tfour", "  - \t\tfour\n- mid"],
      },
      {
        name: "an unchanged item that starts with tabs between a changed item and a new, shallower one",
        replace: ["- three\n  - \t\tfour", "- third\n  - \t\tfour\n- new"],
      },
      {
        name: "an item whose tab is bold split off an item that starts with a tab, with a shallower item behind it",
        replace: ["  - \ttwo", "  - \ttwo\n  - **\t**bold\n- seven"],
      },
      { name: "items appended at two nested levels", append: "  - six\n    - deep" },
      // The item has fewer tabs of its own than its level, so a level tab is written in front
      // of its own bold tab for the bullet request to count with it.
      {
        name: "a bold tab typed into an item of the second nested level, with a shallower item behind it",
        replace: ["    - deep", "    - **\t**deep\n- last"],
      },
    ],
  },
  // A pinned header row, which no builder makes where there is none.
  {
    name: "header-rows",
    setup: pinnedTable,
    steps: [
      {
        name: "a row inserted above the header row",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 0, cells: [["n1", "n2"]], expected: expected(0),
        }),
      },
      {
        name: "the header row deleted",
        table: (_tab, expected) => ({
          type: "deleteTableRows", at: 0, count: 1, expected: expected(0),
        }),
      },
    ],
  },
  // The chips Google copies into a row added beside a row of chips.
  {
    name: "chip-row-copies",
    template: true,
    steps: [
      {
        name: "a row inserted below the row of chips",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 2, cells: [["", "", "", ""]], expected: expected(0),
        }),
      },
      {
        name: "a row inserted above the row of chips",
        table: (_tab, expected) => ({
          type: "insertTableRows", at: 1, cells: [["", "", "", ""]], expected: expected(0),
        }),
      },
    ],
  },
  // A whole paragraph deleted in front of the paragraph that anchors a positioned image.
  {
    name: "positioned-image",
    template: true,
    steps: [
      {
        name: "a paragraph written before the one in front of the anchor",
        replace: [BEFORE_ANCHOR, `Lead in\n\n${BEFORE_ANCHOR}`],
      },
      {
        name: "the paragraph in front of the anchor removed",
        replace: [`Lead in\n\n${BEFORE_ANCHOR}`, "Lead in"],
      },
    ],
  },
  // What Google does with the positioned image of a list item that the bullets of a write
  // take in, which the builders refuse to do and the model has no answer for. Its recording
  // is what would let that refusal be lifted. The list is made by a request and not in the
  // editor, so that the answer does not turn on whether an editor-made list is joined.
  {
    name: "positioned-list-item",
    template: true,
    setup: listAroundAnchor,
    steps: [
      // The builders' empty paragraph goes in directly behind the anchored item.
      {
        name: "a deeper item after the anchored one",
        replace: [`    - ${AFTER_ANCHOR}`, `      - ${AFTER_ANCHOR}`],
      },
      // The anchored item is taken in: its bullet removed, its level written in tabs, and
      // bulleted again with the new item.
      {
        name: "a top-level item after the anchored one",
        replace: [`      - ${AFTER_ANCHOR}`, `- ${AFTER_ANCHOR}`],
        batch: "unguarded",
      },
      // The anchored item is taken in again, and the empty paragraph is inserted at its
      // start and deleted after the bullets. The model refuses this batch, so the step is last.
      {
        name: "an item one level in, behind an empty paragraph",
        replace: [`- ${AFTER_ANCHOR}`, `  - ${AFTER_ANCHOR}`],
        batch: "unguarded",
      },
    ],
  },
  // Whether a list made in the Docs editor is joined as a list of the preset is.
  {
    name: "editor-made-list",
    template: true,
    steps: [
      { name: "an item appended after the list", append: "- Third item" },
      { name: "an item written after the first", replace: ["- First item", "- First item\n- Between"] },
    ],
  },
  // No edit: its recording is the template's tab, for the index guard on inline images,
  // dropdowns, chips, a positioned image and a suggestion.
  { name: "template-indexes", template: true, steps: [] },
];

/** Every scenario: those with a committed recording, and those that wait for one. */
export const SCENARIOS: readonly Scenario[] = [...RECORDED_SCENARIOS, ...WAITING_SCENARIOS];

// ---------------------------------------------------------------------------
// Building a step's batch
// ---------------------------------------------------------------------------

/** The edit one step makes in the tab `view` renders, as an action stores it. */
export function stepEdit(step: ScenarioStep, view: DocTabSnapshot): DocEdit {
  let { markdown, sourceMap } = view;
  if ("append" in step) return { type: "appendText", markdown: step.append };
  if ("replace" in step) {
    let [oldMarkdown, newMarkdown] = step.replace;
    // Queued as a change to the text of table cells when what it changes lies inside a table.
    let matchStart = findUniqueMarkdown(markdown, oldMarkdown, view.tabId);
    let path = replacementPath(view, { matchStart, oldMarkdown, newMarkdown });
    return {
      type: "replaceText", oldMarkdown, newMarkdown,
      ...(path.kind === "cells" ? { inTable: true as const } : {}),
    };
  }
  let expected = (index: number) => {
    let table = sourceMap.tables[index];
    if (!table) throw new Error(`the tab has no table ${index}`);
    return tableIdentity(markdown.slice(table.mdStart, table.mdEnd));
  };
  return step.table(view, expected);
}

/** The batch of one step on the tab `view` renders, as the builders build it. */
function builtRequests(step: ScenarioStep, view: DocTabSnapshot): GoogleDocsRequest[] {
  return docEditRequests(view, stepEdit(step, view));
}

/**
 * The batch of one step on `tab`, built as approval builds it with nothing else waiting
 * (`docEditRequests`). Throws what a builder throws, and when a replacement's text is not
 * in the tab exactly once. A step marked `batch: "unguarded"` must be refused with
 * `POSITIONED_ITEM_BEFORE` as the tab reads (it throws when the builders build it, so the
 * mark cannot outlive the refusal) and is then built with the `positioned` marks left off
 * the tab's blocks. The `"recorded"` mark changes nothing here: `recordScenario` reads it.
 */
export function stepRequests(step: ScenarioStep, tab: GoogleDocsTab): GoogleDocsRequest[] {
  let view = docTabToMarkdown(tab);
  if (step.batch !== "unguarded") return builtRequests(step, view);
  let refused = false;
  try {
    builtRequests(step, view);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== POSITIONED_ITEM_BEFORE) throw error;
    refused = true;
  }
  if (!refused) {
    throw new Error(`step ${JSON.stringify(step.name)} is marked unguarded, and the builders build it`);
  }
  // The refusal alone reads the mark, so this is the batch the builders send without it.
  return builtRequests(step, {
    ...view,
    sourceMap: {
      ...view.sourceMap,
      blocks: view.sourceMap.blocks.map(({ positioned: _anchors, ...block }) => block),
    },
  });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record one scenario through `transport`: create its document (or copy the template), send
 * the scenario's `setup` when it has one, read the document as `before`, and for each step
 * build the batch on the tab as just read, send it, and read again. `recorded` is the
 * scenario's committed recording, which a step marked `batch: "recorded"` takes its batch
 * from. The document goes to the trash whether or not the setup or a step fails.
 */
export async function recordScenario(
  scenario: Scenario, transport: DocsTransport,
  options: { templateId?: string; recorded?: DocsLiveFixture; pauseMs?: number } = {},
): Promise<DocsLiveFixture> {
  let { templateId, recorded, pauseMs = 1_200 } = options;
  let title = `Recording: ${scenario.name}`;
  if (scenario.template && templateId === undefined) {
    throw new Error(
      `${scenario.name} starts from a copy of the template document: give its id with --template`);
  }
  let documentId = scenario.template && templateId !== undefined
    ? await transport.copy(templateId, title)
    : await transport.create(title);
  try {
    if (scenario.setup) {
      await transport.send(documentId, scenario.setup(await transport.read(documentId)));
      await pause(pauseMs);
    }
    for (let suggestion of scenario.suggest ?? []) {
      await transport.suggest(documentId, suggestion(await transport.read(documentId)));
      await pause(pauseMs);
    }
    let tab = await transport.read(documentId);
    let fixture: DocsLiveFixture = { name: scenario.name, before: prunedTab(tab), steps: [] };
    for (let [index, step] of scenario.steps.entries()) {
      try {
        let requests: GoogleDocsRequest[];
        if (step.batch === "recorded") {
          let held = recorded?.steps[index];
          if (held?.name !== step.name) {
            throw new Error("the step sends the batch its committed recording holds, and there is none");
          }
          ({ requests } = held);
        } else {
          requests = stepRequests(step, tab);
        }
        if (requests.length === 0) throw new Error("the builders build no request");
        await transport.send(documentId, requests);
        await pause(pauseMs);
        tab = await transport.read(documentId);
        fixture.steps.push({ name: step.name, requests, after: prunedTab(tab) });
      } catch (error) {
        throw new Error(`${scenario.name} / ${step.name}: ${messageOf(error)}`, { cause: error });
      }
    }
    return fixture;
  } finally {
    await transport.discard(documentId);
  }
}

/** Where two values first differ, as a path from `path`; `undefined` when they are equal. */
function firstDifference(left: unknown, right: unknown, path: string): string | undefined {
  if (left === right) return undefined;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) {
    return path;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      let found = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  let leftFields: Record<string, unknown> = { ...left };
  let rightFields: Record<string, unknown> = { ...right };
  for (let key of new Set([...Object.keys(leftFields), ...Object.keys(rightFields)])) {
    let found = firstDifference(leftFields[key], rightFields[key], path ? `${path}.${key}` : key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Where a fresh recording of a scenario differs from the committed one: a line when the
 * documents they start from differ as `comparable` reads them (a new document, or what the
 * setup left, changed), and a line per step for a batch that is not the recorded one (the
 * builders changed) or an answer that is not the recorded one as `comparable` reads them
 * (Google changed). Empty when nothing drifted.
 */
export function drift(recorded: DocsLiveFixture, fresh: DocsLiveFixture): string[] {
  let lines: string[] = [];
  let start = firstDifference(comparable(recorded.before), comparable(fresh.before), "");
  if (start !== undefined) lines.push(`the document starts differently, at ${start}`);
  for (let index = 0; index < Math.max(recorded.steps.length, fresh.steps.length); index++) {
    let was = recorded.steps.at(index);
    let now = fresh.steps.at(index);
    if (!was || !now) {
      lines.push(was
        ? `${was.name}: the step is missing from the new recording`
        : `${now?.name}: the step is not in the committed recording`);
      continue;
    }
    if (was.name !== now.name) {
      lines.push(`${was.name}: the step is named ${JSON.stringify(now.name)} in the new recording`);
      continue;
    }
    if (firstDifference(was.requests, now.requests, "requests") !== undefined) {
      lines.push(`${was.name}: the builders send another batch`);
      continue;
    }
    let sized = rowsGoogleSizes(was.requests);
    let answer = firstDifference(comparable(was.after, sized), comparable(now.after, sized), "");
    if (answer !== undefined) lines.push(`${was.name}: Google answers differently, at ${answer}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";

/** The transport that calls Google with `token`. */
export function googleTransport(token: string): DocsTransport {
  let docs = new GoogleDocsApi(async () => token);
  // The token goes into this header and nowhere else, and a failure names the call and the
  // status, never what Google answered.
  let drive = async (call: string, path: string, method: string, body: unknown): Promise<unknown> => {
    let response = await fetch(`${DRIVE_FILES_API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${call} failed [http=${response.status}]`);
    // `response.json()` would quote the body in its error.
    let text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${call} answered something that is not JSON [http=${response.status}]`);
    }
  };
  return {
    create: title => docs.createDocument(title),
    async copy(templateId, title) {
      let copied = await drive("copying the template document",
        `${encodeURIComponent(templateId)}/copy?fields=id&supportsAllDrives=true`, "POST",
        { name: title });
      let id = copied && typeof copied === "object" && "id" in copied ? copied.id : undefined;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("copying the template document gave no document id");
      }
      return id;
    },
    read: async documentId => (await docs.getDocument(documentId)).tabs[0],
    async send(documentId, requests) {
      await docs.batchUpdate(documentId, requests);
    },
    async suggest(documentId, requests) {
      await docs.suggest(documentId, requests);
    },
    async discard(documentId) {
      await drive("moving the document to the trash",
        `${encodeURIComponent(documentId)}?fields=id&supportsAllDrives=true`, "PATCH",
        { trashed: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const USAGE = "usage: pnpm --filter @gadgets/google-gatekeeper record:docs-fixtures " +
  "<token-file> [--only name] [--check] [--template <docId>]";

type Arguments = { tokenFile: string; only?: string; check: boolean; templateId?: string };

/** The arguments of the command line, or `undefined` for ones it cannot read. */
function readArguments(argv: readonly string[]): Arguments | undefined {
  let [tokenFile, ...rest] = argv;
  if (tokenFile === undefined || tokenFile.startsWith("--")) return undefined;
  let read: Arguments = { tokenFile, check: false };
  for (let index = 0; index < rest.length; index++) {
    let flag = rest[index];
    if (flag === "--check") {
      read.check = true;
      continue;
    }
    let value = rest[++index];
    if (value === undefined || value.startsWith("--")) return undefined;
    if (flag === "--only") read.only = value;
    else if (flag === "--template") read.templateId = value;
    else return undefined;
  }
  return read;
}

/**
 * The command line: `<token-file> [--only name] [--check] [--template <docId>]`. Records
 * every scenario, or one, and writes each to its file; with `--check` writes nothing and
 * reports drift. Gives the exit code: 0, 1 for drift or a failed scenario, 2 for arguments it
 * cannot read, which a token that is not `isBearerToken` is: a header Node refuses would
 * print it in the error. `io` lets a test give the transport, the directory, the output and the wait
 * between a batch and the read after it.
 */
export async function main(
  argv: readonly string[],
  io: {
    transport?: (token: string) => DocsTransport;
    directory?: string;
    print?: (line: string) => void;
    pauseMs?: number;
  } = {},
): Promise<number> {
  let { directory = FIXTURE_DIRECTORY, print = line => console.log(line), pauseMs } = io;
  let read = readArguments(argv);
  let selected = read?.only === undefined
    ? SCENARIOS : SCENARIOS.filter(scenario => scenario.name === read.only);
  let token = read && existsSync(read.tokenFile)
    ? readFileSync(read.tokenFile, "utf8").trim() : undefined;
  if (!read || selected.length === 0 || !token || !isBearerToken(token)) {
    print(USAGE);
    print(`scenarios: ${SCENARIOS.map(scenario => scenario.name).join(", ")}`);
    return 2;
  }
  let transport = (io.transport ?? googleTransport)(token);
  let { check, templateId } = read;

  let failed = false;
  for (let scenario of selected) {
    let { name } = scenario;
    let file = join(directory, `${name}.json`);
    let recorded = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8")) as DocsLiveFixture : undefined;
    if (check && !recorded) continue;
    if (scenario.template && templateId === undefined) {
      print(`${name}: skipped, it starts from a copy of the template document (--template <docId>)`);
      continue;
    }
    let fresh: DocsLiveFixture;
    try {
      fresh = await recordScenario(scenario, transport, { templateId, recorded, pauseMs });
    } catch (error) {
      print(`${name}: failed: ${messageOf(error)}`);
      failed = true;
      continue;
    }
    let drifted = recorded ? drift(recorded, fresh) : [];
    for (let line of drifted) print(`${name}: ${line}`);
    if (check) {
      if (drifted.length > 0) failed = true;
      else print(`${name}: as recorded`);
      continue;
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify(fresh) + "\n");
    print(`${name}: recorded, ${fresh.steps.length} steps`);
  }
  return failed ? 1 : 0;
}
