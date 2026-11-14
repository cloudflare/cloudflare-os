import { useMemo, useState } from 'react'
import { PlusIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { LibraryToolbar } from '@/blocks/LibraryToolbar'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import type { Skill } from '@/skills/SkillsLibrary'
import { SkillsTab } from '@/skills/SkillsTab'
import { libraryGroups, type LibraryEntry, type LibrarySort, type LibraryTab } from './libraryEntries'
import { LibraryList } from './LibraryList'
import { useLibraryEntries } from './useLibraryEntries'

/** What the Library page shows, a tab each: what the workspaces made, and the user's skills. */
export type LibraryPageTab = LibraryTab | 'skills'

/** The Library's tabs, in order. */
export const LIBRARY_TABS: Array<{ value: LibraryPageTab; label: string }> = [
  { value: 'favorites', label: 'Favorites' },
  { value: 'gadgets', label: 'Gadgets' },
  { value: 'files', label: 'Files' },
  { value: 'skills', label: 'Skills' },
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
}

const ENTRY_TABS = LIBRARY_TABS.filter((tab): tab is { value: LibraryTab; label: string } => tab.value !== 'skills')

// What a tab says when it has nothing, and when a search finds nothing in it.
const EMPTY: Record<LibraryTab, string> = {
  favorites: 'Nothing yet. Star a gadget or a file to keep it here, at hand.',
  gadgets: 'No gadgets yet. What your chats make shows here.',
  files: 'No files yet. What is sent in your chats, and the documents your agents work on, show here.',
}

/**
 * Everything the user's workspaces made, were sent and worked on, and those shared with them, in
 * tabs: what is starred and what was worked on last; the gadgets; the files, sent in chats or
 * kept by a connected service; and the skills the user's agent follows (`SkillsTab`). As rows
 * grouped by when, or a grid of tiles, ordered latest first or by name, as last chosen on this
 * device; and searched by name. Each opens as its own page. Skills are only ever rows, as each has
 * a line on what it is for, and New skill joins the header while they are shown.
 */
export const LibraryPane = ({ tab, onTabChange, onOpen, href, onOpenSkill, skillHref, onUseSkill }: LibraryPaneProps) => {
  const library = useLibraryEntries()
  const [view, setView] = useState(() => readLayoutPrefs().libraryView ?? 'list')
  const [sort, setSort] = useState<LibrarySort>(() => readLayoutPrefs().librarySort ?? 'recent')
  const [query, setQuery] = useState('')
  const [creatingSkill, setCreatingSkill] = useState(false)
  useDocumentTitle(tab === 'skills' ? 'Skills' : 'Library')

  const groups = useMemo(() => (tab === 'skills' ? [] : libraryGroups(library.entries, { tab, sort, query })), [library.entries, tab, sort, query])
  const searching = query.trim() !== ''

  return (
    <PageLayout
      header={(
        <>
          <HeaderBubble>
            <h1 className="flex h-9 items-center gap-2 rounded-full bg-kumo-base pr-4 pl-3 text-base font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
              <SquaresFourIcon aria-hidden="true" />
              Library
            </h1>
          </HeaderBubble>
          <HeaderBubble className="ms-auto">
            <LibraryToolbar
              views={tab !== 'skills'}
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
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-5 pb-8">
        <Tabs value={tab} onValueChange={onTabChange} tabs={LIBRARY_TABS} aria-label="Library" className="gap-6">
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
            <Tabs.Panel key={value} value={value} className="flex flex-col gap-4">
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
