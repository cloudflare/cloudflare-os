import { GitBranchIcon } from '@phosphor-icons/react'
import { attachmentKind } from '@/files/attachmentKind'
import { ATTACHMENT_KIND_ICONS } from '@/blocks/attachmentKindIcons'
import { FormatIcon } from '@/components/FormatIcon'
import type { AsideItem } from './asideItems'

/** What kind of thing an item is, as an icon: the output's format, or the file's kind. */
export const asideItemIcon = (item: AsideItem) => {
  if (item.kind === 'output') {
    return item.output.type === 'worktree' ? <GitBranchIcon aria-hidden="true" /> : <FormatIcon name={item.output.format?.icon} />
  }
  const Glyph = ATTACHMENT_KIND_ICONS[attachmentKind({ name: item.file.name, type: item.file.mimeType })]
  return <Glyph aria-hidden="true" />
}
