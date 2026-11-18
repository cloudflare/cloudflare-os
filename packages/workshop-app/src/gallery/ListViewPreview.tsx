import { useState } from 'react'
import { FileTextIcon, PresentationIcon, TableIcon } from '@phosphor-icons/react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { ListToolbar } from '@/blocks/ListToolbar'
import { WorkspaceCard } from '@/blocks/WorkspaceCard'
import { WorkspaceRow } from '@/blocks/WorkspaceRow'
import { Button } from '@/components/Button'
import { cn } from '@cloudflare/kumo/utils'
import { CardGrid } from '@/components/CardGrid'
import { DropdownMenu } from '@/components/DropdownMenu'
import { GroupedList } from '@/components/GroupedList'
import { useListView } from '@/hooks/useListView'
import { formatActivity } from '@/workspaces/formatActivity'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceList, workspaceTitle } from '@/workspaces/workspaceList'
import type { WorkspaceMember } from '@/workspaces/workspaceMembers'
import { Switch } from '@/components/Switch'
import { useReport } from './previewState'
import { Section } from './Section'

const HOUR = 60 * 60 * 1000
const person = (name: string) => ({ type: 'user' as const, id: `${name.split(' ')[0].toLowerCase()}@example.com`, name })
const me = person('Ada Lovelace')
const grace = person('Grace Hopper')
const others = ['Alan Turing', 'Katherine Johnson', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton', 'Linus Torvalds', 'Radia Perlman'].map(person)

// Hours before now that each was last active and was made, across today, the past week and older
// months, with some that are somebody else's, one with no title, and who else each is shared with.
const WORKSPACES: Array<{ id: string; title: string; active: number; created: number; pinned?: boolean; owner?: typeof grace; with?: Array<typeof grace> }> = [
  { id: 'engineering', title: 'Engineering notes', active: 1, created: 900, pinned: true, with: others },
  { id: 'jira', title: 'Jira dashboard', active: 2, created: 3, with: [grace] },
  { id: 'paris', title: 'Paris slides, with a title long enough that it has to be cut off somewhere', active: 5, created: 30, owner: grace },
  { id: 'design', title: 'Design review', active: 26, created: 200, pinned: true, owner: grace, with: others.slice(0, 2) },
  { id: 'budget', title: 'Budget 2026', active: 30, created: 31 },
  { id: 'untitled', title: '', active: 52, created: 52 },
  { id: 'atlas', title: 'Atlas migration', active: 75, created: 2000, owner: grace, with: others.slice(2, 5) },
  { id: 'eval', title: 'Évaluation des modèles', active: 400, created: 410, pinned: true },
  { id: 'launch', title: 'Launch checklist', active: 1500, created: 1600, pinned: true, with: [others[0]] },
  { id: 'zebra', title: 'Zebra crossing counter', active: 1700, created: 4000, pinned: true },
]

// Who has access to each, the owner first, as the workspaces would say when asked.
const MEMBERSHIPS = new Map(WORKSPACES.map((workspace): [string, WorkspaceMember[]] => [
  workspace.id,
  [
    { profile: workspace.owner ?? me, role: 'owner' },
    ...(workspace.owner ? [{ profile: me, role: 'build' as const }] : []),
    ...(workspace.with ?? []).map((profile) => ({ profile, role: 'build' as const })),
  ],
]))

/** A whole list as the Workspaces page has one, over fake workspaces. */
export const ListViewPreview = () => {
  const { say } = useReport()
  const [now] = useState(() => Date.now())
  const [starred, setStarred] = useState(() => WORKSPACES.filter(({ pinned }) => pinned).map(({ id }) => id))
  const [under, setUnder] = useState(false)
  // Those with anything unread, until they are marked read.
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set(['jira', 'design']))
  const all: WorkspaceMetadataWithTimestamps[] = WORKSPACES.map(({ id, title, active, created, owner }) => ({
    id,
    title,
    owner,
    pinned: starred.includes(id),
    lastActive: new Date(now - active * HOUR),
    created: new Date(now - created * HOUR),
  }))
  const list = useListView('gallery', workspaceList(all, MEMBERSHIPS, me.id, unread))
  const shown = list.narrow(all)
  const timeOf = (workspace: WorkspaceMetadataWithTimestamps) => formatActivity(list.order.at(workspace))
  const pinned = starred.flatMap((id) => shown.filter((workspace) => workspace.id === id))
  const groups = [
    ...(pinned.length > 0 ? [{ key: 'starred', label: 'Starred', entries: pinned.map((value) => ({ value, time: timeOf(value) })) }] : []),
    ...list.arrange(shown.filter((workspace) => !workspace.pinned)).map(({ key, label, entries }) => ({
      key: `${list.order.id}:${key}`,
      label,
      entries: entries.map(({ value, time }) => ({ value, time: time ?? timeOf(value) })),
    })),
  ]
  const propsOf = (workspace: WorkspaceMetadataWithTimestamps) => ({
    workspaceLabel: workspaceLabel(workspace.title),
    title: workspaceTitle(workspace),
    members: MEMBERSHIPS.get(workspace.id)?.map(({ profile }) => ({ id: profile.id, name: profile.name, you: profile.id === me.id })),
    starred: workspace.pinned === true,
    onStarredChange: (on: boolean) => setStarred((current) => (on ? [workspace.id, ...current] : current.filter((other) => other !== workspace.id))),
    href: `#${workspace.id}`,
    unread: unread.has(workspace.id)
      ? {
          onMarkRead: () => {
            setUnread((current) => new Set([...current].filter((id) => id !== workspace.id)))
            say(`marked ${workspaceTitle(workspace)} read`)
          },
        }
      : undefined,
    onSelect: () => say(`open ${workspaceTitle(workspace)}`),
  })

  return (
    <Section title="ListToolbar, SearchField, CardGrid, WorkspaceCard (a list's controls: the search opens out over the room when clicked or tabbed to, stays open while it has text, and Escape clears it, then puts it away; rows or cards, kept for next time as the order is; the order, which is also how the list is grouped: by when it was last active or made, or by name under letters; the filters, a dot on their button while any is on, with Unread for those with anything unread, which a dot marks and their more menu marks read, Mine and Shared with me as alternatives, and Members a menu of its own, with a field that finds one; and what the list offers to do, here a menu. A workspace shows the first three of those with access to it, the viewer alone when nobody else has, each saying how many there are and whose it is when pointed at; a card shows them smaller, beside its time. The starred stay first in every order, and are dragged, or moved with Alt and an arrow key, into another order, as rows or as cards, while nothing narrows them. On a narrow screen the controls are under the list, together in the middle, lifted by a shadow, and their menus open upwards)">
      <Switch label="Controls under the list, as on a narrow screen" checked={under} onCheckedChange={setUnder} />
      <div className={cn('flex w-full gap-4', under ? 'flex-col-reverse' : 'flex-col')}>
        <ListToolbar
          noun="workspaces"
          {...list.controls}
          at={under ? 'bottom' : 'top'}
          action={(
            <DropdownMenu label="New" caret triggerVariant="primary" side={under ? 'top' : 'bottom'} align="end" inPlace>
              <DropdownMenu.Item icon={FileTextIcon} onSelect={() => say('new document')}>Document</DropdownMenu.Item>
              <DropdownMenu.Item icon={TableIcon} onSelect={() => say('new spreadsheet')}>Spreadsheet</DropdownMenu.Item>
              <DropdownMenu.Item icon={PresentationIcon} onSelect={() => say('new presentation')}>Presentation</DropdownMenu.Item>
            </DropdownMenu>
          )}
        />
        {shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            No workspaces match.
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
                      rows: entries.map(({ value, time }) => ({ key: value.id, content: <WorkspaceRow {...propsOf(value)} time={time} /> })),
                      onReorder: key === 'starred' && !list.narrowed ? setStarred : undefined,
                    }))}
                  />
                )
              : (
                  <CardGrid
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      cards: entries.map(({ value, time }) => ({ key: value.id, content: <WorkspaceCard {...propsOf(value)} time={time} /> })),
                      onReorder: key === 'starred' && !list.narrowed ? setStarred : undefined,
                    }))}
                  />
                )}
          </div>
        )}
      </div>
    </Section>
  )
}
