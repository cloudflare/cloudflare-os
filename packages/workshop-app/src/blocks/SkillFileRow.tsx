import { DownloadSimpleIcon, FileIcon, FileImageIcon, FileTextIcon, TrashIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { LinkButton } from '@/components/LinkButton'
import { Tag } from '@/components/Tag'
import { CardAction } from './CardAction'
import { LIST_ACTION } from './StarButton'

const ICON = { text: FileTextIcon, image: FileImageIcon, other: FileIcon }

export type SkillFileRowProps = {
  /** Where it is in the skill: "templates/report.md". */
  path: string
  /** What it is drawn as: something written, a picture, or anything else. */
  kind: keyof typeof ICON
  /** A line under its path: what it is, and how big. */
  detail?: string
  /** What it is to the skill, where it is more than one of its files: "Instructions". */
  role?: string
  /** Its page, so that it can be opened in another tab. */
  href?: string
  /** Opens it. Left out for a file there is nothing to show of, which is only downloaded. */
  onSelect?: () => void
  onDownload: () => void
  /** Takes it out of the skill, asked for twice. Left out where it cannot be. */
  onRemove?: () => void
}

/**
 * One of a skill's files: what it is, its path over a line about it, and, while it is pointed at
 * or has the focus, the ways to download it and to take it out. All of it opens the file, where
 * there is something of it to show.
 */
export const SkillFileRow = ({ path, kind, detail, role, href, onSelect, onDownload, onRemove }: SkillFileRowProps) => {
  const Icon = ICON[kind]
  const content = (
    <>
      <span className="flex shrink-0 text-kumo-subtle"><Icon aria-hidden="true" className="size-5" /></span>
      <span className="min-w-0 flex-1 leading-snug">
        {/* The folders it is in, quieter than its name. */}
        <span className="block truncate font-medium text-kumo-default">
          <span className="font-normal text-kumo-subtle">{path.slice(0, path.lastIndexOf('/') + 1)}</span>
          {path.slice(path.lastIndexOf('/') + 1)}
        </span>
        {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
      </span>
      {/* Kumo rings a badge in a link that is pointed at, which here is the whole row. */}
      {role && <Tag className="shrink-0">{role}</Tag>}
    </>
  )
  const shape = 'flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3.5 text-left text-base'
  return (
    <li className="group relative flex items-center rounded-2xl pr-1.5 has-[a,button[data-opens]]:hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
      {onSelect
        // The whole row opens the file, apart from the buttons over it.
        ? <LinkButton href={href} onClick={onSelect} data-opens="" className={`${shape} after:absolute after:inset-0 after:content-['']`}>{content}</LinkButton>
        : <div className={shape}>{content}</div>}
      <CardAction>
        <Button variant="ghost" icon={DownloadSimpleIcon} aria-label={`Download ${path}`} title="Download" onClick={onDownload} className={LIST_ACTION} />
      </CardAction>
      {onRemove && (
        <CardAction>
          <ConfirmMenu
            icon={TrashIcon}
            aria-label={`Delete ${path}`}
            triggerVariant="ghost"
            triggerClassName={LIST_ACTION}
            title={`Delete ${path}?`}
            description="It is taken out of the skill. This can’t be undone."
            confirmLabel="Delete"
            onConfirm={onRemove}
          />
        </CardAction>
      )}
    </li>
  )
}
