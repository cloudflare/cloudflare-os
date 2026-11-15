import { useRef, useState } from 'react'
import { AddConnectionDialog, type ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import { Button } from '@/components/Button'
import { ChangeDefaultsList, type ChangeDefaultsGroup } from '@/blocks/ChangeDefaultsList'
import { ConnectionAccountView } from '@/blocks/ConnectionAccountView'
import { ConnectionDialog, type ConnectionDialogResource } from '@/blocks/ConnectionDialog'
import { ConnectionRow } from '@/blocks/ConnectionRow'
import { SetUpConnectionDialog, type SetUpConnectionAccount } from '@/blocks/SetUpConnectionDialog'
import { ListGroup } from '@/blocks/ListGroup'
import { ServiceLogo } from '@/components/ServiceLogo'
import { useReport } from './previewState'
import { Section } from './Section'

const google = { name: 'Google', tagline: 'Draft replies, edit docs, and analyse data', color: '#ffffff' }
const googleResources: ConnectionDialogResource[] = [
  { urlPattern: 'https://mail.google.com/*', title: 'Gmail', description: 'Read, label and draft email', grantable: true },
  { urlPattern: 'https://docs.google.com/*', title: 'Docs', description: 'Read and edit documents', grantable: true },
  { urlPattern: 'https://calendar.google.com/*', title: 'Calendar', description: 'See and add events', grantable: true },
]
const github = {
  name: 'GitHub',
  tagline: 'Repositories, issues and pull requests',
  description: 'Connect your GitHub account so gadgets can read code, triage issues and open pull requests in the repositories you choose.',
}
const githubResources: ConnectionDialogResource[] = [
  { urlPattern: 'https://github.com/:owner/:repo', title: 'Repository', description: 'Code, issues and pull requests in one repository' },
]

type Open = 'connect' | 'connect-granular' | 'add' | SetUp | undefined
type SetUp = 'setup-loading' | 'setup-none' | 'setup-ready' | 'setup-expired' | 'setup-grant' | 'setup-create' | 'setup-create-none'

/** The Connections page's rows, the dialog to connect a service, and an account's own page. */
export const ConnectionsPreview = () => {
  const { report, say, later } = useReport()
  const [open, setOpenAt] = useState<Open>()
  // Bumped on each opening, so each starts afresh, and kept as it closes, so it closes as it was.
  const [round, setRound] = useState(0)
  const setOpen = (next: Open) => {
    if (next) setRound((count) => count + 1)
    setOpenAt(next)
  }
  const close = (next: boolean) => { if (!next) setOpen(undefined) }
  const opened = async () => {
    await later()
    say('the service’s window opened')
    return true
  }

  return (
    <>
      <Section title="ServiceLogo (with a picture, on the service’s colour, one with none, and one whose picture failed; in a row and heading a dialog)">
        <ServiceLogo name="Cloudflare" src="/favicon.svg" />
        <ServiceLogo name="Google" color="#ffffff" />
        <ServiceLogo name="Linear" />
        <ServiceLogo name="Broken" src="/missing.png" />
        <ServiceLogo name="GitHub" size="lg" />
      </Section>
      <Section title="ConnectionRow (an account, one with another name, an expired one to reconnect, built in, and one to connect; point at one for what it does)">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <ListGroup label="Connected">
            <ConnectionRow name="GitHub" detail="octocat" verb="Manage" onSelect={() => say('manage GitHub')} />
            <ConnectionRow name="Google" logo={{ color: '#ffffff' }} detail="ada@example.com · a very long account name that has to be cut short" verb="Manage" onSelect={() => say('manage Google')} />
            <ConnectionRow
              name="Linear"
              detail="Sign-in expired"
              problem
              verb="Manage"
              onSelect={() => say('manage Linear')}
              action={<Button onClick={() => say('reconnect Linear')}>Reconnect</Button>}
            />
          </ListGroup>
          <ListGroup label="Built in">
            <ConnectionRow name="Scheduled Tasks" detail="Run agents on a schedule" verb="Manage" onSelect={() => say('manage Scheduled Tasks')} />
            <ConnectionRow name="Web Search" detail="Search the web" verb="Add" onSelect={() => say('add Web Search')} />
          </ListGroup>
          <ListGroup label="Available">
            <ConnectionRow name="Slack" detail="Channels and messages" verb="Connect" onSelect={() => say('connect Slack')} />
          </ListGroup>
        </div>
      </Section>
      <Section title="ConnectionDialog (connect; choose what it can reach, of which at least one; add one built in)">
        <Button onClick={() => setOpen('connect')}>Connect</Button>
        <Button onClick={() => setOpen('connect-granular')}>Connect, choosing</Button>
        <Button onClick={() => setOpen('add')}>Add built in</Button>
      </Section>
      <Section title="ChangeDefaultsList (every kind of change a service can make, by what it changes: Ask first or Automatic in every workspace the user owns; one that can never go ahead on its own requires approval always; one a workspace lets go ahead though the service asks says where, with Ask there too)">
        <div className="w-full max-w-3xl"><DefaultsPreview /></div>
      </Section>
      <Section title="ConnectionAccountView (an account’s page, from the Gatekeepers page: what changes go ahead on their own, in every workspace; what it can reach, with more to grant, which waits for its window; disconnecting, asked first. Signed in, expired, still reading, and a service that changes nothing)">
        <AccountPreview />
      </Section>
      <Section title="SetUpConnectionDialog (a chat’s connection request: accounts loading, none yet, one with the service’s form, an expired one, one without access)">
        <Button onClick={() => setOpen('setup-loading')}>Loading</Button>
        <Button onClick={() => setOpen('setup-none')}>No account</Button>
        <Button onClick={() => setOpen('setup-ready')}>With the form</Button>
        <Button onClick={() => setOpen('setup-expired')}>Expired</Button>
        <Button onClick={() => setOpen('setup-grant')}>Needs access</Button>
      </Section>
      <Section title="SetUpConnectionDialog, creating (approving a card that creates a Google Doc, with two accounts to choose between and the service’s form for where; and with no account yet). With one account, Approve creates it there without asking">
        <Button onClick={() => setOpen('setup-create')}>Two accounts</Button>
        <Button onClick={() => setOpen('setup-create-none')}>No account</Button>
      </Section>
      <Section title="AddConnectionDialog, then SetUpConnectionDialog with Back, and ComposerConnectionLines (the + menu’s Add a connection: what kind, found by typing, your services first; then which, in the service’s form; then it sits above the draft, to go with the message, and is refused beside a skill)">
        <AddConnectionPreview say={say} opened={opened} />
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      {open?.startsWith('setup') && <SetUpPreview key={round} state={open as SetUp} onClose={() => setOpenAt(undefined)} say={say} opened={opened} />}
      <ConnectionDialog key={`connect-${round}`} open={open === 'connect'} onOpenChange={close} service={github} resources={githubResources} onConnect={opened} />
      <ConnectionDialog key={`granular-${round}`} open={open === 'connect-granular'} onOpenChange={close} service={google} resources={googleResources} onConnect={opened} />
      <ConnectionDialog
        key={`add-${round}`}
        open={open === 'add'}
        onOpenChange={close}
       
        ambient
        service={{ name: 'Web Search', tagline: 'Search the web', description: 'Lets agents look things up on the web. It comes with this deployment.' }}
        resources={[]}
        onConnect={async () => {
          await later()
          setOpen(undefined)
          say('Web Search added')
          return true
        }}
      />
    </>
  )
}

const change = (tag: string, label: string, automatic = false, autoApprovable = true, alsoIn?: string[]) =>
  ({ kind: { tag, label }, autoApprovable, automatic, ...(alsoIn ? { alsoIn } : {}) })

const GROUPS: ChangeDefaultsGroup[] = [
  { key: 'gmail', title: 'Gmail', changes: [
    change('gmail.label', 'Labels and archiving, in any message this connection reaches', true),
    change('gmail.draft', 'Drafts, in this mailbox'),
    change('gmail.send', 'Send email', false, false),
    change('gmail.draftSend', 'Send drafts', false, false),
  ] },
  { key: 'doc', title: 'Google Doc', changes: [
    change('editDocument', 'Document edits, in any Doc this connection reaches', false, true, ['Quarterly planning']),
    change('addTab', 'New tabs, in any Doc this connection reaches'),
    change('docComments', 'Comments and replies, in any Doc this connection reaches', true),
  ] },
  { key: 'sheet', title: 'Google Sheet', changes: [
    change('editSheetValues', 'Sheet value edits, in any spreadsheet this connection reaches', false, true, ['Board pack', 'Budget']),
    change('formatSheets', 'Sheet formatting, in any spreadsheet this connection reaches'),
  ] },
  { key: 'drive', title: 'Drive file', changes: [
    change('driveComments', 'Drive comments'),
    change('share', 'Sharing', false, false),
  ] },
]

const toggled = (groups: ChangeDefaultsGroup[], tag: string, update: (one: ChangeDefaultsGroup['changes'][number]) => ChangeDefaultsGroup['changes'][number]) =>
  groups.map((group) => ({ ...group, changes: group.changes.map((one) => (one.kind.tag === tag ? update(one) : one)) }))

const useGroups = () => {
  const [groups, setGroups] = useState(GROUPS)
  return {
    groups,
    set: (tag: string, automatic: boolean) => setGroups((current) => toggled(current, tag, (one) => ({ ...one, automatic, alsoIn: automatic ? undefined : one.alsoIn }))),
    askEverywhere: (tag: string) => setGroups((current) => toggled(current, tag, ({ alsoIn: _, ...one }) => one)),
  }
}

const DefaultsPreview = () => {
  const { groups, set, askEverywhere } = useGroups()
  return <ChangeDefaultsList groups={groups} onChange={(kind, automatic) => set(kind.tag, automatic)} onAskEverywhere={(kind) => askEverywhere(kind.tag)} />
}

type AccountState = 'signed-in' | 'expired' | 'loading' | 'nothing'

const AccountPreview = () => {
  const { report, say, later } = useReport()
  const [state, setState] = useState<AccountState>('signed-in')
  const { groups, set, askEverywhere } = useGroups()
  const [granted, setGranted] = useState(['https://mail.google.com/*'])
  const [failing, setFailing] = useState(false)
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {(['signed-in', 'expired', 'loading', 'nothing'] as const).map((each) => (
          <Button key={each} variant={each === state ? 'primary' : 'secondary'} onClick={() => setState(each)}>{each}</Button>
        ))}
        <Button variant={failing ? 'primary' : 'secondary'} onClick={() => setFailing((current) => !current)}>Changes fail</Button>
      </div>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      <div className="w-full rounded-3xl ring-1 ring-kumo-line">
        <ConnectionAccountView
          key={state}
          service={google}
          account={state === 'expired' ? undefined : 'ada@example.com'}
          expired={state === 'expired'}
          resources={googleResources}
          granted={granted}
          onGrant={async (urlPatterns) => {
            await later()
            say('the service’s window opened')
            setTimeout(() => setGranted((current) => [...current, ...urlPatterns]), 2500)
            return true
          }}
          onReconnect={async () => {
            await later()
            say('the service’s window opened')
            return true
          }}
          onDisconnect={async () => {
            await later()
            say('Google disconnected')
            return true
          }}
          changes={state === 'loading' ? undefined : state === 'nothing' ? [] : groups}
          onChange={(kind, automatic) => {
            set(kind.tag, automatic)
            say(`${kind.tag}: ${automatic ? 'automatic' : 'ask first'}`)
            if (failing) setTimeout(() => set(kind.tag, !automatic), 600)
          }}
          onAskEverywhere={(kind) => {
            askEverywhere(kind.tag)
            say(`${kind.tag}: asks first everywhere`)
          }}
          changeProblem={failing ? 'Couldn’t change “Document edits”: The server didn’t answer.' : undefined}
        />
      </div>
    </div>
  )
}

const setUpAccounts: Record<SetUp, SetUpConnectionAccount[] | undefined> = {
  'setup-loading': undefined,
  'setup-none': [],
  'setup-ready': [{ id: 1, name: 'octocat' }, { id: 2, name: 'octo-work' }],
  'setup-expired': [{ id: 1, name: 'octocat', expired: true }],
  'setup-grant': [{ id: 1, name: 'octocat' }],
  'setup-create': [{ id: 1, name: 'ada@example.com' }, { id: 2, name: 'ada@work.example' }],
  'setup-create-none': [],
}

/** A stand-in for Google's creation form, which says where in Drive. */
const FakeFolderChooser = () => (
  <label className="flex flex-col gap-1.5 text-sm text-kumo-subtle">
    Where
    <select className="h-9 rounded-xl bg-kumo-base px-3 text-base text-kumo-default ring-1 ring-kumo-line">
      <option>My Drive</option>
      <option>My Drive › Meeting notes</option>
      <option>Shared drives › Platform</option>
    </select>
  </label>
)

/** A stand-in for the service's own form, which is a sandboxed frame of the gatekeeper's. */
const FakeConfigurator = ({ onReady }: { onReady: (ready: boolean) => void }) => (
  <label className="flex flex-col gap-1.5 text-sm text-kumo-subtle">
    Repository
    <input
      defaultValue="cloudflare/"
      onChange={(event) => onReady(/^[\w.-]+\/[\w.-]+$/.test(event.target.value))}
      className="h-9 rounded-xl bg-kumo-base px-3 text-base text-kumo-default ring-1 ring-kumo-line"
    />
  </label>
)

const SetUpPreview = ({ state, onClose, say, opened }: { state: SetUp; onClose: () => void; say: (what: string) => void; opened: () => Promise<boolean> }) => {
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState(1)
  const [ready, setReady] = useState(false)
  if (state === 'setup-create' || state === 'setup-create-none') {
    return (
      <SetUpConnectionDialog
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) setTimeout(onClose, 300) }}
        service={{ name: 'Google', color: '#ffffff' }}
        title="Create Google Doc: Weekly notes"
        accept={{ label: 'Create', pending: 'Creating…' }}
        noAccount="Connect your Google account first. It’s created there."
        resource="Google Doc"
        description="Choose the account to create it in, and where."
        accounts={setUpAccounts[state]}
        selectedAccountId={selected}
        onSelectAccount={setSelected}
        onConnectAccount={opened}
        onReconnect={opened}
        configurator={<FakeFolderChooser />}
        ready
        onAccept={async () => {
          await new Promise((resolve) => setTimeout(resolve, 900))
          say('created, and the agent’s connection is to it now')
          setOpen(false)
          setTimeout(onClose, 300)
          return true
        }}
      />
    )
  }
  return (
    <SetUpConnectionDialog
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setTimeout(onClose, 300) }}
      service={{ name: 'GitHub' }}
      resource="a GitHub repository"
      description="The agent asked for a GitHub repository."
      reason="I need to read the open issues in cloudflare/gadgets to sort them by how long they have waited."
      accounts={setUpAccounts[state]}
      selectedAccountId={selected}
      onSelectAccount={setSelected}
      onConnectAccount={opened}
      onReconnect={opened}
      onGrant={state === 'setup-grant' ? opened : undefined}
      configurator={<FakeConfigurator onReady={setReady} />}
      ready={ready}
      onAccept={async () => {
        await new Promise((resolve) => setTimeout(resolve, 900))
        say('connected, and handed to the agent')
        setOpen(false)
        setTimeout(onClose, 300)
        return true
      }}
    />
  )
}

const CHOICES: ConnectionChoice[] = [
  { key: 'repo', service: { name: 'GitHub' }, title: 'Repository', description: 'Code, issues and pull requests', connected: true },
  { key: 'sheet', service: { name: 'Google', color: '#1a73e8' }, title: 'Spreadsheet', description: 'A Google Sheets file', connected: true },
  { key: 'doc', service: { name: 'Google', color: '#1a73e8' }, title: 'Document', description: 'A Google Docs file', connected: true },
  { key: 'page', service: { name: 'Notion' }, title: 'Page', description: 'A page and what is under it', connected: false },
  { key: 'team', service: { name: 'Linear' }, title: 'Team', description: 'A team’s issues and cycles', connected: false },
]

/** The + menu's Add a connection, end to end, into a composer's draft. */
const AddConnectionPreview = ({ say, opened }: { say: (what: string) => void; opened: () => Promise<boolean> }) => {
  const composer = useRef<ComposerHandle>(null)
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<ConnectionChoice>()
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex gap-2">
        <Button onClick={() => { setLoading(false); setChoosing(true) }}>Add a connection</Button>
        <Button variant="ghost" onClick={() => { setLoading(true); setChoosing(true) }}>While services load</Button>
      </div>
      <Composer
        ref={composer}
        onSend={(text, _files, command, connections) => {
          say(`sent “${text}”${connections?.length ? ` with ${connections.map(({ title }) => title).join(' and ')}` : ''}${command ? ` using ${command.title}` : ''}`)
          return true
        }}
        addActions={{ onAddConnection: () => setChoosing(true) }}
        commands={[{ key: 'brief', name: 'meeting-brief', title: 'Meeting brief', description: 'Before a meeting, gather who is coming.', kind: 'skill' }]}
      />
      <AddConnectionDialog
        open={choosing && !chosen}
        onOpenChange={setChoosing}
        to="this chat"
        choices={loading ? undefined : CHOICES}
        onChoose={setChosen}
      />
      {chosen && (
        <SetUpConnectionDialog
          open={choosing}
          onOpenChange={(next) => {
            setChoosing(next)
            if (!next) setChosen(undefined)
          }}
          service={chosen.service}
          resource={chosen.title}
          description={`Choose which ${chosen.title.toLowerCase()} this chat can use.`}
          onBack={() => setChosen(undefined)}
          accounts={chosen.connected ? [{ id: 1, name: chosen.service.name === 'GitHub' ? 'octocat' : 'ada@example.com' }] : []}
          selectedAccountId={1}
          onSelectAccount={() => {}}
          onConnectAccount={opened}
          onReconnect={opened}
          configurator={<FakeConfigurator onReady={setReady} />}
          ready={ready}
          onAccept={async () => {
            await new Promise((resolve) => setTimeout(resolve, 900))
            composer.current?.addConnection({ key: `${chosen.key}-${Date.now()}`, title: chosen.key === 'repo' ? 'cloudflare/gadgets' : 'Q3 forecast', kind: chosen.title, service: chosen.service })
            setChoosing(false)
            setChosen(undefined)
            return true
          }}
        />
      )}
    </div>
  )
}
