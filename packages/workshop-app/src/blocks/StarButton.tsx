import { StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button, LIST_ACTION } from '@gadgets/ui'

export type StarButtonProps = {
  /** What it stars, for its name. */
  title: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  className?: string
}

/** The star of something listed, filled while it is starred. */
export const StarButton = ({ title, starred, onStarredChange, className }: StarButtonProps) => (
  <Button
    variant="ghost"
    icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
    aria-label={`Star ${title}`}
    aria-pressed={starred}
    onClick={() => onStarredChange(!starred)}
    className={cn(LIST_ACTION, className)}
  />
)
