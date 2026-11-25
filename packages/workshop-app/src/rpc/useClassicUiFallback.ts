import { useEffect } from 'react'
import { NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from '@gadgets/workshop-shared/feature-flags'
import { useUiFeatureFlags, type FeatureFlagsState } from './FeatureFlagsContext'

const NEXT_UI_COOKIE = `${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}`

/**
 * Whether this page was served for the cookie that asks for the new UI to a user the
 * `workshop-app` flag has been read as off for. Never on a failed read (`read` is still false, or
 * still what an earlier read said), and never without the cookie, as on a preview, which serves
 * this app to everyone.
 */
export const classicUiFallbackNeeded = ({ flags, read }: Pick<FeatureFlagsState, 'flags' | 'read'>, cookies: string) =>
  read && !flags['workshop-app'] && cookies.split(';').some((cookie) => cookie.trim() === NEXT_UI_COOKIE)

/**
 * Sends a user the `workshop-app` flag is off for back to the old UI: clears the cookie the backend
 * serves this app's page for, and reloads. The cookie is a hint anyone can set; this is what makes
 * the flag the authority.
 */
export const useClassicUiFallback = () => {
  const { flags, read } = useUiFeatureFlags()
  const needed = classicUiFallbackNeeded({ flags, read }, document.cookie)
  useEffect(() => {
    if (!needed) return
    document.cookie = `${NEXT_UI_COOKIE}; Path=/; Max-Age=0`
    window.location.reload()
  }, [needed])
}
