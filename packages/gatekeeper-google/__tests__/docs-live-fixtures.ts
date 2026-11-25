/// <reference types="node" />

// The recordings of Google Docs' own answers to the batches the gatekeeper's builders send,
// as they are committed under `fixtures/docs-live/`, and what reading, pruning and comparing
// them takes.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Dimension, DocList, GoogleDocsRequest, GoogleDocsTab, Paragraph, ParagraphElement,
  StructuralElement, TableCellBorder, TableCellStyle, TextRun,
} from "../src/docs-api";
import type { ModelParagraphStyle } from "../src/docs-model";
import { pruneTab } from "../src/docs-replica";

/**
 * One recorded scenario: a new document's tab as Google returned it, then each batch the
 * gatekeeper's builders sent to it and the tab as Google returned it next.
 */
export type DocsLiveFixture = {
  /** The scenario's name, which is also the file's name. */
  name: string;
  before: GoogleDocsTab;
  steps: {
    name: string;
    /** The batch as it was sent. */
    requests: GoogleDocsRequest[];
    after: GoogleDocsTab;
  }[];
};

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** The stand-ins for the people and the links a tab names, numbered as they first appear. */
type StandIns = { people: Map<string, number>; links: Map<string, number> };

/** The number of `value` among those `seen`, counting from 1 in order of first appearance. */
function numbered(seen: Map<string, number>, value: string): number {
  let number = seen.get(value) ?? seen.size + 1;
  seen.set(value, number);
  return number;
}

/**
 * Replace the person chips' names and addresses and the rich links' titles and addresses of
 * `content` by their stand-ins, in place, in body order, the tables' cells included.
 */
function standIn(content: readonly StructuralElement[], names: StandIns): void {
  for (let { paragraph, table } of content) {
    for (let { person, richLink } of paragraph?.elements ?? []) {
      let properties = person?.personProperties;
      if (properties) {
        let number = numbered(names.people, JSON.stringify([properties.name, properties.email]));
        if (properties.name !== undefined) properties.name = `Person ${number}`;
        if (properties.email !== undefined) properties.email = `person${number}@example.com`;
      }
      let link = richLink?.richLinkProperties;
      if (link) {
        let number = numbered(names.links, JSON.stringify([link.title, link.uri]));
        if (link.title !== undefined) link.title = `Link ${number}`;
        if (link.uri !== undefined) link.uri = `https://example.com/${number}`;
      }
    }
    for (let row of table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) standIn(cell.content ?? [], names);
    }
  }
}

/**
 * `tab` as a recording holds it: pruned by `pruneTab`, the whitelist the gatekeeper's stored
 * copy of a document is pruned with, to only what the Markdown rendering and the model read,
 * in Google's own shape; and then with nothing that names a document or a person: the tab's
 * title is empty, and a person chip's name and address and a rich link's title and address
 * are stand-ins.
 */
export function prunedTab(tab: GoogleDocsTab): GoogleDocsTab {
  // The pruned tab shares nothing with `tab`, so it is this function's to change.
  let pruned = pruneTab(tab);
  pruned.title = "";
  standIn(pruned.body.content, { people: new Map(), links: new Map() });
  return pruned;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/**
 * The rows whose least height a batch leaves to Google, by their table's start index: those a
 * `mergeTableCells` of the batch covers and no later `updateTableRowStyle` of it names.
 */
export function rowsGoogleSizes(
  requests: readonly GoogleDocsRequest[],
): Map<number, Set<number>> {
  let sized = new Map<number, Set<number>>();
  for (let request of requests) {
    if ("mergeTableCells" in request) {
      let { tableCellLocation, rowSpan } = request.mergeTableCells.tableRange;
      let table = tableCellLocation.tableStartLocation.index;
      let rows = sized.get(table) ?? new Set<number>();
      for (let row = 0; row < rowSpan; row++) rows.add(tableCellLocation.rowIndex + row);
      sized.set(table, rows);
    }
    if ("updateTableRowStyle" in request) {
      let { tableStartLocation, rowIndices } = request.updateTableRowStyle;
      let rows = sized.get(tableStartLocation.index);
      for (let row of rowIndices) rows?.delete(row);
      if (rows?.size === 0) sized.delete(tableStartLocation.index);
    }
  }
  return sized;
}

/** `value` as JSON with every object's keys in order, so that two equal values read the same. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : held);
}

/** Give every colour component under `value` the 32-bit float Google stores, in place. */
function roundColors(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (let [key, held] of Object.entries(value)) {
    if (key === "rgbColor" && held && typeof held === "object") {
      let components: Record<string, number> = held;
      for (let name of Object.keys(components)) components[name] = Math.fround(components[name]);
    } else {
      roundColors(held);
    }
  }
}

function isUnset(dimension: Dimension | undefined): boolean {
  return !dimension?.magnitude;
}

/** Whether a border is the one a cell has when nothing sets it: 1pt, solid and black. */
function isDefaultBorder(border: TableCellBorder): boolean {
  let rgb = border.color?.color?.rgbColor ?? {};
  return border.width?.magnitude === 1 && border.width.unit === "PT" &&
    border.dashStyle === "SOLID" && !rgb.red && !rgb.green && !rgb.blue;
}

/** Take the values a cell has when nothing sets them off its style, in place. */
function dropCellDefaults(style: TableCellStyle): void {
  for (let side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
    if (style[side]?.magnitude === 5 && style[side].unit === "PT") delete style[side];
  }
  if (style.contentAlignment === "TOP") delete style.contentAlignment;
  if (style.backgroundColor && !style.backgroundColor.color) delete style.backgroundColor;
  for (let side of ["borderTop", "borderRight", "borderBottom", "borderLeft"] as const) {
    let border = style[side];
    if (border && isDefaultBorder(border)) delete style[side];
  }
}

/** What tells two adjacent text runs apart: their style and the suggestions they carry. */
function runLook({ content: _content, ...look }: TextRun): Omit<TextRun, "content"> {
  return look;
}

/** Join the adjacent text runs of one style into one run, in place. */
function joinRuns(paragraph: Paragraph): void {
  let joined: ParagraphElement[] = [];
  for (let element of paragraph.elements) {
    let last = joined.at(-1);
    if (last?.textRun && element.textRun &&
        canonicalJson(runLook(last.textRun)) === canonicalJson(runLook(element.textRun))) {
      last.textRun.content += element.textRun.content;
      last.endIndex = element.endIndex;
    } else {
      joined.push(element);
    }
  }
  paragraph.elements = joined;
}

/** Give a part whose start index Google left out the 0 it stands for, in place. */
function start(part: { startIndex?: number }): void {
  part.startIndex ??= 0;
}

/** A renaming of one kind of id: each id gets `<prefix>.<n>` in order of first appearance. */
function renaming(prefix: string): (id: string) => string {
  let names = new Map<string, string>();
  return id => {
    let name = names.get(id) ?? `${prefix}.${names.size + 1}`;
    names.set(id, name);
    return name;
  };
}

/**
 * `tab` as two documents are compared. What Google decides alone is replaced by a stand-in:
 * every list id is renamed (a list a paragraph uses in order of first use, `list.1` on; then
 * the lists no paragraph uses, `unused.1` on, in the order of their definitions as JSON, so
 * that their number and each definition are still compared); the ids of positioned objects,
 * of inline objects and of suggestions (the keys of a text's or a paragraph's suggested
 * changes included) are renamed in order of first appearance, each kind on its own
 * (`positioned.1`, `inline.1`, `suggestion.1` on), so that which paragraph, element or cell
 * holds one, and how many, are still compared; heading ids are left out, and so is the least
 * height of the rows `sized` names. Every other id (a footnote's, a dropdown's and its
 * definition's) is compared as sent. What is one document written two ways is written one
 * way: a start index Google leaves out is 0; adjacent text runs of one style and the same
 * suggestions are one run; an explicit default is no value (an indent of no or zero
 * magnitude, alignment `START`, and in a cell padding of 5pt, alignment `TOP`, an empty
 * background and a 1pt solid black border); and a colour component is the 32-bit float
 * Google stores. No other field is left out or changed.
 */
export function comparable(
  tab: GoogleDocsTab, sized?: ReadonlyMap<number, ReadonlySet<number>>,
): GoogleDocsTab {
  let copy = structuredClone(tab);
  roundColors(copy);
  let listName = renaming("list");
  let positionedName = renaming("positioned");
  let inlineName = renaming("inline");
  let suggestionName = renaming("suggestion");
  let usedLists = new Map<string, string>();

  let renamedKeys = (changes: Record<string, object>) => Object.fromEntries(
    Object.entries(changes).map(([id, change]) => [suggestionName(id), change]));
  let suggestions = (part: {
    suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[];
    suggestedTextStyleChanges?: Record<string, object>;
  }) => {
    if (part.suggestedInsertionIds) {
      part.suggestedInsertionIds = part.suggestedInsertionIds.map(suggestionName);
    }
    if (part.suggestedDeletionIds) {
      part.suggestedDeletionIds = part.suggestedDeletionIds.map(suggestionName);
    }
    if (part.suggestedTextStyleChanges) {
      part.suggestedTextStyleChanges = renamedKeys(part.suggestedTextStyleChanges);
    }
  };
  let paragraph = (held: Paragraph) => {
    let style: ModelParagraphStyle = held.paragraphStyle;
    delete style.headingId;
    if (isUnset(style.indentStart)) delete style.indentStart;
    if (isUnset(style.indentFirstLine)) delete style.indentFirstLine;
    if (style.alignment === "START") delete style.alignment;
    if (held.bullet) {
      let name = listName(held.bullet.listId);
      usedLists.set(held.bullet.listId, name);
      held.bullet.listId = name;
    }
    if (held.positionedObjectIds) {
      held.positionedObjectIds = held.positionedObjectIds.map(positionedName);
    }
    if (held.suggestedParagraphStyleChanges) {
      held.suggestedParagraphStyleChanges = renamedKeys(held.suggestedParagraphStyleChanges);
    }
    if (held.suggestedBulletChanges) {
      held.suggestedBulletChanges = renamedKeys(held.suggestedBulletChanges);
    }
    for (let element of held.elements) {
      start(element);
      if (element.textRun) suggestions(element.textRun);
      let inline = element.inlineObjectElement;
      if (inline?.inlineObjectId !== undefined) {
        inline.inlineObjectId = inlineName(inline.inlineObjectId);
      }
    }
    joinRuns(held);
  };
  let content = (elements: StructuralElement[]) => {
    for (let element of elements) {
      start(element);
      if (element.paragraph) paragraph(element.paragraph);
      if (!element.table) continue;
      suggestions(element.table);
      let rows = sized?.get(element.startIndex);
      for (let [index, row] of (element.table.tableRows ?? []).entries()) {
        start(row);
        suggestions(row);
        if (rows?.has(index)) delete row.tableRowStyle?.minRowHeight;
        for (let cell of row.tableCells ?? []) {
          start(cell);
          suggestions(cell);
          if (cell.tableCellStyle) dropCellDefaults(cell.tableCellStyle);
          content(cell.content ?? []);
        }
      }
    }
  };
  content(copy.body.content);

  let lists: GoogleDocsTab["lists"] = {};
  let unused: DocList[] = [];
  for (let [id, list] of Object.entries(copy.lists)) {
    let name = usedLists.get(id);
    if (name === undefined) unused.push(list);
    else lists[name] = list;
  }
  let definitions = unused.map(list => canonicalJson(list)).toSorted();
  for (let [index, definition] of definitions.entries()) {
    lists[`unused.${index + 1}`] = JSON.parse(definition) as DocList;
  }
  copy.lists = lists;
  return copy;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The directory the recordings are committed in. */
export const FIXTURE_DIRECTORY: string =
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/docs-live");

/** Every committed recording, in the order of their file names. */
export function readFixtures(directory: string = FIXTURE_DIRECTORY): DocsLiveFixture[] {
  return readdirSync(directory).filter(file => file.endsWith(".json")).toSorted().map(file => {
    let fixture = JSON.parse(readFileSync(join(directory, file), "utf8")) as DocsLiveFixture;
    if (`${fixture.name}.json` !== file) {
      throw new Error(`${file} holds a recording named ${JSON.stringify(fixture.name)}`);
    }
    return fixture;
  });
}
