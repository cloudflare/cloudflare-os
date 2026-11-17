import { useState } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ownApps } from './libraryList'
import { templateList } from './templateList'
import type { Template } from './templates'
import { DISCOVER_TAB, TemplateStoreView } from './TemplateStoreView'
import { useLibrary } from './useLibrary'
import { templateStore, useTemplates } from './useTemplates'

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const NONE: Template[] = []

/**
 * The templates' page (`TemplateStoreView`) over what it shows: the templates there are (the
 * deployment's featured blueprints, the user's saved ones and what they published), their stars,
 * which are the backend's, and how they are listed; and the user's apps, which Publish lists and
 * publishes, going on to the template it made.
 */
export const TemplateStorePane = ({ tab = DISCOVER_TAB, onTabChange, onOpenTemplate, templateHref, onBack }: TemplateStorePaneProps) => {
  const { state, setStars, reload } = useTemplates()
  const templates = state.status === 'ready' ? state.templates : NONE
  const stars = state.status === 'ready' ? state.stars : []
  const list = useListView('templates', templateList(templates, new Set(stars)))
  const library = useLibrary()
  const connection = useConnectionNotice()
  const [problem, setProblem] = useState<string>()
  useDocumentTitle('Templates')

  const publish = (app: OutputSummary) => {
    if (connection?.blocked()) return
    setProblem(undefined)
    templateStore.publish(app).then(
      (id) => {
        const made = templateStore.getSnapshot()
        const template = made.status === 'ready' ? made.templates.find((each) => each.id === id) : undefined
        if (template) onOpenTemplate(template)
      },
      (error: unknown) => setProblem(`Couldn’t publish ${app.title}: ${messageOf(error)}`),
    )
  }

  return (
    <TemplateStoreView
      tab={tab}
      onTabChange={onTabChange}
      templates={templates}
      status={state.status === 'loading' ? { loading: true } : state.status === 'failed' ? { failed: state.message, onRetry: () => void reload() } : undefined}
      problem={problem}
      list={list}
      stars={stars}
      onStarsChange={(next) => {
        if (!connection?.blocked()) setStars(next)
      }}
      onOpenTemplate={onOpenTemplate}
      templateHref={templateHref}
      onBack={onBack}
      apps={library.status === 'ready' ? ownApps(library.outputs) : library.status === 'failed' ? [] : undefined}
      onPublish={publish}
    />
  )
}
