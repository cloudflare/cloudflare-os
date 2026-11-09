import { AppPreviewPane, type PreviewApp } from './AppPreviewPane'
import { FilePreviewPane, type PreviewFile } from './FilePreviewPane'

/** What a list opens beside itself: a file, or an app, live. */
export type LibraryPreview = { kind: 'file'; file: PreviewFile } | { kind: 'app'; app: PreviewApp }

/** The pane beside a list of apps and files, showing whichever was opened. */
export function LibraryPreviewPane({ preview, ...pane }: {
  preview: LibraryPreview
  onClose: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  return preview.kind === 'app'
    ? <AppPreviewPane app={preview.app} {...pane} />
    : <FilePreviewPane file={preview.file} {...pane} />
}
