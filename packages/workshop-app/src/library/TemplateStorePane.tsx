import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { ownApps } from './libraryList'
import { templateList } from './templateList'
import type { Template } from './templates'
import { DISCOVER_TAB, TemplateStoreView } from './TemplateStoreView'
import { useLibrary } from './useLibrary'
import { useTemplates } from './useTemplates'

export type TemplateStorePaneProps = {
  /** The tab that is showing; the front when none is said. */
  tab?: string
  onTabChange: (tab: string) => void
  onOpenTemplate: (template: Template) => void
  /** A template's page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
  /** Goes back to the library. */
  onBack: () => void
}

/**
 * The templates' page (`TemplateStoreView`) over what it shows: the templates there are, which
 * are examples for now, their stars, which last for the visit, and how they are listed; and the
 * user's apps, which Publish lists.
 */
export const TemplateStorePane = ({ tab = DISCOVER_TAB, onTabChange, onOpenTemplate, templateHref, onBack }: TemplateStorePaneProps) => {
  const { templates, stars, setStars } = useTemplates()
  const list = useListView('templates', templateList(templates, new Set(stars)))
  const library = useLibrary()
  useDocumentTitle('Templates')

  return (
    <TemplateStoreView
      tab={tab}
      onTabChange={onTabChange}
      templates={templates}
      list={list}
      stars={stars}
      onStarsChange={setStars}
      onOpenTemplate={onOpenTemplate}
      templateHref={templateHref}
      onBack={onBack}
      apps={library.status === 'ready' ? ownApps(library.outputs) : library.status === 'failed' ? [] : undefined}
    />
  )
}
