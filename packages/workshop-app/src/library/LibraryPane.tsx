import { useMemo, useState, type ReactNode } from 'react'
import { CirclesFourIcon, PlusIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { AutomationsTab, type AutomationLink } from '@/automations/AutomationsTab'
import { BlueprintsTab } from '@/blueprints/BlueprintsTab'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { ListOrder } from '@/components/listView'
import { Tabs } from '@/components/Tabs'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { readLibraryStarOrder, writeLibraryStarOrder } from '@/prefs/libraryStars'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { Skill } from '@/skills/SkillsLibrary'
import { SkillsTab } from '@/skills/SkillsTab'
import { formatActivity } from '@/workspaces/formatActivity'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { LibraryEntry, LibraryGroup, LibrarySort, LibraryTab } from './libraryEntries'
import { LibraryEntryList } from './LibraryEntryList'
import { libraryList } from './libraryList'
import { byStarOrder, withStarOrder } from './libraryStars'
import { useLibraryEntries } from './useLibraryEntries'
import { startableFormats, useOutputFormats } from './useOutputFormats'

/**
 * What the Library page shows, a tab each: what the workspaces made, what runs by itself, the
 * user's skills, and the blueprints they can start a gadget from.
 */
export type LibraryPageTab = LibraryTab | 'automations' | 'skills' | 'blueprints'

/** The Library's tabs, in order. */
export const LIBRARY_TABS: Array<{ value: LibraryPageTab; label: string }> = [
  { value: 'favorites', label: 'Recent' },
  { value: 'gadgets', label: 'Gadgets' },
  { value: 'files', label: 'Files' },
  { value: 'automations', label: 'Automations' },
  { value: 'skills', label: 'Skills' },
  { value: 'blueprints', label: 'Blueprints' },
]

export type LibraryPaneProps = {
  tab: LibraryPageTab
  onTabChange: (tab: LibraryPageTab) => void
  onOpen: (entry: LibraryEntry) => void
  /** An entry's page, for it to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
  /** Starts a chat that makes something new: as `format`, when one of those offered was chosen. */
  onNew: (format?: BlueprintOutput) => void
  onOpenSkill: (skillId: string) => void
  /** A skill's page, for its row to link to. */
  skillHref?: (skillId: string) => string
  /** Starts a chat with a skill chosen in its composer. */
  onUseSkill: (skill: Skill) => void
  /** Where an automation reports, for its row to open and link to. */
  automationLink: AutomationLink
  /** Opens a blueprint's page; with `use`, with Use asked for, as from its tile's menu. */
  onOpenBlueprint: (blueprintId: string, use?: boolean) => void
  /** A blueprint's page, for its tile to link to. */
  blueprintHref?: (blueprintId: string) => string
}

const ENTRY_TABS = LIBRARY_TABS.filter((tab): tab is { value: LibraryTab; label: string } => tab.value !== 'skills' && tab.value !== 'automations' && tab.value !== 'blueprints')

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What a tab says when it has nothing.
const EMPTY: Record<LibraryTab, string> = {
  favorites: 'Nothing yet. What your chats make shows here, and what you star stays at the top.',
  gadgets: 'No gadgets yet. What your chats make shows here.',
  files: 'No files yet. What is sent in your chats, and the documents your agents work on, show here.',
}

// Recent shows what is starred, then this many of what was worked on last, to reach for.
const RECENT = 8

// Automations, skills and blueprints keep their own order and groups, and are only searched and put
// latest first or by name here.
const OTHER_ORDERS: Array<ListOrder<never> & { id: LibrarySort }> = [
  { id: 'recent', label: 'Latest', arrange: () => [] },
  { id: 'name', label: 'Name', arrange: () => [] },
]

const latest = (a: LibraryEntry, b: LibraryEntry) => b.at.getTime() - a.at.getTime()

// A row of a group, with when it was: as its order says, else when it was last worked on.
const timed = (entry: LibraryEntry, time?: string) => ({ entry, time: time ?? formatActivity(entry.at) })

/**
 * Everything the user's workspaces made, were sent and worked on, and those shared with them, in
 * tabs: what is starred and what was worked on last; the gadgets; the files, sent in chats or
 * kept by a connected service; what runs by itself, in every workspace the user builds in
 * (`AutomationsTab`); the skills the user's agent follows (`SkillsTab`); and the blueprints they
 * can start a gadget from (`BlueprintsTab`). Over each, the list's controls (`ListToolbar`): a
 * search, and for what was made and sent rows or cards, the order, filters, and New, which starts
 * a chat that makes something, as one of the formats the deployment offers. What waits on the
 * viewer leads, then the starred, in the order the user put them in, then the rest in the order
 * chosen, grouped as it groups them. Skills are only ever rows, with New skill; blueprints only
 * ever tiles, with Upload, which takes in a blueprint's file and opens its page. On a narrow
 * screen the controls are under the list, in reach of a thumb.
 */
export const LibraryPane = ({ tab, onTabChange, onOpen, href, onNew, onOpenSkill, skillHref, onUseSkill, automationLink, onOpenBlueprint, blueprintHref }: LibraryPaneProps) => {
  const library = useLibraryEntries()
  const offers = useOutputFormats()
  const [starOrder, setStarOrder] = useState(readLibraryStarOrder)
  const [creatingSkill, setCreatingSkill] = useState(false)
  useDocumentTitle(tab === 'skills' ? 'Skills' : tab === 'automations' ? 'Automations' : tab === 'blueprints' ? 'Blueprints' : 'Library')
  const { api } = useApi()
  const connection = useConnectionNotice()
  const narrow = useNarrowScreen()
  const [uploading, setUploading] = useState(false)
  const [uploadProblem, setUploadProblem] = useState<string>()
  // A blueprint's file, saved from its page here or another deployment's: taken in, then shown.
  const upload = (file: File) => {
    setUploadProblem(undefined)
    if (connection?.blocked()) return
    setUploading(true)
    api.importBlueprint(file.stream()).then(
      (id) => onOpenBlueprint(id),
      (error: unknown) => setUploadProblem(`Couldn’t upload ${file.name}: ${messageOf(error)}`),
    ).finally(() => setUploading(false))
  }

  const entryTab = tab !== 'skills' && tab !== 'automations' && tab !== 'blueprints' ? tab : undefined
  const { gadgets, files, favorites } = library.entries
  const listed = useMemo(
    () => (entryTab === 'gadgets' ? gadgets : entryTab === 'files' ? files : [...gadgets, ...files].toSorted(latest)),
    [entryTab, gadgets, files],
  )
  const list = useListView('library', libraryList(listed, offers.map(({ output }) => output)))
  const other = useListView<never, (typeof OTHER_ORDERS)[number]>('library-other', { orders: OTHER_ORDERS, searchText: () => '' })
  const sort = other.order.id
  const query = other.controls.search.value

  const keepOrder = (order: string[]) => {
    setStarOrder(order)
    writeLibraryStarOrder(order)
  }
  // Only with all of the starred there: putting some of them in order would lose the others' places.
  const reorderStarred = list.narrowed ? undefined : (order: string[]) => keepOrder(withStarOrder(starOrder, order))

  const groups = ((): LibraryGroup[] => {
    if (!entryTab) return []
    const shown = list.narrow(listed)
    // What waits on the viewer leads, out of the groups it would be in otherwise, so it is seen first.
    const waiting = entryTab === 'files' ? [] : shown.filter((entry) => entry.waiting)
    const leads = (entry: LibraryEntry) => waiting.includes(entry)
    // Recent's starred include what the listings do not have, from what starring it recorded.
    const starred = byStarOrder((entryTab === 'favorites' ? list.narrow(favorites) : shown.filter((entry) => entry.starred)).filter((entry) => !leads(entry)), starOrder)
    const rest = shown.filter((entry) => !entry.starred && !leads(entry))
    return [
      ...(waiting.length > 0 ? [{ key: 'waiting', label: 'Needs approval', rows: waiting.toSorted(latest).map((entry) => timed(entry)) }] : []),
      ...(starred.length > 0 ? [{ key: 'starred', label: 'Starred', rows: starred.map((entry) => timed(entry)) }] : []),
      ...(entryTab === 'favorites'
        ? (rest.length > 0 ? [{ key: 'recent', label: 'Latest', rows: rest.slice(0, RECENT).map((entry) => timed(entry)) }] : [])
        : list.arrange(rest).map(({ key, label, entries }) => ({ key: `${list.order.id}:${key}`, label, rows: entries.map(({ value, time }) => timed(value, time)) }))),
    ]
  })()

  // Automations are read from every workspace the user builds in: one only looked at keeps them to itself.
  const workspaces = useWorkspaces()
  const building = useMemo(
    () => (workspaces.status === 'ready' ? workspaces.workspaces.filter(({ role }) => role !== 'use').map(({ id }) => id) : undefined),
    [workspaces],
  )

  const startable = startableFormats(offers)
  const action: ReactNode = entryTab
    ? startable.length > 0
      ? (
          <DropdownMenu label="New" caret triggerVariant="primary" side={narrow ? 'top' : 'bottom'} align="end" inPlace>
            {startable.map((format) => (
              <DropdownMenu.Item key={format.id} label={format.noun} onSelect={() => onNew(format)}>
                <FormatIcon name={format.icon} className="size-4 shrink-0" />
                {format.noun}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu>
        )
      // With no formats to choose between, or until they are known, it starts a chat at once.
      : <Button variant="primary" onClick={() => onNew()}>New</Button>
    : tab === 'skills'
      ? <Button variant="primary" icon={PlusIcon} onClick={() => setCreatingSkill(true)}>New skill</Button>
      : tab === 'blueprints'
        ? (
            // A label, so that the click that chooses a file is the user's own.
            <label
              className={cn(
                'flex h-(--control-size) cursor-pointer items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]',
                'hover:bg-kumo-tint has-focus-visible:ring-2 has-focus-visible:ring-kumo-ring has-disabled:pointer-events-none has-disabled:opacity-60',
              )}
            >
              <UploadSimpleIcon aria-hidden="true" />
              {uploading ? 'Uploading…' : 'Upload'}
              <input
                type="file"
                accept=".gadget"
                className="sr-only"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) upload(file)
                }}
              />
            </label>
          )
        : undefined
  // Recent is what is starred and what was worked on last, which has no other order.
  const recentControls = { ...list.controls, order: undefined }
  const toolbar = (
    <ListToolbar
      key={entryTab ? 'library' : tab}
      noun={entryTab ? 'the library' : tab}
      {...(entryTab ? (entryTab === 'favorites' ? recentControls : list.controls) : { search: other.controls.search, order: other.controls.order })}
      at={narrow ? 'bottom' : 'top'}
      action={action}
    />
  )

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <CirclesFourIcon aria-hidden="true" />
            Library
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2 pb-8">
        <Tabs value={tab} onValueChange={onTabChange} tabs={LIBRARY_TABS} aria-label="Library" className="gap-4">
          {!narrow && toolbar}
          <Tabs.Panel value="automations" className="flex flex-col gap-6">
            {tab === 'automations' && (
              <AutomationsTab
                workspaceIds={building}
                withWorkspace
                order={sort}
                query={query}
                canChange={() => true}
                link={automationLink}
                empty="Nothing runs by itself yet. Ask in a chat for something to happen every morning, or whenever an email arrives, and it shows here."
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel value="blueprints" className="flex flex-col gap-8">
            {uploadProblem && <p role="alert" className="px-4 text-base text-kumo-danger">{uploadProblem}</p>}
            {tab === 'blueprints' && (
              <BlueprintsTab
                sort={sort}
                query={query}
                onOpen={(id) => onOpenBlueprint(id)}
                onUse={(id) => onOpenBlueprint(id, true)}
                href={blueprintHref}
              />
            )}
          </Tabs.Panel>
          <Tabs.Panel value="skills" className="flex flex-col gap-6">
            {tab === 'skills' && (
              <SkillsTab
                sort={sort}
                query={query}
                creating={creatingSkill}
                onCreatingChange={setCreatingSkill}
                onOpenSkill={onOpenSkill}
                skillHref={skillHref}
                onUse={onUseSkill}
              />
            )}
          </Tabs.Panel>
          {ENTRY_TABS.map(({ value }) => (
            <Tabs.Panel key={value} value={value} className="flex flex-col gap-6">
              {library.loading && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
              {library.problem && (
                <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
                  Couldn’t load the library: {library.problem}
                  {library.retry && <Button variant="ghost" onClick={library.retry}>Try again</Button>}
                </p>
              )}
              {!library.loading && !library.problem && groups.length === 0 && (
                list.narrowed
                  ? (
                      <p className="appears flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
                        Nothing matches.
                        <Button variant="ghost" onClick={list.showAll}>Show all</Button>
                      </p>
                    )
                  : <p className="appears px-4 text-center text-base text-kumo-subtle">{EMPTY[value]}</p>
              )}
              {groups.length > 0 && (
                // Another order or view is another list, faded to rather than moved to row by row.
                <div key={`${value}:${list.mode}:${list.order.id}`} className="appears flex flex-col gap-6">
                  <LibraryEntryList
                    groups={groups}
                    view={list.mode}
                    headed={false}
                    onReorderStarred={reorderStarred}
                    library={library}
                    onOpen={onOpen}
                    href={href}
                  />
                </div>
              )}
            </Tabs.Panel>
          ))}
        </Tabs>
      </div>
    </PageLayout>
  )
}
