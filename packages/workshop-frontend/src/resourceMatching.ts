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

type Requirements = { parts: string[][]; query: string }

/**
 * What a URL needs to match a pattern, as URLPattern normalizes it: the host and path segments up to
 * the first optional one (`:rest*`, `*?`), each as the words it accepts, then the query. A
 * {@link WORD_CHOICE} accepts each of its words; any other parameter drops its regex and `+`, so a
 * completion, which spells each segment's first word, holds plain placeholders. A query keeps its
 * names but not its values, which are left for the user to type, as a value starting with a colon is
 * not a placeholder. Null for a pattern this browser can't parse.
 */
const requirements = (pattern: string): Requirements | null => {
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
  return {
    parts: segments.slice(0, optional < 0 ? undefined : optional).map(segment =>
      WORD_CHOICE.exec(segment)?.[1].split('|') ?? [segment.replace(/\(.*\)|\+$/g, '')]),
    query: parsed.search === '*' ? '' : `?${parsed.search.replace(/:\w+(\(.*?\))?/g, '')}`,
  }
}

// The picker classifies every resource on each keystroke, so each pattern is parsed once. The
// patterns are the deployment's resource types, a fixed set, so the cache needs no bound.
const requirementsByPattern = new Map<string, Requirements | null>()

/**
 * Classify a search URL, which may be half-typed and lack its scheme, against a resource pattern.
 * 'full' when it names a resource the pattern matches, by the URLPattern test the backend applies;
 * 'prefix' when `completeUrl(search, suffix)` would continue its path toward one; otherwise 'none'.
 */
export function classifyMatch(search: string, pattern: string): MatchClassification {
  const typed = search.trim()
  if (matchesResourceUrlPattern(pattern, normalizeResourceUrl(typed))) return { type: 'full' }

  let required = requirementsByPattern.get(pattern)
  if (required === undefined) requirementsByPattern.set(pattern, required = requirements(pattern))
  if (!required) return { type: 'none' }
  const { parts } = required
  const words = parts.map(([word]) => word)

  // A scheme still being typed ("h", "https:/") completes to the whole pattern.
  const scheme = pattern.slice(0, pattern.indexOf('://') + 3)
  if (scheme.toLowerCase().startsWith(typed.toLowerCase())) {
    return { type: 'prefix', suffix: scheme.slice(typed.length) + words.join('/') + required.query }
  }

  const [path, tail] = splitAtQuery(typed.replace(/^https?:\/\//i, ''))
  // A link's own query stays as it is, so only a link without one completes to the pattern's.
  const query = tail ? '' : required.query
  // A host matches in any case, as URLPattern lowercases the pattern's; a path only in its own.
  const [host, ...rest] = path.split('/')
  const segments = [host.toLowerCase(), ...rest]
  for (const [i, part] of parts.entries()) {
    const segment = segments[i]
    if (segment === undefined) return { type: 'prefix', suffix: `/${words.slice(i).join('/')}${query}` }
    const matches = part.some(word => (word === '*' || word.startsWith(':')) ? segment !== ''
      : (i === 0 && word.startsWith('*.')) ? segment.endsWith(word.slice(1))
      : segment === word)
    if (matches) continue
    // The segment still being typed completes to a word of this part, then the rest of the pattern.
    const word = i === segments.length - 1
      ? part.find(word => !word.startsWith('*') && word.startsWith(segment)) : undefined
    if (word) return { type: 'prefix', suffix: [word.slice(segment.length), ...words.slice(i + 1)].join('/') + query }
    return { type: 'none' }
  }
  // The path is all there, so all a full match can still lack is the pattern's query.
  return query ? { type: 'prefix', suffix: query } : { type: 'none' }
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
