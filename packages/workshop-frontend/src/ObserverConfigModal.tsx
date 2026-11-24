import { useState, useEffect } from 'react'
import { Collapsible, Dialog, Select, Loader, Text, useKumoToastManager } from '@cloudflare/kumo'
import { Warning, Plus, ArrowClockwise, CaretRight } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  AuthenticatedApi,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  ObserverAccountChoice,
} from '@gadgets/workshop-shared/api'
import {
  AccountDescription,
  VendorDescription,
  SupportedResource,
  resolveRequestedResource,
  getResourceTypeId, getGrantedResourceTypeIds,
} from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton } from './components/WorkshopControls'
import Avatar from './components/Avatar'
import { AccountsSubscriberAdapter } from './accountsSubscriber'
import { openConnectWindow } from './connectHandoff'
import { AuthPopupCancelledError } from './features/native-app/authPopup'

// Shown when a non-owner opens a shared Gadget that reads data through one or more gatekeeper
// bindings, and they haven't yet chosen which of their own connected accounts to use for each one.
// Each chosen account's owner is verified (server-side, via the gatekeeper) to actually have access
// to the data the Gadget read — that's how we uphold the "observers can't see data they couldn't
// otherwise read" invariant. See observers-implementation-plan.md §5 Step 4.
//
// The overseer invokes ObserverConfigCallback.configure(needs) during openWorkspace(); this modal is
// what fulfills that call. Resolving with one ObserverAccountChoice per need lets the open proceed;
// cancelling rejects it (the open is denied and the caller shows an access-denied page).

interface AccountInfo {
  id: number
  description: AccountDescription
  vendor: VendorDescription
  vendorId: string
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

// How to name one of the user's accounts in the UI. Falls back to the id, which is all we can show
// for an account that has since been disconnected (so `accounts` no longer has it).
function accountLabel(account: AccountInfo | undefined, accountId: number): string {
  return account?.description.uniqueName || account?.description.displayName || `Account ${accountId}`
}

// Return the grantable resource type needed to verify one observer binding. Account metadata is
// preferred because it reflects the resources currently available to that account; vendor metadata
// is the fallback used before an account has been connected. Non-grantable resources require no
// OAuth scope expansion.
function requiredResourceTypeIds(
  need: ObserverBindingNeed,
  vendor: GatekeeperVendorInfo | undefined,
  account?: AccountInfo,
): string[] {
  const supportedResources = account?.supportedResources.length
    ? account.supportedResources
    : vendor?.supportedResources
  if (!supportedResources) return []
  const resolved = resolveRequestedResource(supportedResources, need.resourceUrl, need.resourceTypeId)
  return resolved.ok && resolved.resource.grantable ? [getResourceTypeId(resolved.resource)] : []
}

// Older account records may not list which resources were granted. Ask the gatekeeper to check
// instead of assuming the account has access.
function missingResourceTypeIds(account: AccountInfo, required: string[]): string[] {
  const granted = getGrantedResourceTypeIds(account.description, account.supportedResources)
  return granted === undefined ? required : required.filter(typeId => !granted.includes(typeId))
}

// The text links under a vendor's account picker share one row layout: icon, gap, label.
const LINK_ROW = 'flex items-center gap-1.5 self-start text-left text-xs disabled:opacity-60'
const LINK_SUBTLE = 'text-kumo-subtle hover:text-kumo-default'
const LINK_WARNING = 'text-kumo-warning hover:underline'

// The account an account Select's value names, or undefined for anything else: Base UI clears the
// value to null when the selected option disappears from an open menu, and `Number(null)` is 0, a
// real account ID. Ignoring it leaves the choice to the effect that repairs a vanished account.
function optionAccountId(options: AccountInfo[], value: unknown): number | undefined {
  return options.find(account => String(account.id) === value)?.id
}

// One verification refusal: which resource (omitted inside that resource's own row), the account
// refused, and the free-text reason.
function FailureNotice({ title, account, reason }: { title?: string, account: string, reason: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-md text-xs text-kumo-warning bg-kumo-warning-tint border border-kumo-warning/20">
      <Warning size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        {title !== undefined && <><span className="font-medium">{title}</span>{' · '}</>}
        <span className="font-medium">{account}</span>
        {' — '}
        {reason}
      </div>
    </div>
  )
}

interface AccountFixesProps {
  account: AccountInfo
  // Names the account when the vendor's connections use more than one.
  label?: string
  resourceCount: number
  missing: string[]
  refused: boolean
  granting: boolean
  reconnecting: boolean
  onGrant: () => void
  onReconnect: () => void
}

// The fixes one chosen account offers for the connections it was chosen for.
function AccountFixes({ account, label, resourceCount, missing, refused, granting, reconnecting, onGrant, onReconnect }: AccountFixesProps) {
  const suffix = label ? ` (${label})` : ''
  // Scope expansion also replaces expired credentials, so prefer it over plain re-authentication.
  if (missing.length > 0) {
    return (
      <button
        type="button"
        onClick={onGrant}
        disabled={granting}
        className={`${LINK_ROW} ${LINK_WARNING}`}
      >
        {granting ? <ArrowClockwise size={12} className="animate-spin" /> : <Warning size={12} />}
        {granting
          ? 'Requesting access…'
          : (resourceCount === 1
            ? 'Grant the access needed to verify this resource'
            : 'Grant the access needed to verify these resources') + suffix}
      </button>
    )
  }
  // Offer re-authentication for stale credentials, and for an account that just failed: a gatekeeper
  // that rejects an observer on an auth error doesn't always tell the Workshop, so
  // `credentialsValid` can still read true. Not styled as a warning in the second case, since a
  // refusal of valid credentials usually means the account lacks access.
  if (!account.credentialsValid || refused) {
    return (
      <button
        type="button"
        onClick={onReconnect}
        disabled={reconnecting}
        className={`${LINK_ROW} ${account.credentialsValid ? LINK_SUBTLE : LINK_WARNING}`}
      >
        {reconnecting
          ? <ArrowClockwise size={12} className="animate-spin" />
          : account.credentialsValid ? <ArrowClockwise size={12} /> : <Warning size={12} />}
        {reconnecting
          ? 'Re-authenticating…'
          : (account.credentialsValid
            ? 'Re-authenticate this account'
            : 'This account has expired — click to re-authenticate') + suffix}
      </button>
    )
  }
  return null
}

interface ObserverConfigModalProps {
  needs: ObserverBindingNeed[]
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConfirm: (choices: ObserverAccountChoice[]) => void
  onCancel: () => void
  // What is being opened: the workspace, or one gadget of it.
  subject: 'workspace' | 'gadget'
}

export default function ObserverConfigModal({
  needs,
  authenticatedApi,
  onConfirm,
  onCancel,
  subject,
}: ObserverConfigModalProps) {
  const toasts = useKumoToastManager()

  const [accounts, setAccounts] = useState<Map<number, AccountInfo>>(new Map())
  const [ready, setReady] = useState(false)
  // gatekeeperId -> chosen accountId (undefined = not yet chosen). A vendor's picker sets every one
  // of its connections at once; its expanded resource list can set one connection apart.
  const [choices, setChoices] = useState<Record<number, number | undefined>>({})
  // vendorId -> whether its resource list is open, once the user has toggled it (see `isExpanded`).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Vendor metadata keyed by vendorId, used both for display and to resolve the resource scopes each
  // observer binding needs.
  const [vendorsById, setVendorsById] = useState<Map<string, GatekeeperVendorInfo>>(new Map())
  const [vendorsReady, setVendorsReady] = useState(false)
  // The flow being started, by vendorId (connect) or accountId (re-authenticate, grant). Held only
  // while the request that starts it is in flight, not until the account arrives: a popup flow can
  // end without adding one (abandoned, refused by the provider, or an account the user already has),
  // and waiting on it would strand the dialog with every way forward disabled. The result arrives
  // through the accounts subscription whenever the flow does complete.
  const [connecting, setConnecting] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<number | null>(null)
  const [granting, setGranting] = useState<number | null>(null)

  // ── subscribe to the user's connected accounts ────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        setAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { id, description, vendor, vendorId, supportedResources, credentialsValid })
          return next
        })
      },
      remove(id) {
        if (cancelled) return
        setAccounts(prev => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      },
      ready() {
        if (cancelled) return
        setReady(true)
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(
      subscriber, { includeForcedAutoProvisionedAccounts: true })
    subscription.catch(err => {
      if (cancelled) return
      // Loud on purpose: the modal has no retry path, so a quieted transient failure would
      // strand the user on a permanent loader.
      console.error('Failed to subscribe to connected accounts:', err)
      toasts.add({ title: 'Failed to load your connected accounts', variant: 'error' })
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // ── load vendor metadata for display and resource-scope resolution ─────────────
  useEffect(() => {
    let cancelled = false
    Promise.all([
      authenticatedApi.listGatekeeperVendors(),
      authenticatedApi.listAddableGatekeepers(),
    ])
      .then(([vendors, addable]) => {
        if (cancelled) return
        const map = new Map<string, GatekeeperVendorInfo>()
        for (const vendor of [...vendors, ...addable]) map.set(vendor.id, vendor)
        setVendorsById(map)
        setVendorsReady(true)
      })
      .catch(err => {
        console.error('Failed to load vendors:', err)
        if (!cancelled) setVendorsReady(true)
      })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Needs grouped by vendor, in the order the overseer listed their first connection: the vendor's
  // picker covers every connection of a vendor, and its resource list can set one apart.
  const vendorGroups = new Map<string, ObserverBindingNeed[]>()
  for (const need of needs) {
    const group = vendorGroups.get(need.vendorId)
    if (group) group.push(need)
    else vendorGroups.set(need.vendorId, [need])
  }
  // Every grantable resource type a set of connections needs, so one grant request covers them all.
  const requiredForGroup = (group: ObserverBindingNeed[], account?: AccountInfo) => [
    ...new Set(group.flatMap(need => requiredResourceTypeIds(need, vendorsById.get(need.vendorId), account))),
  ]

  // ── keep choices in sync with the available accounts ──────────────────────────
  // Default each connection to its vendor's first matching account, and drop a choice whose account
  // has disappeared (e.g. disconnected in another tab). A connection being re-prompted because it
  // just failed prefers the account that failed, so the reason shown is about the selected account
  // and an expired one can be re-authenticated in place; its vendor's other connections default to
  // that account too, so the vendor's picker starts on one account.
  useEffect(() => {
    setChoices(prev => {
      let changed = false
      const next = { ...prev }
      for (const need of needs) {
        const matching = [...accounts.values()].filter(a => a.vendorId === need.vendorId)
        const failedHere = need.failure && accounts.has(need.failure.accountId) ? need.failure.accountId : undefined
        const failedInVendor = needs.find(other =>
          other.vendorId === need.vendorId && other.failure && accounts.has(other.failure.accountId))?.failure?.accountId
        const preferred = failedHere ?? failedInVendor ?? matching[0]?.id
        const current = next[need.gatekeeperId]
        if (current !== undefined && !accounts.has(current)) {
          next[need.gatekeeperId] = preferred
          changed = true
        } else if (current === undefined && preferred !== undefined) {
          next[need.gatekeeperId] = preferred
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [accounts, needs])

  // ── connect / reconnect handlers ──────────────────────────────────────────────
  const handleConnect = async (vendorId: string, group: ObserverBindingNeed[]) => {
    setConnecting(vendorId)
    try {
      const vendor = vendorsById.get(vendorId)
      if (vendor?.description.autoProvisionsAccount) {
        await authenticatedApi.provisionAmbientAccount(vendorId)
      } else {
        const required = requiredForGroup(group)
        await openConnectWindow(await authenticatedApi.connectAccount(
          vendorId,
          required.length > 0 ? required : undefined,
        ), authenticatedApi)
      }
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to initiate connection:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Could not complete connection flow', variant: 'error' })
    } finally {
      setConnecting(null)
    }
  }

  const handleReconnect = async (accountId: number) => {
    setReconnecting(accountId)
    try {
      // After ticket redemption the restored account arrives through the subscription.
      await openConnectWindow(await authenticatedApi.reconnectAccount(accountId), authenticatedApi)
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to initiate reconnection:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Could not complete re-authentication flow', variant: 'error' })
    } finally {
      setReconnecting(null)
    }
  }

  const handleGrantResourceAccess = async (group: ObserverBindingNeed[], account: AccountInfo) => {
    const missing = missingResourceTypeIds(account, requiredForGroup(group, account))
    if (missing.length === 0) return
    setGranting(account.id)
    try {
      const flow = await authenticatedApi.ensureAccountResources(account.id, missing)
      if (flow) await openConnectWindow(flow, authenticatedApi)
      else {
        // The gatekeeper confirmed this account already has access. Update the modal so the user can
        // continue without an OAuth flow.
        setAccounts(prev => {
          const current = prev.get(account.id)
          if (!current) return prev
          const next = new Map(prev)
          next.set(account.id, {
            ...current,
            description: {
              ...current.description,
              grantedResourceTypeIds: [
                ...new Set([
                  ...(getGrantedResourceTypeIds(current.description, current.supportedResources) ?? []),
                  ...missing,
                ]),
              ],
            },
          })
          return next
        })
      }
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to request additional access:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Failed to request additional access', variant: 'error' })
    } finally {
      setGranting(null)
    }
  }

  // A connection is satisfied only when its chosen account has valid credentials and every grantable
  // resource type it needs for observer verification.
  const accountFor = (need: ObserverBindingNeed): AccountInfo | undefined => {
    const id = choices[need.gatekeeperId]
    return id === undefined ? undefined : accounts.get(id)
  }
  const accountSatisfies = (group: ObserverBindingNeed[], account: AccountInfo | undefined) =>
    !!account?.credentialsValid && missingResourceTypeIds(account, requiredForGroup(group, account)).length === 0
  const allSatisfied = needs.every(need => accountSatisfies([need], accountFor(need)))

  // The vendor's picker sets every one of its connections to one account.
  const chooseForVendor = (group: ObserverBindingNeed[], accountId: number) => setChoices(prev => {
    const next = { ...prev }
    for (const need of group) next[need.gatekeeperId] = accountId
    return next
  })

  const handleConfirm = () => {
    const result: ObserverAccountChoice[] = []
    for (const need of needs) {
      const accountId = choices[need.gatekeeperId]
      if (accountId === undefined) return
      result.push({ gatekeeperId: need.gatekeeperId, accountId })
    }
    onConfirm(result)
  }

  // The overseer re-prompts with `failure` set when an already-configured binding failed
  // verification on this open: expired credentials, or an account without access to the data.
  const failedNeeds = needs.flatMap(n => n.failure ? [n.failure] : [])
  const isRetry = failedNeeds.length > 0
  const failedNeedCount = failedNeeds.length
  // Several refused connections may share one account, so word the fix by distinct accounts.
  const failedAccountCount = new Set(failedNeeds.map(failure => failure.accountId)).size

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !-translate-y-0 flex-col overflow-hidden p-0" size="lg">
        <div className="shrink-0 px-6 pt-6">
          <Dialog.Title className="mb-2 text-lg font-semibold">
            {isRetry ? 'Verify your access again' : 'Verify your access'}
          </Dialog.Title>
          <Text variant="secondary" size="sm" as="p">
            {isRetry
              ? `We couldn’t confirm your access to the resources this ${subject} has read ` +
                `from. Depending on the ${failedNeedCount === 1 ? 'reason' : 'reasons'} below, ` +
                (failedAccountCount === 1
                  ? 're-authenticate this account, connect a different account, '
                  : 're-authenticate these accounts, connect different accounts, ') +
                `or ask the ${subject} owner to share the ` +
                `${failedNeedCount === 1 ? 'resource' : 'resources'} that your ` +
                `${failedAccountCount === 1 ? 'account' : 'accounts'} can’t access.`
              : `Before using this ${subject}, confirm that your accounts can access the protected resources ` +
                'it has read from.'}
          </Text>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!ready || !vendorsReady ? (
            <div className="text-center py-10">
              <Loader />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {[...vendorGroups].map(([vendorId, group]) => {
                const matching = [...accounts.values()].filter(a => a.vendorId === vendorId)
                const vendor = matching[0]?.vendor ?? vendorsById.get(vendorId)?.description
                const vendorName = vendor?.displayName || vendorId || 'service'
                const failures = group.flatMap(need => need.failure ? [{ need, failure: need.failure }] : [])
                // The vendor's picker shows an account only while every connection uses it.
                const chosenIds = group.map(need => choices[need.gatekeeperId])
                const uniform = chosenIds.every(id => id === chosenIds[0]) ? chosenIds[0] : undefined
                const mixed = uniform === undefined && chosenIds.some(id => id !== undefined)
                // Connections by the account chosen for them, so each account's fixes cover its own.
                const byAccount = new Map<number, ObserverBindingNeed[]>()
                for (const need of group) {
                  const id = choices[need.gatekeeperId]
                  if (id === undefined) continue
                  const assigned = byAccount.get(id)
                  if (assigned) assigned.push(need)
                  else byAccount.set(id, [need])
                }
                // Collapsed unless the user opened it, or a retry needs one connection's account
                // changed apart from the rest: the overseer re-prompts once, so that choice must be
                // in sight.
                const open = expanded[vendorId] ?? (failures.length > 0 && matching.length > 1)

                return (
                  <div key={vendorId} className="rounded-xl border border-kumo-line bg-kumo-base p-4">
                    <div className="mb-3 flex items-center gap-3">
                      <Avatar
                        src={vendor?.logo?.url}
                        background={vendor?.color}
                        size={32}
                        fallback={<Plus size={16} />}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-kumo-default truncate">{vendorName}</div>
                        <div className="text-xs text-kumo-subtle truncate">
                          {group.length === 1 ? '1 resource' : `${group.length} resources`}
                        </div>
                      </div>
                      {matching.length === 0 && vendor && (
                        <WorkshopButton
                          tone="primary"
                          onClick={() => handleConnect(vendorId, group)}
                          disabled={connecting === vendorId}
                        >
                          {connecting === vendorId ? 'Connecting…' : 'Connect'}
                        </WorkshopButton>
                      )}
                    </div>

                    {/* Collapsed, name each refused resource, the account refused and why; open, each
                        resource's row says it. The reason is free text, either from the gatekeeper or
                        authored by the overseer, and must not be parsed. */}
                    {!open && failures.length > 0 && (
                      <div className="mb-3 flex flex-col gap-2">
                        {failures.map(({ need, failure }) => (
                          <FailureNotice key={need.gatekeeperId} title={need.resourceTitle}
                            account={accountLabel(accounts.get(failure.accountId), failure.accountId)}
                            reason={failure.reason} />
                        ))}
                      </div>
                    )}

                    {matching.length > 0 && (
                      <div className="flex flex-col gap-2">
                        {matching.length === 1 ? (
                          <div className="flex min-h-10 items-center gap-3 rounded-lg border border-kumo-line bg-kumo-elevated/50 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] leading-4 text-kumo-subtle">Using your account</div>
                              <div className="truncate text-sm font-medium text-kumo-default">
                                {accountLabel(matching[0], matching[0].id)}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <Select
                            className="w-full text-sm"
                            aria-label={`${vendorName} account for all resources`}
                            /* null, not undefined: Base UI treats a Select mounted without a value as
                               uncontrolled and ignores the default chosen once accounts arrive. */
                            value={uniform !== undefined ? String(uniform) : null}
                            placeholder={mixed ? 'Multiple accounts' : `Choose a ${vendorName} account…`}
                            onValueChange={v => {
                              const accountId = optionAccountId(matching, v)
                              if (accountId !== undefined) chooseForVendor(group, accountId)
                            }}
                            renderValue={v => accountLabel(accounts.get(Number(v)), Number(v))}
                          >
                            {matching.map(acct => (
                              <Select.Option key={acct.id} value={String(acct.id)}>
                                {accountLabel(acct, acct.id)}
                                {!acct.credentialsValid ? ' (expired)' : ''}
                              </Select.Option>
                            ))}
                          </Select>
                        )}

                        {[...byAccount].map(([accountId, assigned]) => {
                          const account = accounts.get(accountId)
                          return account && (
                            <AccountFixes
                              key={accountId}
                              account={account}
                              label={byAccount.size > 1 ? accountLabel(account, accountId) : undefined}
                              resourceCount={assigned.length}
                              missing={missingResourceTypeIds(account, requiredForGroup(assigned, account))}
                              refused={assigned.some(need => need.failure?.accountId === accountId)}
                              granting={granting === accountId}
                              reconnecting={reconnecting === accountId}
                              onGrant={() => handleGrantResourceAccess(assigned, account)}
                              onReconnect={() => handleReconnect(accountId)}
                            />
                          )
                        })}

                        {!vendor?.autoProvisionsAccount && (
                          <button
                            type="button"
                            onClick={() => handleConnect(vendorId, group)}
                            disabled={connecting === vendorId}
                            className={`${LINK_ROW} ${LINK_SUBTLE}`}
                          >
                            <Plus size={12} />
                            {connecting === vendorId ? 'Connecting…' : 'Connect a different account'}
                          </button>
                        )}
                      </div>
                    )}

                    <Collapsible.Root open={open} onOpenChange={next => setExpanded(prev => ({ ...prev, [vendorId]: next }))}>
                      <Collapsible.Trigger className={`mt-2 ${LINK_ROW} ${LINK_SUBTLE}`}>
                        <CaretRight size={12} className={open ? 'rotate-90' : undefined} />
                        {matching.length > 1 ? 'Pick a different account for each resource' : 'Show resources'}
                      </Collapsible.Trigger>
                      <Collapsible.Panel>
                        <ul role="list" aria-label={`${vendorName} resources`} className="mt-2 flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
                          {group.map(need => (
                            <li key={need.gatekeeperId} className="flex flex-col gap-2 px-3 py-2">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] text-kumo-default">{need.resourceTitle}</div>
                                  {need.resourceUrl && (
                                    <div className="truncate font-mono text-xs text-kumo-subtle">
                                      {need.resourceUrl.replace(/^https?:\/\//, '')}
                                    </div>
                                  )}
                                </div>
                                {matching.length > 1 && (
                                  <Select
                                    className="w-full shrink-0 text-sm sm:w-44"
                                    aria-label={`Account for ${need.resourceTitle}`}
                                    value={choices[need.gatekeeperId] !== undefined ? String(choices[need.gatekeeperId]) : null}
                                    placeholder="Choose an account…"
                                    onValueChange={v => {
                                      const accountId = optionAccountId(matching, v)
                                      if (accountId !== undefined) setChoices(prev => ({ ...prev, [need.gatekeeperId]: accountId }))
                                    }}
                                    renderValue={v => accountLabel(accounts.get(Number(v)), Number(v))}
                                  >
                                    {matching.map(acct => (
                                      <Select.Option key={acct.id} value={String(acct.id)}>
                                        {accountLabel(acct, acct.id)}
                                        {!acct.credentialsValid ? ' (expired)' : ''}
                                      </Select.Option>
                                    ))}
                                  </Select>
                                )}
                              </div>
                              {need.failure && (
                                <FailureNotice
                                  account={accountLabel(accounts.get(need.failure.accountId), need.failure.accountId)}
                                  reason={need.failure.reason} />
                              )}
                            </li>
                          ))}
                        </ul>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
          <WorkshopButton tone="secondary" onClick={onCancel}>
            Cancel
          </WorkshopButton>
          <WorkshopButton
            tone="primary"
            onClick={handleConfirm}
            disabled={!ready || !vendorsReady || !allSatisfied}
          >
            {isRetry ? 'Verify again' : 'Verify and open'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
