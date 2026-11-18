import { useEffect, useState } from 'react'
import { publishStateOf, type PublishState } from './publishState'
import { templateStore, useTemplates } from './useTemplates'

/**
 * Where the gadget's workspace stands as a template (`publishStateOf`), read while not `paused`
 * and again once it is not, such as after publishing from a dialog. Undefined until it is read,
 * and where it could not be.
 */
export const usePublishState = (workspaceId: string, paused: boolean): PublishState | undefined => {
  // Connects the store, which whatever else shows the templates may not have yet.
  useTemplates()
  const [read, setRead] = useState<{ workspaceId: string; state: PublishState }>()

  useEffect(() => {
    if (paused) return
    let current = true
    templateStore.publishedFrom(workspaceId).then(
      (templates) => {
        if (current) setRead({ workspaceId, state: publishStateOf(templates) })
      },
      () => {
        if (current) setRead(undefined)
      },
    )
    return () => {
      current = false
    }
  }, [workspaceId, paused])

  return read?.workspaceId === workspaceId ? read.state : undefined
}
