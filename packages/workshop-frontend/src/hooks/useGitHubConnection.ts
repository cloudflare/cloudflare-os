import { useEffect, useState } from 'react'
import type { RpcPromise } from 'capnweb'
import { useAuthenticatedApi } from '../AuthContext'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'

export type GitHubConnectionState =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'connected'; accountId: number; label: string }
  | { state: 'expired'; accountId: number; label: string }

export function useGitHubConnection(): GitHubConnectionState {
  const { authenticatedApi } = useAuthenticatedApi()
  const [status, setStatus] = useState<{ api: unknown; value: GitHubConnectionState }>(() => ({
    api: authenticatedApi,
    value: { state: 'loading' },
  }))

  useEffect(() => {
    let cancelled = false
    let subscription: { [Symbol.dispose](): void } | null = null
    const accounts = new Map<number, { label: string; valid: boolean }>()
    setStatus({ api: authenticatedApi, value: { state: 'loading' } })

    const publish = (ready = false) => {
      if (cancelled) return
      const valid = [...accounts].find(([, account]) => account.valid)
      if (valid) {
        setStatus({ api: authenticatedApi, value: { state: 'connected', accountId: valid[0], label: valid[1].label } })
        return
      }
      const expired = accounts.entries().next().value as [number, { label: string; valid: boolean }] | undefined
      if (expired) {
        setStatus({ api: authenticatedApi, value: { state: 'expired', accountId: expired[0], label: expired[1].label } })
      } else if (ready) {
        setStatus({ api: authenticatedApi, value: { state: 'missing' } })
      }
    }

    const subscriptionPromise = authenticatedApi.subscribeConnectedAccounts(
      new AccountsSubscriberAdapter({
        add(event: AccountEvent) {
          if (event.vendorId !== 'github') return
          accounts.set(event.id, {
            label: event.description.uniqueName ?? event.description.displayName ?? event.vendor.displayName,
            valid: event.credentialsValid,
          })
          publish()
        },
        remove(id: number) {
          accounts.delete(id)
          publish(true)
        },
        ready() {
          publish(true)
        },
      }),
    ) as unknown as RpcPromise<{}>
    subscriptionPromise.then((stub) => {
      if (cancelled) stub[Symbol.dispose]()
      else subscription = stub
    }).catch(() => {
      if (!cancelled) setStatus({ api: authenticatedApi, value: { state: 'missing' } })
    })

    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  return status.api === authenticatedApi ? status.value : { state: 'loading' }
}
