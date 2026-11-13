import { Avatar } from '@/components/Avatar'

export type MemberListItemProps = {
  name: string
  /** What they may do, as the list puts it: "Owner", "Can edit". */
  role: string
  /** The member is the viewer. */
  you?: boolean
}

/** One person with access to a workspace, on one line: their initials and name, and what they may do. */
export const MemberListItem = ({ name, role, you }: MemberListItemProps) => (
  <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-base">
    <Avatar name={name} />
    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">
      {name}
      {you && <span className="font-normal text-kumo-subtle"> (you)</span>}
    </span>
    <span className="shrink-0 text-kumo-subtle">{role}</span>
  </div>
)
