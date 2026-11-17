import { getResourceTypeId, getGrantedResourceTypeIds } from "@gadgets/workshop-shared/gatekeeper";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import type {
  ConnectFlowStart, CreationApproval, GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../AuthContext'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'
import { openConnectWindow } from '../connectHandoff'
import { requestAccountResources } from '../requestAccountResources'
import { AuthPopupCancelledError } from '../features/native-app/authPopup'
import { AccountChooser } from '../gatekeeper-modal/AccountChooser'
import ResourceConfiguratorHost from '../ResourceConfiguratorHost'
import { disposeConfiguratorFrame } from '../disposeConfiguratorFrame'
import { WorkshopButton } from './WorkshopControls'

/** The type to make a resource of, and the configuration its configurator opens on, if any. */
export type CreationTarget = {
  vendor: GatekeeperVendorInfo
  resource: SupportedResource
  configuration?: string
}

// The popup flow whose start request is in flight.
type StartingFlow = { kind: 'connect' } | { kind: 'reconnect' | 'grant'; accountId: number }

// The creation configurator started for an account, or why it could not start.
type Configurator = { accountId: number } & ({ frame: GatekeeperUiFrame } | { error: string })

/**
 * Asks which of the user's own accounts for `target`'s vendor to make a resource in, and offers
 * to connect one. For a type with a creation configurator (see
 * SupportedResource.creationConfigurator), it also hosts that account's configurator, started
 * for `purpose`, whose choice `onSubmit` receives as the configuration. `onSubmit` reports its
 * own failures; with a configurator, the dialog stays busy until it settles.
 */
export const CreationAccountDialog = ({
  title, target, purpose, submitLabel, submitDisabled = false, children, onSubmit, onCancel,
}: {
  title: string
  /** Null while it loads. */
  target: CreationTarget | null
  purpose: 'create' | 'save'
  submitLabel: string
  submitDisabled?: boolean
  /** Further fields, shown between the accounts and the configurator. */
  children?: ReactNode
  onSubmit: (creation: CreationApproval) => void | Promise<void>
  onCancel: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [accounts, setAccounts] = useState<AccountEvent[]>([])
  const [ready, setReady] = useState(false)
  const [chosen, setChosen] = useState<number>()
  const [starting, setStarting] = useState<StartingFlow | null>(null)
  const [configurator, setConfigurator] = useState<Configurator | null>(null)
  const [configuratorReady, setConfiguratorReady] = useState<boolean | null>(null)
  const [collector, setCollector] = useState<{ collect: () => Promise<string> } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // onSubmit is running: unlike a collect, it cannot be abandoned, so the dialog holds still for it.
  const [sending, setSending] = useState(false)
  // The submit in flight. Ending the configurator (account switch or unmount) clears it, so a
  // collect settling afterwards, typically rejected by the frame's disposal, is ignored.
  const submitAttempt = useRef<object | null>(null)

  useEffect(() => {
    let cancelled = false
    const subscription = authenticatedApi.subscribeConnectedAccounts(new AccountsSubscriberAdapter({
      add(account) {
        // An update keeps its place, so the default selection (the first usable account) does not
        // move to another account and restart the configurator when a grant arrives.
        if (!cancelled) {
          setAccounts(prev => prev.some(a => a.id === account.id)
            ? prev.map(a => a.id === account.id ? account : a)
            : [...prev, account])
        }
      },
      remove(id) {
        if (!cancelled) setAccounts(prev => prev.filter(a => a.id !== id))
      },
      ready() {
        if (!cancelled) setReady(true)
      },
    }), { includeForcedAutoProvisionedAccounts: true })
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

  const resource = target?.resource
  const matching = target ? accounts.filter(a => a.vendorId === target.vendor.id) : []
  // A separately grantable type needs its grant on the account the resource is created in. A save
  // only hands the account a file, which its configurator asks for whatever it needs.
  const required = purpose === 'create' && resource?.grantable ? [getResourceTypeId(resource)] : []
  const usable = (account: AccountEvent) => account.credentialsValid &&
    required.every(p => getGrantedResourceTypeIds(account.description, account.supportedResources)?.includes(p) ?? true)
  const selected = matching.find(a => a.id === chosen) ?? matching.find(usable)
  const configuratorTypeId = resource?.creationConfigurator ? getResourceTypeId(resource) : null
  const configuratorAccountId =
    configuratorTypeId !== null && selected && usable(selected) ? selected.id : null

  useEffect(() => {
    if (configuratorAccountId === null || configuratorTypeId === null) return
    let cancelled = false
    let started: GatekeeperUiFrame | undefined
    authenticatedApi.startCreationConfigurator(configuratorAccountId, configuratorTypeId, purpose)
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
      submitAttempt.current = null
      setConfigurator(null)
      setSubmitting(false)
    }
  }, [authenticatedApi, configuratorAccountId, configuratorTypeId, purpose])

  // SandboxedResourceConfigurator re-registers its collector whenever this changes identity, so a
  // fresh callback per render would loop: unregister, re-register, re-render.
  const onCollectorChange = useCallback((collect: (() => Promise<string>) | null) =>
    setCollector(collect && { collect }), [])

  const current = configurator?.accountId === configuratorAccountId ? configurator : null
  const frame = current && 'frame' in current ? current.frame : null
  const configured =
    configuratorTypeId === null || (frame && configuratorReady === true && collector)

  const submit = async (accountId: number) => {
    if (configuratorTypeId === null) return onSubmit({ accountId })
    const attempt = {}
    submitAttempt.current = attempt
    setSubmitting(true)
    let configuration: string
    try {
      configuration = await collector!.collect()
    } catch (err) {
      if (submitAttempt.current !== attempt) return
      console.error('Failed to read the creation settings:', err)
      toasts.add({ title: 'Failed to read the creation settings', variant: 'error' })
      setSubmitting(false)
      return
    }
    if (submitAttempt.current !== attempt) return
    setSending(true)
    try {
      await onSubmit({ accountId, configuration })
    } finally {
      setSending(false)
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !sending) onCancel() }}>
      <Dialog className="responsive-dialog !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !-translate-y-0 flex-col overflow-hidden p-0 !w-[min(760px,calc(100vw-32px))]" size="lg">
        <Dialog.Title className="shrink-0 px-6 pt-6 text-lg font-semibold">{title}</Dialog.Title>

        {/* What is sent was read when it was submitted: nothing here changes it from then on. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" inert={submitting || sending}>
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
                requiredResourceTypeIds={required}
                grantingAccountId={starting?.kind === 'grant' ? starting.accountId : null}
                onSelect={accountId => { if (!sending) setChosen(accountId) }}
                onConnect={() => void startFlow({ kind: 'connect' }, async () => {
                  if (target.vendor.description.autoProvisionsAccount) {
                    await authenticatedApi.provisionAmbientAccount(target.vendor.id)
                    return null
                  }
                  // A save connects with no resource types, where none given would ask for them all:
                  // its configurator asks for what it needs.
                  return authenticatedApi.connectAccount(
                    target.vendor.id, required.length > 0 || purpose === 'save' ? required : undefined)
                })}
                onReconnect={accountId => void startFlow({ kind: 'reconnect', accountId }, () =>
                  authenticatedApi.reconnectAccount(accountId))}
                onGrantAccess={accountId => void startFlow({ kind: 'grant', accountId }, () =>
                  authenticatedApi.ensureAccountResources(accountId, required))}
              />
              {children}
              {configuratorAccountId !== null && (
                <ResourceConfiguratorHost
                  frame={frame}
                  frameKey={configuratorAccountId}
                  loading={!current}
                  error={current && 'error' in current ? current.error : null}
                  disabled={false}
                  onCollectResourceUrlChange={onCollectorChange}
                  onSelectionReadyChange={setConfiguratorReady}
                  onEnsureResources={frame
                    ? patterns => requestAccountResources(
                      authenticatedApi, toasts, configuratorAccountId, patterns)
                    : undefined}
                  initialResourceUrl={target.configuration}
                  resourceUrlPattern={resource?.urlPattern}
                  acceptedResourceUrlPatterns={resource ? [resource.urlPattern] : []}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
          <WorkshopButton onClick={onCancel} disabled={sending}>Cancel</WorkshopButton>
          <WorkshopButton
            tone="primary"
            loading={submitting || sending}
            onClick={() => selected && void submit(selected.id)}
            disabled={!selected || !usable(selected) || !configured || submitting || sending || submitDisabled}
          >
            {submitLabel}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
