import { useEffect, useState } from 'react'
import { SummaryListener } from '@/gadgets/GadgetSettings'
import { useObjectUrl } from '@/hooks/useObjectUrl'
import { useApi } from '@/rpc/ApiContext'

/** What people a gadget is shared with see of it: its picture, and when its snapshot was taken. */
export type GadgetView = {
  /** The gadget as the server last drew it (`GadgetClient.getThumbnail`), once it has. */
  picture?: string
  /** When its owner's view, the snapshot "Can view" shows, was last taken (`GadgetSummary.viewTakenAt`). */
  takenAt?: Date
  /** The last attempt to update that view failed, so it is the one from `takenAt` still. */
  updateFailed: boolean
}

/**
 * What a gadget's share dialog shows of what people will see, while it is open: the gadget's
 * picture, and when its snapshot was taken, kept current as the owner opens it again.
 */
export const useGadgetView = (workspaceId: string, gadgetId: number, open: boolean): GadgetView => {
  const { api, reconnecting } = useApi()
  const [bytes, setBytes] = useState<Uint8Array>()
  const [times, setTimes] = useState<{ takenAt?: Date; failedAt?: Date }>({})

  useEffect(() => {
    if (!open || reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    const gadget = overseer.getGadget(gadgetId)
    gadget.getThumbnail().then((picture) => !cancelled && picture && setBytes(picture), () => {})
    const lease = overseer.subscribeToWorkpieces(new SummaryListener(gadgetId, (summary) => {
      if (!cancelled && summary) setTimes({ takenAt: summary.viewTakenAt, failedAt: summary.viewUpdateFailedAt })
    }))
    return () => {
      cancelled = true
      void lease.then((held) => held[Symbol.dispose](), () => {})
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, gadgetId, open])

  const picture = useObjectUrl(bytes, 'image/jpeg')
  const { takenAt, failedAt } = times
  return { picture, takenAt, updateFailed: failedAt !== undefined && (!takenAt || failedAt > takenAt) }
}
