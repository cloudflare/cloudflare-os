import { logRpcFailure } from '../rpcErrors'
import { libraryTabOfApp } from '../features/library/libraryApps'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { ArrowRight, ArrowsClockwise, Plug, Plugs } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { refreshGatekeeperApps } from '../useGatekeeperApps'
import { EmptyState } from '../components/EmptyState'
import ConnectConnectorModal from '../components/ConnectConnectorModal'
import { PageHeader } from '../components/PageHeader'
import { SplitPage } from '../components/AppShell/SplitPage'
import { roundButtonClass } from '../components/RoundButton'
import { LibrarySearch } from '../features/library/LibraryToolbar'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from '../useDocumentTitle'
import { AccountsSubscriberAdapter } from '../accountsSubscriber'
import { openConnectWindow } from '../connectHandoff'
import { AuthPopupCancelledError } from '../features/native-app/authPopup'
import { nativeApp } from '../features/native-app/nativeApp'

export const Route = createFileRoute('/gatekeepers')({
  component: ConnectorsPage,
})

interface AccountEntry {
  id: number
  accountDescription: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

interface VendorEntry {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

/** A gatekeeper's mark at the Library's 25px glyph size, on its brand colour. */
const VendorGlyph = ({ vendor }: { vendor: VendorDescription }) => (
  <span
    className="grid size-[25px] shrink-0 place-items-center overflow-hidden rounded-[8px] ring-1 ring-inset ring-kumo-line"
    style={{ backgroundColor: vendor.color ?? 'var(--color-kumo-tint)' }}
  >
    {vendor.logo?.url
      ? <img src={vendor.logo.url} alt="" className="size-[15px] object-contain" />
      : <span className="text-[12px] font-semibold text-kumo-strong">{vendor.displayName[0]?.toUpperCase() ?? '?'}</span>}
  </span>
)

const ROW = 'group/row flex h-[49px] w-full min-w-0 cursor-pointer items-center gap-3 rounded-[14px] px-3 text-left outline-none transition-colors hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring'
const TRAILING_PILL = roundButtonClass('pill', 'h-7 !px-2.5 !text-[12px]')
// Like the Library's star and More, a row's action shows on hover or focus; touch shows it always.
const ON_HOVER = 'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100 [@media(hover:none)]:opacity-100'

/** A Library-style row: glyph, name, a quiet second part, and whatever ends it. */
const GatekeeperRow = ({ vendor, detail, detailTone = 'subtle', trailing }: {
  vendor: VendorDescription
  detail?: ReactNode
  detailTone?: 'subtle' | 'danger'
  trailing?: ReactNode
}) => (
  <>
    <VendorGlyph vendor={vendor} />
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 text-[14px] font-medium leading-[17px] text-kumo-default">{vendor.displayName}</span>
      {detail && (
        <span className={`min-w-0 truncate text-[13px] ${detailTone === 'danger' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>{detail}</span>
      )}
    </span>
    {trailing}
  </>
)

/** A row that opens its gatekeeper's modal. */
const ButtonRow = ({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) => (
  <div
    role="button"
    tabIndex={0}
    aria-label={label}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
    }}
    className={ROW}
  >
    {children}
  </div>
)

/** One group of rows under a quiet heading, in the design's tinted card. */
const Section = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="flex items-baseline gap-2 px-3 text-[13px] font-medium leading-4 text-kumo-subtle">
      {title}
      {count !== undefined && <span className="text-kumo-inactive">{count}</span>}
    </h2>
    <div className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-1.5">{children}</div>
  </section>
)

const accountName = (account: AccountEntry) =>
  account.accountDescription.uniqueName ?? account.accountDescription.displayName ?? 'Connected'

type ModalTarget =
  | { kind: 'connect'; vendorId: string }
  | { kind: 'manage'; accountId: number }
  | null

function ConnectorsPage() {
  useDocumentTitle('Gatekeepers')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [search, setSearch] = useState('')
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [vendors, setVendors] = useState<VendorEntry[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [vendorsLoaded, setVendorsLoaded] = useState(false)
  // Auto-provisioning ("ambient") gatekeepers set to "optional" that the user can opt into. They're
  // shown in the same "Available" section and opened through the same modal as OAuth vendors; the
  // only difference is that confirming adds the account directly (no OAuth redirect).
  const [addable, setAddable] = useState<GatekeeperVendorInfo[]>([])
  const [loadError, setLoadError] = useState(false)

  const [modalTarget, setModalTarget] = useState<ModalTarget>(null)
  const [connecting, setConnecting] = useState(false)
  const [canCancelConnect, setCanCancelConnect] = useState(false)
  const connectCancellation = useRef<AbortController | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)
  const [ensuringResourceUrlPatterns, setEnsuringResourceUrlPatterns] = useState<string[]>([])

  useEffect(() => () => connectCancellation.current?.abort(), [])

  useEffect(() => {
    let cancelled = false
    const accountMap = new Map<number, AccountEntry>()

    setAccountsLoaded(false)
    setVendorsLoaded(false)

    authenticatedApi.listAddableGatekeepers()
      .then((list) => {
        if (!cancelled) setAddable(list)
      })
      .catch((err) => {
        logRpcFailure('Failed to load addable gatekeepers:', err)
      })

    authenticatedApi.listGatekeeperVendors()
      .then((vendorList) => {
        if (cancelled) return
        const unavailable = vendorList.filter((v) => v.unavailable)
        if (unavailable.length > 0) {
          toasts.add({
            title: `Some services are temporarily unavailable: ${unavailable.map((v) => v.id).join(', ')}`,
            variant: 'warning',
          })
        }
        setVendors(
          vendorList
            .filter((v) => !v.unavailable)
            .map((v) => ({
              id: v.id,
              description: v.description,
              supportedResources: v.supportedResources,
            })),
        )
        setVendorsLoaded(true)
      })
      .catch((err) => {
        logRpcFailure('Failed to load available services:', err)
        if (!cancelled) setLoadError(true)
      })

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorId,
          vendorDescription: vendor,
          supportedResources,
          credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
      },
      remove(id) {
        accountMap.delete(id)
        if (!cancelled) setAccounts(Array.from(accountMap.values()))
      },
      ready() {
        if (!cancelled) setAccountsLoaded(true)
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
      setLoadError(true)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const handleOpenConnect = (vendorId: string) => {
    setModalTarget({ kind: 'connect', vendorId })
  }

  const handleOpenManage = (accountId: number) => {
    setModalTarget({ kind: 'manage', accountId })
  }

  const handleCloseModal = () => {
    setModalTarget(null)
    setEnsuringResourceUrlPatterns([])
  }

  const handleConfirmConnect = async (resourceUrlPatterns?: string[]) => {
    if (!modalTarget || modalTarget.kind !== 'connect') return
    const vendorId = modalTarget.vendorId
    const cancellation = new AbortController()
    connectCancellation.current = cancellation
    setConnecting(true)
    try {
      if (isTargetAmbient) {
        // Ambient gatekeeper: mint the account directly, no OAuth redirect. It then appears under
        // "Connected" via the subscription and drops out of "Available".
        await authenticatedApi.provisionAmbientAccount(vendorId)
        setAddable((prev) => prev.filter((g) => g.id !== vendorId))
        // If the gatekeeper provides a management UI, its nav entry should appear without a reload.
        refreshGatekeeperApps(authenticatedApi)
      } else {
        const flow = await authenticatedApi.connectAccount(vendorId, resourceUrlPatterns)
        setCanCancelConnect(!!nativeApp()?.authentication)
        await openConnectWindow(flow, authenticatedApi, cancellation.signal)
      }
      handleCloseModal()
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to connect account:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Could not complete connection', variant: 'error' })
    } finally {
      connectCancellation.current = null
      setCanCancelConnect(false)
      setConnecting(false)
    }
  }

  const handleEnsureResources = async (resourceUrlPatterns: string[]) => {
    if (!modalTarget || modalTarget.kind !== 'manage') return
    setEnsuringResourceUrlPatterns((prev) => [...new Set([...prev, ...resourceUrlPatterns])])
    try {
      const flow = await authenticatedApi.ensureAccountResources(
        modalTarget.accountId,
        resourceUrlPatterns,
      )
      if (flow) await openConnectWindow(flow, authenticatedApi)
      // After ticket redemption the new grant arrives via subscribeConnectedAccounts(),
      // and the toggle reflects it once `grantedResourceUrlPatterns` updates.
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to expand account access:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Failed to request additional access', variant: 'error' })
    } finally {
      setEnsuringResourceUrlPatterns((prev) =>
        prev.filter((p) => !resourceUrlPatterns.includes(p)),
      )
    }
  }

  const handleDisconnect = async () => {
    if (!modalTarget || modalTarget.kind !== 'manage') return
    setDisconnecting(true)
    try {
      await authenticatedApi.disconnectAccount(modalTarget.accountId)
      // If this was an opt-in ambient account, it's now removable and should return to "Available";
      // re-fetch the addable list so it reappears there immediately (no refresh needed).
      authenticatedApi.listAddableGatekeepers().then(setAddable).catch(() => {})
      // Drop its nav entry too, if it provided a management UI.
      refreshGatekeeperApps(authenticatedApi)
      handleCloseModal()
    } catch (err) {
      console.error('Failed to disconnect account:', err)
      toasts.add({ title: 'Failed to disconnect account', variant: 'error' })
    } finally {
      setDisconnecting(false)
    }
  }

  const handleReconnect = async (accountId: number) => {
    setReconnectingAccountId(accountId)
    try {
      await openConnectWindow(await authenticatedApi.reconnectAccount(accountId), authenticatedApi)
    } catch (err) {
      if (err instanceof AuthPopupCancelledError) return
      console.error('Failed to reconnect account:', err)
      toasts.add({ title: err instanceof Error ? err.message : 'Failed to reconnect account', variant: 'error' })
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const searchLower = search.toLowerCase()
  const filteredAccounts = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)
    const resourcesForAccountFilter = (account: AccountEntry) =>
      vendors.find((v) => v.id === account.vendorId)?.supportedResources ??
      account.supportedResources

    return accounts.filter((a) => {
      const resources = resourcesForAccountFilter(a)
      return (
        matchesSearch(a.accountDescription.displayName) ||
        matchesSearch(a.accountDescription.uniqueName) ||
        matchesSearch(a.vendorDescription.displayName) ||
        matchesSearch(a.vendorDescription.tagline) ||
        resources.some((r) => matchesSearch(r.title))
      )
    })
  }, [accounts, vendors, searchLower])

  // Connectable vendors = OAuth/resource gatekeepers plus opt-in ambient ones, rendered identically.
  // An ambient vendor is recognized by `description.autoProvisionsAccount`, which routes the connect
  // action to a direct (no-OAuth) add instead.
  const availableVendors = useMemo<VendorEntry[]>(
    () => [
      ...vendors,
      ...addable,
    ],
    [vendors, addable],
  )

  const filteredAvailable = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)

    return availableVendors.filter(
      (v) =>
        matchesSearch(v.description.displayName) ||
        matchesSearch(v.description.tagline) ||
        v.supportedResources.some((r) => matchesSearch(r.title)),
    )
  }, [availableVendors, searchLower])

  const activeAccount: AccountEntry | undefined =
    modalTarget?.kind === 'manage'
      ? accounts.find((a) => a.id === modalTarget.accountId)
      : undefined
  const activeVendor: VendorEntry | undefined =
    modalTarget?.kind === 'connect'
      ? availableVendors.find((v) => v.id === modalTarget.vendorId)
      : activeAccount
      ? availableVendors.find((v) => v.id === activeAccount.vendorId) ?? {
          id: activeAccount.vendorId,
          description: activeAccount.vendorDescription,
          supportedResources: activeAccount.supportedResources,
        }
      : undefined

  // True when the connect modal targets an ambient gatekeeper (added directly, no OAuth flow).
  const isTargetAmbient =
    modalTarget?.kind === 'connect' && !!activeVendor?.description.autoProvisionsAccount

  const initialLoading =
    !loadError &&
    (!vendorsLoaded || !accountsLoaded) &&
    vendors.length === 0 &&
    accounts.length === 0

  // Auto-provisioned gatekeepers come with the deployment rather than from an account the user
  // signs in to, so they are grouped apart from the services the user connected.
  const isBuiltIn = (description: VendorDescription) => description.autoProvisionsAccount === true
  const connected = filteredAccounts.filter((a) => !isBuiltIn(a.vendorDescription))
  const builtIn = filteredAccounts.filter((a) => isBuiltIn(a.vendorDescription))
  const addableBuiltIn = filteredAvailable.filter((v) => isBuiltIn(v.description))
  const available = filteredAvailable.filter((v) => !isBuiltIn(v.description))

  const accountRow = (account: AccountEntry) => {
    const vendor = account.vendorDescription
    const expired = !account.credentialsValid
    const busy = reconnectingAccountId === account.id
    return (
      <ButtonRow key={account.id} label={`${vendor.displayName}, ${accountName(account)}`} onOpen={() => handleOpenManage(account.id)}>
        <GatekeeperRow
          vendor={vendor}
          detail={expired ? 'Sign-in expired'
            : accountName(account) === vendor.displayName ? vendor.tagline : accountName(account)}
          detailTone={expired ? 'danger' : 'subtle'}
          trailing={expired ? (
            <button
              type="button"
              disabled={busy}
              onClick={(event) => { event.stopPropagation(); if (!busy) void handleReconnect(account.id) }}
              className={TRAILING_PILL}
            >
              <ArrowsClockwise size={12} />
              {busy ? 'Opening…' : 'Reconnect'}
            </button>
          ) : (
            <span className={`shrink-0 text-[13px] text-kumo-subtle ${ON_HOVER}`}>Manage</span>
          )}
        />
      </ButtonRow>
    )
  }

  const builtInRow = (account: AccountEntry) => {
    const tab = libraryTabOfApp(account.vendorId)
    const vendor = account.vendorDescription
    if (!tab) return accountRow(account)
    return (
      // Its tab, as the Library is where scheduled tasks and skills are kept.
      <Link key={account.id} to="/library" search={{ tab }} className={ROW}>
        <GatekeeperRow
          vendor={vendor}
          detail={vendor.tagline}
          trailing={(
            <span className={`flex shrink-0 items-center gap-1 text-[13px] text-kumo-subtle ${ON_HOVER}`}>
              Open in Library
              <ArrowRight size={12} />
            </span>
          )}
        />
      </Link>
    )
  }

  const vendorRow = (vendor: VendorEntry, verb: 'Connect' | 'Add') => (
    <ButtonRow key={vendor.id} label={`${verb} ${vendor.description.displayName}`} onOpen={() => handleOpenConnect(vendor.id)}>
      <GatekeeperRow
        vendor={vendor.description}
        detail={<span className="max-sm:hidden">{vendor.description.tagline}</span>}
        trailing={<span className={`${TRAILING_PILL} ${ON_HOVER}`}>{verb}</span>}
      />
    </ButtonRow>
  )

  const nothing = !initialLoading && !loadError && filteredAccounts.length === 0 && filteredAvailable.length === 0

  return (
    <SplitPage>
      <PageHeader icon={<Plug size={16} />} title="Gatekeepers">
        <LibrarySearch query={search} onQueryChange={setSearch} placeholder="Search gatekeepers" />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 pb-16 pt-4 md:pt-8">
        <p className="px-3 text-[14px] leading-5 text-kumo-subtle">
          Connect the services your gadgets work with. A gatekeeper stands between each service and your
          gadgets, so each reaches only what you connect, and anyone you share with is checked first.
        </p>

        {loadError && (
          <p role="alert" className="px-3 text-[13px] text-kumo-danger">
            Your gatekeepers couldn&apos;t be loaded. Check your connection and refresh the page.
          </p>
        )}

        {initialLoading && (
          <div className="flex justify-center py-12">
            <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" aria-label="Loading gatekeepers" />
          </div>
        )}

        {connected.length > 0 && (
          <Section title="Connected" count={connected.length}>{connected.map(accountRow)}</Section>
        )}

        {(builtIn.length > 0 || addableBuiltIn.length > 0) && (
          <Section title="Built in">
            {builtIn.map(builtInRow)}
            {addableBuiltIn.map((vendor) => vendorRow(vendor, 'Add'))}
          </Section>
        )}

        {available.length > 0 && (
          <Section title="Available">{available.map((vendor) => vendorRow(vendor, 'Connect'))}</Section>
        )}

        {nothing && (
          <EmptyState
            title={search ? 'No gatekeepers match' : 'No gatekeepers yet'}
            description={search
              ? "We couldn't find anything matching your search."
              : 'Gatekeepers will appear here as they become available.'}
            icon={Plugs}
          />
        )}
      </div>
      {activeVendor && (
        <ConnectConnectorModal
          key={modalTarget?.kind === 'manage'
            ? `manage:${modalTarget.accountId}`
            : `connect:${modalTarget?.vendorId ?? ''}`}
          open={modalTarget !== null}
          mode={modalTarget?.kind === 'manage' ? 'manage' : 'connect'}
          vendorDescription={activeVendor.description}
          supportedResources={activeVendor.supportedResources}
          logoUrl={activeVendor.description.logo?.url}
          color={activeVendor.description.color}
          autoProvisions={isTargetAmbient}
          connecting={connecting}
          onCancelConnect={canCancelConnect ? () => connectCancellation.current?.abort() : undefined}
          onConfirm={handleConfirmConnect}
          accountDescription={activeAccount?.accountDescription}
          credentialsValid={activeAccount?.credentialsValid}
          grantedResourceUrlPatterns={activeAccount?.accountDescription.grantedResourceUrlPatterns}
          onEnsureResources={handleEnsureResources}
          ensuringResourceUrlPatterns={ensuringResourceUrlPatterns}
          disconnecting={disconnecting}
          onDisconnect={handleDisconnect}
          onOpenChange={(open) => {
            if (!open && !connecting && !disconnecting) handleCloseModal()
          }}
        />
      )}
    </SplitPage>
  )
}
