import { useEffect, useRef } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useSiteName } from '../../ServerConfigContext'
import { entryScriptOf, fetchEntryScript, reloadPage } from './versionChecks'
import { useSessionCheck } from './useSessionCheck'

/**
 * Tells the user, with a persistent toast, that a fresh load would serve a newer frontend than
 * this page runs, and offers to reload. Never reloads by itself, so nothing typed is lost. Shown
 * once per new frontend, on the session checks. Renders nothing itself.
 */
export const PageUpdateNotice = () => {
  const siteName = useSiteName()
  // The manager is a new object on every render, so the check reads it through a ref.
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const mounted = useRef(false)
  const checking = useRef(false)
  const notified = useRef<{ entryScript: string; toastId: string } | null>(null)

  useSessionCheck(() => {
    const own = entryScriptOf(document)
    if (checking.current || own === undefined) return
    checking.current = true
    void fetchEntryScript().then((latest) => {
      checking.current = false
      if (!mounted.current) return
      if (latest === undefined || latest === own || latest === notified.current?.entryScript) return
      if (notified.current) toastsRef.current.close(notified.current.toastId)
      notified.current = {
        entryScript: latest,
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
