import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ObserverBindingNeed, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'

/**
 * The connected systems a recipient must have their own access to: those the whole workspace
 * reaches, or with `gadgetId`, only those that gadget reaches. Refreshed on focus as well as on
 * open: bindings cannot change in the share dialog, but they can change in another tab while it
 * remains open. A failed refresh is informational and never blocks sharing.
 */
export const useObserverRequirements = (overseer: RpcStub<Overseer>, open: boolean, gadgetId?: WorkpieceId) => {
  const [requirements, setRequirements] =
    useState<ObserverBindingNeed[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let requestId = 0
    setRequirements(null)
    const refresh = () => {
      const thisRequest = ++requestId
      setFailed(false)
      overseer.listObserverRequirements(gadgetId === undefined ? 'workspace' : { gadgetId })
        .then(needs => {
          if (!cancelled && thisRequest === requestId) setRequirements(needs)
        })
        .catch(err => {
          console.error('Failed to load observer requirements:', err)
          if (!cancelled && thisRequest === requestId) setFailed(true)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [open, overseer, gadgetId])

  return { requirements, failed }
}
