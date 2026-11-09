/**
 * How Simple Light, the theme Google gives every new presentation, styles the text of its layouts'
 * placeholders, which the recording of a new presentation (`blank-presentation.json`) leaves out:
 * its masks read placeholders by their geometry alone. So the approver's preview of a presentation
 * not yet created draws its text as Google will: Arial throughout, titles in the first dark theme
 * colour, other text in the second, and body text at 115% line spacing.
 */

import type { RestPageElement, RestParagraphStyle, RestTextStyle } from "./slides-api";

type PlaceholderStyle = {
  size: number;
  color: "DARK1" | "DARK2";
  alignment?: "TOP" | "MIDDLE" | "BOTTOM";
  paragraph?: RestParagraphStyle;
};

const TITLE: PlaceholderStyle = { size: 28, color: "DARK1", alignment: "TOP" };

const STYLES: Record<string, PlaceholderStyle> = {
  CENTERED_TITLE: { size: 52, color: "DARK1", alignment: "BOTTOM" },
  SUBTITLE: { size: 28, color: "DARK2", alignment: "TOP" },
  TITLE,
  BODY: { size: 18, color: "DARK2", alignment: "TOP", paragraph: { lineSpacing: 115 } },
  SLIDE_NUMBER: { size: 10, color: "DARK2", alignment: "MIDDLE", paragraph: { alignment: "END" } },
};

// A section header's title is larger, and sits at the middle of its box.
const SECTION_TITLE: PlaceholderStyle = { size: 36, color: "DARK1", alignment: "MIDDLE" };

/**
 * `element`, a placeholder of the layout `layoutName` of a new presentation, with the text style
 * and alignment Simple Light gives it, as an empty placeholder's one paragraph carries them.
 */
export function styledPlaceholder(element: RestPageElement, layoutName: string | undefined): RestPageElement {
  let type = element.shape?.placeholder?.type ?? "";
  let style = type === "TITLE" && layoutName === "Section header" ? SECTION_TITLE : STYLES[type];
  if (!style || !element.shape) return element;
  let text: RestTextStyle = {
    fontFamily: "Arial",
    fontSize: { magnitude: style.size, unit: "PT" },
    foregroundColor: { opaqueColor: { themeColor: style.color } },
  };
  return {
    ...element,
    shape: {
      ...element.shape,
      shapeProperties: {
        ...element.shape.shapeProperties,
        ...(style.alignment ? { contentAlignment: style.alignment } : {}),
      },
      text: {
        textElements: [
          { endIndex: 1, paragraphMarker: { style: { alignment: "START", ...style.paragraph } } },
          { endIndex: 1, textRun: { content: "\n", style: text } },
        ],
      },
    },
  };
}
