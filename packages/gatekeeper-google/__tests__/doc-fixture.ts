import type {
  GoogleDocsTab, ParagraphElement, StructuralElement, TextStyle,
} from "../src/docs-api";

/** A styled span of text within a paragraph. */
export type Run = { text: string; style?: TextStyle };

type ParagraphSpec = {
  runs: (Run | string)[];
  namedStyleType?: string;
  bullet?: { listId: string; nestingLevel: number };
};

/**
 * Builds a normalized `GoogleDocsTab` with the index bookkeeping the real API applies: a section
 * break occupies index 0, and every paragraph's runs are laid out contiguously from index 1.
 *
 * Every paragraph's last run must end in "\n", as Google's own responses do.
 */
export function buildTab(
  paragraphs: ParagraphSpec[],
  lists: GoogleDocsTab["lists"] = {},
): GoogleDocsTab {
  let index = 1;
  let content: StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];

  for (let spec of paragraphs) {
    let start = index;
    let elements: ParagraphElement[] = spec.runs.map(run => {
      let { text, style } = typeof run === "string" ? { text: run, style: undefined } : run;
      let runStart = index;
      index += text.length;
      return {
        startIndex: runStart,
        endIndex: index,
        textRun: { content: text, textStyle: style ?? {} },
      };
    });
    content.push({
      startIndex: start,
      endIndex: index,
      paragraph: {
        elements,
        paragraphStyle: { namedStyleType: spec.namedStyleType ?? "NORMAL_TEXT" },
        bullet: spec.bullet,
      },
    });
  }

  return {
    tabId: "tab-1",
    title: "Fixture",
    index: 0,
    nestingLevel: 0,
    body: { content },
    lists,
    namedRanges: {},
  };
}

/** A single-level bullet list definition, for paragraphs carrying a matching `bullet`. */
export const BULLET_LIST: GoogleDocsTab["lists"] = {
  L1: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } },
};
