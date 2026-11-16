import { useEffect, useState } from 'react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The kinds of change the user once let go ahead without asking through a service in every
 * workspace they own (`AuthenticatedApi.listDefaultAutoApprovedActionKinds`), from before that was
 * chosen in each workspace's Connections, and a way to make them all ask first again. They still go
 * ahead until then, so the account's page says so. `kinds` is undefined until read, and nothing is
 * read until the service is known. Clearing shows at once, and puts back, saying why in `problem`,
 * whatever the server refuses.
 */
export const useAccountWideDefaults = (vendorId: string | undefined) => {
  const { api, reconnecting } = useApi()
  const connection = useConnectionNotice()
  const [kinds, setKinds] = useState<readonly ActionKind[]>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    if (!vendorId || reconnecting) return
    let cancelled = false
    api.listDefaultAutoApprovedActionKinds().then(
      (defaults) => {
        if (cancelled) return
        const wanted = vendorId.toLowerCase()
        setKinds(defaults.filter((entry) => entry.vendorId.toLowerCase() === wanted).map(({ actionKind }) => actionKind))
      },
      // Nothing to show for what cannot be read: the page is about the account.
      () => {},
    )
    return () => { cancelled = true }
  }, [api, reconnecting, vendorId])

  const askFirst = async () => {
    setProblem(undefined)
    if (!vendorId || !kinds?.length || connection?.blocked()) return false
    const clearing = kinds
    setKinds([])
    const results = await Promise.allSettled(clearing.map((kind) => api.removeDefaultAutoApprovedActionKind(vendorId, kind.tag)))
    const kept = clearing.filter((_, index) => results[index]!.status === 'rejected')
    if (kept.length) {
      setKinds(kept)
      const failure = results.find((result) => result.status === 'rejected')
      setProblem(`Couldn’t make them ask first: ${messageOf(failure?.status === 'rejected' ? failure.reason : undefined)}`)
    }
    return true
  }

  return { kinds, askFirst, problem }
}
