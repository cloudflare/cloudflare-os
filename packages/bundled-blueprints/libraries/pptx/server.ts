/**
 * The PPTX library's server entry (`@gadgets/bundled-blueprints/libraries/pptx/server`): a
 * dependency-free PresentationML renderer for block-based slide decks.
 */

export { deckToPptx, LOGO_DEFAULT_TEXT, MAX_TOTAL_TEXT_LENGTH, measureText } from "./src/pptx.ts";
export type { PptxBlockAdapter } from "./src/pptx.ts";
