import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, ChatBindingInfo, Overseer } from '@gadgets/workshop-shared/api'
import { reportIssue } from '../../errorReporting'
import { useActionEntries } from '../../useActions'

export type ChatBindings =
  | { status: 'loading' }
  | { status: 'ready'; bindings: ChatBindingInfo[] }
  | { status: 'failed' }

const LOADING: ChatBindings = { status: 'loading' }

/**
 * Whether a persisted chat message binds the chat a resource, as the server's replayChatBindings
 * reads it: a pasted resource once named, a created one once its tool call has an output, and an
 * accepted connection request once named.
 */
export const addsChatBinding = (msg: AiChatMessage): boolean => {
  if (msg.type === 'message') {
    return (msg.capsules ?? []).some(capsule => capsule.bindingName !== undefined) ||
      (msg.toolCalls ?? []).some(call =>
        call.toolName === 'createExternalResource' && call.output !== undefined && !call.error)
  }
  return msg.type === 'connectionRequest' && msg.state === 'accepted' &&
    msg.gatekeeperId !== undefined && msg.bindingName !== undefined
}

/**
 * The chat's bindings, from Overseer.listChatBindings(), or null when `chatId` is null.
 *
 * They are refetched after the first approval through one of them (which marks it changed, or
 * gives a created resource its URL), after any creation, and when the caller calls `invalidate`.
 * One request runs at a time: an invalidation that arrives while one runs is answered by a single
 * refetch once it settles, since the running request may have read the server's state before the
 * change.
 */
export const useChatBindings = (overseer: RpcStub<Overseer> | null, chatId: number | null) => {
  const [loaded, setLoaded] = useState<{ chatId: number; result: ChatBindings } | null>(null)
  const invalidateRef = useRef(() => {})
  const chatBindings = chatId === null ? null : loaded?.chatId === chatId ? loaded.result : LOADING

  // Subscribed before the fetch Effect runs, so the entries replayed on subscribing reach a no-op
  // invalidate: the fetch that Effect starts reads state that already reflects them.
  useActionEntries(overseer, (record) => {
    if (record.type !== 'action') return
    // Until a list arrives, any action may concern it.
    if (record.creation || chatBindings?.status !== 'ready' || (record.state === 'approved' &&
        chatBindings.bindings.some(binding => binding.target === record.gatekeeperId && !binding.changed))) {
      invalidateRef.current()
    }
  })

  useEffect(() => {
    if (!overseer || chatId === null) return
    let active = true
    let inFlight = false
    let stale = false
    const load = () => {
      inFlight = true
      stale = false
      overseer.listChatBindings(chatId).then(
        (bindings): ChatBindings => ({ status: 'ready', bindings }),
        (err: unknown): ChatBindings => {
          reportIssue('chat-bindings.load', err)
          return { status: 'failed' }
        },
      ).then((result) => {
        inFlight = false
        if (!active) return
        setLoaded({ chatId, result })
        if (stale) load()
      })
    }
    invalidateRef.current = () => {
      if (inFlight) stale = true
      else load()
    }
    load()
    return () => {
      active = false
      invalidateRef.current = () => {}
      // A workspace switch can select a chat with the same id.
      setLoaded(null)
    }
  }, [overseer, chatId])

  // Stable, so callers can invoke it from callbacks that are created once.
  const invalidate = useCallback(() => invalidateRef.current(), [])
  return { chatBindings, invalidate }
}
