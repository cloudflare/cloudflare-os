import { useState } from 'react'
import { BindingRow } from '@/blocks/BindingRow'
import { ListGroup } from '@/blocks/ListGroup'
import { Button } from '@/components/Button'
import type { GadgetBinding, Listed } from '@/gadgets/GadgetSettings'
import { GadgetSettingsView, type GadgetSettingsState, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'
import { useReport } from './previewState'
import { Section } from './Section'

const SERVICES = new Map([
  ['github', { name: 'GitHub', logoUrl: '/favicon.svg' }],
  ['google', { name: 'Google', color: '#ffffff' }],
])

const BINDINGS: GadgetBinding[] = [
  { name: 'GITHUB', target: 3, resourceTitle: 'cloudflare/gadgets', vendorId: 'github', kind: 'service' },
  { name: 'CALENDAR', target: 4, resourceTitle: 'Team calendar', vendorId: 'google', kind: 'service', chatId: 12 },
  { name: 'SUMMARY_MODEL', target: 5, resourceTitle: 'Claude Haiku', kind: 'model', model: 'Claude Haiku' },
  { name: 'TRIAGE', target: 6, resourceTitle: 'Triage', kind: 'agent', model: 'Claude Sonnet' },
]

const STATES = {
  ready: 'Ready',
  loading: 'Loading',
  noBindings: 'Nothing connected',
  bindingsFailed: 'Connections failed',
  shared: 'Shared to use',
  gone: 'Deleted',
  denied: 'No access',
  failed: 'Failed',
} as const

/** A gadget's settings page and its blocks: what it is bound to. */
export const GadgetSettingsPreview = () => {
  const { report, say, later } = useReport()
  const [tab, setTab] = useState<GadgetSettingsTab>('connections')
  const [title, setTitle] = useState('Tip jar')
  const [bindings, setBindings] = useState(BINDINGS)
  const [shownState, setShownState] = useState<keyof typeof STATES>('ready')

  const state: GadgetSettingsState = shownState === 'failed' ? { status: 'failed', message: 'The workspace didn’t answer.', onRetry: () => say('try again') }
    : shownState === 'noBindings' || shownState === 'bindingsFailed' ? { status: 'ready' }
      : { status: shownState }
  const listed: Listed<GadgetBinding> = shownState === 'bindingsFailed' ? { status: 'failed', message: 'The workspace didn’t answer.' }
    : shownState === 'noBindings' ? { status: 'ready', items: [] }
      : { status: 'ready', items: bindings }

  return (
    <>
      <Section title="BindingRow (a service’s resource with its logo; one only in the chat that proposed it; a model its code calls; an agent it starts, with the model it thinks with; one with no logo, the service’s first letter; pointed at, the way to take it away, which asks first; its name renamed in place, the first refusing what is typed with why)">
        <div className="w-full max-w-3xl">
          <ListGroup label="Connected to">
            <ul className="flex flex-col">
              <BindingRow title="cloudflare/gadgets" name="GITHUB" service={{ name: 'GitHub', logoUrl: '/favicon.svg' }} onRemove={() => say('GITHUB removed')} onRename={async () => ({ saved: false, problem: 'It already has env.CALENDAR. Choose another name.' })} />
              <BindingRow title="Team calendar" name="CALENDAR" service={{ name: 'Google', color: '#ffffff' }} pending onRemove={() => say('CALENDAR removed')} />
              <BindingRow title="Claude Haiku" name="SUMMARY_MODEL" kind="model" model="Claude Haiku" onRemove={() => say('SUMMARY_MODEL removed')} />
              <BindingRow title="Triage" name="TRIAGE" kind="agent" model="Claude Sonnet" onRemove={() => say('TRIAGE removed')} />
              <BindingRow title="Inbox" name="INBOX" kind="agent" />
              <BindingRow title="Web Search" name="SEARCH" service={{ name: 'Web Search' }} />
            </ul>
          </ListGroup>
        </div>
      </Section>
      <Section title="GadgetSettingsView (a gadget’s settings page: its title renamed in place and what its template says it is for; a tab for what it is connected to, with its agents apart, and one for where it is from and deleting it, which asks first; while it loads, with nothing connected or its connections not read; and in place of all that, for someone it was shared with to use, once it is deleted, for someone with no access, and when it could not be loaded)">
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(STATES).map(([key, label]) => (
              <Button key={key} variant={key === shownState ? 'primary' : 'secondary'} onClick={() => setShownState(key as keyof typeof STATES)}>{label}</Button>
            ))}
          </div>
          {/* Wider than the gallery's column, as a page is. */}
          <div data-preview="gadget-settings" className="relative left-1/2 flex h-[56rem] w-[min(60rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
            <GadgetSettingsView
              state={state}
              title={title}
              icon="appWindow"
              description="Counts tips for the team lunch, and shows everyone the total."
              template="Tip jar"
              workspace={{ id: 'ws-1', title: 'Team lunch', label: 'TL' }}
              tab={tab}
              onTabChange={setTab}
              onRename={(next) => {
                setTitle(next)
                say(`renamed to ${next}`)
              }}
              bindings={listed}
              services={SERVICES}
              onRenameBinding={async (name, next) => {
                await later()
                if (bindings.some((binding) => binding.name === next)) return { saved: false, problem: `It already has env.${next}. Choose another name.` }
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next)) return { saved: false, problem: 'Binding names must be JavaScript identifiers (letters, digits, and \'_\', not starting with a digit).' }
                setBindings((current) => current.map((binding) => (binding.name === name ? { ...binding, name: next } : binding)))
                say(`env.${name} renamed to env.${next}`)
                return { saved: true }
              }}
              onUnbind={(name) => {
                void later().then(() => {
                  setBindings((current) => current.filter((binding) => binding.name !== name))
                  say(`env.${name} removed`)
                })
              }}
              onDelete={() => say('deleted the gadget')}
              onBack={() => say('back to the gadget')}
              onOpenWorkspace={() => say('open the workspace')}
            />
          </div>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
    </>
  )
}
