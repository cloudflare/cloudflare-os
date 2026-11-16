import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { LibraryCard } from '@/blocks/LibraryCard'
import { LibraryRow } from '@/blocks/LibraryRow'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { GroupedList } from '@/components/GroupedList'
import { useListView } from '@/hooks/useListView'
import { libraryList, outputDetail, outputKey, outputTitle } from '@/library/libraryList'
import { withStar, withStarOrder } from '@/library/libraryStars'
import { formatActivity } from '@/workspaces/formatActivity'
import { useReport } from './previewState'
import { Section } from './Section'

const HOUR = 60 * 60 * 1000
const grace = { type: 'user' as const, id: 'grace@example.com', name: 'Grace Hopper' }

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }
const SPREADSHEET: BlueprintOutput = { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table' }
const PRESENTATION: BlueprintOutput = { id: 'presentation', noun: 'Presentation', plural: 'Presentations', icon: 'presentation' }
const NOTEBOOK: BlueprintOutput = { id: 'notebook', noun: 'Notebook', plural: 'Notebooks', icon: 'notebook' }
const WORKFLOW: BlueprintOutput = { id: 'workflow', noun: 'Workflow', plural: 'Workflows', icon: 'flowArrow' }

// What the deployment offers: nothing has been made as a notebook, and workflows are no longer offered.
const FORMATS = [DOCUMENT, SPREADSHEET, PRESENTATION, NOTEBOOK]

// Hours before now that each one's workspace was last active and it was made, across today, the
// past week and older months, of every type, with some in somebody else's workspace and one untitled.
const OUTPUTS: Array<{ id: number; title: string; workspace: string; active: number; created: number; output?: BlueprintOutput; owner?: typeof grace }> = [
  { id: 1, title: 'Q3 platform review', workspace: 'Engineering notes', active: 1, created: 30, output: DOCUMENT },
  { id: 2, title: 'Incident retro', workspace: 'Engineering notes', active: 1, created: 900, output: DOCUMENT },
  { id: 3, title: 'Jira dashboard with a title long enough that it has to be cut off somewhere', workspace: 'Jira dashboard', active: 2, created: 3 },
  { id: 4, title: 'A walk through Paris', workspace: 'Paris slides', active: 5, created: 30, output: PRESENTATION, owner: grace },
  { id: 5, title: 'Budget 2026', workspace: 'Budget 2026', active: 30, created: 31, output: SPREADSHEET },
  { id: 6, title: 'Headcount plan', workspace: 'Budget 2026', active: 30, created: 200, output: SPREADSHEET },
  { id: 7, title: '', workspace: '', active: 52, created: 52 },
  { id: 8, title: 'Atlas cutover', workspace: 'Atlas migration', active: 75, created: 2000, output: WORKFLOW, owner: grace },
  { id: 9, title: 'Atlas runbook', workspace: 'Atlas migration', active: 75, created: 1900, output: DOCUMENT, owner: grace },
  { id: 10, title: 'Évaluation des modèles', workspace: 'Model evals', active: 400, created: 410, output: SPREADSHEET },
  { id: 11, title: 'Launch checklist', workspace: 'Launch', active: 1500, created: 1600, output: DOCUMENT },
  { id: 12, title: 'Zebra crossing counter', workspace: 'Launch', active: 1500, created: 4000 },
]

/** A whole list as the Library page has one, over fake outputs. */
export const LibraryListPreview = () => {
  const { say } = useReport()
  const [now] = useState(() => Date.now())
  const [under, setUnder] = useState(false)
  const all: OutputSummary[] = OUTPUTS.map(({ id, title, workspace, active, created, output, owner }) => ({
    workspaceId: workspace.toLowerCase().replaceAll(' ', '-') || 'untitled',
    workpieceId: id,
    title,
    workspaceTitle: workspace,
    output,
    owner,
    lastActive: new Date(now - active * HOUR),
    created: new Date(now - created * HOUR),
  }))
  const [stars, setStars] = useState(() => [all[4], all[0]].map(outputKey))
  const starredKeys = new Set(stars)
  const list = useListView('gallery-library', libraryList(all, FORMATS, starredKeys))
  const shown = list.narrow(all)
  const shownByKey = new Map(shown.map((output) => [outputKey(output), output]))
  const starred = stars.flatMap((key) => shownByKey.get(key) ?? [])
  const timeOf = (output: OutputSummary) => formatActivity(list.order.at(output))
  const groups = [
    ...(starred.length > 0 ? [{ key: 'starred', label: 'Starred', entries: starred.map((output) => ({ value: output, time: timeOf(output) })) }] : []),
    ...list.arrange(shown.filter((output) => !starredKeys.has(outputKey(output)))).map(({ key, label, entries }) => ({
      key: `${list.order.id}:${key}`,
      label,
      entries: entries.map(({ value, time }) => ({ value, time: time ?? timeOf(value) })),
    })),
  ]
  const reorderStarred = list.narrowed ? undefined : (order: string[]) => setStars(withStarOrder(stars, order))
  const propsOf = (output: OutputSummary) => ({
    title: outputTitle(output),
    icon: output.output?.icon,
    starred: starredKeys.has(outputKey(output)),
    onStarredChange: (on: boolean) => setStars(withStar(stars, outputKey(output), on)),
    href: `#${outputKey(output)}`,
    onSelect: () => say(`open ${outputTitle(output)}`),
  })

  return (
    <Section title="LibraryRow, LibraryCard (the Library page’s list, with the controls a list has: the order, which is also how it is grouped, by when its workspace was last active or it was made, by name under letters, or by type, each type a group of its own however few it has; the filters: Starred; Mine and Shared with me; and Type and Workspace, each a menu of its own with a field that finds one, the types being apps, then what the deployment offers, Notebooks included though none has been made, then Workflows, which it no longer offers. The search also finds an output by its type, its workspace, and who shared it. New is a menu of what the deployment offers to start one as. The starred stay first in every order, and are dragged, or moved with Alt and an arrow key, into another order while nothing narrows them. A card does not say which workspace it is in)">
      <Switch label="Controls under the list, as on a narrow screen" checked={under} onCheckedChange={setUnder} />
      <div className={cn('flex w-full gap-4', under ? 'flex-col-reverse' : 'flex-col')}>
        <ListToolbar
          noun="the library"
          {...list.controls}
          at={under ? 'bottom' : 'top'}
          action={(
            <DropdownMenu label="New" caret triggerVariant="primary" side={under ? 'top' : 'bottom'} align="end" inPlace>
              {FORMATS.map((format) => (
                <DropdownMenu.Item key={format.id} label={format.noun} onSelect={() => say(`new ${format.noun.toLowerCase()}`)}>
                  <FormatIcon name={format.icon} className="shrink-0" />
                  {format.noun}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu>
          )}
        />
        {shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            Nothing matches.
            <Button variant="ghost" onClick={list.showAll}>Show all</Button>
          </p>
        )}
        {shown.length > 0 && (
          <div key={`${list.mode}:${list.order.id}`} className="appears">
            {list.mode === 'list'
              ? (
                  <GroupedList
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      rows: entries.map(({ value, time }) => ({ key: outputKey(value), content: <LibraryRow {...propsOf(value)} detail={outputDetail(value)} time={time} /> })),
                      onReorder: key === 'starred' ? reorderStarred : undefined,
                    }))}
                  />
                )
              : (
                  <CardGrid
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      cards: entries.map(({ value, time }) => ({ key: outputKey(value), content: <LibraryCard {...propsOf(value)} detail={outputDetail(value, { workspace: false })} time={time} /> })),
                      onReorder: key === 'starred' ? reorderStarred : undefined,
                    }))}
                  />
                )}
          </div>
        )}
      </div>
    </Section>
  )
}
