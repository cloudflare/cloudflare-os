import type { ReactNode } from 'react'
import { DotsThreeIcon, UserPlusIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ACTION, libraryMenu, type LibraryAction } from './LibraryRow'
import { ListGroup } from './ListGroup'

export type SkillGroupProps = {
  /** The collection's name: "My skills", "Design team". */
  title: string
  /** Its emoji, when it has one. */
  icon?: string
  /** Who has it, after the name: "Shared with 3 people", "For everyone at Acme". */
  detail?: string
  /** Shares it, for whoever may. */
  onShare?: () => void
  /** Its More menu: rename, leave, delete. */
  actions: LibraryAction[]
  /** Its skills, as rows, or what it says while it has none. */
  children: ReactNode
}

/**
 * A collection of skills: its name and who has it on a line above its rows, as a page's sections
 * are headed, with the ways to share and change it at the end of that line.
 */
export const SkillGroup = ({ title, icon, detail, onShare, actions, children }: SkillGroupProps) => (
  <section aria-label={title} className="flex flex-col gap-2">
    <header className="flex min-h-9 items-center gap-2 ps-4 pe-1.5">
      <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
        {icon && <span aria-hidden="true" className="text-base/none">{icon}</span>}
        <span className="truncate font-medium text-kumo-default">{title}</span>
        {detail && <span className="truncate text-kumo-subtle">{detail}</span>}
      </h2>
      {onShare && <Button variant="ghost" icon={UserPlusIcon} aria-label={`Share ${title}`} title="Share" onClick={onShare} className={ACTION} />}
      {actions.length > 0 && (
        <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={ACTION} align="end">
          {libraryMenu(actions)}
        </DropdownMenu>
      )}
    </header>
    <ListGroup label={title}>{children}</ListGroup>
  </section>
)
