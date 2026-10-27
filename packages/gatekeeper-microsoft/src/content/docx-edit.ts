// Editing a Word document in place: text replaced, Markdown inserted next to a paragraph, or a
// paragraph removed, optionally as tracked changes a reviewer accepts or rejects in Word like a
// colleague's. The document part is edited by splicing its text (see `raw-xml.ts`), so paragraphs
// an edit doesn't reach keep their exact bytes, and every other part of the package is copied
// through unchanged except where inserted content needs a style, a list definition or a link.
//
// Text is matched as Word shows it with every tracked change accepted: across the runs Word splits
// a sentence into (spell-check marks, revision ids, formatting), with tabs as "\t", line breaks as
// "\n", and curly quotes and non-breaking spaces matching their plain forms.

import { emptyParagraph, renderBlocks, revisionAttributes, textXml, type BodyContext, type Revision } from "./docx-body";
import { NumberingAllocator } from "./docx-numbering";
import { CONTENT_TYPES, ContentTypesEditor, PackageEditor, RelationshipsEditor } from "./docx-package";
import { StyleCatalog } from "./docx-styles";
import { requireTransitional, textWidth } from "./docx-write";
import { parseMarkdown } from "./markdown-parse";
import { escapeText, findMainPart, findRelationship, parsePart, readRelationships, relationshipsPartName, withRelationshipsNs } from "./ooxml";
import { applySplices, elementText, parseRaw, rawChild, rawChildren, RawXmlError, type RawElement, type Splice } from "./raw-xml";
import { childElements, firstChild } from "./xml";
import { openZip } from "./zip";

/** One change to a Word document. */
export type DocumentEdit =
  | { find: string; replace: string; all?: boolean }
  | { insertAfter: string; markdown: string }
  | { insertBefore: string; markdown: string }
  | { deleteParagraph: string };

/** How `editDocx` records its changes. */
export interface EditDocxOptions {
  /** Record the edits as tracked changes (revisions) rather than applying them silently. */
  readonly trackChanges: boolean;
  /** Who tracked changes are attributed to. */
  readonly author: string;
  /** When tracked changes are dated, and the package's modification time. */
  readonly date: Date;
}

/** What one edit changed, as plain text: a paragraph before and after, or one inserted or removed. */
export interface DocumentChange {
  readonly before?: string;
  readonly after?: string;
}

/** An edit that can't be made, with a message the agent can act on. */
export class DocumentEditError extends Error {
  override readonly name = "DocumentEditError";
  /** The 0-based index of the edit that failed, when one did. */
  readonly editIndex: number | undefined;

  constructor(message: string, editIndex?: number, options?: ErrorOptions) {
    super(editIndex === undefined ? message : `Edit ${editIndex + 1}: ${message}`, options);
    this.editIndex = editIndex;
  }
}

/** Applies `edits` in order, each to the result of the one before. Throws `DocumentEditError`. */
export async function editDocx(
  bytes: Uint8Array, edits: readonly DocumentEdit[], options: EditDocxOptions,
): Promise<{ bytes: Uint8Array; changes: DocumentChange[] }> {
  if (edits.length === 0) throw new DocumentEditError("No edits were given.");
  let document: EditableDocument;
  try {
    document = await EditableDocument.open(bytes, options);
    await document.prepare(edits);
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    throw new DocumentEditError(`The document can't be edited: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error });
  }
  const changes: DocumentChange[] = [];
  edits.forEach((edit, index) => {
    try {
      changes.push(...document.apply(edit));
    } catch (error) {
      if (error instanceof DocumentEditError && error.editIndex === undefined) throw new DocumentEditError(error.message, index, { cause: error });
      if (error instanceof RawXmlError) throw new DocumentEditError(`the document's XML can't be edited: ${error.message}`, index, { cause: error });
      throw error;
    }
  });
  return { bytes: await document.save(), changes };
}

/** Characters Word substitutes as you type, each matched by its plain form. One for one, so offsets carry over. */
const FOLDED: Readonly<Record<string, string>> = {
  "‘": "'", "’": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "‟": '"', "″": '"',
  " ": " ", " ": " ", " ": " ",
};

function fold(text: string): string {
  return text.replace(/[‘’‛′“”‟″   ]/g, char => FOLDED[char]!);
}

/** Run content that is text, and what it reads as. */
const ATOMS: Readonly<Record<string, string>> = { "w:tab": "\t", "w:br": "\n", "w:cr": "\n", "w:noBreakHyphen": "-" };

/** Run content an edit must not cut through: replacing text on both sides of it would drop or move it. */
const OBJECTS = new Set([
  "w:drawing", "w:pict", "w:object", "w:fldChar", "w:instrText", "w:footnoteReference", "w:endnoteReference",
  "w:commentReference", "w:sym", "w:ruby", "w:ptab", "w:separator", "w:continuationSeparator",
]);

/** Containers whose runs are part of the paragraph's text (`w:del` and `w:moveFrom` are not). */
const TRANSPARENT = new Set(["w:ins", "w:moveTo", "w:hyperlink", "w:smartTag", "w:customXml", "w:fldSimple", "w:dir", "w:bdo", "w:sdtContent"]);

/** Paragraphs in these are skipped: text boxes, which Word also stores a second, fallback copy of. */
const OPAQUE = new Set(["mc:AlternateContent", "w:txbxContent", "w:drawing", "w:pict", "w:object"]);

/** A piece of a run that reads as text: a `w:t`'s text, or one tab, break or hyphen. */
interface Piece {
  readonly run: RawElement;
  readonly element: RawElement;
  readonly text: string;
  /** Offset of the piece in the paragraph's text. */
  readonly from: number;
}

/** A paragraph's text as Word shows it, and where each character came from. */
interface ParagraphText {
  readonly paragraph: RawElement;
  readonly text: string;
  readonly folded: string;
  readonly pieces: Piece[];
  /** Offsets in the text at which an object (picture, field, note reference) sits. */
  readonly objects: number[];
}

class EditableDocument {
  #xml: string;
  readonly #pkg: PackageEditor;
  readonly #mainPart: string;
  readonly #options: EditDocxOptions;
  readonly #revision: Revision | undefined;
  readonly #insertion: () => Promise<InsertionParts>;
  #parts: InsertionParts | undefined;

  private constructor(pkg: PackageEditor, mainPart: string, xml: string, options: EditDocxOptions, nextId: number, insertion: () => Promise<InsertionParts>) {
    this.#pkg = pkg;
    this.#mainPart = mainPart;
    this.#xml = xml;
    this.#options = options;
    let id = nextId;
    this.#revision = options.trackChanges ? { author: options.author, date: options.date, nextId: () => id++ } : undefined;
    this.#insertion = insertion;
  }

  /** The table style most of the document's tables use, which inserted tables then take too. */
  #houseTableStyle(): string | undefined {
    const counts = new Map<string, number>();
    for (const match of this.#xml.matchAll(/<w:tblStyle w:val="([^"]+)"/g)) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
    return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
  }

  static async open(bytes: Uint8Array, options: EditDocxOptions): Promise<EditableDocument> {
    const zip = openZip(bytes);
    const pkg = new PackageEditor(zip);
    const mainPart = await findMainPart(zip, "word/document.xml");
    const xml = (await pkg.text(mainPart))!;
    requireTransitional(xml, mainPart);
    // Revision ids must not collide with any annotation already in the document's story parts.
    let maxId = 0;
    for (const entry of zip.entries()) {
      if (!/^word\/[^/]+\.xml$/i.test(entry.name)) continue;
      for (const match of (await pkg.text(entry.name) ?? "").matchAll(/\bw:id="(\d{1,9})"/g)) maxId = Math.max(maxId, Number(match[1]));
    }
    const insertion = async (): Promise<InsertionParts> => {
      const relationships = await readRelationships(zip, mainPart);
      const stylesPart = findRelationship(relationships, "styles")?.target;
      const numberingPart = findRelationship(relationships, "numbering")?.target;
      const stylesXml = stylesPart === undefined ? undefined : await pkg.text(stylesPart);
      const numberingXml = numberingPart === undefined ? undefined : await pkg.text(numberingPart);
      if (stylesPart !== undefined && stylesXml !== undefined) requireTransitional(stylesXml, stylesPart);
      if (numberingPart !== undefined && numberingXml !== undefined) requireTransitional(numberingXml, numberingPart);
      const relationshipsPart = relationshipsPartName(mainPart);
      return {
        styles: new StyleCatalog(stylesXml), stylesPart,
        numbering: new NumberingAllocator(numberingXml), numberingPart,
        relationships: new RelationshipsEditor(await pkg.text(relationshipsPart)), relationshipsPart,
      };
    };
    return new EditableDocument(pkg, mainPart, xml, options, maxId + 1, insertion);
  }

  apply(edit: DocumentEdit): DocumentChange[] {
    if ("find" in edit) return this.#replace(edit.find, edit.replace, edit.all ?? false);
    if ("deleteParagraph" in edit) return this.#delete(edit.deleteParagraph);
    if ("insertAfter" in edit) return this.#insert(edit.insertAfter, edit.markdown, "after");
    if ("insertBefore" in edit) return this.#insert(edit.insertBefore, edit.markdown, "before");
    throw new DocumentEditError("The edit is not one of find/replace, insertAfter, insertBefore or deleteParagraph.");
  }

  /** Must be awaited before an insertion; `apply` is synchronous, so `editDocx` primes it. */
  async prepare(edits: readonly DocumentEdit[]): Promise<void> {
    if (this.#parts || !edits.some(edit => "markdown" in edit)) return;
    this.#parts = await this.#insertion();
    const tableStyle = this.#houseTableStyle();
    if (tableStyle !== undefined) this.#parts.styles.prefer("table", tableStyle);
  }

  async save(): Promise<Uint8Array> {
    this.#pkg.set(this.#mainPart, withRelationshipsNs(this.#xml));
    const parts = this.#parts;
    if (parts) {
      const directory = this.#mainPart.slice(0, this.#mainPart.lastIndexOf("/") + 1);
      const contentTypes = new ContentTypesEditor((await this.#pkg.text("[Content_Types].xml")) ?? "");
      if (parts.styles.changed) {
        if (parts.stylesPart === undefined) {
          parts.relationships.add("styles", "styles.xml");
          contentTypes.setOverride(`${directory}styles.xml`, CONTENT_TYPES.styles);
        }
        this.#pkg.set(parts.stylesPart ?? `${directory}styles.xml`, parts.styles.serialize());
      }
      if (parts.numbering.used) {
        if (parts.numberingPart === undefined) {
          parts.relationships.add("numbering", "numbering.xml");
          contentTypes.setOverride(`${directory}numbering.xml`, CONTENT_TYPES.numbering);
        }
        this.#pkg.set(parts.numberingPart ?? `${directory}numbering.xml`, parts.numbering.serialize());
      }
      if (parts.relationships.changed) this.#pkg.set(parts.relationshipsPart, parts.relationships.toString());
      if (contentTypes.changed) this.#pkg.set("[Content_Types].xml", contentTypes.toString());
    }
    return this.#pkg.write(this.#options.date);
  }

  // ---- Reading ----

  #paragraphs(): ParagraphText[] {
    const root = parseRaw(this.#xml);
    const body = rawChild(root, "w:body");
    if (!body) throw new DocumentEditError("The document has no body.");
    const paragraphs: RawElement[] = [];
    const visit = (element: RawElement): void => {
      for (const child of rawChildren(element)) {
        if (child.name === "w:p") paragraphs.push(child);
        else if (!OPAQUE.has(child.name)) visit(child);
      }
    };
    visit(body);
    return paragraphs.map(paragraph => this.#paragraphText(paragraph));
  }

  #paragraphText(paragraph: RawElement): ParagraphText {
    const pieces: Piece[] = [];
    const objects: number[] = [];
    let text = "";
    const visit = (parent: RawElement): void => {
      for (const child of rawChildren(parent)) {
        if (child.name === "w:r") {
          for (const content of rawChildren(child)) {
            const value = content.name === "w:t" ? elementText(content) : ATOMS[content.name];
            if (value !== undefined) {
              if (value !== "") pieces.push({ run: child, element: content, text: value, from: text.length });
              text += value;
            } else if (OBJECTS.has(content.name)) {
              objects.push(text.length);
            }
          }
        } else if (TRANSPARENT.has(child.name)) {
          visit(child);
        } else if (child.name === "w:sdt") {
          const content = rawChild(child, "w:sdtContent");
          if (content) visit(content);
        } else if (child.name === "m:oMath" || child.name === "m:oMathPara" || OPAQUE.has(child.name)) {
          objects.push(text.length);
        }
      }
    };
    visit(paragraph);
    return { paragraph, text, folded: fold(text), pieces, objects };
  }

  /** Every paragraph containing `needle`, with the offsets it occurs at. */
  #find(needle: string, what: string): Array<{ paragraph: ParagraphText; at: number[] }> {
    if (needle === "") throw new DocumentEditError(`The text to ${what} is empty.`);
    const folded = fold(needle);
    const found: Array<{ paragraph: ParagraphText; at: number[] }> = [];
    for (const paragraph of this.#paragraphs()) {
      const at: number[] = [];
      for (let index = paragraph.folded.indexOf(folded); index !== -1; index = paragraph.folded.indexOf(folded, index + folded.length)) at.push(index);
      if (at.length > 0) found.push({ paragraph, at });
    }
    if (found.length === 0) throw this.#notFound(needle, folded);
    return found;
  }

  #notFound(needle: string, folded: string): DocumentEditError {
    const lower = folded.toLowerCase();
    const near = this.#paragraphs().find(paragraph => paragraph.folded.toLowerCase().includes(lower));
    const shown = JSON.stringify(needle.length > 80 ? `${needle.slice(0, 80)}…` : needle);
    if (near) {
      const at = near.folded.toLowerCase().indexOf(lower);
      return new DocumentEditError(`${shown} wasn't found; it differs in capitalization from ${JSON.stringify(near.text.slice(at, at + needle.length))}.`);
    }
    if (needle.includes("\n\n")) return new DocumentEditError(`${shown} wasn't found. Text is matched within one paragraph; split the edit by paragraph.`);
    return new DocumentEditError(`${shown} wasn't found in the document's body. Quote it exactly as the document has it (headers, footers, comments and text boxes can't be edited).`);
  }

  /** The one paragraph containing `anchor`. */
  #anchor(anchor: string): ParagraphText {
    const found = this.#find(anchor, "find");
    if (found.length > 1) {
      throw new DocumentEditError(`${JSON.stringify(anchor)} is in ${found.length} paragraphs; quote more of the one you mean so it is in only one.`);
    }
    return found[0]!.paragraph;
  }

  // ---- Replacing ----

  #replace(find: string, replace: string, all: boolean): DocumentChange[] {
    const found = this.#find(find, "replace");
    const count = found.reduce((sum, match) => sum + match.at.length, 0);
    if (!all && count > 1) {
      throw new DocumentEditError(`${JSON.stringify(find)} occurs ${count} times; quote more of the sentence so it occurs once, or set all: true to replace every one.`);
    }
    const splices: Splice[] = [];
    const changes: DocumentChange[] = [];
    for (const { paragraph, at } of found) {
      const ranges = at.map(start => ({ start, end: start + find.length }));
      for (const range of ranges) {
        if (paragraph.objects.some(offset => offset > range.start && offset < range.end)) {
          throw new DocumentEditError(`${JSON.stringify(find)} spans a picture, field or note reference, which replacing it would remove; replace the text on either side of it separately.`);
        }
      }
      splices.push(...this.#rewriteRuns(paragraph, ranges, replace));
      let after = "";
      let cursor = 0;
      for (const range of ranges) {
        after += paragraph.text.slice(cursor, range.start) + replace;
        cursor = range.end;
      }
      changes.push({ before: paragraph.text, after: after + paragraph.text.slice(cursor) });
    }
    this.#xml = applySplices(this.#xml, splices);
    return changes;
  }

  /**
   * Splices that remove `ranges` from the paragraph's runs and put `replacement` at the end of each,
   * in the formatting of the range's first character. Only runs a range touches are rewritten; each
   * is split into the runs before, in and after the range, keeping its own properties.
   */
  #rewriteRuns(paragraph: ParagraphText, ranges: ReadonlyArray<{ start: number; end: number }>, replacement: string): Splice[] {
    const byRun = new Map<RawElement, Piece[]>();
    for (const piece of paragraph.pieces) {
      if (ranges.some(range => piece.from < range.end && piece.from + piece.text.length > range.start)) {
        byRun.set(piece.run, [...(byRun.get(piece.run) ?? []), piece]);
      }
    }
    // Each range's replacement goes after its last character, formatted like its first.
    const insertions = new Map<{ start: number; end: number }, string>();
    for (const range of ranges) {
      const first = paragraph.pieces.find(piece => piece.from < range.end && piece.from + piece.text.length > range.start)!;
      if (replacement !== "") insertions.set(range, this.#insertedRun(first.run, replacement));
    }

    const splices: Splice[] = [];
    for (const [run, pieces] of byRun) {
      const open = this.#xml.slice(run.start, run.openEnd);
      const properties = rawChild(run, "w:rPr");
      const rPr = properties ? this.#xml.slice(properties.start, properties.end) : "";
      let out = "";
      let kept = "";
      let deleted = "";
      const flushKept = (): void => {
        if (kept) out += `${open}${rPr}${kept}</w:r>`;
        kept = "";
      };
      const flushDeleted = (): void => {
        if (!deleted) return;
        out += this.#revision ? `<w:del ${revisionAttributes(this.#revision)}>${open}${rPr}${deleted}</w:r></w:del>` : "";
        deleted = "";
      };
      for (const child of rawChildren(run)) {
        if (child === properties) continue;
        const piece = pieces.find(candidate => candidate.element === child);
        if (!piece) {
          // Content no range reaches (or zero-width marks) stays where it is, with the text before it.
          flushDeleted();
          kept += this.#xml.slice(child.start, child.end);
          continue;
        }
        for (const segment of segments(piece, ranges)) {
          if (segment.deleted) {
            flushKept();
            deleted += child.name === "w:t" ? `<w:delText xml:space="preserve">${escapeText(segment.text)}</w:delText>` : this.#xml.slice(child.start, child.end);
          } else {
            flushDeleted();
            kept += segment.whole ? this.#xml.slice(child.start, child.end) : textXml(segment.text);
          }
          if (segment.endsRange) {
            flushKept();
            flushDeleted();
            out += insertions.get(segment.endsRange) ?? "";
          }
        }
      }
      flushKept();
      flushDeleted();
      splices.push({ start: run.start, end: run.end, text: out });
    }
    return splices;
  }

  #insertedRun(source: RawElement, text: string): string {
    const open = this.#xml.slice(source.start, source.openEnd);
    const properties = rawChild(source, "w:rPr");
    const rPr = properties ? this.#xml.slice(properties.start, properties.end) : "";
    const content = text.split("\n").map(textXml).join("<w:br/>");
    const run = `${open}${rPr}${content}</w:r>`;
    return this.#revision ? `<w:ins ${revisionAttributes(this.#revision)}>${run}</w:ins>` : run;
  }

  // ---- Inserting ----

  #insert(anchor: string, markdown: string, where: "before" | "after"): DocumentChange[] {
    const parts = this.#parts;
    if (!parts) throw new Error("editDocx did not prepare the document for insertion.");
    const { paragraph } = this.#anchor(anchor);
    const blocks = parseMarkdown(markdown);
    if (blocks.length === 0) throw new DocumentEditError("The Markdown to insert is empty.");
    const context: BodyContext = {
      styles: parts.styles, numbering: parts.numbering, hyperlink: url => parts.relationships.hyperlink(url),
      textWidth: this.#textWidth(), revision: this.#revision,
    };
    const rendered = renderBlocks(blocks, context);
    const siblings = rawChildren(paragraph.parent);
    const index = siblings.indexOf(paragraph);
    let xml = rendered.xml;
    // Keep tables from touching one another and the end of a cell or the body.
    const before = where === "after" ? paragraph : siblings[index - 1];
    const next = where === "after" ? siblings[index + 1] : paragraph;
    if (rendered.startsWithTable && before?.name === "w:tbl") xml = emptyParagraph(context) + xml;
    if (rendered.endsWithTable && next?.name !== "w:p") xml += emptyParagraph(context);
    const at = where === "after" ? paragraph.end : paragraph.start;
    this.#xml = applySplices(this.#xml, [{ start: at, end: at, text: xml }]);
    return [{ after: markdown.trim() }];
  }

  #textWidth(): number {
    const section = childElements(firstChild(parsePart(this.#xml), "w:body"), "w:sectPr").at(-1);
    return textWidth(section);
  }

  // ---- Deleting ----

  #delete(anchor: string): DocumentChange[] {
    const target = this.#anchor(anchor);
    const { paragraph } = target;
    const properties = rawChild(paragraph, "w:pPr");
    if (rawChild(properties, "w:sectPr")) {
      throw new DocumentEditError("That paragraph ends a section (it holds the section's page setup), so deleting it would merge two sections; edit its text instead.");
    }
    const siblings = rawChildren(paragraph.parent);
    const index = siblings.indexOf(paragraph);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    const isLast = !siblings.slice(index + 1).some(sibling => sibling.name === "w:p" || sibling.name === "w:tbl" || sibling.name === "w:sdt");
    const splices: Splice[] = [];
    if (this.#revision) {
      for (const run of this.#textRuns(paragraph)) splices.push({ start: run.start, end: run.end, text: this.#deletedRun(run) });
      // The last paragraph of the body or a cell has a mark Word can't delete.
      if (!isLast) splices.push(this.#markDeleted(paragraph, properties));
    } else if (paragraph.parent?.name === "w:tc" && rawChildren(paragraph.parent, "w:p").length === 1 && !rawChild(paragraph.parent, "w:tbl")) {
      // A cell must hold a paragraph, so its only one is emptied rather than removed.
      for (const child of rawChildren(paragraph)) if (child !== properties) splices.push({ start: child.start, end: child.end, text: "" });
    } else {
      if (previous?.name === "w:tbl" && (next === undefined || next.name === "w:tbl" || next.name === "w:sectPr")) {
        throw new DocumentEditError("That paragraph is what keeps a table from running into the next table or the end of the document, so it can't be removed; edit its text instead.");
      }
      if (isLast && rawChildren(paragraph.parent, "w:p").length === 1) {
        throw new DocumentEditError("That is the document's only paragraph, which Word requires; edit its text instead.");
      }
      splices.push({ start: paragraph.start, end: paragraph.end, text: "" });
    }
    this.#xml = applySplices(this.#xml, splices);
    return [{ before: target.text }];
  }

  /** The runs of a paragraph that aren't already deleted, outside text boxes. */
  #textRuns(paragraph: RawElement): RawElement[] {
    const runs: RawElement[] = [];
    const visit = (parent: RawElement): void => {
      for (const child of rawChildren(parent)) {
        if (child.name === "w:r") runs.push(child);
        else if (TRANSPARENT.has(child.name)) visit(child);
        else if (child.name === "w:sdt") {
          const content = rawChild(child, "w:sdtContent");
          if (content) visit(content);
        }
      }
    };
    visit(paragraph);
    return runs;
  }

  /** A run as a tracked deletion: its text as `w:delText`, field codes as `w:delInstrText`. */
  #deletedRun(run: RawElement): string {
    let xml = "";
    let at = run.start;
    // Only the run's own text: a text box inside a drawing keeps its paragraphs as they are.
    for (const child of rawChildren(run)) {
      if (child.name !== "w:t" && child.name !== "w:instrText") continue;
      const name = child.name === "w:t" ? "w:delText" : "w:delInstrText";
      const open = this.#xml.slice(child.start, child.openEnd).replace(child.name, name);
      const close = child.closeStart === child.openEnd && child.end === child.openEnd ? "" : `</${name}>`;
      xml += this.#xml.slice(at, child.start) + open + this.#xml.slice(child.openEnd, child.closeStart) + close;
      at = child.end;
    }
    xml += this.#xml.slice(at, run.end);
    return `<w:del ${revisionAttributes(this.#revision!)}>${xml}</w:del>`;
  }

  /** Marks a paragraph's mark deleted, so accepting the change joins it to the next paragraph. */
  #markDeleted(paragraph: RawElement, properties: RawElement | undefined): Splice {
    const mark = `<w:del ${revisionAttributes(this.#revision!)}/>`;
    if (!properties) return { start: paragraph.openEnd, end: paragraph.openEnd, text: `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>` };
    if (properties.closeStart === properties.openEnd && properties.end === properties.openEnd) {
      return { start: properties.start, end: properties.end, text: `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>` };
    }
    const runProperties = rawChild(properties, "w:rPr");
    if (runProperties) {
      if (runProperties.closeStart === runProperties.openEnd && runProperties.end === runProperties.openEnd) {
        return { start: runProperties.start, end: runProperties.end, text: `<w:rPr>${mark}</w:rPr>` };
      }
      // ins precedes del in a paragraph mark's properties.
      const inserted = rawChild(runProperties, "w:ins");
      const at = inserted ? inserted.end : runProperties.openEnd;
      return { start: at, end: at, text: mark };
    }
    // rPr precedes only sectPr and pPrChange in a paragraph's properties.
    const following = rawChildren(properties).find(child => child.name === "w:sectPr" || child.name === "w:pPrChange");
    const at = following ? following.start : properties.closeStart;
    return { start: at, end: at, text: `<w:rPr>${mark}</w:rPr>` };
  }
}

interface InsertionParts {
  readonly styles: StyleCatalog;
  readonly stylesPart: string | undefined;
  readonly numbering: NumberingAllocator;
  readonly numberingPart: string | undefined;
  readonly relationships: RelationshipsEditor;
  readonly relationshipsPart: string;
}

/** A piece split where ranges start and end. `whole` marks a piece left entirely intact. */
interface Segment {
  readonly text: string;
  readonly deleted: boolean;
  readonly whole: boolean;
  /** The range this segment completes, after which its replacement goes. */
  readonly endsRange: { start: number; end: number } | undefined;
}

function segments<Range extends { start: number; end: number }>(piece: Piece, ranges: readonly Range[]): Segment[] {
  const cuts = new Set([0, piece.text.length]);
  for (const range of ranges) {
    for (const offset of [range.start - piece.from, range.end - piece.from]) {
      if (offset > 0 && offset < piece.text.length) cuts.add(offset);
    }
  }
  const sorted = [...cuts].toSorted((a, b) => a - b);
  const out: Segment[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const from = piece.from + sorted[index]!;
    const to = piece.from + sorted[index + 1]!;
    const range = ranges.find(candidate => from >= candidate.start && to <= candidate.end);
    out.push({
      text: piece.text.slice(sorted[index]!, sorted[index + 1]!),
      deleted: range !== undefined,
      whole: sorted.length === 2,
      endsRange: range !== undefined && to === range.end ? range : undefined,
    });
  }
  return out;
}

