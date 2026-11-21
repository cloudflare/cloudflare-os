import { useRef, useState } from 'react'
import { AddConnectionDialog, type ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { SetUpAgentDialog } from '@/blocks/SetUpAgentDialog'
import { SetUpConnectionDialog, type SetUpConnectionAccount } from '@/blocks/SetUpConnectionDialog'
import { Button, Dialog } from '@gadgets/ui'
import { Section } from './Section'

const GITHUB = { name: 'GitHub', logoUrl: 'https://github.githubassets.com/favicons/favicon.svg' }
const REASON = 'I need read access to the docs repository to find where the onboarding guide lives.'
const MODELS = [{ id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet' }]

// Each way the dialog can be met: no account yet, an account whose sign-in ran out, one that has
// not given access to repositories, and one that can choose which straight away.
type Case = 'none' | 'expired' | 'grant' | 'ready' | 'create'
const ACCOUNTS: Record<Case, SetUpConnectionAccount[]> = {
  none: [],
  expired: [{ id: 1, name: 'octocat', expired: true }],
  grant: [{ id: 1, name: 'octocat' }],
  ready: [{ id: 1, name: 'octocat' }, { id: 2, name: 'octocat-work' }],
  create: [{ id: 1, name: 'ada@example.com' }],
}

// Stands in for the service's own form, which a gatekeeper draws in a frame of its own.
const FakeForm = ({ onReady }: { onReady: (ready: boolean) => void }) => (
  <label className="flex flex-col gap-1.5 rounded-(--surface-radius) bg-kumo-tint p-4 text-base/5">
    <span className="text-sm text-kumo-subtle">The service’s own form, in a frame</span>
    <select className="rounded-lg bg-kumo-base px-2 py-1.5 ring-1 ring-kumo-line" defaultValue="" onChange={(event) => onReady(event.target.value !== '')}>
      <option value="" disabled>Choose a repository</option>
      <option value="docs">acme/docs</option>
      <option value="site">acme/site</option>
    </select>
  </label>
)

const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 700))

/** Setting up what an agent asked to be connected to, or to have created, and an agent it asked for. */
export const SetUpConnectionPreview = () => {
  const [open, setOpen] = useState<Case>()
  const [agentOpen, setAgentOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState(1)
  const [said, setSaid] = useState('Choose one to open it.')
  const shown = open ?? 'ready'

  return (
    <Section title="SetUpConnectionDialog, SetUpAgentDialog (what an agent asked to be connected to, set up from its card’s Set up: with no account yet, the way on to the service to connect one; with an account whose sign-in ran out, Sign in again; with one that has not given access to this kind of resource, Give access; and once it can, the service’s own form for which one, in a frame, filled in with what the agent knew, Connect waiting for a choice. Each step that opens a window of the service’s waits for it, saying so, and can open it again. Titled and labelled so, it creates what the agent asked for instead. An agent the chat asked for is named and given a model)">
      <Button onClick={() => setOpen('none')}>No account yet</Button>
      <Button onClick={() => setOpen('expired')}>Sign-in expired</Button>
      <Button onClick={() => setOpen('grant')}>Needs access</Button>
      <Button onClick={() => { setReady(false); setOpen('ready') }}>Choose which</Button>
      <Button onClick={() => setOpen('create')}>Create a document</Button>
      <Button onClick={() => setAgentOpen(true)}>Set up an agent</Button>
      <p role="status" className="w-full text-sm text-kumo-subtle">{said}</p>
      <SetUpConnectionDialog
        open={open !== undefined}
        onOpenChange={(next) => { if (!next) setOpen(undefined) }}
        {...(shown === 'create' ? { name: 'Google Docs', title: 'Create Document: Weekly notes', accept: { label: 'Create', pending: 'Creating…' } } : GITHUB)}
        resource={shown === 'create' ? undefined : 'GitHub repository'}
        reason={REASON}
        accounts={ACCOUNTS[shown]}
        selectedAccountId={ACCOUNTS[shown].some(({ id }) => id === selected) ? selected : ACCOUNTS[shown][0]?.id}
        onSelectAccount={setSelected}
        onConnectAccount={() => later(true).then((went) => { setSaid('Would open GitHub to connect an account.'); return went })}
        onReconnect={() => later(true).then((went) => { setSaid('Would open GitHub to sign in again.'); return went })}
        onGrant={shown === 'grant' ? () => later(true).then((went) => { setSaid('Would open GitHub to give access to repositories.'); return went }) : undefined}
        configurator={shown === 'create' ? undefined : <FakeForm onReady={setReady} />}
        ready={shown === 'create' || ready}
        onAccept={() => later(true).then((went) => { setSaid(shown === 'create' ? 'Created it, and approved the agent’s changes.' : 'Connected it, and handed it to the agent.'); setOpen(undefined); return went })}
      />
      <SetUpAgentDialog
        open={agentOpen}
        onOpenChange={setAgentOpen}
        reason="I need an agent that writes a short joke each time the gadget’s button is pressed."
        models={MODELS}
        initialModel="sonnet"
        onSetUp={(setup) => later(undefined).then(() => setSaid(`Set up ${setup.name}, thinking with ${setup.modelId}.`))}
      />
    </Section>
  )
}

const CHOICES: ConnectionChoice[] = [
  { key: 'repo', service: { name: 'GitHub', logoUrl: GITHUB.logoUrl }, title: 'Repository', description: 'Code, issues and pull requests', connected: true },
  { key: 'sheet', service: { name: 'Google' }, title: 'Spreadsheet', description: 'A Google Sheets file', connected: true },
  { key: 'doc', service: { name: 'Google' }, title: 'Document', description: 'A Google Docs file', connected: true },
  { key: 'page', service: { name: 'Notion' }, title: 'Page', description: 'A page and what is under it', connected: false },
  { key: 'team', service: { name: 'Linear' }, title: 'Team', description: 'A team’s issues and cycles', connected: false },
]

/** Adding a connection to a draft from the + menu, and one made from a link pasted into it. */
export const AddConnectionPreview = () => {
  const composer = useRef<ComposerHandle>(null)
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<ConnectionChoice>()
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [said, setSaid] = useState('Open + and choose Add a new connection, or paste or type a Google Doc’s, GitHub’s or Notion’s link.')
  // The links found in the draft, each as far as it has come: a Google Doc's connects by itself,
  // a GitHub one waits for the service to be connected, and a Notion one for an account to be chosen.
  const [links, setLinks] = useState<{ url: string; step: 'asked' | 'connecting' | 'made' | 'failed' }[]>([])
  const step = (url: string, next: 'connecting' | 'made' | 'failed') => setLinks((current) => current.map((link) => (link.url === url ? { ...link, step: next } : link)))
  const make = (url: string) => {
    step(url, 'connecting')
    setTimeout(() => {
      step(url, url.includes('missing') ? 'failed' : 'made')
      if (!url.includes('missing')) composer.current?.replaceInDraft(url, 'Q3 plan')
    }, 900)
  }
  const found = (urls: string[]) => {
    const known = urls.filter((url) => /docs\.google\.com\/document|github\.com|notion\.so/.test(url) && !links.some((link) => link.url === url))
    setLinks((current) => [...current, ...known.map((url) => ({ url, step: 'asked' as const }))])
    for (const url of known) if (url.includes('docs.google.com')) make(url)
  }
  const lines = links.map(({ url, step: at }): ComposerConnection => {
    const github = url.includes('github.com')
    const line = { key: `link:${url}`, title: github ? 'Repository' : url.includes('notion.so') ? 'Page' : 'Google Doc', kind: github ? 'Repository' : url.includes('notion.so') ? 'Page' : 'Google Doc', service: { name: github ? 'GitHub' : url.includes('notion.so') ? 'Notion' : 'Google', logoUrl: github ? GITHUB.logoUrl : undefined } }
    if (at === 'made') return { ...line, title: github ? 'cloudflare/gadgets' : 'Q3 plan' }
    if (at === 'connecting') return { ...line, pending: true }
    if (at === 'failed') return { ...line, problem: 'Couldn’t connect it: Requested entity was not found.', ask: { label: 'Choose…', onAct: () => close(true) } }
    if (github) return { ...line, note: 'Connect GitHub to add it', ask: { label: 'Connect', onAct: () => make(url) } }
    return { ...line, note: 'Which account?', ask: { label: 'Choose account', choices: [{ id: '1', label: 'ada@example.com' }, { id: '2', label: 'ada@work.example' }], onChoose: () => make(url) } }
  })
  // Each opening starts at the choice; closing leaves the page shown as it is, to close.
  const close = (next: boolean) => {
    setChoosing(next)
    if (next) setChosen(undefined)
  }

  return (
    <Section title="AddConnectionDialog, then SetUpConnectionDialog with Back, and ComposerConnectionLines (the + menu’s Add a new connection: what kind, found by typing, your services first; then which, in the service’s form, or Back to the list, the one dialog going from page to page, its surface taking each one’s size; then it sits above the draft, to go with the message, and is refused beside a skill; a link pasted, or typed and ended with a space, is a line of its own: a Google Doc’s connects by itself, connecting, then named in the words, or says why not, with “missing” in it, offering the form; GitHub’s waits for Connect; Notion’s for which account; taking a line off puts nothing in the words here; past three, those made fold into one)">
      <Button onClick={() => { setLoading(false); close(true) }}>Add a connection</Button>
      <Button onClick={() => { setLoading(true); close(true) }}>While services are read</Button>
      <div className="w-full">
        <Composer
          ref={composer}
          onSend={(text, _files, command, connections) => {
            setSaid(`Sent “${text}”${connections?.length ? ` with ${connections.map(({ title }) => title).join(' and ')}` : ''}${command ? ` using ${command.title}` : ''}.`)
            return true
          }}
          addActions={{ onAddConnection: () => close(true) }}
          links={{ lines, onFound: found, onRemove: (key) => setLinks((current) => current.filter((link) => `link:${link.url}` !== key)), onSent: () => setLinks([]) }}
          commands={[{ key: 'brief', name: 'meeting-brief', title: 'Meeting Brief', description: 'Before a meeting, gather who is coming.', kind: 'skill' }]}
        />
      </div>
      <p role="status" className="w-full text-sm text-kumo-subtle">{said}</p>
      <Dialog open={choosing} onOpenChange={close} wide={chosen !== undefined} page={chosen ? { key: chosen.key, depth: 1 } : { key: '', depth: 0 }}>
        {!chosen ? (
          <AddConnectionDialog open={choosing} onOpenChange={close} to="this chat" choices={loading ? undefined : CHOICES} onChoose={setChosen} />
        ) : (
          <SetUpConnectionDialog
            open={choosing}
            onOpenChange={close}
            name={chosen.service.name}
            logoUrl={chosen.service.logoUrl}
            resource={chosen.title}
            onBack={() => setChosen(undefined)}
            accounts={chosen.connected ? [{ id: 1, name: chosen.service.name === 'GitHub' ? 'octocat' : 'ada@example.com' }] : []}
            selectedAccountId={1}
            onSelectAccount={() => {}}
            onConnectAccount={() => later(true)}
            onReconnect={() => later(true)}
            configurator={<FakeForm onReady={setReady} />}
            ready={ready}
            onAccept={async () => {
              await later(true)
              composer.current?.addConnection({ key: `${chosen.key}-${Date.now()}`, title: chosen.key === 'repo' ? 'cloudflare/gadgets' : 'Q3 forecast', kind: chosen.title, service: chosen.service })
              close(false)
              return true
            }}
          />
        )}
      </Dialog>
    </Section>
  )
}
