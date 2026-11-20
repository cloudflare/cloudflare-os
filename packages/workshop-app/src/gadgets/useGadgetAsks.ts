import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AsideOutput } from '@/aside/asideItems'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { isAskOf, type Ask } from './askGroups'
import { GadgetAsks, type GadgetAsksSnapshot } from './GadgetAsks'

const LOADING: GadgetAsksSnapshot = { status: 'loading' }
const noSubscription = () => () => {}
const loading = () => LOADING

/**
 * What a gadget shown waits on the viewer for (`GadgetAsks`), live while it is shown, for whoever
 * builds in its workspace; nothing for anyone else (`enabled`), or for an output that is not a
 * gadget. Shown from a chat that is in sight (`chatInSight`, beside it), what it asks from that
 * chat is the chat's to show, and left out here. A new API, from a new connection, opens its
 * workspace again, keeping what is shown meanwhile.
 */
export const useGadgetAsks = (output: AsideOutput | undefined, { enabled, chatInSight }: { enabled: boolean; chatInSight: boolean }) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const latestApi = useRef(api)
  const gadget = enabled && output?.type === 'gadget' ? output : undefined
  const workspaceId = gadget?.workspaceId
  const workpieceId = gadget?.workpieceId
  const chatId = gadget?.chatId
  const key = gadget && `${workspaceId}/${workpieceId}/${chatId}`
  const [current, setCurrent] = useState<{ key?: string; asks?: GadgetAsks }>({})
  if (current.key !== key) {
    // Making one is free; it opens the workspace only when started, in the effect below.
    const asks = gadget && new GadgetAsks(() => latestApi.current.openWorkspace(gadget.workspaceId), gadget.workpieceId, {
      chatId: gadget.chatId,
      connection: notice ?? undefined,
    })
    setCurrent({ key, asks })
  }
  const { asks } = current

  useEffect(() => {
    asks?.start()
    return () => asks?.stop()
  }, [asks])

  // Before the effect above, so that one made in the same commit starts on the new API.
  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    asks?.restart()
  }, [api, asks])

  const snapshot = useSyncExternalStore(asks?.subscribe ?? noSubscription, asks?.getSnapshot ?? loading)
  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const chat = chatInSight || chatId === undefined || !ready ? undefined : { chatId, targets: ready.targets }
  const asked: Ask[] = ready && workpieceId !== undefined
    ? ready.pending.filter((entry) => isAskOf(entry, { gadgetId: workpieceId, agents: ready.agents, chat }))
    : []

  return { asks, ready: ready !== undefined, asked, agents: ready?.agents ?? NO_AGENTS, vendors: ready?.vendors ?? NO_VENDORS }
}

const NO_AGENTS: ReadonlyMap<number, string | undefined> = new Map()
const NO_VENDORS: ReadonlyMap<number, string | undefined> = new Map()
