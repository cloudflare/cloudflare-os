import { cn } from '@cloudflare/kumo/utils'
import type { FormatIconName } from '@/components/FormatIcon'

export type TemplatePreviewProps = {
  /** What the template makes, by what that is drawn as; otherwise an app. */
  icon?: FormatIconName
  /** A picture of what it makes, where its publisher gave one. */
  src?: string
  /** Its shape, and with a text size, how large a sketch is drawn, which is sized by it. */
  className?: string
}

const LINE = 'h-[0.25em] shrink-0 rounded-full bg-kumo-contrast/10'
const BLOCK = 'rounded-[0.125em] bg-kumo-contrast/10'

/** What a template makes, sketched in a few strokes, each sized by the text size so that all of it scales. */
const Sketch = ({ icon }: { icon?: FormatIconName }) => {
  if (icon === 'table' || icon === 'gridNine') {
    return (
      <span className="grid flex-1 grid-cols-4 content-start gap-px overflow-hidden rounded-[0.125em] bg-kumo-line ring-1 ring-kumo-line">
        {Array.from({ length: 24 }, (_, cell) => <span key={cell} className={cn('h-[0.75em]', cell < 4 ? 'bg-kumo-fill' : 'bg-kumo-base')} />)}
      </span>
    )
  }
  if (icon === 'presentation') {
    return (
      <span className="flex flex-1 items-center gap-[0.625em]">
        <span className="flex flex-1 flex-col gap-[0.375em]">
          <span className="h-[0.375em] w-4/5 shrink-0 rounded-full bg-kumo-contrast/25" />
          <span className={cn(LINE, 'w-full')} />
          <span className={cn(LINE, 'w-3/5')} />
        </span>
        <span className={cn(BLOCK, 'aspect-square w-2/5')} />
      </span>
    )
  }
  if (icon === 'chartBar' || icon === 'kanban') {
    return (
      <span className="flex flex-1 items-end gap-[0.375em]">
        {['h-2/5', 'h-3/5', 'h-1/2', 'h-4/5', 'h-full'].map((height) => <span key={height} className={cn(BLOCK, 'flex-1', height)} />)}
      </span>
    )
  }
  if (icon === 'fileText' || icon === 'notebook' || icon === 'listChecks') {
    return (
      <span className="flex flex-1 flex-col gap-[0.375em]">
        <span className="mb-[0.125em] h-[0.375em] w-2/5 shrink-0 rounded-full bg-kumo-contrast/25" />
        {['w-full', 'w-11/12', 'w-4/5', 'w-full', 'w-3/5'].map((width, line) => <span key={line} className={cn(LINE, width)} />)}
      </span>
    )
  }
  // An app: a window, with what is beside its page and what is on it.
  return (
    <span className="flex flex-1 gap-[0.5em]">
      <span className="flex w-1/4 flex-col gap-[0.375em]">
        {['w-full', 'w-4/5', 'w-full', 'w-3/5'].map((width, line) => <span key={line} className={cn(LINE, width)} />)}
      </span>
      <span className="flex flex-1 flex-col gap-[0.375em]">
        <span className="flex h-2/5 gap-[0.375em]">
          <span className={cn(BLOCK, 'flex-1')} />
          <span className={cn(BLOCK, 'flex-1')} />
        </span>
        <span className={cn(BLOCK, 'flex-1')} />
      </span>
    </span>
  )
}

/**
 * A picture of what a template makes: its publisher's, or until there is one, a page of the kind
 * of thing it is, sketched, coming up from the picture's end.
 */
export const TemplatePreview = ({ icon, src, className }: TemplatePreviewProps) => (
  <span className={cn('relative block aspect-16/10 shrink-0 overflow-hidden bg-kumo-fill text-[1rem]', className)}>
    {src
      ? <img src={src} alt="" loading="lazy" className="size-full object-cover" />
      : (
          <span aria-hidden="true" className="absolute inset-x-[14%] top-[18%] bottom-0 flex flex-col rounded-t-[0.5em] bg-kumo-base p-[0.625em] pb-0 ring-1 ring-kumo-line">
            <Sketch icon={icon} />
          </span>
        )}
  </span>
)
