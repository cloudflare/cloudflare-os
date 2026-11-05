import { VERSION_PATH } from '@gadgets/workshop-shared/api'
import { getBackendHost } from '../../connectHandoff'

const FETCH_TIMEOUT_MS = 5_000

/**
 * The version id of the backend that new requests reach (see VERSION_PATH): null where it has
 * none, undefined when the request fails. Never rejects.
 */
export const fetchBackendVersion = async (): Promise<string | null | undefined> => {
  try {
    const response = await fetch(`${window.location.protocol}//${getBackendHost()}${VERSION_PATH}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const { version } = await response.json() as { version?: unknown }
    return typeof version === 'string' ? version : version === null ? null : undefined
  } catch {
    return undefined
  }
}

/**
 * The `src` of a page's entry script, its first module script: Vite names it by a hash of its
 * content, so a new frontend build has a new one.
 */
export const entryScriptOf = (page: Document): string | undefined =>
  page.querySelector('script[type="module"][src]')?.getAttribute('src') ?? undefined

/**
 * The entry script of the page a fresh load would serve, or undefined when it cannot be read.
 * Never rejects.
 */
export const fetchEntryScript = async (): Promise<string | undefined> => {
  try {
    const response = await fetch('/', {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return entryScriptOf(new DOMParser().parseFromString(await response.text(), 'text/html'))
  } catch {
    return undefined
  }
}

/** Reloads the page, picking up the newest frontend. */
export const reloadPage = () => window.location.reload()
