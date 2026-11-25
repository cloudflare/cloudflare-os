// A fake of how Google applies a field mask to a `documents.get` answer, for every test fake
// that answers that request: what a mask selects, and which masks are refused. It loads in Node
// and in workerd alike.

import type { GoogleDocsDocument } from "../src/docs-api";

/**
 * The field names of the Docs API's `documents` resource that the gatekeeper's field masks may
 * name, as Google's reference gives them, and `suggestions`, the suggestion threads a read with
 * comments included returns, which Google took in a mask on 2026-11-21. The fake refuses any other
 * name, as Google does; it does not know which type has which name (see `parseFieldMask`).
 */
export const DOCS_API_FIELD_NAMES: ReadonlySet<string> = new Set([
  "alignment", "autoText", "body", "bold", "bullet", "childTabs", "columnBreak", "content",
  "dateElement", "dateElementProperties", "displayText", "documentId", "documentTab", "dropdown",
  "dropdownId", "dropdownProperties", "elements", "endIndex", "equation", "fontSize", "footnoteId",
  "footnoteNumber", "footnoteReference", "foregroundColor", "glyphSymbol", "glyphType", "headingId",
  "horizontalRule", "indentFirstLine", "indentStart", "inlineObjectElement", "inlineObjectId",
  "italic", "link", "listId", "listProperties", "lists", "minRowHeight", "name", "namedRangeId",
  "namedRanges", "namedStyleType", "namedStyles", "nestingLevel", "nestingLevels", "pageBreak",
  "paragraph", "paragraphStyle", "person", "personProperties", "positionedObjectIds", "revisionId",
  "richLink", "richLinkProperties", "sectionBreak", "startIndex", "startNumber", "strikethrough",
  "styles", "suggestedBulletChanges", "suggestedDeletionIds", "suggestedInsertionIds",
  "suggestedParagraphStyleChanges", "suggestedTableCellStyleChanges",
  "suggestedTableRowStyleChanges", "suggestedTextStyleChanges", "suggestions", "tabId",
  "tabProperties", "table", "tableCellStyle", "tableCells", "tableHeader", "tableOfContents",
  "tableRowStyle", "tableRows", "tableStyle", "tabs", "textRun", "textStyle", "title", "type",
  "underline", "uri",
]);

/** A parsed field mask: for each field, `null` for the field whole, or the selection inside it. */
export type FieldSelection = ReadonlyMap<string, FieldSelection | null>;

/** A field mask Google answers with a 400. */
export class InvalidFieldMask extends Error {}

/** The two fields of a `documentTab` that are maps keyed by ID. */
const ID_KEYED_MAPS: ReadonlySet<string> = new Set(["lists", "namedRanges"]);

/** A selection as the parser builds it, before it is handed out read-only. */
type Selecting = Map<string, Selecting | null>;

/**
 * Adds `name` to `selection` with what is selected `inside` it. A field named twice selects
 * what both selections do, and one asked whole once is whole.
 */
function select(selection: Selecting, name: string, inside: Selecting | null): void {
  let selected = selection.get(name);
  if (selected === undefined || selected === null || inside === null) {
    selection.set(name, selected === undefined ? inside : null);
    return;
  }
  for (let [field, within] of inside) select(selected, field, within);
}

/**
 * Parses a field mask (`a,b(c,d(e)),f`, with `a/b` and `a.b` for `a(b)`). Throws
 * `InvalidFieldMask` for one that is not well formed, that names a field
 * `DOCS_API_FIELD_NAMES` does not hold, that uses a wildcard, or that selects inside `lists` or
 * `namedRanges` where they are the ID-keyed maps of a `documentTab`: Google refuses a wildcard
 * into those maps, and no other selection inside them has been seen to be taken.
 *
 * A name is checked against the list, not against the place it stands in. Google refuses a
 * name the type at that place does not have (`tabs(title)`, `paragraphStyle(bold)`), and this
 * takes it: a mask that passes here is well formed and made of known names, which is less than
 * a mask Google takes.
 */
export function parseFieldMask(mask: string): FieldSelection {
  let at = 0;

  /** The fields between commas from `at`, which are the fields of `parent`. */
  let fields = (parent: string | undefined): Selecting => {
    let selection: Selecting = new Map();
    for (;;) {
      let [name, inside] = field(parent);
      select(selection, name, inside);
      if (mask[at] !== ",") return selection;
      at++;
    }
  };

  /** One field of `parent` from `at`, with what the mask selects inside it. */
  let field = (parent: string | undefined): [string, Selecting | null] => {
    let start = at;
    while (at < mask.length && /[A-Za-z0-9_]/.test(mask[at])) at++;
    let name = mask.slice(start, at);
    // Google takes a wildcard in general and refuses one into the two ID-keyed maps. The
    // gatekeeper sends none, so the fake refuses them all.
    if (mask[at] === "*") throw new InvalidFieldMask(`A wildcard at ${at}`);
    if (name === "") throw new InvalidFieldMask(`No field name at ${at}`);
    if (!DOCS_API_FIELD_NAMES.has(name)) throw new InvalidFieldMask(`Unknown field ${name}`);
    let inside: Selecting | null = null;
    if (mask[at] === "(") {
      at++;
      inside = fields(name);
      if (mask[at++] !== ")") throw new InvalidFieldMask(`No closing parenthesis for ${name}`);
    } else if (mask[at] === "/" || mask[at] === ".") {
      at++;
      inside = new Map([field(name)]);
    }
    if (inside && parent === "documentTab" && ID_KEYED_MAPS.has(name)) {
      throw new InvalidFieldMask(`A selection inside the map ${name}`);
    }
    return [name, inside];
  };

  let selection = fields(undefined);
  if (at !== mask.length) throw new InvalidFieldMask(`Unexpected text at ${at}`);
  return selection;
}

/**
 * `answer` as Google sends it for `selection`: of an object, the selected fields it holds, in
 * its own order; a list keeps every item, each selected in turn; an object none of whose
 * selected fields is set is `{}`. Shares the parts taken whole with `answer`.
 */
export function selectFields(answer: unknown, selection: FieldSelection): unknown {
  if (Array.isArray(answer)) return answer.map(item => selectFields(item, selection));
  if (answer === null || typeof answer !== "object") return answer;
  let selected: Record<string, unknown> = {};
  for (let [name, value] of Object.entries(answer)) {
    let inside = selection.get(name);
    if (inside === undefined) continue;
    selected[name] = inside === null ? value : selectFields(value, inside);
  }
  return selected;
}

/** The field mask a request carries: its `X-Goog-FieldMask` header, else its `fields` parameter. */
export function requestedFieldMask(url: URL, headers: Headers): string | undefined {
  return headers.get("X-Goog-FieldMask") ?? url.searchParams.get("fields") ?? undefined;
}

/**
 * Google's answer to a `documents.get` that `document` is the whole answer of: `document` itself
 * for a request with no field mask, the fields the mask selects for one with a mask, and a 400
 * with the status `INVALID_ARGUMENT` for a mask `parseFieldMask` refuses.
 */
export function docsGetResponse(url: URL, headers: Headers, document: unknown): Response {
  let mask = requestedFieldMask(url, headers);
  if (mask === undefined) return Response.json(document);
  let selection: FieldSelection;
  try {
    selection = parseFieldMask(mask);
  } catch (error) {
    if (!(error instanceof InvalidFieldMask)) throw error;
    return Response.json({
      error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
    }, { status: 400 });
  }
  return Response.json(selectFields(document, selection));
}

/**
 * A whole `documents.get` answer for `document`: its tabs nested as Google nests them, each as
 * `tabProperties`, `documentTab` and `childTabs`, with whatever else the tabs hold.
 */
export function rawDocsDocument(document: GoogleDocsDocument): Record<string, unknown> {
  let { documentId, title, revisionId, tabs } = document;
  let ids = new Set(tabs.map(tab => tab.tabId));
  /** The tabs under `parent`, in the document's order; with no parent, the top-level ones. */
  let nested = (parent: string | undefined): Record<string, unknown>[] => tabs
    .filter(tab => parent === undefined
      ? tab.parentTabId === undefined || !ids.has(tab.parentTabId)
      : tab.parentTabId === parent)
    .map(tab => {
      let {
        tabId, title: _title, parentTabId: _parent, index: _index, nestingLevel: _level,
        ...documentTab
      } = tab;
      let childTabs = nested(tabId);
      return {
        tabProperties: { tabId, title: tab.title },
        documentTab,
        ...childTabs.length === 0 ? {} : { childTabs },
      };
    });
  return {
    documentId, title, ...revisionId === undefined ? {} : { revisionId }, tabs: nested(undefined),
  };
}

/** `answer` copied with everything `selection` does not name poisoned (`poisonOutsideMask`). */
function poisoned(answer: unknown, selection: FieldSelection): unknown {
  if (Array.isArray(answer)) return answer.map(item => poisoned(item, selection));
  if (answer === null || typeof answer !== "object") return answer;
  let copy: Record<string, unknown> = {};
  for (let [name, held] of Object.entries(answer)) {
    let inside = selection.get(name);
    if (inside === undefined) {
      copy[name] = held !== null && typeof held === "object" ? "unasked" : { unasked: true };
    } else {
      copy[name] = inside === null ? structuredClone(held) : poisoned(held, inside);
    }
  }
  copy.unasked = "unasked";
  return copy;
}

/**
 * A copy of `answer`, a whole `documents.get` answer, in which everything `mask` does not ask
 * for holds a value of the wrong kind, so that a reader of it breaks or gives something else. In
 * every object the mask selects inside, each field the selection does not name becomes
 * `"unasked"` where it held an object or a list and `{ unasked: true }` where it held a
 * primitive, and one more field is added, `unasked: "unasked"`. What the mask asks for whole is
 * copied as it is. Selecting `mask` from the copy gives what selecting it from `answer` gives.
 */
export function poisonOutsideMask(answer: unknown, mask: string): unknown {
  return poisoned(answer, parseFieldMask(mask));
}
