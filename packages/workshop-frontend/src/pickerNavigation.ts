// Shared keyboard handling for ResourcePicker navigation.
// Used by both the inline CapsuleOverlay (ChatInterface) and the GatekeeperModal.

import type React from 'react'
import type { MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { SelectableItem } from './ResourcePicker'
import { getPlaceholderRanges } from './resourceMatching'

/**
 * Handle arrow-key navigation and Tab (placeholder advance / item activation)
 * for an input element paired with a ResourcePicker.
 *
 * `urlText`   – the URL string being edited (may be a substring of the input value)
 * `urlOffset` – position of urlText within the input element's value (0 if the
 *               input contains only the URL)
 */
export function handlePickerKeyDown(
  e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  urlText: string,
  urlOffset: number,
  overlayIndex: number,
  setOverlayIndex: Dispatch<SetStateAction<number>>,
  itemsRef: MutableRefObject<SelectableItem[]>,
  activateRef: MutableRefObject<((index: number) => void) | null>,
): void {
  const items = itemsRef.current
  if (items.length === 0) return

  const count = items.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setOverlayIndex(i => (i + 1) % count)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setOverlayIndex(i => (i - 1 + count) % count)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    // Check if there are unfilled placeholders after the cursor in the URL.
    // If so, advance to the next one instead of activating the overlay item.
    // Use selectionEnd so that if a placeholder is already selected,
    // Tab advances to the next placeholder instead of re-selecting it.
    const input = e.target as HTMLInputElement | HTMLTextAreaElement
    const cursorInUrl = (input.selectionEnd ?? 0) - urlOffset
    const placeholders = getPlaceholderRanges(urlText)
    const next = placeholders.find(p => p.start >= cursorInUrl)
    if (next) {
      input.setSelectionRange(urlOffset + next.start, urlOffset + next.end)
    } else {
      activateRef.current?.(overlayIndex)
    }
  }
}
