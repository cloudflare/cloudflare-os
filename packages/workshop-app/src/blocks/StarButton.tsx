import { StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'

/** How a button over a row or a card of a list is drawn: quiet until it is pointed at itself. */
export const LIST_ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'

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
