import type { GooglePresentationReadSession } from "./slides-read-types";
export type * from "./slides-read-types";

/**
 * One text edit. The text is a shape's, a table cell's, or a slide's speaker notes, exactly as
 * `getSlides()` returns it.
 */
export type SlideTextEdit = {
  /** The slide the text is on. */
  slideId: string;
  /**
   * The shape or table holding the text, by `SlideElement.id`; a shape inside a group counts.
   * Omit to edit the slide's speaker notes.
   */
  elementId?: string;
  /** For a table, the cell to edit, zero-based as in `TableElement.cells`. */
  cell?: { row: number; column: number };
  /**
   * The text to replace, which must occur exactly once in the target's text: include surrounding
   * text to make it unique. Omit to replace all of the target's text.
   */
  find?: string;
  /** The new text. `\n` starts a paragraph, `\u000b` breaks a line within one. */
  replace: string;
};

/**
 * Read/write access to one directly bound Google Slides presentation.
 *
 * Changes are queued for the user's approval. `getPresentation()` and `getSlides()` show them as
 * if already applied; `getSlideThumbnail()` renders the presentation as saved. A queued change
 * that no longer applies, because the presentation was edited elsewhere, fails when approved, and
 * reads of what it changes report it in `queuedChangeConflict`.
 */
export interface GooglePresentationSession extends GooglePresentationReadSession {
  /**
   * Queue text edits, applied in order, together or not at all. Each replaces the one occurrence of
   * `find`, or all of the target's text. New text takes the style of the text it replaces, and
   * text an edit leaves unchanged at either end keeps its own, so `find` and `replace` may share
   * context. A slide number can be replaced whole, not in part. Throws, queuing nothing, when an
   * edit does not apply to the text `getSlides()` would now return.
   */
  editText(edits: SlideTextEdit[]): Promise<void>;

  /**
   * Queue copying a slide, with its speaker notes, to right after it. Returns the copy's slide ID.
   * Its elements get new IDs too: read the copy with `getSlides()` to edit it.
   */
  duplicateSlide(slideId: string): Promise<string>;

  /** Queue deleting a slide. */
  deleteSlide(slideId: string): Promise<void>;

  /**
   * Queue moving slides to follow the slide `after`, or to the start when `after` is null. They
   * keep their current order relative to each other, whatever order `slideIds` lists them in.
   */
  moveSlides(slideIds: string[], after: string | null): Promise<void>;
}
