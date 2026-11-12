import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import type { AsideOutput } from './asideTabs'
import { GadgetConnection, type GadgetSnapshot } from './GadgetConnection'

const NOTHING: GadgetSnapshot = { ui: { status: 'loading' }, people: [] }
const noSubscription = () => () => {}
const nothing = () => NOTHING

/**
 * The gadget an output is, live, while it is the one shown; nothing for an output that is not a
 * gadget. Showing another connects to that one instead.
 */
export const useGadgetConnection = (output: AsideOutput | undefined, onEscape: () => void) => {
  const { api, user } = useApi()
  const key = output?.type === 'gadget' ? `${output.workspaceId}/${output.workpieceId}/${output.chatId}` : undefined
  const [current, setCurrent] = useState<{ key?: string; connection?: GadgetConnection }>({})
  if (current.key !== key) {
    // Creating one is free; it connects only when started, in the effect below.
    const connection = output && key
      ? new GadgetConnection(() => api.openWorkspace(output.workspaceId), output.workpieceId, {
          chatId: output.chatId,
          viewerId: user.id,
          onEscape,
        })
      : undefined
    setCurrent({ key, connection })
  }
  const { connection } = current

  useEffect(() => {
    connection?.start()
    return () => connection?.stop()
  }, [connection])

  const snapshot = useSyncExternalStore(connection?.subscribe ?? noSubscription, connection?.getSnapshot ?? nothing)
  return { connection, snapshot }
}
