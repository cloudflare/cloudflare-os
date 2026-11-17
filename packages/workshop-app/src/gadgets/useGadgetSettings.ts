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

/** What a gadget's blueprint says of itself: its title, and what it is for. */
export type BlueprintInfo = { title: string; description?: string }

/**
 * What a blueprint says it is, which anyone may read (`PublicApi.getBlueprint()`): for the gadget
 * made from it. Nothing until it is known, and for no blueprint.
 */
export const useBlueprintInfo = (blueprintId: string | undefined) => {
  const connection = sharedConnection()
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const [found, setFound] = useState<{ id: string; info?: BlueprintInfo }>()
  useEffect(() => {
    if (!blueprintId || !publicApi) return
    let current = true
    publicApi.getBlueprint(blueprintId).then(
      (blueprint) => {
        if (current) setFound({ id: blueprintId, info: blueprint ? { title: blueprint.metadata.title, description: blueprint.metadata.description || undefined } : undefined })
      },
      // It only says more of the gadget, which shows without it.
      () => {},
    )
    return () => {
      current = false
    }
  }, [blueprintId, publicApi])
  return found && found.id === blueprintId ? found.info : undefined
}

/** A service a gadget is bound through, as its row draws it. */
export type BindingService = { name: string; logoUrl?: string; color?: string }

/**
 * The services the deployment offers, by id, for the rows of what a gadget is bound to: their
 * names and logos. Empty until read, and if they cannot be, as each row says what it reaches
 * without them.
 */
export const useServices = (): ReadonlyMap<string, BindingService> => {
  const { api, reconnecting } = useApi()
  const [services, setServices] = useState<ReadonlyMap<string, BindingService>>(new Map())
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let current = true
    api.listGatekeeperVendors().then(
      (vendors) => {
        if (current) setServices(new Map(vendors.map(({ id, description }) => [id, { name: description.displayName || id, logoUrl: description.logo?.url, color: description.color }])))
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [api, reconnecting])
  return services
}
