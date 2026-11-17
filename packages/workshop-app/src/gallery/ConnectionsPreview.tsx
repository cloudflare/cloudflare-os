import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { ConnectDialog } from '@/blocks/ConnectDialog'
import { ConnectionCard } from '@/blocks/ConnectionCard'
import { ConnectionRow } from '@/blocks/ConnectionRow'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { GroupedList } from '@/components/GroupedList'
import { ManageConnectionDialog } from '@/blocks/ManageConnectionDialog'
import { connectionList, connectionName, connectionsOf, type ConnectedAccount, type Connection } from '@/connections/connectionList'
import { connectDialogProps, connectionProps, manageDialogProps, type ConnectionActions } from '@/connections/connectionProps'
import { useListView } from '@/hooks/useListView'
import { useReport } from './previewState'
import { Section } from './Section'

const resource = (title: string, grantable = false, description = ''): SupportedResource => ({ urlPattern: `https://${title.toLowerCase().replaceAll(' ', '-')}.example/*`, title, description, grantable })

// A logo drawn here, in one colour, as a service's own would be.
const logo = (letter: string, ink = 'white') => ({
  url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="18" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" fill="${ink}">${letter}</text></svg>`)}`,
})

const service = (id: string, displayName: string, tagline: string, rest: Partial<GatekeeperVendorInfo['description']> = {}, supportedResources: SupportedResource[] = []): GatekeeperVendorInfo => ({
  id,
  description: { displayName, url: `https://${id}.example`, tagline, ...rest },
  supportedResources,
})

const MAIL = resource('Mail', true)
const GOOGLE = service('google', 'Google', 'Draft replies, edit docs, and analyze data', { logo: logo('G'), color: '#4285f4' }, [MAIL, resource('Calendar', true), resource('Docs', true), resource('BigQuery', true)])
const GITHUB = service('github', 'GitHub', 'Review pull requests and triage issues', {
  logo: logo('H'),
  color: '#24292f',
  description: 'Connect your GitHub account to give gadgets access to your repositories. Build agents that review pull requests, triage issues, and keep an eye on what is merged.',
}, [resource('Repository', false, 'Code, pull requests and issues of a repository')])
const JIRA = service('jira', 'Jira', 'Create, update and search issues', { logo: logo('J'), color: '#0c66e4' }, [resource('Issue')])
const SLACK = service('slack', 'Slack', 'Read channels and post messages on your behalf, wherever your team talks', {
  logo: logo('S'),
  color: '#4a154b',
  // Longer than the dialog shows of it at first.
  description: 'Connect your Slack account to give gadgets access to the channels and conversations you choose. Build agents that summarise what happened while you were away, answer questions from what was said in a channel, post updates where your team will see them, and follow up on threads that went quiet, without handing over anything you did not pick.',
}, [resource('Channel', true, 'Read and post in a channel'), resource('Direct messages', true, 'Read and send direct messages'), resource('Profile', false, 'Who you are in the workspace')])
const SENTRY = service('sentry', 'Sentry', 'Look into errors and performance issues', { logo: logo('S'), color: '#362d59' })
const LINEAR = service('linear', 'Linear with a name long enough that it has to be cut off somewhere', 'Plan and track work')
const BROKEN = service('zip', 'Zip', 'Request and approve purchases', { logo: { url: 'https://logo.invalid/zip.png' } })
// Added as they are, with nothing to sign in to.
const CONTEXT = service('context', 'Context Library', 'Notes and documents your agents can read', { autoProvisionsAccount: true })
// In black with no colour, as the real one is, drawn for a light tile.
const SCHEDULER = service('scheduler', 'Scheduled Tasks', 'Run something every morning, or once next week', { logo: logo('T', 'black'), autoProvisionsAccount: true })

// With the rest, enough of two categories for a group each, as cards too.
const CATEGORISED = [
  service('gitlab', 'GitLab', 'Triage issues, review merge requests, and push to projects', { logo: logo('L'), color: '#e24329' }),
  service('supabase', 'Supabase', 'Query Postgres, inspect schema, and manage projects', { logo: logo('S'), color: '#249361' }),
  service('cloudflare', 'Cloudflare', 'Use AI Gateway and inspect Workers Observability', { logo: logo('C'), color: '#f6821f' }),
  service('notion', 'Notion', 'Read and write your pages and databases', { logo: logo('N'), color: '#191919' }),
  // More kinds of access than its dialog has room for at once.
  service('microsoft', 'Microsoft 365', 'SharePoint, OneDrive, Outlook mail and calendars', { logo: logo('M'), color: '#0078d4' }, [
    // Said at more length than a line of the list shows at first.
    resource('SharePoint site', true, 'Search, browse and edit the pages and files of a site, its lists and their items, and the libraries it keeps its documents in, including those of the sites under it that you have been given access to.'),
    resource('OneDrive', true, 'Read and edit the files in your drive'),
    resource('Outlook mail', true, 'Read, draft and send mail'),
    resource('Outlook calendar', true, 'Read and manage your calendars'),
    resource('Teams', true, 'Read channels and post messages'),
    resource('Planner', true, 'Read and update plans and their tasks'),
  ]),
]

const VENDORS = [GOOGLE, GITHUB, JIRA, SLACK, SENTRY, LINEAR, BROKEN, ...CATEGORISED]

const account = (id: number, of: GatekeeperVendorInfo, description: Partial<ConnectedAccount['description']> = {}, credentialsValid = true): ConnectedAccount => ({
  id,
  vendorId: of.id,
  vendor: of.description,
  description: { avatar: { url: '' }, ...description },
  supportedResources: of.supportedResources,
  credentialsValid,
})

// Two accounts of one service, one given only its mail; one whose sign-in ran out; one added as it is.
const ACCOUNTS = [
  account(1, GOOGLE, { displayName: 'Ada Lovelace', uniqueName: 'ada@work.example', grantedResourceUrlPatterns: [MAIL.urlPattern] }),
  account(2, GOOGLE, { uniqueName: 'ada@home.example' }),
  account(3, JIRA, { uniqueName: 'ada.lovelace' }, false),
  account(4, SCHEDULER),
]

/** A whole list as the Connections page has one, over fake services and accounts. */
export const ConnectionsPreview = () => {
  const { report, say } = useReport()
  const [under, setUnder] = useState(false)
  const [accounts, setAccounts] = useState(ACCOUNTS)
  const [dialog, setDialog] = useState<{ connection: Connection; open: boolean }>()
  const all = connectionsOf({ vendors: VENDORS, addable: [CONTEXT, SCHEDULER], accounts })
  const inDialog = dialog && (all.find(({ key }) => key === dialog.connection.key) ?? dialog.connection)
  const closeDialog = () => setDialog((current) => current && { ...current, open: false })
  const list = useListView('gallery-connections', connectionList(all))
  const shown = list.narrow(all)
  const groups = list.arrange(shown)

  // What the real ones end in: an account connected, signed in to again, or disconnected.
  const actions: ConnectionActions = {
    open: (connection) => setDialog({ connection, open: true }),
    connect: (connection, access) => {
      say(`connect ${connectionName(connection)}${access ? ` with ${access.length} of its kinds of access` : ''}`)
      closeDialog()
      setAccounts((current) => [...current, account(Math.max(0, ...current.map(({ id }) => id)) + 1, { id: connection.vendorId, description: connection.vendor, supportedResources: connection.resources }, {
        uniqueName: connection.vendor.autoProvisionsAccount ? undefined : `ada+${current.length}@example.com`,
        grantedResourceUrlPatterns: access,
      })])
    },
    reconnect: (connection) => {
      say(`reconnect ${connectionName(connection)}`)
      closeDialog()
      setAccounts((current) => current.map((other) => (other.id === connection.account.id ? { ...other, credentialsValid: true } : other)))
    },
    addAccess: (connection, access) => {
      say(`give ${connectionName(connection)} more access`)
      closeDialog()
      setAccounts((current) => current.map((other) => (other.id === connection.account.id
        ? { ...other, description: { ...other.description, grantedResourceUrlPatterns: [...(other.description.grantedResourceUrlPatterns ?? []), ...access] } }
        : other)))
    },
    disconnect: (connection) => {
      say(`disconnect ${connectionName(connection)}`)
      closeDialog()
      setAccounts((current) => current.filter(({ id }) => id !== connection.account.id))
    },
  }
  const { search, view, filter } = list.controls

  return (
    <Section title="ConnectionCard, ConnectionRow (the Connections page’s list, as a store’s apps, two cards to a line: what needs attention first, an account whose sign-in ran out, with a red dot on its logo and a badge, whose dialog has Reconnect; then the accounts connected, a green dot on each one’s logo, whose card or row opens ManageConnectionDialog, which gives access it does not have, as the first Google account can be given, connects another account, and disconnects, asked for twice; then the services that could be connected, by category, a category with too few for the view gathered under More with those that have none. All of one’s card or row is a button, which opens ConnectDialog: what it is for, cut short with “more” after it where it runs long, as Slack’s is and Microsoft 365’s SharePoint site, and what it gives access to, with a switch for each kind given on its own, as Slack’s are, and the way on to sign in, or to add it where there is nothing to sign in to, as with Context Library. One has no logo, one’s does not load, and one’s name is too long. The filters are where a connection stands; the search also finds one by what it is for, its category, what it gives access to, and whose account it is)">
      <Switch label="Controls under the list, as on a narrow screen" checked={under} onCheckedChange={setUnder} />
      <p className="w-full text-sm text-kumo-subtle">{report}</p>
      <div className={cn('flex w-full gap-4', under ? 'flex-col-reverse' : 'flex-col')}>
        <ListToolbar noun="connections" search={search} view={view} filter={filter} at={under ? 'bottom' : 'top'} />
        {shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            No connections match.
            <Button variant="ghost" onClick={list.showAll}>Show all</Button>
          </p>
        )}
        {shown.length > 0 && (
          <div key={list.mode} className="appears">
            {list.mode === 'list'
              ? (
                  <GroupedList
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      rows: entries.map(({ value }) => ({ key: value.key, content: <ConnectionRow {...connectionProps(value, actions)} /> })),
                    }))}
                  />
                )
              : (
                  <CardGrid
                    wide
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      cards: entries.map(({ value }) => ({ key: value.key, content: <ConnectionCard {...connectionProps(value, actions)} /> })),
                    }))}
                  />
                )}
          </div>
        )}
      </div>
      {dialog && inDialog?.kind === 'service' && (
        <ConnectDialog
          {...connectDialogProps(inDialog)}
          open={dialog.open}
          onOpenChange={(open) => setDialog({ ...dialog, open })}
          onConnect={(access) => actions.connect(inDialog, access)}
        />
      )}
      {dialog && inDialog?.kind === 'account' && (
        <ManageConnectionDialog {...manageDialogProps(inDialog, actions)} open={dialog.open} onOpenChange={(open) => setDialog({ ...dialog, open })} />
      )}
    </Section>
  )
}
