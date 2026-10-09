/**
 * What an agent passes `updateSlides()`, checked before anything is read: the checks that need no
 * presentation, and the IDs minted for the elements it creates.
 */

import { isSlideColor } from "./slides-format";
import type { SlideBounds } from "./slides-read-types";
import type { DesignChange } from "./slides-design";
import { mintObjectId } from "./slides-simulation";
import { STRIPPED_CHARACTERS } from "./slides-text";
import type {
  ShapeOutline, SlideChange, SlideTextEdit, SlideTextTarget, TextFormatChange,
} from "./slides-types";

const MAX_CHANGES = 50;
const MAX_TABLE_SIZE = 20;
const MAX_LINES_INSERTED = 20;
// Google's limit for an image URL, and a generous one for a link.
const MAX_URL_LENGTH = 2 * 1024;
const MAX_REF_LENGTH = 64;
const MAX_FONT_SIZE = 400;

/** Every shape type Google Slides can create: its `Shape.Type` values but `CUSTOM`. */
const SHAPE_TYPES = new Set([
  "TEXT_BOX", "RECTANGLE", "ROUND_RECTANGLE", "ELLIPSE", "ARC", "BENT_ARROW", "BENT_UP_ARROW",
  "BEVEL", "BLOCK_ARC", "BRACE_PAIR", "BRACKET_PAIR", "CAN", "CHEVRON", "CHORD", "CLOUD",
  "CORNER", "CUBE", "CURVED_DOWN_ARROW", "CURVED_LEFT_ARROW", "CURVED_RIGHT_ARROW",
  "CURVED_UP_ARROW", "DECAGON", "DIAGONAL_STRIPE", "DIAMOND", "DODECAGON", "DONUT",
  "DOUBLE_WAVE", "DOWN_ARROW", "DOWN_ARROW_CALLOUT", "FOLDED_CORNER", "FRAME", "HALF_FRAME",
  "HEART", "HEPTAGON", "HEXAGON", "HOME_PLATE", "HORIZONTAL_SCROLL", "IRREGULAR_SEAL_1",
  "IRREGULAR_SEAL_2", "LEFT_ARROW", "LEFT_ARROW_CALLOUT", "LEFT_BRACE", "LEFT_BRACKET",
  "LEFT_RIGHT_ARROW", "LEFT_RIGHT_ARROW_CALLOUT", "LEFT_RIGHT_UP_ARROW", "LEFT_UP_ARROW",
  "LIGHTNING_BOLT", "MATH_DIVIDE", "MATH_EQUAL", "MATH_MINUS", "MATH_MULTIPLY", "MATH_NOT_EQUAL",
  "MATH_PLUS", "MOON", "NO_SMOKING", "NOTCHED_RIGHT_ARROW", "OCTAGON", "PARALLELOGRAM",
  "PENTAGON", "PIE", "PLAQUE", "PLUS", "QUAD_ARROW", "QUAD_ARROW_CALLOUT", "RIBBON", "RIBBON_2",
  "RIGHT_ARROW", "RIGHT_ARROW_CALLOUT", "RIGHT_BRACE", "RIGHT_BRACKET", "ROUND_1_RECTANGLE",
  "ROUND_2_DIAGONAL_RECTANGLE", "ROUND_2_SAME_RECTANGLE", "RIGHT_TRIANGLE", "SMILEY_FACE",
  "SNIP_1_RECTANGLE", "SNIP_2_DIAGONAL_RECTANGLE", "SNIP_2_SAME_RECTANGLE",
  "SNIP_ROUND_RECTANGLE", "STAR_10", "STAR_12", "STAR_16", "STAR_24", "STAR_32", "STAR_4",
  "STAR_5", "STAR_6", "STAR_7", "STAR_8", "STRIPED_RIGHT_ARROW", "SUN", "TRAPEZOID", "TRIANGLE",
  "UP_ARROW", "UP_ARROW_CALLOUT", "UP_DOWN_ARROW", "UTURN_ARROW", "VERTICAL_SCROLL", "WAVE",
  "WEDGE_ELLIPSE_CALLOUT", "WEDGE_RECTANGLE_CALLOUT", "WEDGE_ROUND_RECTANGLE_CALLOUT",
  "FLOW_CHART_ALTERNATE_PROCESS", "FLOW_CHART_COLLATE", "FLOW_CHART_CONNECTOR",
  "FLOW_CHART_DECISION", "FLOW_CHART_DELAY", "FLOW_CHART_DISPLAY", "FLOW_CHART_DOCUMENT",
  "FLOW_CHART_EXTRACT", "FLOW_CHART_INPUT_OUTPUT", "FLOW_CHART_INTERNAL_STORAGE",
  "FLOW_CHART_MAGNETIC_DISK", "FLOW_CHART_MAGNETIC_DRUM", "FLOW_CHART_MAGNETIC_TAPE",
  "FLOW_CHART_MANUAL_INPUT", "FLOW_CHART_MANUAL_OPERATION", "FLOW_CHART_MERGE",
  "FLOW_CHART_MULTIDOCUMENT", "FLOW_CHART_OFFLINE_STORAGE", "FLOW_CHART_OFFPAGE_CONNECTOR",
  "FLOW_CHART_ONLINE_STORAGE", "FLOW_CHART_OR", "FLOW_CHART_PREDEFINED_PROCESS",
  "FLOW_CHART_PREPARATION", "FLOW_CHART_PROCESS", "FLOW_CHART_PUNCHED_CARD",
  "FLOW_CHART_PUNCHED_TAPE", "FLOW_CHART_SORT", "FLOW_CHART_SUMMING_JUNCTION",
  "FLOW_CHART_TERMINATOR", "ARROW_EAST", "ARROW_NORTH_EAST", "ARROW_NORTH", "SPEECH",
  "STARBURST", "TEARDROP", "ELLIPSE_RIBBON", "ELLIPSE_RIBBON_2", "CLOUD_CALLOUT",
]);

/** The changes that create an element, and what each creates. */
export const CREATES: Partial<Record<SlideChange["op"], string>> = {
  createShape: "shape", insertImage: "image", createTable: "table",
};

class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message);
}

function isIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function checkCell(cell: { row: number; column: number } | undefined, elementId?: string): void {
  if (!cell) return;
  if (elementId === undefined) refuse("cell is given, but no table elementId");
  if (!isIndex(cell.row) || !isIndex(cell.column)) refuse("a cell's row and column are zero-based integers");
}

function checkInsertedText(text: string, field: string): void {
  if (STRIPPED_CHARACTERS.test(text)) {
    refuse(`${field} contains a control or private-use character, which Google Slides removes. ` +
      "Use \\n to start a paragraph, \\u000b to break a line");
  }
}

function checkEdit(edit: SlideTextEdit): void {
  checkCell(edit.cell, edit.elementId);
  if (edit.find === "") refuse("find is empty. Omit it to replace all of the text");
  checkInsertedText(edit.replace, "replace");
}

function checkTarget(target: SlideTextTarget, emptyRange: boolean): void {
  checkCell(target.cell, target.elementId);
  if (target.find === "") refuse("find is empty. Omit it to address all of the text");
  let { range } = target;
  if (!range) return;
  if (target.find !== undefined) refuse("give find or range, not both");
  if (!isIndex(range.start) || !isIndex(range.end) || range.end < range.start ||
    (!emptyRange && range.end === range.start)) {
    refuse(`range must be offsets into the text, with start ${emptyRange ? "at most" : "before"} end`);
  }
}

function checkColor(color: string | null | undefined, field: string): void {
  if (color !== undefined && color !== null && !isSlideColor(color)) {
    refuse(`${field} "${color}" is not a #rrggbb colour or a theme colour such as ACCENT1`);
  }
}

function checkPositive(value: number | null | undefined, field: string, max = Infinity): void {
  if (value !== undefined && value !== null && !(Number.isFinite(value) && value > 0 && value <= max)) {
    refuse(`${field} must be a positive number${max < Infinity ? ` up to ${max}` : ""}`);
  }
}

// The length checked is the URL as `normalizedUrls` sends it, percent-encoded, which can run to
// several times what was given.
function checkUrl(url: string, field: string, protocols: readonly string[]): void {
  let parsed = URL.parse(url);
  if (!parsed || parsed.href.length > MAX_URL_LENGTH || !protocols.includes(parsed.protocol) ||
    parsed.username || parsed.password) {
    refuse(`${field} must be a${protocols.length === 1 ? "n" : ""} ${protocols.join(", ")} URL of ` +
      `at most ${MAX_URL_LENGTH} characters once percent-encoded, with no user name or password`);
  }
}

function checkFormat(format: TextFormatChange): void {
  let set = Object.entries(format).filter(([, value]) => value !== undefined);
  if (set.length === 0) refuse("format sets nothing");
  if (format.fontFamily === "") refuse("fontFamily is empty; pass null to unset it");
  checkPositive(format.fontSize, "fontSize", MAX_FONT_SIZE);
  checkColor(format.color, "color");
  checkColor(format.highlight, "highlight");
  if (format.link !== undefined) checkUrl(format.link, "link", ["https:", "http:", "mailto:"]);
}

function checkBounds(bounds: Partial<SlideBounds> | undefined): void {
  if (!bounds) return;
  for (let key of ["x", "y"] as const) {
    let value = bounds[key];
    if (value !== undefined && !Number.isFinite(value)) refuse(`bounds.${key} must be a number`);
  }
  checkPositive(bounds.width, "bounds.width");
  checkPositive(bounds.height, "bounds.height");
}

function checkFill(fill: string | undefined): void {
  if (fill !== "none") checkColor(fill, "fill");
}

function checkOutline(outline: ShapeOutline | "none" | undefined): void {
  if (outline === undefined || outline === "none") return;
  if (outline.color === undefined && outline.weight === undefined) {
    refuse('outline sets nothing; give a colour or weight, or "none"');
  }
  checkColor(outline.color, "outline colour");
  checkPositive(outline.weight, "outline weight");
}

function checkCount(count: number | undefined, max = Infinity): void {
  if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= max)) {
    refuse(`count must be a whole number from 1${max < Infinity ? ` to ${max}` : ""}`);
  }
}

function checkChange(change: SlideChange): void {
  switch (change.op) {
    case "editText":
      return checkEdit(change);
    case "formatText":
      checkTarget(change, false);
      return checkFormat(change.format);
    case "formatParagraphs": {
      checkTarget(change, true);
      let { alignment, lineSpacing, spaceAbove, spaceBelow, bullets } = change;
      if ([alignment, lineSpacing, spaceAbove, spaceBelow, bullets].every(value => value === undefined)) {
        refuse("it sets nothing");
      }
      checkPositive(lineSpacing, "lineSpacing");
      for (let [field, value] of [["spaceAbove", spaceAbove], ["spaceBelow", spaceBelow]] as const) {
        if (value !== undefined && value !== null && !(Number.isFinite(value) && value >= 0)) {
          refuse(`${field} must be a number of points, 0 or more`);
        }
      }
      return;
    }
    case "createShape":
      if (!SHAPE_TYPES.has(change.shapeType)) {
        refuse(`shapeType "${change.shapeType}" is not a Google Slides shape type, such as TEXT_BOX`);
      }
      checkBounds(change.bounds);
      if (change.text !== undefined) checkInsertedText(change.text, "text");
      if (change.format) {
        if (!change.text) refuse("format is given, but no text to format");
        checkFormat(change.format);
      }
      checkFill(change.fill);
      return checkOutline(change.outline);
    case "updateShape":
      if (change.fill === undefined && change.outline === undefined && change.contentAlignment === undefined) {
        refuse("it sets nothing");
      }
      checkFill(change.fill);
      return checkOutline(change.outline);
    case "setBounds":
      if (change.bounds === undefined && change.rotation === undefined) refuse("it sets nothing");
      if (change.bounds && Object.values(change.bounds).every(value => value === undefined)) {
        refuse("bounds sets nothing");
      }
      checkBounds(change.bounds);
      if (change.rotation !== undefined && !Number.isFinite(change.rotation)) {
        refuse("rotation must be a number of degrees");
      }
      return;
    case "setAltText":
      if (change.title === undefined && change.description === undefined) refuse("it sets nothing");
      // Google keeps alt text a request leaves unset, and may read an empty string as unset.
      if (change.title === "" || change.description === "") {
        refuse("alt text cannot be cleared; give the text it should have");
      }
      return;
    case "insertImage":
      checkBounds(change.bounds);
      return checkUrl(change.url, "url", ["https:"]);
    case "replaceImage":
      return checkUrl(change.url, "url", ["https:"]);
    case "createTable": {
      let { rows, columns, cells = [] } = change;
      for (let [field, value] of [["rows", rows], ["columns", columns]] as const) {
        if (!(Number.isInteger(value) && value >= 1 && value <= MAX_TABLE_SIZE)) {
          refuse(`${field} must be a whole number from 1 to ${MAX_TABLE_SIZE}`);
        }
      }
      checkBounds(change.bounds);
      if (cells.length > rows || cells.some(line => line.length > columns)) {
        refuse(`cells has more rows or columns than the table's ${rows} by ${columns}`);
      }
      cells.flat().forEach(text => checkInsertedText(text, "a cell's text"));
      return;
    }
    case "insertTableRows":
    case "insertTableColumns":
      if (!isIndex(change.at)) refuse("at must be a zero-based index");
      return checkCount(change.count, MAX_LINES_INSERTED);
    case "deleteTableRows":
    case "deleteTableColumns":
      if (!isIndex(change.at)) refuse("at must be a zero-based index");
      return checkCount(change.count);
    case "formatTableCells": {
      if (change.fill === undefined && change.contentAlignment === undefined) refuse("it sets nothing");
      checkFill(change.fill);
      let { range } = change;
      if (range && (!isIndex(range.row) || !isIndex(range.column) ||
        [range.rowSpan, range.columnSpan].some(span =>
          span !== undefined && !(Number.isInteger(span) && span >= 1)))) {
        refuse("range must be a zero-based row and column, with spans of 1 or more");
      }
      return;
    }
    case "deleteElement":
    case "arrange":
      return;
  }
}

const TEXT_TARGET = ["elementId", "cell", "find", "range"];
const TABLE_LINES = ["elementId", "at", "count"];

// What each change declares. capnweb-validate passes undeclared properties through unchecked, so
// they are dropped before anything reads them: the approval describes only what is written.
const FIELDS: Record<SlideChange["op"], readonly string[]> = {
  editText: ["elementId", "cell", "find", "replace"],
  formatText: [...TEXT_TARGET, "format"],
  formatParagraphs: [...TEXT_TARGET, "alignment", "lineSpacing", "spaceAbove", "spaceBelow", "bullets"],
  createShape: ["ref", "shapeType", "bounds", "text", "format", "fill", "outline"],
  updateShape: ["elementId", "fill", "outline", "contentAlignment"],
  setBounds: ["elementId", "bounds", "rotation"],
  deleteElement: ["elementId"],
  setAltText: ["elementId", "title", "description"],
  arrange: ["elementId", "to"],
  insertImage: ["ref", "url", "bounds"],
  replaceImage: ["elementId", "url"],
  createTable: ["ref", "rows", "columns", "bounds", "cells"],
  insertTableRows: TABLE_LINES,
  insertTableColumns: TABLE_LINES,
  deleteTableRows: TABLE_LINES,
  deleteTableColumns: TABLE_LINES,
  formatTableCells: ["elementId", "range", "fill", "contentAlignment"],
};

const NESTED_FIELDS: Record<string, readonly string[]> = {
  cell: ["row", "column"],
  bounds: ["x", "y", "width", "height"],
  outline: ["color", "weight"],
  format: [
    "bold", "italic", "underline", "strikethrough", "smallCaps", "fontFamily", "fontSize", "color",
    "highlight", "link", "baseline",
  ],
};

function picked(value: object, keys: readonly string[]): Record<string, unknown> {
  let fields = value as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap(key => fields[key] === undefined ? [] : [[key, fields[key]]]));
}

function declared(change: SlideChange): SlideChange {
  let fields = picked(change, ["op", "slideId", ...FIELDS[change.op]]);
  for (let [key, value] of Object.entries(fields)) {
    let nested = key !== "range" ? NESTED_FIELDS[key]
      : change.op === "formatTableCells" ? ["row", "column", "rowSpan", "columnSpan"] : ["start", "end"];
    if (nested && typeof value === "object" && value !== null) fields[key] = picked(value, nested);
  }
  return fields as SlideChange;
}

// The URL as the parser read it, so Google gets exactly what was checked.
function normalizedUrls(change: SlideChange): SlideChange {
  if ("url" in change) return { ...change, url: new URL(change.url).href };
  if ("format" in change && change.format?.link !== undefined) {
    return { ...change, format: { ...change.format, link: new URL(change.format.link).href } };
  }
  return change;
}

// Prefixes a refusal with the change it is about.
function inChange<T>(label: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    throw new Error(`${label}: ${error.message}.`, { cause: error });
  }
}

/**
 * Checks `changes` as far as they can be without the presentation, and mints an ID for each element
 * they create. Returns the changes addressing those elements by their IDs, and the ID of each
 * element created with a `ref`, under it. Throws `Error`.
 */
export function prepareChanges(
  changes: SlideChange[],
): { changes: DesignChange[]; refs: Record<string, string> } {
  if (changes.length === 0 || changes.length > MAX_CHANGES) {
    throw new Error(`Make between 1 and ${MAX_CHANGES} changes at a time.`);
  }
  let refs = new Map<string, string>();
  let prepared = changes.map((given, i) => inChange(`Change ${i + 1} (${given.op})`, () => {
    let change = declared(given);
    checkChange(change);
    let { ref, ...rest } = normalizedUrls(change) as SlideChange & { ref?: string };
    let id = "elementId" in rest && rest.elementId !== undefined ? refs.get(rest.elementId) : undefined;
    let resolved = id ? { ...rest, elementId: id } : rest;
    if (!CREATES[change.op]) return resolved as DesignChange;
    let minted = mintObjectId();
    if (ref !== undefined) {
      if (ref.length === 0 || ref.length > MAX_REF_LENGTH) {
        refuse(`ref must be 1 to ${MAX_REF_LENGTH} characters`);
      }
      if (refs.has(ref)) refuse(`ref "${ref}" names an element an earlier change creates`);
      refs.set(ref, minted);
    }
    return { ...resolved, id: minted } as DesignChange;
  }));
  return { changes: prepared, refs: Object.fromEntries(refs) };
}
