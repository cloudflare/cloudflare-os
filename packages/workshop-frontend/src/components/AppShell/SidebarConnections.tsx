import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Tooltip } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import { logRpcFailure } from '../../rpcErrors'
import { PlusIcon } from '../icons/designIcons'

// The pill shows this many of the user's connected services; the Gatekeepers page lists them all.
const MAX_LOGOS = 3

type ConnectedVendor = { vendorId: string; name: string; logoUrl?: string }

/** The user's connected services, one per vendor, in the order they were first seen. */
const useConnectedVendors = (): ConnectedVendor[] => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [accounts, setAccounts] = useState(new Map<number, ConnectedVendor>())
  useEffect(() => {
    let active = true
    setAccounts(new Map())
    const adapter = new AccountsSubscriberAdapter({
      add: (event) => setAccounts(previous => {
        // Auto-provisioned accounts (the Context Library and the like) aren't services the user
        // connected, so they don't belong in the pill.
        if (event.vendor.autoProvisionsAccount) return previous
        const next = new Map(previous)
        next.set(event.id, { vendorId: event.vendorId, name: event.vendor.displayName, logoUrl: event.vendor.logo?.url })
        return next
      }),
      remove: (id) => setAccounts(previous => {
        if (!previous.has(id)) return previous
        const next = new Map(previous)
        next.delete(id)
        return next
      }),
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(
      adapter as unknown as RpcStub<ConnectedAccountsSubscriber>)
    subscription.catch(err => { if (active) logRpcFailure('Failed to subscribe to connected accounts:', err) })
    return () => {
      active = false
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])
  const byVendor = new Map<string, ConnectedVendor>()
  for (const account of accounts.values()) if (!byVendor.has(account.vendorId)) byVendor.set(account.vendorId, account)
  return [...byVendor.values()]
}

/**
 * The sidebar footer's connections pill (Figma "Round Btn" 107×34): a plus to connect a service,
 * then the logos of services already connected, overlapped like a stack of cards that fans out
 * when pointed at. It opens the Gatekeepers page.
 */
export const SidebarConnections = () => {
  const vendors = useConnectedVendors()
  const shown = vendors.slice(0, MAX_LOGOS)
  const more = vendors.length - shown.length
  const label = vendors.length
    ? `Gatekeepers: ${vendors.map(v => v.name).join(', ')}`
    : 'Connect a service'
  return (
    <Tooltip content={label} render={
      <Link
        to="/gatekeepers"
        aria-label={label}
        className="group/connections flex h-[34px] max-md:h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-kumo-base py-2.5 pl-1.5 pr-2 ring-1 ring-kumo-line transition-colors hover:bg-kumo-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
      >
        <span className="flex size-6 max-md:size-[30px] items-center justify-center rounded-full bg-kumo-tint text-kumo-subtle transition-colors group-hover/connections:text-kumo-default">
          <PlusIcon size={14} />
        </span>
        {shown.length > 0 && (
          <span className="flex items-center">
            {shown.map((vendor, index) => (
              <span
                key={vendor.vendorId}
                style={{ zIndex: shown.length - index }}
                // Each logo sits on its own outlined tile, whose edge tucks under the one before it
                // (the 2px halo in the pill's colour keeps them apart); pointing at the pill fans
                // them out. The overlap stays within the tile's padding, so no logo is covered.
                className={`relative flex size-[22px] shrink-0 items-center justify-center rounded-full bg-kumo-base shadow-[0_0_0_2px_var(--color-kumo-base)] ring-1 ring-inset ring-kumo-line group-hover/connections:shadow-[0_0_0_2px_var(--color-kumo-elevated)] motion-safe:transition-[margin] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${
                  index === 0 ? '' : '-ml-[3px] group-hover/connections:ml-1 group-focus-visible/connections:ml-1'
                }`}
              >
                {vendor.logoUrl
                  ? <img src={vendor.logoUrl} alt="" className="size-3 object-contain" />
                  : <span className="text-[10px] font-semibold text-kumo-default">{vendor.name.slice(0, 1).toUpperCase()}</span>}
              </span>
            ))}
            {more > 0 && (
              <span className="ml-1.5 text-[12px] font-medium leading-4 text-kumo-subtle">+{more}</span>
            )}
          </span>
        )}
      </Link>
    } />
  )
}
