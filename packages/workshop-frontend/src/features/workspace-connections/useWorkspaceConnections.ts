import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, WorkspaceConnectionInfo, Overseer } from '@gadgets/workshop-shared/api'
import { reportIssue } from '../../errorReporting'
import { useActionEntries } from '../../useActions'

export type WorkspaceConnections =
  | { status: 'loading' }
  | { status: 'ready'; connections: WorkspaceConnectionInfo[] }
  | { status: 'failed' }

const LOADING: WorkspaceConnections = { status: 'loading' }

/** Messages that can add a connection to the workspace registry. */
export const changesWorkspaceConnections = (msg: AiChatMessage): boolean => {
  if (msg.type === 'message') {
    return (msg.capsules ?? []).length > 0 ||
      (msg.toolCalls ?? []).some(call =>
        call.toolName === 'createExternalResource' && call.output !== undefined && !call.error)
  }
  return msg.type === 'connectionRequest' && msg.state === 'accepted' && msg.gatekeeperId !== undefined
}

/** Workspace registry, with one in-flight request and a coalesced refetch after invalidation. */
export const useWorkspaceConnections = (overseer: RpcStub<Overseer> | null) => {
  const [loaded, setLoaded] = useState<{
    overseer: RpcStub<Overseer>
    result: WorkspaceConnections
  } | null>(null)
  const invalidateRef = useRef(() => {})
  const connections = !overseer ? null : loaded?.overseer === overseer ? loaded.result : LOADING

  // Subscribe before fetching: the initial replay is already reflected in the first list.
  useActionEntries(overseer, record => {
    if (record.type === 'action' && record.creation) invalidateRef.current()
  })

  useEffect(() => {
    if (!overseer) return
    let active = true
    let inFlight = false
    let stale = false
    const load = () => {
      inFlight = true
      stale = false
      overseer.listConnections().then(
        (inventory): WorkspaceConnections => ({ status: 'ready', connections: inventory }),
        (err: unknown): WorkspaceConnections => {
          if (active) reportIssue('workspace-connections.load', err)
          return { status: 'failed' }
        },
      ).then(result => {
        inFlight = false
        if (!active) return
        if (stale) load()
        else setLoaded({ overseer, result })
      })
    }
    invalidateRef.current = () => {
      if (inFlight) stale = true
      else load()
    }
    load()
    const onFocus = () => invalidateRef.current()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
      invalidateRef.current = () => {}
      setLoaded(null)
    }
  }, [overseer])

  const invalidate = useCallback(() => invalidateRef.current(), [])
  return { connections, invalidate }
}
