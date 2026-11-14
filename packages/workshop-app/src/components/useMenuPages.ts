import { useEffect, useRef, useState } from 'react'

/**
 * A `DropdownMenu` that shows another list in its own place, such as the models in the composer's
 * + menu: which list it shows, and the way to another. Put the lists in an element given `rows`,
 * give a row that opens a list `row` named for it, and the menu `onOpenChangeComplete`, so it
 * opens on the first list again. The keyboard carries on in the list shown: on its chosen row
 * (`current`), else back on the row that opened the list it left, else on its first.
 */
export const useMenuPages = <Page extends string>(first: Page) => {
  const [page, setPage] = useState(first)
  const rows = useRef<HTMLDivElement>(null)
  // The list just left, while the keyboard has yet to move to the one shown.
  const left = useRef<Page>(undefined)
  const show = (next: Page) => {
    left.current = page
    setPage(next)
  }

  useEffect(() => {
    const from = left.current
    if (from === undefined) return
    left.current = undefined
    // After the menu has let go of the row that went.
    const frame = requestAnimationFrame(() => {
      const list = rows.current
      const target = list?.querySelector<HTMLElement>(`[aria-current="true"], [data-row="${from}"]`)
      ;(target ?? list?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])'))?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [page])

  // Once closed, so the list does not change as the menu goes.
  const onOpenChangeComplete = (open: boolean) => {
    if (!open) setPage(first)
  }

  return { page, show, rows, onOpenChangeComplete }
}
