import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BlueprintGadgetSummary } from '@gadgets/workshop-shared/api'
import type { CreateTemplateDialogProps } from '@/blocks/CreateTemplateDialog'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { madeTemplatesOf } from './madeTemplates'
import { templateStore } from './useTemplates'

type MadeTemplatesState = CreateTemplateDialogProps['existing']

/**
 * A gadget's templates. The owner's rows already arrive through the account feed; a builder
 * lists the workspace's from it when needed, after local changes, and on reconnect.
 */
export const useMadeTemplates = (workspaceId: string | undefined, workpieceId: number | undefined, paused: boolean) => {
  const { api, reconnecting } = useApi()
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const ownsWorkspace = workspace !== undefined && workspace.owner === undefined
  useEffect(() => {
    if (workspaceId !== undefined && !reconnecting) templateStore.connect(api)
  }, [api, reconnecting, workspaceId])
  const own = useSyncExternalStore(templateStore.subscribe, templateStore.getOwnSnapshot)
  // The workspace's templates as last read, of all its gadgets: which gadget's are shown is chosen on render.
  const [read, setRead] = useState<{ workspaceId: string; summaries: BlueprintGadgetSummary[] } | { workspaceId: string; failed: string }>()
  const [revision, setRevision] = useState(0)
  const canReadWorkspace = workspaces.status !== 'loading' && !ownsWorkspace && workspace?.role !== 'use'

  useEffect(() => {
    if (paused || reconnecting || !canReadWorkspace || workspaceId === undefined) return
    let current = true
    templateStore.createdFrom(workspaceId).then(
      (summaries) => {
        if (current) setRead({ workspaceId, summaries })
      },
      (error: unknown) => {
        if (!current) return
        const message = error instanceof Error ? error.message : String(error)
        setRead((was) => was?.workspaceId === workspaceId && 'summaries' in was ? was : { workspaceId, failed: message })
      },
    )
    return () => {
      current = false
    }
  }, [api, canReadWorkspace, paused, reconnecting, revision, workspaceId])

  let state: MadeTemplatesState = { status: 'loading' }
  if (ownsWorkspace && own) {
    state = { status: 'ready', templates: madeTemplatesOf(own.filter(({ source }) => source.type === 'workspace' && source.workspaceId === workspaceId && source.gadgetId === workpieceId)) }
  } else if (canReadWorkspace && read !== undefined && read.workspaceId === workspaceId) {
    state = 'summaries' in read
      ? { status: 'ready', templates: madeTemplatesOf(read.summaries.filter(({ gadgetId }) => gadgetId === workpieceId)) }
      : { status: 'failed', message: read.failed }
  }
  return {
    state,
    templates: state.status === 'ready' ? state.templates : undefined,
    refresh: () => {
      if (!ownsWorkspace) setRevision((was) => was + 1)
    },
  }
}
