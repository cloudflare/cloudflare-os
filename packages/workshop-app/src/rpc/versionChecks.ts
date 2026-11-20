import { VERSION_PATH } from '@gadgets/workshop-shared/api'

const FETCH_TIMEOUT_MS = 5_000

/**
 * What a new request reaches (`VERSION_PATH`), on the page's own origin as the connection is: the
 * version of the backend, and the build id of the app a fresh load gets. Each is undefined where
 * there is none, it is not said, or it could not be asked. Never rejects.
 */
export const fetchVersions = async (): Promise<{ backend?: string; assets?: string }> => {
  try {
    const response = await fetch(VERSION_PATH, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return {}
    const { version, assets } = await response.json() as { version?: unknown; assets?: unknown }
    return {
      backend: typeof version === 'string' ? version : undefined,
      assets: typeof assets === 'string' ? assets : undefined,
    }
  } catch {
    return {}
  }
}
