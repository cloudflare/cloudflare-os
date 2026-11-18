import { useEffect, useState } from 'react'
import type { MadeTemplate } from '@/blocks/CreateTemplateDialog'
import { madeTemplatesOf } from './madeTemplates'
import { templateStore, useTemplates } from './useTemplates'

/**
 * The templates made from a workspace's gadgets, read while not `paused` and again once it is not,
 * such as after creating one from a dialog, again when `refresh` says something changed, and again
 * whenever the templates are read anew (`TemplateStore`, which every create, release, edit and
 * delete does), so that what one place does is seen by every other that shows them, such as a
 * template deleted from its own page. Undefined until they are read, where they could not be,
 * and given no workspace.
 */
export const useMadeTemplates = (workspaceId: string | undefined, paused: boolean): { templates: MadeTemplate[] | undefined; refresh: () => void } => {
  // Connects the store, which whatever else shows the templates may not have yet, and says when they are read anew.
  const { state } = useTemplates()
  const [read, setRead] = useState<{ workspaceId: string; templates: MadeTemplate[] }>()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (paused || workspaceId === undefined) return
    let current = true
    templateStore.createdFrom(workspaceId).then(
      (summaries) => {
        if (current) setRead({ workspaceId, templates: madeTemplatesOf(summaries) })
      },
      () => {
        if (current) setRead(undefined)
      },
    )
    return () => {
      current = false
    }
  }, [workspaceId, paused, version, state])

  return { templates: read && read.workspaceId === workspaceId ? read.templates : undefined, refresh: () => setVersion((was) => was + 1) }
}
