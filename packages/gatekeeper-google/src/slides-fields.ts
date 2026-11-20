// The field masks of the Google Slides reads a presentation session makes. They live apart from the
// client so `scripts/record-blank-presentation.ts`, which runs under plain `node`, makes the very
// same reads of a new presentation as the session does of a real one.

// Replaying a queued change needs an AutoText's width, which only the indices give, and its type.
const TEXT_FIELDS =
  "text(textElements(startIndex,endIndex,textRun(content),autoText(type,content)))";
// A picture is read only by its size: its `contentUrl` is a bearer URL, good for 30 minutes to
// anyone holding it, which acts as the account that asked.
const BACKGROUND_FIELDS = "pageBackgroundFill(propertyState,solidFill,stretchedPictureFill(size))";
// Masters without their elements: their names, backgrounds and theme colours.
const MASTER_FIELDS =
  `masters(objectId,masterProperties(displayName),pageProperties(${BACKGROUND_FIELDS},colorScheme))`;
// A new slide's layout must share its master with the slide before it, or with the first master
// in a presentation that has no slides.
const LAYOUT_PROPERTIES =
  `objectId,layoutProperties(displayName,masterObjectId),pageProperties(${BACKGROUND_FIELDS})`;
/**
 * A presentation's slide summaries. They need titles and speaker notes, which a mask can only
 * reach as every shape's text. Styles and geometry, most of a deck's JSON, are left out: 65 KiB for
 * a live 16-slide deck, against 780 KiB with them.
 */
export const SUMMARY_FIELDS =
  `presentationId,title,locale,pageSize,${MASTER_FIELDS},` +
  `layouts(${LAYOUT_PROPERTIES},pageElements(shape(placeholder(type)))),` +
  `slides(objectId,pageProperties(${BACKGROUND_FIELDS}),` +
  `pageElements(objectId,shape(placeholder(type),${TEXT_FIELDS})),` +
  "slideProperties(layoutObjectId,masterObjectId,isSkipped," +
  `notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(${TEXT_FIELDS})))))`;
/**
 * A presentation's slide order, masters and layouts, but no slide content: masters and layouts
 * without their elements are about 7 KiB for a live deck of 11 layouts. Google returns `revisionId`
 * only to an account that can edit the presentation. A skip applies against this alone.
 */
export const OUTLINE_FIELDS =
  `presentationId,title,revisionId,${MASTER_FIELDS},layouts(${LAYOUT_PROPERTIES}),` +
  "slides(objectId,slideProperties(layoutObjectId,masterObjectId,isSkipped))";
/** What a new slide takes from its layout: each placeholder's type, index, shape and geometry. */
export const LAYOUT_PAGE_FIELDS =
  "objectId,pageElements(objectId,size,transform,shape(shapeType,placeholder(type,index)))";
/** One slide's full content and speaker notes. */
export const SLIDE_FIELDS =
  `objectId,pageProperties(${BACKGROUND_FIELDS}),pageElements,` +
  "slideProperties(layoutObjectId,masterObjectId,isSkipped,notesPage(notesProperties,pageElements))";
/**
 * A slide as it is drawn: as SLIDE_FIELDS, with the bearer URL of a picture background, which is
 * read only to download the picture (see `slides-media.ts`).
 */
export const DRAWN_SLIDE_FIELDS = SLIDE_FIELDS.replace(BACKGROUND_FIELDS, "pageBackgroundFill");
/**
 * What a slide is drawn over: the page size, and every master and layout whole. A placeholder
 * takes its place, fill and text styles from its layout's, and that from its master's, and a slide
 * shows its layout's and master's other elements behind its own.
 */
export const THEME_FIELDS =
  "presentationId,pageSize,masters(objectId,pageProperties(pageBackgroundFill),pageElements)," +
  "layouts(objectId,pageProperties(pageBackgroundFill),pageElements)";
// The styles that say which font text is drawn in.
const FONT_STYLE = "bold,italic,fontFamily,weightedFontFamily";
const FONT_TEXT =
  `text(textElements(textRun(style(${FONT_STYLE})),autoText(style(${FONT_STYLE})),` +
  `paragraphMarker(bullet(bulletStyle(${FONT_STYLE})))),lists)`;
const FONT_SHAPES = `shape(${FONT_TEXT}),table(tableRows(tableCells(${FONT_TEXT})))`;
// A mask names each depth it reaches, so text grouped more than three deep is not read.
const FONT_ELEMENTS = `pageElements(${FONT_SHAPES},elementGroup(children(${FONT_SHAPES},` +
  `elementGroup(children(${FONT_SHAPES},elementGroup(children(${FONT_SHAPES})))))))`;
/** Every text style's font across the presentation, and nothing of what the text says. */
export const FONT_FIELDS =
  `presentationId,title,masters(${FONT_ELEMENTS}),layouts(${FONT_ELEMENTS}),slides(${FONT_ELEMENTS})`;
