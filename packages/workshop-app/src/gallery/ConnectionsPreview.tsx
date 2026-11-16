import { useRef, useState } from 'react'
import { AddConnectionDialog, type ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import { Button } from '@/components/Button'
import { ChangeRulesList, type ChangeRule } from '@/blocks/ChangeRulesList'
import { ConnectionDetailsDialog, type ConnectionUse } from '@/blocks/ConnectionDetailsDialog'
import { WorkspaceConnectionRow } from '@/blocks/WorkspaceConnectionRow'
import { FormatIcon } from '@/components/FormatIcon'
import { KindMark } from '@/components/KindMark'
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
      <Section title="WorkspaceConnectionRow (a workspace’s Connections tab, by service: what it is and what uses it, and what goes ahead without asking, under the title on a narrow screen; one nothing uses yet; one every chat has)">
        <WorkspaceRowsPreview say={say} />
      </Section>
      <Section title="ChangeRulesList (every kind of change one connection can make: Ask first or Allow for its workspace; one that can never go ahead on its own always asks; and as shown where nothing can be chosen)">
        <RulesPreview />
      </Section>
      <Section title="ConnectionDetailsDialog (one of a workspace’s connections, from its row or a chat’s or gadget’s More: what uses it, gadgets then chats, a published gadget saying it asks separately, the first five until all; its changes; the account, and from a chat or gadget the rest. Also with nothing using it, in a workspace that contains restricted data, and for whoever only uses it)">
        <DetailsPreview say={say} />
      </Section>
      <Section title="ConnectionAccountView (an account’s page, from the Gatekeepers page: what it can reach, with more to grant, which waits for its window; that what goes ahead is each workspace’s, with what still goes ahead everywhere from before, to make ask first; disconnecting, asked first. Signed in, expired, and with nothing left from before)">
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
      <Section title="AddConnectionDialog, then SetUpConnectionDialog with Back, and ComposerConnectionLines (the + menu’s Add a connection: what kind, found by typing, your services first; then which, in the service’s form; then it sits above the draft, to go with the message, and is refused beside a skill; a pasted Google Doc link connects by itself, connecting then named in the words, or says why not, with “missing” in it)">
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

const change = (tag: string, label: string, automatic = false, autoApprovable = true): ChangeRule =>
  ({ kind: { tag, label }, autoApprovable, automatic })

const CHANGES: ChangeRule[] = [
  change('editDocument', 'Document edits, in any Doc this connection reaches', true),
  change('addTab', 'New tabs, in any Doc this connection reaches'),
  change('docComments', 'Comments and replies, in any Doc this connection reaches'),
  change('share', 'Sharing', false, false),
]

const useChanges = () => {
  const [changes, setChanges] = useState(CHANGES)
  return {
    changes,
    set: (tag: string, automatic: boolean) => setChanges((current) => current.map((one) => (one.kind.tag === tag ? { ...one, automatic } : one))),
  }
}

const RulesPreview = () => {
  const { changes, set } = useChanges()
  return (
    <div className="flex w-full max-w-xl flex-col gap-3">
      <ChangeRulesList changes={changes} onChange={(kind, automatic) => set(kind.tag, automatic)} />
      <ChangeRulesList changes={changes} onChange={() => {}} disabled />
    </div>
  )
}

const GADGET_COLOR = 'blue' as const

const WorkspaceRowsPreview = ({ say }: { say: (what: string) => void }) => (
  <div className="flex w-full max-w-3xl flex-col gap-6">
    {[
      { label: 'GitHub', rows: [{ title: 'acme/storefront', detail: 'GitHub Repository · Used by Release Notes and 3 chats', automatic: '2 changes allowed' }] },
      { label: 'Google', rows: [
        { title: 'Quarterly planning', detail: 'Google Doc · Used by Tip Jar and a chat', automatic: 'Document edits allowed' },
        { title: 'Team calendar', detail: 'Google Calendar · Not used yet' },
      ] },
      { label: 'Every chat has', rows: [{ title: 'Web Search', detail: 'Used in 4 chats' }] },
    ].map((group) => (
      <section key={group.label} className="flex flex-col gap-2">
        <h2 className="px-4 text-sm font-medium text-kumo-subtle">{group.label}</h2>
        <ListGroup label={group.label}>
          {group.rows.map((row) => (
            <WorkspaceConnectionRow key={row.title} {...row} logo={{ name: group.label }} onOpen={() => say(`open ${row.title}`)} />
          ))}
        </ListGroup>
      </section>
    ))}
  </div>
)

type DetailsState = 'used' | 'unused' | 'restricted' | 'uses'

const DetailsPreview = ({ say }: { say: (what: string) => void }) => {
  const [open, setOpen] = useState<DetailsState>()
  const [shown, setShown] = useState<DetailsState>('used')
  const { changes, set } = useChanges()
  const uses: ConnectionUse[] = [
    { key: 'g1', icon: <FormatIcon name="dashboard" color={GADGET_COLOR} />, title: 'Tip Jar', detail: 'Gadget', onOpen: () => say('open Tip Jar') },
    { key: 'g2', icon: <FormatIcon name="listChecks" />, title: 'Launch checklist', detail: 'Made by Ada, so it asks separately', onOpen: () => say('open Launch checklist') },
    { key: 'a1', icon: <KindMark name="agent" />, title: 'Weekly digest', detail: 'Agent · 4 runs', onOpen: () => say('open Weekly digest’s latest run') },
    ...['Plan the offsite', 'Q3 board pack', 'Budget review', 'Hiring plan'].map((title, index) => ({
      key: `c${index}`, icon: <span className="size-5 rounded-full bg-kumo-contrast/10" />, title, detail: 'Chat', onOpen: () => say(`open ${title}`),
    })),
  ]
  const show = (state: DetailsState) => {
    setShown(state)
    setOpen(state)
  }
  return (
    <>
      {(['used', 'unused', 'restricted', 'uses'] as const).map((state) => (
        <Button key={state} onClick={() => show(state)}>{{ used: 'From the workspace', unused: 'Nothing uses it', restricted: 'Restricted data', uses: 'Only uses it' }[state]}</Button>
      ))}
      <ConnectionDetailsDialog
        open={open !== undefined}
        onOpenChange={(next) => { if (!next) setOpen(undefined) }}
        title="Quarterly planning"
        logo={{ name: 'Google' }}
        kind="Google Doc"
        serviceLink={{ label: 'Open in Google', href: 'https://example.com/doc' }}
        uses={shown === 'unused' ? [] : uses}
        changes={changes}
        onChange={(kind, automatic) => {
          set(kind.tag, automatic)
          say(`${kind.tag}: ${automatic ? 'allow' : 'ask first'}`)
        }}
        locked={shown === 'restricted'
          ? 'This workspace contains restricted data, so every change asks you first.'
          : shown === 'uses' ? 'Only whoever builds in this workspace chooses what goes ahead without asking.' : undefined}
        account={{ label: 'Google account', onOpen: () => say('the account’s page') }}
        onSeeAll={shown === 'used' ? undefined : () => say('the workspace’s connections')}
      />
    </>
  )
}

type AccountState = 'signed-in' | 'expired' | 'nothing'

const AccountPreview = () => {
  const { report, say, later } = useReport()
  const [state, setState] = useState<AccountState>('signed-in')
  const [everywhere, setEverywhere] = useState(['Document edits', 'Sheet value edits'])
  const [granted, setGranted] = useState(['https://mail.google.com/*'])
  const [failing, setFailing] = useState(false)
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {(['signed-in', 'expired', 'nothing'] as const).map((each) => (
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
          everywhere={state === 'nothing' ? undefined : {
            kinds: everywhere,
            onAskFirst: async () => {
              await later()
              if (failing) {
                say('couldn’t')
                return true
              }
              setEverywhere([])
              say('they ask first everywhere')
              return true
            },
            problem: failing ? 'Couldn’t make them ask first: The server didn’t answer.' : undefined,
          }}
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
        // Paste a Google Doc's link: it connects, named in the words, or, with "missing" in it, says why not.
        onPasteLinks={(urls) => {
          for (const url of urls.filter((each) => each.includes('docs.google.com/document'))) {
            const key = `link:${url}`
            const service = { name: 'Google' }
            composer.current?.addConnection({ key, title: 'Google Doc', kind: 'Google Doc', service, pending: true })
            setTimeout(() => {
              if (url.includes('missing')) {
                composer.current?.addConnection({ key, title: 'Google Doc', kind: 'Google Doc', service, problem: 'Couldn’t connect it: Requested entity was not found.' })
                return
              }
              composer.current?.addConnection({ key, title: 'Q3 plan', kind: 'Google Doc', service })
              composer.current?.replaceInDraft(url, 'Q3 plan')
            }, 900)
          }
        }}
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
