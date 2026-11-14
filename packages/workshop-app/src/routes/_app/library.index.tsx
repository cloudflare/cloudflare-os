import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { pageOf } from '@/aside/asideItems'
import type { LibraryEntry } from '@/library/libraryEntries'
import { LIBRARY_TABS, LibraryPane, type LibraryPageTab } from '@/library/LibraryPane'

const validateTab = (value: unknown): LibraryPageTab | undefined =>
  LIBRARY_TABS.find((tab) => tab.value === value && value !== 'favorites')?.value

/**
 * Everything the user can open, from all their workspaces: what is starred, or with `?tab=`, the
 * gadgets, the files or their skills. Each opens as its own page, a file shown from the chat it was
 * sent in; a skill can also start a chat of its own.
 */
export const Route = createFileRoute('/_app/library/')({
  validateSearch: (search: Record<string, unknown>): { tab?: LibraryPageTab } => ({ tab: validateTab(search.tab) }),
  component: Library,
})

const page = (entry: LibraryEntry) => ({ ...pageOf(entry.workspaceId, entry.item), search: { chat: entry.chatId } })
const skillPage = (skillId: string) => ({ to: '/skills/$skillId', params: { skillId } }) as const

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
      onOpenSkill={(skillId) => navigate(skillPage(skillId))}
      skillHref={(skillId) => router.buildLocation(skillPage(skillId)).href}
      onUseSkill={({ id, name, description }) => navigate({ to: '/', state: { useSkill: { id, name, description } } })}
    />
  )
}

