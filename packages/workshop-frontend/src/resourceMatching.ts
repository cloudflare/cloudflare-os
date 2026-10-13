import { matchesResourceUrlPattern, type SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

/**
 * Extract a base URL from a resource pattern, e.g. "https://jira.cfdata.org/*" → "https://jira.cfdata.org/"
 * Returns null for wildcard hostnames (e.g. "https://*.example.com/*") since we can't pre-fill.
 */
export function extractBaseUrl(pattern: string): string | null {
  const match = pattern.match(/^(https?:\/\/[^/*:]+(?:\/[^*:]*)?)/)
  if (!match) return null
  return match[1].endsWith('/') ? match[1] : match[1] + '/'
}

/**
 * Extract the hostname from a pattern, including wildcard subdomains.
 * e.g. "https://jira.cfdata.org/*" → "jira.cfdata.org"
 * e.g. "https://*.prometheus-access.cfdata.org/*" → "*.prometheus-access.cfdata.org"
 */
export function extractHostname(pattern: string): string | null {
  const match = pattern.match(/^https?:\/\/([^/:]+)/)
  if (!match) return null
  const hostname = match[1].replace(/\*+$/, '') // strip trailing wildcard (e.g. https://*)
  return hostname || null
}

/** Classification of how a search URL relates to a resource pattern. */
export type MatchClassification =
  | { type: 'full' }
  | { type: 'prefix'; suffix: string }  // suffix e.g. "/issues/:number"
  | { type: 'none' }

/** Splits a URL into its path and the query or fragment after it. */
const splitAtQuery = (url: string): [path: string, tail: string] => {
  const at = url.search(/[?#]/)
  return at < 0 ? [url, ''] : [url.slice(0, at), url.slice(at)]
}

/** A parameter choosing between words, such as `:kind(room|dm)`, capturing the words. */
const WORD_CHOICE = /^:\w+\(([\w-]+(?:\|[\w-]+)*)\)$/

/**
 * The host and path segments a URL needs to match a pattern, as URLPattern normalizes them: up to
 * the first optional segment (`:rest*`, `*?`), each as the words it accepts. A {@link WORD_CHOICE}
 * accepts each of its words; any other parameter drops its regex and `+`, so a completion, which
 * spells each segment's first word, holds plain placeholders. Null for a pattern this browser can't
 * parse.
 */
const requiredSegments = (pattern: string): string[][] | null => {
  let parsed: URLPattern
  try {
    parsed = new URLPattern(pattern)
  } catch {
    return null
  }
  const segments = [
    parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
    ...parsed.pathname.split('/').slice(1),
  ]
  const optional = segments.findIndex(segment => segment !== '*' && /[?*]$/.test(segment))
  return segments.slice(0, optional < 0 ? undefined : optional).map(segment =>
    WORD_CHOICE.exec(segment)?.[1].split('|') ?? [segment.replace(/\(.*\)|\+$/g, '')])
}

/**
 * Classify a search URL, which may be half-typed and lack its scheme, against a resource pattern.
 * 'full' when it names a resource the pattern matches, by the URLPattern test the backend applies;
 * 'prefix' when `completeUrl(search, suffix)` would continue its path toward one; otherwise 'none'.
 */
export function classifyMatch(search: string, pattern: string): MatchClassification {
  const typed = search.trim()
  if (matchesResourceUrlPattern(pattern, normalizeResourceUrl(typed))) return { type: 'full' }

  const parts = requiredSegments(pattern)
  if (!parts) return { type: 'none' }
  const words = parts.map(([word]) => word)

  // A scheme still being typed ("h", "https:/") completes to the whole pattern.
  const scheme = pattern.slice(0, pattern.indexOf('://') + 3)
  if (scheme.toLowerCase().startsWith(typed.toLowerCase())) {
    return { type: 'prefix', suffix: scheme.slice(typed.length) + words.join('/') }
  }

  const [path] = splitAtQuery(typed.replace(/^https?:\/\//i, ''))
  const segments = path.toLowerCase().split('/')
  for (const [i, part] of parts.entries()) {
    const segment = segments[i]
    if (segment === undefined) return { type: 'prefix', suffix: `/${words.slice(i).join('/')}` }
    const matches = part.some(word => word === '*' || word.startsWith(':') ? segment !== ''
      : i === 0 && word.startsWith('*.') ? segment.endsWith(word.slice(1).toLowerCase())
      : segment === word.toLowerCase())
    if (matches) continue
    // The segment still being typed completes to a word of this part, then the rest of the pattern.
    const word = i === segments.length - 1
      ? part.find(word => !word.startsWith('*') && word.toLowerCase().startsWith(segment)) : undefined
    if (word) return { type: 'prefix', suffix: [word.slice(segment.length), ...words.slice(i + 1)].join('/') }
    return { type: 'none' }
  }
  return { type: 'none' }
}

/** Appends a `classifyMatch` suffix to a URL's path, keeping any query or fragment after it. */
export function completeUrl(url: string, suffix: string): string {
  const [path, tail] = splitAtQuery(url.trim())
  // A trailing "*" stands for everything under the path, which the URL needn't spell out.
  return path + suffix.replace(/\*$/, '') + tail
}

/**
 * Find all placeholder ranges in a URL string. Placeholders are ":name" named parameters and
 * standalone "*" wildcards. Returns ranges sorted by position.
 */
export function getPlaceholderRanges(url: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const namedParamRegex = /(?<=\/):([a-zA-Z_]\w*)/g
  let match
  while ((match = namedParamRegex.exec(url)) !== null) {
    // Include the colon in the range
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  // Standalone * wildcards as complete path segments, but NOT when * is the final
  // segment (trailing /* is just "everything under here" and shouldn't block selection).
  const starRegex = /(?<=\/)\*(?=\/)/g
  while ((match = starRegex.exec(url)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges.toSorted((a, b) => a.start - b.start)
}

/** Check if search text matches a resource by name/description tokens only. */
export function matchesResourceText(search: string, resource: SupportedResource): boolean {
  const corpus = `${resource.title} ${resource.description} ${resource.urlPattern}`.toLowerCase()
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every(t => corpus.includes(t))
}

/**
 * Normalize a resource URL for sending to the backend. Prepends https:// if no protocol
 * is present, and strips a trailing /* wildcard (which is just "everything under here").
 */
export function normalizeResourceUrl(url: string): string {
  let normalized = url.trim()
  // Default to https:// if no protocol specified.
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized
  }
  // Strip trailing /* wildcard — it's not meaningful for the backend.
  normalized = normalized.replace(/\/\*$/, '')
  return normalized
}
