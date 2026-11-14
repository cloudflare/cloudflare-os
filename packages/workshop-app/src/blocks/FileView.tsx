import { FileIcon, MusicNotesIcon } from '@phosphor-icons/react'
import { Markdown } from '@/components/Markdown'
import { PaneNotice } from './PaneNotice'

export type FileViewProps = {
  /** The file's name, which also names what is shown for assistive technology. */
  name: string
  /** What else is known of it, such as its type and size, for when it is not shown. */
  details?: string
  onDownload: () => void
} & (
  /** Shown by the browser from `url`, which holds the file's bytes. */
  | { kind: 'image' | 'pdf' | 'audio' | 'video'; url: string }
  | { kind: 'markdown' | 'text'; text: string }
  /** Not something that can be shown here. */
  | { kind: 'none' }
)

/** A file, shown as what it is: an image, a PDF, a recording, a video, a document, text. */
export const FileView = (props: FileViewProps) => {
  const { name, details, onDownload } = props
  switch (props.kind) {
    case 'image':
      return (
        <div className="appears flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img src={props.url} alt={name} className="max-h-full max-w-full rounded-xl object-contain" />
        </div>
      )
    case 'pdf':
      // The browser's own viewer, which a sandboxed frame would not have.
      return <iframe src={props.url} title={name} className="appears block min-h-0 w-full flex-1 border-0" />
    case 'audio':
      return (
        <div className="appears flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <span className="grid size-12 place-items-center rounded-2xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
            <MusicNotesIcon aria-hidden="true" className="size-6" />
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
    case 'none':
      return (
        <PaneNotice
          icon={FileIcon}
          title="This file can’t be shown here"
          description={details}
          action={{ label: 'Download', onClick: onDownload }}
        />
      )
  }
}
