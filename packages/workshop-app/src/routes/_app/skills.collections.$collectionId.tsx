import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { COLLECTION_TABS, CollectionPane, type CollectionTab } from '@/skills/CollectionPane'

const validateTab = (value: unknown): CollectionTab | undefined => COLLECTION_TABS.find((tab) => tab.value === value && value !== 'skills')?.value

/**
 * One collection of skills, opened from the list of them in the settings: its skills, or with
 * `?tab=settings`, its settings.
 */
export const Route = createFileRoute('/_app/skills/collections/$collectionId')({
  validateSearch: (search: Record<string, unknown>): { tab?: CollectionTab } => ({ tab: validateTab(search.tab) }),
  component: CollectionPage,
})

function CollectionPage() {
  const { collectionId } = Route.useParams()
  const { tab = 'skills' } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <CollectionPane
      // Keyed, so that what was said of one collection is not carried to the next.
      key={collectionId}
      collectionId={collectionId}
      tab={tab}
      // In place, so that going back leaves the collection rather than going through its tabs.
      onTabChange={(next) => navigate({ to: '/skills/collections/$collectionId', params: { collectionId }, search: { tab: next === 'skills' ? undefined : next }, replace: true, state: true })}
      // From the collection, so the way back from the skill comes back to it.
      onOpenSkill={(skillId) => navigate({ to: '/skills/$skillId', params: { skillId }, state: { fromSkillList: true } })}
      skillHref={(skillId) => router.buildLocation({ to: '/skills/$skillId', params: { skillId } }).href}
      onBack={() => {
        // To the list as it was left, where the collection was opened from it.
        if (router.state.location.state.fromSkillList) return router.history.back()
        void navigate({ to: '/settings', search: { section: 'skills' } })
      }}
    />
  )
}
