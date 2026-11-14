/**
 * Builders for `presentations.get` responses in the shape Google returns them.
 *
 * `text()` lays runs out the way Slides does: each paragraph is a `paragraphMarker` spanning the
 * paragraph followed by its runs, offsets count UTF-16 code units, `startIndex` is omitted when it
 * is 0, and the last paragraph ends with the newline a shape always keeps. An AutoText occupies
 * exactly one index whatever it renders, as a live deck shows: slide number "11" spans [0, 1).
 * `slides-live-sample.json` is a recorded response (styles stripped) that pins these facts.
 *
 * A slide or layout that sets no background reads `INHERIT`; a master's background is resolved,
 * with `RENDERED`, the default, omitted. A colour scheme lists the 12 theme colours as bare
 * `RgbColor`s, then `TEXT1`, `BACKGROUND1`, `TEXT2` and `BACKGROUND2` repeating `DARK1`, `LIGHT1`,
 * `LIGHT2` and `DARK2`, as `slides-live-theme.json` shows.
 */

import type {
  RestPageBackgroundFill, RestPageElement, RestPageProperties, RestPresentation, RestText,
  RestTextElement, RestTextStyle,
} from "../src/slides-api";
import type { ThemeColorName } from "../src/slides-read-types";

/** A run of text, a styled run, or the slide-number AutoText with the content it renders. */
export type FixtureRun = string | { slideNumber: string } | { content: string; style: RestTextStyle };

/** A paragraph: its runs, or its runs and what its marker carries. */
export type FixtureParagraph =
  FixtureRun[] | { runs: FixtureRun[]; marker: NonNullable<RestTextElement["paragraphMarker"]> };

/** `TextContent` for paragraphs of runs, each paragraph ending in the newline Slides stores. */
export function text(...paragraphs: FixtureParagraph[]): RestText {
  let elements: RestTextElement[] = [];
  let index = 0;
  let at = (start: number, length: number) =>
    ({ ...(start === 0 ? {} : { startIndex: start }), endIndex: start + length });
  for (let paragraph of paragraphs) {
    let { runs: content, marker } = Array.isArray(paragraph) ? { runs: paragraph, marker: {} } : paragraph;
    let runs = [...content, "\n"].map(run => {
      if (typeof run === "string") return { element: { textRun: { content: run } }, width: run.length };
      if ("content" in run) return { element: { textRun: run }, width: run.content.length };
      return { element: { autoText: { type: "SLIDE_NUMBER", content: run.slideNumber } }, width: 1 };
    });
    let length = runs.reduce((sum, run) => sum + run.width, 0);
    elements.push({ ...at(index, length), paragraphMarker: marker });
    for (let { element, width } of runs) {
      elements.push({ ...element, ...at(index, width) });
      index += width;
    }
  }
  return { textElements: elements };
}

/** A shape element. */
export function shape(
  objectId: string, body?: RestText, options: { placeholder?: string; shapeType?: string } = {},
): RestPageElement {
  return {
    objectId,
    shape: {
      shapeType: options.shapeType ?? "TEXT_BOX",
      ...(options.placeholder ? { placeholder: { type: options.placeholder } } : {}),
      ...(body ? { text: body } : {}),
    },
  };
}

/** A slide page with optional speaker notes; `notes: null` omits the notes shape entirely. */
export function slide(
  objectId: string,
  pageElements: RestPageElement[],
  options: {
    layoutObjectId?: string; masterObjectId?: string; background?: RestPageBackgroundFill;
    notes?: RestText | null; isSkipped?: boolean;
  } = {},
): NonNullable<RestPresentation["slides"]>[number] {
  let notesId = `${objectId}-notes`;
  return {
    objectId,
    pageProperties: { pageBackgroundFill: options.background ?? { propertyState: "INHERIT" } },
    pageElements,
    slideProperties: {
      layoutObjectId: options.layoutObjectId ?? "layout-title-body",
      masterObjectId: options.masterObjectId ?? "master-1",
      ...(options.isSkipped ? { isSkipped: true } : {}),
      notesPage: {
        notesProperties: { speakerNotesObjectId: notesId },
        pageElements: options.notes === null ? [] : [
          shape(`${objectId}-notes-slide-image`, undefined, { shapeType: "RECTANGLE" }),
          shape(notesId, options.notes, { placeholder: "BODY" }),
        ],
      },
    },
  };
}

/** The colours of Google's Simple Light theme. */
export const SIMPLE_LIGHT: Record<ThemeColorName, string> = {
  DARK1: "#000000", LIGHT1: "#ffffff", DARK2: "#595959", LIGHT2: "#eeeeee",
  ACCENT1: "#4285f4", ACCENT2: "#212121", ACCENT3: "#78909c", ACCENT4: "#ffab40",
  ACCENT5: "#0097a7", ACCENT6: "#eeff41", HYPERLINK: "#0097a7", FOLLOWED_HYPERLINK: "#0097a7",
};

// Google omits a zero component, so black is `{}`.
function rgb(hex: string): { red?: number; green?: number; blue?: number } {
  let [red, green, blue] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
  return { ...(red ? { red } : {}), ...(green ? { green } : {}), ...(blue ? { blue } : {}) };
}

/** A master's colour scheme: the 12 colours in Google's order, then the four that repeat them. */
export function colorScheme(
  colors: Record<ThemeColorName, string> = SIMPLE_LIGHT,
): NonNullable<RestPageProperties["colorScheme"]> {
  let aliases = {
    TEXT1: colors.DARK1, BACKGROUND1: colors.LIGHT1, TEXT2: colors.LIGHT2, BACKGROUND2: colors.DARK2,
  };
  return {
    colors: Object.entries({ ...colors, ...aliases }).map(([type, hex]) => ({ type, color: rgb(hex) })),
  };
}

/** A master page, its background the theme's `LIGHT1` unless another is given. */
export function master(
  objectId: string,
  options: {
    name?: string; background?: RestPageBackgroundFill; colors?: Record<ThemeColorName, string>;
  } = {},
): NonNullable<RestPresentation["masters"]>[number] {
  return {
    objectId,
    masterProperties: { displayName: options.name ?? "Simple Light" },
    pageProperties: {
      pageBackgroundFill:
        options.background ?? { solidFill: { color: { themeColor: "LIGHT1" }, alpha: 1 } },
      colorScheme: colorScheme(options.colors),
    },
  };
}

/** A layout page, made from `master-1` unless another master is given. */
export function layout(
  objectId: string,
  displayName: string,
  options: {
    masterObjectId?: string; background?: RestPageBackgroundFill; pageElements?: RestPageElement[];
  } = {},
): NonNullable<RestPresentation["layouts"]>[number] {
  return {
    objectId,
    layoutProperties: { displayName, masterObjectId: options.masterObjectId ?? "master-1" },
    pageProperties: { pageBackgroundFill: options.background ?? { propertyState: "INHERIT" } },
    ...(options.pageElements ? { pageElements: options.pageElements } : {}),
  };
}

/** A presentation of the given slides, 10in x 5.625in like Google's default 16:9 deck. */
export function presentation(slides: NonNullable<RestPresentation["slides"]>): RestPresentation {
  return {
    presentationId: "deck-1",
    title: "Quarterly review",
    locale: "en",
    pageSize: {
      width: { magnitude: 9_144_000, unit: "EMU" },
      height: { magnitude: 5_143_500, unit: "EMU" },
    },
    masters: [master("master-1")],
    // Through the summary mask, a layout's elements carry only their placeholder.
    layouts: [
      layout("layout-title", "Title slide", { pageElements: [
        { shape: { placeholder: { type: "CENTERED_TITLE" } } },
        { shape: { placeholder: { type: "SUBTITLE" } } },
      ] }),
      layout("layout-title-body", "Title and body", { pageElements: [
        { shape: {} },
        { shape: { placeholder: { type: "TITLE" } } },
        { shape: { placeholder: { type: "BODY" } } },
        { shape: { placeholder: { type: "BODY" } } },
      ] }),
    ],
    slides,
  };
}
