import { useCallback, useRef, useState } from 'react'
import type { CreationApproval } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useConnectedAccounts } from './ConnectedAccountsContext'
import { creationAccountOf, type CreationTarget } from './creation'
import { ConnectResource } from './SetUpConnection'

type Service = { name: string; logoUrl?: string; resource?: SupportedResource }

/** A pending creation an agent asked for (`ActionLogEntry.creation`), as its card has it. */
export type CreationAction = {
  actionId: number
  /** The gatekeeper standing in for what is created, which says what it is (`getCreationSpec`). */
  gatekeeperId: number
  /** What the card says: "Create Google Doc: Weekly notes". */
  title: string
}

export type ApproveCreationOptions = {
  workspaceId: string
  /** Approves it as it is to be made, as approving anything else is, saying in the chat why it failed. */
  approve: (actionId: number, creation: CreationApproval) => Promise<void>
}

/**
 * Approving a creation makes it in one of the user's own accounts on its service. With only one
 * that can, it is made there at once, where the service puts what it makes (My Drive, for a Google
 * file); otherwise, or when the agent suggested where for the user to look over, `dialog` asks
 * which account, connecting one where there is none, and where, in the service's creation form.
 * `approve` resolves once it is made or asked.
 */
export const useApproveCreation = ({ workspaceId, approve }: ApproveCreationOptions) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const accounts = useConnectedAccounts()
  // Read when a card is approved, so `approveCreation` stays the same between renders.
  const latest = useRef(accounts)
  latest.current = accounts
  // The creation being asked about, with its service, kept as the dialog closes.
  const [asking, setAsking] = useState<{ action: CreationAction; target: CreationTarget; service: Service; open: boolean }>()

  const approveCreation = useCallback(async (action: CreationAction) => {
    if (connection?.blocked()) return
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    const gatekeeper = overseer.getGatekeeperById(action.gatekeeperId)
    let spec
    try {
      spec = await gatekeeper.getCreationSpec()
    } finally {
      gatekeeper[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
    if (spec.type !== 'gatekeeper') throw new Error('This can’t be created from here.')
    const target: CreationTarget = { vendorId: spec.vendorId, typeUrlPattern: spec.typeUrlPattern, configuration: spec.configuration }
    const known = latest.current
    const mine = known.status === 'ready' ? known.accounts : []
    const resources = mine.find(({ vendorId }) => vendorId === target.vendorId)?.supportedResources ?? []
    const accountId = creationAccountOf(mine, target, resources)
    if (accountId !== undefined) return approve(action.actionId, { accountId })
    // Only now is the service needed, for the dialog to name it when there is no account on it to.
    const vendor = (await api.listGatekeeperVendors()).find(({ id }) => id === target.vendorId)
    if (!vendor) throw new Error('This service isn’t offered here anymore.')
    const resource = vendor.supportedResources.find(({ urlPattern }) => urlPattern === target.typeUrlPattern)
    setAsking({ action, target, service: { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, resource }, open: true })
  }, [api, connection, workspaceId, approve])

  const resource = asking?.service.resource
  const dialog = asking && (
    <ConnectResource
      key={asking.action.actionId}
      open={asking.open}
      onOpenChange={(open) => setAsking((current) => current && { ...current, open })}
      service={{ vendorId: asking.target.vendorId, name: asking.service.name, logoUrl: asking.service.logoUrl }}
      resourceUrlPattern={asking.target.typeUrlPattern}
      resourceUrl={asking.target.configuration}
      scope={resource?.title}
      description={resource?.creationConfigurator ? 'Choose the account to create it in, and where.' : 'Choose the account to create it in.'}
      create={{
        title: asking.action.title,
        onCreate: async (accountId, configuration) => {
          const overseer = api.openWorkspace(workspaceId)
          try {
            await overseer.approveAction(asking.action.actionId, { accountId, configuration })
          } finally {
            overseer[Symbol.dispose]()
          }
        },
      }}
    />
  )
  return { approveCreation, dialog }
}
