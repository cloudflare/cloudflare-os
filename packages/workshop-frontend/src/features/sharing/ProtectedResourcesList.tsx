import { useEffect, useState } from 'react'
import { Tooltip } from '@cloudflare/kumo'
import { LockSimpleIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperVendorInfo, ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import Avatar from '../../components/Avatar'

type Props = {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const ProtectedResourcesList = ({ requirements, failed, authenticatedApi }: Props) => {
  const [vendors, setVendors] = useState<Map<string, GatekeeperVendorInfo>>(new Map())

  useEffect(() => {
    let cancelled = false
    Promise.all([
      authenticatedApi.listGatekeeperVendors(),
      authenticatedApi.listAddableGatekeepers(),
    ]).then(([connected, addable]) => {
      if (!cancelled) setVendors(new Map([...connected, ...addable].map(vendor => [vendor.id, vendor])))
    }).catch(error => {
      console.error('Failed to load protected resource vendors:', error)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  if (failed) {
    return <p role="status" className="text-sm text-kumo-subtle">Couldn’t check which connected systems viewers must have access to.</p>
  }
  if (requirements === null) {
    return <p role="status" className="text-sm text-kumo-subtle">Loading protected resources…</p>
  }
  if (requirements.length === 0) {
    return <p role="status" className="text-sm text-kumo-subtle">No connected systems require viewers to verify their own access.</p>
  }

  return (
    <ul aria-label="Protected resources" className="chat-panel min-h-0 space-y-1 overflow-y-auto overscroll-none rounded-xl border border-kumo-line bg-kumo-base p-1">
      {requirements.map(requirement => {
        const vendor = vendors.get(requirement.vendorId)
        return (
          <li key={requirement.gatekeeperId} className="flex items-center gap-3 hover:bg-kumo-elevated rounded-xl p-1.5">
            <Avatar
              src={vendor?.description.logo?.url}
              background={vendor?.description.color}
              size={42}
              className="rounded-xl!"
              fallback={<LockSimpleIcon size={16} />}
            />
            <div className="min-w-0 flex-1">
              {requirement.resourceUrl ? (
                <Tooltip
                  asChild
                  content={<span className="block max-w-xs break-all">{requirement.resourceUrl}</span>}
                >
                  <p tabIndex={0} className="truncate text-sm font-medium text-kumo-default">
                    {requirement.resourceTitle}
                  </p>
                </Tooltip>
              ) : (
                <p className="truncate text-sm font-medium text-kumo-default">{requirement.resourceTitle}</p>
              )}
              <p className="truncate text-xs text-kumo-subtle">
                {vendor?.description.displayName ?? requirement.vendorId}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
