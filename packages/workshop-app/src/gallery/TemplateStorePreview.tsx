import { useState } from 'react'
import { UseTemplateDialog, type UseTemplateNeed } from '@/blocks/UseTemplateDialog'
import { Button } from '@/components/Button'
import { useListView } from '@/hooks/useListView'
import { exampleTemplates } from '@/library/exampleTemplates'
import { outputTitle, ownApps } from '@/library/libraryList'
import { withStar } from '@/library/libraryStars'
import { mostUsed, templateList } from '@/library/templateList'
import { TemplatePageView } from '@/library/TemplatePageView'
import { templateType } from '@/library/templates'
import { DISCOVER_TAB, TemplateStoreView } from '@/library/TemplateStoreView'
import { previewOutputs } from './LibraryListPreview'
import { useReport } from './previewState'
import { Section } from './Section'

const MODELS = [{ id: 'sonnet', name: 'Claude Sonnet' }, { id: 'gpt', name: 'GPT-5' }]

/** What `UseTemplateDialog` is shown with: a connection to choose, one chosen, one not offered here, a model and an agent. */
const useNeeds = (say: (what: string) => void, modelsRead: boolean): UseTemplateNeed[] => {
  const [chosen, setChosen] = useState<Record<string, string | null>>({ MODEL: 'sonnet', TICKETS: 'acme.atlassian.net/browse/OPS' })
  const choose = (key: string, value: string | null) => setChosen((current) => ({ ...current, [key]: value }))
  return [
    { key: 'SHEET', title: 'Budget sheet', description: 'The sheet it reads the plan from', kind: 'connection', service: { name: 'Google' }, chosen: chosen.SHEET ?? undefined, onChoose: () => { say('chose the sheet in Google’s form'); choose('SHEET', 'docs.google.com/spreadsheets/d/1Bx') } },
    { key: 'TICKETS', title: 'Tickets', kind: 'connection', service: { name: 'Jira' }, chosen: chosen.TICKETS ?? undefined, onChoose: () => say('Jira’s form, to choose again') },
    { key: 'NOTES', title: 'Notes', description: 'Where it writes its summary', kind: 'connection', service: { name: 'Notion' }, unavailable: 'Not offered here', onChoose: () => {} },
    { key: 'MODEL', title: 'Model', description: 'Writes the summary', kind: 'model', models: modelsRead ? MODELS : undefined, chosen: chosen.MODEL, onChoose: (id) => choose('MODEL', id) },
    { key: 'AGENT', title: 'Helper', kind: 'agent', models: modelsRead ? MODELS : undefined, chosen: chosen.AGENT, onChoose: (id) => choose('AGENT', id) },
  ]
}

/** `UseTemplateDialog` in its states: what it needs, met and not, its models still being read, and making it, which fails the first time. */
const UseTemplatePreview = () => {
  const { report, say } = useReport()
  const [open, setOpen] = useState<'needs' | 'reading' | 'nothing'>()
  const [tries, setTries] = useState(0)
  const needs = useNeeds(say, open !== 'reading')
  return (
    <Section title="UseTemplateDialog (states): what a template needs, each met in place or in its service’s form, with a tick once it is, one not offered here, a model and an agent, which can run on none; the models still being read; one that needs nothing; and making it, held while it is made and open under why where it could not be (the first time)">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen('needs')}>What it needs</Button>
        <Button onClick={() => setOpen('reading')}>Models being read</Button>
        <Button onClick={() => setOpen('nothing')}>Needs nothing</Button>
      </div>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      <UseTemplateDialog
        open={open !== undefined}
        onOpenChange={(next) => { if (!next) setOpen(undefined) }}
        title="Budget tracker"
        publisher="Katherine Johnson"
        needs={open === 'nothing' ? [] : needs}
        onUse={async () => {
          await new Promise((resolve) => setTimeout(resolve, 800))
          setTries(tries + 1)
          if (tries === 0) throw new Error('The sheet can’t be reached with this account.')
          say('made it in a new workspace')
          return true
        }}
      />
    </Section>
  )
}

/** The templates' page and one template's own, over the example templates: opening one goes from the first to the second. */
export const TemplateStorePreview = () => (
  <>
    <TemplateStorePages />
    <UseTemplatePreview />
  </>
)

const TemplateStorePages = () => {
  const { report, say } = useReport()
  const [templates] = useState(exampleTemplates)
  const [apps] = useState(() => ownApps(previewOutputs(Date.now())))
  const [tab, setTab] = useState(DISCOVER_TAB)
  const [stars, setStars] = useState(['budget-tracker'])
  const [openId, setOpenId] = useState<string>()
  // The templates as they are once read, or while they are, or where they could not be.
  const [read, setRead] = useState<'ready' | 'loading' | 'failed'>('ready')
  // As if Jira were the one service the user has connected.
  const [connected, setConnected] = useState<string[]>(['JIRA'])
  const list = useListView('gallery-templates', templateList(templates, new Set(stars)))
  const open = templates.find(({ id }) => id === openId)

  return (
    <Section title="TemplateStoreView, TemplatePageView, TemplateCard, TemplateListing, ConnectionNeeds, FactStrip, ScrollRow, Shelf (the templates, as a store lists what it has. Discover is its front: the most used on one line that is scrolled along, the latest published two to a line, then some of each kind, each with the way to the rest. All lists every one in the order chosen, and a tab each those of a kind; a search or a filter lists what it leaves in place of the front. The templates while they are read, and where they could not be. A template’s own page has what it makes on a tile beside its title and the way to use it, what there is to know of it at a glance, a picture of what it makes, sketched until its publisher gives one, what it is for, the services it has to be connected to, each with whether it is and the way to connect it, the facts at length, and others of its kind)">
      <div className="flex w-full flex-col gap-3">
        {/* Wider than the gallery's column, as a page is. */}
        <div data-preview="templates" className="relative left-1/2 flex h-[64rem] w-[min(60rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
          {openId === undefined
            ? (
                <TemplateStoreView
                  tab={tab}
                  onTabChange={setTab}
                  templates={read === 'ready' ? templates : []}
                  status={read === 'loading' ? { loading: true } : read === 'failed' ? { failed: 'The connection was lost.', onRetry: () => setRead('ready') } : undefined}
                  list={list}
                  stars={stars}
                  onStarsChange={setStars}
                  onOpenTemplate={({ id }) => setOpenId(id)}
                  templateHref={({ id }) => `#${id}`}
                  onBack={() => say('back to the library')}
                  apps={apps}
                  onPublish={(app) => say(`publish ${outputTitle(app)} as a template`)}
                />
              )
            : (
                <TemplatePageView
                  // Keyed, so that what was read of one is not carried to the next.
                  key={openId}
                  template={open}
                  starred={stars.includes(openId)}
                  onStarredChange={(on) => setStars(withStar(stars, openId, on))}
                  onUse={() => say(`use ${open?.metadata.title}`)}
                  connected={new Set(connected)}
                  onConnect={({ key }) => setConnected([...connected, key])}
                  related={open ? mostUsed(templates).filter((other) => other.id !== open.id && templateType(other).id === templateType(open).id).slice(0, 4) : []}
                  onOpenTemplate={({ id }) => setOpenId(id)}
                  templateHref={({ id }) => `#${id}`}
                  onBack={() => setOpenId(undefined)}
                />
              )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['ready', 'loading', 'failed'] as const).map((each) => (
            <Button key={each} aria-pressed={read === each} onClick={() => { setOpenId(undefined); setRead(each) }}>
              {each === 'ready' ? 'Read' : each === 'loading' ? 'Being read' : 'Couldn’t be read'}
            </Button>
          ))}
        </div>
        <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      </div>
    </Section>
  )
}
