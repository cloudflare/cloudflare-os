import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { CreateTemplateDialog, type CreateTemplateDialogProps } from '@/blocks/CreateTemplateDialog'
import { TemplateCard } from '@/blocks/TemplateCard'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { madeTemplatesOf } from './madeTemplates'
import type { TemplateSource } from './TemplateStore'
import { withStar } from './libraryStars'
import { templateCreator, templateServices, templateType } from './templates'
import { templateStore, useTemplates } from './useTemplates'

export type CreateTemplateProps = {
  /** The gadget to make a template from. */
  gadget: TemplateSource
  open: boolean
  onOpenChange: (open: boolean) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Creating a template from a gadget (`CreateTemplateDialog`) over the templates (`TemplateStore`):
 * those its workspace has made, read each time it opens, and creating or releasing, which the
 * templates are read again after, so that the store and the template's page have it.
 */
export const CreateTemplate = ({ gadget, open, onOpenChange }: CreateTemplateProps) => {
  // Connects the store, which whatever else shows the templates may not have yet; what it has read of them is what a template just made is shown from.
  const { state, setStars } = useTemplates()
  const router = useRouter()
  const connection = useConnectionNotice()
  const [existing, setExisting] = useState<CreateTemplateDialogProps['existing']>({ status: 'loading' })
  const { workspaceId } = gadget

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setExisting({ status: 'loading' })
    templateStore.createdFrom(workspaceId).then(
      (summaries) => {
        if (!cancelled) setExisting({ status: 'ready', templates: madeTemplatesOf(summaries) })
      },
      (error: unknown) => {
        if (!cancelled) setExisting({ status: 'failed', message: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, workspaceId])

  const href = (templateId: string) => router.buildLocation({ to: '/library/templates/$templateId', params: { templateId } }).href
  const view = (templateId: string) => {
    onOpenChange(false)
    void router.navigate({ to: '/library/templates/$templateId', params: { templateId } })
  }

  // Asked for by the user: not tried over a lost connection, which says so itself.
  const blocked = () => {
    if (connection?.blocked()) throw new Error('The Workshop is reconnecting.')
  }

  return (
    <CreateTemplateDialog
      // Keyed, so that what was typed for one gadget, or one opening, is not carried to the next.
      key={`${workspaceId}/${gadget.workpieceId}`}
      open={open}
      onOpenChange={onOpenChange}
      title={gadget.title}
      existing={existing}
      onCreate={async ({ title, description }) => {
        blocked()
        return templateStore.create(gadget, { title, description })
      }}
      onRelease={async (id) => {
        blocked()
        await templateStore.release(workspaceId, id)
      }}
      onViewTemplate={view}
      renderTemplate={(templateId) => {
        const made = state.status === 'ready' ? state.templates.find(({ id }) => id === templateId) : undefined
        if (!made || state.status !== 'ready') return undefined
        const { title, description } = made.metadata
        const { noun, icon } = templateType(made)
        return (
          // As wide as the Templates page's cards are, in the middle.
          <div className="mx-auto flex w-60 max-w-full flex-col">
            <TemplateCard
              title={title}
              description={description}
              kind={noun}
              icon={icon}
              creator={templateCreator(made)}
              connections={templateServices(made).map(({ name }) => name)}
              previewUrl={made.screenshotUrl}
              starred={state.stars.includes(templateId)}
              onStarredChange={(on) => setStars(withStar(state.stars, templateId, on))}
              href={href(templateId)}
              onSelect={() => view(templateId)}
            />
          </div>
        )
      }}
      templateHref={href}
    />
  )
}
