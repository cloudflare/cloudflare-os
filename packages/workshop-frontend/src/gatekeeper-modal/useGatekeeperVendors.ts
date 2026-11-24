import { useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { GatekeeperVendorInfo, GatekeeperVendorListOptions } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { reportIssue } from '../errorReporting'

/**
 * The connectable vendors, fetched each time `open` turns true. The last list stays in `vendors`
 * while a reopen refreshes it, so `vendors` is null only until the first list arrives. `retry`
 * fetches again, asking at once for every vendor the server could not reach.
 */
export const useGatekeeperVendors = (open: boolean) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  // Numbers each fetch. Only the latest one settles the state, so that a list requested before a
  // close or a retry cannot replace the one requested after it.
  const latestRequestRef = useRef(0)

  const load = (options?: GatekeeperVendorListOptions) => {
    const request = ++latestRequestRef.current
    setLoading(true)
    authenticatedApi.listGatekeeperVendors(options).then(list => {
      if (request === latestRequestRef.current) setVendors(list)
    }, err => {
      if (request !== latestRequestRef.current) return
      console.error('Failed to load connection vendors:', err)
      reportIssue('gatekeeper.vendors-load', err)
      toasts.add({ title: "Couldn't load connection options", variant: 'error' })
    }).finally(() => {
      if (request === latestRequestRef.current) setLoading(false)
    })
  }

  useEffect(() => {
    if (!open) return
    load()
    return () => {
      latestRequestRef.current++
      setLoading(false)
    }
  }, [open, authenticatedApi])

  return { vendors, loading, retry: () => load({ retryUnavailable: true }) }
}
