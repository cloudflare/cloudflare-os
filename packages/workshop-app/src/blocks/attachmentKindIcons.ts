import {
  Doc01Icon, FileAudioIcon, FileCodeIcon, FileEmpty02Icon, FileImageIcon, FileTextIcon, FileVideoIcon,
  Pdf01Icon, Ppt01Icon, Xls01Icon, Zip01Icon, type Icon,
} from '@/components/icons'
import type { AttachmentKind } from '@/files/attachmentKind'

/** The glyph shown for a file that has no picture of its own. */
export const ATTACHMENT_KIND_ICONS: Record<AttachmentKind, Icon> = {
  image: FileImageIcon,
  pdf: Pdf01Icon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  spreadsheet: Xls01Icon,
  document: Doc01Icon,
  presentation: Ppt01Icon,
  archive: Zip01Icon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileEmpty02Icon,
}
