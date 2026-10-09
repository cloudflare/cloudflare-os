// The field masks of the Google Slides reads a presentation session makes. They live apart from the
// client so `scripts/record-blank-presentation.ts`, which runs under plain `node`, makes the very
// same reads of a new presentation as the session does of a real one.

// Replaying a queued change needs an AutoText's width, which only the indices give, and its type.
const TEXT_FIELDS =
  "text(textElements(startIndex,endIndex,textRun(content),autoText(type,content)))";
// A new slide's layout must share its master with the slide before it, or with the first master
// in a presentation that has no slides.
const LAYOUT_PROPERTIES = "objectId,layoutProperties(displayName,masterObjectId)";
/**
 * A presentation's slide summaries. They need titles and speaker notes, which a mask can only
 * reach as every shape's text. Styles and geometry, most of a deck's JSON, are left out: 65 KiB for
 * a live 16-slide deck, against 780 KiB with them.
 */
export const SUMMARY_FIELDS =
  "presentationId,title,locale,pageSize,masters(objectId)," +
  `layouts(${LAYOUT_PROPERTIES},pageElements(shape(placeholder(type)))),` +
  `slides(objectId,pageElements(objectId,shape(placeholder(type),${TEXT_FIELDS})),` +
  "slideProperties(layoutObjectId,masterObjectId,isSkipped," +
  `notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(${TEXT_FIELDS})))))`;
/**
 * A presentation's slide order, masters and layouts, but no slide content. Google returns
 * `revisionId` only to an account that can edit the presentation. A skip applies against this alone.
 */
export const OUTLINE_FIELDS =
  `presentationId,title,revisionId,masters(objectId),layouts(${LAYOUT_PROPERTIES}),` +
  "slides(objectId,slideProperties(masterObjectId,isSkipped))";
/** What a new slide takes from its layout: each placeholder's type, index, shape and geometry. */
export const LAYOUT_PAGE_FIELDS =
  "objectId,pageElements(objectId,size,transform,shape(shapeType,placeholder(type,index)))";
/** One slide's full content and speaker notes. */
export const SLIDE_FIELDS =
  "objectId,pageElements," +
  "slideProperties(layoutObjectId,masterObjectId,isSkipped,notesPage(notesProperties,pageElements))";
