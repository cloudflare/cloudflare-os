import { PushPinIcon, StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button, LIST_ACTION } from '@gadgets/ui'

export type StarButtonProps = {
  /** What it stars, for its name. */
  title: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /**
   * A pin rather than a star, for what is kept at hand where it is used, such as a workspace in
   * the sidebar, rather than collected.
   */
  pin?: boolean
  className?: string
}

/** The star of something listed, filled while it is starred, or its pin. */
export const StarButton = ({ title, starred, onStarredChange, pin = false, className }: StarButtonProps) => (
  <Button
    variant="ghost"
    icon={pin ? <PushPinIcon weight={starred ? 'fill' : 'regular'} /> : <StarIcon weight={starred ? 'fill' : 'regular'} />}
    aria-label={`${pin ? 'Pin' : 'Star'} ${title}`}
    aria-pressed={starred}
    onClick={() => onStarredChange(!starred)}
    className={cn(LIST_ACTION, className)}
  />
)
