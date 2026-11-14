import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { sharedConnection } from '@/rpc/sharedConnection'
import { GadgetSettings } from './GadgetSettings'

/**
 * One gadget's settings (`GadgetSettings`), live while mounted; the caller keys it by the gadget.
 * A new API, from a new connection, opens its workspace again, keeping what is shown meanwhile.
 */
export const useGadgetSettings = (workspaceId: string, workpieceId: number) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  // The API it opens the workspace with, read when it does.
  const latestApi = useRef(api)
  const [settings] = useState(() => new GadgetSettings(() => latestApi.current.openWorkspace(workspaceId), workpieceId, { connection: notice ?? undefined }))

  useEffect(() => {
    settings.start()
    return () => settings.stop()
  }, [settings])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    settings.restart()
  }, [api, settings])

  return { settings, snapshot: useSyncExternalStore(settings.subscribe, settings.getSnapshot) }
}

/**
 * What a blueprint says it is for, which anyone may read (`PublicApi.getBlueprint()`): for the
 * gadget made from it. Nothing until it is known, and for no blueprint.
 */
export const useBlueprintDescription = (blueprintId: string | undefined) => {
  const connection = sharedConnection()
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const [found, setFound] = useState<{ id: string; description?: string }>()
  useEffect(() => {
    if (!blueprintId || !publicApi) return
    let current = true
    publicApi.getBlueprint(blueprintId).then(
      (blueprint) => {
        if (current) setFound({ id: blueprintId, description: blueprint?.metadata.description || undefined })
      },
      // It only says more of the gadget, which shows without it.
      () => {},
    )
    return () => {
      current = false
    }
  }, [blueprintId, publicApi])
  return found && found.id === blueprintId ? found.description : undefined
}
