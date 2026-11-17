import { useRef, type KeyboardEvent } from 'react'

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
