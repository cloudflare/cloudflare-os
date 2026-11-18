import { useEffect } from 'react'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { applyAccentColor } from '@gadgets/workshop-shared/theme'

// The logo's address is the same for every logo the deployment is given, so the page asks for it
// afresh once, rather than showing one the browser kept from before it was changed.
let busted: { url: string; fresh: string } | undefined

/** The deployment's own logo (`ServerConfig.siteLogo`), read afresh once a page, or nothing to show the app's mark. */
export const siteLogoUrl = (config: ServerConfig | undefined): string | undefined => {
  const url = config?.siteLogo?.url
  if (!url) return undefined
  if (busted?.url !== url) busted = { url, fresh: `${url}${url.includes('?') ? '&' : '?'}v=${Date.now().toString(36)}` }
  return busted.fresh
}

const DEFAULT_ICON = { href: '/favicon.svg', type: 'image/svg+xml' }

/**
 * Puts the deployment's logo in the tab, once it has loaded, so that one that does not load leaves
 * the app's own there rather than none. Returns what lets go of it.
 */
const showFavicon = (logoUrl: string | undefined): (() => void) => {
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!icon) return () => {}
  Object.assign(icon, DEFAULT_ICON)
  if (!logoUrl) return () => {}

  const controller = new AbortController()
  let objectUrl: string | undefined
  fetch(logoUrl, { cache: 'no-cache', signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`The logo could not be read (${response.status}).`)
      return response.blob()
    })
    .then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      Object.assign(icon, { href: objectUrl, type: 'image/png' })
    })
    .catch(() => {})
  return () => {
    controller.abort()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Gives the app the deployment's look (`ServerConfig`): its accent colour in place of the brand's,
 * in the tokens Kumo draws it with (`applyAccentColor`, which the old app and the gatekeepers' apps
 * share), and its logo in the tab. The app's own until the configuration has been read, and for a
 * deployment that sets neither.
 */
export const useSiteLook = (config: ServerConfig | undefined) => {
  const accent = config?.accentColor
  useEffect(() => {
    applyAccentColor(document.documentElement.style, accent)
  }, [accent])
  const logo = siteLogoUrl(config)
  useEffect(() => showFavicon(logo), [logo])
}
