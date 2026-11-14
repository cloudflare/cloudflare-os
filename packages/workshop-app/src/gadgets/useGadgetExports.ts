import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { GadgetExports } from './GadgetExports'

/**
 * Saving a gadget to this device (`GadgetExports`), as it is or as chat `chatId` proposes it; one
 * for each gadget, and nothing for no gadget.
 */
export const useGadgetExports = (gadget: { workspaceId: string; workpieceId: number; chatId?: number } | undefined) => {
  const { api } = useApi()
  // The API it opens the workspace with, read when it does, so a new connection is used as it comes.
  const latestApi = useRef(api)
  useLayoutEffect(() => {
    latestApi.current = api
  }, [api])
  const { workspaceId, workpieceId, chatId } = gadget ?? {}
  const exports = useMemo(
    () => (workspaceId === undefined || workpieceId === undefined ? undefined : new GadgetExports(() => latestApi.current.openWorkspace(workspaceId), workpieceId, chatId)),
    [workspaceId, workpieceId, chatId],
  )
  const snapshot = useSyncExternalStore(exports?.subscribe ?? noSubscribe, exports?.getSnapshot ?? noSnapshot)
  return exports && snapshot && { exports, snapshot }
}

const noSubscribe = () => () => {}
const noSnapshot = () => undefined
