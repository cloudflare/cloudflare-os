import { useEffect, useState } from 'react'
import type { GadgetUpstream } from '@gadgets/workshop-shared/api'
import type { SetupModel } from '@/blocks/UseTemplateDialog'
import { UpdateFromTemplateDialog } from '@/blocks/UpdateFromTemplateDialog'
import { useDefaultModel } from '@/chat/useDefaultModel'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { proposeTemplateUpdate, templateUpdateStatus } from './templateUpdate'
import type { BlueprintInfo } from './useGadgetSettings'

export type UpdateFromTemplateProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  gadgetId: number
  /** The gadget's title. */
  title: string
  /** What it follows, which names the template. */
  upstream: GadgetUpstream & { blueprintId: string }
  /** The template as it now stands: undefined while it is read, null once it is not there. */
  template?: BlueprintInfo | null
  /** The update was proposed in a new chat, which is where it is tried and accepted: go there. */
  onProposed: (chatId: number) => void
}

/** The user's models, read while `open`; undefined until they are, and none where they cannot be. */
const useReviewers = (open: boolean) => {
  const { api, reconnecting } = useApi()
  const [models, setModels] = useState<SetupModel[]>()
  useEffect(() => {
    if (!open || reconnecting) return
    let current = true
    api.listModels().then(
      (listed) => {
        if (current) setModels(listed.map(({ id, name }) => ({ id, name })))
      },
      // Then there is only No agent, which still updates it.
      () => {
        if (current) setModels([])
      },
    )
    return () => {
      current = false
    }
  }, [api, reconnecting, open])
  return models
}

/**
 * Updates a gadget from the template it follows (`UpdateFromTemplateDialog`): the update is
 * proposed in a new chat (`proposeTemplateUpdate`), reviewed by the model the user's messages are
 * answered by unless another, or none, is chosen, and the chat is gone to once it is there.
 */
export const UpdateFromTemplate = ({ open, onOpenChange, workspaceId, gadgetId, title, upstream, template, onProposed }: UpdateFromTemplateProps) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const models = useReviewers(open)
  const preferred = useDefaultModel()
  // Wrapped, so that No agent (null) is told from nothing chosen.
  const [chosen, setChosen] = useState<{ id: string | null }>()
  const reviewer = chosen ? chosen.id
    : preferred.status === 'ready' ? preferred.id
      : preferred.status === 'loading' ? undefined : null

  return (
    <UpdateFromTemplateDialog
      open={open}
      onOpenChange={onOpenChange}
      gadget={title}
      template={template && { ...template, status: templateUpdateStatus(upstream, template) }}
      models={models}
      reviewer={reviewer}
      onReviewerChange={(id) => setChosen({ id })}
      onUpdate={async (allowUnrelated) => {
        if (connection?.blocked() || reviewer === undefined) return { outcome: 'blocked' }
        const result = await proposeTemplateUpdate(() => api.openWorkspace(workspaceId), gadgetId, upstream.blueprintId, { reviewer, allowUnrelated })
        if (result.outcome === 'proposed') {
          onOpenChange(false)
          onProposed(result.chatId)
        }
        return result
      }}
    />
  )
}
