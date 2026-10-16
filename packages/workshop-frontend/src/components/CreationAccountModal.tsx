import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  ConnectFlowStart, CreationApproval, GatekeeperVendorInfo, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../AuthContext'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'
import { openConnectWindow } from '../connectHandoff'
import { AuthPopupCancelledError } from '../features/native-app/authPopup'
import { AccountChooser } from '../gatekeeper-modal/AccountChooser'
import ResourceConfiguratorHost from '../ResourceConfiguratorHost'
import { disposeConfiguratorFrame } from '../disposeConfiguratorFrame'
import { WorkshopButton } from './WorkshopControls'

type CreationTarget = { vendor: GatekeeperVendorInfo; typeUrlPattern: string }

// The popup flow whose start request is in flight.
type StartingFlow = { kind: 'connect' } | { kind: 'reconnect' | 'grant'; accountId: number }

// The creation configurator started for an account, or why it could not start.
type Configurator = { accountId: number } & ({ frame: GatekeeperUiFrame } | { error: string })

/**
 * Approving a creation (see ActionLogEntry.creation) makes the resource in one of the approver's
 * own accounts for its vendor. This asks which, and offers to connect one. For a type with a
 * creation configurator (see SupportedResource.creationConfigurator), it also hosts that
 * account's configurator, whose choice becomes CreationApproval.configuration.
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
  const [accounts, setAccounts] = useState<AccountEvent[]>([])
  const [ready, setReady] = useState(false)
  const [chosen, setChosen] = useState<number>()
  const [starting, setStarting] = useState<StartingFlow | null>(null)
  const [configurator, setConfigurator] = useState<Configurator | null>(null)
  const [configuratorReady, setConfiguratorReady] = useState<boolean | null>(null)
  const [collector, setCollector] = useState<{ collect: () => Promise<string> } | null>(null)
  const [collecting, setCollecting] = useState(false)
  // The Approve whose collect is pending. Ending the configurator (account switch or unmount)
  // clears it, so a collect settling afterwards, typically rejected by the frame's disposal, is
  // ignored.
  const collectAttempt = useRef<object | null>(null)

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

  // Desktop redeems in the popup; native awaits in-app redemption. Both notify the subscription.
  const startFlow = async (flow: StartingFlow, start: () => Promise<ConnectFlowStart | null>) => {
    setStarting(flow)
    try {
      const started = await start()
      if (started) await openConnectWindow(started, authenticatedApi)
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to start connection flow:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Could not complete connection flow', variant: 'error' })
    } finally {
      setStarting(null)
    }
  }

  const matching = target ? accounts.filter(a => a.vendorId === target.vendor.id) : []
  const resource = target?.vendor.supportedResources
    .find(r => r.urlPattern === target.typeUrlPattern)
  // A separately grantable type needs its grant on the account the resource is created in.
  const required = resource?.grantable ? [resource.urlPattern] : []
  const usable = (account: AccountEvent) => account.credentialsValid &&
    required.every(p => account.description.grantedResourceUrlPatterns?.includes(p) ?? true)
  const selected = matching.find(a => a.id === chosen) ?? matching.find(usable)
  const configuratorPattern = resource?.creationConfigurator ? resource.urlPattern : null
  const configuratorAccountId =
    configuratorPattern !== null && selected && usable(selected) ? selected.id : null

  useEffect(() => {
    if (configuratorAccountId === null || configuratorPattern === null) return
    let cancelled = false
    let started: GatekeeperUiFrame | undefined
    authenticatedApi.startCreationConfigurator(configuratorAccountId, configuratorPattern)
      .then(frame => {
        if (cancelled) return disposeConfiguratorFrame(frame)
        started = frame
        setConfigurator({ accountId: configuratorAccountId, frame })
      })
      .catch((err: unknown) => {
        console.error('Failed to start the creation configurator:', err)
        if (cancelled) return
        const error = err instanceof Error ? err.message : 'Could not start configurator.'
        setConfigurator({ accountId: configuratorAccountId, error })
      })
    return () => {
      cancelled = true
      if (started) disposeConfiguratorFrame(started)
      collectAttempt.current = null
      setConfigurator(null)
      setCollecting(false)
    }
  }, [authenticatedApi, configuratorAccountId, configuratorPattern])

  // SandboxedResourceConfigurator re-registers its collector whenever this changes identity, so a
  // fresh callback per render would loop: unregister, re-register, re-render.
  const onCollectorChange = useCallback((collect: (() => Promise<string>) | null) =>
    setCollector(collect && { collect }), [])

  const current = configurator?.accountId === configuratorAccountId ? configurator : null
  const frame = current && 'frame' in current ? current.frame : null
  const configured =
    configuratorPattern === null || (frame && configuratorReady === true && collector)

  const approve = async (accountId: number) => {
    if (configuratorPattern === null) return onChoose({ accountId })
    const attempt = {}
    collectAttempt.current = attempt
    setCollecting(true)
    let configuration: string
    try {
      configuration = await collector!.collect()
    } catch (err) {
      if (collectAttempt.current !== attempt) return
      console.error('Failed to read the creation settings:', err)
      toasts.add({ title: 'Failed to read the creation settings', variant: 'error' })
      setCollecting(false)
      return
    }
    if (collectAttempt.current === attempt) onChoose({ accountId, configuration })
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !-translate-y-0 flex-col overflow-hidden p-0 sm:w-[480px]" size="base">
        <Dialog.Title className="shrink-0 px-6 pt-6 text-lg font-semibold">
          {configuratorPattern === null
            ? 'Choose an account to create it in'
            : 'Choose where to create it'}
        </Dialog.Title>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!target || !ready ? (
            <div className="flex justify-center py-6"><Loader size="base" /></div>
          ) : (
            <div className="space-y-4">
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
              {configuratorAccountId !== null && (
                <ResourceConfiguratorHost
                  frame={frame}
                  frameKey={configuratorAccountId}
                  loading={!current}
                  error={current && 'error' in current ? current.error : null}
                  disabled={false}
                  onCollectResourceUrlChange={onCollectorChange}
                  onSelectionReadyChange={setConfiguratorReady}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
          <WorkshopButton onClick={onCancel}>Cancel</WorkshopButton>
          <WorkshopButton
            tone="primary"
            onClick={() => selected && void approve(selected.id)}
            disabled={!selected || !usable(selected) || !configured || collecting}
          >
            Approve
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
