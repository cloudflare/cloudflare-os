import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedFileKind } from '@/files/connectedFile'
import { loadingPreview } from './resource-preview/loadingPreview'
import { ResourcePreviewView } from './resource-preview/ResourcePreviewView'

export type ConnectedFileViewProps = {
  /** The file as drawn; absent while it is on its way. */
  preview?: ResourcePreview
  /** What it is, so that a blank one can stand in for it while it loads. */
  kind: ConnectedFileKind
}

// Shown as it is: nothing is decided here, so nothing is drawn as decided.
const NO_DECISIONS = new Map<number, never>()
const ignore = () => {}

const changes = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`

/**
 * A Google Doc, Sheet or Slides deck, drawn in its own look as it will be once the changes waiting
 * on someone are made, and read only: it is edited in its own editor. While it loads a blank one
 * of its kind stands where it will be, so nothing moves when it arrives. Changes waiting are
 * marked where they land, and counted in a pill over its foot.
 */
export const ConnectedFileView = ({ preview, kind }: ConnectedFileViewProps) => {
  const waiting = preview?.actions.filter((id) => id >= 0).length ?? 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResourcePreviewView
        preview={preview ?? loadingPreview(kind)}
        loading={!preview}
        focusedChangeId={null}
        decided={NO_DECISIONS}
        onChangeClick={ignore}
        overlay={waiting > 0 ? (
          <p className="pointer-events-auto mx-auto w-fit rounded-full bg-kumo-base px-3 py-1.5 text-sm text-kumo-subtle ring-1 ring-kumo-line shadow-[0_2px_6px_rgb(0_0_0/0.03)]">
            Shows {changes(waiting)} waiting for review
          </p>
        ) : undefined}
      />
    </div>
  )
}
