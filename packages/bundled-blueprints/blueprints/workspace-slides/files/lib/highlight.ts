// The colour of a title's highlighted words (`highlight`). The theme accent,
// unless that would be hard to read on the slide's background -- on the
// orange cover, accent orange on orange all but vanishes -- in which case the
// first of black or white that reads well (at least 3:1, the WCAG minimum for
// large text) and stands apart from the title's own colour. The browser
// renderer (client.ts) and the PowerPoint export (lib/pptx.ts) both colour
// highlights with highlightColorFor, so they always agree.

import type { SlideBackground } from "./protocol.ts";

/** The theme accent highlights use where it reads well (client `C.orange`). */
export const HIGHLIGHT_ACCENT = "#FF5F2E";
/** The least contrast a highlight keeps with the background behind it. */
const MIN_HIGHLIGHT_CONTRAST = 3;

// What a block on the slide sits on: the inset surface when it is on, else
// the cover artwork (its tone under the title, where it is darkest), else
// the slide's colour (client renderSlide / C).
const SURFACE = "#FFF9EF", PAGE = "#F5F1EB", COVER_TONE = "#FF6018";

/** The colour behind a slide's blocks, as far as legibility goes. */
export function slideBackdrop(background: SlideBackground | null | undefined): string {
  if (!background || background.inset !== false) return SURFACE;
  if (background.coverOrange) return COVER_TONE;
  return parseHex(background.color ?? "") ? String(background.color) : PAGE;
}

/** The colour a title's highlighted words get on this background, for a title drawn in `textColor`. */
export function highlightColorFor(background: SlideBackground | null | undefined, textColor: string): string {
  const backdrop = slideBackdrop(background);
  const text = parseHex(textColor);
  const candidates = [HIGHLIGHT_ACCENT, "#000000", "#FFFFFF"].filter((c) => !text || contrastRatio(c, textColor) >= 1.5);
  return candidates.find((c) => contrastRatio(c, backdrop) >= MIN_HIGHLIGHT_CONTRAST)
    ?? candidates.toSorted((a, b) => contrastRatio(b, backdrop) - contrastRatio(a, backdrop))[0]
    ?? HIGHLIGHT_ACCENT;
}

/** WCAG contrast ratio of two `#rgb` / `#rrggbb` colours (1 when either isn't one). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  if (la == null || lb == null) return 1;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
