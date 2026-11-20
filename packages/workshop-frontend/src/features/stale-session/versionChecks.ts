import { VERSION_PATH } from '@gadgets/workshop-shared/api'
import { getBackendHost } from '../../connectHandoff'

const FETCH_TIMEOUT_MS = 5_000

/**
 * What new requests reach (see VERSION_PATH): the version id of the backend, and the build id of
 * the frontend a fresh load serves. Each is undefined where there is none, it is not said, or the
 * request fails. Never rejects.
 */
export const fetchVersions = async (): Promise<{ backend?: string; assets?: string }> => {
  try {
    const response = await fetch(`${window.location.protocol}//${getBackendHost()}${VERSION_PATH}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
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

/** Reloads the page, picking up the newest frontend. */
export const reloadPage = () => window.location.reload()
