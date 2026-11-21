import { useCallback, useRef, useState } from 'react'
import type { CreationApproval } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { creationAccountOf, creationKindOf } from './connectionList'
import { ConnectResource } from './SetUpConnection'
import { useConnections } from './useConnections'

/** A pending creation an agent asked for (`ActionLogEntry.creation`), as its card has it. */
export type CreationAction = {
  actionId: number
  /** What the card says: "Create Document: Weekly notes". */
  title: string
  /** The connection it creates, whose creation spec says what and on which service. */
  gatekeeperId: number
}

// What is being asked about, kept as the dialog closes so that it does not change as it goes.
type Asking = {
  action: CreationAction
  vendorId: string
  typeUrlPattern?: string
  name: string
  logoUrl?: string
  resource?: string
  /** What the agent suggested it be (the creation spec's `configuration`), which the form opens on. */
  configuration?: string
  open: boolean
}

/**
 * Approving a creation makes it in one of the user's own accounts on its service. With only one
 * that can, it is made there at once, where the service puts what it makes (My Drive, for a Google
 * file); otherwise `dialog` asks which account, connecting one where there is none, and, for a
 * kind with one, where, in the service's creation form. `approveCreation` resolves once it is
 * made or the dialog is asking, and rejects with why it could not be made at once.
 */
export const useApproveCreation = (workspaceId: string) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const { state } = useConnections()
  // Read when a card is approved, so that `approveCreation` stays the same between renders.
  const latest = useRef(state)
  latest.current = state
  const [asking, setAsking] = useState<Asking>()

  const approve = useCallback(async (actionId: number, creation: CreationApproval) => {
    const overseer = api.openWorkspace(workspaceId)
    try {
      await overseer.approveAction(actionId, creation)
    } finally {
      overseer[Symbol.dispose]()
    }
  }, [api, workspaceId])

  const approveCreation = useCallback(async (action: CreationAction) => {
    if (connection?.blocked()) return
    const overseer = api.openWorkspace(workspaceId)
    // Pipelined: the connection is asked what it creates as it is reached.
    const gatekeeper = overseer.getGatekeeperById(action.gatekeeperId)
    let spec
    try {
      spec = await gatekeeper.getCreationSpec()
    } finally {
      gatekeeper[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
    if (spec.type !== 'gatekeeper') throw new Error('This isn’t something a service makes.')
    const { vendorId, configuration } = spec
    // One queued before stable type ids names its kind by its pattern alone.
    const resourceTypeId = spec.resourceTypeId ?? spec.typeUrlPattern
    const known = latest.current
    const listed = known.status === 'ready' ? known.connections.filter((each) => each.vendorId === vendorId) : []
    const accounts = listed.flatMap((each) => (each.kind === 'account' ? [each.account] : []))
    const kind = listed[0] && creationKindOf(listed[0].resources, resourceTypeId)
    // Where it goes is the user's to choose, in a form of the service's, so that is always asked.
    const accountId = kind?.creationConfigurator ? undefined : creationAccountOf(accounts, vendorId, resourceTypeId)
    if (accountId !== undefined) return approve(action.actionId, { accountId })
    const vendor = listed[0]?.vendor
    if (!vendor) throw new Error('This service isn’t offered here anymore.')
    setAsking({ action, vendorId, typeUrlPattern: kind?.urlPattern, name: vendor.displayName, logoUrl: vendor.logo?.url, resource: kind?.title, configuration, open: true })
  }, [api, workspaceId, connection, approve])

  const dialog = asking && (
    <ConnectResource
      key={asking.action.actionId}
      open={asking.open}
      onOpenChange={(open) => setAsking((current) => current && { ...current, open })}
      vendorId={asking.vendorId}
      name={asking.name}
      logoUrl={asking.logoUrl}
      resourceUrlPattern={asking.typeUrlPattern}
      resource={asking.resource}
      resourceUrl={asking.configuration}
      create={{
        title: asking.action.title,
        onCreate: (accountId, configuration) => approve(asking.action.actionId, { accountId, configuration }),
      }}
    />
  )
  return { approveCreation, dialog }
}
