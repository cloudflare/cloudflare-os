import { useEffect, useRef, useState } from 'react'
import { useHandler } from '@/hooks/useHandler'
import { useApi } from '@/rpc/ApiContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { browserPushEnabled, browserPushSupport, disableBrowserPush, enableBrowserPush, syncBrowserPush, type BrowserPushSupport } from './browserPush'

/**
 * Keeps this browser's notifications with the signed-in user (`syncBrowserPush`), once for each user
 * and key in a page's life, and opens the address a notification clicked names (`onOpen`), which
 * the service worker sends to the most recently used tab.
 */
export const useBrowserPushSync = (onOpen: (path: string) => void) => {
  const { api, user, reconnecting } = useApi()
  const publicKey = useServerConfig()?.webPushPublicKey
  const synced = useRef<string>(undefined)
  const open = useHandler(onOpen)

  useEffect(() => {
    // Not for each new connection: each costs the service a registration. A failed one is tried
    // again with the next, or a tab left open would stay unregistered.
    if (reconnecting || !publicKey || browserPushSupport() !== 'supported') return
    const target = `${user.id}\n${publicKey}`
    if (synced.current === target) return
    synced.current = target
    syncBrowserPush(api, user.id, publicKey).catch(() => {
      if (synced.current === target) synced.current = undefined
    })
  }, [api, user.id, publicKey, reconnecting])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'cloudflare-os:open-notification' && 'path' in data && typeof data.path === 'string') {
        open(data.path)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [open])
}

/**
 * Whether this browser shows the user's notifications while no tab is in view, as far as it is
 * known: `loading` until it has been read, then `on`, `off`, or `blocked` by the browser.
 */
export type BrowserPushStatus = 'loading' | 'on' | 'off' | 'blocked'

const readStatus = async (userId: string): Promise<BrowserPushStatus> =>
  Notification.permission === 'denied' ? 'blocked' : (await browserPushEnabled(userId)) ? 'on' : 'off'

/**
 * This browser's notifications, for the settings: whether the deployment and the browser can have
 * them (`available`, and `support` says why not), whether they are on, and the way to turn them on
 * or off, which rejects with why it could not be done.
 */
export const useBrowserPushSetting = (): {
  available: boolean
  support: BrowserPushSupport
  status: BrowserPushStatus
  pending: boolean
  setOn: (on: boolean) => Promise<void>
} => {
  const { api, user } = useApi()
  const publicKey = useServerConfig()?.webPushPublicKey
  const [support] = useState(browserPushSupport)
  const [status, setStatus] = useState<BrowserPushStatus>('loading')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!publicKey || support !== 'supported') return
    let cancelled = false
    void readStatus(user.id).then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [user.id, publicKey, support])

  const setOn = async (on: boolean) => {
    if (!publicKey) return
    setPending(true)
    try {
      if (on) {
        // First, so that the browser's question still has the click.
        const permission = await enableBrowserPush(api, user.id, publicKey)
        setStatus(permission === 'granted' ? 'on' : permission === 'denied' ? 'blocked' : 'off')
      } else {
        await disableBrowserPush()
        setStatus('off')
      }
    } catch (error) {
      setStatus(await readStatus(user.id))
      throw error
    } finally {
      setPending(false)
    }
  }

  return { available: publicKey !== undefined && support !== 'unsupported', support, status, pending, setOn }
}
