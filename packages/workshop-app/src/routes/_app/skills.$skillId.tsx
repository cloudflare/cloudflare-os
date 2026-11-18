import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { SKILL_TABS, SkillPane, type SkillTab } from '@/skills/SkillPane'

const validateTab = (value: unknown): SkillTab | undefined => SKILL_TABS.find((tab) => tab.value === value && value !== 'preview')?.value

/**
 * One skill, opened from the list of them in the settings: what it says, or with `?tab=`, its
 * files or its settings, or with `?file=`, the one of its files at that path, in a tab of its own.
 */
export const Route = createFileRoute('/_app/skills/$skillId')({
  validateSearch: (search: Record<string, unknown>): { tab?: SkillTab; file?: string } => ({
    tab: validateTab(search.tab),
    // A path that reads as something else, such as a number, is still a path.
    file: search.file === undefined || search.file === '' ? undefined : String(search.file),
  }),
  component: SkillPage,
})

function SkillPage() {
  const { skillId } = Route.useParams()
  const { tab = 'preview', file } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <SkillPane
      // Keyed, so that what was said of one skill is not carried to the next.
      key={skillId}
      skillId={skillId}
      tab={tab}
      // In place, so that going back leaves the skill rather than going through its tabs.
      onTabChange={(next) => navigate({ to: '/skills/$skillId', params: { skillId }, search: { tab: next === 'preview' ? undefined : next }, replace: true, state: true })}
      file={file}
      onOpenFile={(path) => navigate({ to: '/skills/$skillId', params: { skillId }, search: { file: path }, replace: true, state: true })}
      fileHref={(path) => router.buildLocation({ to: '/skills/$skillId', params: { skillId }, search: { file: path } }).href}
      // In place, so that going back does not come to where it no longer is.
      onMoved={(id) => navigate({ to: '/skills/$skillId', params: { skillId: id }, search: { tab: tab === 'preview' ? undefined : tab }, replace: true, state: true })}
      onOpenCollection={(collectionId) => navigate({ to: '/skills/collections/$collectionId', params: { collectionId }, state: { fromSkillList: true } })}
      onBack={() => {
        // To the list as it was left, where the skill was opened from it.
        if (router.state.location.state.fromSkillList) return router.history.back()
        void navigate({ to: '/settings', search: { section: 'skills' } })
      }}
    />
  )
}
