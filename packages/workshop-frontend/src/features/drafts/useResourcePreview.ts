import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { rpcFailureDescription } from '../../rpcErrors'

/** Where a file's preview stands. `refreshing` keeps the last one shown while a newer one loads. */
export type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: ResourcePreview; refreshing: boolean }
  | { status: 'none' }
  | { status: 'failed'; message: string; refreshing: boolean }

/**
 * The file `subjectId` of connection `gatekeeperId`, drawn as it will be once its waiting changes
 * are made (see Overseer.previewResource). Drawn again whenever `version` changes -- the set of
 * waiting changes, say -- keeping the previous drawing up until the new one arrives so a decision
 * never blanks the page; a null `version` draws nothing. `retry` draws it again on demand.
 */
export const useResourcePreview = (
  overseer: RpcStub<Overseer>,
  gatekeeperId: WorkpieceId,
  /** Null for a file not yet created: its connection holds only that one. */
  subjectId: string | null,
  version: string | null,
) => {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState({ gatekeeperId, subjectId })
  // Another file starts over rather than showing the last one's page while this one loads.
  if (shown.gatekeeperId !== gatekeeperId || shown.subjectId !== subjectId) {
    setShown({ gatekeeperId, subjectId })
    setState({ status: 'loading' })
  }

  useEffect(() => {
    if (version === null) return
    let live = true
    setState(previous => previous.status === 'ready' || previous.status === 'failed'
      ? { ...previous, refreshing: true }
      : previous)
    overseer.previewResource(gatekeeperId, subjectId ?? undefined).then(preview => {
      if (!live) return
      setState(preview ? { status: 'ready', preview, refreshing: false } : { status: 'none' })
    }, (error: unknown) => {
      if (!live) return
      console.error('Failed to draw file preview:', error)
      setState({
        status: 'failed',
        message: rpcFailureDescription(error) ?? 'Check your connection and try again.',
        refreshing: false,
      })
    })
    return () => { live = false }
  }, [overseer, gatekeeperId, subjectId, version, attempt])

  return { state: version === null ? { status: 'none' } as const : state, retry: () => setAttempt(n => n + 1) }
}
