import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import type { LibraryEntry, LibraryTab } from '@/library/libraryEntries'
import { LIBRARY_TABS, LibraryPane } from '@/library/LibraryPane'

const validateTab = (value: unknown): LibraryTab | undefined =>
  LIBRARY_TABS.find((tab) => tab.value === value && value !== 'favorites')?.value

/**
 * Everything the user can open, from all their workspaces: what is starred, or with `?tab=`, the
 * gadgets or the files. Each opens as its own page, a file shown from the chat it was sent in.
 */
export const Route = createFileRoute('/_app/library/')({
  validateSearch: (search: Record<string, unknown>): { tab?: LibraryTab } => ({ tab: validateTab(search.tab) }),
  component: Library,
})

const page = (entry: LibraryEntry) => ({ ...pageOf(entry.workspaceId, entry.item), search: { chat: entry.chatId } })

function Library() {
  const { tab = 'favorites' } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <LibraryPane
      tab={tab}
      // In place, so that going back leaves the Library rather than going through its tabs.
      onTabChange={(next) => navigate({ to: '/library', search: { tab: next === 'favorites' ? undefined : next }, replace: true })}
      onOpen={(entry) => navigate({ ...page(entry), state: { fromLibrary: true } })}
      href={(entry) => router.buildLocation(page(entry)).href}
    />
  )
}
