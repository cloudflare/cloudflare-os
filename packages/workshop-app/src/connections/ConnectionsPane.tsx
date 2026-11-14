import { useState, type ReactNode } from 'react'
import { PlugsConnectedIcon } from '@phosphor-icons/react'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionDialog, type ConnectionDialogResource } from '@/blocks/ConnectionDialog'
import { ConnectionRow } from '@/blocks/ConnectionRow'
import { ListGroup } from '@/blocks/ListGroup'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { ConnectedAccount } from './ConnectedAccounts'
import { useConnectedAccounts } from './ConnectedAccountsContext'
import { openConnectWindow } from './connectHandoff'
import { accountName, groupConnections, newAccountOf } from './connectionGroups'
import { useServices } from './useServices'

/** The dialog open, and what it is for. */
type Target =
  /** `before`: the accounts there were, so the one the flow makes is known when it comes. */
  | { kind: 'connect'; vendor: GatekeeperVendorInfo; before: ReadonlySet<number> }
  | { kind: 'manage'; accountId: number }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const resourcesOf = (resources: GatekeeperVendorInfo['supportedResources']): ConnectionDialogResource[] =>
  resources.map(({ urlPattern, title, description, icon, grantable }) => ({ urlPattern, title, description, iconUrl: icon?.url, grantable }))

const serviceOf = ({ displayName, tagline, description, logo, color }: GatekeeperVendorInfo['description']) =>
  ({ name: displayName, tagline, description, logoUrl: logo?.url, color })

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="flex flex-col gap-2">
    <h2 className="px-4 text-sm font-medium text-kumo-subtle">{title}</h2>
    <ListGroup label={title}>{children}</ListGroup>
  </div>
)

/**
 * The services the user has connected, and those they can (the sidebar's connect button): the
 * accounts they signed in to, what comes with the deployment, then what else there is. Each opens
 * a dialog to connect it or manage its account (`ConnectionDialog`). Connecting goes on in a
 * window of the service's, and the account arrives as any does, which is when the dialog goes.
 */
export const ConnectionsPane = () => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const accounts = useConnectedAccounts()
  const { services, reread } = useServices()
  const [target, setTarget] = useState<Target>()
  // Why the last thing asked of a row did not happen.
  const [problem, setProblem] = useState<string>()
  useDocumentTitle('Connections')

  const all = accounts.status === 'ready' ? accounts.accounts : []
  const groups = groupConnections(all, services.status === 'ready' ? services.vendors : [], services.status === 'ready' ? services.addable : [])

  // The account a connect flow made has come: it is connected, and the dialog is done.
  const made = target?.kind === 'connect' && newAccountOf(all, target.vendor.id, target.before)
  if (made) setTarget(undefined)
  const managed = target?.kind === 'manage' ? all.find(({ id }) => id === target.accountId) : undefined
  // The account went while it was being managed, as when disconnected elsewhere.
  if (target?.kind === 'manage' && accounts.status === 'ready' && !managed) setTarget(undefined)

  const reconnect = async (account: ConnectedAccount) => {
    setProblem(undefined)
    if (connection?.blocked()) return false
    openConnectWindow(await api.reconnectAccount(account.id))
    return true
  }
  const connect = async (vendor: GatekeeperVendorInfo, urlPatterns: string[] | undefined) => {
    if (connection?.blocked()) return false
    if (vendor.description.autoProvisionsAccount) {
      await api.provisionAmbientAccount(vendor.id)
      reread()
      setTarget(undefined)
      return true
    }
    openConnectWindow(await api.connectAccount(vendor.id, urlPatterns))
    return true
  }
  const open = (next: Target) => {
    setProblem(undefined)
    setTarget(next)
  }

  const accountRow = (account: ConnectedAccount) => {
    const { vendor } = account
    const expired = !account.credentialsValid
    return (
      <ConnectionRow
        key={account.id}
        name={vendor.displayName}
        logo={{ src: vendor.logo?.url, color: vendor.color }}
        detail={expired ? 'Sign-in expired' : accountName(account) ?? vendor.tagline}
        problem={expired}
        verb="Manage"
        onSelect={() => open({ kind: 'manage', accountId: account.id })}
        action={expired ? (
          <Button
            onClick={() => {
              reconnect(account).catch((error: unknown) => setProblem(`Couldn’t reconnect ${vendor.displayName}: ${messageOf(error)}`))
            }}
          >
            Reconnect
          </Button>
        ) : undefined}
      />
    )
  }
  const vendorRow = (vendor: GatekeeperVendorInfo, verb: 'Connect' | 'Add') => (
    <ConnectionRow
      key={vendor.id}
      name={vendor.description.displayName}
      logo={{ src: vendor.description.logo?.url, color: vendor.description.color }}
      detail={vendor.description.tagline}
      verb={verb}
      onSelect={() => open({ kind: 'connect', vendor, before: new Set(all.map(({ id }) => id)) })}
    />
  )

  const loading = accounts.status === 'loading' || services.status === 'loading'
  const nothing = !loading && groups.connected.length + groups.builtIn.accounts.length + groups.builtIn.addable.length + groups.available.length === 0

  return (
    <PageLayout
      header={(
        <HeaderBubble>
          <h1 className="flex h-9 items-center gap-2 rounded-full bg-kumo-base pr-4 pl-3 text-base font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <PlugsConnectedIcon aria-hidden="true" />
            Connections
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-5 pb-8">
        <p className="px-4 text-base text-kumo-subtle">
          Connect the services your gadgets work with. Each gadget reaches only what you connect it to, and
          anyone you share it with is checked first.
        </p>
        {loading && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading connections…</p>}
        {accounts.status === 'failed' && <p className="px-4 text-base text-kumo-subtle">Couldn’t load your connections: {accounts.message}</p>}
        {services.status === 'failed' && (
          <p className="flex items-center gap-3 px-4 text-base text-kumo-subtle">
            Couldn’t load what can be connected: {services.message}
            <Button variant="ghost" onClick={services.retry}>Try again</Button>
          </p>
        )}
        {problem && <p role="alert" className="px-4 text-base text-kumo-danger">{problem}</p>}
        {groups.connected.length > 0 && <Group title="Connected">{groups.connected.map(accountRow)}</Group>}
        {groups.builtIn.accounts.length + groups.builtIn.addable.length > 0 && (
          <Group title="Built in">
            {groups.builtIn.accounts.map(accountRow)}
            {groups.builtIn.addable.map((vendor) => vendorRow(vendor, 'Add'))}
          </Group>
        )}
        {groups.available.length > 0 && <Group title="Available">{groups.available.map((vendor) => vendorRow(vendor, 'Connect'))}</Group>}
        {nothing && <p className="px-4 text-center text-base text-kumo-subtle">Nothing can be connected yet.</p>}
      </div>
      {target?.kind === 'connect' && (
        <ConnectionDialog
          key={`connect:${target.vendor.id}`}
          open
          onOpenChange={(next) => { if (!next) setTarget(undefined) }}
          mode="connect"
          ambient={target.vendor.description.autoProvisionsAccount}
          service={serviceOf(target.vendor.description)}
          resources={resourcesOf(target.vendor.supportedResources)}
          onConnect={(urlPatterns) => connect(target.vendor, urlPatterns)}
        />
      )}
      {managed && (
        <ConnectionDialog
          key={`manage:${managed.id}`}
          open
          onOpenChange={(next) => { if (!next) setTarget(undefined) }}
          mode="manage"
          account={accountName(managed)}
          expired={!managed.credentialsValid}
          granted={managed.description.grantedResourceUrlPatterns}
          service={serviceOf(managed.vendor)}
          resources={resourcesOf(managed.supportedResources)}
          onGrant={async (urlPatterns) => {
            if (connection?.blocked()) return false
            const flow = await api.ensureAccountResources(managed.id, urlPatterns)
            if (flow) openConnectWindow(flow)
            return true
          }}
          onReconnect={() => reconnect(managed)}
          onDisconnect={async () => {
            if (connection?.blocked()) return false
            await api.disconnectAccount(managed.id)
            reread()
            return true
          }}
        />
      )}
    </PageLayout>
  )
}
