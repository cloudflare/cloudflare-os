import { useEffect } from 'react'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'

// Fonts every viewer has, or that Google Fonts doesn't serve; asking for them would only fail.
const SYSTEM_FONTS = new Set([
  'arial', 'helvetica', 'georgia', 'times new roman', 'verdana', 'trebuchet ms', 'courier new',
  'comic sans ms', 'impact', 'tahoma', 'calibri', 'cambria', 'consolas', 'segoe ui',
])

// The weights and styles a file's text uses, most to least complete: a family that lacks one is
// refused whole by Google Fonts, so each fallback asks for less.
const AXES = [':ital,wght@0,400;0,700;1,400;1,700', ':wght@400;700', '']

const requested = new Set<string>()

/** Every font family `preview` names, as the file's own text sets them. */
export function previewFontFamilies(preview: ResourcePreview): string[] {
  const families = new Set<string>()
  JSON.stringify(preview.content, (key, value: unknown) => {
    if (key === 'fontFamily' && typeof value === 'string') families.add(value)
    return value
  })
  return [...families]
}

const load = (family: string, attempt = 0) => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}${AXES[attempt]}&display=swap`
  link.addEventListener('error', () => {
    link.remove()
    if (attempt + 1 < AXES.length) load(family, attempt + 1)
  }, { once: true })
  document.head.append(link)
}

/**
 * Loads from Google Fonts the fonts a file's text is set in, so its text is drawn in its own
 * typeface rather than the nearest system font -- the file is a Google file, whose fonts are Google
 * Fonts. Only the family names leave the page. Each family is asked for once per page load.
 */
export const useWebFonts = (families: readonly string[]) => {
  const wanted = families
    .filter(family => /^[\w -]{1,60}$/.test(family) && !SYSTEM_FONTS.has(family.toLowerCase()) && !requested.has(family))
    .join('|')
  useEffect(() => {
    if (wanted === '') return
    for (const family of wanted.split('|')) {
      if (requested.has(family)) continue
      requested.add(family)
      load(family)
    }
  }, [wanted])
}
