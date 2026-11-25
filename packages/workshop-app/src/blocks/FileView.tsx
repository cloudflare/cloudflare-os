import { AlertCircleIcon, FileEmpty02Icon, MusicNote03Icon } from '@/components/icons'
import { Markdown } from '@gadgets/ui'
import { DrawnPreview, type DrawnPreviewKind } from './file-preview/DrawnPreview'
import { PaneNotice } from './PaneNotice'

export type FileViewProps = {
  /** The file's name, which also names what is shown for assistive technology. */
  name: string
  /** What else is known of it, such as its type and size, for when it is not shown. */
  details?: string
  onDownload: () => void
} & (
  /** Shown by the browser from `url`, which holds the file's bytes. */
  | { kind: 'image' | 'audio' | 'video'; url: string }
  | { kind: 'markdown' | 'text'; text: string }
  /** A PDF, Word document, PowerPoint deck, Excel workbook or CSV, drawn here from its bytes. */
  | { kind: DrawnPreviewKind; bytes: Uint8Array; mimeType: string }
  /** Not something that can be shown here. */
  | { kind: 'none' }
)

/** A file, shown as what it is: an image, a PDF, a recording, a video, a document, a deck, a sheet, text. */
export const FileView = (props: FileViewProps) => {
  const { name, details, onDownload } = props
  switch (props.kind) {
    case 'image':
      return (
        <div className="appears flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img src={props.url} alt={name} className="max-h-full max-w-full rounded-xl object-contain" />
        </div>
      )
    case 'audio':
      return (
        <div className="appears flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <span className="grid size-12 place-items-center rounded-2xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
            <MusicNote03Icon aria-hidden="true" className="size-6" />
          </span>
          <audio controls src={props.url} aria-label={name} className="w-full max-w-md" />
        </div>
      )
    case 'video':
      return (
        <div className="appears flex min-h-0 flex-1 items-center justify-center p-6">
          <video controls src={props.url} aria-label={name} className="max-h-full max-w-full rounded-xl" />
        </div>
      )
    case 'markdown':
      return (
        <div className="appears min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-8 text-base text-kumo-default">
            <Markdown>{props.text}</Markdown>
          </div>
        </div>
      )
    case 'text':
      return (
        <div className="appears min-h-0 flex-1 overflow-auto">
          <pre className="p-6 font-mono text-sm/6 break-words whitespace-pre-wrap text-kumo-default">{props.text}</pre>
        </div>
      )
    case 'pdf':
    case 'document':
    case 'slides':
    case 'workbook':
    case 'delimited':
      return (
        <div className="appears min-h-0 flex-1 overflow-auto">
          <DrawnPreview
            kind={props.kind}
            name={name}
            mimeType={props.mimeType}
            bytes={props.bytes}
            loading={<PaneNotice title="Loading…" />}
            failed={(message) => <PaneNotice onTint icon={AlertCircleIcon} title={`Couldn’t show ${name}`} description={message} action={{ label: 'Download', onClick: onDownload }} />}
          />
        </div>
      )
    case 'none':
      return (
        <PaneNotice
          onTint
          icon={FileEmpty02Icon}
          title="This file can’t be shown here"
          description={details}
          action={{ label: 'Download', onClick: onDownload }}
        />
      )
  }
}
