import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useAccessWaiting } from '@/connections/ObserverAccessProvider'
import type { AsideOutput } from './asideItems'
import { capturedLogs, CapturedLogs } from '@/chat/capturedLogs'
import { GadgetConnection, type GadgetSnapshot } from './GadgetConnection'

const NOTHING: GadgetSnapshot = { ui: { status: 'loading' }, people: [] }
const noSubscription = () => () => {}
const nothing = () => NOTHING

/**
 * The gadget an output is, live, while it is the one shown; nothing for an output that is not a
 * gadget. Showing another connects to that one instead. A new API, from a new connection, connects
 * to it again, keeping the page shown until the new one is loaded. `onEscape` and `onPointerAt`
 * are those it was first given for the gadget, so they must not need to change.
 */
export const useGadgetConnection = (output: AsideOutput | undefined, onEscape: () => void, onPointerAt?: (y: number) => void) => {
  const { api, user } = useApi()
  const notice = useConnectionNotice()
  const waiting = useAccessWaiting()
  // The API the connection opens the workspace with, read when it connects.
  const latestApi = useRef(api)
  const key = output?.type === 'gadget' ? `${output.workspaceId}/${output.workpieceId}/${output.chatId}` : undefined
  const [current, setCurrent] = useState<{ key?: string; connection?: GadgetConnection }>({})
  if (current.key !== key) {
    // Creating one is free; it connects only when started, in the effect below.
    const connection = output && key
      ? new GadgetConnection(() => latestApi.current.openWorkspace(output.workspaceId), output.workpieceId, {
          chatId: output.chatId,
          viewerId: user.id,
          onEscape,
          onPointerAt,
          // Beside a chat, what its page logs is the chat's to send to its agent.
          onConsoleLog: output.chatId === undefined
            ? undefined
            : (log) => capturedLogs.add(CapturedLogs.key(output.workspaceId, output.chatId!), [{ ...log, source: 'page' }]),
          connection: notice ?? undefined,
          // While the user is asked to confirm their access to it, which its loading waits on.
          waitsOnViewer: () => waiting(output.workspaceId, output.workpieceId),
        })
      : undefined
    setCurrent({ key, connection })
  }
  const { connection } = current

  useEffect(() => {
    connection?.start()
    return () => connection?.stop()
  }, [connection])

  // Before the effect above, so a connection made in the same commit starts on the new API.
  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    connection?.reconnect()
  }, [api, connection])

  const snapshot = useSyncExternalStore(connection?.subscribe ?? noSubscription, connection?.getSnapshot ?? nothing)
  return { connection, snapshot }
}
