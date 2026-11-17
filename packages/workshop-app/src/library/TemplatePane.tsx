import { useState } from 'react'
import { useConnections } from '@/connections/useConnections'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { withStar } from './libraryStars'
import { mostUsed } from './templateList'
import { TemplatePageView } from './TemplatePageView'
import { templateNeeds, templateType, type Template } from './templates'
import { UseTemplate, type MadeFromTemplate } from './UseTemplate'
import { useSharedTemplate, useTemplates } from './useTemplates'

/** How many others of its kind a template's page goes on to. */
const RELATED = 4

export type TemplatePaneProps = {
  templateId: string
  onOpenTemplate: (template: Template) => void
  /** A template's page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
  /** Goes back to the templates. */
  onBack: () => void
  /** Something was made from it: show it. */
  onMade: (made: MadeFromTemplate) => void
}

/**
 * One template's page (`TemplatePageView`) over what it shows: the template, whether it is
 * starred, which of the services it needs the user has connected, and the most used others of its
 * kind. One that is not listed, as one whose link was shared, is read on its own. Use template sets
 * up what it needs and makes it (`UseTemplate`).
 */
export const TemplatePane = ({ templateId, onOpenTemplate, templateHref, onBack, onMade }: TemplatePaneProps) => {
  const { state, setStars } = useTemplates()
  const { state: connections } = useConnections()
  const connection = useConnectionNotice()
  const [using, setUsing] = useState(false)
  const templates = state.status === 'ready' ? state.templates : []
  const stars = state.status === 'ready' ? state.stars : []
  const listed = templates.find(({ id }) => id === templateId)
  const shared = useSharedTemplate(templateId, state.status === 'ready' && !listed)
  const template = listed ?? (shared.status === 'ready' ? shared.info : undefined)
  useDocumentTitle(template?.metadata.title ?? 'Template')

  // A service is connected where the user has an account of it that can be used.
  const connected = connections.status === 'ready' && template
    ? new Set(templateNeeds(template).filter(({ vendorId }) => connections.connections.some((each) => each.vendorId === vendorId && each.kind === 'account' && each.account.credentialsValid)).map(({ key }) => key))
    : undefined
  // Until there is one, or it is known there is none.
  const status = template || shared.status === 'gone'
    ? undefined
    : state.status === 'failed' ? { failed: state.message } : shared.status === 'failed' ? { failed: shared.message } : { loading: true as const }

  return (
    <>
      <TemplatePageView
        template={template}
        status={status}
        starred={stars.includes(templateId)}
        onStarredChange={(on) => {
          if (!connection?.blocked()) setStars(withStar(stars, templateId, on))
        }}
        onUse={() => {
          if (!connection?.blocked()) setUsing(true)
        }}
        connected={connected}
        related={template ? mostUsed(templates).filter((other) => other.id !== template.id && templateType(other).id === templateType(template).id).slice(0, RELATED) : []}
        onOpenTemplate={onOpenTemplate}
        templateHref={templateHref}
        onBack={onBack}
      />
      {template && <UseTemplate template={template} open={using} onOpenChange={setUsing} onMade={onMade} />}
    </>
  )
}
