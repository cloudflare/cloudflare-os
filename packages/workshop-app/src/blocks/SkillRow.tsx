import { DotsThreeIcon, ScrollIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { ACTION, libraryMenu, type LibraryAction } from './LibraryRow'

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
 * A skill in the Library, as a gadget's row is (`LibraryRow`) with a second line: what it is for,
 * the way the agent decides whether to use it. More slides out at the end when pointed at, and
 * right-clicking opens the same menu.
 */
export const SkillRow = ({ title, description, time, actions, href, onSelect }: SkillRowProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <LinkButton
        href={href}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
      >
        {/* On the name's line, as a row's glyph is, rather than between the two lines. */}
        <span aria-hidden="true" className="flex h-5 shrink-0 items-center text-kumo-default [&>svg]:size-5"><ScrollIcon /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-kumo-default">{title}</span>
          <span className="line-clamp-2 text-sm/5 text-kumo-subtle">{description}</span>
        </span>
        {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
      </LinkButton>
      {actions.length > 0 && (
        <span
          className={cn(
            'flex w-0 shrink-0 justify-end self-start pt-1.5 opacity-0 transition-[width,opacity] duration-75 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none',
            'pointer-events-none group-hover:pointer-events-auto group-hover:w-10 group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:w-10 group-has-focus-visible:opacity-100',
            'group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:w-10 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:w-10 pointer-coarse:opacity-100',
          )}
        >
          <span className="relative flex">
            <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={ACTION} align="end">
              {libraryMenu(actions)}
            </DropdownMenu>
          </span>
        </span>
      )}
    </div>
  </ContextMenu>
)
