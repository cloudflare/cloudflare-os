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

/** How often settings left open on a shown tab read the template's release again. */
const BLUEPRINT_RECHECK_INTERVAL_MS = 60_000

/**
 * The template description and release as published in KV. Undefined until it is read (or there
 * is no upstream to read); null for an upstream that no longer exists. Keep what was read while
 * reconnecting or refreshing, and read again when the gadget takes a release. Nothing says when
 * a template is released, so while mounted it also reads again as the window is focused and
 * every minute the tab is shown, never while a read is still under way.
 */
export const useBlueprintInfo = (blueprintId: string | undefined, release: string | undefined) => {
  const publicApi = useTemplateReader()
  const { reconnecting } = useApi()
  const [found, setFound] = useState<{ id: string; info: BlueprintInfo | null }>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!blueprintId || !publicApi || reconnecting) return
    let current = true
    let reading = false
    const read = () => {
      if (reading) return
      reading = true
      publicApi.getBlueprint(blueprintId).then(
        (blueprint) => {
          reading = false
          if (!current) return
          if (!blueprint) {
            setFound({ id: blueprintId, info: null })
            return
          }
          const { title, description, version, commitId } = blueprint.metadata
          setFound({ id: blueprintId, info: { title: title || 'Untitled template', description: description || undefined, version, commitId } })
        },
        // The gadget settings still work without this extra information.
        () => {
          reading = false
        },
      )
    }
    const recheck = () => {
      if (document.visibilityState !== 'hidden') read()
    }
    read()
    window.addEventListener('focus', recheck)
    const interval = setInterval(recheck, BLUEPRINT_RECHECK_INTERVAL_MS)
    return () => {
      current = false
      window.removeEventListener('focus', recheck)
      clearInterval(interval)
    }
  }, [blueprintId, release, publicApi, reconnecting, revision])
  return { info: found?.id === blueprintId ? found?.info : undefined, refresh: () => setRevision((was) => was + 1) }
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
