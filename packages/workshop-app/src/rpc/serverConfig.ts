import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { sharedConnection } from './sharedConnection'

// Read once for the page: it says how the deployment is set up, which a session does not change.
let config: Promise<ServerConfig> | undefined
let known: ServerConfig | undefined

/**
 * How the deployment is set up (`PublicApi.getServerConfig`), read the first time it is asked for,
 * and undefined while there is no connection to read it over. One that could not be read is read
 * again when it is next asked for.
 */
export const readServerConfig = (): Promise<ServerConfig> | undefined => {
  if (config) return config
  const { publicApi } = sharedConnection().getSnapshot()
  if (!publicApi) return undefined
  config = publicApi.getServerConfig().then(
    (value) => (known = value),
    (error: unknown) => {
      // Asked again by whoever needs it next.
      config = undefined
      throw error
    },
  )
  return config
}

/**
 * How the deployment is set up (`PublicApi.getServerConfig`): what it calls itself, whether its
 * people can be searched. Unknown until it has been read, which it is the first time it is asked
 * for, once there is a connection to read it over.
 */
export const useServerConfig = (): ServerConfig | undefined => {
  const connection = sharedConnection()
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const [value, setValue] = useState(known)
  useEffect(() => {
    if (value || !publicApi) return
    let cancelled = false
    readServerConfig()?.then((next) => { if (!cancelled) setValue(next) }, () => {})
    return () => {
      cancelled = true
    }
  }, [value, publicApi])
  return value
}
