import { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

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

const stripScheme = (s: string) => s.replace(/^https?:\/\//, '').toLowerCase()

/**
 * Segment-based URL match: split by "/" and compare segments, treating ":name" as a
 * single-segment named parameter and "*" as a greedy wildcard that matches all remaining
 * segments. Handles partial typing (user mid-keystroke on the last segment). Also handles
 * wildcard subdomain patterns like "*.prometheus-access.cfdata.org".
 */
export function matchesResourceUrl(search: string, pattern: string): boolean {
  const s = stripScheme(search)
  const p = stripScheme(pattern)
  if (!s) return false

  // Wildcard subdomain: *.foo.com matches anything.foo.com
  if (p.startsWith('*.')) {
    const suffixHost = p.slice(1).split('/')[0] // ".foo.com"
    const searchHost = s.split('/')[0]
    if (searchHost.endsWith(suffixHost) || suffixHost.startsWith('.' + searchHost)) return true
  }

  const searchParts = s.split('/')
  const patternParts = p.split('/')

  for (let i = 0; i < Math.max(searchParts.length, patternParts.length); i++) {
    const sp = searchParts[i]
    const pp = patternParts[i]

    if (pp === '*') {
      // Greedy wildcard – matches all remaining segments
      return true
    }
    if (pp !== undefined && pp.startsWith(':')) {
      // Named parameter – matches any single non-empty segment
      if (sp === undefined || sp === '') {
        return true // user still typing
      }
      continue
    }
    if (sp === undefined) {
      // Search exhausted, pattern has more – user is still typing
      return true
    }
    if (pp === undefined) {
      // Pattern exhausted, search has more – URL is more specific than pattern.
      // Allow trailing slash, otherwise no match.
      return sp === '' && i === searchParts.length - 1
    }
    // Literal segment: allow partial match on last search segment
    if (i === searchParts.length - 1) {
      return pp.startsWith(sp) || sp.startsWith(pp)
    }
    if (sp !== pp) {
      return false
    }
  }

  return true
}

/** Classification of how a search URL relates to a resource pattern. */
export type MatchClassification =
  | { type: 'full' }
  | { type: 'prefix'; suffix: string }  // suffix e.g. "/issues/:number"
  | { type: 'none' }

/**
 * Classify a search URL against a resource pattern. Returns 'full' when the URL
 * satisfies all segments, 'prefix' when the URL is a valid prefix that could be
 * extended (with the remaining suffix), or 'none' when there's no match.
 */
export function classifyMatch(search: string, pattern: string): MatchClassification {
  const s = stripScheme(search)
  const p = stripScheme(pattern)

  // Empty after scheme stripping (e.g. search is "https://") — every pattern is a prefix.
  if (!s) return { type: 'prefix', suffix: p }

  // If the search is a partial scheme prefix (e.g. "h", "https", "https:/") that hasn't
  // reached the hostname yet, treat as a prefix of the full pattern. The suffix completes
  // the scheme + the schemeless pattern so that searchText + suffix = full pattern URL.
  const lowerSearch = search.toLowerCase().trim()
  if (pattern.toLowerCase().startsWith(lowerSearch) &&
      lowerSearch.length <= pattern.indexOf('://') + 3) {
    return { type: 'prefix', suffix: pattern.slice(lowerSearch.length) }
  }

  // Wildcard subdomain – treat as full for simplicity (no current patterns use this)
  if (p.startsWith('*.')) {
    const suffixHost = p.slice(1).split('/')[0]
    const searchHost = s.split('/')[0]
    if (searchHost.endsWith(suffixHost) || suffixHost.startsWith('.' + searchHost)) {
      return { type: 'full' }
    }
  }

  const searchParts = s.split('/')
  const patternParts = p.split('/')

  for (let i = 0; i < Math.max(searchParts.length, patternParts.length); i++) {
    const sp = searchParts[i]
    const pp = patternParts[i]

    if (pp === '*') {
      // Greedy wildcard – matches all remaining segments
      if (sp === undefined) {
        return { type: 'prefix', suffix: '/*' }
      }
      return { type: 'full' }
    }
    if (pp !== undefined && pp.startsWith(':')) {
      // Named parameter – needs a non-empty segment
      if (sp === undefined || sp === '') {
        const suffix = '/' + patternParts.slice(i).join('/')
        return { type: 'prefix', suffix }
      }
      continue
    }
    if (sp === undefined) {
      // Search exhausted, pattern has more literal/named/wildcard segments
      const suffix = '/' + patternParts.slice(i).join('/')
      return { type: 'prefix', suffix }
    }
    if (pp === undefined) {
      // Pattern exhausted, search has more segments
      // Trailing slash is OK (still full), otherwise URL is more specific → none
      if (sp === '' && i === searchParts.length - 1) {
        return { type: 'full' }
      }
      return { type: 'none' }
    }
    // Literal segment
    if (sp !== pp) {
      // On the last search segment, allow partial match (user is still typing).
      // The suffix completes the current segment plus the rest of the pattern.
      if (i === searchParts.length - 1 && pp.startsWith(sp)) {
        const segmentRemainder = pp.slice(sp.length)
        const rest = patternParts.slice(i + 1)
        const suffix = segmentRemainder + (rest.length > 0 ? '/' + rest.join('/') : '')
        return { type: 'prefix', suffix }
      }
      return { type: 'none' }
    }
  }

  return { type: 'full' }
}

/**
 * Find all placeholder ranges in a URL string. Placeholders are ":name" named parameters
 * and standalone "*" wildcards. Returns ranges sorted by position.
 */
export function getPlaceholderRanges(url: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  // Named parameters: colon followed by word characters, preceded by / or start
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
 * Check if search text matches a resource. Tries URL prefix matching (scheme-optional),
 * then falls back to multi-word token matching against title/description/pattern.
 */
export function matchesResource(search: string, resource: SupportedResource): boolean {
  if (matchesResourceUrl(search.trim(), resource.urlPattern)) return true
  return matchesResourceText(search, resource)
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
