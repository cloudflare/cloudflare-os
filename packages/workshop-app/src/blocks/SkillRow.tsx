import { ScrollIcon } from '@phosphor-icons/react'
import { ContextMenu } from '@/components/ContextMenu'
import { LinkButton } from '@/components/LinkButton'
import { LibraryGlyph, LibraryMore, libraryMenu, type LibraryAction } from './LibraryRow'
import { RowAction } from './RowAction'

export type SkillRowProps = {
  /** Its name in plain words: "Meeting brief". */
  title: string
  /** When the agent uses it, on the line under its name. */
  description: string
  /** When it was last changed, as the list puts it. */
  time?: string
  /** Its More menu, which right-clicking it opens as well. */
  actions: LibraryAction[]
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * A skill in the Library, as a gadget's row is (`LibraryRow`), with what it is for under its name,
 * the way the agent decides whether to use it, on two lines at most. More slides out at the end
 * when pointed at, and right-clicking opens the same menu.
 */
export const SkillRow = ({ title, description, time, actions, href, onSelect }: SkillRowProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole row opens it, apart from the buttons over it.
        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
      >
        <LibraryGlyph icon={<ScrollIcon />} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className="block truncate font-medium text-kumo-default">{title}</span>
          <span className="line-clamp-2 text-kumo-subtle">{description}</span>
        </span>
        {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
      </LinkButton>
      {actions.length > 0 && (
        <RowAction>
          <span className="relative flex">
            <LibraryMore title={title} actions={actions} />
          </span>
        </RowAction>
      )}
    </div>
  </ContextMenu>
)
