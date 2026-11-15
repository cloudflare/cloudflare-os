import { useState } from 'react'
import { AppWindowIcon, ArrowUpRightIcon, BookmarkSimpleIcon, CubeIcon, FileTextIcon, LinkIcon, SparkleIcon } from '@phosphor-icons/react'
import { KindMark } from '@/components/KindMark'
import { BlueprintNeedRow } from '@/blocks/BlueprintNeedRow'
import { BlueprintSuggestions } from '@/blocks/BlueprintSuggestions'
import { BlueprintPicture, BlueprintTile } from '@/blocks/BlueprintTile'
import type { LibraryAction } from '@/blocks/LibraryRow'
import { UseBlueprintDialog } from '@/blocks/UseBlueprintDialog'
import { Button } from '@/components/Button'
import { PREVIEW_BUDGET, PREVIEW_STANDUP, PREVIEW_TIP_JAR } from './previewPictures'
import { useReport } from './previewState'
import { Section } from './Section'

const MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'opus', name: 'Claude Opus', description: 'For the hardest work' },
]

const PLACES = [
  { id: 'acme', title: 'Acme launch', label: 'AL' },
  { id: 'home', title: 'Home', label: 'H' },
]

/**
 * Blueprints: tiles in the Library's tab, with a picture, without one, and one saved; what Home
 * suggests under its composer; the rows of what one needs, as its page lists them; and Use, for
 * one that needs connections and models, and for one that needs nothing, which asks where it goes.
 */
export const BlueprintsPreview = () => {
  const { report, say, later } = useReport()
  const [using, setUsing] = useState<'needs' | 'nothing' | 'fails'>()
  const [sheet, setSheet] = useState<string>()
  const [model, setModel] = useState<string>('sonnet')
  const [agent, setAgent] = useState<string | null>(null)
  const [place, setPlace] = useState<string>()
  const actions = (title: string): LibraryAction[] => [
    { key: 'open', label: 'Open', icon: ArrowUpRightIcon, onSelect: () => say(`opened ${title}`) },
    { key: 'use', label: 'Use blueprint…', icon: SparkleIcon, onSelect: () => say(`asked to use ${title}`) },
    { key: 'link', label: 'Copy link', icon: LinkIcon, onSelect: () => say(`copied a link to ${title}`) },
    { key: 'save', label: 'Save to Library', icon: BookmarkSimpleIcon, onSelect: () => say(`saved ${title}`) },
  ]

  return (
    <>
      <Section title="BlueprintTile (the Library’s Blueprints tab: with a picture, saved, and one with none, drawn with its glyph)">
        <div className="grid w-full max-w-3xl grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
          <BlueprintTile title="Tip jar" detail="By Ada · Ready to use" picture={PREVIEW_TIP_JAR} icon={<AppWindowIcon />} actions={actions('Tip jar')} href="#" onSelect={() => say('opened Tip jar')} />
          <BlueprintTile title="Standup board" detail="By Lin · Needs 2 things" picture={PREVIEW_STANDUP} icon={<AppWindowIcon />} badge="Saved" actions={actions('Standup board')} onSelect={() => say('opened Standup board')} />
          <BlueprintTile title="Weekly brief" detail="By you · Ready to use" icon={<FileTextIcon />} label="Document" actions={actions('Weekly brief')} onSelect={() => say('opened Weekly brief')} />
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      </Section>
      <Section title="BlueprintSuggestions (under Home’s composer: two featured, and the way to the rest, fanning more)">
        <div className="w-full max-w-md">
          <BlueprintSuggestions
            blueprints={[
              { id: 'tip', title: 'Tip jar', picture: PREVIEW_TIP_JAR, icon: <AppWindowIcon /> },
              { id: 'budget', title: 'Household budget', picture: PREVIEW_BUDGET, icon: <AppWindowIcon /> },
            ]}
            more={[PREVIEW_STANDUP, PREVIEW_TIP_JAR, undefined]}
            onOpen={(id) => say(`opened ${id}`)}
            onBrowse={() => say('went to all blueprints')}
          />
        </div>
      </Section>
      <Section title="BlueprintPicture + BlueprintNeedRow (a blueprint’s page: its picture, and what it needs)">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <BlueprintPicture picture={PREVIEW_BUDGET} icon={<AppWindowIcon />} size="lg" className="rounded-[28px] ring-1 ring-kumo-contrast/6" />
          <div className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
            <BlueprintNeedRow title="Budget sheet" detail="Google · Spreadsheet" service={{ name: 'Google', logoUrl: '/favicon.svg', color: '#ffffff' }} />
            <BlueprintNeedRow title="Writer" detail="One of your AI models" icon={<CubeIcon />} />
            <BlueprintNeedRow title="Reminders" detail="One of your models, for an agent it starts" icon={<KindMark name="agent" />} met />
          </div>
        </div>
      </Section>
      <Section title="UseBlueprintDialog (connections chosen in the service’s form, models from a menu, a service not offered here holding it back; one needing nothing asks where it goes; one whose making fails says why)">
        <Button onClick={() => setUsing('needs')}>Use, with needs</Button>
        <Button onClick={() => setUsing('nothing')}>Use, needing nothing</Button>
        <Button onClick={() => setUsing('fails')}>Use, failing</Button>
      </Section>
      <UseBlueprintDialog
        open={using !== undefined}
        onOpenChange={(open) => { if (!open) setUsing(undefined) }}
        title={using === 'nothing' ? 'Tip jar' : 'Household budget'}
        needs={using === 'nothing' ? [] : [
          {
            key: 'SHEET',
            title: 'Budget sheet',
            description: 'The spreadsheet it reads and writes',
            service: { name: 'Google', logoUrl: '/favicon.svg', color: '#ffffff' },
            kind: 'connection',
            chosen: sheet,
            onChoose: () => setSheet('docs.google.com/spreadsheets/d/1a2b3c'),
          },
          // A service this deployment does not offer, which keeps it from being used.
          ...(using === 'needs' ? [{ key: 'MAIL', title: 'Mailbox', service: { name: 'Fastmail' }, kind: 'connection' as const, unavailable: 'Not offered here', onChoose: () => {} }] : []),
          { key: 'LLM', title: 'Writer', description: 'An AI model it uses', icon: <CubeIcon />, kind: 'model', models: MODELS, chosen: model, onChoose: (id) => setModel(id ?? 'sonnet') },
          { key: 'AGENT', title: 'Reminders', description: 'The model an agent it starts runs on', icon: <KindMark name="agent" />, kind: 'model', models: MODELS, chosen: agent, none: 'No agent', onChoose: setAgent },
        ]}
        place={using === 'nothing' ? { workspaces: PLACES, value: place, onChange: setPlace } : undefined}
        onUse={async () => {
          await later()
          if (using === 'fails') throw new Error('The blueprint’s code couldn’t be read.')
          say(`made it${place ? ` in ${PLACES.find(({ id }) => id === place)?.title}` : ' in a new workspace'}`)
          setUsing(undefined)
          return true
        }}
      />
    </>
  )
}
