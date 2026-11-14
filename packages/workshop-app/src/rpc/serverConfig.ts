import { useEffect, useState } from 'react'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { sharedConnection } from './sharedConnection'

// Read once for the page: it says how the deployment is set up, which a session does not change.
let config: Promise<ServerConfig> | undefined
let known: ServerConfig | undefined

const read = (): Promise<ServerConfig> | undefined => {
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
 * people can be searched. Unknown until it has been read, which it is the first time it is asked for.
 */
export const useServerConfig = (): ServerConfig | undefined => {
  const [value, setValue] = useState(known)
  useEffect(() => {
    if (value) return
    let cancelled = false
    read()?.then((next) => { if (!cancelled) setValue(next) }, () => {})
    return () => {
      cancelled = true
    }
  }, [value])
  return value
}
