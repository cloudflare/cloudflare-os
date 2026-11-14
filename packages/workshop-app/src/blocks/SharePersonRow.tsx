import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { BuildingsIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'

const GLYPHS = {
  /** Everyone in a group, such as a workspace's members. */
  people: UsersThreeIcon,
  /** Anyone in the deployment who has the link. */
  everyone: BuildingsIcon,
}

export type SharePersonRowProps = {
  /** Who, or which group: "Ada Lovelace", "Members of Engineering". */
  name: string
  /** The person is the viewer. */
  you?: boolean
  /** A group in place of a person, drawn by a glyph rather than initials. */
  group?: keyof typeof GLYPHS
  /** A line under the name, such as who added them. */
  detail?: string
  /** What they have: a label, or a menu that changes it (`AccessMenu`). */
  access: ReactNode
  /** Just given access, which the row says for a moment by lighting up. */
  landed?: boolean
}

/** One line of who something is shared with: a face or a glyph, who, and what they have. */
export const SharePersonRow = ({ name, you, group, detail, access, landed }: SharePersonRowProps) => {
  const Glyph = group && GLYPHS[group]
  return (
    <div
      data-landed={landed || undefined}
      className={cn(
        'flex min-h-12 items-center gap-3 rounded-2xl py-1.5 ps-2.5 pe-1 text-base/5',
        // Lit up at once, then let go of slowly, so it is seen where it landed.
        'transition-colors duration-1000 ease-out data-landed:bg-kumo-contrast/6 data-landed:duration-0',
      )}
    >
      {Glyph ? (
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
          <Glyph className="size-4" />
        </span>
      ) : (
        <Avatar name={name} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-kumo-default">
          {name}
          {you && <span className="text-kumo-subtle"> (you)</span>}
        </span>
        {detail && <span className="truncate text-sm text-kumo-subtle">{detail}</span>}
      </span>
      <span className="flex shrink-0 items-center">{typeof access === 'string' ? <span className="px-3 text-kumo-subtle">{access}</span> : access}</span>
    </div>
  )
}
