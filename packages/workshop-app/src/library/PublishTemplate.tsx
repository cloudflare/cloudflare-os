import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { PublishTemplateDialog, type PublishTemplateDialogProps } from '@/blocks/PublishTemplateDialog'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { PublishedGadget } from './TemplateStore'
import { templateStore, useTemplates } from './useTemplates'

export type PublishTemplateProps = {
  /** The gadget to publish. */
  gadget: PublishedGadget
  open: boolean
  onOpenChange: (open: boolean) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Publishing a gadget as a template (`PublishTemplateDialog`) over the templates (`TemplateStore`):
 * those its workspace has published, read each time it opens, and publishing, which the
 * templates are read again after, so that the store and the template's page have it.
 */
export const PublishTemplate = ({ gadget, open, onOpenChange }: PublishTemplateProps) => {
  // Connects the store, which whatever else shows the templates may not have yet.
  useTemplates()
  const router = useRouter()
  const connection = useConnectionNotice()
  const [published, setPublished] = useState<PublishTemplateDialogProps['published']>({ status: 'loading' })
  const { workspaceId } = gadget

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPublished({ status: 'loading' })
    templateStore.publishedFrom(workspaceId).then(
      (summaries) => {
        if (!cancelled) setPublished({ status: 'ready', templates: summaries.map(({ id, title, version, unpublishedChanges }) => ({ id, title, version, ...(unpublishedChanges ? { changes: true } : {}) })) })
      },
      (error: unknown) => {
        if (!cancelled) setPublished({ status: 'failed', message: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, workspaceId])

  // Asked for by the user: not tried over a lost connection, which says so itself.
  const blocked = () => {
    if (connection?.blocked()) throw new Error('The Workshop is reconnecting.')
  }

  return (
    <PublishTemplateDialog
      // Keyed, so that what was typed for one gadget, or one opening, is not carried to the next.
      key={`${workspaceId}/${gadget.workpieceId}`}
      open={open}
      onOpenChange={onOpenChange}
      title={gadget.title}
      published={published}
      onPublish={async ({ title, description }) => {
        blocked()
        return templateStore.publish(gadget, { title, description })
      }}
      onPublishChanges={async (id) => {
        blocked()
        await templateStore.publishChanges(workspaceId, id)
      }}
      onViewTemplate={(templateId) => {
        onOpenChange(false)
        void router.navigate({ to: '/library/templates/$templateId', params: { templateId } })
      }}
      templateHref={(templateId) => router.buildLocation({ to: '/library/templates/$templateId', params: { templateId } }).href}
    />
  )
}
