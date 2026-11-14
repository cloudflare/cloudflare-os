import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'

export type MemberListItemProps = {
  name: string
  /** What they may do, as the list puts it: "Owner", "Can edit". */
  role: string
  /** The member is the viewer. */
  you?: boolean
  /** In place of the role, a menu that changes it or takes it away (`AccessMenu`). */
  access?: ReactNode
}

/**
 * One person with access to a workspace, on one line: their initials and name, and what they may
 * do, which the viewer may be able to change from there.
 */
export const MemberListItem = ({ name, role, you, access }: MemberListItemProps) => (
  <div className={cn('flex items-center gap-3 rounded-2xl ps-3 text-base', access ? 'py-1.5 pe-1' : 'py-2.5 pe-3')}>
    <Avatar name={name} />
    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">
      {name}
      {you && <span className="font-normal text-kumo-subtle"> (you)</span>}
    </span>
    {access ?? <span className="shrink-0 text-kumo-subtle">{role}</span>}
  </div>
)
