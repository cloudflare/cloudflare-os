import { useEffect } from 'react'
import { NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from '@gadgets/workshop-shared/feature-flags'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'

const NEXT_UI_COOKIE = `${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}`
// Set once this tab has asked for the new UI, so a host that cannot serve it (`pnpm dev-client`, a
// router-served instance) reloads at most once rather than forever.
const SWITCHED_KEY = 'cfos-ui-switched'
const YEAR_IN_SECONDS = 365 * 24 * 60 * 60

/**
 * Sets the cookie that asks for the new UI and reloads, unless this tab already tried, the cookie
 * is already there, or sessionStorage is unavailable (no guard, so no reload).
 */
export const switchToNextUi = (reload: () => void = () => window.location.reload()) => {
  if (document.cookie.split(';').some((cookie) => cookie.trim() === NEXT_UI_COOKIE)) return
  try {
    if (sessionStorage.getItem(SWITCHED_KEY) !== null) return
    sessionStorage.setItem(SWITCHED_KEY, '1')
  } catch {
    return
  }
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${NEXT_UI_COOKIE}; Path=/; Max-Age=${YEAR_IN_SECONDS}; SameSite=Lax${secure}`
  reload()
}

/**
 * Moves a user the `workshop-app` flag is on for to the new UI, which the backend serves to page
 * requests carrying the cookie. A failed flag read is the default (off), so it never switches.
 */
export const useNextUiSwitch = () => {
  const { enabled, loading } = useUiFeatureFlag('workshop-app')
  useEffect(() => {
    if (!loading && enabled) switchToNextUi()
  }, [enabled, loading])
}
