import { useRef } from 'react'
import { fetchBackendVersion } from './versionChecks'
import { useSessionCheck } from './useSessionCheck'

/**
 * Reconnects a session whose WebSocket outlived a deploy. A deploy never moves a socket already
 * open, so its backend keeps answering until the socket breaks; new requests reach the new one.
 * `socketVersion` is what the socket's backend reports (ServerConfig.backendVersion), compared
 * on each session check with what a new request reaches. A session reconnects away from a given
 * version only once, ever, so a gradual rollout that lands new sockets and new requests on either
 * version cannot loop it.
 */
export const useStaleBackendReconnect = (
  socketVersion: string | undefined,
  connectionLost: boolean,
  onReconnect: () => void,
) => {
  const session = useRef({ socketVersion, connectionLost })
  session.current = { socketVersion, connectionLost }
  const checking = useRef(false)
  const reconnectedFrom = useRef(new Set<string>())

  // Read through the ref after the fetch too: the socket may have changed meanwhile.
  const isCheckable = (version: string | undefined): version is string =>
    version !== undefined && !session.current.connectionLost && !reconnectedFrom.current.has(version)

  useSessionCheck(() => {
    const version = session.current.socketVersion
    if (checking.current || !isCheckable(version)) return
    checking.current = true
    void fetchBackendVersion().then((latest) => {
      checking.current = false
      if (typeof latest !== 'string' || latest === version) return
      if (session.current.socketVersion !== version || !isCheckable(version)) return
      reconnectedFrom.current.add(version)
      onReconnect()
    })
  })
}
