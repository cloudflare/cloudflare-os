import { useEffect, useState } from 'react'
import type { CloudflareAccountOption, CloudflareUsageInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { messageOf } from './useAttempt'

export type UsageState =
  | { status: 'loading' }
  | {
      status: 'ready'
      usage: CloudflareUsageInfo
      /** The accounts there are to bill, once read, where one has to be chosen. */
      accounts?: CloudflareAccountOption[]
    }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * What the user has used of their allowance, and the Cloudflare account that pays for the rest.
 * Read again when the window is come back to, as connecting an account and adding credits both
 * happen in another, and whenever `refresh` is called. Nothing is read while it is not `enabled`,
 * and what was read is read again each time it becomes so.
 */
export const useUsage = (enabled = true) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<UsageState>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const refresh = () => setReads((count) => count + 1)

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => setReads((count) => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting || !enabled) return
    let cancelled = false
    const read = async (): Promise<UsageState> => {
      const usage = await api.getCloudflareUsage()
      const choosing = usage.connected && usage.needsAccountSelection
      return { status: 'ready', usage, accounts: choosing ? await api.listCloudflareAccounts() : undefined }
    }
    read().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      (error) => {
        if (cancelled) return
        // What was shown stays up when it could not be read again.
        setState((current) => (current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry: () => setReads((count) => count + 1) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, reads, enabled])

  return { state, refresh }
}
