import { useState } from 'react'
import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon, NotePencilIcon } from '@phosphor-icons/react'
import { SearchDialog, type SearchEntry } from '@/blocks/SearchDialog'
import { Button } from '@/components/Button'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { Section } from './Section'

const workspace = (title: string, label: string, detail: string) =>
  ({ title, group: 'Workspaces', detail, icon: <WorkspaceIcon label={label} small /> })

/** Search, as ⌘K and the sidebar's button open it. */
export const SearchPreview = () => {
  const [open, setOpen] = useState(false)
  const [said, setSaid] = useState('Search, or press ⌘K on the app’s own pages.')
  const entries: SearchEntry[] = [
    { title: 'New chat', group: 'Go to', keywords: ['home', 'start'], icon: <NotePencilIcon /> },
    { title: 'Workspaces', group: 'Go to', icon: <FolderIcon /> },
    { title: 'Library', group: 'Go to', keywords: ['apps', 'files', 'skills'], icon: <CirclesFourIcon /> },
    workspace('Garden planning', 'GP', 'Just now'),
    workspace('Launch readiness', 'LR', 'Yesterday'),
    workspace('Weekly digest', 'WD', 'Monday'),
  ].map((entry) => ({ ...entry, key: entry.title, onSelect: () => setSaid(`Went to ${entry.title}.`) }))

  return (
    <Section title="SearchDialog (the sidebar’s Search, and ⌘K anywhere in the app: the most recent workspaces, then the app’s own pages, before anything is typed; then what fits, best first, under what each is; the arrow keys and Enter, or a click, to go)">
      <Button icon={MagnifyingGlassIcon} onClick={() => setOpen(true)}>Search</Button>
      <p role="status" className="w-full text-sm text-kumo-subtle">{said}</p>
      <SearchDialog
        open={open}
        onOpenChange={setOpen}
        entries={entries}
        suggested={[...entries.slice(3, 5), ...entries.slice(0, 3)]}
        placeholder="Search workspaces and pages"
      />
    </Section>
  )
}
