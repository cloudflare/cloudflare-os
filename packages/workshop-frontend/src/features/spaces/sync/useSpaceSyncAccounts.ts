import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../../../AuthContext'
import { AccountsSubscriberAdapter, type AccountEvent } from '../../../accountsSubscriber'
import { useUiFeatureFlag } from '../../../FeatureFlagsContext'
import { logRpcFailure } from '../../../rpcErrors'

/** One of the user's connected accounts that can sync a source into a space. */
export type SpaceSyncAccount = {
  id: number
  /** The account's own name, as the Connections page shows it. */
  label: string
  /** The display name of the account's vendor: the source system a sync reads. */
  vendorName: string
  /** The id of the account's vendor. */
  vendorId: string
  /**
   * The bundled blueprint its syncs create workspaces from (`providesSpaceSync.blueprintId`),
   * whose declared publication is the one every workspace they create is published with.
   */
  blueprintId: string
  /** False when the account's credentials are known to have expired and it needs reconnecting. */
  credentialsValid: boolean
  /**
   * The resource types its configurator can pick a source from: those it supports that are not
   * separately grantable or that the account has been granted.
   */
  resources: SupportedResource[]
}

const toSyncAccount = (
  { id, description, vendor, supportedResources, credentialsValid, vendorId }: AccountEvent,
  blueprintId: string,
): SpaceSyncAccount => {
  // Undefined for an account that predates grant tracking, which has every resource.
  const granted = description.grantedResourceUrlPatterns
  return {
    id,
    label: description.displayName ?? description.uniqueName ?? vendor.displayName,
    vendorName: vendor.displayName,
    vendorId,
    blueprintId,
    credentialsValid,
    resources: supportedResources.filter(resource =>
      !resource.grantable || granted === undefined || granted.includes(resource.urlPattern)),
  }
}

/**
 * How a sync action names its source: the vendor of the accounts that can sync, or a generic name
 * when they belong to several vendors.
 */
export const syncSourceName = (accounts: readonly SpaceSyncAccount[]): string => {
  const vendors = new Set(accounts.map(account => account.vendorName))
  return vendors.size === 1 ? [...vendors][0] : 'a connected account'
}

type Subscribed = {
  api: RpcStub<AuthenticatedApi>
  accounts: ReadonlyMap<number, SpaceSyncAccount>
  ready: boolean
}

/**
 * The user's connected accounts whose description declares `providesSpaceSync`, kept current by
 * the connected-accounts subscription the rest of the Workshop uses. `ready` turns true once the
 * accounts connected at the time have all arrived, or the subscription failed and none will.
 * Subscribes only while the `spaces` flag is on.
 */
export const useSpaceSyncAccounts = (): { accounts: SpaceSyncAccount[]; ready: boolean } => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [subscribed, setSubscribed] = useState<Subscribed | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Applies a change to this subscription's own state.
    const update = (change: (previous: Subscribed) => Subscribed) => {
      if (cancelled) return
      setSubscribed(previous => change(previous?.api === authenticatedApi
        ? previous
        : { api: authenticatedApi, accounts: new Map(), ready: false }))
    }
    const without = (previous: Subscribed, id: number) => {
      if (!previous.accounts.has(id)) return previous
      const accounts = new Map(previous.accounts)
      accounts.delete(id)
      return { ...previous, accounts }
    }

    const subscriber = new AccountsSubscriberAdapter({
      // An upsert: a replayed account whose description no longer declares the capability goes.
      add(event) {
        const sync = event.description.providesSpaceSync
        update(previous => sync
          ? { ...previous, accounts: new Map(previous.accounts).set(event.id, toSyncAccount(event, sync.blueprintId)) }
          : without(previous, event.id))
      },
      remove(id) {
        update(previous => without(previous, id))
      },
      ready() {
        update(previous => previous.ready ? previous : { ...previous, ready: true })
      },
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch(err => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
      update(previous => ({ ...previous, ready: true }))
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
      // The next subscription, for this session or another, starts from nothing: an account
      // removed in between would otherwise never be dropped.
      setSubscribed(null)
    }
  }, [authenticatedApi, enabled])

  const current = enabled && subscribed?.api === authenticatedApi ? subscribed : null
  return { accounts: current ? [...current.accounts.values()] : [], ready: current?.ready ?? false }
}
