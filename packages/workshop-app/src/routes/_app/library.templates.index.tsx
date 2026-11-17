import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { TemplateStorePane } from '@/library/TemplateStorePane'

/**
 * The templates there are to start something from, come to from the library. `?tab=` names the
 * tab that is showing: all of them, or those of a kind, rather than the front.
 */
export const Route = createFileRoute('/_app/library/templates/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({ tab: typeof search.tab === 'string' && search.tab !== '' ? search.tab : undefined }),
  component: Templates,
})

function Templates() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <TemplateStorePane
      tab={tab}
      // In place, so that going back leaves the templates rather than going through their tabs.
      onTabChange={(next) => navigate({ to: '/library/templates', search: { tab: next }, replace: true })}
      onOpenTemplate={({ id }) => navigate({ to: '/library/templates/$templateId', params: { templateId: id } })}
      templateHref={({ id }) => router.buildLocation({ to: '/library/templates/$templateId', params: { templateId: id } }).href}
      onBack={() => navigate({ to: '/library' })}
    />
  )
}
