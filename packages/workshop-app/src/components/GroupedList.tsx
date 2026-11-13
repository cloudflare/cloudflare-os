import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { SPACING } from './groupedLayout'
import { GroupedListMotion } from './groupedListMotion'

export type GroupedListGroup = {
  /** Which group it is, from one render to the next. */
  key: string
  /** What its rows have in common, such as when they were: "Today", "Starred". Not shown; read out. */
  label: string
  rows: Array<{ key: string; content: ReactNode }>
  /** Lets its rows be put in another order, giving the keys in the new one. */
  onReorder?: (keys: string[]) => void
}

export type GroupedListProps = {
  groups: GroupedListGroup[]
}

const { pad, gap } = SPACING

/**
 * Rows in groups, each group on a surface of its own as `ListGroup` draws one. The rows are one
 * flat list, so a row that changes group is the same row and keeps its focus.
 *
 * Rows that keep their order stay where they are as groups change around them: the room between
 * two opens or closes, so groups split and merge, their corners rounding and squaring as they do.
 * A row that moves past others to another group (starred, or unstarred) does not travel there: it
 * shrinks out of the group it was in, as a copy left there, and grows into the one it is in now.
 * A row put in another order within its group slides there over the group's surface, which stays.
 *
 * A group with `onReorder` can have its rows dragged with a mouse, held and dragged with a finger,
 * or moved a place at a time with Alt and the up or down arrow from anything focused in a row.
 */
export const GroupedList = ({ groups }: GroupedListProps) => {
  const listRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const ghostsRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<GroupedListMotion>(undefined)
  const [announcement, setAnnouncement] = useState('')

  useLayoutEffect(() => {
    const motion = new GroupedListMotion(listRef.current!, surfaceRef.current!, ghostsRef.current!, setAnnouncement)
    motionRef.current = motion
    return () => motion.destroy()
  }, [])

  // After every render, from where React has put the rows.
  useLayoutEffect(() => {
    motionRef.current?.sync(groups.map(({ key, rows, onReorder }) => ({ key, rows: rows.map((row) => row.key), reorder: onReorder })))
  })

  return (
    // Not anchored to by the page's scrolling: when a row moves, the browser would scroll to keep
    // it in place, when it is drawn where it was until it has moved.
    <div ref={listRef} className="relative flex flex-col [overflow-anchor:none]">
      <div ref={surfaceRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      <div ref={ghostsRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      {groups.flatMap((group, groupIndex) =>
        group.rows.map((row, rowIndex) => (
          <div
            key={row.key}
            data-row={row.key}
            className={cn(
              'relative',
              group.onReorder && 'rounded-2xl select-none [-webkit-touch-callout:none] data-lifted:bg-kumo-tint data-lifted:ring-1 data-lifted:ring-kumo-line',
            )}
            // The group's padding around its rows, and the gap before it, which the surface is drawn
            // from: a flex column's margins do not collapse.
            style={{
              marginInline: pad,
              marginTop: rowIndex === 0 ? (groupIndex > 0 ? gap : 0) + pad : 0,
              marginBottom: rowIndex === group.rows.length - 1 ? pad : 0,
            }}
          >
            {rowIndex === 0 && <h2 className="sr-only">{group.label}</h2>}
            {row.content}
          </div>
        )),
      )}
      <span role="status" className="sr-only">{announcement}</span>
    </div>
  )
}
