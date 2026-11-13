// Symbol and Wingdings text as Unicode, for Word list markers and runs and PowerPoint bullets.

import { lookupTable } from "./lookup-table";

/** Glyphs of the Symbol and Wingdings fonts that bullets use, by their code in the font. */
const SYMBOL_GLYPHS = lookupTable<Readonly<Record<number, string>>>({
  symbol: { 0xb7: "•", 0xa8: "♦", 0xde: "⇒", 0xae: "→" },
  wingdings: { 0xa7: "▪", 0xa8: "◻", 0x6e: "■", 0x6f: "□", 0x71: "❑", 0x76: "❖", 0x9f: "•", 0xd8: "➢", 0xfc: "✔", 0xe0: "→" },
});

/**
 * Text set in a symbol font, as the Unicode characters that look the same. Such fonts put their
 * glyphs at private-use code points (U+F0xx) that no fallback font can draw, so a bullet would
 * otherwise show as an empty box. Returns undefined for text that needs no translation.
 */
export function symbolText(text: string, font: string | undefined): string | undefined {
  const glyphs = SYMBOL_GLYPHS[font?.toLowerCase() ?? ""];
  const privateUse = /[\uf000-\uf0ff]/.test(text);
  if (!glyphs && !privateUse) return undefined;
  return Array.from(text, char => {
    const code = char.charCodeAt(0);
    if (code >= 0xf000 && code <= 0xf0ff) return (glyphs ?? SYMBOL_GLYPHS.symbol!)[code & 0xff] ?? "•";
    return glyphs?.[code] ?? char;
  }).join("");
}
