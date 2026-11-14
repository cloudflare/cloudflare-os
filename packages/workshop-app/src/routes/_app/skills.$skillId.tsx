import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { SkillPane } from '@/skills/SkillPane'

/**
 * One skill, on a page of its own: opened from the Library's Skills tab, which is where going back
 * goes. Its id is its document's (`collection/path`), so renaming it moves it.
 */
export const Route = createFileRoute('/_app/skills/$skillId')({
  component: SkillPage,
})

const toSkills = { to: '/library', search: { tab: 'skills' } } as const

function SkillPage() {
  const { skillId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <SkillPane
      key={skillId}
      skillId={skillId}
      onBack={() => navigate(toSkills)}
      onUse={({ id, name, description }) => navigate({ to: '/', state: { useSkill: { id, name, description } } })}
      // In place, so going back does not come to where it was.
      onMoved={(moved) => navigate({ to: '/skills/$skillId', params: { skillId: moved }, replace: true })}
      onDeleted={() => navigate({ ...toSkills, replace: true })}
      link={new URL(router.buildLocation({ to: '/skills/$skillId', params: { skillId } }).href, window.location.origin).href}
    />
  )
}
