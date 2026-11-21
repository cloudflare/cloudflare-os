import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import type { Connection } from './Connection'
import { PageUpdates, StaleBackend } from './staleSession'
import { useSessionCheck } from './useSessionCheck'
import { fetchVersions } from './versionChecks'

/**
 * Makes `connection` again once its socket has outlived a deploy (`StaleBackend`): each socket is
 * asked which backend it reached (`ServerConfig.backendVersion`), which is compared on each
 * session check with what a new request reaches. Making it again is what a drop does, which
 * `RpcGate` rides out with everything left as it is.
 */
export const useStaleBackendReconnect = (connection: Connection) => {
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  // With the socket it is for, as the next one's is not known until it has answered. (An object,
  // as a stub in useState would be called as an updater.)
  const [answered, setAnswered] = useState<{ socket: RpcStub<PublicApi>; version: string | undefined }>()
  const [stale] = useState(() => new StaleBackend())
  const version = answered?.socket === publicApi ? answered.version : undefined
  const current = useRef(version)
  useEffect(() => {
    current.current = version
  })
  const checking = useRef(false)

  useEffect(() => {
    if (!publicApi) return
    let cancelled = false
    publicApi.getServerConfig().then(({ backendVersion }) => {
      if (!cancelled) setAnswered({ socket: publicApi, version: backendVersion })
    }, () => {})
    return () => {
      cancelled = true
    }
  }, [publicApi])

  useSessionCheck(() => {
    const at = current.current
    if (checking.current || at === undefined || stale.hasLeft(at)) return
    checking.current = true
    void fetchVersions().then(({ backend }) => {
      checking.current = false
      // Not for a socket that has been replaced meanwhile.
      if (current.current === at && stale.leave(at, backend)) connection.reconnect()
    })
  })
}

/**
 * Whether to say that a fresh load would get a newer app than this page runs (`PageUpdates`): the
 * build id this page was built with against the one `VERSION_PATH` answers, on each session check.
 * The page is never reloaded for the user, which could lose what they were writing: they are told,
 * and choose.
 */
export const usePageUpdate = (): { available: boolean; dismiss: () => void } => {
  const [updates] = useState(() => new PageUpdates())
  const [available, setAvailable] = useState(false)
  const checking = useRef(false)

  useSessionCheck(() => {
    const own = import.meta.env.ASSETS_BUILD_ID
    if (checking.current || own === undefined) return
    checking.current = true
    void fetchVersions().then(({ assets }) => {
      checking.current = false
      if (updates.newer(own, assets)) setAvailable(true)
    })
  })

  return { available, dismiss: () => setAvailable(false) }
}
