import { useEffect, useState } from 'react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The kinds of change the user lets go ahead without asking on a service's connections, in every
 * workspace they own (`AuthenticatedApi.listDefaultAutoApprovedActionKinds`), by tag, and a way to
 * change one. A change shows at once, and goes back, saying why in `problem`, if the server refuses
 * it. `automatic` is undefined until read, and nothing is read until the service is known.
 */
export const useChangeDefaults = (vendorId: string | undefined) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const [automatic, setAutomatic] = useState<ReadonlySet<string>>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    if (!vendorId || reconnecting) return
    let cancelled = false
    api.listDefaultAutoApprovedActionKinds().then(
      (defaults) => {
        if (cancelled) return
        const wanted = vendorId.toLowerCase()
        setAutomatic(new Set(defaults.filter((entry) => entry.vendorId.toLowerCase() === wanted).map(({ actionKind }) => actionKind.tag)))
      },
      (error: unknown) => !cancelled && setProblem(`Couldn’t read what goes ahead on its own: ${messageOf(error)}`),
    )
    return () => { cancelled = true }
  }, [api, reconnecting, vendorId])

  const set = (tag: string, on: boolean) => setAutomatic((current) => {
    const next = new Set(current)
    if (on) next.add(tag)
    else next.delete(tag)
    return next
  })

  const change = (kind: ActionKind, on: boolean) => {
    setProblem(undefined)
    if (!vendorId || connection?.blocked()) return
    set(kind.tag, on)
    const asked = on ? api.setDefaultAutoApprovedActionKind(vendorId, kind) : api.removeDefaultAutoApprovedActionKind(vendorId, kind.tag)
    asked.catch((error: unknown) => {
      set(kind.tag, !on)
      setProblem(`Couldn’t change “${kind.label}”: ${messageOf(error)}`)
    })
  }

  return { automatic, change, problem }
}
