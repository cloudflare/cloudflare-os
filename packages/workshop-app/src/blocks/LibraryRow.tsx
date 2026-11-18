import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { EditableTitle } from '@/components/EditableTitle'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { LibraryMoreMenu, type LibraryMoreActions } from './LibraryMoreMenu'
import { RowAction } from './RowAction'
import { LIST_ACTION, StarButton } from './StarButton'
import { WaitingBadge } from './WaitingBadge'

export type LibraryRowProps = {
  title: string
  /** A line under the title: what it is, which workspace it is in, and whose that is. */
  detail?: string
  /** What it is drawn as, when its blueprint says; otherwise an app. */
  icon?: FormatIconName
  /** When it was, as the list it is in puts it. */
  time?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** What else can be done to it from its more menu, for whoever may (`LibraryMoreMenu`). */
  more?: LibraryMoreActions
  /** How many things it asks that wait on the user, which it says before when it was. */
  waiting?: number
}

const ROW = 'flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base'

/**
 * One output on the Library page: what it is, its title over where it is from, and at the far end
 * how many of its asks wait on the user, if any, and when it was. Pointed at, more and its star
 * slide out at the end; a starred one keeps its star out. The star is last, so it stays where it
 * is as more slides out before it. Renamed from more, its title is typed where it is, and the row
 * opens nothing until that is done. On a narrow screen the line has room for less: more is left
 * out, which the output's own page has, and what waits takes the place of when it was.
 */
export const LibraryRow = ({ title, detail, icon, time, starred, onStarredChange, href, onSelect, more, waiting = 0 }: LibraryRowProps) => {
  const [renaming, setRenaming] = useState(false)
  const { onRename } = more ?? {}
  const content = (name: ReactNode) => (
    <>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle">
        <FormatIcon name={icon} className="size-5" />
      </span>
      <span className="min-w-0 flex-1 leading-snug">
        {name}
        {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
      </span>
      {waiting > 0 && <WaitingBadge count={waiting} />}
      {/* On a narrow screen, what waits says more than when it was, and takes its place. */}
      {time && <span className={cn('shrink-0 text-end text-kumo-subtle', waiting > 0 && 'max-md:hidden')}>{time}</span>}
    </>
  )

  return (
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      {renaming && onRename ? (
        <div className={ROW}>
          {content(
            // Where the title was, as wide as the line: the field's own room is taken from its sides.
            <EditableTitle value={title} onRename={onRename} onEnd={() => setRenaming(false)} autoFocus aria-label="Title" className="-mx-2.5 -my-1 block w-[calc(100%+1.25rem)] max-w-none font-medium text-kumo-default" />,
          )}
        </div>
      ) : (
        <LinkButton
          href={href}
          onClick={onSelect}
          // The whole row opens the output, apart from the buttons over it.
          className={cn(ROW, "after:absolute after:inset-0 after:content-['']")}
        >
          {content(<span className="block truncate font-medium text-kumo-default">{title}</span>)}
        </LinkButton>
      )}
      {!renaming && (
        <span className="contents max-md:hidden">
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
        </span>
      )}
      <RowAction shown={starred}>
        <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="relative" />
      </RowAction>
    </div>
  )
}
