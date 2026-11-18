import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { RpcTarget } from 'capnweb'
import type { ConsoleLogEvent, ConsoleLogSubscriber } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { capturedLogs, CapturedLogs } from './capturedLogs'

/**
 * Takes the workspace's gadgets' server-side logs for one chat: those of a version with its
 * changes, and those of the gadgets as they are, which the chat shown is the one to fix.
 */
class ServerLogs extends RpcTarget implements ConsoleLogSubscriber {
  constructor(private readonly chatId: number, private readonly key: string) {
    super()
  }

  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    if (chatId !== null && chatId !== this.chatId) return
    capturedLogs.add(this.key, logs.map((log) => ({ ...log, source: 'server' as const })))
  }
}

/**
 * What the gadgets logged while this chat was shown, with the way to send it or put it away. The
 * gadget's page adds its own when shown beside the chat (`useGadgetConnection`).
 */
export const useCapturedLogs = (workspaceId: string, chatId: number) => {
  const { api, reconnecting } = useApi()
  const key = CapturedLogs.key(workspaceId, chatId)

  useEffect(() => {
    if (reconnecting) return
    let subscription: Disposable | undefined
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    // Through `then`, so a workspace without them (the app's mock) is one that sends none.
    Promise.resolve().then(() => overseer.subscribeToConsoleLogs(new ServerLogs(chatId, key))).then(
      (made) => {
        if (current) subscription = made
        else made[Symbol.dispose]()
      },
      // Not having them leaves nothing to send, which is what there was before.
      () => {},
    )
    return () => {
      current = false
      subscription?.[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, chatId, key])

  const subscribe = useCallback((listener: () => void) => capturedLogs.subscribe(key, listener), [key])
  const summary = useSyncExternalStore(subscribe, () => capturedLogs.summary(key))
  const take = useCallback(() => capturedLogs.take(key), [key])
  const discard = useCallback(() => capturedLogs.discard(key), [key])
  const peek = useCallback(() => capturedLogs.peek(key), [key])
  return { summary, take, discard, peek }
}
