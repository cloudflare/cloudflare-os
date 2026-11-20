import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { OutputsFeed } from './OutputsFeed'
import { OutputsFeedContext } from './OutputsFeedContext'

/**
 * Keeps the library live for everything beneath it (`useLibrary`): one
 * subscription for the whole app, made again on each new connection without clearing the feed.
 */
export const OutputsFeedProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [feed] = useState(() => new OutputsFeed())
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    feed.start({ subscribe: (listener) => api.subscribeToOutputs(listener) })
    return () => feed.stop()
  }, [api, reconnecting, feed])
  return <OutputsFeedContext value={feed}>{children}</OutputsFeedContext>
}
