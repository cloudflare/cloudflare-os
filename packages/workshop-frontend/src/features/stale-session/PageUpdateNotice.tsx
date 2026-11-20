import { useEffect, useRef } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useSiteName } from '../../ServerConfigContext'
import { fetchVersions, reloadPage } from './versionChecks'
import { useSessionCheck } from './useSessionCheck'

/**
 * Tells the user, with a persistent toast, that a fresh load would serve a newer frontend than
 * this page runs (its build id against the one VERSION_PATH answers), and offers to reload. Never
 * reloads by itself, so nothing typed is lost. Shown once per new frontend, on the session checks.
 * Renders nothing itself.
 */
export const PageUpdateNotice = () => {
  const siteName = useSiteName()
  // The manager is a new object on every render, so the check reads it through a ref.
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const mounted = useRef(false)
  const checking = useRef(false)
  const notified = useRef<{ buildId: string; toastId: string } | null>(null)

  useSessionCheck(() => {
    const own = import.meta.env.ASSETS_BUILD_ID
    if (checking.current || own === undefined) return
    checking.current = true
    void fetchVersions().then(({ assets: latest }) => {
      checking.current = false
      if (!mounted.current) return
      if (latest === undefined || latest === own || latest === notified.current?.buildId) return
      if (notified.current) toastsRef.current.close(notified.current.toastId)
      notified.current = {
        buildId: latest,
        toastId: toastsRef.current.add({
          title: `${siteName} was updated`,
          description: 'Reload to use the new version.',
          variant: 'info',
          timeout: 0,
          actions: [{
            children: 'Reload',
            variant: 'primary',
            onClick: reloadPage,
          }],
        }),
      }
    })
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (notified.current) toastsRef.current.close(notified.current.toastId)
      notified.current = null
    }
  }, [])

  return null
}
