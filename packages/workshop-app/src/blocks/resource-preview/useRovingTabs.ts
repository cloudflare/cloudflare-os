import { useRef, useState, type KeyboardEvent } from 'react'

/**
 * A tablist's keyboard behavior: the selected tab is the one tab stop, arrow keys (and Home/End)
 * move to and select a neighbour. `orientation` picks the arrow keys that move.
 */
export const useRovingTabs = ({ count, selected, onSelect, orientation = 'horizontal' }: {
  count: number
  selected: number
  onSelect: (index: number) => void
  orientation?: 'horizontal' | 'vertical'
}) => {
  const tabs = useRef<(HTMLElement | null)[]>([])
  const [prev, next] = orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  const move = (index: number) => {
    onSelect(index)
    tabs.current[index]?.focus()
  }
  return (index: number) => ({
    ref: (element: HTMLElement | null) => { tabs.current[index] = element },
    role: 'tab' as const,
    'aria-selected': index === selected,
    tabIndex: index === selected ? 0 : -1,
    onClick: () => onSelect(index),
    onKeyDown: (event: KeyboardEvent) => {
      const target = event.key === prev ? (index - 1 + count) % count
        : event.key === next ? (index + 1) % count
          : event.key === 'Home' ? 0
            : event.key === 'End' ? count - 1
              : null
      if (target === null) return
      event.preventDefault()
      move(target)
    },
  })
}

/**
 * Which of several parts (tabs, sheets, slides) is shown: the user's choice, moved to the part
 * holding the focused change whenever that focus changes, so the focused change is on screen.
 */
export const useSelectionFollowingFocus = <K,>(
  fallback: K,
  focusedChangeId: number | null,
  partOf: (changeId: number) => K | undefined,
) => {
  const [selected, setSelected] = useState<K>(() => (focusedChangeId === null ? undefined : partOf(focusedChangeId)) ?? fallback)
  const [followed, setFollowed] = useState(focusedChangeId)
  if (focusedChangeId !== followed) {
    setFollowed(focusedChangeId)
    const part = focusedChangeId === null ? undefined : partOf(focusedChangeId)
    if (part !== undefined) setSelected(part)
  }
  return [selected, setSelected] as const
}
