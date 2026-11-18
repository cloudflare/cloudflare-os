import { VERSION_PATH } from '@gadgets/workshop-shared/api'

const FETCH_TIMEOUT_MS = 5_000

/**
 * The version of the backend that a new request reaches (`VERSION_PATH`), on the page's own
 * origin as the connection is: null where it has none, and undefined when it could not be asked.
 * Never rejects.
 */
export const fetchBackendVersion = async (): Promise<string | null | undefined> => {
  try {
    const response = await fetch(VERSION_PATH, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const { version } = await response.json() as { version?: unknown }
    return typeof version === 'string' ? version : version === null ? null : undefined
  } catch {
    return undefined
  }
}

/**
 * The `src` of a page's entry script, its first module script: Vite names it by a hash of what is
 * in it, so a new build of the app has a new one.
 */
export const entryScriptOf = (page: Pick<Document, 'querySelector'>): string | undefined =>
  page.querySelector('script[type="module"][src]')?.getAttribute('src') ?? undefined

/** The entry script of the page a fresh load would get, or undefined when it cannot be read. Never rejects. */
export const fetchEntryScript = async (): Promise<string | undefined> => {
  try {
    const response = await fetch('/', { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    return entryScriptOf(new DOMParser().parseFromString(await response.text(), 'text/html'))
  } catch {
    return undefined
  }
}
