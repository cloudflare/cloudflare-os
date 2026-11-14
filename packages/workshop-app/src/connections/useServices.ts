import { useEffect, useState } from 'react'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type ServicesState =
  | { status: 'loading' }
  /** `addable`: the built-in ones the user can add (`listAddableGatekeepers()`). */
  | { status: 'ready'; vendors: GatekeeperVendorInfo[]; addable: GatekeeperVendorInfo[] }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * The services that can be connected (`listGatekeeperVendors()`) and the built-in ones that can be
 * added. Loaded when mounted and over each new connection, keeping what was loaded meanwhile, and
 * again on `reread`, as after one is added or disconnected, which changes what can be added.
 */
export const useServices = (): { services: ServicesState; reread: () => void } => {
  const { api, reconnecting } = useApi()
  const [services, setServices] = useState<ServicesState>({ status: 'loading' })
  // Bumped to ask again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let current = true
    Promise.all([api.listGatekeeperVendors(), api.listAddableGatekeepers()]).then(
      ([vendors, addable]) => {
        if (current) setServices({ status: 'ready', vendors, addable })
      },
      (error: unknown) => {
        if (!current) return
        const retry = () => {
          setServices({ status: 'loading' })
          setAttempt((count) => count + 1)
        }
        setServices({ status: 'failed', message: error instanceof Error ? error.message : String(error), retry })
      },
    )
    return () => {
      current = false
    }
  }, [api, reconnecting, attempt])

  return { services, reread: () => setAttempt((count) => count + 1) }
}
