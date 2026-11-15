import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { GadgetRequests, type GadgetRequestsSnapshot } from './GadgetRequests'

/**
 * What one gadget and the agents it started wait on a person for (`GadgetRequests`), live while mounted; the
 * caller keys it by the gadget. Nothing for `undefined`. A new API, from a new connection, opens
 * its workspace again, keeping what is shown meanwhile.
 */
export const useGadgetRequests = (gadget: { workspaceId: string; workpieceId: number } | undefined) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const latestApi = useRef(api)
  const [requests] = useState(() => gadget && new GadgetRequests(
    () => latestApi.current.openWorkspace(gadget.workspaceId),
    gadget.workpieceId,
    { connection: notice ?? undefined },
  ))

  useEffect(() => {
    requests?.start()
    return () => requests?.stop()
  }, [requests])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    requests?.restart()
  }, [api, requests])

  const snapshot = useSyncExternalStore(requests?.subscribe ?? noop, requests?.getSnapshot ?? empty)
  return { requests, snapshot }
}

const noop = () => () => {}
const EMPTY: GadgetRequestsSnapshot = { waiting: [], agents: new Map(), vendors: new Map() }
const empty = () => EMPTY
