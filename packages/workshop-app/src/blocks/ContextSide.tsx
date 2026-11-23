import type { ReactNode, Ref } from 'react'
import { ArrowRightDoubleIcon } from '@/components/icons'
import { Button } from '@gadgets/ui'

export type ContextSideProps = {
  /** What the card holds (`ContextSection`), each of which scrolls once it is taller than it should be. */
  children: ReactNode
  /** Puts the card away. */
  onMinimize: () => void
  /** Its minimize button, to bring focus to when the card is opened. */
  minimizeRef?: Ref<HTMLButtonElement>
}

/**
 * The card of what a page has, laid out by the page beside its content (`ChatLayout`'s `side`), as
 * the other side of `ContextPanel`'s button. It has no surface, and is all quiet text, which what
 * can be opened in it turns to the main colour as it is pointed at. Its first title is level with the
 * header's buttons, and its minimize button's glyph is as far in from the right as the rows' ends are.
 */
export const ContextSide = ({ children, onMinimize, minimizeRef }: ContextSideProps) => (
  <aside aria-label="What this chat can use" className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
    <div className="relative">
      {/* Sections alone in what holds them, so that the first and last of them are the first and last of it. */}
      <div className="flex flex-col">{children}</div>
      <Button
        ref={minimizeRef}
        variant="ghost"
        icon={<ArrowRightDoubleIcon aria-hidden="true" weight="bold" className="size-3.5!" />}
        aria-label="Minimize"
        title="Minimize"
        onClick={onMinimize}
        className="absolute top-0 end-0.75 z-10 size-7 text-kumo-subtle not-data-disabled:hover:bg-transparent hover:text-kumo-default"
      />
    </div>
  </aside>
)
