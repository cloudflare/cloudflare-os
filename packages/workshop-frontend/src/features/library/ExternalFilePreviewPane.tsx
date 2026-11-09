import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { PaneHeader } from '../chat-page/ChatPageChrome'
import { DraftFileIcon } from '../drafts/DraftFileIcon'
import { changeCount, OPEN_LABEL } from '../drafts/drafts'
import { useResourcePreview } from '../drafts/useResourcePreview'
import { loadingPreview } from '../resource-preview/loadingPreview'
import { ResourcePreviewView } from '../resource-preview/ResourcePreviewView'
import type { ExternalFileSource } from './externalFiles'

const NO_DECISIONS = new Map()

/**
 * A file in a connected service opened beside the Library: drawn live through the connection the
 * workspace reaches it by, with a link to its editor. A file the connection can't draw -- one a
 * whole-Drive connection reaches, say -- offers only the link.
 */
export function ExternalFilePreviewPane({ file, onClose, expanded, onExpandedChange }: {
  file: ExternalFileSource
  onClose: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  // Wrapped: a stub in state would be taken for an updater function.
  const [workspace, setWorkspace] = useState<{ overseer: RpcStub<Overseer> } | null>(null)
  useEffect(() => {
    const overseer = authenticatedApi.openWorkspace(file.workspaceId)
    setWorkspace({ overseer })
    return () => overseer[Symbol.dispose]()
  }, [authenticatedApi, file.workspaceId])

  return (
    <>
      <PaneHeader
        glyph={<DraftFileIcon kind={file.kind} size={14} />}
        title={file.title}
        actions={(
          <a href={file.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-medium leading-4 text-kumo-default ring-1 ring-inset ring-kumo-line transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
            {OPEN_LABEL[file.kind]} ↗
          </a>
        )}
        onExpand={() => onExpandedChange(!expanded)}
        expandLabel={expanded ? 'Exit full screen' : 'Full screen'}
        onClose={onClose}
        closeLabel="Close preview"
      />
      <div className="relative min-h-0 flex-1">
        {workspace && <LiveFile key={`${file.workspaceId}:${file.gatekeeperId}:${file.subjectId}`} overseer={workspace.overseer} file={file} />}
      </div>
    </>
  )
}

const LiveFile = ({ overseer, file }: { overseer: RpcStub<Overseer>; file: ExternalFileSource }) => {
  const { state, retry } = useResourcePreview(overseer, file.gatekeeperId, file.subjectId, 'library')
  const drawable = file.kind === 'document' || file.kind === 'spreadsheet' || file.kind === 'presentation'

  if (state.status === 'ready' || (state.status === 'loading' && drawable)) {
    const preview = state.status === 'ready' ? state.preview
      : loadingPreview(file.kind as 'document' | 'spreadsheet' | 'presentation')
    const waiting = state.status === 'ready' ? state.preview.actions.filter(id => id !== -1).length : 0
    return (
      <ResourcePreviewView
        preview={preview}
        loading={state.status === 'loading'}
        focusedChangeId={null}
        decided={NO_DECISIONS}
        onChangeClick={() => {}}
        overlay={waiting === 0 ? undefined : (
          <div className="pointer-events-auto mx-auto w-fit rounded-full bg-kumo-base px-3 py-1.5 text-[12px] text-kumo-subtle shadow-sm ring-1 ring-kumo-line">
            Shows {changeCount(waiting)} waiting for review
          </div>
        )}
      />
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
      <DraftFileIcon kind={file.kind} size={32} />
      <p className="max-w-xs text-[13px] text-kumo-subtle">
        {state.status === 'failed'
          ? `${file.title} couldn't be loaded. ${state.message}`
          : `${file.title} can't be shown here.`}
      </p>
      <div className="flex gap-2">
        {state.status === 'failed' && (
          <button type="button" onClick={retry}
            className="inline-flex h-[34px] cursor-pointer items-center rounded-full px-3 text-[13px] font-medium text-kumo-default ring-1 ring-inset ring-kumo-line hover:bg-kumo-tint">
            Try again
          </button>
        )}
        <a href={file.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-[34px] items-center rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85">
          {OPEN_LABEL[file.kind]} ↗
        </a>
      </div>
    </div>
  )
}
