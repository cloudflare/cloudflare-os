import { useState } from 'react'
import { SetUpAgentDialog } from '@/blocks/SetUpAgentDialog'
import { SetUpConnectionDialog, type SetUpConnectionAccount } from '@/blocks/SetUpConnectionDialog'
import { Button } from '@/components/Button'
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
