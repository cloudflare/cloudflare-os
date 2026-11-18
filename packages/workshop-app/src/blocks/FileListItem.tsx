import { useState, type ReactElement, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { EditableTitle } from '@/components/EditableTitle'
import { LinkButton } from '@/components/LinkButton'
import { LibraryMoreMenu, type LibraryMoreActions } from './LibraryMoreMenu'
import { RowAction } from './RowAction'
import { LIST_ACTION } from './StarButton'

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
  /**
   * What else can be done to it from its more menu (`LibraryMoreMenu`), for an output whoever looks
   * may change. Without it the row has no menu.
   */
  more?: LibraryMoreActions
}

const ROW = 'flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-3 text-left text-base'

/**
 * A file or an output in a list of them, on one line: what it is, its name, and when it was. With
 * `more`, its more menu slides out at the end while the row is pointed at, as a chat's does in a
 * list of chats; renamed from there, its name is typed where it is, and the row opens nothing
 * until that is done.
 */
export const FileListItem = ({ title, icon, time, href, onSelect, more }: FileListItemProps) => {
  const [renaming, setRenaming] = useState(false)
  const { onRename } = more ?? {}
  const content = (name: ReactNode) => (
    <>
      <span className="flex shrink-0 text-kumo-default [&>svg]:size-5">{icon}</span>
      {name}
      {time && <span className="shrink-0 text-kumo-subtle">{time}</span>}
    </>
  )

  if (!more) {
    return (
      <LinkButton href={href} onClick={onSelect} className={cn(ROW, 'w-full hover:bg-kumo-contrast/5')}>
        {content(<span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>)}
      </LinkButton>
    )
  }
  return (
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      {renaming && onRename ? (
        <div className={ROW}>
          {content(
            // Where the name was, as wide as the line: the field's own room is taken from its sides.
            <span className="min-w-0 flex-1">
              <EditableTitle value={title} onRename={onRename} onEnd={() => setRenaming(false)} autoFocus aria-label="Title" className="-mx-2.5 -my-1 block w-[calc(100%+1.25rem)] max-w-none font-medium text-kumo-default" />
            </span>,
          )}
        </div>
      ) : (
        <LinkButton
          href={href}
          onClick={onSelect}
          // The whole row opens it, apart from the button over it.
          className={cn(ROW, "after:absolute after:inset-0 after:content-['']")}
        >
          {content(<span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>)}
        </LinkButton>
      )}
      {!renaming && (
        <RowAction>
          <span className="relative flex">
            <LibraryMoreMenu
              title={title}
              href={href}
              onOpen={onSelect}
              {...more}
              onRename={onRename && (() => setRenaming(true))}
              triggerClassName={LIST_ACTION}
            />
          </span>
        </RowAction>
      )}
    </div>
  )
}
