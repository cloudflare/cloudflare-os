import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { withStar } from './libraryStars'
import { mostUsed } from './templateList'
import { TemplatePageView } from './TemplatePageView'
import { templateType, type Template } from './templates'
import { useTemplates } from './useTemplates'

/** How many others of its kind a template's page goes on to. */
const RELATED = 4

export type TemplatePaneProps = {
  templateId: string
  onOpenTemplate: (template: Template) => void
  /** A template's page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
  /** Goes back to the templates. */
  onBack: () => void
}

/**
 * One template's page (`TemplatePageView`) over what it shows: the template, whether it is
 * starred, and the most used others of its kind.
 *
 * There is no way to start something from a template yet, and which of the services it needs the
 * user has connected is not asked: its button is out of use, and its connections are only listed.
 */
export const TemplatePane = ({ templateId, onOpenTemplate, templateHref, onBack }: TemplatePaneProps) => {
  const { templates, stars, setStars } = useTemplates()
  const template = templates.find(({ id }) => id === templateId)
  useDocumentTitle(template?.metadata.title ?? 'Template')

  return (
    <TemplatePageView
      template={template}
      starred={stars.includes(templateId)}
      onStarredChange={(on) => setStars(withStar(stars, templateId, on))}
      related={template ? mostUsed(templates).filter((other) => other.id !== template.id && templateType(other).id === templateType(template).id).slice(0, RELATED) : []}
      onOpenTemplate={onOpenTemplate}
      templateHref={templateHref}
      onBack={onBack}
    />
  )
}
