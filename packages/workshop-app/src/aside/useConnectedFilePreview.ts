import { useEffect, useState } from 'react'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { useApi } from '@/rpc/ApiContext'
import type { AsideConnectedFile } from './asideItems'

export type ConnectedFileState =
  | { status: 'loading' }
  /** `refreshing` while it is read again, as after a change to it was decided. */
  | { status: 'ready'; preview: ResourcePreview; refreshing?: boolean }
  /** The connection draws no picture of it, such as one reached through a whole drive. */
  | { status: 'none' }
  | { status: 'failed'; message: string; retry: () => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A connected file, drawn as it is through the connection its workspace reaches it by
 * (`Overseer.previewResource`), with any changes still waiting on someone drawn in. Asked once
 * for each file, and again when asked to after a failure, or when `version` changes, such as the
 * changes waiting on it: it is shown as it was meanwhile. Nothing, for no file. Showing another
 * starts over, rather than showing the last one's page while it loads.
 */
export const useConnectedFilePreview = (file: AsideConnectedFile | undefined, version = ''): ConnectedFileState => {
  const { api, reconnecting } = useApi()
  const key = file && `${file.workspaceId}/${file.gatekeeperId}/${file.subjectId}`
  const [drawn, setDrawn] = useState<{ key: string; state: ConnectedFileState }>()
  // Bumped to ask again after a failure.
  const [attempt, setAttempt] = useState(0)
  const workspaceId = file?.workspaceId
  const gatekeeperId = file?.gatekeeperId
  const subjectId = file?.subjectId

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (!key || reconnecting || workspaceId === undefined || gatekeeperId === undefined) return
    let cancelled = false
    setDrawn((current) => (current?.key === key && current.state.status === 'ready' ? { key, state: { ...current.state, refreshing: true } } : current))
    const overseer = api.openWorkspace(workspaceId)
    overseer.previewResource(gatekeeperId, subjectId).then(
      (preview) => {
        if (!cancelled) setDrawn({ key, state: preview ? { status: 'ready', preview } : { status: 'none' } })
      },
      (error: unknown) => {
        if (cancelled) return
        const retry = () => {
          setDrawn(undefined)
          setAttempt((current) => current + 1)
        }
        setDrawn({ key, state: { status: 'failed', message: messageOf(error), retry } })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, key, workspaceId, gatekeeperId, subjectId, attempt, version])

  return drawn?.key === key && drawn ? drawn.state : { status: 'loading' }
}
