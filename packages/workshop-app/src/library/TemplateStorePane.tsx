import { useState } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { templatable } from './libraryEdits'
import { outputKey, outputTitle } from './libraryList'
import { CreateTemplate } from './CreateTemplate'
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

const NONE: Template[] = []

/**
 * The templates' page (`TemplateStoreView`) over what it shows: the templates there are (the
 * deployment's featured blueprints, the user's saved ones and what they created), their stars,
 * which are the backend's, and how they are listed; and the user's gadgets, which Create template
 * lists, the one chosen made into a template as a gadget's own More menu does (`CreateTemplate`).
 */
export const TemplateStorePane = ({ tab = DISCOVER_TAB, onTabChange, onOpenTemplate, templateHref, onBack }: TemplateStorePaneProps) => {
  const { state, setStars, reload } = useTemplates()
  const templates = state.status === 'ready' ? state.templates : NONE
  const stars = state.status === 'ready' ? state.stars : []
  const list = useListView('templates', templateList(templates, new Set(stars)))
  const library = useLibrary()
  const connection = useConnectionNotice()
  // The gadget chosen to make a template from, kept while its dialog closes.
  const [creating, setCreating] = useState<{ app: OutputSummary; open: boolean }>()
  useDocumentTitle('Templates')

  return (
    <>
    <TemplateStoreView
      tab={tab}
      onTabChange={onTabChange}
      templates={templates}
      status={state.status === 'loading' ? { loading: true } : state.status === 'failed' ? { failed: state.message, onRetry: () => void reload() } : undefined}
      list={list}
      stars={stars}
      onStarsChange={(next) => {
        if (!connection?.blocked()) setStars(next)
      }}
      onOpenTemplate={onOpenTemplate}
      templateHref={templateHref}
      onBack={onBack}
      apps={library.status === 'ready' ? templatable(library.outputs) : library.status === 'failed' ? [] : undefined}
      onCreateTemplate={(app) => setCreating({ app, open: true })}
    />
    {creating && (
      <CreateTemplate
        key={outputKey(creating.app)}
        gadget={{ workspaceId: creating.app.workspaceId, workpieceId: creating.app.workpieceId, title: outputTitle(creating.app) }}
        open={creating.open}
        onOpenChange={(open) => setCreating((current) => current && { ...current, open })}
      />
    )}
    </>
  )
}
