import { useEffect, useState } from 'react'
import { Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  ConnectFlowStart, GatekeeperVendorInfo, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'
import { openConnectWindow } from '../connectHandoff'
import { AccountChooser } from '../gatekeeper-modal/AccountChooser'
import { WorkshopButton } from './WorkshopControls'

type CreationTarget = { vendor: GatekeeperVendorInfo; typeUrlPattern: string }

// The popup flow whose start request is in flight.
type StartingFlow = { kind: 'connect' } | { kind: 'reconnect' | 'grant'; accountId: number }

/**
 * Approving a creation (see ActionLogEntry.creation) makes the resource in one of the approver's
 * own accounts for its vendor. This asks which, and offers to connect one.
 */
export const CreationAccountModal = ({ overseer, gatekeeperId, onChoose, onCancel }: {
  overseer: RpcStub<Overseer>
  gatekeeperId: WorkpieceId
  onChoose: (accountId: number) => void
  onCancel: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [target, setTarget] = useState<CreationTarget | null>(null)
  const [accounts, setAccounts] = useState<AccountEvent[]>([])
  const [ready, setReady] = useState(false)
  const [chosen, setChosen] = useState<number>()
  const [starting, setStarting] = useState<StartingFlow | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const gatekeeper = await overseer.getGatekeeperById(gatekeeperId)
      try {
        const [spec, vendors] = await Promise.all(
          [gatekeeper.getCreationSpec(), authenticatedApi.listGatekeeperVendors()])
        const vendor = spec.type === 'gatekeeper' && vendors.find(v => v.id === spec.vendorId)
        if (!vendor || spec.type !== 'gatekeeper') throw new Error('This service is unavailable.')
        if (!cancelled) setTarget({ vendor, typeUrlPattern: spec.typeUrlPattern })
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

  useEffect(() => {
    let cancelled = false
    const subscription = authenticatedApi.subscribeConnectedAccounts(new AccountsSubscriberAdapter({
      add(account) {
        if (!cancelled) setAccounts(prev => [...prev.filter(a => a.id !== account.id), account])
      },
      remove(id) {
        if (!cancelled) setAccounts(prev => prev.filter(a => a.id !== id))
      },
      ready() {
        if (!cancelled) setReady(true)
      },
    }))
    subscription.catch(err => {
      if (cancelled) return
      console.error('Failed to subscribe to connected accounts:', err)
      toasts.add({ title: 'Failed to load your connected accounts', variant: 'error' })
    })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // The popup redeems the flow itself; a new or restored account arrives through the subscription.
  const startFlow = async (flow: StartingFlow, start: () => Promise<ConnectFlowStart | null>) => {
    setStarting(flow)
    try {
      const started = await start()
      if (started) openConnectWindow(started)
    } catch (err) {
      console.error('Failed to start connection flow:', err)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setStarting(null)
    }
  }

  const matching = target ? accounts.filter(a => a.vendorId === target.vendor.id) : []
  // A separately grantable type needs its grant on the account the resource is created in.
  const required = target?.vendor.supportedResources
    .some(r => r.urlPattern === target.typeUrlPattern && r.grantable) ? [target.typeUrlPattern] : []
  const usable = (account: AccountEvent) => account.credentialsValid &&
    required.every(p => account.description.grantedResourceUrlPatterns?.includes(p) ?? true)
  const selected = matching.find(a => a.id === chosen) ?? matching.find(usable)

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !-translate-y-0 flex-col overflow-hidden p-0 sm:w-[480px]" size="base">
        <Dialog.Title className="shrink-0 px-6 pt-6 text-lg font-semibold">
          Choose an account to create it in
        </Dialog.Title>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!target || !ready ? (
            <div className="flex justify-center py-6"><Loader size="base" /></div>
          ) : (
            <AccountChooser
              accounts={matching.map(a => ({ ...a, vendorDescription: a.vendor }))}
              selectedAccountId={selected?.id ?? null}
              vendorName={target.vendor.description.displayName}
              connecting={starting?.kind === 'connect'}
              reconnectingAccountId={starting?.kind === 'reconnect' ? starting.accountId : null}
              requiredResourceUrlPatterns={required}
              grantingAccountId={starting?.kind === 'grant' ? starting.accountId : null}
              onSelect={setChosen}
              onConnect={() => void startFlow({ kind: 'connect' }, () =>
                authenticatedApi.connectAccount(
                  target.vendor.id, required.length > 0 ? required : undefined))}
              onReconnect={accountId => void startFlow({ kind: 'reconnect', accountId }, () =>
                authenticatedApi.reconnectAccount(accountId))}
              onGrantAccess={accountId => void startFlow({ kind: 'grant', accountId }, () =>
                authenticatedApi.ensureAccountResources(accountId, required))}
            />
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
          <WorkshopButton onClick={onCancel}>Cancel</WorkshopButton>
          <WorkshopButton
            tone="primary"
            onClick={() => selected && onChoose(selected.id)}
            disabled={!selected || !usable(selected)}
          >
            Approve
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
