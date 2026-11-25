/** A logo drawn in one tone that a surface of the same tone would lose: all dark, or all light. */
export type LogoTone = 'dark' | 'light'

// Under this, of 1, everything drawn is dark: GitHub's near-black, a black wordmark.
const DARK_BELOW = 0.25
// Over this, everything drawn is light: a mark drawn in white for a coloured tile.
const LIGHT_ABOVE = 0.85
// Fainter than this a pixel is an edge being smoothed, or nothing, and says nothing of the tone.
const DRAWN_FROM = 128

/**
 * The tone of a logo, from its pixels (RGBA, a byte each, as a canvas gives them): dark where
 * everything it draws is, light where everything is, and neither for one with colour or contrast
 * of its own, which reads on any surface.
 */
export const logoTone = (pixels: ArrayLike<number>): LogoTone | undefined => {
  let darkest = 1
  let lightest = 0
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if (pixels[at + 3]! < DRAWN_FROM) continue
    const light = (0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!) / 255
    darkest = Math.min(darkest, light)
    lightest = Math.max(lightest, light)
  }
  // Nothing drawn.
  if (lightest < darkest) return undefined
  if (lightest < DARK_BELOW) return 'dark'
  return darkest > LIGHT_ABOVE ? 'light' : undefined
}

// Small enough to read at once, and enough to tell a tone by.
const SAMPLE = 24

// What each logo was found to be, by its address, so that it is drawn right from the first the next time.
const known = new Map<string, LogoTone | undefined>()

/** The tone a logo was found to have, if it has been drawn before. */
export const knownLogoTone = (src: string) => known.get(src)

/**
 * The tone of a logo that has loaded from `src`, read from how it draws, and kept for the next
 * time. None for one from elsewhere that the browser will not let be read, which is left as it is.
 */
export const readLogoTone = (image: HTMLImageElement, src: string): LogoTone | undefined => {
  if (known.has(src)) return known.get(src)
  let tone: LogoTone | undefined
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE
    canvas.height = SAMPLE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context?.drawImage(image, 0, 0, SAMPLE, SAMPLE)
    tone = context ? logoTone(context.getImageData(0, 0, SAMPLE, SAMPLE).data) : undefined
  } catch {
    tone = undefined
  }
  known.set(src, tone)
  return tone
}
