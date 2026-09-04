import { useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import { useConnectHandoffListener } from './connectHandoff'

/**
 * Mounted once inside the authenticated shell (below the toast provider): completes gatekeeper
 * connect flows whose popup reports back to this window, surfacing a rejected ticket as a toast.
 */
export function ConnectHandoffListener(): null {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const onError = useCallback((message: string) => {
    toasts.add({ title: 'Could not complete the connection', description: message, variant: 'error' })
  }, [toasts])
  useConnectHandoffListener(authenticatedApi, onError)
  return null
}
