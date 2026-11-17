import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { TemplatePane } from '@/library/TemplatePane'

/** One template's own page, opened from where the templates are listed. */
export const Route = createFileRoute('/_app/library/templates/$templateId')({
  component: TemplatePage,
})

function TemplatePage() {
  const { templateId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <TemplatePane
      templateId={templateId}
      onOpenTemplate={({ id }) => navigate({ to: '/library/templates/$templateId', params: { templateId: id } })}
      templateHref={({ id }) => router.buildLocation({ to: '/library/templates/$templateId', params: { templateId: id } }).href}
      onBack={() => navigate({ to: '/library/templates' })}
    />
  )
}
