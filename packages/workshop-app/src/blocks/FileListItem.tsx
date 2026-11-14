import type { ReactElement } from 'react'
import { LinkButton } from '@/components/LinkButton'

export type FileListItemProps = {
  /** A file's name, an output's title. */
  title: string
  /** What kind of thing it is. */
  icon: ReactElement
  /** When it was, as the list it is in puts it. */
  time?: string
  /** Where it opens, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** A file or an output in a list of them, on one line: what it is, its name, and when it was. */
export const FileListItem = ({ title, icon, time, href, onSelect }: FileListItemProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-base hover:bg-kumo-contrast/5"
  >
    <span className="flex shrink-0 text-kumo-default [&>svg]:size-5">{icon}</span>
    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
    {time && <span className="shrink-0 text-kumo-subtle">{time}</span>}
  </LinkButton>
)
