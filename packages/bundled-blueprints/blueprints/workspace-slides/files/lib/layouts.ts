// The slide layouts: the on-brand templates a new slide starts from. The editor's "New slide"
// menu (client.ts) and an agent's `addSlide(atIndex, { layout })` (server.ts) both build slides
// from these, and a new deck's cover is the title layout, so every path makes the same slide.
// The templates leave the logo out: the deck logo (Slide settings, or setLogo) puts the owner's
// logo on every slide, and the `logo` block puts one on a single slide. Blocks carry no ids; the
// server mints them.

import type { BlockInput, SlideBackground, SlideLayout } from "./protocol.ts";

/** A slide as a template makes it: its background and its blocks, without ids. */
export interface SlideTemplate {
  background: SlideBackground;
  blocks: BlockInput[];
}

/** The content slides' brand bar: a 1200 × 12 gradient, drawn as an `svg` block at y 663. */
export const BOTTOM_BAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="brandbar"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#brandbar)"/></svg>`;

function makeTitleSlide(): SlideTemplate {
  return {
    background: { color: "#F6821F", inset: false, coverOrange: true },
    blocks: [
      {
        type: "title",
        x: 33,
        y: 245,
        w: 760,
        props: {
          text: "[TITLE]",
          fontSize: 58,
          weight: 700,
          color: "#FFFFFF",
          letterSpacing: "-0.03em",
          lineHeight: 1.1,
          highlight: ""
        }
      }
    ]
  };
}
function makeContentSlide(): SlideTemplate {
  return {
    background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
    blocks: [
      { type: "sectionLabel", x: 36, y: 35, props: { text: "SECTION" } },
      {
        type: "title",
        x: 35,
        y: 76,
        w: 984,
        props: {
          text: "Write the headline as a specific assertion",
          fontSize: 28,
          weight: 600,
          color: "#000000",
          letterSpacing: "-0.03em",
          lineHeight: 1.2,
          highlight: ""
        }
      },
      {
        type: "text",
        x: 36,
        y: 204,
        w: 760,
        props: {
          text: "Replace this with one or two short paragraphs of supporting evidence. Keep body copy to roughly 40–60 words and leave generous white space on the right.",
          fontSize: 19,
          weight: "400",
          color: "#000000",
          family: "sans",
          align: "left",
          lineHeight: 1.6
        }
      },
      {
        type: "svg",
        x: 0,
        y: 663,
        w: 1200,
        h: 12,
        props: { markup: BOTTOM_BAR_SVG, fit: "stretch", background: "" }
      }
    ]
  };
}
function makeTwoColumnSlide(): SlideTemplate {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter((b) => b.type !== "text");
  for (const x of [36, 609]) {
    slide.blocks.splice(
      -1,
      0,
      {
        type: "text",
        x,
        y: 204,
        w: 553,
        props: {
          text: "Column heading",
          fontSize: 18,
          weight: 600,
          color: "#000000",
          family: "sans",
          align: "left",
          lineHeight: 1.3
        }
      },
      {
        type: "text",
        x,
        y: 252,
        w: 553,
        props: {
          text: "Add concise supporting copy. Keep both columns parallel in structure and similar in length.",
          fontSize: 19,
          weight: 400,
          color: "#000000",
          family: "sans",
          align: "left",
          lineHeight: 1.6
        }
      }
    );
  }
  return slide;
}
function makeFourColumnSlide(): SlideTemplate {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter((b) => b.type !== "text");
  [34, 328, 622, 916].forEach((x, i) => {
    slide.blocks.splice(
      -1,
      0,
      {
        type: "text",
        x,
        y: 194,
        w: 40,
        props: {
          text: String(i + 1).padStart(2, "0"),
          fontSize: 14,
          weight: 600,
          color: "#FF6633",
          family: "sans",
          align: "left",
          lineHeight: 1.2
        }
      },
      {
        type: "text",
        x,
        y: 228,
        w: 260,
        props: {
          text: "Column heading",
          fontSize: 16,
          weight: 600,
          color: "#000000",
          family: "sans",
          align: "left",
          lineHeight: 1.3
        }
      },
      {
        type: "text",
        x,
        y: 272,
        w: 260,
        props: {
          text: "Use compact supporting copy with one clear idea per column.",
          fontSize: 15,
          weight: 400,
          color: "#747474",
          family: "sans",
          align: "left",
          lineHeight: 1.5
        }
      }
    );
  });
  return slide;
}

/** Each layout's template, by the id `addSlide` takes. Each call builds a fresh copy. */
export const SLIDE_LAYOUTS: Record<SlideLayout, () => SlideTemplate> = {
  title: makeTitleSlide,
  content: makeContentSlide,
  twoColumn: makeTwoColumnSlide,
  fourColumn: makeFourColumnSlide,
};

/** The layout ids, in the order the editor offers them. */
export const SLIDE_LAYOUT_IDS = Object.keys(SLIDE_LAYOUTS) as SlideLayout[];

/** Whether `v` names a layout. */
export function isSlideLayout(v: unknown): v is SlideLayout {
  return typeof v === "string" && Object.hasOwn(SLIDE_LAYOUTS, v);
}
