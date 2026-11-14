// Colors, font names and images in a preview come from the provider's file, so each is applied
// only when it is plainly a value of its kind: nothing from the file may name a URL to load.

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:%|deg)?`
const FUNCTIONAL = new RegExp(
  String.raw`^(?:rgba?|hsla?)\(\s*${NUMBER}(?:\s*[,\s]\s*${NUMBER}){2}(?:\s*[,/]\s*${NUMBER})?\s*\)$`,
  'i',
)
const NAMED = /^[a-z]{3,20}$/i

/** `value` when it is a hex, rgb()/hsl() or named CSS color, else undefined. */
export function safeCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined
  const color = value.trim()
  if (HEX.test(color) || FUNCTIONAL.test(color)) return color
  if (!NAMED.test(color)) return undefined
  // A bare word can only be a keyword; where the browser can say whether it names a color, ask.
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', color) ? color : undefined
  }
  return color
}

/** A font stack led by the file's font, when its name is plain, falling back to `fallback`. */
export function fontStack(name: string | undefined, fallback: string): string {
  if (!name || !/^[\w -]{1,60}$/.test(name)) return fallback
  return `"${name}", ${fallback}`
}

const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)(?:;[\w=.+-]+)*,/i

/** `url` when it is an inline `data:image/` URL of a common image type, else undefined. */
export function safeImageDataUrl(url: string | undefined): string | undefined {
  return url && IMAGE_DATA_URL.test(url) ? url : undefined
}
