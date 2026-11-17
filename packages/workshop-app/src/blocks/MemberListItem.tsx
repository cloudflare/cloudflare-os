import type { ElementType, ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'

export type MemberListItemProps = {
  /** Who, or which group of people: "Ada Lovelace", "Anyone in Cloudflare OS". */
  name: string
  /** What they may do, as the list puts it: "Owner", "Can edit". */
  role: string
  /** The member is the viewer. */
  you?: boolean
  /** In place of the role, a menu that changes it or takes it away (`AccessMenu`). */
  access?: ReactNode
  /** A line under the name, such as how they came to have it. */
  detail?: string
  /** For a group in place of a person, drawn by this rather than by initials. */
  icon?: ElementType
  /** Just given access, which the row says for a moment by lighting up. */
  landed?: boolean
}

/** One person with access to a workspace, on one line: their initials and name, and what they may do. */
export const MemberListItem = ({ name, role, you, access, detail, icon: Icon, landed }: MemberListItemProps) => (
  <div
    data-landed={landed || undefined}
    // Lit up at once, then let go of slowly, so that it is seen where it landed. As tall with a
    // menu in place of the role as without, and the menu's button as far from the end as the
    // role's words would be.
    className={cn(
      'flex min-h-12 items-center gap-3 rounded-2xl px-3 py-1.5 text-base transition-colors duration-1000 ease-out data-landed:bg-kumo-contrast/6 data-landed:duration-0',
      access && 'pe-0',
    )}
  >
    {Icon ? (
      <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-base text-kumo-subtle">
        <Icon className="size-4" />
      </span>
    ) : (
      // Filled, to show on the list's tinted surface.
      <Avatar name={name} className="bg-kumo-base" />
    )}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium text-kumo-default">
        {name}
        {you && <span className="font-normal text-kumo-subtle"> (you)</span>}
      </span>
      {detail && <span className="truncate text-sm text-kumo-subtle">{detail}</span>}
    </span>
    {access ?? <span className="shrink-0 text-kumo-subtle">{role}</span>}
  </div>
)
