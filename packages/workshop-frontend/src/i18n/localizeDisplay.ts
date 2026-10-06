import type { TranslateVars } from './types'

type TFn = (key: string, vars?: TranslateVars) => string

/** Return catalog value, or fallback when the key is missing from all locales. */
export function tOr(t: TFn, key: string, fallback: string | undefined | null): string {
  const value = t(key)
  if (value === key) return fallback ?? ''
  return value
}

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Localized title/description for known featured/format blueprints.
 * Keys mirror blueprint ids (`format.document` → featuredBlueprints.format.document.*).
 * Also accepts hyphenated folder-style ids (`workspace-docs`) and English title slugs
 * (`Workspace Docs` → byTitle.workspace_docs) so deployments with renamed ids still overlay.
 * Falls back to server metadata.
 */
export function localizeBlueprintDisplay(
  t: TFn,
  blueprint: { id: string; metadata: { title: string; description?: string | null } },
): { title: string; description: string } {
  const idCandidates = Array.from(
    new Set(
      [
        blueprint.id,
        // folder-style → dotted format id (workspace-docs → not format.document; keep as key)
        blueprint.id.replaceAll('-', '_'),
      ].filter(Boolean),
    ),
  )

  let byIdTitle = ''
  let byIdDesc = ''
  for (const id of idCandidates) {
    const idKey = `featuredBlueprints.${id}`
    if (!byIdTitle) byIdTitle = tOr(t, `${idKey}.title`, '')
    if (!byIdDesc) byIdDesc = tOr(t, `${idKey}.description`, '')
    if (byIdTitle && byIdDesc) break
  }

  // Secondary: match well-known English titles (deployments may use different ids).
  const titleSlug = slugify(blueprint.metadata.title)
  const byTitleTitle = byIdTitle || tOr(t, `featuredBlueprints.byTitle.${titleSlug}.title`, '')
  const byTitleDesc = byIdDesc || tOr(t, `featuredBlueprints.byTitle.${titleSlug}.description`, '')

  return {
    title: byIdTitle || byTitleTitle || blueprint.metadata.title,
    description:
      byIdDesc ||
      byTitleDesc ||
      blueprint.metadata.description ||
      t('workspaces.noDescription'),
  }
}

/**
 * Localized vendor displayName + tagline + long description by vendor id
 * (`GATEKEEPER_*` suffix, lowercased). Accepts hyphenated ids (`mcp-portal`) and falls back to
 * English `displayName` slug (`byTitle.scheduled_tasks`) when deployments rename binding ids.
 * Falls back to server metadata for unknown vendors.
 */
export function localizeVendorDisplay(
  t: TFn,
  vendor: {
    id?: string
    displayName: string
    tagline?: string | null
    description?: string | null
  },
): { displayName: string; tagline: string | undefined; description: string | undefined } {
  const rawId = (vendor.id ?? '').toLowerCase()
  const idCandidates = Array.from(
    new Set(
      [rawId, rawId.replaceAll('-', '_'), rawId.replaceAll('_', '-')].filter(Boolean),
    ),
  )

  let byIdName = ''
  let byIdTagline = ''
  let byIdDesc = ''
  for (const id of idCandidates) {
    if (!byIdName) byIdName = tOr(t, `vendors.${id}.displayName`, '')
    if (!byIdTagline) byIdTagline = tOr(t, `vendors.${id}.tagline`, '')
    if (!byIdDesc) byIdDesc = tOr(t, `vendors.${id}.description`, '')
    if (byIdName && byIdTagline && byIdDesc) break
  }

  const titleSlug = slugify(vendor.displayName)
  const byTitleName = byIdName || tOr(t, `vendors.byTitle.${titleSlug}.displayName`, '')
  const byTitleTagline = byIdTagline || tOr(t, `vendors.byTitle.${titleSlug}.tagline`, '')
  const byTitleDesc = byIdDesc || tOr(t, `vendors.byTitle.${titleSlug}.description`, '')

  return {
    displayName: byIdName || byTitleName || vendor.displayName,
    tagline: byIdTagline || byTitleTagline || vendor.tagline || undefined,
    description: byIdDesc || byTitleDesc || vendor.description || undefined,
  }
}

/**
 * Localized SupportedResource title + description (Connect modal, resource picker).
 * Prefer English title slug (`gmail_mailbox`); unknown / host-specific resources stay as returned.
 */
export function localizeSupportedResource(
  t: TFn,
  resource: { title: string; description?: string | null; urlPattern?: string },
): { title: string; description: string } {
  const titleSlug = slugify(resource.title)
  const byTitle = tOr(t, `gatekeeperResources.byTitle.${titleSlug}.title`, '')
  const byDesc = tOr(t, `gatekeeperResources.byTitle.${titleSlug}.description`, '')
  return {
    title: byTitle || resource.title,
    description: byDesc || resource.description || '',
  }
}

/**
 * Localized format output noun/plural (command palette, create menus, Outputs filters).
 * Prefer output id (`document` / `presentation` / `spreadsheet` / `app`), then English noun match.
 */
export function localizeFormatOutput(
  t: TFn,
  output: { id?: string; noun: string; plural?: string },
): { noun: string; plural: string } {
  const id = (output.id ?? '').trim()
  const byIdNoun = id ? tOr(t, `formatOutput.byId.${id}.noun`, '') : ''
  const byIdPlural = id ? tOr(t, `formatOutput.byId.${id}.plural`, '') : ''

  const nounSlug = slugify(output.noun)
  const byNoun = byIdNoun || tOr(t, `formatOutput.byNoun.${nounSlug}`, '')

  const pluralSrc = output.plural ?? output.noun
  const pluralSlug = slugify(pluralSrc)
  const byPlural =
    byIdPlural || tOr(t, `formatOutput.byPlural.${pluralSlug}`, '') || (byNoun && !output.plural ? byNoun : '')

  return {
    noun: byIdNoun || byNoun || output.noun,
    plural: byIdPlural || byPlural || output.plural || output.noun,
  }
}

/**
 * English vendor product names longest-first, for prefix / exact replacement in account labels.
 * Brand names often stay identical in KO; descriptive defaults (Scheduled Tasks, MCP Server, …) change.
 */
const VENDOR_EN_PREFIXES: { en: string; id: string }[] = [
  { en: 'Cloudflare MCP Server Portals', id: 'mcp_portal' },
  { en: 'Scheduled Tasks', id: 'scheduler' },
  { en: 'Home Assistant', id: 'homeassistant' },
  { en: 'MCP Server', id: 'mcp' },
  { en: 'ZoomInfo', id: 'zoominfo' },
  { en: 'Confluence', id: 'confluence' },
  { en: 'Cloudflare', id: 'cloudflare' },
  { en: 'Supabase', id: 'supabase' },
  { en: 'Spotify', id: 'spotify' },
  { en: 'Context', id: 'context' },
  { en: 'GitHub', id: 'github' },
  { en: 'Google', id: 'google' },
  { en: 'Linear', id: 'linear' },
  { en: 'Notion', id: 'notion' },
  { en: 'Slack', id: 'slack' },
  { en: 'Email', id: 'email' },
]

/**
 * Localize known English product / connector defaults in an account display label.
 * User-specific names (OAuth profile names, workspace names) stay as-is.
 */
export function localizeAccountDisplayName(
  t: TFn,
  name: string | undefined | null,
): string {
  if (name == null || name.trim() === '') {
    return tOr(t, 'accountDefaults.connected', 'Connected')
  }
  const trimmed = name.trim()

  const byExact = tOr(t, `accountDefaults.${slugify(trimmed)}`, '')
  if (byExact) return byExact

  for (const { en, id } of VENDOR_EN_PREFIXES) {
    if (trimmed === en) {
      return tOr(t, `vendors.${id}.displayName`, trimmed)
    }
    // Prefix forms: "GitHub / login", "Google — name", "Slack - workspace"
    const separators = [' — ', ' - ', ' / ', '/ ', ' (', ' · ']
    for (const sep of separators) {
      if (trimmed.startsWith(en + sep)) {
        const localized = tOr(t, `vendors.${id}.displayName`, en)
        return localized + trimmed.slice(en.length)
      }
    }
    if (trimmed.startsWith(en + ' ')) {
      const localized = tOr(t, `vendors.${id}.displayName`, en)
      return localized + trimmed.slice(en.length)
    }
  }

  return trimmed
}

/**
 * Localized gatekeeper management-app title (`providesUi.title`) by vendor id.
 * Accepts hyphenated ids and English title slugs as fallbacks.
 */
export function localizeGatekeeperAppTitle(
  t: TFn,
  app: { id: string; title: string },
): string {
  const rawId = (app.id ?? '').toLowerCase()
  const idCandidates = Array.from(
    new Set(
      [rawId, rawId.replaceAll('-', '_'), rawId.replaceAll('_', '-')].filter(Boolean),
    ),
  )
  for (const id of idCandidates) {
    const title = tOr(t, `gatekeeperApps.${id}.title`, '')
    if (title) return title
  }
  const byTitle = tOr(t, `gatekeeperApps.byTitle.${slugify(app.title)}.title`, '')
  return byTitle || app.title
}
