import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, type AccountEvent } from '../../accountsSubscriber'
import { openConnectWindow } from '../../connectHandoff'
import { reportIssue } from '../../errorReporting'
import { logRpcFailure } from '../../rpcErrors'
import { AuthPopupCancelledError } from '../native-app/authPopup'

/** One of the user's accounts that this workspace's connections use and that needs signing in. */
export type SignInAccount = {
  id: number
  vendorName: string
  logoUrl?: string
  color?: string
  /** The name the account signs in with, such as an email address. */
  identity?: string
  /** The workspace's connections that use the account. */
  connections: { target: WorkpieceId; resourceTitle: string }[]
  /** `waiting` while the sign-in window this view opened is still out. */
  phase: 'signedOut' | 'waiting'
}

export type AccountSignIn = {
  accounts: SignInAccount[]
  onSignIn: (accountId: number) => void
  onCancel: () => void
}

type ConnectionsByAccount = Map<number, SignInAccount['connections']>

/**
 * The user's signed-out accounts that the open workspace depends on, and the flow to sign back in.
 * Sign-in state arrives live from the connected-accounts subscription; which accounts the
 * workspace uses is read only while one of them is signed out.
 */
export const useAccountSignIn = (
  overseer: RpcStub<Overseer> | undefined,
  authenticatedApi: RpcStub<AuthenticatedApi>,
): AccountSignIn => {
  const [accounts, setAccounts] = useState<Map<number, AccountEvent>>(new Map())
  const [connections, setConnections] = useState<ConnectionsByAccount>(new Map())
  const [waitingId, setWaitingId] = useState<number | null>(null)
  const toasts = useKumoToastManager()

  useEffect(() => {
    let cancelled = false
    const subscriber = new AccountsSubscriberAdapter({
      add(account) {
        setAccounts((prev) => new Map(prev).set(account.id, account))
        if (account.credentialsValid) setWaitingId((prev) => (prev === account.id ? null : prev))
      },
      remove(id) {
        setAccounts((prev) => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      },
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((error) => {
      if (!cancelled) logRpcFailure('Failed to subscribe to connected accounts:', error)
    })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const signedOutKey = [...accounts.values()]
    .filter((account) => !account.credentialsValid)
    .map((account) => account.id)
    .toSorted((a, b) => a - b)
    .join(',')

  useEffect(() => {
    if (!overseer || signedOutKey === '') return
    let cancelled = false
    overseer.listAccountConnections().then((list) => {
      if (cancelled) return
      const next: ConnectionsByAccount = new Map()
      for (const { accountId, target, resourceTitle } of list) {
        next.set(accountId, [...(next.get(accountId) ?? []), { target, resourceTitle }])
      }
      setConnections(next)
    }, (error) => {
      if (!cancelled) logRpcFailure('Failed to list account connections:', error)
    })
    return () => {
      cancelled = true
    }
  }, [overseer, signedOutKey])

  const onSignIn = async (accountId: number) => {
    setWaitingId(accountId)
    try {
      await openConnectWindow(await authenticatedApi.reconnectAccount(accountId), authenticatedApi)
    } catch (error) {
      setWaitingId(null)
      if (error instanceof AuthPopupCancelledError) return
      console.error('Failed to start sign-in:', error)
      reportIssue('connection-sign-in.start', error, {
        gatekeeperVendorId: accounts.get(accountId)?.vendorId,
      })
      toasts.add({
        title: error instanceof Error ? error.message : 'Could not open the sign-in window',
        variant: 'error',
      })
    }
  }

  const listed: SignInAccount[] = []
  for (const [accountId, accountConnections] of connections) {
    const account = accounts.get(accountId)
    if (!account || account.credentialsValid) continue
    listed.push({
      id: accountId,
      vendorName: account.vendor.displayName,
      logoUrl: account.vendor.logo?.url,
      color: account.vendor.color,
      identity: account.description.uniqueName || account.description.displayName,
      connections: accountConnections,
      phase: waitingId === accountId ? 'waiting' : 'signedOut',
    })
  }

  return {
    accounts: listed,
    onSignIn: (accountId) => { void onSignIn(accountId) },
    onCancel: () => setWaitingId(null),
  }
}
