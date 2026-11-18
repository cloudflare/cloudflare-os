import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useTemplateReader } from '@/rpc/PublicApiContext'
import { GadgetSettings } from './GadgetSettings'
import type { TemplateRelease } from './templateUpdate'

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
 * What a gadget's blueprint says of itself: its title, what it is for, and its release as it now
 * stands, which says whether the gadget has an update to take (`templateUpdateStatus`).
 */
export type BlueprintInfo = { title: string; description?: string } & TemplateRelease

/**
 * What a blueprint says it is, which anyone may read (`PublicApi.getBlueprint()`): for the gadget
 * made from it. Undefined until it is known, and for no blueprint; null for one that is no longer
 * there. Read again when `release` changes, which is the gadget taking an update: nothing says a
 * template was published again, which is noticed then or once the page is opened again.
 */
export const useBlueprintInfo = (blueprintId: string | undefined, release?: string) => {
  const publicApi = useTemplateReader()
  const [found, setFound] = useState<{ id: string; info: BlueprintInfo | null }>()
  useEffect(() => {
    if (!blueprintId || !publicApi) return
    let current = true
    publicApi.getBlueprint(blueprintId).then(
      (blueprint) => {
        if (!current) return
        const { title, description, version, commitId } = blueprint?.metadata ?? {}
        setFound({ id: blueprintId, info: blueprint ? { title: title || 'Untitled template', description: description || undefined, version: version ?? 0, ...(commitId ? { commitId } : {}) } : null })
      },
      // It only says more of the gadget, which shows without it.
      () => {},
    )
    return () => {
      current = false
    }
  }, [blueprintId, release, publicApi])
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
