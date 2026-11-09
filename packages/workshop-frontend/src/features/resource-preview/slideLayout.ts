import type { CSSProperties } from 'react'
import type { SlideElement, SlideParagraph, SlideStroke } from '@gadgets/workshop-shared/gatekeeper'
import { fonts } from './googleTheme'
import { fontStack } from './safeStyle'

/** Pixels per point when a slide `slideWidth` points wide is drawn `renderWidth` pixels wide. */
export const slideScale = (renderWidth: number, slideWidth: number) =>
  slideWidth > 0 && Number.isFinite(slideWidth) && renderWidth > 0 ? renderWidth / slideWidth : 0

/** The largest size, in pixels, a slide fits in a `box` while keeping its aspect ratio. */
export function fitSlide(box: { width: number; height: number }, slide: { width: number; height: number }) {
  if (!(slide.width > 0 && slide.height > 0)) return { width: 0, height: 0 }
  const width = Math.max(0, Math.min(box.width, box.height * (slide.width / slide.height)))
  return { width, height: width * (slide.height / slide.width) }
}

const finite = (value: number | undefined, fallback = 0) =>
  value !== undefined && Number.isFinite(value) ? value : fallback

/** Where an element sits, in pixels from the slide's top left corner, at `scale`. */
export function elementBox(element: SlideElement, scale: number): CSSProperties {
  const rotation = finite(element.rotation)
  return {
    position: 'absolute',
    left: finite(element.x) * scale,
    top: finite(element.y) * scale,
    width: Math.max(0, finite(element.width)) * scale,
    height: Math.max(0, finite(element.height)) * scale,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: 'center',
  }
}

/** Slides' default text size, in points. */
export const DEFAULT_FONT_SIZE = 14
/** How far Slides insets text from its box, in points (0.1in). */
export const TEXT_INSET = 7.2
/** How far Slides insets a table cell's text, in points: 0.1in at the sides, 0.05in above and below. */
export const CELL_INSET = { x: 7.2, y: 3.6 }
/** Where a list item's text starts when its paragraph sets no indent, in points (0.25in). */
export const LEVEL_INDENT = 18
/** How much smaller Slides draws superscript and subscript text. */
export const BASELINE_SCALE = 2 / 3

/**
 * Single line spacing in Slides, as a multiple of the text's size: 1.2 whatever the font, as
 * measured against Slides' own renders of Oswald, Playfair Display, Roboto and Lato, whose metrics
 * tables range from 1.17 to 1.48. Lines are spaced this far apart even while a fallback font draws
 * the glyphs.
 */
export const SINGLE_LINE_HEIGHT = 1.2

const SERIF = /serif|georgia|times|garamond|merriweather|playfair|lora|baskerville|caslon|cormorant|crimson|bodoni|slab|alegreya|spectral/i
const MONOSPACE = /mono|courier|consol|code/i

/**
 * The font stack a slide's font is drawn with: the font itself -- installed, or loaded from Google
 * Fonts (see useWebFonts) -- then a system font of its kind while it loads or if it can't.
 */
export function slideFontStack(fontFamily: string | undefined): string {
  if (!fontFamily) return fonts.document
  const fallback = MONOSPACE.test(fontFamily) ? fonts.monospace : SERIF.test(fontFamily) && !/sans/i.test(fontFamily) ? fonts.serif : fonts.document
  return fontStack(fontFamily, fallback)
}

// Dash patterns as multiples of the line's weight, as PowerPoint's presets that Slides' match.
const DASHES: Record<NonNullable<SlideStroke['dash']>, number[]> = {
  dot: [1, 1], dash: [4, 3], dashDot: [4, 3, 1, 3], longDash: [8, 3], longDashDot: [8, 3, 1, 3],
}

/** An SVG `stroke-dasharray` for `dash` drawn `weight` pixels wide. */
export const dashArray = (dash: SlideStroke['dash'], weight: number) =>
  dash ? DASHES[dash].map(length => length * weight).join(' ') : undefined

/** A stroke's width in pixels at `scale`, never so thin that it vanishes. */
export const strokePixels = (stroke: SlideStroke, scale: number) => Math.max(0.5, finite(stroke.weight, 0.75) * scale)

/** A font size in points, drawn at `scale`. */
export const fontPixels = (points: number | undefined, scale: number) =>
  Math.max(0, finite(points, DEFAULT_FONT_SIZE)) * scale

export const paragraphAlign = (align: SlideParagraph['align']): CSSProperties['textAlign'] =>
  align === 'center' ? 'center' : align === 'end' ? 'right' : align === 'justified' ? 'justify' : 'left'

/** All the text of an element, for naming it. */
export const elementText = (element: SlideElement) =>
  [...(element.text ?? []), ...(element.table?.cells ?? []).flat().flatMap(cell => cell?.text ?? [])]
    .map(paragraph => paragraph.runs.map(run => run.text).join(''))
    .join(' ')
    .trim()
