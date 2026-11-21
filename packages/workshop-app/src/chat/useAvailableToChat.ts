import { useEffect, useMemo, useState } from 'react'
import type { GadgetBindingInfo } from '@gadgets/workshop-shared/api'
import { useAutomations } from '@/automations/useAutomations'
import { useLibrary } from '@/library/OutputsFeedContext'
import { useApi } from '@/rpc/ApiContext'
import { availableTo } from './chatAvailable'
import type { ChatContext } from './chatContext'

const NONE: readonly GadgetBindingInfo[] = []

/**
 * What the chat `chatId` can use (`availableTo`), from what it has (`context`) and what its
 * workspace has: the library's outputs in it, its automations and its gadgets' bindings, each as
 * the chat sees them, its own provisional ones among them. The bindings are read again as the
 * gadgets change, and as the chat goes through a connection it had not.
 */
export const useAvailableToChat = (workspaceId: string, chatId: number, context: ChatContext): ChatContext => {
  const { api, reconnecting } = useApi()
  const library = useLibrary()
  const { state: automations } = useAutomations(workspaceId)
  const made = useMemo(
    () => (library.status === 'ready' ? library.outputs.filter((output) => output.workspaceId === workspaceId) : undefined),
    [library, workspaceId],
  )
  // As a string, so that the same gadgets in a new array read nothing again.
  const ids = [...new Set([
    ...(made ?? []).map(({ workpieceId }) => workpieceId),
    ...context.outputs.flatMap(({ type, workpieceId }) => (type === 'gadget' ? [workpieceId] : [])),
  ])].toSorted((a, b) => a - b).join(',')
  const used = context.connectors.length
  const [bindings, setBindings] = useState(NONE)

  useEffect(() => {
    if (!ids || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const gadgets = ids.split(',').map((id) => overseer.getGadget(Number(id)))
    // A gadget that cannot be read, as one deleted meanwhile, is left out.
    void Promise.allSettled(gadgets.map((gadget) => gadget.listBindings(chatId)))
      .then((results) => {
        if (current) setBindings(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])))
      })
      .finally(() => {
        for (const gadget of gadgets) gadget[Symbol.dispose]()
        overseer[Symbol.dispose]()
      })
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, chatId, ids, used])

  const hooks = useMemo(() => (automations.status === 'ready' ? automations.automations.map(({ hook }) => hook) : undefined), [automations])
  return useMemo(() => availableTo(context, { library: made, hooks, bindings: ids ? bindings : NONE }), [context, made, hooks, bindings, ids])
}
