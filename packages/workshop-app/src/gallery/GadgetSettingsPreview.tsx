import { useState } from 'react'
import { BindingRow } from '@/blocks/BindingRow'
import { CodeBrowser, type CodeBrowserProps } from '@/blocks/CodeBrowser'
import { ListGroup } from '@/blocks/ListGroup'
import { Button } from '@/components/Button'
import type { GadgetBinding, Listed } from '@/gadgets/GadgetSettings'
import { GadgetSettingsView, type GadgetSettingsState, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'
import { useReport } from './previewState'
import { Section } from './Section'

const CLIENT = `// What the tip jar shows: the total, and a button for each amount.
import { connect } from './lib/protocol'

const AMOUNTS = [2, 5, 10]

export default function render(root) {
  const server = connect()
  const total = document.createElement('h1')
  root.append(total)
  for (const amount of AMOUNTS) {
    const button = document.createElement('button')
    button.textContent = \`Tip $\${amount}\`
    button.onclick = async () => update(await server.tip(amount))
    root.append(button)
  }
  const update = (cents) => { total.textContent = \`$\${(cents / 100).toFixed(2)}\` }
  server.total().then(update)
}
`

const SERVER = `import { DurableObject } from 'cloudflare:workers'

/** Keeps the jar's total, in cents. */
export class Gadget extends DurableObject {
  async total(): Promise<number> {
    return (await this.ctx.storage.get<number>('total')) ?? 0
  }

  async tip(dollars: number): Promise<number> {
    const total = (await this.total()) + dollars * 100
    await this.ctx.storage.put('total', total)
    return total
  }
}
`

const TEXTS: Record<string, string> = {
  'client.js': CLIENT,
  'server.ts': SERVER,
  'README.md': '# Tip jar\n\nCounts tips for the team lunch. **Tip** adds to the total, which everyone sees.\n',
  'lib/protocol.ts': 'export const connect = () => (globalThis as any).gadget\n',
  'lib/styles.css': 'button {\n  border-radius: 999px;\n  padding: 8px 14px;\n}\n',
}

const FILES = [
  { path: 'client.js', role: 'What it shows' },
  { path: 'server.ts', role: 'What it keeps and does' },
  { path: 'README.md', role: 'What it is' },
  { path: 'blueprint.png' },
  { path: 'lib/protocol.ts' },
  { path: 'lib/styles.css' },
]

/** The code of a fake gadget, a file at a time, as the Code tab is given it. */
const useFakeCode = (): Omit<CodeBrowserProps, 'empty' | 'className'> => {
  const [shown, setShown] = useState('client.js')
  const text = TEXTS[shown]
  return {
    files: { status: 'ready', files: FILES },
    shown,
    onShow: setShown,
    file: text === undefined ? { status: 'other', message: 'It isn’t text, so it isn’t shown here.' } : { status: 'text', text },
  }
}

const Fixed = (props: Omit<CodeBrowserProps, 'onShow'>) => <CodeBrowser {...props} onShow={() => {}} onRetry={() => {}} />

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

/** A gadget's settings page and its blocks: what it is bound to, and its code. */
export const GadgetSettingsPreview = () => {
  const { report, say, later } = useReport()
  const code = useFakeCode()
  const narrowCode = useFakeCode()
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
      <Section title="BindingRow (a service’s resource with its logo; one only in the chat that proposed it; a model its code calls; an agent it starts, with the model it thinks with; one with no logo, the service’s first letter; pointed at, the way to take it away, which asks first)">
        <div className="w-full max-w-3xl">
          <ListGroup label="Connected to">
            <ul className="flex flex-col">
              <BindingRow title="cloudflare/gadgets" name="GITHUB" service={{ name: 'GitHub', logoUrl: '/favicon.svg' }} onRemove={() => say('GITHUB removed')} />
              <BindingRow title="Team calendar" name="CALENDAR" service={{ name: 'Google', color: '#ffffff' }} pending onRemove={() => say('CALENDAR removed')} />
              <BindingRow title="Claude Haiku" name="SUMMARY_MODEL" kind="model" model="Claude Haiku" onRemove={() => say('SUMMARY_MODEL removed')} />
              <BindingRow title="Triage" name="TRIAGE" kind="agent" model="Claude Sonnet" onRemove={() => say('TRIAGE removed')} />
              <BindingRow title="Inbox" name="INBOX" kind="agent" />
              <BindingRow title="Web Search" name="SEARCH" service={{ name: 'Web Search' }} />
            </ul>
          </ListGroup>
        </div>
      </Section>
      <Section title="CodeBrowser (a gadget’s Code tab: its files beside the one shown, highlighted, with Copy; the arrow keys step through them; a picture says it isn’t shown. Where it is narrow, the files are a drawer its header opens)">
        <div className="w-full max-w-5xl"><CodeBrowser {...code} /></div>
        <div className="w-full max-w-[420px]"><CodeBrowser {...narrowCode} /></div>
      </Section>
      <Section title="CodeBrowser, while reading, and when a file or all of it could not be read, or there is no code yet">
        <div className="grid w-full max-w-5xl gap-4">
          <Fixed files={{ status: 'loading' }} file={{ status: 'loading' }} />
          <Fixed files={{ status: 'ready', files: FILES }} shown="server.ts" file={{ status: 'failed', message: 'The workspace didn’t answer.' }} />
          <Fixed files={{ status: 'failed', message: 'The workspace didn’t answer.' }} file={{ status: 'loading' }} />
          <Fixed files={{ status: 'ready', files: [] }} file={{ status: 'loading' }} empty="It has no code yet. Once a chat writes some and it’s kept, it shows here." />
        </div>
      </Section>
      <Section title="GadgetSettingsView (a gadget’s settings page: its title renamed in place and what its template says it is for; a tab for what it is connected to, with its agents apart, one for its code, and one for where it is from and deleting it, which asks first; while it loads, with nothing connected or its connections not read; and in place of all that, for someone it was shared with to use, once it is deleted, for someone with no access, and when it could not be loaded)">
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
              onUnbind={(name) => {
                void later().then(() => {
                  setBindings((current) => current.filter((binding) => binding.name !== name))
                  say(`env.${name} removed`)
                })
              }}
              code={code}
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
