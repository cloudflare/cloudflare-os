import { findResourceType } from "@gadgets/workshop-shared/gatekeeper";
import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { CreationApproval, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { CreationAccountDialog, type CreationTarget } from './CreationAccountDialog'

/**
 * Approving a creation (see ActionLogEntry.creation) makes the resource in one of the approver's
 * own accounts for its vendor. This asks which (see CreationAccountDialog), opening the type's
 * configurator, if it has one, on the configuration the agent suggested, if any; its choice
 * becomes CreationApproval.configuration.
 */
export const CreationAccountModal = ({ overseer, gatekeeperId, onChoose, onCancel }: {
  overseer: RpcStub<Overseer>
  gatekeeperId: WorkpieceId
  onChoose: (creation: CreationApproval) => void
  onCancel: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [target, setTarget] = useState<CreationTarget | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const gatekeeper = await overseer.getGatekeeperById(gatekeeperId)
      try {
        const [spec, vendors] = await Promise.all(
          [gatekeeper.getCreationSpec(), authenticatedApi.listGatekeeperVendors()])
        const vendor = spec.type === 'gatekeeper' && vendors.find(v => v.id === spec.vendorId)
        if (!vendor || spec.type !== 'gatekeeper') throw new Error('This service is unavailable.')
        const resource =
          findResourceType(vendor.supportedResources, spec.resourceTypeId, spec.typeUrlPattern)
        if (!resource?.creatable) {
          throw new Error('This resource type is no longer available for creation.')
        }
        if (!cancelled) setTarget({ vendor, resource, configuration: spec.configuration })
      } finally {
        gatekeeper[Symbol.dispose]()
      }
    }
    load().catch(err => {
      if (cancelled) return
      console.error('Failed to load the creation:', err)
      toasts.add({ title: 'Failed to load the creation', variant: 'error' })
      onCancel()
    })
    return () => { cancelled = true }
  }, [overseer, gatekeeperId, authenticatedApi])

  return (
    <CreationAccountDialog
      title={target?.resource.creationConfigurator
        ? 'Choose where to create it'
        : 'Choose an account to create it in'}
      target={target}
      purpose="create"
      submitLabel="Approve"
      onSubmit={onChoose}
      onCancel={onCancel}
    />
  )
}
