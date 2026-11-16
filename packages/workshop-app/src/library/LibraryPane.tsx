import { useMemo, useState } from 'react'
import { PlusIcon, SquaresFourIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { AutomationsTab, type AutomationLink } from '@/automations/AutomationsTab'
import { BlueprintsTab } from '@/blueprints/BlueprintsTab'
import { LibraryToolbar } from '@/blocks/LibraryToolbar'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import type { Skill } from '@/skills/SkillsLibrary'
import { SkillsTab } from '@/skills/SkillsTab'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { libraryGroups, type LibraryEntry, type LibrarySort, type LibraryTab } from './libraryEntries'
import { LibraryList } from './LibraryList'
import { useLibraryEntries } from './useLibraryEntries'

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

// What a tab says when it has nothing, and when a search finds nothing in it.
const EMPTY: Record<LibraryTab, string> = {
  favorites: 'Nothing yet. What your chats make shows here, and what you star stays at the top.',
  gadgets: 'No gadgets yet. What your chats make shows here.',
  files: 'No files yet. What is sent in your chats, and the documents your agents work on, show here.',
}

/**
 * Everything the user's workspaces made, were sent and worked on, and those shared with them, in
 * tabs: what is starred and what was worked on last; the gadgets; the files, sent in chats or
 * kept by a connected service; what runs by itself, in every workspace the user builds in
 * (`AutomationsTab`); and the skills the user's agent follows (`SkillsTab`). As rows
 * grouped by when, or a grid of tiles, ordered latest first or by name, as last chosen on this
 * device; and searched by name. Each opens as its own page. Skills are only ever rows, as each has
 * a line on what it is for, and New skill joins the header while they are shown. Blueprints are
 * only ever tiles, as each has its picture (`BlueprintsTab`), and Upload joins the header while
 * they are shown, which takes in a blueprint's file and opens its page.
 */
export const LibraryPane = ({ tab, onTabChange, onOpen, href, onOpenSkill, skillHref, onUseSkill, automationLink, onOpenBlueprint, blueprintHref }: LibraryPaneProps) => {
  const library = useLibraryEntries()
  const [view, setView] = useState(() => readLayoutPrefs().libraryView ?? 'list')
  const [sort, setSort] = useState<LibrarySort>(() => readLayoutPrefs().librarySort ?? 'recent')
  const [query, setQuery] = useState('')
  const [creatingSkill, setCreatingSkill] = useState(false)
  useDocumentTitle(tab === 'skills' ? 'Skills' : tab === 'automations' ? 'Automations' : tab === 'blueprints' ? 'Blueprints' : 'Library')
  const { api } = useApi()
  const connection = useConnectionNotice()
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
  const groups = useMemo(() => (entryTab ? libraryGroups(library.entries, { tab: entryTab, sort, query }) : []), [library.entries, entryTab, sort, query])
  // Automations are read from every workspace the user builds in: one only looked at keeps them to itself.
  const workspaces = useWorkspaces()
  const building = useMemo(
    () => (workspaces.status === 'ready' ? workspaces.workspaces.filter(({ role }) => role !== 'use').map(({ id }) => id) : undefined),
    [workspaces],
  )
  const searching = query.trim() !== ''

  return (
    <PageLayout
      header={(
        <>
          <HeaderBubble>
            <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
              <SquaresFourIcon aria-hidden="true" />
              Library
            </h1>
          </HeaderBubble>
          <HeaderBubble className="ms-auto">
            <LibraryToolbar
              views={entryTab !== undefined}
              view={view}
              onViewChange={(next) => {
                setView(next)
                writeLayoutPrefs({ libraryView: next })
              }}
              sort={sort}
              onSortChange={(next) => {
                setSort(next)
                writeLayoutPrefs({ librarySort: next })
              }}
              query={query}
              onQueryChange={setQuery}
            />
          </HeaderBubble>
          {tab === 'skills' && (
            <HeaderBubble>
              <Button variant="primary" icon={PlusIcon} onClick={() => setCreatingSkill(true)}>New skill</Button>
            </HeaderBubble>
          )}
          {tab === 'blueprints' && (
            <HeaderBubble>
              {/* A label, so that the click that chooses a file is the user's own. */}
              <label className="flex h-9 cursor-pointer items-center gap-2 rounded-full bg-kumo-base px-4 text-base font-medium text-kumo-default ring-1 ring-kumo-line has-focus-visible:ring-2 has-focus-visible:ring-kumo-ring hover:bg-kumo-tint has-disabled:pointer-events-none has-disabled:opacity-60 [&>svg]:size-[1.125em]">
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
            </HeaderBubble>
          )}
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-5 pb-8">
        <Tabs value={tab} onValueChange={onTabChange} tabs={LIBRARY_TABS} aria-label="Library" className="gap-6">
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
                <p className="appears px-4 text-center text-base text-kumo-subtle">
                  {searching ? `Nothing here is called “${query.trim()}”.` : EMPTY[value]}
                </p>
              )}
              {groups.length > 0 && <LibraryList groups={groups} view={view} library={library} onOpen={onOpen} href={href} />}
            </Tabs.Panel>
          ))}
        </Tabs>
      </div>
    </PageLayout>
  )
}
