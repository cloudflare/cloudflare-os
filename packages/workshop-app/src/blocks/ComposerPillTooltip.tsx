import { useEffect, useMemo, useState, type RefObject } from 'react'
import { AnchoredChipTooltip } from '@/components/AnchoredChipTooltip'
import { CHIP_TOOLTIP_DELAY } from '@/components/ChipTooltip'
import type { DraftDocument } from './composerDraft'
import { pillAbout } from './ComposerPill'

/**
 * The card over a pill in the draft while a mouse points at it. A pill there has nothing in it
 * that can be pointed at, as the editor keeps what it draws out of reach, so the field is asked
 * which of its pills the pointer is over, and the card is put over that. It goes as the pointer
 * leaves the pill, and as soon as the draft is pressed, written in or scrolled.
 */
export const ComposerPillTooltip = ({ field, draft }: {
  /** The draft's field, whose pills each say which they are (`data-billow-item`). */
  field: RefObject<HTMLElement | null>
  draft: DraftDocument
}) => {
  // The pill pointed at for long enough, where it is drawn, and whether its name is cut short
  // there, which is then worth a card for that alone.
  const [pointed, setPointed] = useState<{ id: string; anchor: Element; cut: boolean }>()

  useEffect(() => {
    const element = field.current
    if (!element) return
    let over: Element | null = null
    let waiting: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(waiting)
      over = null
      setPointed(undefined)
    }
    const point = (event: PointerEvent) => {
      // A finger has nothing to point with: its press is the draft's.
      if (event.pointerType !== 'mouse') return
      const pill = event.target instanceof Element ? event.target.closest('[data-billow-item]') : null
      if (pill === over) return
      hide()
      over = pill
      const id = pill instanceof HTMLElement ? pill.dataset.billowItem : undefined
      if (!pill || !id) return
      waiting = setTimeout(() => {
        const name = pill.querySelector('.chip-name')
        setPointed({ id, anchor: pill, cut: !!name && name.scrollWidth > name.clientWidth })
      }, CHIP_TOOLTIP_DELAY)
    }
    const events = ['pointerleave', 'pointerdown', 'keydown', 'scroll'] as const
    element.addEventListener('pointermove', point)
    for (const event of events) element.addEventListener(event, hide)
    return () => {
      clearTimeout(waiting)
      element.removeEventListener('pointermove', point)
      for (const event of events) element.removeEventListener(event, hide)
    }
  }, [field])

  // A pill that has left the draft, as when the draft is sent, has nothing said of it. The same
  // card for as long as the pill is the same, which is how what shows it knows it has not changed.
  const pill = pointed && draft.find((node) => typeof node !== 'string' && node.id === pointed.id)
  const { anchor, cut } = pointed ?? {}
  const shown = useMemo(() => (pill && typeof pill !== 'string' && anchor ? { about: { ...pillAbout(pill), cut }, anchor } : undefined), [pill, anchor, cut])
  return <AnchoredChipTooltip shown={shown} />
}
