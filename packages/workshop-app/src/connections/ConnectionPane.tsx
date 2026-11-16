import { CaretLeftIcon } from '@phosphor-icons/react'
import { ConnectionAccountView } from '@/blocks/ConnectionAccountView'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useConnectedAccounts } from './ConnectedAccountsContext'
import { openConnectWindow } from './connectHandoff'
import { accountName, grantedGroups, resourcesOf, serviceOf, withGrouped } from './connectionGroups'
import { changeGroups } from './changeGroups'
import { useChangeDefaults } from './useChangeDefaults'
import { useWorkspaceRules } from './useWorkspaceRules'

export type ConnectionPaneProps = {
  accountId: number
  /** Back to the Gatekeepers page, as when the account is gone. */
  onBack: () => void
}

/**
 * One connected account's page (`ConnectionAccountView`), opened from the Gatekeepers page: every
 * kind of change its service can make, and which go ahead without asking in the user's workspaces
 * (`useChangeDefaults`), with the workspaces that let one go ahead though the service asks
 * (`useWorkspaceRules`); what it can reach; reconnecting it; and disconnecting it, after which it
 * goes back.
 */
export const ConnectionPane = ({ accountId, onBack }: ConnectionPaneProps) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const accounts = useConnectedAccounts()
  const account = accounts.status === 'ready' ? accounts.accounts.find(({ id }) => id === accountId) : undefined
  const defaults = useChangeDefaults(account?.vendorId)
  const workspaceRules = useWorkspaceRules(account?.vendorId)
  useDocumentTitle(account?.vendor.displayName ?? 'Gatekeeper')

  // The workspaces that let each kind go ahead though the service asks first, by tag.
  const alsoIn = new Map<string, string[]>()
  for (const { tag, workspaceTitle } of workspaceRules.rules ?? []) {
    const titles = alsoIn.get(tag) ?? []
    if (!titles.includes(workspaceTitle)) titles.push(workspaceTitle)
    alsoIn.set(tag, titles)
  }

  const header = (
    <HeaderBubble>
      <Button icon={CaretLeftIcon} onClick={onBack}>Gatekeepers</Button>
    </HeaderBubble>
  )

  if (!account) {
    return (
      <PageLayout header={header}>
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 pt-16 text-center">
          {accounts.status === 'loading' && <p role="status" className="appears-late text-base text-kumo-subtle">Loading the connection…</p>}
          {accounts.status === 'failed' && <p className="text-base text-kumo-subtle">Couldn’t load your connections: {accounts.message}</p>}
          {accounts.status === 'ready' && (
            <>
              <p className="text-base text-kumo-subtle">This account isn’t connected anymore.</p>
              <Button onClick={onBack}>See your gatekeepers</Button>
            </>
          )}
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout header={header}>
      <ConnectionAccountView
        key={account.id}
        service={serviceOf(account.vendor)}
        account={accountName(account)}
        expired={!account.credentialsValid}
        resources={resourcesOf(account.supportedResources)}
        granted={grantedGroups(account.supportedResources, account.description.grantedResourceUrlPatterns)}
        onGrant={async (urlPatterns) => {
          if (connection?.blocked()) return false
          const flow = await api.ensureAccountResources(account.id, withGrouped(account.supportedResources, urlPatterns))
          if (flow) openConnectWindow(flow)
          return true
        }}
        onReconnect={async () => {
          if (connection?.blocked()) return false
          openConnectWindow(await api.reconnectAccount(account.id))
          return true
        }}
        onDisconnect={async () => {
          if (connection?.blocked()) return false
          await api.disconnectAccount(account.id)
          onBack()
          return true
        }}
        changes={defaults.automatic && changeGroups(account.supportedResources, defaults.automatic, alsoIn)}
        onChange={defaults.change}
        onAskEverywhere={(kind) => workspaceRules.clear(kind.tag, kind.label)}
        changeProblem={defaults.problem ?? workspaceRules.problem}
      />
    </PageLayout>
  )
}
