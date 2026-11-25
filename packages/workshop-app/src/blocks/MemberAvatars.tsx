import { cn } from '@cloudflare/kumo/utils'
import { Avatar, Tooltip } from '@gadgets/ui'

/** Someone with access to what is listed. */
export type ListedMember = {
  id: string
  name: string
  /** The member is the viewer. */
  you?: boolean
}

export type MemberAvatarsProps = {
  /** Everyone with access, the owner first, or the first of them when `count` says there are more. */
  members: ListedMember[]
  /** How many have access, when more than are listed. */
  count?: number
  /** Smaller pictures, for a line of a card's text. */
  small?: boolean
}

// The most pictures shown; how many members there are is in each one's tooltip.
const SHOWN = 3
// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

// Each picture but the last has the next one's round cut out of it, a little larger than the
// picture that sits there, so that a gap parts them. Cut out rather than outlined in the surface's
// colour, which would show as a ring once the surface changes under them, as a row's does when it
// is pointed at. The next one's middle is half a picture past this one's edge, less their overlap.
const SIZES = {
  regular: {
    overlap: '-space-x-1',
    cut: 'not-last:[mask-image:radial-gradient(circle_at_calc(100%+0.625rem)_50%,transparent_1rem,black_calc(1rem+0.5px))]',
  },
  small: {
    overlap: '-space-x-0.5',
    cut: 'not-last:[mask-image:radial-gradient(circle_at_calc(100%+0.5rem)_50%,transparent_0.71875rem,black_calc(0.71875rem+0.5px))]',
  },
}

const counted = (count: number) => `${count} ${count === 1 ? 'member' : 'members'}`

/**
 * Who has access to a workspace, where it is listed: the first few members' pictures, overlapping,
 * on a tinted surface. Pointed at, a picture says how many members there are and whose it is.
 */
export const MemberAvatars = ({ members, count = members.length, small }: MemberAvatarsProps) => {
  const { overlap, cut } = SIZES[small ? 'small' : 'regular']
  return (
    <span
      role="img"
      aria-label={`${counted(count)}: ${members.map(({ name, you }) => (you ? 'You' : name)).join(', ')}${count > members.length ? `, and ${count - members.length} more` : ''}`}
      // Over what covers a row to make all of it one link, so that it can be pointed at.
      className={cn('appears relative z-1 flex shrink-0 items-center', overlap)}
    >
      {members.slice(0, SHOWN).map(({ id, name, you }) => (
        <Tooltip key={id} delay={TOOLTIP_DELAY} content={`${counted(count)} · ${you ? 'You' : name}`}>
          <span className={cn('flex rounded-full', cut)}>
            <Avatar name={name} small={small} className="bg-kumo-base" />
          </span>
        </Tooltip>
      ))}
    </span>
  )
}
