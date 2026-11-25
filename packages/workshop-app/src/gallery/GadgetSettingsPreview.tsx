import { useState } from 'react'
import { BindingRow } from '@/blocks/BindingRow'
import { Button, ListGroup } from '@gadgets/ui'
import { ModelBindingDialog, type ModelChoice } from '@/blocks/ModelBindingDialog'
import { UpdateFromTemplateDialog, type UpdateFromTemplateOutcome, type UpdateTemplate } from '@/blocks/UpdateFromTemplateDialog'
import { bindingNameProblem, freeBindingName, MODEL_BINDING_NAMES, type GadgetBinding, type Listed } from '@/gadgets/GadgetSettings'
import { DEFAULT_GADGET_SETTINGS_TAB, GadgetSettingsView, type GadgetSettingsState, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'
import type { MadeTemplate } from '@/blocks/CreateTemplateDialog'
import { useReport } from './previewState'
import { Section } from './Section'

const SERVICES = new Map([
  ['github', { name: 'GitHub', logoUrl: '/favicon.svg' }],
  ['google', { name: 'Google', color: '#ffffff' }],
])

const BINDINGS: GadgetBinding[] = [
  { name: 'GITHUB', target: 3, resourceTitle: 'cloudflare/gadgets', vendorId: 'github', kind: 'service' },
  { name: 'CALENDAR', target: 4, resourceTitle: 'Team calendar', vendorId: 'google', kind: 'service', chatId: 12 },
  { name: 'SUMMARY_MODEL', target: 5, resourceTitle: 'Claude Haiku', kind: 'model', model: 'claude-haiku-4-5', modelId: 'haiku' },
  { name: 'TRIAGE', target: 6, resourceTitle: 'Triage', kind: 'agent', model: 'Claude Sonnet' },
]

const TEMPLATE: UpdateTemplate = { title: 'Tip jar', description: 'Counts tips for the team lunch, and shows everyone the total.', version: 4, status: 'available' }
const MODELS = [{ id: 'sonnet', name: 'Claude Sonnet' }, { id: 'haiku', name: 'Claude Haiku' }]
const MODEL_CHOICES: ModelChoice[] = [...MODELS.map((model) => ({ ...model, kind: 'language' as const })), { id: 'triage', name: 'Triage classifier', kind: 'decision' }]

// The ways the model dialog is opened, and what giving the model ends in.
const MODEL_DIALOGS: Record<string, { label: string; models?: ModelChoice[]; changing?: string; initial?: string; fails?: boolean }> = {
  add: { label: 'Add', models: MODEL_CHOICES, initial: 'sonnet' },
  change: { label: 'Change', models: MODEL_CHOICES, changing: 'SUMMARY_MODEL', initial: 'haiku' },
  fails: { label: 'Refused', models: MODEL_CHOICES, initial: 'sonnet', fails: true },
  none: { label: 'No models', models: [] },
  loading: { label: 'Loading' },
}

/** Giving a gadget's code a model, and changing one's model, opened in each of the ways it can go. */
const ModelDialogPreview = () => {
  const { report, say, later } = useReport()
  const [shown, setShown] = useState<string>()
  const [open, setOpen] = useState(false)
  const dialog = shown ? MODEL_DIALOGS[shown] : undefined
  const taken = ['GITHUB', 'LLM']
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(MODEL_DIALOGS).map(([key, { label }]) => <Button key={key} onClick={() => { setShown(key); setOpen(true) }}>{label}</Button>)}
      </div>
      <ModelBindingDialog
        open={open}
        onOpenChange={setOpen}
        gadget="“Tip jar”"
        models={dialog?.models}
        initialModel={dialog?.initial}
        changing={dialog?.changing}
        suggestName={(kind) => freeBindingName(MODEL_BINDING_NAMES[kind], taken)}
        nameProblem={(name) => bindingNameProblem(name, taken)}
        onSubmit={async ({ modelId, name }) => {
          await later()
          if (dialog?.fails) throw new Error('This model can’t be used right now.')
          say(dialog?.changing ? `env.${dialog.changing} now uses ${modelId}` : `added ${modelId} as env.${name}`)
        }}
      />
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </div>
  )
}

// What asking for the update ends in, in each of the dialog's previews.
const UPDATES: Record<string, { label: string; template?: UpdateTemplate | null; models?: typeof MODELS; outcome: (allowUnrelated: boolean) => UpdateFromTemplateOutcome }> = {
  proposed: { label: 'Update available', template: TEMPLATE, models: MODELS, outcome: () => ({ outcome: 'proposed' }) },
  upToDate: { label: 'Up to date', template: { ...TEMPLATE, status: 'upToDate' }, models: MODELS, outcome: () => ({ outcome: 'upToDate' }) },
  unrelated: { label: 'Unrelated', template: { ...TEMPLATE, status: undefined }, models: MODELS, outcome: (allowUnrelated) => ({ outcome: allowUnrelated ? 'proposed' : 'unrelated' }) },
  baseUnavailable: { label: 'Can’t be merged', template: TEMPLATE, models: MODELS, outcome: () => ({ outcome: 'baseUnavailable' }) },
  failed: { label: 'Failed', template: TEMPLATE, models: MODELS, outcome: () => ({ outcome: 'failed', message: 'The gadget changed while the update was being prepared. Try again.' }) },
  gone: { label: 'Template gone', template: null, models: MODELS, outcome: () => ({ outcome: 'proposed' }) },
  loading: { label: 'Loading', outcome: () => ({ outcome: 'proposed' }) },
}

/** The dialog that proposes a gadget's update from its template, opened in each of the ways it can go. */
const UpdatePreview = () => {
  const { report, say, later } = useReport()
  const [shown, setShown] = useState<string>()
  const [reviewer, setReviewer] = useState<string | null>('sonnet')
  const update = shown ? UPDATES[shown] : undefined
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(UPDATES).map(([key, { label }]) => <Button key={key} onClick={() => setShown(key)}>{label}</Button>)}
      </div>
      <UpdateFromTemplateDialog
        open={update !== undefined}
        onOpenChange={(open) => {
          if (!open) setShown(undefined)
        }}
        gadget="Team lunch tips"
        template={update?.template}
        models={update?.models}
        reviewer={reviewer}
        onReviewerChange={(id) => {
          setReviewer(id)
          say(`reviewed by ${id ?? 'no agent'}`)
        }}
        onUpdate={async (allowUnrelated) => {
          await later()
          const result = update!.outcome(allowUnrelated)
          if (result.outcome === 'proposed') {
            setShown(undefined)
            say('proposed in a new chat')
          }
          return result
        }}
      />
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </div>
  )
}

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

const TEMPLATES: Record<string, { label: string; made: MadeTemplate[] | undefined }> = {
  none: { label: 'No template yet', made: [] },
  changes: { label: 'Template with changes', made: [{ id: 'tpl-tip', title: 'Tip jar', description: 'Counts tips for the team lunch.', version: 3, changes: { code: true } }] },
  connections: { label: 'Template with connection changes', made: [{ id: 'tpl-tip', title: 'Tip jar', description: 'Counts tips for the team lunch.', version: 3, changes: { bindings: true } }] },
  current: { label: 'Template up to date', made: [{ id: 'tpl-tip', title: 'Tip jar', description: 'Counts tips for the team lunch.', version: 3 }] },
  several: { label: 'Several templates', made: [{ id: 'tpl-tip', title: 'Tip jar', description: 'Counts tips for the team lunch.', version: 3, changes: { code: true } }, { id: 'tpl-lunch', title: 'Team lunch tracker', description: '', version: 1, changes: { bindings: true } }] },
  unread: { label: 'Templates not read', made: undefined },
}

/** A gadget's settings page and its blocks: what it is bound to. */
export const GadgetSettingsPreview = () => {
  const { report, say, later } = useReport()
  const [tab, setTab] = useState<GadgetSettingsTab>(DEFAULT_GADGET_SETTINGS_TAB)
  const [title, setTitle] = useState('Tip jar')
  const [bindings, setBindings] = useState(BINDINGS)
  const [shownState, setShownState] = useState<keyof typeof STATES>('ready')
  const [shownTemplates, setShownTemplates] = useState<keyof typeof TEMPLATES>('none')
  const [devMode, setDevMode] = useState(false)

  const state: GadgetSettingsState = shownState === 'failed' ? { status: 'failed', message: 'The workspace didn’t answer.', onRetry: () => say('try again') }
    : shownState === 'noBindings' || shownState === 'bindingsFailed' ? { status: 'ready' }
      : { status: shownState }
  const listed: Listed<GadgetBinding> = shownState === 'bindingsFailed' ? { status: 'failed', message: 'The workspace didn’t answer.' }
    : shownState === 'noBindings' ? { status: 'ready', items: [] }
      : { status: 'ready', items: bindings }

  return (
    <>
      <Section title="BindingRow (a service’s resource with its logo; one only in the chat that proposed it; a model its code calls, whose model can be changed; an agent it starts, with the model it thinks with; one with no logo, the service’s first letter; pointed at, the way to take it away, which asks first, in the user’s words; and in developer mode, the name its code knows each by, renamed in place, the first refusing what is typed with why)">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <ListGroup label="Connected to">
            <ul className="flex flex-col">
              <BindingRow title="cloudflare/gadgets" name="GITHUB" gadget="Tip jar" service={{ name: 'GitHub', logoUrl: '/favicon.svg' }} onRemove={() => say('GITHUB removed')} />
              <BindingRow title="Team calendar" name="CALENDAR" gadget="Tip jar" service={{ name: 'Google', color: '#ffffff' }} pending onRemove={() => say('CALENDAR removed')} />
              <BindingRow title="Claude Haiku" name="SUMMARY_MODEL" gadget="Tip jar" kind="model" onRemove={() => say('SUMMARY_MODEL removed')} onChangeModel={() => say('change the model of SUMMARY_MODEL')} />
              <BindingRow title="Triage" name="TRIAGE" gadget="Tip jar" kind="agent" model="Claude Sonnet" onRemove={() => say('TRIAGE removed')} />
              <BindingRow title="Inbox" name="INBOX" kind="agent" />
              <BindingRow title="Web Search" name="SEARCH" service={{ name: 'Web Search' }} />
            </ul>
          </ListGroup>
          <ListGroup label="Connected to, in developer mode">
            <ul className="flex flex-col">
              <BindingRow showsCodeName title="cloudflare/gadgets" name="GITHUB" gadget="Tip jar" service={{ name: 'GitHub', logoUrl: '/favicon.svg' }} onRemove={() => say('GITHUB removed')} onRename={async () => ({ saved: false, problem: 'It already has env.CALENDAR. Choose another name.' })} />
              <BindingRow showsCodeName title="Team calendar" name="CALENDAR" gadget="Tip jar" service={{ name: 'Google', color: '#ffffff' }} pending onRemove={() => say('CALENDAR removed')} />
              <BindingRow showsCodeName title="Claude Haiku" name="SUMMARY_MODEL" gadget="Tip jar" kind="model" onRemove={() => say('SUMMARY_MODEL removed')} onRename={async () => ({ saved: true })} onChangeModel={() => say('change the model of SUMMARY_MODEL')} />
              <BindingRow showsCodeName title="Triage" name="TRIAGE" gadget="Tip jar" kind="agent" model="Claude Sonnet" onRemove={() => say('TRIAGE removed')} onRename={async () => ({ saved: true })} />
            </ul>
          </ListGroup>
        </div>
      </Section>
      <Section title="ModelBindingDialog (giving a gadget’s code one of the user’s models, starting on their default, under a name it has nothing by, with how its code calls it; changing a model binding’s model; refused, with why; with no models; and while they are read)">
        <ModelDialogPreview />
      </Section>
      <Section title="UpdateFromTemplateDialog (proposing a gadget’s update from its template in a new chat: with a newer version, already up to date, unrelated and warned of first, one that can’t be merged, one that couldn’t be asked with the way to try again, its template gone, and while it is read)">
        <UpdatePreview />
      </Section>
      <Section title="GadgetSettingsView (a gadget’s settings page: its title renamed in place and what its template says it is for; a tab for updating it from its template, creating a template from it, exporting it, a group for each template it has made, which releases its changes as its next version or deletes it, which asks first, and deleting it, which asks first, one for what it is connected to, where a model is added and changed, and one for the agents its code can start; while it loads, with nothing connected or its connections not read; and in place of all that, for someone it was shared with to use, once it is deleted, for someone with no access, and when it could not be loaded)">
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(STATES).map(([key, label]) => (
              <Button key={key} variant={key === shownState ? 'primary' : 'secondary'} onClick={() => setShownState(key as keyof typeof STATES)}>{label}</Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(TEMPLATES).map(([key, { label }]) => (
              <Button key={key} variant={key === shownTemplates ? 'primary' : 'secondary'} onClick={() => setShownTemplates(key)}>{label}</Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant={devMode ? 'primary' : 'secondary'} onClick={() => setDevMode((on) => !on)}>Developer mode</Button>
          </div>
          {/* Wider than the gallery's column, as a page is. */}
          <div data-preview="gadget-settings" className="relative left-1/2 flex h-[56rem] w-[min(60rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
            <GadgetSettingsView
              state={state}
              title={title}
              icon="appWindow"
              description="Counts tips for the team lunch, and shows everyone the total."
              templateUpdate={{ status: 'available', onUpdate: () => say('update from the template') }}
              template={{
                made: TEMPLATES[shownTemplates].made,
                onCreate: () => say('opened Create template'),
                onOpen: (id) => say(`opened the page of ${id}`),
                onEdit: async (id, fields) => {
                  await later()
                  say(`edited ${id}: ${fields.title}`)
                },
                onRelease: (id) => say(`released an update to ${id}`),
                onDelete: (id) => say(`deleted ${id}`),
              }}
              exports={{
                choices: { status: 'ready', formats: [{ id: 'md', label: 'Markdown' }, { id: 'csv', label: 'CSV' }], saves: [{ key: 'doc', title: 'Google Doc' }] },
                onOpen: () => {},
                onExport: (id) => say(`exported as ${id}`),
                onSave: (key) => say(`saved to ${key}`),
                onUpdate: (key) => say(`updated ${key}`),
              }}
              workspace={{ id: 'ws-1', title: 'Team lunch', label: 'TL' }}
              tab={tab}
              onTabChange={setTab}
              onRename={(next) => {
                setTitle(next)
                say(`renamed to ${next}`)
              }}
              bindings={listed}
              services={SERVICES}
              models={{ models: MODEL_CHOICES, initial: 'sonnet' }}
              onChangeModel={async (name, modelId) => {
                await later()
                setBindings((current) => current.map((binding) => (binding.name === name ? { ...binding, modelId } : binding)))
                say(`env.${name} now uses ${modelId}`)
              }}
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
              showsCodeNames={devMode}
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
