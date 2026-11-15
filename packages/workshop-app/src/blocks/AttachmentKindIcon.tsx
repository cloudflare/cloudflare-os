import type { AttachmentKind } from '@/files/attachmentKind'
import { KindMark, type KindMarkName } from '@/components/KindMark'

const MARKS: Record<AttachmentKind, KindMarkName> = {
  image: 'image',
  pdf: 'pdf',
  audio: 'audio',
  video: 'video',
  spreadsheet: 'sheetFile',
  document: 'documentFile',
  presentation: 'slidesFile',
  archive: 'archive',
  code: 'code',
  text: 'text',
  file: 'file',
}

/** The mark shown for a file that has no picture of its own: a page, with what kind of file it is on it. */
export const AttachmentKindIcon = ({ kind, className }: { kind: AttachmentKind; className?: string }) => (
  <KindMark name={MARKS[kind]} className={className} />
)
