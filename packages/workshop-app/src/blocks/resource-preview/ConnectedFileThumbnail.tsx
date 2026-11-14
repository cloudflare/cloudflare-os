import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { ThumbnailStage } from '../file-preview/ThumbnailStage'
import { ResourcePreviewView } from './ResourcePreviewView'

/** The width the file is laid out at before it is shrunk to its tile: a page in a narrow pane. */
const PAGE_WIDTH = 640

const NO_DECISIONS = new Map<number, never>()
const ignore = () => {}

/**
 * A Google Doc, Sheet or Slides deck as a tile shows it: its top, drawn as its own view draws it
 * at a page's width, then shrunk to fit the tile. A picture of it, which takes no focus or clicks.
 */
export const ConnectedFileThumbnail = ({ preview }: { preview: ResourcePreview }) => (
  <ThumbnailStage>
    {(width) => (
      <div className="size-full overflow-hidden bg-kumo-base">
        <div style={{ width: PAGE_WIDTH, height: PAGE_WIDTH, transform: `scale(${width / PAGE_WIDTH})`, transformOrigin: 'top left' }}>
          <ResourcePreviewView preview={preview} focusedChangeId={null} decided={NO_DECISIONS} onChangeClick={ignore} />
        </div>
      </div>
    )}
  </ThumbnailStage>
)
