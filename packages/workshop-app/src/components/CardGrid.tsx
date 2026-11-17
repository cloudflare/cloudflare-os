import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { CardGridMotion } from './cardGridMotion'

export type CardGridGroup = {
  /** Which group it is, from one render to the next. */
  key: string
  /** What its cards have in common, such as when they were: "Today", "Starred". Shown over them. */
  label: string
  cards: Array<{ key: string; content: ReactNode }>
  /** Lets its cards be put in another order, giving the keys in the new one. */
  onReorder?: (keys: string[]) => void
}

export type CardGridProps = {
  groups: CardGridGroup[]
  /**
   * Two cards to a line, and one where two would be too narrow, for cards laid out along a line as
   * a row is: a picture, what it is, and a button of their own at the end.
   */
  wide?: boolean
}

const Group = ({ label, cards, onReorder, wide }: Omit<CardGridGroup, 'key'> & { wide: boolean }) => {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      {/* Shown, unlike a `GroupedList`'s: cards run on along a line, so nothing else sets one group apart from the next. */}
      <h2 id={id} className="px-1.5 text-sm font-medium text-kumo-subtle">{label}</h2>
      {/*
        As many to a line as fit, all as wide as each other, and as tall as the tallest on their
        line. Wide ones are half the line less half the gap at least, so that no more than two fit,
        and only one once that half is under 20rem.
      */}
      <div
        className={cn(
          'grid gap-3',
          wide
            ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,max(20rem,calc(50%-0.375rem))),1fr))]'
            : 'grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]',
        )}
      >
        {cards.map(({ key, content }) => (
          <div
            key={key}
            data-card={key}
            className={cn(
              'flex min-w-0 flex-col rounded-3xl *:flex-1 data-lifted:ring-1 data-lifted:ring-kumo-line',
              onReorder && 'select-none [-webkit-touch-callout:none]',
            )}
          >
            {content}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * What `GroupedList` lists a row each, as a card each: every group under its label, its cards in
 * lines. A card that has another place after a change slides there, and one that arrives fades in.
 *
 * A group with `onReorder` can have its cards dragged with a mouse, held and dragged with a finger,
 * or moved a place at a time with Alt and an arrow key from anything focused in a card: left and
 * right along the line, up and down to the line above or below.
 */
export const CardGrid = ({ groups, wide = false }: CardGridProps) => {
  const gridRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<CardGridMotion>(undefined)
  const [announcement, setAnnouncement] = useState('')

  useLayoutEffect(() => {
    const motion = new CardGridMotion(gridRef.current!, setAnnouncement)
    motionRef.current = motion
    return () => motion.destroy()
  }, [])

  // After every render, from where React has put the cards.
  useLayoutEffect(() => {
    motionRef.current?.sync(groups.map(({ key, cards, onReorder }) => ({ key, cards: cards.map((card) => card.key), reorder: onReorder })))
  })

  return (
    // What the cards are laid out against, so nothing between it and them is positioned. Not
    // anchored to by the page's scrolling: when a card moves, the browser would scroll to keep it
    // in place, when it is drawn where it was until it has moved.
    <div ref={gridRef} className="relative flex flex-col gap-6 [overflow-anchor:none]">
      {groups.map(({ key, label, cards, onReorder }) => <Group key={key} label={label} cards={cards} onReorder={onReorder} wide={wide} />)}
      <span role="status" className="sr-only">{announcement}</span>
    </div>
  )
}
