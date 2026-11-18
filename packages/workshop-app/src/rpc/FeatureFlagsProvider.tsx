import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from './ApiContext'
import { FeatureFlagsContext, uiFeatureFlagsOf, type FeatureFlagsState } from './FeatureFlagsContext'

/**
 * The user's UI feature flags for whatever is beneath (`useUiFeatureFlag`), read as they sign in
 * and again on each new connection, with what was read before kept meanwhile. Flags that could not
 * be read are their defaults, which is what a deployment without Flagship has too.
 */
export const FeatureFlagsProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<FeatureFlagsState>(() => ({ flags: uiFeatureFlagsOf(undefined), loading: true }))

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads them.
    if (reconnecting) return
    let cancelled = false
    api.getUiFeatureFlags().then(
      (read) => {
        if (!cancelled) setState({ flags: uiFeatureFlagsOf(read), loading: false })
      },
      () => {
        // What was read before stays.
        if (!cancelled) setState((current) => ({ ...current, loading: false }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  return <FeatureFlagsContext value={state}>{children}</FeatureFlagsContext>
}
