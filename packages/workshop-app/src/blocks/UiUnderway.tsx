import type { CSSProperties } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Mascot } from '@/components/mascot/Mascot'
import './UiUnderway.css'

export type UiUnderwayProps = {
  title: string
  description?: string
}

// The order each piece goes in, for the stagger (`UiUnderway.css`).
const piece = (i: number, className: string) => (
  <span className={cn('ui-underway-piece block rounded-[3px] text-kumo-default', className)} style={{ '--i': i } as CSSProperties} />
)

/**
 * Where a gadget's UI will be, before it has one: a window sketched piece by piece, its bar, its
 * sidebar, a heading, cards and a button, over and over, with the mascot at work at its corner.
 * Decorative, so the words say what it is; still for people who ask for reduced motion.
 */
export const UiUnderway = ({ title, description }: UiUnderwayProps) => (
  <div className="appears flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
    <div aria-hidden="true" className="relative">
      <div className="flex w-52 flex-col overflow-hidden rounded-xl bg-kumo-base shadow-xs ring-1 ring-kumo-line">
        <div className="flex h-6 items-center gap-1 border-b border-kumo-line px-2.5">
          {[0, 1, 2].map((dot) => <span key={dot} className="size-1.5 rounded-full bg-kumo-fill" />)}
        </div>
        <div className="grid grid-cols-[2.75rem_1fr] gap-2.5 p-2.5">
          <div className="flex flex-col gap-1.5 pt-0.5">
            {piece(0, 'h-2 w-full bg-kumo-fill')}
            {piece(1, 'h-2 w-4/5 bg-kumo-fill')}
            {piece(2, 'h-2 w-3/5 bg-kumo-fill')}
          </div>
          <div className="flex flex-col gap-2 text-left">
            {piece(3, 'h-3 w-3/5 bg-kumo-fill')}
            <div className="grid grid-cols-2 gap-1.5">
              {piece(4, 'h-10 rounded-md bg-kumo-fill')}
              {piece(5, 'h-10 rounded-md bg-kumo-fill')}
            </div>
            {piece(6, 'h-2 w-full bg-kumo-fill')}
            {piece(7, 'h-2 w-4/5 bg-kumo-fill')}
            <div className="flex pt-0.5">
              {piece(8, 'h-4 w-12 rounded-full bg-kumo-contrast')}
            </div>
          </div>
        </div>
      </div>
      <Mascot emotion="thinking" className="absolute -right-5 -bottom-5 w-11" />
    </div>
    <div className="flex max-w-xs flex-col gap-1">
      <p className="text-base font-medium text-kumo-default">{title}</p>
      {description && <p className="text-sm text-kumo-subtle">{description}</p>}
    </div>
  </div>
)
