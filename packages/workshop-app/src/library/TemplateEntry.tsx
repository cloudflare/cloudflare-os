import { TemplateListing } from '@/blocks/TemplateListing'
import { templateCreator, templateNeeds, templateType, type Template } from './templates'

export type TemplateEntryProps = {
  template: Template
  /** Shows it on its own page. */
  onOpenTemplate: (template: Template) => void
  /** Its page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
}

/** One template where several are listed (`TemplateListing`), from what the backend says of it. */
export const TemplateEntry = ({ template, onOpenTemplate, templateHref }: TemplateEntryProps) => {
  const { title, description } = template.metadata
  const { noun, icon } = templateType(template)
  return (
    <TemplateListing
      title={title}
      description={description}
      kind={noun}
      icon={icon}
      creator={templateCreator(template)}
      connections={templateNeeds(template).map(({ name }) => name)}
      href={templateHref?.(template)}
      onSelect={() => onOpenTemplate(template)}
    />
  )
}
