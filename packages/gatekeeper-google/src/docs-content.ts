// What Google Docs does with single characters, with chips and with the lists of a bullet
// preset, as the Markdown rendering, the request builders and the model of
// `documents.batchUpdate` need it, and what makes a footnote's number a number.

import type {
  DocList, NestingLevel, Paragraph, ParagraphElement, StructuralElement, TextRun,
} from "./docs-api";

/** Whether Google Docs strips UTF-16 code unit `code` from text it inserts. */
export function isGoogleDocsStrippedCharacter(code: number): boolean {
  return code <= 0x08 || code >= 0x0c && code <= 0x1f ||
    code >= 0xe000 && code <= 0xf8ff;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whether `offset` of `text` lies between two grapheme clusters, or at either end. Google Docs
 * does not insert text inside a cluster (such as between a letter and its combining accent):
 * it refuses the insertion or moves it to the cluster's end.
 */
export function atGraphemeBoundary(text: string, offset: number): boolean {
  return offset <= 0 || offset >= text.length ||
    GRAPHEMES.segment(text).containing(offset)?.index === offset;
}

/**
 * Whether deleting what lies between the first `prefix` and the last `suffix` UTF-16 code units
 * of `text` leaves a grapheme cluster across the place it was deleted from, as two regional
 * indicators pair up as a flag once the character between them goes.
 */
export function joinsGraphemes(text: string, prefix: number, suffix: number): boolean {
  return prefix > 0 && suffix > 0 && prefix + suffix < text.length &&
    !atGraphemeBoundary(text.slice(0, prefix) + text.slice(text.length - suffix), prefix);
}

/** Whether a suggestion inserts, deletes or restyles the text of `run`. */
export function holdsSuggestion(run: TextRun): boolean {
  return !!run.suggestedInsertionIds?.length || !!run.suggestedDeletionIds?.length ||
    Object.keys(run.suggestedTextStyleChanges ?? {}).length > 0;
}

/** Whether a suggestion changes the style or the bullet of `paragraph`. */
export function holdsOwnSuggestion(paragraph: Paragraph): boolean {
  return Object.keys(paragraph.suggestedParagraphStyleChanges ?? {}).length > 0 ||
    Object.keys(paragraph.suggestedBulletChanges ?? {}).length > 0;
}

/** The character a text run holds in place of embedded content, such as a building block's chip. */
export const CHIP_PLACEHOLDER = "\uE907";

/** Whether Google Docs copies a chip into a new row as the placeholder character. */
function isCopiedAsPlaceholder(element: ParagraphElement): boolean {
  return !!(element.person || element.dateElement || element.richLink);
}

/**
 * What a cell is to a row added beside it, by the chips it holds. `undefined` for a cell that
 * is not one paragraph of chips and no text: a chip is any element that is neither text nor an
 * inline image, or the placeholder U+E907 in a text run, and white space does not count as
 * text. For such a cell, what Google Docs is seen copying into the new row's cell: `"dropdown"`
 * for a dropdown alone; `"placeholder"` for a placeholder alone, or for one person chip, date
 * chip or rich link, also with spaces after it, which are not copied; `"nothing"` for two or
 * more of those chips; and `"unseen"` for chips in a shape nobody has seen copied.
 */
export function loneChipCopy(
  elements: readonly StructuralElement[],
): "dropdown" | "placeholder" | "nothing" | "unseen" | undefined {
  let parts = elements.length === 1 ? elements[0].paragraph?.elements : undefined;
  if (!parts) return undefined;
  let text = parts.map(part => part.textRun?.content ?? "").join("");
  let others = parts.filter(part => !part.textRun);
  let chip = others.some(part => !part.inlineObjectElement) || text.includes(CHIP_PLACEHOLDER);
  if (!chip || /\S/.test(text.replaceAll(CHIP_PLACEHOLDER, ""))) return undefined;
  if (others.length === 0) return text === `${CHIP_PLACEHOLDER}\n` ? "placeholder" : "unseen";
  if (others.length > 1) {
    return text === "\n" && others.every(isCopiedAsPlaceholder) ? "nothing" : "unseen";
  }
  let [only] = others;
  if (only.dropdown) return text === "\n" ? "dropdown" : "unseen";
  return isCopiedAsPlaceholder(only) && parts[0] === only && /^ *\n$/.test(text)
    ? "placeholder" : "unseen";
}

/** How many nesting levels a list in Google Docs has. */
export const LIST_LEVELS = 9;

/** The nine levels of the list each preset the gatekeeper sends makes, as Google shows them. */
export const BULLET_PRESETS: Record<string, readonly NestingLevel[]> = {
  BULLET_DISC_CIRCLE_SQUARE: Array.from({ length: LIST_LEVELS }, (_, level) => (
    { glyphSymbol: ["●", "○", "■"][level % 3], startNumber: 1 })),
  NUMBERED_DECIMAL_ALPHA_ROMAN: Array.from({ length: LIST_LEVELS }, (_, level) => (
    { glyphType: ["DECIMAL", "ALPHA", "ROMAN"][level % 3], startNumber: 1 })),
};

/**
 * Whether `list` counts as made by a preset of the levels `preset`: it has at least one level
 * and every level it has shows the glyph the preset gives that level. `createParagraphBullets`
 * puts a paragraph into the list of the item directly before it only when that list was made
 * by the request's preset. That is on record for lists the two presets made; that a list made
 * in the Docs editor is told from them by its glyphs is inferred, and the request builders and
 * the model both rest on this one reading of it.
 */
export function madeByPreset(list: DocList | undefined, preset: readonly NestingLevel[]): boolean {
  let levels = list?.listProperties?.nestingLevels ?? [];
  return levels.length > 0 && levels.every((level, index) => {
    let made = preset[index];
    if (!made) return false;
    if (made.glyphSymbol === undefined) return level.glyphType === made.glyphType;
    return level.glyphSymbol === made.glyphSymbol &&
      (level.glyphType === undefined || level.glyphType === "GLYPH_TYPE_UNSPECIFIED");
  });
}

/**
 * The whole number a footnote reference's number states, or `undefined` where its text is
 * anything else: no text, or not the decimal form of a whole number of at most nine digits
 * (a minus sign and no other, no leading zero, no space; `/^(?:0|-?[1-9]\d{0,8})$/`). THE ONE
 * DEFINITION OF A NUMBERED FOOTNOTE: the stored form of a run keeps such a number counted
 * from the references before the run (`cutRuns`), and the renderer keys a run that holds one
 * by that count (`RunSummary.numberedFootnotes`, the key's `f`). Nine digits keep the number,
 * and its sum with any count of references, exact.
 */
export function wholeFootnoteNumber(text: string | undefined): number | undefined {
  return text !== undefined && /^(?:0|-?[1-9]\d{0,8})$/.test(text) ? Number(text) : undefined;
}
