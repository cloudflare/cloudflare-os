import { useRef } from 'react'
import { fetchBackendVersion } from './versionChecks'
import { useSessionCheck } from './useSessionCheck'

/**
 * Reconnects a session whose WebSocket outlived a deploy. A deploy never moves a socket already
 * open, so its backend keeps answering until the socket breaks; new requests reach the new one.
 * `socketVersion` is what the current socket's backend reports (ServerConfig.backendVersion),
 * undefined while it has not answered, and is compared on each session check with what a new
 * request reaches. A session reconnects away from a given
 * version only once, ever, so a gradual rollout that lands new sockets and new requests on either
 * version cannot loop it.
 */
export const useStaleBackendReconnect = (
  socketVersion: string | undefined,
  onReconnect: () => void,
) => {
  const currentVersion = useRef(socketVersion)
  currentVersion.current = socketVersion
  const checking = useRef(false)
  const reconnectedFrom = useRef(new Set<string>())

  useSessionCheck(() => {
    const version = currentVersion.current
    if (checking.current || version === undefined || reconnectedFrom.current.has(version)) return
    checking.current = true
    void fetchBackendVersion().then((latest) => {
      checking.current = false
      if (typeof latest !== 'string' || latest === version) return
      // The socket may have changed during the fetch.
      if (currentVersion.current !== version) return
      reconnectedFrom.current.add(version)
      onReconnect()
    })
  })
}
