import { attachmentKind } from '@/files/attachmentKind'
import { AttachmentKindIcon } from '@/blocks/AttachmentKindIcon'
import { FormatIcon } from '@/components/FormatIcon'
import { GoogleFileIcon } from '@/components/GoogleFileIcon'
import { KindMark } from '@/components/KindMark'
import type { AsideItem } from './asideItems'

/** What kind of thing an item is, as a mark (`KindMark`): the output's format, the file's kind, or a Google file's own icon. */
export const asideItemIcon = (item: AsideItem) => {
  if (item.kind === 'output') {
    return item.output.type === 'worktree' ? <KindMark name="branch" /> : <FormatIcon name={item.output.format?.icon} />
  }
  if (item.kind === 'connected') {
    const { fileKind } = item.connected
    if (fileKind) return <GoogleFileIcon kind={fileKind} />
    return <AttachmentKindIcon kind="file" />
  }
  return <AttachmentKindIcon kind={attachmentKind({ name: item.file.name, type: item.file.mimeType })} />
}
