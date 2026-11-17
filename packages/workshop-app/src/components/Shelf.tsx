import { useId, type ReactNode } from 'react'
import { Button } from './Button'

export type ShelfProps = {
  /** What is on it: "Recent", "Starred". */
  title: string
  /** The way to the rest of what it shows a few of, at the end of its title's line. */
  more?: {
    label: string
    /** What it goes to, where the label alone does not say among other shelves: "See all starred". */
    'aria-label'?: string
    onSelect: () => void
  }
  children: ReactNode
}

/**
 * A few of something under what they are, with the way to the rest of them: one stretch of a page
 * that is made of several, each a line or so.
 */
export const Shelf = ({ title, more, children }: ShelfProps) => {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      {/* Titled as a group of settings is, and in from the edge as little as a list's group is. */}
      <div className="flex min-h-7 items-center justify-between gap-3 px-1.5">
        <h2 id={id} className="text-lg font-medium text-kumo-default">{title}</h2>
        {more && (
          // Its end is where what is under it ends, out of the title's inset, and it takes none of the title's height.
          <Button aria-label={more['aria-label']} onClick={more.onSelect} className="-my-1.5 -me-1.5">{more.label}</Button>
        )}
      </div>
      {children}
    </section>
  )
}
