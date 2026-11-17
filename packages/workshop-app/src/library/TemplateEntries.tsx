import { TemplateEntry, type TemplateEntryProps } from './TemplateEntry'
import type { Template } from './templates'

export type TemplateEntriesProps = Omit<TemplateEntryProps, 'template'> & { templates: Template[] }

/**
 * A few templates on a shelf, two to a line, and one where two would be too narrow, as
 * `CardGrid`'s wide cards are, each as tall as the other on its line.
 */
export const TemplateEntries = ({ templates, ...entry }: TemplateEntriesProps) => (
  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,max(20rem,calc(50%-0.375rem))),1fr))] gap-3">
    {templates.map((template) => (
      <div key={template.id} className="flex min-w-0 flex-col *:flex-1">
        <TemplateEntry template={template} {...entry} />
      </div>
    ))}
  </div>
)
